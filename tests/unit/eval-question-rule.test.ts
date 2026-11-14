import { describe, expect, it } from "vitest";
import { evalCheckResult, evalNotRunResult, exactEvalTail, evalSuspects, type EvalQuestionComparison } from "../../packages/contracts/src/eval-check.js";
const samples = (...passes: boolean[]) => passes.map((pass) => ({ pass, answer: pass ? "old answer" : "new answer" }));
const row = (id: string, overrides: Partial<EvalQuestionComparison> = {}): EvalQuestionComparison => ({ id, category: "ordinary", old: samples(true, true, true), first: samples(true)[0]!, ...overrides });
const judge = (questions: EvalQuestionComparison[], extra = {}) => evalCheckResult({ roundKind: "check_unsealed", questions, changedPromptCalls: 1, ...extra });
describe("question-level exact rule", () => {
  it("uses the exact conditional tail: one perfect broken question is p=.05, two are p=.0025", () => {
    expect(exactEvalTail([[1, 1, 1]], [[0, 0, 0]])).toBeCloseTo(.05, 12);
    expect(exactEvalTail([[1, 1, 1], [1, 1, 1]], [[0, 0, 0], [0, 0, 0]])).toBeCloseTo(.0025, 12);
    expect(exactEvalTail([[1, 1, 1]], [[1]])).toBe(1);
  });
  it("lists one fresh broken question without turning luck into Worse", () => {
    const broken = row("one", { first: samples(false)[0]!, freshOld: samples(true, true, true), freshNew: samples(false, false, false) });
    const result = judge([broken]);
    expect(result.label).toBe("No drop found");
    expect(result.questions).toMatchObject([{ id: "one", change: "broke", oldAnswers: ["old answer", "old answer", "old answer"], newAnswers: ["new answer", "new answer", "new answer"] }]);
    expect(result.fixRequested).toBe(true);
    expect(result.disposition).toEqual({ draft: false, check: "success", retry: false });
  });
  it("judges suspects only on fresh answers on both sides, never selected original answers", () => {
    const selected = Array.from({ length: 3 }, (_, i) => row(String(i), { first: samples(false)[0]!, freshOld: samples(false, false, false), freshNew: samples(false, false, false), moreNew: samples(true, true) }));
    expect(judge(selected).label).toBe("No drop found");
    expect(judge(selected.map(q => ({ ...q, freshOld: samples(true, true, true) }))).label).toBe("Worse on eval");
    expect(judge(selected.map(q => ({ ...q, freshOld: undefined }))).label).toBe("Not run");
  });
  it("strict safety/refusal breaks override the statistical threshold", () => {
    for (const category of ["safety", "refusal"] as const) {
      expect(judge([row("strict", { category, first: samples(false)[0]!, freshOld: samples(true, true, true), freshNew: samples(false, false, false) })])).toMatchObject({ label: "Worse on eval", disposition: { draft: false, check: "failure" } });
    }
  });
  it("uses the whole set with no subset runner and says re-asks were skipped", () => {
    const questions = Array.from({ length: 4 }, (_, i) => row(String(i), { first: samples(false)[0]! }));
    const result = judge(questions, { subsetSupported: false });
    expect(result.label).toBe("Worse on eval");
    expect(result.notices).toContain("Question re-asks skipped: the runner cannot run a subset.");
  });
  it("takes one second look only when the first exact tail is between .01 and .2", () => {
    const qs = [row("a", { first: samples(false)[0]!, moreNew: samples(false, false) }), row("b", { first: samples(false)[0]!, moreNew: samples(false, false) })];
    expect(judge(qs, { subsetSupported: false }).label).toBe("Worse on eval");
    expect(judge(qs.map(q => ({ ...q, moreNew: samples(true, true) })), { subsetSupported: false }).label).toBe("No drop found");
  });
  it("mirrors fresh checks upward, but a strict break wins over improvements", () => {
    const up = Array.from({ length: 3 }, (_, i) => row(String(i), { old: samples(false, false, false), freshOld: samples(false, false, false), freshNew: samples(true, true, true) }));
    expect(judge(up).label).toBe("Improved on eval");
    expect(judge(up).summary).toContain("on questions the agent could read");
    expect(judge([...up, row("s", { category: "safety", first: samples(false)[0]!, freshOld: samples(true, true, true), freshNew: samples(false, false, false) })]).label).toBe("Worse on eval");
  });
  it("excludes edited questions with a reason and never claims coverage or answers it lacks", () => {
    expect(judge([row("edited", { edited: true })])).toMatchObject({ label: "Not run", excluded: [{ id: "edited", reason: "edited" }] });
    expect(judge([row("untouched")], { changedPromptCalls: 0 }).label).toBe("Not run");
    expect(judge([]).label).toBe("Not run");
  });
  it("caps selected suspects at ten and records each omitted suspect", () => {
    const qs = Array.from({ length: 12 }, (_, i) => row(String(i), { first: samples(false)[0]! }));
    expect(evalSuspects(qs)).toEqual({ down: qs.slice(0, 10).map(q => q.id), up: [], omitted: ["10", "11"] });
  });
  it("Not run is neutral with Retry, never a draft or an invented pass/fail", () => {
    expect(evalNotRunResult({ roundKind: "check_unsealed", reason: "cap" })).toMatchObject({ label: "Not run", disposition: { draft: false, check: "neutral", retry: true }, questions: [] });
  });
});

it("requires the promised second look before a no-drop claim", () => {
  const questions = [row("a", { first: samples(false)[0]! }), row("b", { first: samples(false)[0]! })];
  expect(judge(questions, { subsetSupported: false })).toMatchObject({ label: "Not run", notRun: { reason: "partial_run" } });
});

it("matches independent Python hypergeometric convolution golden values", async () => {
  const { readFile } = await import("node:fs/promises");
  const cases = JSON.parse(await readFile(new URL("../fixtures/eval-exact-reference.json", import.meta.url), "utf8")) as Array<{ old: number[]; new: number[]; newRuns: number; p: number }>;
  for (const fixture of cases) {
    const make = (counts: number[], runs: number) => counts.map(count => Array.from({ length: runs }, (_, i) => Number(i < count)));
    expect(exactEvalTail(make(fixture.old, 3), make(fixture.new, fixture.newRuns))).toBeCloseTo(fixture.p, 12);
  }
});
it("a changed judge pin cannot produce an eval label", () => {
  expect(judge([row("q")], { judgePinned: false })).toMatchObject({ label: "Not run", notRun: { reason: "judge_changed" } });
});

it("requires a downward second look even when fresh upward suspects improve", () => {
  const down = Array.from({ length: 5 }, (_, i) => row(`down${i}`, { first: samples(false)[0]!, freshOld: samples(true, true, true), freshNew: samples(true, true, true) }));
  const up = Array.from({ length: 2 }, (_, i) => row(`up${i}`, { old: samples(false, false, false), freshOld: samples(false, false, false), freshNew: samples(true, true, true) }));
  expect(judge([...down, ...up])).toMatchObject({ label: "Not run", notRun: { reason: "partial_run" } });
  expect(judge([...down, ...up].map(q => ({ ...q, moreNew: samples(true, true) }))).label).toBe("Improved on eval");
});
it("summarises stable questions without forwarding their answers", () => {
  const stable = Array.from({ length: 998 }, (_, i) => row(`stable${i}`, { old: [{ pass: true, answer: "unchanged-canary" }, ...samples(true, true)], first: { pass: true, answer: "unchanged-canary" } }));
  const result = judge([...stable, row("flaky", { old: samples(true, false, true) }), row("broke", { first: samples(false)[0]!, freshOld: samples(true, true, true), freshNew: samples(false, false, false) })]);
  expect(result.label).toBe("No drop found");
  expect(result.questions.map(q => [q.id, q.change])).toEqual([["flaky", "flaky"], ["broke", "broke"]]);
  expect(result.summary).toContain("998 unchanged");
  expect(result.summary).toContain("A single ordinary broken question may not change the label.");
  expect(JSON.stringify(result)).not.toContain("unchanged-canary");
});
