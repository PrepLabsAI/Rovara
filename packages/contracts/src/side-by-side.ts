// TE-F10 (M2, 0.5.20): old vs new prompt outputs on the same inputs, side by side, judged by an independent judge. This file holds the types, the choice of cases (seeded, deterministic), the pairing rules, the table of when the layer is
// on, and the eval-set case source. The runner is `side-by-side-run.ts`, the judge's input and answer rules are `side-by-side-judge.ts`, the two renderings are `side-by-side-render.ts`.
//
// A side-by-side result is NEVER proof that a change works: it shows what two prompts said and what an independent reader made of them. It carries no trust class and no proof basis, and its check kind (`side_by_side`) does not count toward the
// proof (check-kinds.ts). Pure and browser-safe apart from the hash: no clock, no randomness, no file, no network. No callers yet.
import { createHash } from "node:crypto";
import { modelOfBody } from "./model-egress/cost.js";
import { ModelEgressFrameSchema, type ModelEgressFrame } from "./model-egress/frame.js";
import type { ModelEgressFamily } from "./model-egress/schemes.js";
import { promptChangesNeedSideBySide, type PromptChangeReport } from "./prompt-change.js";
import type { SideBySideJudgeIdentity } from "./side-by-side-judge-pin.js";

export const SIDE_BY_SIDE_SCHEMA_VERSION = 1;
/** The id of the check kind in the registry (`check-kinds.ts`). */
export const SIDE_BY_SIDE_CHECK_KIND = "prompt_side_by_side";
/** The most cases ever compared (a ceiling; the count asked for is data). */
export const SIDE_BY_SIDE_MAX_CASES = 5;
/** The default per-task limit on calls through the product key (two per case, five cases): defence in depth next to the meter's cap. */
export const SIDE_BY_SIDE_DEFAULT_CALL_CAP = 10;
/** The most characters of one answer that are kept (and shown to the judge). */
export const SIDE_BY_SIDE_OUTPUT_MAX_CHARS = 8_000;
/** The most examples a full rendering shows. */
export const SIDE_BY_SIDE_EXAMPLES_MAX = 3;
const CASE_ID_MAX = 200;

/** What the judge concluded, from the NEW prompt's point of view. */
export const SIDE_BY_SIDE_VERDICTS = ["same", "better", "worse", "unclear"] as const;
export type SideBySideVerdict = (typeof SIDE_BY_SIDE_VERDICTS)[number];

/** One input, asked of both prompts: a frame for the old prompt and one for the new, both for the `model-egress` port. */
export interface SideBySideCase {
  readonly caseId: string;
  readonly family: ModelEgressFamily;
  readonly old: ModelEgressFrame;
  readonly new: ModelEgressFrame;
}

/**
 * Where the cases come from. Bound to ONE company: a source of company A is never used for company B (the runner refuses it).
 * `eval_set` is built below. `probe_request_store` is the seam for TE-F11's store of probe requests (a reply-set entry with its captured base and head requests): when F11 lands, an adapter over its store implements this and nothing else changes.
 */
export interface SideBySideCaseSource {
  readonly company: string;
  readonly kind: "eval_set" | "probe_request_store";
  cases(): readonly SideBySideCase[] | Promise<readonly SideBySideCase[]>;
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Up to `max` cases (never more than five), chosen by a seeded hash of the case id: the same cases for the same seed whatever order they arrive in. A repeated case id counts once. */
export function selectSideBySideCases(cases: readonly SideBySideCase[], options: { readonly seed: string; readonly max?: number | undefined }): SideBySideCase[] {
  const max = options.max;
  const limit = typeof max === "number" && Number.isFinite(max) ? Math.min(SIDE_BY_SIDE_MAX_CASES, Math.max(0, Math.floor(max))) : SIDE_BY_SIDE_MAX_CASES;
  const seen = new Set<string>();
  const ranked: Array<{ rank: string; item: SideBySideCase }> = [];
  for (const item of cases) {
    if (seen.has(item.caseId)) continue;
    seen.add(item.caseId);
    ranked.push({ rank: sha256(`${options.seed}\u0000select\u0000${item.caseId}`), item });
  }
  ranked.sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.item.caseId < b.item.caseId ? -1 : a.item.caseId > b.item.caseId ? 1 : 0));
  return ranked.slice(0, limit).map((entry) => entry.item);
}

export type SideBySideOrder = "old_first" | "new_first";
/** Which answer the judge sees as A: decided by the seed and the case id alone, so it is repeatable and the mapping back is by code. */
export function sideBySideOrder(seed: string, caseId: string): SideBySideOrder {
  return parseInt(sha256(`${seed}\u0000order\u0000${caseId}`).slice(0, 2), 16) % 2 === 0 ? "old_first" : "new_first";
}

/** The model a frame names: in the path for Gemini and Vertex, in the body for the rest (an Azure deployment is named by the path and is the same on both sides). */
export function modelOfFrame(frame: ModelEgressFrame, family: ModelEgressFamily): string | undefined {
  if (family === "gemini" || family === "vertex") return /\/models\/([^/:?]+)/u.exec(frame.path)?.[1];
  return modelOfBody(frame.body);
}

export type SideBySidePairingRefusal = "bad_frame" | "different_row" | "different_model";
export interface SideBySidePairing {
  readonly paired: SideBySideCase[];
  readonly refused: ReadonlyArray<{ readonly caseId: string; readonly reason: SideBySidePairingRefusal }>;
}
/**
 * Keeps the cases whose two frames the port would accept and which differ in nothing but the prompt as far as the row and the model go. A case whose sides use different rows or different models is refused, unless the change IS a
 * model change (then the model is the thing under test). Never echoes a frame.
 */
export function pairSideBySideCases(cases: readonly SideBySideCase[], options: { readonly modelChange: boolean }): SideBySidePairing {
  const paired: SideBySideCase[] = [];
  const refused: Array<{ caseId: string; reason: SideBySidePairingRefusal }> = [];
  for (const item of cases) {
    const caseId = typeof item?.caseId === "string" ? item.caseId : "";
    const idOk = caseId.length > 0 && caseId.length <= CASE_ID_MAX;
    const oldFrame = ModelEgressFrameSchema.safeParse(item?.old);
    const newFrame = ModelEgressFrameSchema.safeParse(item?.new);
    if (!idOk || !oldFrame.success || !newFrame.success) refused.push({ caseId: idOk ? caseId : "", reason: "bad_frame" });
    else if (oldFrame.data.row !== newFrame.data.row) refused.push({ caseId, reason: "different_row" });
    else if (!options.modelChange && modelOfFrame(oldFrame.data, item.family) !== modelOfFrame(newFrame.data, item.family)) refused.push({ caseId, reason: "different_model" });
    else paired.push({ caseId, family: item.family, old: oldFrame.data, new: newFrame.data });
  }
  return { paired, refused };
}

export const SIDE_BY_SIDE_PRESETS = ["lightweight", "balanced", "careful"] as const;
export type SideBySidePreset = (typeof SIDE_BY_SIDE_PRESETS)[number];
/** The typed input for the project's policy (TE-D1's preset resolver is not built: this is what it will hand in). */
export interface SideBySidePolicy {
  readonly preset: SideBySidePreset;
  readonly aiPilot: boolean;
  readonly optIn: boolean;
}
export type SideBySideOnDecision =
  | { readonly on: true; readonly reason: "careful" | "ai_pilot" | "opt_in" }
  | { readonly on: false; readonly reason: "no_prompt_change" | "not_enabled" };

/** On for Careful projects and the AI pilot, opt-in elsewhere, and only when F4 found a prompt-affecting change (an incomplete report counts as one). Anything that is not exactly the right value is off. */
export function sideBySideIsOn(report: PromptChangeReport, policy: SideBySidePolicy): SideBySideOnDecision {
  if (!promptChangesNeedSideBySide(report).needed) return { on: false, reason: "no_prompt_change" };
  if (policy.preset === "careful") return { on: true, reason: "careful" };
  if (policy.aiPilot === true) return { on: true, reason: "ai_pilot" };
  if (policy.optIn === true) return { on: true, reason: "opt_in" };
  return { on: false, reason: "not_enabled" };
}

/** What happened to one selected case. A case a pairing rule refused is never selected; it is counted. */
export type SideBySideCaseOutcome =
  | { readonly caseId: string; readonly status: "judged"; readonly verdict: SideBySideVerdict; readonly oldText: string; readonly newText: string; readonly possiblySteering?: true }
  | { readonly caseId: string; readonly status: "judge_not_run"; readonly reason: string; readonly oldText: string; readonly newText: string; readonly possiblySteering?: true }
  | { readonly caseId: string; readonly status: "not_run"; readonly side: "old" | "new"; readonly sentence: string }
  | { readonly caseId: string; readonly status: "call_failed"; readonly side: "old" | "new"; readonly sentence: string };

export interface SideBySideCounts {
  readonly planned: number;
  readonly judged: number;
  readonly same: number;
  readonly better: number;
  readonly worse: number;
  readonly unclear: number;
  readonly notRun: number;
  readonly callFailed: number;
  readonly judgeNotRun: number;
  readonly refused: number;
  /** Cases where an answer holds words that could steer the judge (a verdict word, "judge", "verdict" or a case label). The judge still judged them; a person should read them. */
  readonly possiblySteering: number;
}
export interface SideBySideMeter {
  readonly calls: number;
  readonly costMicros: number;
}
/**
 * The result. It has NO trust class and NO proof basis, and says in `evidence` that it does not count toward the proof. The two meters are separate: `product` is the product key's spend (the old and new calls), `rovara` is the
 * judge's (Rovara's own model access). The judge's words are never kept: only the verdict.
 */
export interface SideBySideSummary {
  readonly schemaVersion: typeof SIDE_BY_SIDE_SCHEMA_VERSION;
  readonly evidence: { readonly kind: typeof SIDE_BY_SIDE_CHECK_KIND; readonly countsTowardProof: false };
  /** The judge, pinned: its model, version, scoring prompt hash, family and why it is independent (DECISIONS 170). */
  readonly judge: SideBySideJudgeIdentity;
  readonly counts: SideBySideCounts;
  readonly cases: readonly SideBySideCaseOutcome[];
  readonly meters: { readonly product: SideBySideMeter; readonly rovara: SideBySideMeter };
  readonly stoppedBy?: "overrun" | "cap" | "call_limit";
}

// ---- the eval-set source ----

/** One input from the project's eval set (TE-F3 builds the set; this takes only what is needed to ask both prompts). */
export interface EvalSetCase {
  readonly caseId: string;
  readonly input: string;
}
/** A prompt as a call carries it. The prompt text reaches the frames only; nothing downstream of the frames keeps it. */
export interface PromptVariant {
  readonly system: string;
  readonly model: string;
}
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const JSON_HEADERS: ReadonlyArray<readonly [string, string]> = [["content-type", "application/json"]];

/** The frame a client of this family sends for one prompt and one input. Throws on a model name that is not a plain name, so no text reaches a path. */
function generateFrame(family: "gemini" | "openai_compatible" | "anthropic_messages", row: string, variant: PromptVariant, input: string): ModelEgressFrame {
  if (!MODEL_NAME.test(variant.model)) throw new Error("a side-by-side prompt names a model that is not a plain model name");
  const headers = JSON_HEADERS.map(([name, value]) => [name, value] as [string, string]);
  switch (family) {
    case "gemini":
      return { row, method: "POST", path: `/v1beta/models/${variant.model}:generateContent`, query: "", headers, body: encode({ systemInstruction: { parts: [{ text: variant.system }] }, contents: [{ role: "user", parts: [{ text: input }] }] }) };
    case "anthropic_messages":
      return { row, method: "POST", path: "/v1/messages", query: "", headers, body: encode({ model: variant.model, max_tokens: 1024, system: variant.system, messages: [{ role: "user", content: input }] }) };
    case "openai_compatible":
      return { row, method: "POST", path: "/v1/chat/completions", query: "", headers, body: encode({ model: variant.model, messages: [{ role: "system", content: variant.system }, { role: "user", content: input }] }) };
  }
}

/**
 * The cases from the eval set: each input asked of the old prompt and of the new. Both sides use the same row and family; the prompt (and, for a model change, the model) are the only differences. The old and new prompt texts come from the
 * caller (F4's report holds fingerprints, never text).
 */
export function evalSetCaseSource(args: {
  readonly company: string;
  readonly cases: readonly EvalSetCase[];
  readonly old: PromptVariant;
  readonly new: PromptVariant;
  readonly row: string;
  readonly family: "gemini" | "openai_compatible" | "anthropic_messages";
}): SideBySideCaseSource {
  return {
    company: args.company,
    kind: "eval_set",
    cases: () => args.cases.map((item) => ({ caseId: item.caseId, family: args.family, old: generateFrame(args.family, args.row, args.old, item.input), new: generateFrame(args.family, args.row, args.new, item.input) })),
  };
}
