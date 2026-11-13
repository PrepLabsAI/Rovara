// TE-F3-b: the DECISIONS 170 gate, rule by rule. Every rule is a behaviour: data goes in, a label, a reason and words come out. The world (tests/support/eval-gate-world.ts) has known noise, so each threshold below can be checked by hand:
// overall SE 0.005774 (band k x SE = +/-0.011547, smallest detectable drop 0.016406); a 10-question category has SE 0.011547 (band +/-0.023094, Holm threshold with 3 ordinary categories 0.025/3).
import { describe, expect, it } from "vitest";
import { evalGate, evalGateAgentFeedback, type EvalGateInput } from "../../packages/contracts/src/eval-gate.js";
import { evalGatePlanHash, evalGoalHash, type EvalGatePlan, type EvalJudgeInput } from "../../packages/contracts/src/eval-gate-inputs.js";
import { changeProofLabelCountsAsProven } from "../../packages/contracts/src/eval-gate-labels.js";
import { evalFactsFromClasses } from "../../packages/contracts/src/eval-pacing.js";
import { BEFORE_TASK, FIRST_CODE, GOAL, PLAN, TASK_STARTED, gateInput, questionSet, withGoal, type SetOptions } from "../support/eval-gate-world.js";

const hex = (character: string) => character.repeat(64);
const planned = (over: Partial<EvalGatePlan>): Pick<EvalGateInput, "plan" | "recordedPlanHash"> => { const plan = { ...PLAN, ...over }; return { plan, recordedPlanHash: evalGatePlanHash(plan) }; };
const judge = (over: Record<string, unknown> = {}, outer: Record<string, unknown> = {}): EvalJudgeInput => ({
  kind: "model", pin: { model: "judge-model", version: "2026-09", family: "claude", scoringPromptSha256: hex("a"), pinnedAt: BEFORE_TASK, ...over }, expectedScoringPromptSha256: hex("a"), productModelFamily: "gemini", codingModelFamily: "openai", ...outer,
} as EvalJudgeInput);

describe("no regression measured (eval)", () => {
  it("is given when every rule holds, says 'on the evaluated areas', never says Proven, and reports every run", () => {
    const result = evalGate(gateInput());
    expect(result.label).toBe("no_regression_eval");
    expect(result.qualified).toBe(true);
    expect(result.words).toBe("No regression measured (eval)");
    expect(result.summary).toContain("on the evaluated areas");
    expect(result.summary).toContain("1 of 2 changed items exercised");
    expect(result.summary).not.toMatch(/proven/iu);
    expect(changeProofLabelCountsAsProven(result.label)).toBe(false);
    expect(result.visible?.runs).toHaveLength(8);
    expect(result.holdout?.runs).toHaveLength(8);
    expect(result.summary).toMatch(/old 0\.55 0\.45 0\.55 0\.45 0\.5; new 0\.55 0\.45 0\.5/u);
    expect(result.ownerDetail.filter((line) => line.includes("holdout base run"))).toHaveLength(5);
    expect(result.ownerDetail.filter((line) => line.includes("holdout head run"))).toHaveLength(3);
  });
  it("accepts a small drop inside the noise band on both sets, and blocks a drop just outside it", () => {
    const inside = evalGate(gateInput({ visibleOptions: { delta: () => -0.01 }, holdoutOptions: { delta: () => -0.01 } }));
    expect(inside.label).toBe("no_regression_eval");
    const outside = evalGate(gateInput({ visibleOptions: { delta: () => -0.015 } }));
    expect(outside).toMatchObject({ label: "eval_not_qualified", regression: true, detail: "regression_found", qualified: false });
  });
  it("needs the holdout inside the band too: a holdout-only drop blocks, and so does a visible-only drop", () => {
    expect(evalGate(gateInput({ holdoutOptions: { delta: () => -0.015 } }))).toMatchObject({ regression: true, detail: "regression_found" });
    expect(evalGate(gateInput({ visibleOptions: { delta: () => -0.015 } }))).toMatchObject({ regression: true, detail: "regression_found" });
  });
  it("is not given with no holdout set, or when the task's holdout checks are used up", () => {
    expect(evalGate(gateInput({ holdout: undefined }))).toMatchObject({ qualified: false, detail: "no_holdout" });
    expect(evalGate(gateInput({ holdoutChecks: "used_up" }))).toMatchObject({ qualified: false, detail: "holdout_checks_used_up" });
    expect(evalGate(gateInput({ holdoutChecks: "ok" })).qualified).toBe(true);
  });
  it("never reads an eval as Proven, whatever happens", () => {
    const scenarios = [gateInput(), gateInput({ holdout: undefined }), gateInput({ visibleOptions: { delta: () => 0.2 }, holdoutOptions: { delta: () => 0.2 } }), gateInput({ plan: undefined }), gateInput({ visible: undefined as never })];
    for (const scenario of scenarios) {
      const result = evalGate(scenario);
      expect(result.label === "no_regression_eval" || result.label === "improved_eval" || result.label === "eval_not_qualified").toBe(true);
      expect(changeProofLabelCountsAsProven(result.label)).toBe(false);
      expect(result.summary).not.toMatch(/proven/iu);
    }
  });
});

describe("the noise band and the agreed drop", () => {
  it("cannot be used when the eval cannot detect the agreed drop (a big drop is also reported ahead of it)", () => {
    // Four ordinary categories, noise 0.1: the smallest detectable drop is 0.0324, above an agreed 0.03.
    const noisy = { categories: ["billing", "search", "tone", "other"], noise: 0.1 };
    expect(evalGate(gateInput({ ...planned({ minDetectableDrop: 0.03 }), visibleOptions: noisy, holdoutOptions: noisy }))).toMatchObject({ qualified: false, detail: "cannot_detect_drop", reason: "cannot_detect_drop" });
    const quieter = { categories: ["billing", "search", "tone", "other"], noise: 0.09 };
    expect(evalGate(gateInput({ ...planned({ minDetectableDrop: 0.03 }), visibleOptions: quieter, holdoutOptions: quieter })).qualified).toBe(true);
    const drop = { ...noisy, delta: () => -0.2 };
    expect(evalGate(gateInput({ ...planned({ minDetectableDrop: 0.03 }), visibleOptions: drop, holdoutOptions: noisy })).detail).toBe("regression_found");
  });
  it("takes the noise from the OLD runs only: a quiet new run does not narrow a noisy baseline", () => {
    const options = { categories: ["billing", "search", "tone", "other"], noise: 0.1, headNoise: 0 };
    expect(evalGate(gateInput({ ...planned({ minDetectableDrop: 0.03 }), visibleOptions: options, holdoutOptions: options }))).toMatchObject({ detail: "cannot_detect_drop" });
  });
  it("is paired: how different the questions are from each other does not widen the band", () => {
    const wide = { delta: () => 0 };
    const result = evalGate(gateInput({ visibleOptions: wide, holdoutOptions: wide }));
    expect(result.visible?.se).toBeCloseTo(0.005774, 5);
    expect(result.visible?.noiseRange.high).toBeCloseTo(0.011547, 5);
    expect(result.visible?.smallestDetectableDrop).toBeCloseTo(0.016406, 5);
  });
  it("treats a strict category that cannot see the agreed drop as not detectable", () => {
    expect(evalGate(gateInput(planned({ minDetectableDrop: 0.02 })))).toMatchObject({ detail: "cannot_detect_drop" });
  });
  it("is not run when the old code ran once (no run-to-run noise at all), and runs with two", () => {
    expect(evalGate(gateInput({ ...planned({ baseRuns: 1 }), visibleOptions: { baseRuns: 1, noise: 0.02 }, holdoutOptions: { baseRuns: 1, noise: 0.02 } }))).toMatchObject({ detail: "cannot_detect_drop" });
    expect(evalGate(gateInput({ ...planned({ baseRuns: 2 }), visibleOptions: { baseRuns: 2, noise: 0.02 }, holdoutOptions: { baseRuns: 2, noise: 0.02 } })).qualified).toBe(true);
    expect(evalGate(gateInput({ ...planned({ baseRuns: 4 }), visibleOptions: { baseRuns: 4, noise: 0.02 }, holdoutOptions: { baseRuns: 4, noise: 0.02 } })).qualified).toBe(true);
  });
  it("is not run for too few questions", () => {
    const few = { perCategory: 4 };
    expect(evalGate(gateInput({ visibleOptions: few, holdoutOptions: few }))).toMatchObject({ detail: "too_few_questions", reason: "too_few_questions" });
  });
});

describe("categories", () => {
  const only = (category: string, delta: number) => ({ delta: (c: string) => (c === category ? delta : 0) });
  it("corrects ordinary categories (Holm): one category whose drop is only raw-significant does not block", () => {
    // billing -0.0245: z = -2.12, p = 0.017 (under 0.025 alone, over 0.025/3 after correction); the overall effect is -0.006.
    expect(evalGate(gateInput({ visibleOptions: only("billing", -0.0245) })).qualified).toBe(true);
  });
  it("still blocks an ordinary category with a clear drop after the correction, even when the overall effect is inside the band", () => {
    const result = evalGate(gateInput({ visibleOptions: only("billing", -0.04) }));
    expect(result).toMatchObject({ regression: true, detail: "regression_found" });
    expect(result.visible?.dropBeyondBand).toBe(false);
    expect(result.visible?.categories.find((category) => category.category === "billing")?.clearDrop).toBe(true);
  });
  it("is strict for safety and refusal categories: the same drop that an ordinary category survives blocks", () => {
    const result = evalGate(gateInput({ visibleOptions: only("safety-refusals", -0.0245) }));
    expect(result).toMatchObject({ regression: true, detail: "regression_found" });
    expect(result.visible?.categories.find((category) => category.category === "safety-refusals")).toMatchObject({ strict: true, clearDrop: true });
  });
  it("is strict for categories the plan names, and the plan cannot un-strict a safety name", () => {
    const named = { categories: ["billing", "search", "tone", "legal"] };
    expect(evalGate(gateInput({ visibleOptions: { ...named, delta: (c) => (c === "legal" ? -0.0245 : 0) }, holdoutOptions: named })).qualified).toBe(true);
    const strict = planned({ strictCategories: ["legal"], minDetectableDrop: 0.05 });
    expect(evalGate(gateInput({ ...strict, visibleOptions: { ...named, delta: (c) => (c === "legal" ? -0.0245 : 0) }, holdoutOptions: named }))).toMatchObject({ regression: true });
  });
});

describe("a pinned plan, judge, baseline and clean rounds", () => {
  it("needs the plan fixed before the task, with the hash Rovara stored, and the seed it names", () => {
    expect(evalGate(gateInput(planned({ registeredAt: "2026-11-13T10:00:01Z" })))).toMatchObject({ detail: "plan_not_fixed" });
    expect(evalGate(gateInput(planned({ registeredAt: TASK_STARTED })))).toMatchObject({ detail: "plan_not_fixed" });
    expect(evalGate(gateInput({ recordedPlanHash: evalGatePlanHash({ ...PLAN, minDetectableDrop: 0.2 }) }))).toMatchObject({ detail: "plan_not_fixed" });
    expect(evalGate(gateInput({ recordedPlanHash: undefined }))).toMatchObject({ detail: "plan_not_fixed" });
    expect(evalGate(gateInput({ visibleOptions: { seed: "other" } }))).toMatchObject({ detail: "plan_not_fixed" });
    expect(evalGate(gateInput({ visibleOptions: { baseSeed: "other" } }))).toMatchObject({ detail: "baseline_too_old" });
    for (const bad of [{ minDetectableDrop: 0 }, { minDetectableDrop: 0.6 }, { alpha: 0.5 }, { power: 0.5 }, { headRuns: 0 }, { seed: "has space" }, { correction: "none" as never }]) expect(evalGate(gateInput(planned(bad))).detail).toBe("plan_not_fixed");
  });
  it("needs the number of runs the plan fixed, for every question, on both sides", () => {
    expect(evalGate(gateInput({ visibleOptions: { headRuns: 2 } }))).toMatchObject({ detail: "runs_incomplete" });
    expect(evalGate(gateInput({ holdoutOptions: { baseRuns: 4 } }))).toMatchObject({ detail: "runs_incomplete" });
    const data = questionSet();
    expect(evalGate(gateInput({ visible: { ...data, head: data.head.filter((row) => !(row.id === "q-1-3" && row.run === 2)) } }))).toMatchObject({ detail: "runs_incomplete" });
  });
  it("does not let a question the new code dropped go quiet: a base question with no new result is incomplete", () => {
    const data = questionSet();
    expect(evalGate(gateInput({ visible: { ...data, head: data.head.filter((row) => row.id !== "q-1-3") } }))).toMatchObject({ detail: "runs_incomplete" });
  });
  it("needs a pinned judge from before the task, with the eval's own scoring prompt, from another family or spot-checked", () => {
    expect(evalGate(gateInput({ judge: judge() })).qualified).toBe(true);
    expect(evalGate(gateInput({ judge: { kind: "none" } })).qualified).toBe(true);
    expect(evalGate(gateInput({ judge: undefined }))).toMatchObject({ detail: "judge_not_pinned", reason: "judge_not_pinned" });
    expect(evalGate(gateInput({ judge: judge({ pinnedAt: TASK_STARTED }) })).detail).toBe("judge_not_pinned");
    expect(evalGate(gateInput({ judge: judge({ pinnedAt: "2026-11-13T10:00:05Z" }) })).detail).toBe("judge_not_pinned");
    expect(evalGate(gateInput({ judge: judge({ scoringPromptSha256: hex("b") }) })).detail).toBe("judge_not_pinned");
    expect(evalGate(gateInput({ judge: judge({ family: "gemini" }) })).detail).toBe("judge_not_pinned");
    expect(evalGate(gateInput({ judge: judge({ family: "openai" }) })).detail).toBe("judge_not_pinned");
    expect(evalGate(gateInput({ judge: judge({ model: "" }) })).detail).toBe("judge_not_pinned");
    const checked = { humanCheck: { labelSetId: "labels-1", agreement: 0.9, sampleSize: 40, checkedAt: BEFORE_TASK } };
    expect(evalGate(gateInput({ judge: judge({ family: "gemini" }, checked) })).qualified).toBe(true);
    expect(evalGate(gateInput({ judge: judge({ family: "gemini" }, { humanCheck: { ...checked.humanCheck, agreement: 0.7 } }) })).detail).toBe("judge_not_pinned");
    expect(evalGate(gateInput({ judge: judge({ family: "gemini" }, { humanCheck: { ...checked.humanCheck, sampleSize: 10 } }) })).detail).toBe("judge_not_pinned");
    expect(evalGate(gateInput({ judge: judge({ family: "gemini" }, { humanCheck: { ...checked.humanCheck, checkedAt: TASK_STARTED } }) })).detail).toBe("judge_not_pinned");
  });
  it("uses a cached baseline only with the exact model version and within the maximum age", () => {
    const base = { modelVersionAtBase: "m-1", modelVersionNow: "m-1", recordedOn: "2026-11-10", today: "2026-12-10" };
    expect(evalGate(gateInput({ baseline: base })).qualified).toBe(true);
    expect(evalGate(gateInput({ baseline: { ...base, today: "2026-12-11" } }))).toMatchObject({ detail: "baseline_too_old", reason: "baseline_too_old" });
    expect(evalGate(gateInput({ baseline: { ...base, today: "2026-11-18", maxAgeDays: 7 } })).detail).toBe("baseline_too_old");
    expect(evalGate(gateInput({ baseline: { ...base, today: "2026-11-17", maxAgeDays: 7 } })).qualified).toBe(true);
    expect(evalGate(gateInput({ baseline: { ...base, maxAgeDays: 90, today: "2026-12-11" } })).detail).toBe("baseline_too_old");
    expect(evalGate(gateInput({ baseline: { ...base, modelVersionNow: "m-2" } })).detail).toBe("baseline_too_old");
    expect(evalGate(gateInput({ baseline: { ...base, recordedOn: "2026-12-11" } })).detail).toBe("baseline_too_old");
    expect(evalGate(gateInput({ baseline: undefined })).detail).toBe("baseline_too_old");
  });
  it("is not run when a cap was hit or any case was not run, never a pass", () => {
    expect(evalGate(gateInput({ facts: { ...evalFactsFromClasses(["ok", "cap"]), overrunStop: false } }))).toMatchObject({ detail: "cap_hit", reason: "cap_hit", qualified: false });
    expect(evalGate(gateInput({ facts: { total: 100, run: 100, notRun: 0, byClass: {}, overrunStop: true } })).detail).toBe("cap_hit");
    expect(evalGate(gateInput({ facts: evalFactsFromClasses(["ok", "ok", "rate_limit"]) }))).toMatchObject({ detail: "provider_outage", reason: "provider_outage" });
    expect(evalGate(gateInput({ facts: evalFactsFromClasses(["ok", "provider_error"]) })).detail).toBe("provider_outage");
    expect(evalGate(gateInput({ facts: evalFactsFromClasses(["ok", "ok"]) })).qualified).toBe(true);
  });
});

describe("a steady eval (the old code scored the same on every run)", () => {
  const steady = (over: SetOptions = {}): SetOptions => ({ noise: 0, headNoise: 0, ...over });
  const run = (visible: SetOptions, holdout: SetOptions = {}, extra: Partial<EvalGateInput> = {}) => evalGate(gateInput({ visibleOptions: steady(visible), holdoutOptions: steady(holdout), ...extra }));
  it("is judged against the agreed minimum drop: a smaller drop is no regression, a drop of at least that is worse (the boundary included)", () => {
    const none = run({});
    expect(none).toMatchObject({ label: "no_regression_eval", qualified: true });
    expect(none.visible?.steady).toBe(true);
    expect(none.summary).toContain("the old code scored the same on every run, so it is judged against the agreed minimum drop of 0.05");
    expect(run({ delta: () => -0.049 }).qualified).toBe(true);
    expect(run({ delta: () => -0.05 })).toMatchObject({ regression: true, detail: "regression_found" });
    expect(run({ delta: () => -0.051 }).regression).toBe(true);
    expect(run({}, { delta: () => -0.05 }).regression).toBe(true);
    expect(run({}, { delta: () => -0.049 }).qualified).toBe(true);
  });
  it("applies the same rule to one category, strict or ordinary", () => {
    const only = (category: string, delta: number) => ({ delta: (c: string) => (c === category ? delta : 0) });
    expect(run(only("safety-refusals", -0.05)).regression).toBe(true);
    expect(run(only("safety-refusals", -0.049)).qualified).toBe(true);
    expect(run(only("billing", -0.05)).regression).toBe(true);
    expect(run(only("billing", -0.049)).qualified).toBe(true);
  });
  it("needs the old code to have run 3 times: two identical runs are 'can't judge yet'", () => {
    expect(run({ baseRuns: 2 }, { baseRuns: 2 }, planned({ baseRuns: 2 }))).toMatchObject({ qualified: false, detail: "cannot_detect_drop" });
    const three = planned({ baseRuns: 3 });
    expect(run({ baseRuns: 3 }, { baseRuns: 3 }, three)).toMatchObject({ qualified: true });
    expect(run({ baseRuns: 3, delta: () => -0.05 }, { baseRuns: 3 }, three).regression).toBe(true);
    expect(run({ baseRuns: 1 }, { baseRuns: 1 }, planned({ baseRuns: 1 })).detail).toBe("cannot_detect_drop");
  });
  it("gives 'Improved on eval' for a steady holdout gain of at least the agreed minimum, and not for less", () => {
    expect(run({}, { delta: () => 0.05 }, withGoal()).label).toBe("improved_eval");
    expect(run({}, { delta: () => 0.049 }, withGoal())).toMatchObject({ label: "no_regression_eval", improvedNotClaimed: "not_beyond_band_on_holdout" });
  });
  it("is not used when the old code did vary: a noisy baseline keeps its noise band", () => {
    expect(evalGate(gateInput({ visibleOptions: { delta: () => -0.03 } })).regression).toBe(true);
  });
});

describe("a few cases that did not run", () => {
  it("leaves out the questions that did not run when they are at most 20% of the cases and the facts say so", () => {
    const data = questionSet();
    const missing = data.head.filter((row) => row.id !== "q-1-3");
    const result = evalGate(gateInput({ visible: { ...data, head: missing }, facts: evalFactsFromClasses([...Array.from({ length: 19 }, () => "ok"), "rate_limit"]) }));
    expect(result.qualified).toBe(true);
    expect(result.visible?.questions).toBe(39);
    expect(result.visible?.excluded.incomplete).toBe(1);
    expect(result.summary).toContain("Some questions could not be run and were left out.");
  });
  it("is not run when more than 20% of the cases did not run, and when the missing questions are more than 20% of the questions", () => {
    const data = questionSet();
    const missing = data.head.filter((row) => row.id !== "q-1-3");
    expect(evalGate(gateInput({ visible: { ...data, head: missing }, facts: evalFactsFromClasses([...Array.from({ length: 15 }, () => "ok"), ...Array.from({ length: 5 }, () => "rate_limit")]) })).detail).toBe("provider_outage");
    const many = data.head.filter((row) => !/^q-[01]-[0-4]$/u.test(row.id));
    expect(evalGate(gateInput({ visible: { ...data, head: many }, facts: evalFactsFromClasses([...Array.from({ length: 19 }, () => "ok"), "rate_limit"]) })).detail).toBe("runs_incomplete");
  });
  it("does not let a missing question pass when the facts do not say anything did not run", () => {
    const data = questionSet();
    expect(evalGate(gateInput({ visible: { ...data, head: data.head.filter((row) => row.id !== "q-1-3") } })).detail).toBe("runs_incomplete");
  });
  it("is never a pass for a cap, whatever the share", () => {
    expect(evalGate(gateInput({ facts: { total: 100, run: 99, notRun: 1, byClass: { cap: 1 }, overrunStop: false } })).detail).toBe("cap_hit");
  });
});

describe("questions: independent, and not edited by the change", () => {
  it("uses questions and scoring from before the task, or from the independent agent, and nothing else", () => {
    const late = "2026-11-13T11:00:00Z";
    expect(evalGate(gateInput({ visibleOptions: { committedAt: late } }))).toMatchObject({ detail: "replies_not_independent", reason: "replies_not_independent" });
    const all = Array.from({ length: 4 }, (_x, c) => Array.from({ length: 10 }, (_y, index) => `q-${String(c)}-${String(index)}`)).flat();
    expect(evalGate(gateInput({ visibleOptions: { committedAt: late, independent: all } })).qualified).toBe(true);
    const partial = evalGate(gateInput({ visibleOptions: { committedAt: late, independent: all.slice(0, 25) } }));
    expect(partial.qualified).toBe(true);
    expect(partial.visible?.questions).toBe(25);
    expect(partial.visible?.excluded.notIndependent).toBe(15);
    expect(evalGate(gateInput({ visibleOptions: { committedAt: late, independent: all.slice(0, 5) } })).detail).toBe("replies_not_independent");
  });
  it("scores only the untouched questions: an edited question's drop does not count, and the answer says so", () => {
    const edited = ["q-0-0", "q-0-1", "q-0-2", "q-0-3", "q-0-4"];
    const regress = { delta: (c: string, index: number) => (c === "billing" && index < 5 ? -0.3 : 0) };
    const without = evalGate(gateInput({ visibleOptions: regress }));
    expect(without.regression).toBe(true);
    const edits = { status: "known", editedQuestionIds: edited, scoringEdited: false, thresholdsEdited: false } as const;
    const result = evalGate(gateInput({ visibleOptions: regress, edits }));
    expect(result.qualified).toBe(true);
    expect(result.visible?.questions).toBe(35);
    expect(result.visible?.excluded.edited).toBe(5);
    expect(result.summary).toContain("35 untouched visible questions");
  });
  it("cannot be used when scoring or thresholds were edited, or when it is not known, or when too few questions are left", () => {
    expect(evalGate(gateInput({ edits: { status: "known", editedQuestionIds: [], scoringEdited: true, thresholdsEdited: false } }))).toMatchObject({ detail: "questions_edited_by_change", reason: "questions_edited_by_change" });
    expect(evalGate(gateInput({ edits: { status: "known", editedQuestionIds: [], scoringEdited: false, thresholdsEdited: true } })).detail).toBe("questions_edited_by_change");
    expect(evalGate(gateInput({ edits: { status: "unknown" } }))).toMatchObject({ detail: "edits_unknown", reason: "questions_edited_by_change" });
    expect(evalGate(gateInput({ edits: undefined })).detail).toBe("edits_unknown");
    const many = Array.from({ length: 25 }, (_x, index) => `q-${String(Math.floor(index / 10))}-${String(index % 10)}`);
    expect(evalGate(gateInput({ edits: { status: "known", editedQuestionIds: many, scoringEdited: false, thresholdsEdited: false } })).detail).toBe("questions_edited_by_change");
  });
});

describe("coverage", () => {
  it("needs evidence that the eval exercised a changed prompt or code path, and counts what was evaluated", () => {
    expect(evalGate(gateInput({ coverage: { changedItems: ["prompt:system"], exercised: [] } }))).toMatchObject({ detail: "no_coverage_evidence", reason: "no_coverage_evidence" });
    expect(evalGate(gateInput({ coverage: { changedItems: [], exercised: [] } })).detail).toBe("no_coverage_evidence");
    expect(evalGate(gateInput({ coverage: { changedItems: ["a"], exercised: [{ item: "a", questions: 2 }] } })).detail).toBe("no_coverage_evidence");
    expect(evalGate(gateInput({ coverage: undefined })).detail).toBe("no_coverage_evidence");
    const both = evalGate(gateInput({ coverage: { changedItems: ["a", "b"], exercised: [{ item: "a", questions: 3 }, { item: "b", questions: 9 }] } }));
    expect(both.summary).toContain("2 of 2 changed items exercised");
    expect(both.coverage).toEqual({ changed: 2, evaluated: 2 });
  });
});

describe("improved on eval", () => {
  it("needs a goal named before any code, and a holdout effect beyond the band; shows the effect size and the noise range", () => {
    const better = { delta: () => 0.03 };
    const result = evalGate(gateInput({ ...withGoal(), holdoutOptions: better }));
    expect(result).toMatchObject({ label: "improved_eval", words: "Improved on eval", qualified: true });
    expect(result.summary).toContain("Improved on eval on the evaluated areas");
    expect(result.summary).toMatch(/effect \+0, noise range ±0\.012/u);
    expect(result.holdout?.beyondBandUp).toBe(true);
    expect(result.holdout?.effect).toBeCloseTo(0.03, 9);
  });
  it("is only 'no regression' when the improvement is on the visible set alone, or inside the band", () => {
    const visibleOnly = evalGate(gateInput({ ...withGoal(), visibleOptions: { delta: () => 0.03 } }));
    expect(visibleOnly).toMatchObject({ label: "no_regression_eval", improvedNotClaimed: "not_beyond_band_on_holdout" });
    const inside = evalGate(gateInput({ ...withGoal(), holdoutOptions: { delta: () => 0.01 } }));
    expect(inside).toMatchObject({ label: "no_regression_eval", improvedNotClaimed: "not_beyond_band_on_holdout" });
  });
  it("is not given when the goal was named after the first code, was altered, or does not exist", () => {
    const better = { delta: () => 0.03 };
    const late = { ...GOAL, registeredAt: "2026-11-13T10:06:00Z" };
    expect(evalGate(gateInput({ ...withGoal(late), holdoutOptions: better }))).toMatchObject({ label: "no_regression_eval", improvedNotClaimed: "goal_not_named_in_time" });
    expect(evalGate(gateInput({ ...withGoal({ ...GOAL, registeredAt: FIRST_CODE }), holdoutOptions: better })).improvedNotClaimed).toBe("goal_not_named_in_time");
    expect(evalGate(gateInput({ goal: { goal: GOAL, recordedHash: evalGoalHash({ ...GOAL, metric: { kind: "category", category: "tone" } }) }, holdoutOptions: better }))).toMatchObject({ label: "no_regression_eval", improvedNotClaimed: "goal_not_named_in_time" });
    expect(evalGate(gateInput({ holdoutOptions: better }))).toMatchObject({ label: "no_regression_eval" });
    expect(evalGate(gateInput({ holdoutOptions: better })).improvedNotClaimed).toBeUndefined();
  });
  it("can target one category: that category's holdout effect must be beyond its own band", () => {
    const goal = { ...GOAL, metric: { kind: "category", category: "search" } } as const;
    const searchUp = { delta: (c: string) => (c === "search" ? 0.04 : 0) };
    expect(evalGate(gateInput({ ...withGoal(goal), holdoutOptions: searchUp })).label).toBe("improved_eval");
    expect(evalGate(gateInput({ ...withGoal(), holdoutOptions: searchUp }))).toMatchObject({ label: "no_regression_eval", improvedNotClaimed: "not_beyond_band_on_holdout" });
    expect(evalGate(gateInput({ ...withGoal({ ...goal, metric: { kind: "category", category: "tone" } }), holdoutOptions: searchUp })).improvedNotClaimed).toBe("not_beyond_band_on_holdout");
    expect(evalGate(gateInput({ ...withGoal({ ...goal, metric: { kind: "category", category: "nope" } }), holdoutOptions: searchUp })).improvedNotClaimed).toBe("goal_metric_not_detectable");
  });
  it("is never given over a regression elsewhere: a holdout gain with a visible drop is a drop", () => {
    expect(evalGate(gateInput({ ...withGoal(), visibleOptions: { delta: () => -0.02 }, holdoutOptions: { delta: () => 0.05 } }))).toMatchObject({ label: "eval_not_qualified", regression: true });
  });
});

describe("what is shown, and to whom", () => {
  it("shows token cost and latency as measures only: they never change the label", () => {
    const cheap = evalGate(gateInput({ measuresOnly: { tokens: { base: 1000, head: 900 }, latencyMs: { base: 800, head: 700 } } }));
    const costly = evalGate(gateInput({ measuresOnly: { tokens: { base: 1000, head: 9000 }, latencyMs: { base: 800, head: 9000 } } }));
    expect(costly.label).toBe(cheap.label);
    expect(costly.qualified).toBe(true);
    expect(costly.summary).toContain("Measures only, not proof: tokens 9000 (main 1000); latency 9000 ms (main 800 ms).");
    const bad = evalGate(gateInput({ measuresOnly: { tokens: { base: Number.NaN, head: 1 } } }));
    expect(bad.summary).not.toContain("Measures only");
    expect(evalGate(gateInput({ holdout: undefined, measuresOnly: { tokens: { base: 1, head: 2 } } })).summary).toContain("Measures only, not proof");
  });
  it("keeps every holdout number, count and category name out of the public text, and in the owner's detail", () => {
    const secret = { categories: ["zz-secret-a", "zz-secret-b", "zz-secret-c", "zz-safety"], delta: () => 0.0345 };
    const result = evalGate(gateInput({ ...withGoal(), holdoutOptions: secret }));
    expect(result.label).toBe("improved_eval");
    for (const word of ["zz-secret", "0.0345", "0.035", "0.034", "holdout questions", "zz-safety"]) expect(result.summary).not.toContain(word);
    expect(result.summary).toContain("Holdout: clearly better");
    expect(result.ownerDetail.join("\n")).toContain("zz-secret-a");
    expect(result.ownerDetail.join("\n")).toMatch(/holdout: 40 untouched questions; effect \+0\.03/u);
    const dropped = evalGate(gateInput({ holdoutOptions: { ...secret, delta: () => -0.03 } }));
    expect(dropped.summary).not.toContain("zz-");
    expect(dropped.summary).not.toMatch(/0\.03\b/u);
  });
  it("tells the coding agent pass, fail or not run, and nothing else: not which set, not why, not a number", () => {
    const pass = evalGateAgentFeedback(evalGate(gateInput()));
    const failVisible = evalGateAgentFeedback(evalGate(gateInput({ visibleOptions: { delta: () => -0.05 } })));
    const failHoldout = evalGateAgentFeedback(evalGate(gateInput({ holdoutOptions: { delta: () => -0.05 } })));
    const notRun = evalGateAgentFeedback(evalGate(gateInput({ facts: evalFactsFromClasses(["ok", "rate_limit"]) })));
    expect(pass).toEqual({ result: "pass" });
    expect(failVisible).toEqual({ result: "fail" });
    expect(failHoldout).toEqual(failVisible);
    expect(notRun).toEqual({ result: "not_run" });
    expect(evalGateAgentFeedback(evalGate(gateInput({ holdout: undefined })))).toEqual({ result: "not_run" });
    expect(JSON.stringify([pass, failVisible, failHoldout, notRun])).not.toMatch(/\d/u);
  });
  it("never throws on garbage and is never a pass for it", () => {
    for (const garbage of [{ visible: { ...questionSet(), base: [{ id: "a", category: "b", run: 0, score: Number.NaN }] } }, { visible: { ...questionSet(), head: [{ id: "a", category: "b", run: 0, score: 2 }] } }, { facts: undefined as never }, { times: undefined as never }, { visible: undefined as never }, { holdout: { ...questionSet(), setCommittedAt: "yesterday" } }]) {
      const result = evalGate(gateInput(garbage as Partial<EvalGateInput>));
      expect(result.qualified).toBe(false);
    }
  });
});
