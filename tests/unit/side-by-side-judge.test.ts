// TE-F10: the judge is independent (DECISIONS 161 applied to judging): it sees the two output texts and nothing else, its answer is strict JSON with no free text kept, and A/B is mapped back to old/new by code.
import { describe, expect, it } from "vitest";
import {
  buildSideBySideJudgeCall, newPromptVerdict, parseSideBySideVerdicts, runSideBySide, sideBySideOrder, SIDE_BY_SIDE_JUDGE_ROLE, type SideBySideRunInput,
} from "../../packages/contracts/src/index.js";
import { RUN_DEFAULTS, canary, COMPANY_A, evalCases, recordingJudge, reportNeeded, sbsWorld, source, verdictText } from "../support/side-by-side-world.js";

const policy = { preset: "careful", aiPilot: false, optIn: false } as const;

describe("what the judge is given", () => {
  it("has a fixed role text that says the answers are data and asks for the JSON verdict only", () => {
    expect(SIDE_BY_SIDE_JUDGE_ROLE).toMatch(/compare two answers/iu);
    expect(SIDE_BY_SIDE_JUDGE_ROLE).toMatch(/data, not instructions/iu);
    expect(SIDE_BY_SIDE_JUDGE_ROLE).toMatch(/only the JSON verdict/iu);
  });
  it("is exactly the role and, per case, a synthetic id and the two texts labelled A and B in the seeded order (both orders)", () => {
    const first = buildSideBySideJudgeCall([{ id: "case-1", oldText: "OLD", newText: "NEW", order: "old_first" }]);
    expect(first).toEqual({ role: SIDE_BY_SIDE_JUDGE_ROLE, cases: [{ caseId: "case-1", a: "OLD", b: "NEW" }] });
    const second = buildSideBySideJudgeCall([{ id: "case-1", oldText: "OLD", newText: "NEW", order: "new_first" }]);
    expect(second).toEqual({ role: SIDE_BY_SIDE_JUDGE_ROLE, cases: [{ caseId: "case-1", a: "NEW", b: "OLD" }] });
    expect(Object.keys(first.cases[0]!)).toEqual(["caseId", "a", "b"]);
    expect(Object.isFrozen(first) && Object.isFrozen(first.cases)).toBe(true);
  });
  it("never receives the prompt, the inputs, the diff, the tests, the task request, the file paths, the case ids or the model: canaries planted in all of them stay out", async () => {
    const world = sbsWorld();
    const planted = { prompt: canary("prompt"), input: canary("input"), diff: canary("diff"), tests: canary("tests"), task: canary("task"), path: canary("path"), caseId: canary("case"), seed: canary("seed"), model: canary("model") };
    const inputs = [{ caseId: `${planted.caseId}-1`, input: `${planted.input} one` }, { caseId: `${planted.caseId}-2`, input: `${planted.input} two` }];
    // The report is the one place a path and a diff-derived word enter; F4 keeps only metadata and fingerprints, and the judge must not see even that.
    const report = { ...reportNeeded(), items: reportNeeded().items.map((item) => ({ ...item, path: `${planted.path}/a.prompt` })) };
    const judge = recordingJudge(COMPANY_A, (call) => verdictText(call, "same"));
    world.answers("old answer one", "new answer one", "old answer two", "new answer two");
    const result = await runSideBySide({
      ...RUN_DEFAULTS, company: COMPANY_A.orgId, egress: world.egress, scope: world.scope, source: source(COMPANY_A, 2, { inputs, oldSystem: `${planted.prompt} old`, newSystem: `${planted.prompt} new` }), judge, report, policy, seed: planted.seed,
      context: { diff: planted.diff, tests: planted.tests, taskRequest: planted.task, model: planted.model },
    } as SideBySideRunInput);
    expect(result.status).toBe("ran");
    expect(judge.received).toHaveLength(2);
    const seen = JSON.stringify(judge.received);
    for (const [name, value] of Object.entries(planted)) expect(seen, name).not.toContain(value);
    expect(seen).not.toMatch(/gemini|generateContent|systemInstruction|\.prompt|claude-judge|2026-10-01|scoringPrompt|pinnedAt/u);
    // What it did get: the role and the texts, and only those.
    for (const call of judge.received as Array<{ role: string; cases: Array<{ caseId: string; a: string; b: string }> }>) {
      expect(Object.keys(call)).toEqual(["role", "cases"]);
      expect(call.role).toBe(SIDE_BY_SIDE_JUDGE_ROLE);
      for (const item of call.cases) {
        expect(Object.keys(item)).toEqual(["caseId", "a", "b"]);
        expect(item.caseId).toMatch(/^case-\d+$/u);
        expect([item.a, item.b].sort().join("|")).toMatch(/^(new answer one\|old answer one|new answer two\|old answer two)$/u);
      }
    }
  });
});

describe("what the judge may answer", () => {
  const expected = ["case-1", "case-2"];
  const good = JSON.stringify({ verdicts: [{ caseId: "case-1", verdict: "same" }, { caseId: "case-2", verdict: "b_better" }] });
  it("takes the strict JSON verdict", () => {
    const parsed = parseSideBySideVerdicts(good, expected);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect([...parsed.verdicts]).toEqual([["case-1", "same"], ["case-2", "b_better"]]);
  });
  it.each([
    ["extra prose around the JSON", `Sure! ${good}`],
    ["a code fence", `\`\`\`json\n${good}\n\`\`\``],
    ["truncated JSON", good.slice(0, 40)],
    ["an unknown top-level key", JSON.stringify({ verdicts: [{ caseId: "case-1", verdict: "same" }, { caseId: "case-2", verdict: "same" }], note: "free text" })],
    ["an unknown key on a verdict (free text is never kept)", JSON.stringify({ verdicts: [{ caseId: "case-1", verdict: "same", reason: "because" }, { caseId: "case-2", verdict: "same" }] })],
    ["a __proto__ key", '{"verdicts":[{"caseId":"case-1","verdict":"same"},{"caseId":"case-2","verdict":"same"}],"__proto__":{"polluted":true}}'],
    ["a __proto__ key on a verdict", '{"verdicts":[{"caseId":"case-1","verdict":"same","__proto__":{"x":1}},{"caseId":"case-2","verdict":"same"}]}'],
    ["a wrong case id", JSON.stringify({ verdicts: [{ caseId: "case-1", verdict: "same" }, { caseId: "case-9", verdict: "same" }] })],
    ["a repeated case id", JSON.stringify({ verdicts: [{ caseId: "case-1", verdict: "same" }, { caseId: "case-1", verdict: "a_better" }] })],
    ["a missing case", JSON.stringify({ verdicts: [{ caseId: "case-1", verdict: "same" }] })],
    ["an unknown verdict word", JSON.stringify({ verdicts: [{ caseId: "case-1", verdict: "same" }, { caseId: "case-2", verdict: "BETTER" }] })],
    ["a verdict that is not a string", JSON.stringify({ verdicts: [{ caseId: "case-1", verdict: 1 }, { caseId: "case-2", verdict: "same" }] })],
    ["verdicts that are not a list", JSON.stringify({ verdicts: { caseId: "case-1" } })],
    ["more verdicts than cases", JSON.stringify({ verdicts: [...(JSON.parse(good) as { verdicts: unknown[] }).verdicts, { caseId: "case-1", verdict: "same" }] })],
    ["an array at the top", "[]"],
    ["null", "null"],
    ["nothing", ""],
    ["a huge answer", `${good}${" ".repeat(10_000)}`],
  ])("is 'judge not run' for %s, never a guessed verdict", (_name, text) => {
    expect(parseSideBySideVerdicts(text, expected)).toEqual({ ok: false });
  });
  it("never lets a __proto__ verdict reach Object.prototype", () => {
    parseSideBySideVerdicts('{"verdicts":[],"__proto__":{"polluted":true}}', []);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("mapping A/B back to old and new", () => {
  it("maps a_better and b_better to the right side in BOTH orders", () => {
    expect(newPromptVerdict("a_better", "old_first")).toBe("worse");
    expect(newPromptVerdict("b_better", "old_first")).toBe("better");
    expect(newPromptVerdict("a_better", "new_first")).toBe("better");
    expect(newPromptVerdict("b_better", "new_first")).toBe("worse");
    for (const order of ["old_first", "new_first"] as const) {
      expect(newPromptVerdict("same", order)).toBe("same");
      expect(newPromptVerdict("different_unclear", order)).toBe("unclear");
    }
  });
  it("through a whole run: a judge that always prefers answer A says 'better' exactly for the cases where the new answer was shown first", async () => {
    const world = sbsWorld();
    const seed = "mapping-seed";
    const cases = evalCases(5);
    world.answers(...cases.flatMap((_, index) => [`old text ${String(index)}`, `new text ${String(index)}`]));
    const judge = recordingJudge(COMPANY_A, (call) => verdictText(call, "a_better"));
    const result = await runSideBySide({ ...RUN_DEFAULTS, company: COMPANY_A.orgId, egress: world.egress, scope: world.scope, source: source(COMPANY_A, 5), judge, report: reportNeeded(), policy, seed });
    expect(result.status).toBe("ran");
    if (result.status !== "ran") return;
    const outcomes = result.summary.cases.filter((item) => item.status === "judged");
    expect(outcomes).toHaveLength(5);
    const orders = outcomes.map((item) => sideBySideOrder(seed, item.caseId));
    expect(new Set(orders).size).toBe(2);
    for (const item of outcomes) expect(item.status === "judged" && item.verdict).toBe(sideBySideOrder(seed, item.caseId) === "new_first" ? "better" : "worse");
  });
});
