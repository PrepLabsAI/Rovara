// Per-company engine model (DEC 254n item 1, guided onboarding PR 14; contracts company-engine-model.ts). The install's core agent model (ROVARA_CORE_AGENT_MODEL) is the default;
// a company's own model, when it set one, replaces it for that company's tasks only.
//
//   The setting  `ORG#<company>#SETTINGS` / `ENGINE_MODEL`   { entityType: COMPANY_ENGINE_MODEL, orgId, version: 1, model, updatedAt, updatedBy }
//                written only by the company route (aws/company-engine-model-routes.ts) after the gateway's live list for THAT company offered the model.
//   The route    `companyEngineModelRoute`: the company's model on the gateway's agent route (the same route shape as the install's), else the install's route exactly as it was.
//                The broker (task start, the task token's description) and the dispatcher (each step's route) both read it per company.
//   The start    `companyEngineModelStartCheck`: before a task of a company WITH its own model starts, the gateway's live list for that company must offer it; otherwise the start is
//                refused before anything is written (ENGINE_MODEL_NOT_OFFERED), and a list that cannot be read refuses too (ENGINE_MODEL_UNCHECKED, never a guess).
//                A company without its own model starts exactly as before: nothing is read from the gateway.
//
// A row that is there but is not exactly this company's setting is unreadable: the route and the start fail closed (never the install default in its place).
import { ENGINE_MODEL_NOT_OFFERED, ENGINE_MODEL_UNCHECKED, OfferedAgentModelsSchema, OrgIdSchema, agentXError, isCoreAgentModelId, orgSettingsKey,
  type AgentXError, type InvocationModelRoute, type OrgId, type OrgKey, type StoredDocument } from "@agentx/contracts";
import { gatewayRouteOf } from "./gateway-model-selection.js";
import { readGatewayModelAccess } from "./gateway-model-access.js";

export const COMPANY_ENGINE_MODEL_ENTITY = "COMPANY_ENGINE_MODEL";
export const COMPANY_ENGINE_MODEL_UNREADABLE = "the company's engine model setting could not be read";

/** The company's own setting row: `ORG#<company>#SETTINGS` / `ENGINE_MODEL`. */
export const companyEngineModelKey = (companyId: OrgId): OrgKey => orgSettingsKey(companyId, "ENGINE_MODEL");

/** Anything that reads one row by its key (the registry's DocumentStore, or the route's table reader). */
export interface EngineModelRowReader {
  get(key: OrgKey): Promise<StoredDocument | Record<string, unknown> | undefined>;
}

export class CompanyEngineModelUnreadable extends Error {
  constructor() { super(COMPANY_ENGINE_MODEL_UNREADABLE); this.name = "CompanyEngineModelUnreadable"; }
}

/** The company's own model, `undefined` when it set none. A row that is not exactly this company's well-formed setting, or a read that fails, throws CompanyEngineModelUnreadable. */
export async function readCompanyEngineModel(store: EngineModelRowReader, companyId: OrgId): Promise<string | undefined> {
  if (!OrgIdSchema.safeParse(companyId).success) throw new CompanyEngineModelUnreadable();
  const key = companyEngineModelKey(companyId);
  let row: Record<string, unknown> | undefined;
  try { row = await store.get(key); } catch { throw new CompanyEngineModelUnreadable(); }
  if (row === undefined || row === null) return undefined;
  const model = row["model"];
  if (row["pk"] !== key.pk || row["sk"] !== key.sk || row["entityType"] !== COMPANY_ENGINE_MODEL_ENTITY || row["orgId"] !== companyId || row["version"] !== 1
    || typeof model !== "string" || !isCoreAgentModelId(model)) throw new CompanyEngineModelUnreadable();
  return model;
}

/**
 * The flow's `modelAccess` for one company: its own model on the gateway's agent route when it set one, else the install's route (the same answer, byte for byte). A setting that cannot
 * be read throws (the step is not dispatched on a guess).
 */
export function companyEngineModelRoute(input: { store: EngineModelRowReader; companyId: OrgId; install: { route(): Promise<InvocationModelRoute | undefined> } }): { route(): Promise<InvocationModelRoute | undefined> } {
  return {
    async route() {
      const own = await readCompanyEngineModel(input.store, input.companyId);
      return own === undefined ? await input.install.route() : gatewayRouteOf(own);
    },
  };
}

/** Reads the models the gateway offers one company (the HTTP reader's `offered`, or the admin read's function). The answer is checked against the contract here. */
export type EngineModelOfferedReader = (companyId: OrgId) => Promise<unknown>;

/** The gateway's offered model ids for the company, in the gateway's order; throws (no cause) when the list cannot be read or is not the contract. */
export async function offeredEngineModels(reader: EngineModelOfferedReader, companyId: OrgId): Promise<string[]> {
  let answer: unknown;
  try { answer = await reader(companyId); } catch { throw new Error("offered"); }
  const parsed = OfferedAgentModelsSchema.safeParse(answer);
  if (!parsed.success) throw new Error("offered");
  return parsed.data.models.map((entry) => entry.model);
}

/**
 * The task start's check (TaskFlowDeps.startModelCheck): undefined when the start may go on, else the refusal. A company with no model of its own: undefined, and the gateway is not asked.
 * Otherwise the gateway's live list for THIS company must hold the model.
 */
export function companyEngineModelStartCheck(input: { store: EngineModelRowReader; companyId: OrgId; offered: EngineModelOfferedReader | undefined }): () => Promise<AgentXError | undefined> {
  return async () => {
    let own: string | undefined;
    try { own = await readCompanyEngineModel(input.store, input.companyId); } catch { return agentXError("RUNTIME_UNAVAILABLE", ENGINE_MODEL_UNCHECKED); }
    if (own === undefined) return undefined;
    if (input.offered === undefined) return agentXError("RUNTIME_UNAVAILABLE", ENGINE_MODEL_UNCHECKED);
    let offered: string[];
    try { offered = await offeredEngineModels(input.offered, input.companyId); } catch { return agentXError("RUNTIME_UNAVAILABLE", ENGINE_MODEL_UNCHECKED); }
    return offered.includes(own) ? undefined : agentXError("CONFIG_INVALID", ENGINE_MODEL_NOT_OFFERED);
  };
}

/** The install's default engine model (ROVARA_CORE_AGENT_MODEL, checked with its gateway origin), undefined where the install has none or its settings are broken. */
export function installEngineModel(env: NodeJS.ProcessEnv): string | undefined {
  const settings = readGatewayModelAccess(env);
  return settings === undefined || "problem" in settings ? undefined : settings.route.alias;
}
