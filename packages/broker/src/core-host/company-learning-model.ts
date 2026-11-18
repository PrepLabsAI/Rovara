// Per-company lessons learning model (DEC 254zzz63; contracts company-learning-model.ts), mirroring the per-company engine model (company-engine-model.ts, DEC 254n item 1).
//
//   The setting  `ORG#<company>#SETTINGS` / `LEARNING_MODEL`   { entityType: COMPANY_LEARNING_MODEL, orgId, version: 1, model, updatedAt, updatedBy }
//                written only by the company route (aws/company-learning-model-routes.ts) after the gateway's live list for THAT company offered the model.
//   The model    `learningModelFor`: the company's own model when it chose one, else the install's (ROVARA_CORE_LEARNING_MODEL, else CORE_LEARNING_MODEL_DEFAULT).
//
// A row that is there but is not exactly this company's well-formed setting is unreadable: learning fails closed for that call (never the install default in its place).
import { CORE_CLAUDE_AGENT_MODEL, CORE_LEARNING_MODEL_DEFAULT, CORE_LEARNING_MODEL_VARIABLE, OrgIdSchema, isCoreLearningModelId, orgSettingsKey, type OfferedAgentModels, type OrgId, type OrgKey } from "@agentx/contracts";
import { listPricesPerMillion } from "@agentx/model-runtime/catalog";
import type { EngineModelRowReader } from "./company-engine-model.js";

export const COMPANY_LEARNING_MODEL_ENTITY = "COMPANY_LEARNING_MODEL";
export const COMPANY_LEARNING_MODEL_UNREADABLE = "the company's learning model setting could not be read";

/** The company's own setting row: `ORG#<company>#SETTINGS` / `LEARNING_MODEL`. */
export const companyLearningModelKey = (companyId: OrgId): OrgKey => orgSettingsKey(companyId, "LEARNING_MODEL");

export class CompanyLearningModelUnreadable extends Error {
  constructor() { super(COMPANY_LEARNING_MODEL_UNREADABLE); this.name = "CompanyLearningModelUnreadable"; }
}

/** A Claude engine name the learning route can use and Code can price (its per-call cap is priced from the catalog). */
export function isLearnableModel(model: string): boolean {
  if (!isCoreLearningModelId(model) || !CORE_CLAUDE_AGENT_MODEL.test(model)) return false;
  const prices = listPricesPerMillion({ provider: "anthropic", modelId: model });
  return prices !== undefined && prices.input > 0 && prices.output > 0;
}

/** The company's own learning model, `undefined` when it chose none. A row that is not exactly this company's well-formed setting, or a read that fails, throws CompanyLearningModelUnreadable. */
export async function readCompanyLearningModel(store: EngineModelRowReader, companyId: OrgId): Promise<string | undefined> {
  if (!OrgIdSchema.safeParse(companyId).success) throw new CompanyLearningModelUnreadable();
  const key = companyLearningModelKey(companyId);
  let row: Record<string, unknown> | undefined;
  try { row = await store.get(key); } catch { throw new CompanyLearningModelUnreadable(); }
  if (row === undefined || row === null) return undefined;
  const model = row["model"];
  if (row["pk"] !== key.pk || row["sk"] !== key.sk || row["entityType"] !== COMPANY_LEARNING_MODEL_ENTITY || row["orgId"] !== companyId || row["version"] !== 1
    || typeof model !== "string" || !isCoreLearningModelId(model) || !CORE_CLAUDE_AGENT_MODEL.test(model)) throw new CompanyLearningModelUnreadable();
  return model;
}

/**
 * The install's learning model (DEC 254zzz58/63): ROVARA_CORE_LEARNING_MODEL when set (one Claude engine name), else CORE_LEARNING_MODEL_DEFAULT. A SET value that is not a Claude engine name is
 * undefined (learning is "not set up"; never a silent fall back to the default or the agent model).
 */
export function installLearningModel(env: NodeJS.ProcessEnv): string | undefined {
  const chosen = env[CORE_LEARNING_MODEL_VARIABLE]?.trim() ?? "";
  if (chosen === "") return CORE_LEARNING_MODEL_DEFAULT;
  return isCoreLearningModelId(chosen) && CORE_CLAUDE_AGENT_MODEL.test(chosen) ? chosen : undefined;
}

/** The Claude models of a company's offered list that lessons can learn with, in the gateway's order. */
export function offeredLearningModels(offered: OfferedAgentModels): string[] {
  return offered.models.map((entry) => entry.model).filter(isLearnableModel);
}
