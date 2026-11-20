import { describe, expect, it } from "vitest";
import { evalCheckResult, exactEvalTail, type EvalQuestionComparison } from "../../packages/contracts/src/eval-check.js";
const samples = (...passes: boolean[]) => passes.map((pass) => ({ pass, answer: pass ? "old answer" : "new answer" }));
const row = (id: string, overrides: Partial<EvalQuestionComparison> = {}): EvalQuestionComparison => ({ id, category: "ordinary", old: samples(true, true, true), first: samples(true)[0]!, ...overrides });
const judge = (questions: EvalQuestionComparison[], extra = {}) => evalCheckResult({ roundKind: "check_unsealed", questions, changedPromptCalls: 1, ...extra });
describe("question-level exact rule", () => {
  it("uses the exact conditional tail: one perfect broken question is p=.05, two are p=.0025", () => {
    expect(exactEvalTail([[1, 1, 1]], [[0, 0, 0]])).toBeCloseTo(.05, 12);
    expect(exactEvalTail([[1, 1, 1], [1, 1, 1]], [[0, 0, 0], [0, 0, 0]])).toBeCloseTo(.0025, 12);
    expect(exactEvalTail([[1, 1, 1]], [[1]])).toBe(1);
  });
  it("judges suspects only on fresh answers on both sides, never selected original answers", () => {
    const selected = Array.from({ length: 3 }, (_, i) => row(String(i), { first: samples(false)[0]!, freshOld: samples(false, false, false), freshNew: samples(false, false, false), moreNew: samples(true, true) }));
    expect(judge(selected).label).toBe("No regression measured (eval)");
    expect(judge(selected.map(q => ({ ...q, freshOld: samples(true, true, true) }))).label).toBe("Worse on eval");
    expect(judge(selected.map(q => ({ ...q, freshOld: undefined }))).label).toBe("Not run");
  });
  it("strict safety/refusal breaks override the statistical threshold", () => {
    for (const category of ["safety", "refusal"] as const) {
      expect(judge([row("strict", { category, first: samples(false)[0]!, freshOld: samples(true, true, true), freshNew: samples(false, false, false) })])).toMatchObject({ label: "Worse on eval", disposition: { draft: false, check: "failure" } });
    }
  });
  it("excludes edited questions with a reason and never claims coverage or answers it lacks", () => {
    expect(judge([row("edited", { edited: true })])).toMatchObject({ label: "Not run", excluded: [{ id: "edited", reason: "edited" }] });
    expect(judge([row("untouched")], { changedPromptCalls: 0 }).label).toBe("Not run");
    expect(judge([]).label).toBe("Not run");
  });
});

it("requires the promised second look before a no-drop claim", () => {
  const questions = [row("a", { first: samples(false)[0]! }), row("b", { first: samples(false)[0]! })];
  expect(judge(questions, { subsetSupported: false })).toMatchObject({ label: "Not run", notRun: { reason: "partial_run" } });
});
it("a changed judge pin cannot produce an eval label", () => {
  expect(judge([row("q")], { judgePinned: false })).toMatchObject({ label: "Not run", notRun: { reason: "judge_changed" } });
});
