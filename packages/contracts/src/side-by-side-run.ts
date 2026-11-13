// TE-F10: the run. For each chosen case, ONE attempt per side through the `model-egress` port (the product key's calls, F1-a), then ONE judge call per case through the judge seam (Rovara's own model access: a separate meter, never
// mixed with the product key's). Each case is judged alone, so an answer that tries to talk to the judge can reach no other case's verdict. A call that did not run says why in F1-a's own sentence ("not run", never "failed");
// after a call that settled over the cap no further call is made (DECISIONS 165/165a: over by at most one call); a per-task call limit is the defence in depth. No real call is made here: the port is whatever the caller hands in.
// Pure apart from the calls it is given: no clock, no randomness, no file, no socket of its own. No callers yet.
import { randomBytes } from "node:crypto";
import type { ModelEgress, ModelEgressScope, ModelEgressSettle } from "./ports/model-egress.js";
import { capSentence, NOT_RUN_CLASSES, NOT_RUN_SENTENCES, type ModelEgressNotRunClass } from "./model-egress/classify.js";
import { MODEL_EGRESS_OVERRUN_SENTENCE } from "./model-egress/cost.js";
import type { ModelEgressFamily } from "./model-egress/schemes.js";
import type { PromptChangeReport } from "./prompt-change.js";
import { checkSideBySideJudgePin, type SideBySideHumanCheck, type SideBySideJudgePinRefusal } from "./side-by-side-judge-pin.js";
import { buildSideBySideJudgeCall, newPromptVerdict, parseSideBySideVerdicts, type SideBySideJudge } from "./side-by-side-judge.js";
import {
  pairSideBySideCases, selectSideBySideCases, sideBySideIsOn, sideBySideOrder, SIDE_BY_SIDE_CHECK_KIND, SIDE_BY_SIDE_DEFAULT_CALL_CAP, SIDE_BY_SIDE_OUTPUT_MAX_CHARS, SIDE_BY_SIDE_SCHEMA_VERSION,
  type SideBySideCase, type SideBySideCaseOutcome, type SideBySideCaseSource, type SideBySideCounts, type SideBySideMeter, type SideBySideOnDecision, type SideBySidePolicy, type SideBySideSummary,
} from "./side-by-side.js";

/** The most bytes of one answer the runner reads; more is "cannot be read". */
const ANSWER_READ_MAX_BYTES = 4 * 1_048_576;

const rec = (value: unknown): Record<string, unknown> | undefined => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);
const own = (object: Record<string, unknown> | undefined, key: string): unknown => (object !== undefined && Object.hasOwn(object, key) ? object[key] : undefined);
const texts = (parts: unknown, accept: (part: Record<string, unknown>) => boolean): string => (Array.isArray(parts) ? (parts as unknown[]).flatMap((part) => { const held = rec(part); const text = held !== undefined && accept(held) ? own(held, "text") : undefined; return typeof text === "string" ? [text] : []; }).join("") : "");

/** The answer text of a non-streamed reply in a family's own shape; undefined when there is none or it cannot be read. A hostile reply costs a bounded read. */
export function modelOutputText(family: ModelEgressFamily, bytes: Uint8Array): string | undefined {
  if (bytes.byteLength === 0 || bytes.byteLength > ANSWER_READ_MAX_BYTES) return undefined;
  let top: Record<string, unknown> | undefined;
  try {
    top = rec(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return undefined;
  }
  let text: string;
  switch (family) {
    case "gemini":
    case "vertex": {
      const candidates = own(top, "candidates");
      const content = Array.isArray(candidates) ? rec(own(rec((candidates as unknown[])[0]), "content")) : undefined;
      text = texts(own(content, "parts"), (part) => own(part, "thought") !== true);
      break;
    }
    case "anthropic_messages":
      text = texts(own(top, "content"), (part) => own(part, "type") === "text");
      break;
    case "openai_compatible": {
      const choices = own(top, "choices");
      const message = Array.isArray(choices) ? rec(own(rec((choices as unknown[])[0]), "message")) : undefined;
      const content = own(message, "content");
      text = typeof content === "string" ? content : texts(content, (part) => own(part, "type") === "text");
      break;
    }
    case "cohere": {
      const direct = own(top, "text");
      text = typeof direct === "string" ? direct : texts(own(rec(own(top, "message")), "content"), () => true);
      break;
    }
    default:
      return undefined;
  }
  return text.trim().length === 0 ? undefined : text;
}

/** An answer cut to the most that is kept; a cut never splits a surrogate pair. */
function keep(text: string): string {
  if (text.length <= SIDE_BY_SIDE_OUTPUT_MAX_CHARS) return text;
  const cut = text.slice(0, SIDE_BY_SIDE_OUTPUT_MAX_CHARS - 1);
  const last = cut.charCodeAt(cut.length - 1);
  return `${last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut}…`;
}

export interface SideBySideRunInput {
  /** The company this run is for. The case source and the judge must be bound to the same one. */
  readonly company: string;
  /** The port the product key's calls go through (the fake adapter in tests, the laptop or Cloud adapter later). */
  readonly egress: ModelEgress;
  readonly scope: ModelEgressScope;
  readonly source: SideBySideCaseSource;
  readonly judge: SideBySideJudge;
  /** F4's report: it says whether the layer is needed and whether the change is a model change. It is not given to the judge. */
  readonly report: PromptChangeReport;
  readonly policy: SideBySidePolicy;
  /** Seeds the choice of cases (deterministic: the same cases for the same seed). */
  readonly seed: string;
  /**
   * Seeds the A/B order the judge sees. By default a fresh random seed for this run, which nothing outside the run can read. If a caller passes one (a replay, a test), it is a REQUIREMENT on the caller that it comes from a source the
   * agent that wrote the change cannot read, and that it is not the selection seed: an agent that can predict which answer is shown first can write answers for the judge's position instead of for the reader.
   */
  readonly orderSeed?: string | undefined;
  /** When the task started, UTC `YYYY-MM-DDTHH:MM:SSZ`: the judge's pin (and any spot check) must predate it (DECISIONS 170). */
  readonly taskStartedAt: string;
  /** The model family of the product model under test, and of the coding model if one wrote the change: the judge must be from a different family, or be spot-checked against human labels. */
  readonly productModelFamily: string;
  /** REQUIRED: the family of the model that wrote the change. An unknown family needs the human spot check. */
  readonly codingModelFamily: string;
  readonly humanCheck?: SideBySideHumanCheck | undefined;
  /** Cases to compare (data; at most five). */
  readonly maxCases?: number;
  /** Per-task limit on calls through the product key. Default 10. */
  readonly maxProductCalls?: number;
  /** Per-task limit on judge calls (the Rovara source's own limit). Default 10. */
  readonly maxJudgeCalls?: number;
  readonly signal?: AbortSignal;
}

export type SideBySideRunResult =
  | { readonly status: "off"; readonly reason: Extract<SideBySideOnDecision, { on: false }>["reason"] }
  | { readonly status: "refused"; readonly reason: "company_mismatch" | "source_unreadable" | SideBySideJudgePinRefusal }
  | { readonly status: "ran"; readonly summary: SideBySideSummary };

const wholeNumber = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const limitOf = (value: number | undefined, fallback: number): number => (typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback);
const NOT_RUN_BY_CLASS: ReadonlySet<string> = new Set<string>(NOT_RUN_CLASSES);
const sentenceOfClass = (cls: ModelEgressNotRunClass): string => (cls === "cap" ? capSentence() : NOT_RUN_SENTENCES[cls]);
const JUDGE_NOT_RUN = "judge not run";
/** Words that could steer the judge. Linear: no nesting, and the answers it reads are cut to 8,000 characters. */
const STEERING = /a_better|b_better|different_unclear|verdict|judge|case-\d/iu;

type Stop = "overrun" | "cap" | "call_limit";
type Side = "old" | "new";
type SideResult = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly outcome: "not_run" | "call_failed"; readonly sentence: string };

export async function runSideBySide(input: SideBySideRunInput): Promise<SideBySideRunResult> {
  const on = sideBySideIsOn(input.report, input.policy);
  if (!on.on) return { status: "off", reason: on.reason };
  if (typeof input.company !== "string" || input.company === "" || input.source.company !== input.company || input.judge.company !== input.company) return { status: "refused", reason: "company_mismatch" };

  // The product key's scope must be for this company when it says which one (an opaque scope that names no company cannot be checked here: the adapter's own capability binds it, DEFERRED for the F1-e wiring). One that cannot be read is refused.
  try {
    const scopeCompany = (input.scope as unknown as { company?: unknown } | undefined)?.company;
    if (input.scope === undefined || (scopeCompany !== undefined && scopeCompany !== input.company)) return { status: "refused", reason: "company_mismatch" };
  } catch {
    return { status: "refused", reason: "company_mismatch" };
  }
  // The judge is pinned and independent, or nothing runs: no call is made for a judge that breaks DECISIONS 170's rules.
  const checked = checkSideBySideJudgePin({ pin: input.judge.pin, taskStartedAt: input.taskStartedAt, productModelFamily: input.productModelFamily, codingModelFamily: input.codingModelFamily, humanCheck: input.humanCheck });
  if (!checked.ok) return { status: "refused", reason: checked.reason };

  let offered: readonly SideBySideCase[];
  try {
    offered = await input.source.cases();
  } catch {
    return { status: "refused", reason: "source_unreadable" };
  }
  const pairing = pairSideBySideCases(offered, { modelChange: input.report.counts.model_name > 0 });
  const chosen = selectSideBySideCases(pairing.paired, { seed: input.seed, max: input.maxCases });

  const orderSeed = input.orderSeed ?? randomBytes(16).toString("hex");
  const callLimit = limitOf(input.maxProductCalls, SIDE_BY_SIDE_DEFAULT_CALL_CAP);
  const judgeLimit = limitOf(input.maxJudgeCalls, SIDE_BY_SIDE_DEFAULT_CALL_CAP);
  const product = { calls: 0, costMicros: 0 };
  const rovara = { calls: 0, costMicros: 0 };
  // An object, not a variable: the closure below sets it, and a plain `let` would be narrowed to `undefined` after each check.
  const state: { stop: Stop | undefined } = { stop: undefined };

  /** One attempt through the port: the answer text, or the plain reason there is none. Never throws, never keeps a provider's or an adapter's words. */
  async function callSide(item: SideBySideCase, side: Side): Promise<SideResult> {
    product.calls += 1;
    let settle: ModelEgressSettle | undefined;
    const chunks: Uint8Array[] = [];
    let size = 0;
    let tooLong = false;
    try {
      for await (const event of input.egress.forward(input.scope, side === "old" ? item.old : item.new, input.signal === undefined ? undefined : { signal: input.signal })) {
        if (event.kind === "chunk") {
          size += event.bytes.byteLength;
          if (size > ANSWER_READ_MAX_BYTES) tooLong = true;
          else chunks.push(event.bytes);
        } else if (event.kind === "settle") settle = event;
      }
    } catch {
      return { ok: false, outcome: "call_failed", sentence: `the ${side} prompt's call failed` };
    }
    if (settle === undefined) return { ok: false, outcome: "call_failed", sentence: `the ${side} prompt's call did not finish` };
    if (wholeNumber(settle.costMicros)) product.costMicros += settle.costMicros;
    if (settle.overrun === true) state.stop = "overrun";
    if (NOT_RUN_BY_CLASS.has(settle.class)) {
      if (settle.class === "cap" && state.stop === undefined) state.stop = "cap";
      return { ok: false, outcome: "not_run", sentence: sentenceOfClass(settle.class as ModelEgressNotRunClass) };
    }
    if (settle.class !== "ok") return { ok: false, outcome: "call_failed", sentence: `the ${side} prompt's call failed (${settle.class === "refused" ? "refused by the model gateway" : "provider error"})` };
    const whole = new Uint8Array(size > ANSWER_READ_MAX_BYTES ? 0 : size);
    let at = 0;
    for (const chunk of chunks) {
      whole.set(chunk, at);
      at += chunk.byteLength;
    }
    const text = tooLong ? undefined : modelOutputText(item.family, whole);
    return text === undefined ? { ok: false, outcome: "call_failed", sentence: `the ${side} prompt's answer could not be read` } : { ok: true, text: keep(text) };
  }

  const stopSentence = (why: Stop): string => (why === "overrun" ? MODEL_EGRESS_OVERRUN_SENTENCE : why === "cap" ? capSentence() : `not run: side-by-side call limit reached (${String(callLimit)} calls)`);
  const outcomes: SideBySideCaseOutcome[] = [];
  let judgeIndex = 0;

  for (const item of chosen) {
    if (state.stop === undefined && product.calls + 2 > callLimit) state.stop = "call_limit";
    if (state.stop !== undefined) {
      outcomes.push({ caseId: item.caseId, status: "not_run", side: "old", sentence: stopSentence(state.stop) });
      continue;
    }
    const before = await callSide(item, "old");
    if (!before.ok) {
      outcomes.push({ caseId: item.caseId, status: before.outcome, side: "old", sentence: before.sentence });
      continue;
    }
    // A call that settled over the cap was the one call the cap may be passed by: the new side is not called.
    if (state.stop !== undefined) {
      outcomes.push({ caseId: item.caseId, status: "not_run", side: "new", sentence: stopSentence(state.stop) });
      continue;
    }
    const after = await callSide(item, "new");
    if (!after.ok) {
      outcomes.push({ caseId: item.caseId, status: after.outcome, side: "new", sentence: after.sentence });
      continue;
    }

    judgeIndex += 1;
    // An answer that talks to the judge (a verdict word, "judge", a case label) is flagged for a person to read; the judge still judges it.
    const base = { caseId: item.caseId, oldText: before.text, newText: after.text, ...(STEERING.test(before.text) || STEERING.test(after.text) ? { possiblySteering: true as const } : {}) };
    if (rovara.calls >= judgeLimit) {
      outcomes.push({ ...base, status: "judge_not_run", reason: `${JUDGE_NOT_RUN}: judge call limit reached` });
      continue;
    }
    const id = `case-${String(judgeIndex)}`;
    const order = sideBySideOrder(orderSeed, item.caseId);
    rovara.calls += 1;
    let answer: Awaited<ReturnType<SideBySideJudge["judge"]>> | undefined;
    try {
      answer = await input.judge.judge(buildSideBySideJudgeCall([{ id, oldText: before.text, newText: after.text, order }]));
    } catch {
      answer = undefined;
    }
    if (answer === undefined || typeof answer.text !== "string" || !wholeNumber(answer.costMicros)) {
      outcomes.push({ ...base, status: "judge_not_run", reason: JUDGE_NOT_RUN });
      continue;
    }
    rovara.costMicros += answer.costMicros;
    const parsed = parseSideBySideVerdicts(answer.text, [id]);
    const raw = parsed.ok ? parsed.verdicts.get(id) : undefined;
    outcomes.push(raw === undefined ? { ...base, status: "judge_not_run", reason: JUDGE_NOT_RUN } : { ...base, status: "judged", verdict: newPromptVerdict(raw, order) });
  }

  const count = (verdict: string): number => outcomes.filter((item) => item.status === "judged" && item.verdict === verdict).length;
  const counts: SideBySideCounts = {
    planned: outcomes.length,
    judged: outcomes.filter((item) => item.status === "judged").length,
    same: count("same"),
    better: count("better"),
    worse: count("worse"),
    unclear: count("unclear"),
    notRun: outcomes.filter((item) => item.status === "not_run").length,
    callFailed: outcomes.filter((item) => item.status === "call_failed").length,
    judgeNotRun: outcomes.filter((item) => item.status === "judge_not_run").length,
    refused: pairing.refused.length,
    possiblySteering: outcomes.filter((item) => (item.status === "judged" || item.status === "judge_not_run") && item.possiblySteering === true).length,
  };
  const meter = (held: { calls: number; costMicros: number }): SideBySideMeter => ({ calls: held.calls, costMicros: held.costMicros });
  // Everything the result holds is frozen: a caller that holds it (or a renderer) cannot change a verdict or the judge's identity after the run.
  const summary: SideBySideSummary = Object.freeze({
    schemaVersion: SIDE_BY_SIDE_SCHEMA_VERSION,
    evidence: Object.freeze({ kind: SIDE_BY_SIDE_CHECK_KIND, countsTowardProof: false as const }),
    judge: checked.identity,
    counts: Object.freeze(counts),
    cases: Object.freeze(outcomes.map((item) => Object.freeze(item))),
    meters: Object.freeze({ product: Object.freeze(meter(product)), rovara: Object.freeze(meter(rovara)) }),
    ...(state.stop === undefined ? {} : { stoppedBy: state.stop }),
  });
  return { status: "ran", summary };
}
