// The eval as a proof row (plan v3.2 row 20.2): cases passed, the bar, the baseline, the judge and the slices, all
// re-derived from the bound artifact. A stored label or summary never decides any of it.
import { describe, expect, it } from "vitest";
import type { EvalQuestionComparison } from "../../packages/contracts/src/eval-check.js";
import { captureEvalRoundEvidence } from "../../packages/contracts/src/eval-round-artifact.js";
import { EVAL_PROOF_BAR, evalProofBasis } from "../../packages/contracts/src/eval-proof-basis.js";

const hash = (c: string) => c.repeat(64);
const answer = (pass: boolean, text = "answer") => ({ pass, answer: text });
const samples = (pass: boolean, n: number) => Array.from({ length: n }, () => answer(pass));
type Category = "ordinary" | "safety" | "refusal";
const question = (id: string, category: Category, old: boolean, head: boolean, extra: Partial<EvalQuestionComparison> = {}): EvalQuestionComparison => ({
  id, category, edited: false, old: samples(old, 3), first: answer(head),
  ...(old === head ? {} : { freshOld: samples(old, 3), freshNew: samples(head, 3), moreNew: samples(head, 2) }), ...extra,
});
const context = { aiChange: true, discovery: "configured" as const, previousPasses: 0 as const };
const basis = { evalSetHash: hash("e"), judgePin: hash("b"), model: "model-a", modelVersion: "v1", oldRuns: 3 as const };
const artifact = (qs: EvalQuestionComparison[], extra: Record<string, unknown> = {}) => ({
  schemaVersion: 1, candidateDigest: hash("a"), roundKind: "check_unsealed", evalPass: 1, outcome: "done",
  ...captureEvalRoundEvidence({ context, comparison: { questions: qs, changedPromptCalls: qs.length, subsetSupported: true, sameJudgeFamily: false } }),
  usage: { calls: 12, costMicros: 120 }, cache: "hit", evalConfigured: true, basis, ...extra,
});

describe("eval proof basis", () => {
  it("counts cases passed per slice from the pass bits, not from any stored word", () => {
    const qs = [question("a", "ordinary", true, true), question("b", "ordinary", true, false), question("c", "safety", true, true), question("d", "refusal", false, false)];
    const out = evalProofBasis({ ...artifact(qs), label: "Improved on eval", summary: "customer-secret" })!;
    expect(out.outcome).toBe("ran");
    expect(out.label).not.toBe("Improved on eval");
    expect(out.cases).toEqual({ total: 4, compared: 4, excluded: 0 });
    expect(out.slices).toEqual([
      { category: "ordinary", questions: 2, oldPassed: 6, oldOf: 6, newPassed: 1, newOf: 2 },
      { category: "safety", questions: 1, oldPassed: 3, oldOf: 3, newPassed: 1, newOf: 1 },
      { category: "refusal", questions: 1, oldPassed: 0, oldOf: 3, newPassed: 0, newOf: 1 },
    ]);
    expect(out.passed).toEqual({ old: { passed: 9, of: 12 }, new: { passed: 2, of: 4 } });
    expect(JSON.stringify(out)).not.toContain("customer-secret");
  });
  it("leaves edited questions out of every count and names how many", () => {
    const qs = [question("a", "ordinary", true, true), question("b", "ordinary", true, true, { edited: true }), question("c", "safety", true, true)];
    const out = evalProofBasis(artifact(qs, { excluded: [{ id: "b", reason: "edited" }] }))!;
    expect(out.cases).toEqual({ total: 3, compared: 2, excluded: 1 });
    expect(out.passed.old.of).toBe(6);
    expect(out.slices.map(s => [s.category, s.questions])).toEqual([["ordinary", 1], ["safety", 1]]);
  });
  it("records the baseline, the judge and the bar from the artifact and the rule's constants", () => {
    const out = evalProofBasis(artifact([question("a", "ordinary", true, true)], { cache: "filled" }))!;
    expect(out.baseline).toEqual({ oldRuns: 3, cache: "filled", evalSetHash: hash("e"), model: "model-a", modelVersion: "v1" });
    expect(out.judge).toEqual({ pin: hash("b"), sameFamily: false });
    expect(out.bar).toBe(EVAL_PROOF_BAR);
    expect(EVAL_PROOF_BAR).toEqual({ rule: "question-exact-v1", wholeSetP: 0.01, secondLookFromP: 0.01, secondLookBelowP: 0.2, strictCategories: ["safety", "refusal"] });
  });
  it("says the judge shares the product's family when the artifact says so", () => {
    const qs = [question("a", "ordinary", true, true)];
    const a = { ...artifact(qs), options: { ...artifact(qs).options!, sameJudgeFamily: true } };
    expect(evalProofBasis(a)!.judge).toEqual({ pin: hash("b"), sameFamily: true });
  });
  it("gives an older artifact with no basis no invented baseline or judge", () => {
    const older: Record<string, unknown> = { ...artifact([question("a", "ordinary", true, true)]) };
    delete older["basis"];
    const out = evalProofBasis(older)!;
    expect(out.baseline).toEqual({ oldRuns: 3, cache: "hit" });
    expect(out.judge).toBeUndefined();
  });
  it("is Not run when the comparison cannot be judged, and shows no baseline basis for it", () => {
    const qs = [question("a", "ordinary", true, true, { edited: true })];
    const out = evalProofBasis(artifact(qs, { excluded: [{ id: "a", reason: "edited" }] }))!;
    expect(out.outcome).toBe("not_run"); expect(out.label).toBe("Not run"); expect(out.notRunReason).toBeDefined();
    expect(out.cases).toEqual({ total: 0, compared: 0, excluded: 0 }); expect(out.judge).toBeUndefined();
    expect(out.baseline).toEqual({ oldRuns: 3, cache: "hit" });
  });
  it("gives a private-set round nothing to count", () => {
    expect(evalProofBasis({ schemaVersion: 1, candidateDigest: hash("a"), roundKind: "check_sealed", evalPass: 1, outcome: "done", privatePass: true })).toBeUndefined();
  });
});

