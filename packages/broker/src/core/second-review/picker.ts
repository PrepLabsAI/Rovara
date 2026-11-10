// Second review: the model picker. Pure: it reads nothing and calls no model; the caller gives the models the company can actually use (its connected sources plus Rovara's own,
// from `servableModels`), what is allowed, the recorded models the reviewer must differ from, and a price lookup. It makes the LIST a company sees (each entry: maker, estimated cost per review, fit, notes), the
// 2 to 3 SUGGESTIONS (marked, with a one-line reason made of fixed words), and nothing else: the choice is the company's, and the default (the top suggestion) is used only while nobody has chosen.
//
// There is no hidden driving-test gate: any eligible model may run in shadow straight away. Running in `on` (blocking) is a separate step that needs a track record (see second-review.ts, `verified`).
import {
  canonicalModelName, modelCompany, secondReviewModelKey, secondReviewedByLine, type ModelCompany, type ModelIdentifier, type SecondReviewModelRef, type SecondReviewReplayRun, type SecondReviewVerdict, secondReviewVerdictHolds,
} from "@agentx/contracts";
import { isBatchVariant, isFreeVariant } from "./model-variants.js";
import { candidatesOf, criticCapabilityTier, differentCompany, rankCriticModels, type CriticModelLimits } from "./model-ranking.js";

/** A typical review's size: one place for the cost estimate shown beside each model (tokens in and out). No prompt caching is assumed. */
export const SECOND_REVIEW_TYPICAL_REVIEW_TOKENS = { input: 60_000, output: 4_000 } as const;
/** How many entries are marked suggested. */
export const SECOND_REVIEW_SUGGESTIONS_MAX = 3;

/** A catalog price per million tokens. */
/** `cacheReadUsdPerMTok` and `cacheWriteUsdPerMTok` are set only when the catalog lists them (design review reviewers use it; the second-review estimate ignores it). */
export interface SecondReviewPrice { inputUsdPerMTok: number; outputUsdPerMTok: number; cacheReadUsdPerMTok?: number | undefined; cacheWriteUsdPerMTok?: number | undefined }

/** The estimated cost of one review from a catalog price and the typical review size. */
export function estimateSecondReviewUsd(price: SecondReviewPrice, tokens: { input: number; maxOutput: number }): number {
  return (tokens.input * price.inputUsdPerMTok + tokens.maxOutput * price.outputUsdPerMTok) / 1_000_000;
}

export type PickerIneligibleWhy = "same-company" | "company-unknown";

export interface PickerEntry {
  model: SecondReviewModelRef;
  company: ModelCompany;
  /** The estimated cost of one review in US dollars, or undefined when the catalog has no price. */
  costUsd: number | undefined;
  eligible: boolean;
  ineligibleWhy?: PickerIneligibleWhy;
  /** Fixed-word notes (for example a `:free` variant: the provider may train on the code). */
  notes: string[];
  suggested: boolean;
  /** One line of fixed words, only on a suggested entry. */
  suggestionReason?: string;
  /** The evidence line when the model has a verdict on record (what shadow showed), else absent. */
  trackRecord?: string;
}

export interface PickerInput {
  /** The models the company can use: `servableModels` (its connected sources plus Rovara's own). When empty, the project's approved list stands in. */
  sources: readonly ModelIdentifier[];
  project: { approved?: readonly ModelIdentifier[] | undefined };
  forbidden: CriticModelLimits["forbidden"];
  unusable?: readonly ModelIdentifier[] | undefined;
  /** The recorded models the reviewer must differ in company from (every build's and the first reviewer's). */
  against: readonly ModelIdentifier[];
  /** The company's settings page does not know which model writes the code (it differs per task): fit is then only "its maker is known", and the list says so. */
  fitUnknown?: boolean | undefined;
  price?: ((model: ModelIdentifier) => SecondReviewPrice | undefined) | undefined;
  verdicts?: readonly SecondReviewVerdict[] | undefined;
  replayRuns?: readonly SecondReviewReplayRun[] | undefined;
  /** The task started before the frontier tier: its default stays the one the old order gave (`CriticModelLimits.legacyRanking`). */
  legacyRanking?: boolean | undefined;
}

// By capability tier (model-ranking.ts): frontier, Sonnet, small; a model no tier names reads as the last.
const STRENGTH_WORDS = ["high strength", "good strength", "lighter and faster"] as const;
// `isFreeVariant` lives in model-variants.ts; re-exported for the callers that import it from here.
export { isFreeVariant };

function priceBand(costUsd: number | undefined): string {
  if (costUsd === undefined) return "price unknown";
  return costUsd < 0.1 ? "low cost" : costUsd < 0.5 ? "medium cost" : "higher cost";
}

const money = (value: number): string => `$${value.toFixed(value < 0.1 ? 3 : 2)}`;

/** What a model's track record says, in fixed words: what the people on the team agreed with while it ran in shadow. Absent without a verdict that still holds. */
export function secondReviewTrackRecord(verdict: Pick<SecondReviewVerdict, "shadow">): string {
  const days = Math.max(0, Math.floor((Date.parse(verdict.shadow.endedAt) - Date.parse(verdict.shadow.startedAt)) / 86_400_000));
  return `agreed with your team on ${String(verdict.shadow.agreed)} of ${String(verdict.shadow.findings)} findings over ${String(days)} days`;
}

/**
 * The list, with fit and suggestions. Only models the company can actually use are listed (the allowed ones of `sources`: not forbidden, not outside the project's approved list, not found unusable); a model from
 * the SAME company as a recorded one, or whose maker is unknown, is listed greyed out with the reason. Strongest first (the critic's capability tiers; the order of the sources decides nothing).
 */
export function secondReviewPicker(input: PickerInput): { entries: PickerEntry[]; suggested: PickerEntry[] } {
  const limits: CriticModelLimits = { approved: input.project.approved, forbidden: input.forbidden, unusable: input.unusable, legacyRanking: input.legacyRanking };
  // Every route the company can use, each exactly as the source lists it (a `:free` variant is its own entry, not the same model as the paid one): allowed by the limits, strongest first.
  const exact = new Map<string, ModelIdentifier>();
  // LP-11: an OpenRouter `:batch` variant is the Batch API's id (half price, answered within a day), never one for a review, so it is not listed or suggested.
  for (const model of input.sources.length > 0 ? input.sources : input.project.approved ?? []) if (!isBatchVariant(model)) exact.set(secondReviewModelKey(model), model);
  const usable = rankCriticModels([...exact.values()].filter((model) => candidatesOf(limits, [model]).length > 0), undefined, input.legacyRanking === true);
  const entries: PickerEntry[] = usable.map((model) => {
    const company = modelCompany(model);
    const eligible = company !== "other" && (input.fitUnknown === true || (input.against.length > 0 && input.against.every((other) => differentCompany(model, other))));
    const price = input.price?.(model);
    const verdict = (input.verdicts ?? []).find((entry) => entry.model === secondReviewModelKey(model) && secondReviewVerdictHolds(entry, (input.replayRuns ?? []).find((run) => run.runId === entry.replayRunId)));
    return {
      model: { provider: model.provider, modelId: model.modelId },
      company,
      costUsd: price === undefined ? undefined : estimateSecondReviewUsd(price, { input: SECOND_REVIEW_TYPICAL_REVIEW_TOKENS.input, maxOutput: SECOND_REVIEW_TYPICAL_REVIEW_TOKENS.output }),
      eligible,
      ...(eligible ? {} : { ineligibleWhy: company === "other" ? "company-unknown" as const : "same-company" as const }),
      notes: isFreeVariant(model) ? ["the provider may train on the code sent to a free model"] : [],
      suggested: false,
      ...(verdict === undefined ? {} : { trackRecord: secondReviewTrackRecord(verdict) }),
    };
  });
  // Suggestions: the strongest eligible entries, never a free variant (it may train on the code), at most three, one line each.
  let count = 0;
  for (const entry of entries) {
    if (!entry.eligible || entry.notes.length > 0 || count >= SECOND_REVIEW_SUGGESTIONS_MAX) continue;
    count += 1;
    entry.suggested = true;
    const tier = criticCapabilityTier(entry.model);
    entry.suggestionReason = `${STRENGTH_WORDS[Math.min(tier, STRENGTH_WORDS.length - 1)]}; a different AI company than the one that wrote the code; ${priceBand(entry.costUsd)}${entry.costUsd === undefined ? "" : ` (about ${money(entry.costUsd)} a review)`}`;
  }
  return { entries, suggested: entries.filter((entry) => entry.suggested) };
}

/** Whether a canonical name is the same model as another (used to find a named model in the list regardless of route). */
export const sameCanonical = (left: ModelIdentifier, right: ModelIdentifier): boolean => canonicalModelName(left) === canonicalModelName(right);

/** The line the task page and the preview show while nobody has chosen: "Using default: <model> (change)", or "(previous no longer fits)" when the earlier default dropped out. */
export const defaultModelLine = (model: SecondReviewModelRef, previousNoLongerFits: boolean): string => secondReviewedByLine({ ...model, choice: "default", defaultChanged: previousNoLongerFits });
