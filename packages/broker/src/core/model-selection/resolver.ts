// One choice function. Callers supply server-read policy and source evidence, never browser attestations.
import { StageModelChoiceSchema, canonicalModelName, forbiddenModelMatcher, modelCompany, sameModelOrUnrecognised, type ModelSelection, type ModelIdentifier, type StageId, type StageModelChoice, type StageModelRefusalCode, type ModelFallback, type ThinkingLevel } from "@agentx/contracts";
import { reviewerModelFor } from "./reviewer-model.js";
import { meetsReviewDefaultFloor } from "./review-default-pool.js";

export { STAGE_OPERATION_MAPPING, STAGE_EDIT_GROUPS, STAGE_EDIT_RULES } from "@agentx/contracts";
export interface SourceModelEvidence {
  orgId: string;
  sourcesRevision: number;
  kind: "rovara_catalog" | "tested_bedrock_role" | "stored_key" | "qualified_endpoint" | "chatgpt_connection";
  payerDeveloperId?: string;
  connectionRevision?: string;
}
export interface VerifiedStageCandidate {
  model: ModelIdentifier;
  sourceId: string;
  enabled: boolean;
  inEffectiveOrder: boolean;
  evidence?: SourceModelEvidence | undefined;
  /** The kind of the company source the candidate came from, set from the live record. `qualified_endpoint` evidence counts only for an `endpoint` source. */
  sourceKind?: string | undefined;
  /** Owner decision 2026-11-03: the account is known not to be able to call this model now (an Amazon Bedrock model it has not enabled). A default choice prefers any other candidate; an explicit choice still stands. See `resolveStageModel`. */
  accountCannotUse?: true | undefined;
}
export interface StageModelInput {
  orgId: string;
  stage: StageId;
  sourcesRevision: number;
  payerDeveloperId?: string | undefined;
  connectionRevision?: string | undefined;
  candidates: readonly VerifiedStageCandidate[];
  forbidden: readonly ModelIdentifier[];
  approved?: readonly ModelIdentifier[] | undefined;
  companyLock?: StageModelChoice | undefined;
  projectChoice?: StageModelChoice | undefined;
  companyDefault?: StageModelChoice | undefined;
  /** Provenance of a model inherited below partial company metadata. Server-only. */
  companyDefaultOrigin?: "recipe" | undefined;
  projectSelection?: ModelSelection | undefined;
  projectDefault?: ModelSelection | undefined;
  builtinDefault?: ModelIdentifier | undefined;
  defaultFallbacks?: readonly ModelIdentifier[] | undefined;
  /** The review default of owner decision 2026-11-02 applies: set for a task pinned with it and for the live How we work read; a task pinned before it resolves as it did. */
  reviewDefaultDifferentCompany?: boolean | undefined;
  /** Verified server-selected default preference (for example the payer's personal plan). */
  defaultPreferred?: ModelIdentifier | undefined;
  referenceModel?: ModelIdentifier | undefined;
  /** Default-only historical reviewer/critic fallback, never set for an explicit stage choice. */
  allowLegacyDefaultFallback?: boolean | undefined;
  defaultLastAttempt?: boolean | undefined;
  requireDifferentVendor?: boolean | undefined;
  deniedModels?: readonly ModelIdentifier[] | undefined;
  /** Only an approval validated against the task's frozen recipe and pinned policy may populate this input. */
  sameModelApproval?: { model: ModelIdentifier; referenceModel: ModelIdentifier } | undefined;
}
export type StageDecisionReason = "COMPANY_LOCK" | "PROJECT_CHOICE" | "COMPANY_DEFAULT" | "PROJECT_SELECTION" | "PROJECT_DEFAULT" | "BUILTIN_DEFAULT" | "PERSONAL_PLAN_DEFAULT" | "RECIPE_DEFAULT" | "APPROVED_SAME_MODEL" | "DEFAULT_DIFFERENT_COMPANY";
export type StageModelResult = { kind: "refusal"; code: StageModelRefusalCode } | {
  kind: "resolved"; model: ModelIdentifier; sourceId: string; thinkingLevel: ThinkingLevel | null;
  reason: StageDecisionReason; locked: boolean; fallback?: ModelFallback;
  /** Set when a checking step's default is "a different company" and no other company's model was usable, so the same company's model runs it (shown as a fixed sentence). */
  noOtherCompany?: true;
  /** The same, but another company's model was usable and failed (the account refused it), so the same company's model runs the step. */
  otherCompanyFailed?: true;
};
const same = (a: ModelIdentifier, b: ModelIdentifier): boolean => canonicalModelName(a) === canonicalModelName(b);
const label = (model: ModelIdentifier): string => `${model.provider}/${model.modelId}`;
const checking = (stage: StageId): boolean => stage === "plan_check" || stage === "code_review" || stage === "security_review";
/** Both models are from known companies and the companies differ (a model of an unrecognised company can never be shown to differ). */
const otherCompany = (model: ModelIdentifier, reference: ModelIdentifier): boolean => { const own = modelCompany(model), prior = modelCompany(reference); return own !== "other" && prior !== "other" && own !== prior; };
/** The model is the reference itself or from the reference's recognised company. */
const sameCompany = (model: ModelIdentifier, reference: ModelIdentifier): boolean => same(model, reference) || (modelCompany(model) !== "other" && modelCompany(model) === modelCompany(reference));

/** Evidence proves source-level access per the owner's v1.1 rule, not a per-model successful test or future provider availability. */
export function stageCandidateVerified(input: StageModelInput, candidate: VerifiedStageCandidate): boolean {
  const evidence = candidate.evidence;
  if (!candidate.enabled || !candidate.inEffectiveOrder || evidence === undefined || evidence.orgId !== input.orgId || evidence.sourcesRevision !== input.sourcesRevision) return false;
  if ((input.deniedModels ?? []).some((model) => same(model, candidate.model))) return false;
  if (candidate.sourceId === "personal-chatgpt") return evidence.kind === "chatgpt_connection" && input.payerDeveloperId !== undefined && evidence.payerDeveloperId === input.payerDeveloperId && input.connectionRevision !== undefined && evidence.connectionRevision === input.connectionRevision;
  if (candidate.sourceId === "rovara") return evidence.kind === "rovara_catalog";
  if (!/^src_[a-z0-9]{20}$/u.test(candidate.sourceId)) return false;
  if (evidence.kind === "qualified_endpoint") return candidate.sourceKind === "endpoint";
  // The other company-source proofs are never a company endpoint's.
  return (evidence.kind === "tested_bedrock_role" || evidence.kind === "stored_key") && candidate.sourceKind !== "endpoint";
}

const projectDefaultChoice=(model:ModelSelection)=>StageModelChoiceSchema.safeParse({model:{provider:model.provider,modelId:model.modelId},...(model.thinkingLevel===undefined?{}:{thinkingLevel:model.thinkingLevel})});

/**
 * Owner decision 2026-11-03: Rovara picks only models the account can actually call. When some candidates are marked `accountCannotUse`, the choice is made without them first; if that finds a model it is the answer,
 * recorded as a fallback from the model the choice would have been (so the task says why: the default model was not usable), and if it finds none (nothing else is usable, or a choice somebody made explicitly or locked
 * names only an unusable model) the choice is made exactly as before, with them. So this never refuses what was accepted before, and never overrides what a person chose.
 */
export function resolveStageModel(input: StageModelInput): StageModelResult {
  if (!input.candidates.some((candidate) => candidate.accountCannotUse === true)) return resolveStageModelOnce(input);
  const usable = resolveStageModelOnce({ ...input, candidates: input.candidates.filter((candidate) => candidate.accountCannotUse !== true) });
  const preferred = resolveStageModelOnce(input);
  if (usable.kind === "refusal") return preferred;
  if (preferred.kind === "refusal" || (same(usable.model, preferred.model) && usable.sourceId === preferred.sourceId)) return usable;
  // The same model on a different source (one source cannot serve it, another can) is not a different model: the note then names none, never the model that ran as the one that was unavailable.
  const wanted = same(preferred.model, usable.model) ? null : label(preferred.model);
  // A fallback that already names what was asked for keeps it. One that names nothing (the model that ran was the only one left) is told the model the choice would have been, so the note says which model was unavailable.
  if (usable.fallback !== undefined) return usable.fallback.wanted === null ? { ...usable, fallback: { ...usable.fallback, wanted } } : usable;
  return { ...usable, fallback: { stage: input.stage, used: label(usable.model), wanted, reasonCode: "DEFAULT_MODEL_UNAVAILABLE" } };
}

function resolveStageModelOnce(input: StageModelInput): StageModelResult {
  const locked = input.companyLock !== undefined;
  const candidates = input.candidates.filter((candidate) => stageCandidateVerified(input, candidate));
  const permitted = (model: ModelIdentifier): StageModelRefusalCode | undefined => {
    if (forbiddenModelMatcher(input.forbidden)(model)) return "MODEL_FORBIDDEN";
    if (input.approved !== undefined && !input.approved.some((allowed) => same(model, allowed))) return "MODEL_NOT_ALLOWED_IN_PROJECT";
    return undefined;
  };
  const eligible = candidates.filter((candidate) => permitted(candidate.model) === undefined);
  const independent = (model: ModelIdentifier): boolean => {
    if (!checking(input.stage)) return true;
    const reference = input.referenceModel;
    if (reference === undefined) return false;
    if (input.requireDifferentVendor === true || choice?.differentFrom?.level === "vendor") {
      const own = modelCompany(model), prior = modelCompany(reference);
      return own !== "other" && prior !== "other" && own !== prior;
    }
    if (!sameModelOrUnrecognised(model, reference)) return true;
    const approval = input.sameModelApproval;
    return approval !== undefined && same(approval.model, model) && same(approval.referenceModel, reference);
  };
  const refusal = (code: StageModelRefusalCode): StageModelResult => ({ kind: "refusal", code: locked ? "LOCK_UNSATISFIABLE" : code });
  const finish = (candidate: VerifiedStageCandidate, choice: StageModelChoice, reason: StageDecisionReason, wanted?: ModelIdentifier, fallbackCode?: ModelFallback["reasonCode"]): Extract<StageModelResult, { kind: "resolved" }> => ({
    kind: "resolved", model: candidate.model, sourceId: candidate.sourceId, thinkingLevel: choice.thinkingLevel ?? null, locked,
    reason: fallbackCode !== "DEFAULT_MODEL_UNAVAILABLE" && checking(input.stage) && input.referenceModel !== undefined && input.sameModelApproval !== undefined && same(candidate.model, input.referenceModel) && same(input.sameModelApproval.model, candidate.model) && same(input.sameModelApproval.referenceModel, input.referenceModel) ? "APPROVED_SAME_MODEL" : reason,
    // A fallback never names the model that ran as the one that was asked for (the legacy same-model default passes the step's reference model, which is the model that runs): that reads "Used X because X was unavailable".
    ...(fallbackCode === undefined ? {} : { fallback: { stage: input.stage, used: label(candidate.model), wanted: wanted === undefined || same(wanted, candidate.model) ? null : label(wanted), reasonCode: fallbackCode } }),
  });
  let choice: StageModelChoice | undefined;
  let reason: StageDecisionReason = "BUILTIN_DEFAULT";
  let explicit = false;
  if (input.companyLock !== undefined) { choice = input.companyLock; reason = "COMPANY_LOCK"; explicit = true; }
  else if (input.projectChoice?.model !== undefined) { choice = input.projectChoice; reason = "PROJECT_CHOICE"; explicit = true; }
  else if (input.companyDefault?.model !== undefined) { choice = input.companyDefault; reason = input.companyDefaultOrigin === "recipe" ? "RECIPE_DEFAULT" : "COMPANY_DEFAULT"; explicit = true; }
  else if (!checking(input.stage) && input.projectSelection !== undefined) { const parsed=projectDefaultChoice(input.projectSelection);if(!parsed.success)return refusal("MODEL_NOT_VERIFIED");choice=parsed.data; reason = "PROJECT_SELECTION"; }
  else if (!checking(input.stage) && input.defaultPreferred !== undefined) { choice = { model: input.defaultPreferred }; reason = "PERSONAL_PLAN_DEFAULT"; }
  else if (!checking(input.stage) && input.projectDefault !== undefined) { const parsed=projectDefaultChoice(input.projectDefault);if(!parsed.success)return refusal("MODEL_NOT_VERIFIED");choice=parsed.data; reason = "PROJECT_DEFAULT"; }
  else if (!checking(input.stage) && input.builtinDefault !== undefined) choice = { model: input.builtinDefault };

  // Model precedence and field inheritance are separate: metadata-only settings still apply.
  // Undefined inherits; null explicitly resets effort to the model default. A lock freezes the tuple.
  if (!locked) {
    const inherited: StageModelChoice = { ...choice };
    for (const layer of [input.companyDefault, input.projectChoice]) {
      if (layer === undefined) continue;
      if (layer.thinkingLevel !== undefined) inherited.thinkingLevel = layer.thinkingLevel;
      if (layer.fallbackModel !== undefined) inherited.fallbackModel = layer.fallbackModel;
      if (layer.differentFrom !== undefined) inherited.differentFrom = layer.differentFrom;
    }
    choice = inherited;
  }
  if (checking(input.stage) && input.referenceModel === undefined) return refusal("MODEL_NOT_VERIFIED");
  const wanted = choice?.model;
  if (wanted !== undefined) {
    const problem = permitted(wanted);
    const found = eligible.find((candidate) => candidate.model.provider === wanted.provider && candidate.model.modelId === wanted.modelId);
    if (problem === undefined && found !== undefined && independent(found.model)) return finish(found, choice ?? {}, reason);
    const fallback = choice?.fallbackModel;
    if (fallback !== undefined) {
      const next = eligible.find((candidate) => candidate.model.provider === fallback.provider && candidate.model.modelId === fallback.modelId && independent(candidate.model));
      if (next !== undefined) return finish(next, choice ?? {}, reason, wanted, "CONFIGURED_FALLBACK");
    }
    if (explicit) return refusal(problem ?? (found !== undefined ? "DIFFERENT_FROM_UNSATISFIABLE" : "MODEL_NOT_VERIFIED"));
  }
  if (checking(input.stage)) {
    // Owner decision 2026-11-02: a checking step nobody has set (no lock, model or rule at any level) defaults to the strongest usable model of a different company than the step it checks. When no such model is usable
    // it keeps today's behaviour (the same company's other model, then the legacy same-model fallback) and says so; it never blocks the task.
    // A task pinned before the review default (no marker on its pin) ranks the models as it did when it started, so its next review or plan check cannot change model because the order did.
    const legacyRanking = input.reviewDefaultDifferentCompany !== true;
    const defaultVendor = input.reviewDefaultDifferentCompany === true && !explicit && choice?.differentFrom === undefined && input.requireDifferentVendor !== true;
    const reference = input.referenceModel;
    // The models the default may take: another company's, of a good capability tier (the floor), and never through a person's ChatGPT plan (the company's own sources serve the default).
    const usableAbroad = (candidate: VerifiedStageCandidate): boolean => reference !== undefined && otherCompany(candidate.model, reference) && meetsReviewDefaultFloor(candidate.model) && candidate.sourceId !== "personal-chatgpt";
    const abroad = defaultVendor ? eligible.filter(usableAbroad) : [];
    // Whether such a model exists at all, before an earlier try's failures are left out: it tells "none is available" from "the one there was failed".
    const abroadExisted = defaultVendor && input.candidates.some((candidate) => stageCandidateVerified({ ...input, deniedModels: [] }, candidate) && permitted(candidate.model) === undefined && usableAbroad(candidate));
    const mark = (result: Extract<StageModelResult, { kind: "resolved" }>): StageModelResult => !defaultVendor || reference === undefined || !sameCompany(result.model, reference) ? result : abroadExisted ? { ...result, otherCompanyFailed: true } : { ...result, noOtherCompany: true };
    if (!explicit && input.allowLegacyDefaultFallback === true && input.defaultLastAttempt === true && input.requireDifferentVendor !== true && choice?.differentFrom?.level !== "vendor") {
      const last = reviewerModelFor({ step: undefined, legacyRanking, builderModel: input.referenceModel, unusable: input.deniedModels, lastAttempt: true, project: { approved: eligible.map(entry => entry.model) }, guardrails: { forbiddenModels: [...input.forbidden] }, sources: eligible.map(entry => entry.model) });
      if (last?.chosenBy === "rovara" && input.referenceModel !== undefined && same(last.model, input.referenceModel)) {
        const candidate = eligible.find(entry => entry.model.provider === last.model.provider && entry.model.modelId === last.model.modelId);
        if (candidate !== undefined) return mark(finish(candidate, choice ?? {}, reason, input.referenceModel, "DEFAULT_MODEL_UNAVAILABLE"));
      }
    }
    if (defaultVendor && reference !== undefined) {
      const strongest = reviewerModelFor({ step: undefined, legacyRanking, builderModel: reference, unusable: input.deniedModels, project: { approved: abroad.map((candidate) => candidate.model) }, guardrails: { forbiddenModels: [...input.forbidden] }, sources: abroad.map((candidate) => candidate.model) });
      if (strongest?.chosenBy === "rovara") {
        const candidate = abroad.find((entry) => entry.model.provider === strongest.model.provider && entry.model.modelId === strongest.model.modelId);
        if (candidate !== undefined) return finish(candidate, choice ?? {}, "DEFAULT_DIFFERENT_COMPANY");
      }
    }
    // Reuse the existing interim rule, but pass only verified eligible candidates. Its implicit same-model result cannot waive approval.
    // The default never takes a model of a weak tier or a person's ChatGPT plan from another company, even by the model-level rule or the legacy fallback below. Where nothing else is left and the legacy fallback is off
    // (publish-time validation), today's pool stands, so the default never refuses what was accepted before.
    const weakAbroad = (candidate: VerifiedStageCandidate): boolean => defaultVendor && reference !== undefined && !sameCompany(candidate.model, reference) && (!meetsReviewDefaultFloor(candidate.model) || candidate.sourceId === "personal-chatgpt");
    const strongEligible = eligible.filter((candidate) => !weakAbroad(candidate));
    let pool = strongEligible.filter((candidate) => independent(candidate.model));
    if (pool.length === 0 && input.allowLegacyDefaultFallback !== true) pool = eligible.filter((candidate) => independent(candidate.model));
    const chosen = reviewerModelFor({ step: undefined, legacyRanking, builderModel: input.referenceModel, unusable: input.deniedModels, project: { approved: pool.map((candidate) => candidate.model) }, guardrails: { forbiddenModels: [...input.forbidden] }, sources: pool.map((candidate) => candidate.model) });
    if (chosen?.chosenBy === "rovara") {
      const candidate = pool.find((entry) => entry.model.provider === chosen.model.provider && entry.model.modelId === chosen.model.modelId);
      if (candidate !== undefined) return mark(finish(candidate, choice ?? {}, reason));
    }
    if (!explicit && input.allowLegacyDefaultFallback === true && input.requireDifferentVendor !== true && choice?.differentFrom?.level !== "vendor") {
      const legacy = reviewerModelFor({ step: undefined, legacyRanking, builderModel: input.referenceModel, unusable: input.deniedModels, project: { approved: strongEligible.map((entry) => entry.model) }, guardrails: { forbiddenModels: [...input.forbidden] }, sources: strongEligible.map((entry) => entry.model) });
      if (legacy?.chosenBy === "rovara") {
        const candidate = strongEligible.find((entry) => entry.model.provider === legacy.model.provider && entry.model.modelId === legacy.model.modelId);
        if (candidate !== undefined) return mark({ ...finish(candidate, choice ?? {}, reason, input.referenceModel, "DEFAULT_MODEL_UNAVAILABLE"), reason });
      }
    }
    return refusal(eligible.length === 0 ? "NO_VERIFIED_CANDIDATE" : "DIFFERENT_FROM_UNSATISFIABLE");
  }
  for (const fallback of input.defaultFallbacks ?? []) {
    const candidate = eligible.find((entry) => entry.model.provider === fallback.provider && entry.model.modelId === fallback.modelId);
    if (candidate !== undefined) return finish(candidate, choice ?? {}, reason, wanted, "DEFAULT_MODEL_UNAVAILABLE");
  }
  return refusal("NO_VERIFIED_CANDIDATE");
}

export { classifyStageChoiceChange } from "./classify.js";
