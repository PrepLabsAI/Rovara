// TE-F10, DECISIONS 170 (owner 2026-11-13): the judge is PINNED and its identity is part of the evidence. Its model, version and scoring prompt are fixed before the task starts; it comes from a different model family than the product
// model and the coding model, or else it was spot-checked against human labels (and the rendering says so). A run whose judge breaks one of these rules is refused before any call is made. Side-by-side stays evidence shown to people:
// it is never a proof label (no "Proven", no "No regression measured", no "Improved on eval" here).
// Pure: no clock, no randomness, no file, no network. Times are compared as fixed-shape UTC text, so no clock API is needed. No callers yet.
import { createHash } from "node:crypto";
import { SIDE_BY_SIDE_JUDGE_ROLE } from "./side-by-side-judge.js";

/** What is fixed about the judge. */
export interface SideBySideJudgePin {
  /** The judge's model name and exact version, as the provider names them. */
  readonly model: string;
  readonly version: string;
  /** The judge's model family (the vendor's line of models: `claude`, `gemini`, `gpt`), compared with the product's and the coding model's. */
  readonly family: string;
  /** SHA-256 of the scoring prompt the judge is run with: it must be the code's own role text. */
  readonly scoringPromptSha256: string;
  /** When the pin was made, UTC, `YYYY-MM-DDTHH:MM:SSZ`. It must be BEFORE the task started. */
  readonly pinnedAt: string;
}
/** A spot check of the judge against labels people wrote, required when the judge shares a family with the product or the coding model. */
export interface SideBySideHumanCheck {
  readonly labelSetId: string;
  /** Share of the sampled cases where the judge agreed with the people's label, 0 to 1. */
  readonly agreement: number;
  readonly sampleSize: number;
  readonly checkedAt: string;
}
export const SIDE_BY_SIDE_SPOT_CHECK_MIN_AGREEMENT = 0.8;
export const SIDE_BY_SIDE_SPOT_CHECK_MIN_SAMPLES = 20;

export type SideBySideJudgeIndependence = "different_family" | "spot_checked_against_human_labels";
/** The judge as the evidence names it. */
export interface SideBySideJudgeIdentity extends SideBySideJudgePin {
  readonly independence: SideBySideJudgeIndependence;
  readonly humanCheck?: SideBySideHumanCheck;
}
export type SideBySideJudgePinRefusal = "judge_pin_invalid" | "judge_pinned_after_task" | "judge_same_family_unchecked";

const NAME = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/u;
const FAMILY = /^[a-z][a-z0-9_-]{0,39}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
/** Exact UTC text to the second: two such strings compare in time order as plain text. */
const UTC = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\dZ$/u;

/** The hash a pin must carry: the scoring prompt is the code's role text. */
export const sideBySideScoringPromptSha256 = (): string => createHash("sha256").update(SIDE_BY_SIDE_JUDGE_ROLE).digest("hex");

const familyOf = (value: unknown): string | undefined => (typeof value === "string" && FAMILY.test(value.trim().toLowerCase()) ? value.trim().toLowerCase() : undefined);

/**
 * The judge's identity for the evidence, or the reason the judge may not be used. Refused: a pin with a missing or malformed field, or a scoring prompt that is not the code's; a pin made at or after the task started (or with a time that
 * is not exact UTC text); a judge in the same family as the product model or the coding model (or a family that cannot be told) with no spot check, a spot check that is too small, too weak, or made after the task started.
 */
export function checkSideBySideJudgePin(args: {
  readonly pin: SideBySideJudgePin;
  readonly taskStartedAt: string;
  readonly productModelFamily: string;
  readonly codingModelFamily?: string | undefined;
  readonly humanCheck?: SideBySideHumanCheck | undefined;
}): { readonly ok: true; readonly identity: SideBySideJudgeIdentity } | { readonly ok: false; readonly reason: SideBySideJudgePinRefusal } {
  const pin = args.pin as Partial<SideBySideJudgePin> | undefined;
  const judgeFamily = familyOf(pin?.family);
  if (
    pin === undefined || typeof pin.model !== "string" || !NAME.test(pin.model) || typeof pin.version !== "string" || !NAME.test(pin.version) || judgeFamily === undefined ||
    typeof pin.scoringPromptSha256 !== "string" || !SHA256.test(pin.scoringPromptSha256) || pin.scoringPromptSha256 !== sideBySideScoringPromptSha256() ||
    typeof pin.pinnedAt !== "string" || !UTC.test(pin.pinnedAt) || typeof args.taskStartedAt !== "string" || !UTC.test(args.taskStartedAt)
  ) return { ok: false, reason: "judge_pin_invalid" };
  if (!(pin.pinnedAt < args.taskStartedAt)) return { ok: false, reason: "judge_pinned_after_task" };

  const productFamily = familyOf(args.productModelFamily);
  const codingFamily = args.codingModelFamily === undefined ? undefined : familyOf(args.codingModelFamily);
  const knownDifferent = productFamily !== undefined && productFamily !== judgeFamily && (args.codingModelFamily === undefined || (codingFamily !== undefined && codingFamily !== judgeFamily));
  const base: SideBySideJudgePin = { model: pin.model, version: pin.version, family: judgeFamily, scoringPromptSha256: pin.scoringPromptSha256, pinnedAt: pin.pinnedAt };
  if (knownDifferent) return { ok: true, identity: { ...base, independence: "different_family" } };

  const check = args.humanCheck;
  const checked = check !== undefined && typeof check.labelSetId === "string" && NAME.test(check.labelSetId) && typeof check.checkedAt === "string" && UTC.test(check.checkedAt) && check.checkedAt < args.taskStartedAt
    && Number.isFinite(check.agreement) && check.agreement >= SIDE_BY_SIDE_SPOT_CHECK_MIN_AGREEMENT && check.agreement <= 1
    && Number.isSafeInteger(check.sampleSize) && check.sampleSize >= SIDE_BY_SIDE_SPOT_CHECK_MIN_SAMPLES;
  if (!checked) return { ok: false, reason: "judge_same_family_unchecked" };
  return { ok: true, identity: { ...base, independence: "spot_checked_against_human_labels", humanCheck: { labelSetId: check.labelSetId, agreement: check.agreement, sampleSize: check.sampleSize, checkedAt: check.checkedAt } } };
}

/** The sentence the evidence prints about the judge: its pinned identity and why it is independent. Every part is a fixed word, a checked name or a number. */
export function judgeIdentityWords(identity: SideBySideJudgeIdentity): string {
  const who = `Judge: ${identity.model} ${identity.version} (${identity.family} family), pinned before the task`;
  if (identity.independence === "different_family" || identity.humanCheck === undefined) return `${who}, from a different model family than the product and coding models.`;
  return `${who}; same model family as the product or coding model, so spot-checked against human labels (${String(Math.round(identity.humanCheck.agreement * 100))}% agreement on ${String(identity.humanCheck.sampleSize)} cases).`;
}
