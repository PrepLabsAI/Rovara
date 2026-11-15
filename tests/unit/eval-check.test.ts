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

it.each([
  ["baseline_measuring", "baseline still being measured", "Eval: Not run — baseline still being measured. Not a pass or a fail."],
  ["baseline_not_confirmed", "the eval health check is waiting for a maintainer or admin to confirm it", "Eval: Not run — the eval health check is waiting for a maintainer or admin to confirm it."],
] as const)("keeps %s neutral with exact fixed words", (reason, words, summary) => {
  const result = evalNotRunResult({ roundKind: "check_unsealed", reason });
  expect(result.notRun).toEqual({ reason, sentence: `not run: ${words}` }); expect(result.summary).toBe(summary);
  expect(result.disposition).toEqual({ draft: false, check: "neutral", retry: true });
});

import * as evalContracts from "../../packages/contracts/src/eval-check.js";
import { renderEvidence } from "../../packages/contracts/src/evidence-render.js";
import { v2Pack } from "../support/evidence-v2-fixtures.js";
it("maps every refusal to fixed not-tested words and renders the measuring golden", () => {
  for (const reason of evalContracts.EVAL_NOT_RUN_REASONS) {
    const result = evalNotRunResult({ roundKind: "check_unsealed", reason });
    const entry = evalContracts.evalNotTestedEntry(result);
    expect(entry).toEqual({ kind: "check", id: "eval", what: "Eval comparison", reason: evalContracts.EVAL_NOT_RUN_SENTENCES[reason].replace(/^not run: /iu, "") });
  }
  const entry = evalContracts.evalNotTestedEntry(evalNotRunResult({ roundKind: "check_unsealed", reason: "baseline_measuring" }))!;
  expect(renderEvidence(v2Pack({ notTested: [entry] })).body.join("\n")).toContain("Eval comparison (baseline still being measured)");
  expect(evalContracts.evalNotTestedEntry(evalCheckResult({ roundKind: "check_unsealed", questions: [row("q")], changedPromptCalls: 1 }))).toBeUndefined();
});
it("never echoes malformed reasons or stored sentences, even with a megabyte of hostile text", () => {
  const hostile = "@secret [x](https://private.invalid)".repeat(40_000); const start = performance.now();
  for (const reason of ["__proto__", "constructor", "unknown", 5, undefined, null, hostile]) {
    const result = evalNotRunResult({ roundKind: "check_unsealed", reason: reason as never });
    expect(result.notRun).toEqual({ reason: "invalid_question_data", sentence: "not run: question results are incomplete or invalid" });
    expect(JSON.stringify(result)).not.toContain("@secret");
    expect(evalContracts.evalNotTestedEntry({ ...result, notRun: { reason: reason as never, sentence: hostile } })).toEqual({ kind: "check", id: "eval", what: "Eval comparison", reason: "question results are incomplete or invalid" });
  }
  for (const value of [null, undefined, {}, { kind: "eval", outcome: "other" }]) expect(evalContracts.evalNotTestedEntry(value as never)).toBeUndefined();
  expect(performance.now() - start).toBeLessThan(1000);
});
