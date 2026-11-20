import { describe, expect, it } from "vitest";
import { evalCheckResult, evalNotRunResult, type EvalQuestionComparison } from "../../packages/contracts/src/eval-check.js";
import { expectLinearScaling } from "../support/scaling.js";
const answer = (pass: boolean, text = "answer") => ({ pass, answer: text });
const row = (id: string): EvalQuestionComparison => ({ id, category: "ordinary", old: [answer(true), answer(true), answer(true)], first: answer(true) });
describe("eval evidence", () => {
  it("bounds a megabyte answer quickly and accepts the stated 1000-question maximum", () => {
    const text = "x".repeat(1_048_576);
    const result = evalCheckResult({ roundKind: "check_unsealed", questions: [{ ...row("__proto__"), first: answer(false, text) }], changedPromptCalls: 1, subsetSupported: false });
    expect(result.questions[0]!.newAnswers[0]!.length).toBeLessThan(1100);
    // The cost must not grow faster than the answer (32,768 -> 262,144 characters: the 8N input stays at or under 256 KiB so it stays in CPU cache; the full 1,048,576 characters are checked once above).
    let scaled = result;
    expectLinearScaling((size) => { const questions = [{ ...row("__proto__"), first: answer(false, "x".repeat(size)) }]; return () => { scaled = evalCheckResult({ roundKind: "check_unsealed", questions, changedPromptCalls: 1, subsetSupported: false }); }; }, { n: 32_768, label: "eval check with a long answer" });
    expect(scaled.questions[0]!.newAnswers[0]!.length).toBeLessThan(1100);
    const questions = Array.from({ length: 1000 }, (_, i) => row(String(i)));
    expect(evalCheckResult({ roundKind: "check_unsealed", questions, changedPromptCalls: 1 }).label).toBe("No regression measured (eval)");
    expect(evalCheckResult({ roundKind: "check_unsealed", questions: [...questions, row("extra")], changedPromptCalls: 1 }).label).toBe("Not run");
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
  const hostile = "@secret [x](https://private.invalid)".repeat(40_000);
  for (const reason of ["__proto__", "constructor", "unknown", 5, undefined, null, hostile]) {
    const result = evalNotRunResult({ roundKind: "check_unsealed", reason: reason as never });
    expect(result.notRun).toEqual({ reason: "invalid_question_data", sentence: "not run: question results are incomplete or invalid" });
    expect(JSON.stringify(result)).not.toContain("@secret");
    expect(evalContracts.evalNotTestedEntry({ ...result, notRun: { reason: reason as never, sentence: hostile } })).toEqual({ kind: "check", id: "eval", what: "Eval comparison", reason: "question results are incomplete or invalid" });
  }
  for (const value of [null, undefined, {}, { kind: "eval", outcome: "other" }]) expect(evalContracts.evalNotTestedEntry(value as never)).toBeUndefined();
  // The cost of refusing the hostile text must not grow faster than it does (800 -> 6,400 repeats of 36 bytes: the 8N input stays at or under 256 KiB so it stays in CPU cache; the full 40,000 repeats are checked once above).
  expectLinearScaling((repeats) => { const text = "@secret [x](https://private.invalid)".repeat(repeats); return () => {
    const result = evalNotRunResult({ roundKind: "check_unsealed", reason: text as never });
    JSON.stringify(result);
    evalContracts.evalNotTestedEntry({ ...result, notRun: { reason: text as never, sentence: text } });
  }; }, { n: 800, unitBytes: 36, label: "refusing hostile eval not-run text" });
});
