// TE-F3 part A: the eval verdict, the noise band and the words. Every rule here is behavioural: a number goes in, a verdict and a sentence come out. Nothing here calls a model.
import { describe, expect, it } from "vitest";
import { EvidenceMeasureSchema } from "../../packages/contracts/src/evidence.js";
import { MeasuresFileSchema } from "../../packages/contracts/src/measures-file.js";
import { NOT_RUN_SENTENCES, capSentence } from "../../packages/contracts/src/model-egress/classify.js";
import { EVAL_MIN_QUESTIONS, EVAL_NOISE_K, EVAL_NOT_RUN_SENTENCES, EVAL_VERDICT_WORDS, evalCheckResult, evalNotRunResult, evalVerdictFor, type EvalVerdictInput } from "../../packages/contracts/src/eval-check.js";
import { EVAL_NOT_RUN_FRACTION_MAX, evalFactsAllRun, evalFactsFromClasses } from "../../packages/contracts/src/eval-pacing.js";
import type { EvalBaseRecord } from "../../packages/contracts/src/eval-base-cache.js";

const input = (over: Partial<EvalVerdictInput> = {}): EvalVerdictInput => ({ direction: "up_good", base: 0.8, head: 0.8, spread: 0.05, ...over });
const file = (measures: Array<Record<string, unknown>>) => MeasuresFileSchema.parse({ schemaVersion: 1, measures });
const baseRecord = (measures: EvalBaseRecord["measures"] = [{ name: "accuracy", unit: "fraction", value: 0.8, direction: "up_good", spread: 0.05 }]): EvalBaseRecord => ({ schemaVersion: 1, measures, caseCount: 50, recordedOn: "2026-11-13", roundKind: "check_sealed", runnerSchemaVersion: 1 });
const accuracy = (over: Record<string, unknown> = {}) => ({ name: "accuracy", unit: "fraction", value: 0.82, direction: "up_good", spread: 0.05, ...over });

describe("the noise band rule", () => {
  it("uses k = 2 as a data constant", () => {
    expect(EVAL_NOISE_K).toBe(2);
  });
  it("is no detectable change inside base +/- k x spread, better or worse only outside it", () => {
    // base 0.8, spread 0.05: the band is 0.7 to 0.9.
    expect(evalVerdictFor(input({ head: 0.82 })).verdict).toBe("no_detectable_change");
    expect(evalVerdictFor(input({ head: 0.71 })).verdict).toBe("no_detectable_change");
    expect(evalVerdictFor(input({ head: 0.95 })).verdict).toBe("better");
    expect(evalVerdictFor(input({ head: 0.6 })).verdict).toBe("worse");
    expect(evalVerdictFor(input({ head: 0.95 })).band).toEqual({ low: 0.7, high: 0.9 });
  });
  it("treats a value exactly on the band's edge as inside it (strictly outside, never on the edge)", () => {
    expect(evalVerdictFor({ direction: "up_good", base: 1, head: 2, spread: 0.5 }).verdict).toBe("no_detectable_change");
    expect(evalVerdictFor({ direction: "up_good", base: 1, head: 0, spread: 0.5 }).verdict).toBe("no_detectable_change");
    expect(evalVerdictFor({ direction: "up_good", base: 1, head: 2.0001, spread: 0.5 }).verdict).toBe("better");
  });
  it("is not fooled by floating-point noise at the edge (0.7 + 2 x 0.1 is 0.8999999999999999)", () => {
    expect(evalVerdictFor({ direction: "up_good", base: 0.7, head: 0.9, spread: 0.1 }).verdict).toBe("no_detectable_change");
    expect(evalVerdictFor({ direction: "down_good", base: 0.3, head: 0.1, spread: 0.1 }).verdict).toBe("no_detectable_change");
  });
  it("reads k as 2 spreads, not 1: a head between base + 1 spread and base + 2 spreads is inside the band", () => {
    expect(evalVerdictFor({ direction: "up_good", base: 10, head: 11.5, spread: 1 }).verdict).toBe("no_detectable_change");
    expect(evalVerdictFor({ direction: "down_good", base: 10, head: 8.5, spread: 1 }).verdict).toBe("no_detectable_change");
  });
  it("reads direction both ways: up_good rising is better, down_good rising is worse", () => {
    expect(evalVerdictFor({ direction: "up_good", base: 10, head: 20, spread: 1 }).verdict).toBe("better");
    expect(evalVerdictFor({ direction: "up_good", base: 10, head: 0, spread: 1 }).verdict).toBe("worse");
    expect(evalVerdictFor({ direction: "down_good", base: 10, head: 20, spread: 1 }).verdict).toBe("worse");
    expect(evalVerdictFor({ direction: "down_good", base: 10, head: 0, spread: 1 }).verdict).toBe("better");
  });
  it("takes the spread from the base round only: the head runner's own spread is not an input (a wide one would hide a real drop)", () => {
    expect(evalVerdictFor({ direction: "up_good", base: 10, head: 13, spread: 0.1 }).verdict).toBe("better");
    expect(evalVerdictFor({ direction: "up_good", base: 10, head: 13, spread: 2 }).verdict).toBe("no_detectable_change");
    expect(evalVerdictFor({ direction: "up_good", base: 10, head: 13, headSpread: 50 } as never).verdict).toBe("no_noise_estimate");
    const result = evalCheckResult({ roundKind: "check_unsealed", head: file([accuracy({ value: 0.5, spread: 50 })]), base: baseRecord([{ name: "accuracy", unit: "fraction", value: 0.8, direction: "up_good", spread: 0.01 }]), facts: evalFactsAllRun(50) });
    expect(result.verdicts[0]!.verdict).toBe("worse");
    expect(result.measures[0]!.spread).toBe(0.01);
    const none = evalCheckResult({ roundKind: "check_unsealed", head: file([accuracy({ value: 0.5, spread: 50 })]), base: baseRecord([{ name: "accuracy", unit: "fraction", value: 0.8, direction: "up_good" }]), facts: evalFactsAllRun(50) });
    expect(none.verdicts[0]!.verdict).toBe("no_noise_estimate");
  });
  it("judges nothing without a noise estimate: no spread, or a zero spread, is never a change", () => {
    expect(evalVerdictFor({ direction: "up_good", base: 0.5, head: 0.99 })).toMatchObject({ verdict: "no_noise_estimate" });
    expect(evalVerdictFor({ direction: "up_good", base: 0.5, head: 0.99, spread: 0 })).toMatchObject({ verdict: "no_noise_estimate" });
    expect(evalVerdictFor({ direction: "down_good", base: 0.5, head: 0.01 }).band).toBeUndefined();
  });
  it("never reads NaN, infinity, a negative spread or an out-of-range number as a change", () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(evalVerdictFor(input({ head: bad })).verdict).toBe("not_run");
      expect(evalVerdictFor(input({ base: bad })).verdict).toBe("not_run");
      expect(evalVerdictFor(input({ spread: bad })).verdict).toBe("not_run");
    }
    expect(evalVerdictFor(input({ spread: -1 })).verdict).toBe("not_run");
    expect(evalVerdictFor(input({ head: 1e12 + 1 })).verdict).toBe("not_run");
    expect(evalVerdictFor(input({ head: 1e12 + 1 })).reason).toBe("unreadable_score");
  });
  it("handles negative zero and huge numbers without a spurious change", () => {
    expect(evalVerdictFor({ direction: "up_good", base: 0, head: -0, spread: 1 }).verdict).toBe("no_detectable_change");
    expect(evalVerdictFor({ direction: "up_good", base: 1e12, head: 1e12, spread: 1e12 })).toMatchObject({ verdict: "no_detectable_change", band: { low: -1e12, high: 1e12 } });
    expect(EvidenceMeasureSchema.safeParse({ name: "x", unit: "u", base: 1e12, head: 1e12, direction: "up_good", band: evalVerdictFor({ direction: "up_good", base: 1e12, head: 1e12, spread: 1e12 }).band }).success).toBe(true);
  });
});

describe("the check result", () => {
  const facts = evalFactsAllRun(50);
  it("builds a v2 measure with base, head, spread and band that the evidence schema accepts", () => {
    const result = evalCheckResult({ roundKind: "check_unsealed", head: file([accuracy()]), base: baseRecord(), facts });
    expect(result.measures).toHaveLength(1);
    expect(EvidenceMeasureSchema.safeParse(result.measures[0]).success).toBe(true);
    expect(result.measures[0]).toMatchObject({ name: "accuracy", unit: "fraction", base: 0.8, head: 0.82, spread: 0.05, direction: "up_good", band: { low: 0.7, high: 0.9 } });
    expect(result.verdicts[0]).toMatchObject({ verdict: "no_detectable_change", sentence: "no detectable change" });
    expect(result.outcome).toBe("ran");
    expect(result.casesRun).toBe(50);
  });
  it("assigns no label: a measure beyond the band is not 'Improved on eval' and nothing here is 'Proven' (DECISIONS 170 labels come from the next lane)", () => {
    const result = evalCheckResult({ roundKind: "check_sealed", head: file([accuracy({ value: 0.99 })]), base: baseRecord(), facts });
    expect(result.verdicts[0]!.verdict).toBe("better");
    expect(Object.keys(result).some((key) => /proof|label|proven|improved/iu.test(key))).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/Proven|Improved on eval|No regression measured/u);
    expect(result.outcome).toBe("ran");
    expect(evalCheckResult({ roundKind: "check_sealed", head: file([accuracy({ value: 0.2 })]), base: baseRecord(), facts }).outcome).toBe("ran");
  });
  it("renders 'Eval (your runner): accuracy 0.82 (main 0.8) - no detectable change', and better/worse only beyond the band", () => {
    const quiet = evalCheckResult({ roundKind: "check_unsealed", head: file([accuracy()]), base: baseRecord(), facts });
    expect(quiet.summary).toBe("Eval (your runner): accuracy 0.82 fraction (main 0.8 fraction) · no detectable change");
    const better = evalCheckResult({ roundKind: "check_unsealed", head: file([accuracy({ value: 0.97 })]), base: baseRecord(), facts });
    expect(better.summary).toContain("· better than main beyond the noise band");
    const worse = evalCheckResult({ roundKind: "check_unsealed", head: file([accuracy({ value: 0.4 })]), base: baseRecord(), facts });
    expect(worse.summary).toContain("· worse than main beyond the noise band");
    expect(EVAL_VERDICT_WORDS.no_detectable_change).toBe("no detectable change");
  });
  it("says 'difference not judged: no noise estimate' when neither side has a spread", () => {
    const result = evalCheckResult({ roundKind: "check_unsealed", head: file([accuracy({ spread: undefined, value: 0.99 })]), base: baseRecord([{ name: "accuracy", unit: "fraction", value: 0.8, direction: "up_good" }]), facts });
    expect(result.verdicts[0]).toMatchObject({ verdict: "no_noise_estimate", sentence: "difference not judged: no noise estimate" });
    expect(result.summary).not.toMatch(/better|worse/u);
    expect(result.measures[0]!.band).toBeUndefined();
  });
  it("says 'not run: no base score' for a measure with no base, and leaves it out of the v2 measures (which need a base)", () => {
    const result = evalCheckResult({ roundKind: "check_unsealed", head: file([accuracy(), { name: "f1", unit: "fraction", value: 0.5, direction: "up_good", spread: 0.1 }]), base: baseRecord(), facts });
    expect(result.measures.map((measure) => measure.name)).toEqual(["accuracy"]);
    expect(result.verdicts[1]).toMatchObject({ verdict: "not_run", reason: "no_base_score" });
    const none = evalCheckResult({ roundKind: "check_unsealed", head: file([accuracy()]), base: undefined, facts });
    expect(none.measures).toEqual([]);
    expect(none.verdicts[0]).toMatchObject({ verdict: "not_run", reason: "no_base_score" });
    expect(none.outcome).toBe("not_run");
  });
  it("matches a base score by name, unit and direction, so a renamed or flipped measure is never compared", () => {
    for (const changed of [{ unit: "percent" }, { direction: "down_good" }]) {
      const result = evalCheckResult({ roundKind: "check_unsealed", head: file([accuracy(changed)]), base: baseRecord(), facts });
      expect(result.verdicts[0]!.reason).toBe("no_base_score");
      expect(result.measures).toEqual([]);
    }
  });
  it("is 'not run' with the provider sentence above the not-run fraction, never failed and never a score", () => {
    expect(EVAL_NOT_RUN_FRACTION_MAX).toBe(0.2);
    const facts30 = evalFactsFromClasses([...Array.from({ length: 7 }, () => "rate_limit"), ...Array.from({ length: 23 }, () => "ok")]);
    const result = evalCheckResult({ roundKind: "check_unsealed", head: file([accuracy({ value: 0.1 })]), base: baseRecord(), facts: facts30 });
    expect(result.outcome).toBe("not_run");
    expect(result.notRun).toEqual({ reason: "too_many_not_run", sentence: NOT_RUN_SENTENCES.rate_limit });
    expect(result.summary).toBe("Eval (your runner): not run: provider rate limit");
    expect(result.measures).toEqual([]);
    expect(result.summary).not.toMatch(/fail/iu);
  });
  it("applies the minimum per measure too: the runner's own count under it, or a base score from too few cases, is not compared", () => {
    const small = evalCheckResult({ roundKind: "check_unsealed", head: file([accuracy({ count: 19 })]), base: baseRecord(), facts: evalFactsAllRun(50) });
    expect(small.verdicts[0]).toMatchObject({ verdict: "not_run", reason: "too_few_questions" });
    expect(small.measures).toEqual([]);
    const smallBase = evalCheckResult({ roundKind: "check_unsealed", head: file([accuracy({ count: 50 })]), base: { ...baseRecord(), caseCount: 19 }, facts: evalFactsAllRun(50) });
    expect(smallBase.verdicts[0]).toMatchObject({ verdict: "not_run", reason: "too_few_questions" });
    const smallBaseEntry = evalCheckResult({ roundKind: "check_unsealed", head: file([accuracy({ count: 50 })]), base: baseRecord([{ name: "accuracy", unit: "fraction", value: 0.8, direction: "up_good", spread: 0.05, count: 19 }]), facts: evalFactsAllRun(50) });
    expect(smallBaseEntry.verdicts[0]).toMatchObject({ verdict: "not_run", reason: "too_few_questions" });
    expect(evalCheckResult({ roundKind: "check_unsealed", head: file([accuracy({ count: 20 })]), base: { ...baseRecord(), caseCount: 20 }, facts: evalFactsAllRun(50) }).verdicts[0]!.verdict).toBe("no_detectable_change");
  });
  it("the count behind a score is the cases that ran, from Rovara's facts, never the runner's own number", () => {
    const result = evalCheckResult({ roundKind: "check_unsealed", head: file([accuracy({ count: 9999 })]), base: baseRecord(), facts: evalFactsAllRun(50) });
    expect(result.verdicts[0]!.count).toBe(50);
  });
  it("uses a neutral outcome word, never 'passed' or 'failed'", () => {
    const result = evalCheckResult({ roundKind: "check_unsealed", head: file([accuracy({ value: 0.2 })]), base: baseRecord(), facts: evalFactsAllRun(50) });
    expect(result.verdicts[0]!.verdict).toBe("worse");
    expect(result.outcome).toBe("ran");
    expect(JSON.stringify(result)).not.toMatch(/"passed"|"failed"/u);
  });
  it("is not run with too few questions, never a pass: fewer than 20 cases ran", () => {
    expect(EVAL_MIN_QUESTIONS).toBe(20);
    const few = evalCheckResult({ roundKind: "check_unsealed", head: file([accuracy({ count: 19 })]), base: baseRecord(), facts: evalFactsAllRun(19) });
    expect(few).toMatchObject({ outcome: "not_run", notRun: { reason: "too_few_questions", sentence: "not run: too few eval questions to detect a change" }, measures: [] });
    expect(evalCheckResult({ roundKind: "check_unsealed", head: file([accuracy()]), base: baseRecord(), facts: evalFactsAllRun(20) }).outcome).toBe("ran");
    expect(evalCheckResult({ roundKind: "check_unsealed", head: file([accuracy()]), base: baseRecord(), facts: evalFactsAllRun(5), minQuestions: 5 }).outcome).toBe("ran");
  });
  it("a provider error (an outage) is not run too, never a pass", () => {
    const outage = evalFactsFromClasses([...Array.from({ length: 30 }, () => "provider_error"), ...Array.from({ length: 20 }, () => "ok")]);
    expect(evalCheckResult({ roundKind: "check_unsealed", head: file([accuracy()]), base: baseRecord(), facts: outage })).toMatchObject({ outcome: "not_run", notRun: { sentence: "not run: provider error" } });
  });
  it("a refusal by the adapter is not run too, whatever its word", () => {
    const refused = evalFactsFromClasses([...Array.from({ length: 30 }, () => "refused"), ...Array.from({ length: 20 }, () => "ok")]);
    expect(evalCheckResult({ roundKind: "check_unsealed", head: file([accuracy()]), base: baseRecord(), facts: refused })).toMatchObject({ outcome: "not_run", notRun: { sentence: "not run: the model call was refused" } });
  });
  it("exactly at the fraction is still a run; one case over is not", () => {
    const atLimit = evalFactsFromClasses([...Array.from({ length: 6 }, () => "rate_limit"), ...Array.from({ length: 24 }, () => "ok")]);
    expect(evalCheckResult({ roundKind: "check_unsealed", head: file([accuracy({ count: 24 })]), base: baseRecord(), facts: atLimit }).notRun).toBeUndefined();
    const over = evalFactsFromClasses([...Array.from({ length: 7 }, () => "quota"), ...Array.from({ length: 23 }, () => "ok")]);
    expect(evalCheckResult({ roundKind: "check_unsealed", head: file([accuracy({ count: 23 })]), base: baseRecord(), facts: over }).notRun?.sentence).toBe(NOT_RUN_SENTENCES.quota);
  });
  it("picks the sentence of the class that stopped most cases, with the cap sentence for a budget stop", () => {
    const mixed = evalFactsFromClasses(["overloaded", "overloaded", "overloaded", "rate_limit", "ok", "ok"]);
    expect(evalCheckResult({ roundKind: "check_unsealed", head: file([accuracy()]), base: baseRecord(), facts: mixed }).notRun?.sentence).toBe(NOT_RUN_SENTENCES.overloaded);
    const capped = evalFactsFromClasses(["cap", "cap", "cap", "ok"]);
    expect(evalCheckResult({ roundKind: "check_unsealed", head: file([accuracy()]), base: baseRecord(), facts: capped, capMicros: 2_000_000 }).notRun?.sentence).toBe(capSentence(2_000_000));
    const keys = evalFactsFromClasses(["key_refused", "key_refused", "ok"]);
    expect(evalCheckResult({ roundKind: "check_unsealed", head: file([accuracy()]), base: baseRecord(), facts: keys }).notRun?.sentence).toBe(NOT_RUN_SENTENCES.key_refused);
  });
  it("a few not-run cases never lower a score: the measure is compared only when the runner's count is the run cases, and says 'n of N run'", () => {
    const some = evalFactsFromClasses([...Array.from({ length: 3 }, () => "rate_limit"), ...Array.from({ length: 47 }, () => "ok")]);
    const counted = evalCheckResult({ roundKind: "check_unsealed", head: file([accuracy({ count: 47 })]), base: baseRecord(), facts: some });
    expect(counted.verdicts[0]!.verdict).toBe("no_detectable_change");
    expect(counted.summary).toContain("(47 of 50 run)");
    const blind = evalCheckResult({ roundKind: "check_unsealed", head: file([accuracy({ value: 0.1 })]), base: baseRecord(), facts: some });
    expect(blind.verdicts[0]).toMatchObject({ verdict: "not_run", reason: "partial_run" });
    expect(blind.verdicts[0]!.verdict).not.toBe("worse");
    expect(blind.measures).toEqual([]);
  });
  it("the hidden-set sentence is exactly the sealed-round one", () => {
    const result = evalNotRunResult({ roundKind: "check_unsealed", reason: "hidden_set_needs_sealed_round" });
    expect(result.notRun?.sentence).toBe("not run: the hidden eval set needs the sealed round");
    expect(result.summary).toBe("Eval (your runner): not run: the hidden eval set needs the sealed round");
    expect(EVAL_NOT_RUN_SENTENCES.hidden_set_needs_sealed_round).toBe("not run: the hidden eval set needs the sealed round");
    expect(result.outcome).toBe("not_run");
  });
});

describe("untrusted text from the runner", () => {
  // Valid under the measures-file schema (one plain line, 80 and 20 characters at most) and still hostile.
  const hostile = "[score](https://evil.example/x) @octocat #123 ENG-42 <b>x</b> ![i](https://e/x)";
  const hostileUnit = "[u](https://x.ex)";
  it("reaches the summary and the verdict sentences only through the inert-text function", () => {
    const result = evalCheckResult({ roundKind: "check_unsealed", head: file([accuracy({ name: hostile, unit: hostileUnit })]), base: baseRecord([{ name: hostile, unit: hostileUnit, value: 0.8, direction: "up_good", spread: 0.05 }]), facts: evalFactsAllRun(50) });
    const printed = [result.summary, ...result.verdicts.map((verdict) => `${verdict.label} ${verdict.sentence}`)].join("\n");
    expect(printed).not.toMatch(/https:\/\/(?!‍)/u);
    expect(printed).not.toMatch(/@octocat/u);
    expect(printed).not.toMatch(/#123/u);
    expect(printed).not.toMatch(/ENG-42/u);
    expect(printed).not.toContain("<");
    expect(printed).not.toMatch(/!\[/u);
    expect(printed).not.toContain("\n#");
    expect(result.summary.includes("\n")).toBe(false);
  });
  it("holds even for names that bypass the file schema: line breaks, a bidi override, a heading", () => {
    const raw = "line one\n# heading \u202e [x](https://evil.example)";
    const head = { schemaVersion: 1, source: "project_runner", measures: [{ name: raw, unit: raw, value: 0.8, direction: "up_good", spread: 0.05 }] } as const;
    const result = evalCheckResult({ roundKind: "check_unsealed", head: head as never, base: baseRecord([{ name: raw, unit: raw, value: 0.8, direction: "up_good", spread: 0.05 }]), facts: evalFactsAllRun(50) });
    expect(result.summary).not.toMatch(/\n|\u202e|https:\/\/(?!\u200d)/u);
    expect(result.measures).toEqual([]);
  });
  it("holds even for names that bypass the file schema: line breaks, a bidi override, a heading", () => {
    const raw = "line one\n# heading \u202e [x](https://evil.example)";
    const head = { schemaVersion: 1, source: "project_runner", measures: [{ name: raw, unit: raw, value: 0.8, direction: "up_good", spread: 0.05 }] };
    const result = evalCheckResult({ roundKind: "check_unsealed", head: head as never, base: baseRecord([{ name: raw, unit: raw, value: 0.8, direction: "up_good", spread: 0.05 }]), facts: evalFactsAllRun(50) });
    expect(result.summary).not.toMatch(/\n|\u202e|https:\/\/(?!\u200d)/u);
    expect(result.measures).toEqual([]);
  });
  it("prints a measure named with a prototype key as plain text, never as an object key", () => {
    const result = evalCheckResult({ roundKind: "check_unsealed", head: file([accuracy({ name: "__proto__" })]), base: baseRecord([{ name: "__proto__", unit: "fraction", value: 0.8, direction: "up_good", spread: 0.05 }]), facts: evalFactsAllRun(50) });
    expect(result.summary).toContain("__proto__");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  it("caps the listed measures and handles 50 measures with one-megabyte names quickly", () => {
    const names = Array.from({ length: 50 }, (_, index) => ({ name: `m${String(index)}`, unit: "u", value: 1, direction: "up_good" as const, spread: 0.1 }));
    const result = evalCheckResult({ roundKind: "check_unsealed", head: file(names), base: baseRecord(names), facts: evalFactsAllRun(50) });
    expect(result.summary).toContain("and 45 more measures");
    const big = "x".repeat(1_048_576);
    const started = Date.now();
    const huge = evalCheckResult({ roundKind: "check_unsealed", head: { schemaVersion: 1, source: "project_runner", measures: [{ name: big, unit: big, value: 1, direction: "up_good", spread: 0.1 }] }, base: baseRecord([{ name: big, unit: big, value: 1, direction: "up_good", spread: 0.1 }]), facts: evalFactsAllRun(50) });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(huge.summary.length).toBeLessThan(2_000);
  });
});
