// DEC 254zzz63: the company's own lessons LEARNING model on the deployed developer API (contracts company-learning-model.ts; core-host/company-learning-model.ts reads it). Mirrors the
// company engine model route (company-engine-model-routes.ts, DEC 254n item 1).
//
//   GET /v1/dev/company/learning-model   any member of the company     -> { model, source, offered, preselect }
//   PUT /v1/dev/company/learning-model   owner or admin of the company  { model: <claude id> | null } -> the same view (null clears it: the install default applies again)
//
// Rules:
//   - The company and role are the caller's LIVE membership (sign-in table), read at every call; never a body, query, header or token claim. Full access only (the route table's row).
//   - A model is accepted only when it is a Claude model Code can price AND the model gateway offers it to THIS company now (its live list, read with a service token naming the company).
//     The gateway stays the authority: Code holds no list. A list that cannot be read changes nothing and says so in fixed words (never a guess).
//   - The setting is written under the company's own key (ORG#<company>#SETTINGS / LEARNING_MODEL) in one transaction with an audit row naming the person, plus a company log line.
//   - Every refusal is fixed words: no model id, company id or cause is echoed.
import { randomUUID } from "node:crypto";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import type { z } from "zod";
import { CompanyLearningModelBodySchema, agentXError, companyLog, OrgIdSchema, orgScoped, type CompanyLearningModelView } from "@agentx/contracts";
import { Membership, membershipKey } from "./company-check.js";
import type { DeveloperCaller } from "./developer-routes.js";
import type { AdaptedHttpRequest } from "./lambda.js";
import { offeredEngineModels, type EngineModelOfferedReader } from "../core-host/company-engine-model.js";
import { COMPANY_LEARNING_MODEL_ENTITY, companyLearningModelKey, isLearnableModel, readCompanyLearningModel } from "../core-host/company-learning-model.js";

export const COMPANY_LEARNING_MODEL_PATH = "/v1/dev/company/learning-model";
export const COMPANY_LEARNING_MODEL_AUDIT_ENTITY = "COMPANY_LEARNING_MODEL_AUDIT";
export const LEARNING_MODEL_ADMIN_ONLY = "Only a company owner or admin can change the model lessons learn with.";
export const LEARNING_MODEL_BODY_INVALID = "Send the Claude model lessons should learn with, as { \"model\": \"<model id>\" }, or { \"model\": null } to use this Rovara's default.";
export const LEARNING_MODEL_NOT_OFFERED_TO_COMPANY = "That model isn't a Claude model offered to this company now. Pick one from the list.";
export const LEARNING_MODEL_LIST_UNAVAILABLE = "The AI models this company can use could not be read just now; nothing was changed. Try again in a moment.";
export const LEARNING_MODEL_SETTING_UNAVAILABLE = "The company's learning model setting could not be read or saved just now; try again.";
const SIGN_IN_AGAIN = "your AgentX sign-in has ended; run agentx login <url> again";

export interface CompanyLearningModelWiring {
  /** The models the gateway offers one company now (`adminOfferedModelsFromEnvironment`); checked against the contract here. */
  offered: EngineModelOfferedReader;
  /** The install's learning model (ROVARA_CORE_LEARNING_MODEL, else the default), undefined where the install's setting is broken. */
  installModel: () => string | undefined;
  /** The broker's log sink; every line goes through companyLog. Event names and ids only. */
  log: (entry: Record<string, unknown>) => void;
}

export interface CompanyLearningModelContext {
  documentClient: { send(command: unknown): Promise<unknown> };
  /** The State table (the setting and its audit). */
  tableName: string;
  /** The sign-in table (memberships). */
  signInTableName: string;
  now: () => number;
  wiring: CompanyLearningModelWiring;
}

/** Whether this module answers the path (the dispatcher sends it here before anything is read). */
export function isCompanyLearningModelPath(path: string): boolean {
  return path === COMPANY_LEARNING_MODEL_PATH;
}

async function liveMembership(ctx: CompanyLearningModelContext, caller: DeveloperCaller, companyId: string): Promise<z.infer<typeof Membership>> {
  try {
    const response = await ctx.documentClient.send(new GetCommand({ TableName: ctx.signInTableName, Key: membershipKey(caller.developerId), ConsistentRead: true })) as { Item?: unknown };
    const member = Membership.parse(response.Item);
    if (member.personId !== caller.developerId || member.companyId !== companyId || member.revokedAt !== undefined || !OrgIdSchema.safeParse(companyId).success) throw new Error("membership");
    return member;
  } catch { throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN); }
}

function bodyOf(request: AdaptedHttpRequest): unknown {
  if (request.body === undefined || request.body === "") return undefined;
  try { return JSON.parse(request.body) as unknown; } catch { return undefined; }
}

const viewOf = (own: string | undefined, install: string | undefined, offered: string[]): CompanyLearningModelView => {
  const model = own ?? install ?? null;
  return { model, source: own === undefined ? "install" : "company", offered, preselect: model !== null && offered.includes(model) ? model : offered[0] ?? null };
};

export async function routeCompanyLearningModel(ctx: CompanyLearningModelContext, caller: DeveloperCaller, companyId: string, request: AdaptedHttpRequest): Promise<unknown> {
  if (request.method !== "GET" && request.method !== "PUT") throw agentXError("NOT_FOUND", "not found");
  const member = await liveMembership(ctx, caller, companyId);
  const company = member.companyId;
  const reader = { get: async (key: { pk: string; sk: string }) => (await ctx.documentClient.send(new GetCommand({ TableName: ctx.tableName, Key: key, ConsistentRead: true })) as { Item?: Record<string, unknown> }).Item };
  const readOwn = async (): Promise<string | undefined> => {
    try { return await readCompanyLearningModel(reader, company); } catch { throw agentXError("RUNTIME_UNAVAILABLE", LEARNING_MODEL_SETTING_UNAVAILABLE); }
  };
  // Only the Claude models Code can price are offered here: the learning route is the company's own Anthropic account, and the per-call cap is priced from the catalog.
  const readOffered = async (): Promise<string[]> => {
    try { return (await offeredEngineModels(ctx.wiring.offered, company)).filter(isLearnableModel); } catch { throw agentXError("RUNTIME_UNAVAILABLE", LEARNING_MODEL_LIST_UNAVAILABLE); }
  };
  const installModel = (): string | undefined => {
    try { return ctx.wiring.installModel(); } catch { return undefined; }
  };

  if (request.method === "GET") {
    const own = await readOwn();
    return viewOf(own, installModel(), await readOffered());
  }

  // PUT: the live role first (nobody learns more than "owner or admin"), then the body, then the gateway's live list for this company.
  if (member.role !== "owner" && member.role !== "admin") throw agentXError("FORBIDDEN", LEARNING_MODEL_ADMIN_ONLY);
  const parsed = CompanyLearningModelBodySchema.safeParse(bodyOf(request));
  if (!parsed.success) throw agentXError("CONFIG_INVALID", LEARNING_MODEL_BODY_INVALID);
  const chosen = parsed.data.model;
  const previous = await readOwn();
  const offered = await readOffered();
  if (chosen !== null && !offered.includes(chosen)) throw agentXError("CONFIG_INVALID", LEARNING_MODEL_NOT_OFFERED_TO_COMPANY);

  const at = new Date(ctx.now()).toISOString();
  const key = companyLearningModelKey(company);
  const audit = {
    pk: orgScoped(company, "LEARNING_MODEL_AUDIT"), sk: `${at}#${randomUUID()}`, entityType: COMPANY_LEARNING_MODEL_AUDIT_ENTITY, orgId: company,
    action: chosen === null ? "clear" : "set", model: chosen, previousModel: previous ?? null, personId: caller.developerId, at,
  };
  const setting = chosen === null
    ? { Delete: { TableName: ctx.tableName, Key: key } }
    : { Put: { TableName: ctx.tableName, Item: { ...key, entityType: COMPANY_LEARNING_MODEL_ENTITY, orgId: company, version: 1, model: chosen, updatedAt: at, updatedBy: caller.developerId } } };
  try {
    await ctx.documentClient.send(new TransactWriteCommand({ TransactItems: [setting, { Put: { TableName: ctx.tableName, Item: audit, ConditionExpression: "attribute_not_exists(pk)" } }] }));
  } catch { throw agentXError("RUNTIME_UNAVAILABLE", LEARNING_MODEL_SETTING_UNAVAILABLE); }
  companyLog(company, ctx.wiring.log)({ event: chosen === null ? "company.learning_model_cleared" : "company.learning_model_set", actor: caller.developerId });
  return viewOf(chosen ?? undefined, installModel(), offered);
}
