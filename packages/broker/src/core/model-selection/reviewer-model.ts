// Trust fix A2: the model that reviews a version 2 task's code. A review that nobody set a model for does not run on the model that wrote the code: Rovara picks a different one the way it picks
// the plan check's (the critic's pieces, so there is one capability order and one rule for models an account cannot use), and records when only the builder's own model was usable. This is the one
// place the choice is made, with the allowed and callable models as its input, so a model resolver can later call it for the Review step's default.
import { canonicalModelName, sameModelOrUnrecognised, type ModelIdentifier, type ModelSelection } from "@agentx/contracts";
import { candidatesOf, differentCompany, type CriticModelLimits } from "../second-review/model-ranking.js";

export interface ReviewerModelInput {
  /** The review step: a model (or fallback model) the company set on it stands, and nothing is chosen. */
  step: { settings?: object | undefined } | undefined;
  /** The model the build ran on; undefined when it isn't known. */
  builderModel: ModelIdentifier | undefined;
  project: { approved?: readonly ModelIdentifier[] | undefined };
  guardrails: { forbiddenModels: readonly ModelIdentifier[] };
  /** The recorded models of the steps this review must differ in company from (the dispatch's `crossCompanyTargets`); empty when no such rule applies. */
  differentCompanyFrom?: readonly ModelIdentifier[] | undefined;
  /** The models the project's sources can serve for this org (empty when that isn't known: the approved list stands in). */
  sources: readonly ModelIdentifier[];
  /** Models this task's earlier reviews tried and the account could not use. */
  unusable?: readonly ModelIdentifier[] | undefined;
  /** This is the last try (`CRITIC_MODEL_ATTEMPTS_MAX`): the builder's own model, which this account just served, is the choice when the policy allows it. */
  lastAttempt?: boolean | undefined;
  /** The task started before the frontier tier: rank as it did then (`CriticModelLimits.legacyRanking`). */
  legacyRanking?: boolean | undefined;
}

/**
 * `company`: the step names its model; leave it to the step's ordinary checks. `rovara`: the model to set on the step for this one operation, and whether it is the builder's own. Undefined: nothing
 * to choose (nothing is known, no allowed model is left, or the company needs another company's model and none is allowed), so the step runs as it always did and the dispatch checks decide.
 */
export type ReviewerModel =
  | { chosenBy: "company" }
  | { chosenBy: "rovara"; model: ModelSelection; sameModelAsBuilder: boolean }
  | undefined;

const selectionOf = (model: ModelIdentifier): ModelSelection => ({ provider: model.provider, modelId: model.modelId });
const sameModel = (left: ModelIdentifier, right: ModelIdentifier): boolean => canonicalModelName(left) === canonicalModelName(right);

export function reviewerModelFor(input: ReviewerModelInput): ReviewerModel {
  const settings = (input.step?.settings ?? {}) as { model?: ModelIdentifier | null; fallbackModel?: ModelIdentifier | null };
  if ((settings.model ?? undefined) !== undefined || (settings.fallbackModel ?? undefined) !== undefined) return { chosenBy: "company" };
  const limits: CriticModelLimits = { approved: input.project.approved, forbidden: input.guardrails.forbiddenModels, unusable: input.unusable, reference: input.builderModel, legacyRanking: input.legacyRanking };
  const another = input.differentCompanyFrom ?? [];
  const candidates = candidatesOf(limits, input.sources).filter((model) => another.every((other) => differentCompany(model, other)));
  const builder = input.builderModel;
  // The last try: the builder's own model answered this account a moment ago, so a review on it (saying so) beats none. Never when the company needs another company's model.
  if (input.lastAttempt === true && builder !== undefined && another.length === 0 && candidates.some((model) => sameModel(model, builder))) {
    return { chosenBy: "rovara", model: selectionOf(builder), sameModelAsBuilder: true };
  }
  const different = builder === undefined ? candidates[0] : candidates.find((model) => !sameModelOrUnrecognised(model, builder));
  if (different !== undefined) return { chosenBy: "rovara", model: selectionOf(different), sameModelAsBuilder: false };
  // Only the builder's model is usable (and no other company is needed): it reviews, and the review says so.
  const only = candidates[0];
  return only === undefined || another.length > 0 ? undefined : { chosenBy: "rovara", model: selectionOf(only), sameModelAsBuilder: true };
}
