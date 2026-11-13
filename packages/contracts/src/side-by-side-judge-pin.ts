// TE-F10, DECISIONS 170 (owner 2026-11-13): the judge is PINNED and its identity is part of the evidence. Its model, version and scoring prompt are fixed before the task starts; it comes from a different model family than the product
// model AND the coding model (both families must be known), or else it was spot-checked against human labels (and the rendering says which). A run whose judge breaks one of these rules is refused before any call is made. Side-by-side
// stays evidence shown to people: it is never a proof label (no "Proven", no "No regression measured", no "Improved on eval" here).
// Pure: no clock, no randomness, no file, no network. Times are compared as fixed-shape UTC text, so no clock API is needed. No callers yet.
import { createHash } from "node:crypto";
import { inertEvidenceText } from "./evidence-inert.js";
import { buildSideBySideJudgeCall, serializeSideBySideJudgeInput } from "./side-by-side-judge.js";

// ---- vendor families ----

/** The closed list of vendor families. An API format (`anthropic_messages`, `openai_compatible`, `vertex`, `bedrock`) is NOT a vendor family and is never accepted as one. */
export const SIDE_BY_SIDE_VENDOR_FAMILIES = ["anthropic", "google", "openai", "cohere", "meta", "mistral", "amazon", "xai", "deepseek"] as const;
export type SideBySideVendorFamily = (typeof SIDE_BY_SIDE_VENDOR_FAMILIES)[number];
/** The words that name a vendor family; `claude` and `anthropic` are one family. */
const FAMILY_WORDS: Readonly<Record<string, SideBySideVendorFamily>> = Object.freeze({
  anthropic: "anthropic", claude: "anthropic", google: "google", gemini: "google", gemma: "google", openai: "openai", gpt: "openai", cohere: "cohere", command: "cohere", meta: "meta", llama: "meta", mistral: "mistral", mixtral: "mistral",
  amazon: "amazon", nova: "amazon", titan: "amazon", xai: "xai", grok: "xai", deepseek: "deepseek",
});
/** The model-name stems of each family: the stem is at the start of the name or after a `.`, `/` or `:` (a vendor or Bedrock prefix). */
const FAMILY_MODELS: Readonly<Record<SideBySideVendorFamily, RegExp>> = {
  anthropic: /(?:^|[./:])claude/iu, google: /(?:^|[./:])(?:gemini|gemma)/iu, openai: /(?:^|[./:])(?:gpt|chatgpt|o\d)/iu, cohere: /(?:^|[./:])(?:command|c4ai)/iu, meta: /(?:^|[./:])(?:llama|meta-llama)/iu,
  mistral: /(?:^|[./:])(?:mistral|mixtral|codestral|ministral)/iu, amazon: /(?:^|[./:])(?:nova|titan|amazon)/iu, xai: /(?:^|[./:])grok/iu, deepseek: /(?:^|[./:])deepseek/iu,
};

/** The vendor family a word names, or undefined for anything not on the list. */
export function vendorFamilyOf(value: unknown): SideBySideVendorFamily | undefined {
  if (typeof value !== "string" || value.length > 40) return undefined;
  const word = value.trim().toLowerCase();
  return Object.hasOwn(FAMILY_WORDS, word) ? FAMILY_WORDS[word] : undefined;
}
/** Whether a model name belongs to the family it is said to be from. */
export function modelBelongsToFamily(model: unknown, family: SideBySideVendorFamily): boolean {
  return typeof model === "string" && model.length <= 128 && FAMILY_MODELS[family].test(model);
}

// ---- the pin and the spot check ----

/** What is fixed about the judge. */
export interface SideBySideJudgePin {
  /** The judge's model name and exact version, as the provider names them. */
  readonly model: string;
  readonly version: string;
  /** The judge's vendor family (`claude` and `anthropic` are one). The model name must belong to it. */
  readonly family: string;
  /** SHA-256 of the scoring prompt: the code's role text together with the serialisation of the judge's input (`sideBySideScoringPromptSha256`). */
  readonly scoringPromptSha256: string;
  /** When the pin was made, UTC, `YYYY-MM-DDTHH:MM:SS[.mmm]Z`. It must be BEFORE the task started. */
  readonly pinnedAt: string;
}
/** A spot check of THIS judge against labels people wrote: it names the judge it checked, and was made after the pin and before the task. */
export interface SideBySideHumanCheck {
  readonly labelSetId: string;
  readonly model: string;
  readonly version: string;
  readonly scoringPromptSha256: string;
  /** Share of the sampled cases where the judge agreed with the people's label, 0 to 1. */
  readonly agreement: number;
  readonly sampleSize: number;
  readonly checkedAt: string;
}
export const SIDE_BY_SIDE_SPOT_CHECK_MIN_AGREEMENT = 0.8;
export const SIDE_BY_SIDE_SPOT_CHECK_MIN_SAMPLES = 20;

export type SideBySideJudgeIndependence = "different_family" | "spot_checked_against_human_labels";
/** Why a spot check was needed: the judge shares a family with the product or coding model, or one of those families is not known. */
export type SideBySideSpotCheckReason = "same_family" | "family_unknown";
/** The judge as the evidence names it. */
export interface SideBySideJudgeIdentity extends SideBySideJudgePin {
  readonly independence: SideBySideJudgeIndependence;
  /** The vendor families it was compared with (both present for `different_family`). */
  readonly productFamily?: SideBySideVendorFamily;
  readonly codingFamily?: SideBySideVendorFamily;
  readonly spotCheckReason?: SideBySideSpotCheckReason;
  readonly humanCheck?: SideBySideHumanCheck;
}
export type SideBySideJudgePinRefusal = "judge_pin_invalid" | "judge_pinned_after_task" | "judge_same_family_unchecked";

const NAME = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const UTC = /^(\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d)(?:\.(\d{1,3}))?Z$/u;

/** A UTC time as text that compares in time order: exact to the millisecond (`YYYY-MM-DDTHH:MM:SS.mmmZ`), or undefined when it is not UTC text of that shape. */
function utcOf(value: unknown): string | undefined {
  const match = typeof value === "string" && value.length <= 30 ? UTC.exec(value) : null;
  return match === null ? undefined : `${match[1]!}.${(match[2] ?? "").padEnd(3, "0")}Z`;
}

/** The hash a pin must carry: the scoring prompt is the code's role text and the serialisation format of the judge's input, run on a fixed sample. */
export const sideBySideScoringPromptSha256 = (): string => createHash("sha256").update(serializeSideBySideJudgeInput(buildSideBySideJudgeCall([{ id: "case-1", oldText: "A", newText: "B", order: "old_first" }]))).digest("hex");

const pinFamily = (pin: Partial<SideBySideJudgePin> | undefined): SideBySideVendorFamily | undefined => {
  const family = vendorFamilyOf(pin?.family);
  if (pin === undefined || family === undefined || typeof pin.model !== "string" || !NAME.test(pin.model) || !modelBelongsToFamily(pin.model, family) || typeof pin.version !== "string" || !NAME.test(pin.version)) return undefined;
  if (typeof pin.scoringPromptSha256 !== "string" || !SHA256.test(pin.scoringPromptSha256) || pin.scoringPromptSha256 !== sideBySideScoringPromptSha256() || utcOf(pin.pinnedAt) === undefined) return undefined;
  return family;
};

/** A spot check that is of this judge, strong and large enough, and made between the pin and the task (`taskStartedAt` undefined: the task time is not known here, so only the order against the pin is checked). */
function humanCheckOk(check: Partial<SideBySideHumanCheck> | undefined, pin: SideBySideJudgePin, taskStartedAt: string | undefined): check is SideBySideHumanCheck {
  if (check === undefined || typeof check.labelSetId !== "string" || !NAME.test(check.labelSetId)) return false;
  if (check.model !== pin.model || check.version !== pin.version || check.scoringPromptSha256 !== pin.scoringPromptSha256) return false;
  const checked = utcOf(check.checkedAt);
  const pinned = utcOf(pin.pinnedAt);
  if (checked === undefined || pinned === undefined || checked < pinned || (taskStartedAt !== undefined && !(checked < taskStartedAt))) return false;
  return typeof check.agreement === "number" && Number.isFinite(check.agreement) && check.agreement >= SIDE_BY_SIDE_SPOT_CHECK_MIN_AGREEMENT && check.agreement <= 1
    && typeof check.sampleSize === "number" && Number.isSafeInteger(check.sampleSize) && check.sampleSize >= SIDE_BY_SIDE_SPOT_CHECK_MIN_SAMPLES;
}

/**
 * The judge's identity for the evidence, or the reason the judge may not be used. Refused: a pin with a missing or malformed field, a family that is not on the vendor list or does not match the model's name, or a scoring prompt that is not
 * the code's; a pin made at or after the task started (times may carry milliseconds); a judge in the same family as the product model or the coding model, OR with either family unknown (the coding family is required), with no spot check of
 * THIS judge (same model, version and scoring prompt) made between the pin and the task start, strong and large enough.
 */
export function checkSideBySideJudgePin(args: {
  readonly pin: SideBySideJudgePin;
  readonly taskStartedAt: string;
  readonly productModelFamily: string;
  readonly codingModelFamily: string;
  readonly humanCheck?: SideBySideHumanCheck | undefined;
}): { readonly ok: true; readonly identity: SideBySideJudgeIdentity } | { readonly ok: false; readonly reason: SideBySideJudgePinRefusal } {
  const pin = args.pin as Partial<SideBySideJudgePin> | undefined;
  const judgeFamily = pinFamily(pin);
  const pinnedAt = utcOf(pin?.pinnedAt);
  const taskAt = utcOf(args.taskStartedAt);
  if (pin === undefined || judgeFamily === undefined || pinnedAt === undefined || taskAt === undefined) return { ok: false, reason: "judge_pin_invalid" };
  if (!(pinnedAt < taskAt)) return { ok: false, reason: "judge_pinned_after_task" };

  const base: SideBySideJudgePin = { model: pin.model!, version: pin.version!, family: judgeFamily, scoringPromptSha256: pin.scoringPromptSha256!, pinnedAt };
  const product = vendorFamilyOf(args.productModelFamily);
  const coding = vendorFamilyOf(args.codingModelFamily);
  if (product !== undefined && coding !== undefined && product !== judgeFamily && coding !== judgeFamily) return { ok: true, identity: Object.freeze({ ...base, independence: "different_family", productFamily: product, codingFamily: coding }) };

  const check = args.humanCheck;
  if (!humanCheckOk(check, base, taskAt)) return { ok: false, reason: "judge_same_family_unchecked" };
  const known = product !== undefined && coding !== undefined;
  return {
    ok: true,
    identity: Object.freeze({
      ...base, independence: "spot_checked_against_human_labels", spotCheckReason: known ? "same_family" : "family_unknown", ...(product === undefined ? {} : { productFamily: product }), ...(coding === undefined ? {} : { codingFamily: coding }),
      humanCheck: Object.freeze({ labelSetId: check.labelSetId, model: check.model, version: check.version, scoringPromptSha256: check.scoringPromptSha256, agreement: check.agreement, sampleSize: check.sampleSize, checkedAt: utcOf(check.checkedAt)! }),
    }),
  };
}

/** Whether an identity (a summary read back from storage, say) is still one `checkSideBySideJudgePin` could have made. The task start is not known here, so the order of the spot check against the pin is the part of the time rule checked. */
export function verifySideBySideJudgeIdentity(identity: unknown): identity is SideBySideJudgeIdentity {
  if (typeof identity !== "object" || identity === null) return false;
  const held = identity as Partial<SideBySideJudgeIdentity>;
  const family = pinFamily(held);
  if (family === undefined || held.family !== family) return false;
  if (held.independence === "different_family") {
    return held.humanCheck === undefined && held.productFamily !== undefined && held.codingFamily !== undefined && vendorFamilyOf(held.productFamily) === held.productFamily && vendorFamilyOf(held.codingFamily) === held.codingFamily
      && held.productFamily !== family && held.codingFamily !== family;
  }
  if (held.independence !== "spot_checked_against_human_labels" || (held.spotCheckReason !== "same_family" && held.spotCheckReason !== "family_unknown")) return false;
  if (held.spotCheckReason === "same_family" && !(held.productFamily !== undefined && held.codingFamily !== undefined && (held.productFamily === family || held.codingFamily === family))) return false;
  return humanCheckOk(held.humanCheck, held as SideBySideJudgePin, undefined);
}

const UNVERIFIED_WORDS = "Judge identity could not be verified.";
/** The sentence the evidence prints about the judge. The identity is checked again here, so a summary that was changed after the run cannot claim an independence it does not have; the names go through the inert-text function. */
export function judgeIdentityWords(identity: SideBySideJudgeIdentity): string {
  if (!verifySideBySideJudgeIdentity(identity)) return UNVERIFIED_WORDS;
  const who = `Judge: ${inertEvidenceText(identity.model, 128)} ${inertEvidenceText(identity.version, 128)} (${identity.family} family), pinned before the task`;
  if (identity.independence === "different_family") return `${who}, from a different model family than the product and coding models.`;
  const check = identity.humanCheck!;
  const why = identity.spotCheckReason === "same_family" ? "same model family as the product or coding model" : "the product or coding model family is not known";
  return `${who}; ${why}, so spot-checked against human labels (${String(Math.round(check.agreement * 100))}% agreement on ${String(check.sampleSize)} cases).`;
}
