import { describe, expect, it, vi } from "vitest";
import { evalCheckResult, EVAL_NOT_RUN_REASONS, type EvalQuestionComparison } from "../../packages/contracts/src/eval-check.js";
import { captureEvalRoundEvidence, EvalRoundArtifactSchema, EvalRoundArtifactReadSchema, evalResultFromArtifact } from "../../packages/contracts/src/eval-round-artifact.js";

import * as inert from "../../packages/contracts/src/evidence-inert.js";

const answer = (pass: boolean, text = "answer") => ({ pass, answer: text });
const questions = (old: boolean, head: boolean, n = 4): EvalQuestionComparison[] => Array.from({ length: n }, (_, i) => ({ id: `q${i}`, category: "ordinary", edited: false, old: Array.from({ length: 3 }, () => answer(old)), first: answer(head), freshOld: Array.from({ length: 3 }, () => answer(old)), freshNew: Array.from({ length: 3 }, () => answer(head)) }));
const context = { aiChange: true, discovery: "configured" as const, previousPasses: 0 as const };
const artifact = (qs = questions(true, false)) => ({ schemaVersion: 1, candidateDigest: "a".repeat(64), roundKind: "check_unsealed", evalPass: 1, outcome: "done", ...captureEvalRoundEvidence({ context, comparison: { questions: qs, changedPromptCalls: qs.length, subsetSupported: true, sameJudgeFamily: false, hiddenSetUsed: false } }), usage: { calls: 28, costMicros: 280 }, cache: "hit", evalConfigured: true });

describe("eval-round artifact", () => {
  it.each([[true, false, "Worse on eval"], [true, true, "No drop found"], [false, true, "Improved on eval"]] as const)("re-derives %s/%s as %s, ignoring a forged label", (old, head, label) => {
    const qs = questions(old, head);
    const a = artifact(qs);
    expect(EvalRoundArtifactSchema.safeParse(a).success).toBe(true);
    const result = evalResultFromArtifact({ ...a, label: "Improved on eval", summary: "customer-secret" });
    expect(result.label).toBe(label);
    expect(result).toEqual(evalCheckResult({ roundKind: "check_unsealed", questions: qs, changedPromptCalls: 4, subsetSupported: true, sameJudgeFamily: false }));
    expect(JSON.stringify(result)).not.toContain("customer-secret");
  });
  it.each(EVAL_NOT_RUN_REASONS)("round-trips fixed refusal %s without invented comparisons", reason => {
    const a = { schemaVersion: 1, candidateDigest: "a".repeat(64), roundKind: "working", evalPass: 1, outcome: "not_run", notRunReason: reason, context: { aiChange: true, discovery: "unknown", previousPasses: 0 }, excluded: [], notices: [], usage: { calls: 0, costMicros: 0 }, cache: "not_used" };
    expect(EvalRoundArtifactSchema.safeParse(a).success).toBe(true);
    expect(evalResultFromArtifact(a)).toMatchObject({ label: "Not run", notRun: { reason }, disposition: { draft: false, check: "neutral", retry: reason !== "no_eval_configured" } });
  });
  it("preserves DEC 200 and discovery context with no comparison", () => {
    const a = { ...artifact(), outcome: "not_run", notRunReason: "no_eval_configured", questions: undefined, options: undefined, evalConfigured: false, context: { ...context, discovery: "not_configured" }, notices: [{ code: "no_eval_configured" }] };
    const result = evalResultFromArtifact(a);
    expect(result.summary).toBe("Prompt changed. No eval found, so AI quality wasn't measured. Compare the old and new answers below.");
    expect(result.disposition).toEqual({ check: "neutral", draft: false, retry: false });
  });
  it("reads future fields tolerantly but writes strictly", () => {
    const a = { ...artifact(), future: true };
    expect(EvalRoundArtifactSchema.safeParse(a).success).toBe(false);
    expect(EvalRoundArtifactReadSchema.safeParse(a).success).toBe(true);
  });
  it.each([null, {}, { schemaVersion: 2 }, { ...artifact(), evalPass: 3 }, { ...artifact(), roundKind: "secret-kind" }, { ...artifact(), usage: { calls: NaN } }, { ...artifact(), outcome: "not_run" }, { ...artifact(), questions: [] }, { ...artifact(), questions: [{ id: "q", category: "secret-category" }] }])("refuses malformed or inconsistent evidence with fixed words", value => {
    const out = evalResultFromArtifact(value);
    expect(out).toMatchObject({ label: "Not run", notRun: { reason: "invalid_question_data" } });
    expect(JSON.stringify(out)).not.toMatch(/secret-kind|secret-category/);
  });
  it("records fix-round context without requesting a third fix", () => {
    const a = artifact();
    expect(evalResultFromArtifact(a).fixRequested).toBe(true);
    expect(evalResultFromArtifact({ ...a, evalPass: 2, context: { ...context, previousPasses: 1 } }).fixRequested).toBe(false);
    expect(evalResultFromArtifact({ ...a, evalPass: 2 })).toMatchObject({ notRun: { reason: "invalid_question_data" } });
  });
  it.each([{ roundKind: "working" }, { evalConfigured: false, context: { ...context, discovery: "not_configured" } }])("refuses a completed result whose setup contradicts its evidence %j", patch => {
    expect(evalResultFromArtifact({ ...artifact(), ...patch })).toMatchObject({ notRun: { reason: "invalid_question_data" } });
  });
  it.each([null, {}, { context, excluded: Array.from({ length: 2001 }, () => ({ id: "secret", reason: "edited" })) }, { context, comparison: { questions: [{ id: "secret", old: null }] } }])("refuses invalid capture input without partial evidence or an exception", input => {
    expect(captureEvalRoundEvidence(input as never)).toEqual({});
  });
  it("keeps 1,000 question comparisons below one MiB and bounds text work across the call", () => {
    const large = "x".repeat(1_000_000);
    const qs = questions(true, false, 1000).map((q, i) => ({ ...q, id: `q${i}${"界".repeat(150)}`, old: q.old.map(a => ({ ...a, answer: large })), first: answer(false, large) }));
    const start = performance.now(); const a = artifact(qs);
    expect(EvalRoundArtifactSchema.safeParse(a).success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(a))).toBeLessThanOrEqual(1_048_576);
    expect(a.questions?.filter(q => q.answers !== undefined).length).toBeLessThanOrEqual(20);
    expect(performance.now() - start).toBeLessThan(3000);
  });
  it("bounds each raw answer and total text passed to the sanitizer", () => {
    const huge = "x".repeat(1_000_000);
    const qs = questions(true, false, 20).map(q => ({ ...q, old: q.old.map(a => ({ ...a, answer: huge })), first: answer(false, huge), freshOld: q.freshOld!.map(a => ({ ...a, answer: huge })), freshNew: q.freshNew!.map(a => ({ ...a, answer: huge })) }));
    // Isolate input work from the sanitizer's independent output cap.
    const sanitize = vi.spyOn(inert, "inertEvidenceText").mockReturnValue("");
    try {
      artifact(qs);
      const lengths = sanitize.mock.calls.map(([text]) => text.length).filter(n => n > 320);
      expect(lengths.length).toBeGreaterThan(1);
      expect(Math.max(...lengths)).toBeLessThanOrEqual(4096);
      expect(lengths.reduce((total, n) => total + n, 0)).toBeLessThanOrEqual(262_144);
    } finally { sanitize.mockRestore(); }
  });
  it("omits answers on unchanged questions and makes changed answers inert and redacted", () => {
    const token = ["sk", "proj", "x".repeat(48)].join("-");
    const hostile = `# > --- \x60\x60\x60 ~~~ ![a[b]](https://evil.example) [ref][id] @owner #123 <b>html</b> \u200b\ufe0f Authorization: Bearer ${token}`;
    const qs = questions(true, true); qs[0] = { ...qs[0]!, first: answer(false, hostile) };
    const a = artifact(qs); const serialized = JSON.stringify(a);
    expect(a.questions?.[1]).not.toHaveProperty("answers");
    expect(a.questions?.[0]?.answers).toBeDefined();
    expect(serialized).not.toContain(token);
    expect(serialized).not.toMatch(/https:\/\/evil|@owner|#123|<b>|\[ref\]/);
  });
  it("private evidence exposes pass/fail only, with no ids, answers, counts or spend", () => {
    const e = captureEvalRoundEvidence({ context, privatePass: false, comparison: { questions: questions(true, false).map(q => ({ ...q, id: `private-question-${q.id}`, first: answer(false, "private-answer-sentinel") })), changedPromptCalls: 4 } });
    expect(e).toEqual({ privatePass: false });
    const a = { schemaVersion: 1, candidateDigest: "a".repeat(64), roundKind: "check_sealed", evalPass: 1, outcome: "done", ...e };
    expect(EvalRoundArtifactSchema.safeParse(a).success).toBe(true);
    expect(JSON.stringify(a)).not.toMatch(/private-question|private-answer-sentinel/);
    expect(evalResultFromArtifact(a)).toMatchObject({ label: "Worse on eval", usedHiddenSet: true, casesRun: 0, casesTotal: 0, questions: [], excluded: [] });
    const stored = artifact();
    expect(EvalRoundArtifactSchema.safeParse(stored).success).toBe(true);
    for (const field of ["questions", "excluded", "notices", "context", "options", "usage", "cache", "evalConfigured"] as const) {
      const leaked = { ...a, [field]: stored[field] };
      expect(EvalRoundArtifactSchema.safeParse(leaked).success, field).toBe(false);
      expect(EvalRoundArtifactReadSchema.safeParse(leaked).success, field).toBe(false);
      expect(evalResultFromArtifact(leaked)).toMatchObject({ label: "Not run", notRun: { reason: "invalid_question_data" }, questions: [], excluded: [] });
    }
  });
  it("copies only bounded exclusion facts into evidence", () => {
    const e = captureEvalRoundEvidence({ context, excluded: [{ id: "q", reason: "edited", extra: "private-extra-cause" }] as never });
    expect(e.excluded).toEqual([{ id: "q", reason: "edited" }]); expect(JSON.stringify(e)).not.toContain("private-extra-cause");
  });
});

it("refuses oversized comparisons before walking their contents", () => {
  const a = artifact();
  const start = performance.now();
  expect(evalResultFromArtifact({ ...a, questions: Array.from({ length: 100_000 }, () => a.questions![0]) })).toMatchObject({ notRun: { reason: "invalid_question_data" } });
  expect(performance.now() - start).toBeLessThan(1000);
});
