// Owner decision 2026-11-02: a review step nobody has set defaults to the strongest usable model of a different company. The stage candidates are read for a bounded pool of models (at most `STAGE_POOL_MAX`),
// which until now held only the project's approved models (or Rovara's own Claude models) and the models a setting names; another company's model the company can use never reached it. This adds the models
// the company's sources can serve (`servableModels`), strongest first (the existing ranking), a few from each company, only while the pool has room: a named model is never displaced and the pool never grows past its limit.
// Only models of a good capability tier are added (the floor below), and the approved list is matched by provider and model id exactly, as the project's own approved models are.
import { canonicalModelName, modelCompany, type ModelIdentifier } from "@agentx/contracts";
import { candidatesOf, criticCapabilityTier } from "../second-review/model-ranking.js";

export const STAGE_POOL_MAX = 23;
const PER_COMPANY = 3;
/** A different-company model is chosen by default only if its capability tier is Sonnet's or better; a model whose tier is unknown (DeepSeek, Qwen, Nova and the like) never wins by default. */
const FLOOR_TIER = criticCapabilityTier({ provider: "anthropic", modelId: "claude-sonnet-4" });
export const meetsReviewDefaultFloor = (model: ModelIdentifier): boolean => criticCapabilityTier(model) <= FLOOR_TIER;
/** How the pool's models are compared: by canonical name, so one model offered over two routes is one model. */
export const poolKey = (model: ModelIdentifier): string => canonicalModelName(model);

/** The servable models to add to a pool of `size` models already holding `have` (their `poolKey`s), in the order they should be added. Allowed models of a good tier only (not forbidden, inside the approved list when the project has one). */
export function reviewDefaultExtras(input: { servable: readonly ModelIdentifier[]; approved: readonly ModelIdentifier[] | undefined; forbidden: readonly ModelIdentifier[]; have: ReadonlySet<string>; size: number }): ModelIdentifier[] {
  const approved = input.approved;
  const ranked = candidatesOf({ approved, forbidden: input.forbidden }, input.servable)
    .filter((model) => meetsReviewDefaultFloor(model) && (approved === undefined || approved.some((other) => other.provider === model.provider && other.modelId === model.modelId)));
  const byCompany = new Map<string, ModelIdentifier[]>();
  for (const model of ranked) {
    const company = modelCompany(model) === "other" ? `other:${model.provider}` : modelCompany(model);
    byCompany.set(company, [...(byCompany.get(company) ?? []), model]);
  }
  // Round-robin by the strength of each company's best model, so a full pool still holds every company's strongest.
  const out: ModelIdentifier[] = [];
  const room = Math.max(0, STAGE_POOL_MAX - input.size);
  for (let round = 0; round < PER_COMPANY; round += 1) {
    for (const list of byCompany.values()) {
      const model = list[round];
      if (model !== undefined && !input.have.has(poolKey(model)) && out.length < room) out.push(model);
    }
  }
  return out;
}
