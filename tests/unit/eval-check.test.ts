import { describe, expect, it } from "vitest";
import { evalCheckResult, evalNotRunResult, type EvalQuestionComparison } from "../../packages/contracts/src/eval-check.js";
const answer = (pass: boolean, text = "answer") => ({ pass, answer: text });
const row = (id: string): EvalQuestionComparison => ({ id, category: "ordinary", old: [answer(true), answer(true), answer(true)], first: answer(true) });
describe("eval evidence", () => {
  it("golden PR text for every label uses counts only and normal PR disposition", () => {
    const stable = evalCheckResult({ roundKind: "check_unsealed", questions: [row("private customer text")], changedPromptCalls: 1 });
    expect(stable.summary).toBe("Eval: No drop found — 1 questions · 0 broke · 0 newly pass · 0 flaky · 1 unchanged · on questions the agent could read; on the evaluated areas. Small or noisy sets can miss changes. This check can flag repeated breaks across questions and confirmed safety or refusal breaks. A single ordinary broken question may not change the label.");
    const down = Array.from({ length: 3 }, (_, i) => ({ ...row(String(i)), first: answer(false), freshOld: [answer(true), answer(true), answer(true)], freshNew: [answer(false), answer(false), answer(false)] }));
    const worse = evalCheckResult({ roundKind: "check_unsealed", questions: down, changedPromptCalls: 1 });
    expect(worse.summary).toBe("Eval: Worse on eval — 3 questions · 3 broke · 0 newly pass · 0 flaky · 0 unchanged · on questions the agent could read; on the evaluated areas. Small or noisy sets can miss changes.");
    const up = down.map(q => ({ ...q, old: q.freshNew, first: answer(true), freshOld: q.freshNew, freshNew: q.freshOld }));
    expect(evalCheckResult({ roundKind: "check_unsealed", questions: up, changedPromptCalls: 1 }).summary).toBe("Eval: Improved on eval — 3 questions · 0 broke · 3 newly pass · 0 flaky · 0 unchanged · on questions the agent could read; on the evaluated areas. Small or noisy sets can miss changes.");
    expect(evalNotRunResult({ roundKind: "check_unsealed", reason: "provider_error" }).summary).toBe("Eval: Not run — provider error. Retry.");
    expect(stable.summary).not.toContain("private customer text");
    expect(worse.disposition).toEqual({ draft: false, check: "failure", retry: false });
  });
  it("neutralizes untrusted question identities and all old/new answers with the shared inert formatter", () => {
    const hostile = "[a[b]](https://evil.test) ![image][r]\n[r]: https://evil.test\n@team #123 <img>\n# title\n> quote\n---\n```js\n~~~\u200b\ufe0f";
    const q = { ...row(hostile), old: Array.from({ length: 3 }, () => answer(true, hostile)), first: answer(false, hostile) };
    const result = evalCheckResult({ roundKind: "check_unsealed", questions: [q], changedPromptCalls: 1, subsetSupported: false });
    const text = JSON.stringify(result.questions);
    for (const active of ["https://evil.test", "@team", "#123", "<img>", "\u200b", "\ufe0f"]) expect(text).not.toContain(active);
    expect(result.questions[0]!.id).not.toMatch(/^[#>~`-]/u);
    expect(result.questions[0]!.id).not.toContain("\n");
    expect(result.questions[0]!.oldAnswers).toHaveLength(3);
    expect(result.questions[0]!.newAnswers).toHaveLength(1);
  });
  it("bounds a megabyte answer quickly and accepts the stated 1000-question maximum", () => {
    const text = "x".repeat(1_048_576);
    const start = performance.now();
    const result = evalCheckResult({ roundKind: "check_unsealed", questions: [{ ...row("__proto__"), first: answer(false, text) }], changedPromptCalls: 1, subsetSupported: false });
    expect(result.questions[0]!.newAnswers[0]!.length).toBeLessThan(1100);
    expect(performance.now() - start).toBeLessThan(1000);
    const questions = Array.from({ length: 1000 }, (_, i) => row(String(i)));
    expect(evalCheckResult({ roundKind: "check_unsealed", questions, changedPromptCalls: 1 }).label).toBe("No drop found");
    expect(evalCheckResult({ roundKind: "check_unsealed", questions: [...questions, row("extra")], changedPromptCalls: 1 }).label).toBe("Not run");
  });
  it("rejects malformed binary samples and duplicate identities instead of dropping them", () => {
    for (const qs of [[row("a"), row("a")], [{ ...row("a"), old: [answer(true)] }], [{ ...row("a"), first: { pass: NaN, answer: "bad" } }]]) {
      expect(evalCheckResult({ roundKind: "check_unsealed", questions: qs as never, changedPromptCalls: 1 }).label).toBe("Not run");
    }
  });
});
