import { isDeepStrictEqual } from "node:util";
// ANSWER-3: broker validation lives on the existing company MODEL_SELECTION_POLICY row in State.
// No signing/HTTP capability or sign-in-table grant is needed by the dispatcher. DocumentStore.get is strongly consistent.
import { z } from "zod";
import { AGENT_MODEL_NAME, OfferedAgentModelsSchema, StageModelOverridesSchema, agentModelIdentity, agentModelName, when,
  type DocumentStore, type InvocationModelRoute, type OrgId, type StoredDocument } from "@agentx/contracts";
import { createModelSelection, type ModelSelectionService, type StepChoice } from "../core/model-selection/service.js";
import { modelSelectionPolicyKey, readModelSelectionPolicy } from "../core/model-selection/policy-store.js";

export const STORED_MODEL_CHOICE_UNAVAILABLE = "The company's validated model choice could not be read just now, so this step cannot run.";
const VALIDATION_TTL_MS = 60_000;
const Choice = z.object({ revision: z.number().int().min(0), stepOverrides: StageModelOverridesSchema,
  reviewDefault: z.enum(["install-model", "different-company"]), defaultModel: z.string().regex(AGENT_MODEL_NAME) }).strict();
const Validation = z.object({ choice: Choice, offered: OfferedAgentModelsSchema,
  validatedAt: z.number().int().nonnegative(), expiresAt: z.number().int().nonnegative() }).strict();
const refused = () => ({ ok: false as const, code: "MODEL_STALE" as const, words: STORED_MODEL_CHOICE_UNAVAILABLE });

/** Publish only after the broker has checked every saved choice (and its fallback) against this company's list. Fence concurrent policy changes. */
export async function publishAgentModelChoice(input: { store: Pick<DocumentStore, "get" | "put" | "transact">; companyId: OrgId; offered: unknown; defaultModel: string; now: () => number }): Promise<void> {
  const offered = OfferedAgentModelsSchema.parse(input.offered);
  const policy = await readModelSelectionPolicy(input.store, input.companyId);
  const names = new Set(offered.models.map((model) => model.model));
  if (!names.has(input.defaultModel)) throw new Error(STORED_MODEL_CHOICE_UNAVAILABLE);
  for (const choice of Object.values(policy.stepOverrides)) {
    for (const model of [choice?.model, choice?.fallbackModel]) {
      if (model !== undefined && !names.has(agentModelName(model) ?? "")) throw new Error(STORED_MODEL_CHOICE_UNAVAILABLE);
    }
  }
  const key = modelSelectionPolicyKey(input.companyId);
  const row = await input.store.get(key);
  if (row !== undefined && (row["orgId"] !== input.companyId || row["entityType"] !== "MODEL_SELECTION_POLICY" || row["revision"] !== policy.revision)) throw new Error(STORED_MODEL_CHOICE_UNAVAILABLE);
  const at = input.now();
  const validation = Validation.parse({ choice: { ...policy, defaultModel: input.defaultModel }, offered, validatedAt: at, expiresAt: at + VALIDATION_TTL_MS });
  const item = JSON.parse(JSON.stringify({ ...(row ?? { ...key, entityType: "MODEL_SELECTION_POLICY", orgId: input.companyId, version: 1, rankingVersion: "g3-v1", ...policy }), agentModelValidation: validation })) as StoredDocument;
  const result = await input.store.transact([{ kind: "put", item, condition: row === undefined ? when.absent() : when.eq("revision", policy.revision) }]);
  if (!result.applied) throw new Error(STORED_MODEL_CHOICE_UNAVAILABLE);
}

/** Re-read on EVERY choice. No cached success outlives its TTL or a company policy edit. Never calls the offered-models route. */
export function storedAgentModelChoice(input: { store: Pick<DocumentStore, "get">; companyId: OrgId; now: () => number }): Pick<ModelSelectionService, "choose"> {
  return { async choose(request) {
    try {
      const key = modelSelectionPolicyKey(input.companyId);
      const row = await input.store.get(key);
      if (row === undefined || row.pk !== key.pk || row.sk !== key.sk || row["orgId"] !== input.companyId || row["entityType"] !== "MODEL_SELECTION_POLICY") return refused();
      const parsed = Validation.safeParse(row["agentModelValidation"]);
      if (!parsed.success) return refused();
      const { choice, offered, validatedAt, expiresAt } = parsed.data;
      const now = input.now();
      if (validatedAt > now || expiresAt <= now || expiresAt <= validatedAt || expiresAt - validatedAt > VALIDATION_TTL_MS || row["revision"] !== choice.revision
        || !isDeepStrictEqual(row["stepOverrides"], choice.stepOverrides) || row["reviewDefault"] !== choice.reviewDefault) return refused();
      const names = new Set(offered.models.map((model) => model.model));
      if (!names.has(choice.defaultModel) || Object.values(choice.stepOverrides).some((setting) => [setting?.model, setting?.fallbackModel].some((model) => model !== undefined && !names.has(agentModelName(model) ?? "")))) return refused();
      const service = createModelSelection({ companyId: input.companyId, store: { get: async () => row, put: async () => { throw new Error("read only"); }, transact: async () => { throw new Error("read only"); } },
        audit: { stage: () => [], record: async () => undefined }, approvers: { requirement: async () => { throw new Error("read only"); }, verify: async () => { throw new Error("read only"); } },
        now: input.now, capApplies: () => false, prices: { find: () => undefined, findCap: () => undefined }, usable: { unusable: async () => new Set<string>(), markUnusable: async () => undefined },
        seams: { servable: async () => offered.models.map((entry) => agentModelIdentity(entry.model)), installModel: async () => agentModelIdentity(choice.defaultModel),
          canServe: async (model) => names.has(agentModelName(model) ?? ""), route: async (model) => { const name = agentModelName(model); return name === undefined || !names.has(name) ? undefined : { alias: name, api: "anthropic-messages", catalog: name }; } },
      });
      const chosen = await service.choose(request);
      return chosen.ok ? chosen : refused();
    } catch { return refused(); }
  } };
}

/** Dispatcher policy: only absence or expiry uses the install's configured default; malformed and off-list state still refuses. */
export function dispatcherStoredAgentModelChoice(input: { store: Pick<DocumentStore, "get">; companyId: OrgId; now: () => number; defaultRoute: () => Promise<InvocationModelRoute | undefined>; log: (entry: Record<string, unknown>) => void }): Pick<ModelSelectionService, "choose"> {
  const validated = storedAgentModelChoice(input);
  return { async choose(request) {
    try {
    const key = modelSelectionPolicyKey(input.companyId);
    const row = await input.store.get(key);
    if (row === undefined || row.pk !== key.pk || row.sk !== key.sk || row["orgId"] !== input.companyId || row["entityType"] !== "MODEL_SELECTION_POLICY") {
      if (row !== undefined) return refused();
      return dispatcherDefault(input.defaultRoute);
    }
    // A company's model rule without a validated choice (the broker's model choice is off, or never published): no stored choice, so the default model.
    if (row["agentModelValidation"] === undefined) return dispatcherDefault(input.defaultRoute);
    const parsed = Validation.safeParse(row["agentModelValidation"]);
    if (!parsed.success) return refused();
    const { choice, offered, validatedAt, expiresAt } = parsed.data;
    const now = input.now();
    const names = new Set(offered.models.map((model) => model.model));
    if (row["revision"] !== choice.revision || !isDeepStrictEqual(row["stepOverrides"], choice.stepOverrides) || row["reviewDefault"] !== choice.reviewDefault
      || !names.has(choice.defaultModel) || Object.values(choice.stepOverrides).some((setting) => [setting?.model, setting?.fallbackModel].some((model) => model !== undefined && !names.has(agentModelName(model) ?? "")))) return refused();
    if (expiresAt <= now && expiresAt > validatedAt && expiresAt - validatedAt <= VALIDATION_TTL_MS) {
      input.log({ component: "dispatcher", event: "core_engine.model_choice_expired" });
      return dispatcherDefault(input.defaultRoute);
    }
    return validated.choose(request);
    } catch { return refused(); }
  } };
}

async function dispatcherDefault(defaultRoute: () => Promise<InvocationModelRoute | undefined>): Promise<StepChoice> {
  const route = await defaultRoute();
  if (route === undefined) return refused();
  return { ok: true, step: { model: agentModelIdentity(route.alias), thinkingLevel: null, reason: "INSTALL_MODEL", sameModelAsChecked: false, route } };
}
