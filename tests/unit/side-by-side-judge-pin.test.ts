// TE-F10, DECISIONS 170: the judge is pinned (model, version, scoring prompt) before the task, from a different model family than the product and coding models or else spot-checked against human labels, its identity is in the
// evidence, and the result is evidence shown to people, never a proof label. A run whose judge breaks a rule is refused before any call.
import { describe, expect, it } from "vitest";
import {
  checkSideBySideJudgePin, checkKindInfo, judgeIdentityWords, renderSideBySide, runSideBySide, sideBySidePairsPart, sideBySideScoringPromptSha256, SIDE_BY_SIDE_SPOT_CHECK_MIN_AGREEMENT, SIDE_BY_SIDE_SPOT_CHECK_MIN_SAMPLES,
  type SideBySideHumanCheck, type SideBySideSummary,
} from "../../packages/contracts/src/index.js";
import { PIN, RUN_DEFAULTS, COMPANY_A, recordingJudge, reportNeeded, sbsWorld, source, verdictText } from "../support/side-by-side-world.js";

const base = { pin: PIN, taskStartedAt: RUN_DEFAULTS.taskStartedAt, productModelFamily: "gemini" } as const;
const human = (over: Partial<SideBySideHumanCheck> = {}): SideBySideHumanCheck => ({ labelSetId: "labels-1", agreement: 0.9, sampleSize: 25, checkedAt: "2026-10-30T00:00:00Z", ...over });

describe("the pin predates the task", () => {
  it("accepts a pin made before the task started", () => {
    expect(checkSideBySideJudgePin(base)).toMatchObject({ ok: true, identity: { model: "claude-judge", version: "2026-10-01", family: "claude", independence: "different_family" } });
  });
  it.each([
    ["at the same second", RUN_DEFAULTS.taskStartedAt],
    ["after the task started", "2026-11-13T09:00:01Z"],
    ["a day after", "2026-11-14T00:00:00Z"],
  ])("refuses a pin made %s", (_name, pinnedAt) => {
    expect(checkSideBySideJudgePin({ ...base, pin: { ...PIN, pinnedAt } })).toEqual({ ok: false, reason: "judge_pinned_after_task" });
  });
  it.each(["2026-11-01", "2026-11-01T00:00:00.5Z", "2026-11-01T00:00:00+02:00", "yesterday", "", "2026-13-01T00:00:00Z"])("refuses a pin time that is not exact UTC text: %s", (pinnedAt) => {
    expect(checkSideBySideJudgePin({ ...base, pin: { ...PIN, pinnedAt } })).toEqual({ ok: false, reason: "judge_pin_invalid" });
  });
});

describe("the model, version and scoring prompt are pinned", () => {
  it("refuses a scoring prompt that is not the code's own role text, and one that is not a hash", () => {
    expect(PIN.scoringPromptSha256).toBe(sideBySideScoringPromptSha256());
    expect(checkSideBySideJudgePin({ ...base, pin: { ...PIN, scoringPromptSha256: "a".repeat(64) } })).toEqual({ ok: false, reason: "judge_pin_invalid" });
    expect(checkSideBySideJudgePin({ ...base, pin: { ...PIN, scoringPromptSha256: "nope" } })).toEqual({ ok: false, reason: "judge_pin_invalid" });
  });
  it("refuses a missing, empty or malformed model, version or family", () => {
    for (const over of [{ model: "" }, { version: "" }, { family: "" }, { model: "has space" }, { version: "x\ny" }, { family: "Not A Family!" }, { model: undefined }, { version: 3 }]) {
      expect(checkSideBySideJudgePin({ ...base, pin: { ...PIN, ...over } as never }), JSON.stringify(over)).toEqual({ ok: false, reason: "judge_pin_invalid" });
    }
    expect(checkSideBySideJudgePin({ ...base, pin: undefined as never })).toEqual({ ok: false, reason: "judge_pin_invalid" });
  });
});

describe("a different family, or a spot check", () => {
  it("refuses a judge of the product model's family with no spot check", () => {
    expect(checkSideBySideJudgePin({ ...base, productModelFamily: "claude" })).toEqual({ ok: false, reason: "judge_same_family_unchecked" });
    expect(checkSideBySideJudgePin({ ...base, productModelFamily: "  Claude " })).toEqual({ ok: false, reason: "judge_same_family_unchecked" });
  });
  it("refuses a judge of the coding model's family with no spot check, even when the product's family differs", () => {
    expect(checkSideBySideJudgePin({ ...base, codingModelFamily: "claude" })).toEqual({ ok: false, reason: "judge_same_family_unchecked" });
    expect(checkSideBySideJudgePin({ ...base, codingModelFamily: "gpt" })).toMatchObject({ ok: true });
  });
  it("cannot tell the family when the product's is unknown, so it needs the spot check", () => {
    expect(checkSideBySideJudgePin({ ...base, productModelFamily: "" })).toEqual({ ok: false, reason: "judge_same_family_unchecked" });
    expect(checkSideBySideJudgePin({ ...base, productModelFamily: "" , humanCheck: human() })).toMatchObject({ ok: true });
  });
  it("accepts a same-family judge that was spot-checked against human labels, and records that", () => {
    const outcome = checkSideBySideJudgePin({ ...base, productModelFamily: "claude", humanCheck: human() });
    expect(outcome).toMatchObject({ ok: true, identity: { independence: "spot_checked_against_human_labels", humanCheck: { labelSetId: "labels-1", agreement: 0.9, sampleSize: 25 } } });
  });
  it("refuses a spot check that is too weak, too small, made after the task, or malformed", () => {
    expect(SIDE_BY_SIDE_SPOT_CHECK_MIN_AGREEMENT).toBe(0.8);
    expect(SIDE_BY_SIDE_SPOT_CHECK_MIN_SAMPLES).toBe(20);
    for (const over of [{ agreement: 0.79 }, { agreement: Number.NaN }, { agreement: 1.5 }, { sampleSize: 19 }, { sampleSize: 20.5 }, { checkedAt: RUN_DEFAULTS.taskStartedAt }, { checkedAt: "later" }, { labelSetId: "" }]) {
      expect(checkSideBySideJudgePin({ ...base, productModelFamily: "claude", humanCheck: human(over) }), JSON.stringify(over)).toEqual({ ok: false, reason: "judge_same_family_unchecked" });
    }
    expect(checkSideBySideJudgePin({ ...base, productModelFamily: "claude", humanCheck: human({ agreement: 0.8, sampleSize: 20 }) })).toMatchObject({ ok: true });
  });
  it("does not let a spot check stand in for a different family when the families already differ (the identity says which it is)", () => {
    expect(checkSideBySideJudgePin({ ...base, humanCheck: human() })).toMatchObject({ ok: true, identity: { independence: "different_family" } });
  });
});

describe("a run with a judge that breaks a rule makes no call at all", () => {
  async function refusedRun(judgePin: typeof PIN, over: Record<string, unknown> = {}) {
    const world = sbsWorld();
    const judge = recordingJudge(COMPANY_A, (call) => verdictText(call, "same"), judgePin);
    let calls = 0;
    const egress = { capabilities: world.egress.capabilities, forward: (...args: Parameters<typeof world.egress.forward>) => { calls += 1; return world.egress.forward(...args); } };
    const result = await runSideBySide({ ...RUN_DEFAULTS, company: COMPANY_A.orgId, egress, scope: world.scope, source: source(COMPANY_A, 3), judge, report: reportNeeded(), policy: { preset: "careful", aiPilot: false, optIn: false }, seed: "s", ...over });
    return { result, calls, judgeCalls: judge.received.length };
  }
  it("refuses a pin made after the task started", async () => {
    expect(await refusedRun({ ...PIN, pinnedAt: "2026-11-13T09:00:01Z" })).toEqual({ result: { status: "refused", reason: "judge_pinned_after_task" }, calls: 0, judgeCalls: 0 });
  });
  it("refuses a scoring prompt that is not the pinned one", async () => {
    expect(await refusedRun({ ...PIN, scoringPromptSha256: "b".repeat(64) })).toEqual({ result: { status: "refused", reason: "judge_pin_invalid" }, calls: 0, judgeCalls: 0 });
  });
  it("refuses a judge of the product's family without a spot check, and runs it with one", async () => {
    expect(await refusedRun(PIN, { productModelFamily: "claude" })).toEqual({ result: { status: "refused", reason: "judge_same_family_unchecked" }, calls: 0, judgeCalls: 0 });
    const world = sbsWorld();
    world.answers("a", "b", "c", "d", "e", "f");
    const result = await runSideBySide({ ...RUN_DEFAULTS, productModelFamily: "claude", humanCheck: human(), company: COMPANY_A.orgId, egress: world.egress, scope: world.scope, source: source(COMPANY_A, 3), judge: recordingJudge(COMPANY_A, (call) => verdictText(call, "same")), report: reportNeeded(), policy: { preset: "careful", aiPilot: false, optIn: false }, seed: "s" });
    expect(result.status === "ran" && result.summary.judge.independence).toBe("spot_checked_against_human_labels");
  });
});

describe("the judge's identity is in the evidence", () => {
  async function summary(over: Record<string, unknown> = {}): Promise<SideBySideSummary> {
    const world = sbsWorld();
    world.answers("a", "b", "c", "d");
    const result = await runSideBySide({ ...RUN_DEFAULTS, company: COMPANY_A.orgId, egress: world.egress, scope: world.scope, source: source(COMPANY_A, 2), judge: recordingJudge(COMPANY_A, (call) => verdictText(call, "same")), report: reportNeeded(), policy: { preset: "careful", aiPilot: false, optIn: false }, seed: "s", ...over });
    if (result.status !== "ran") throw new Error("expected a run");
    return result.summary;
  }
  it("is in the summary: model, version, family, scoring prompt hash, pin time and why it is independent", async () => {
    expect((await summary()).judge).toEqual({ ...PIN, independence: "different_family" });
  });
  it("is printed in both renderings, and for a spot-checked judge the rendering says so with the numbers", async () => {
    const plain = await summary();
    for (const mode of ["public", "full"] as const) expect(renderSideBySide(plain, { mode })).toContain("Judge: claude-judge 2026-10-01 (claude family), pinned before the task, from a different model family");
    const checked = await summary({ productModelFamily: "claude", humanCheck: human() });
    for (const mode of ["public", "full"] as const) expect(renderSideBySide(checked, { mode })).toContain("same model family as the product or coding model, so spot-checked against human labels (90% agreement on 25 cases)");
    expect(judgeIdentityWords(checked.judge)).not.toMatch(/different model family/u);
  });
  it("is in the check's label for the pack writer", async () => {
    expect(sideBySidePairsPart(await summary(), { mode: "full" }, () => undefined).label).toContain("judge: claude-judge 2026-10-01, different model family");
    expect(sideBySidePairsPart(await summary({ productModelFamily: "claude", humanCheck: human() }), { mode: "full" }, () => undefined).label).toContain("spot-checked against human labels");
  });
});

describe("side-by-side is evidence shown to people, never a proof label", () => {
  it("never prints one of DECISIONS 170's three labels, and its kind never counts toward the proof", async () => {
    const world = sbsWorld();
    world.answers("a", "b", "c", "d");
    const result = await runSideBySide({ ...RUN_DEFAULTS, company: COMPANY_A.orgId, egress: world.egress, scope: world.scope, source: source(COMPANY_A, 2), judge: recordingJudge(COMPANY_A, (call) => verdictText(call, "b_better")), report: reportNeeded(), policy: { preset: "careful", aiPilot: false, optIn: false }, seed: "s" });
    if (result.status !== "ran") throw new Error("expected a run");
    expect(result.summary.counts.better + result.summary.counts.worse).toBeGreaterThan(0);
    for (const mode of ["public", "full"] as const) expect(renderSideBySide(result.summary, { mode })).not.toMatch(/\bProven\b|No regression measured|Improved on eval|\bproof\b|\bReal\b/iu);
    expect(sideBySidePairsPart(result.summary, { mode: "full" }, () => undefined).label).not.toMatch(/Proven|No regression|Improved on eval/iu);
    expect(JSON.stringify(result.summary)).not.toMatch(/"(?:trust|proofBasis|label|proven)"/u);
    expect(result.summary.evidence.countsTowardProof).toBe(false);
    expect(checkKindInfo("side_by_side")?.countsTowardProof).toBe(false);
  });
});
