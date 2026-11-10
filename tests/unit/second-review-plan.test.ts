// The second review by a different AI company. The setting (off, shadow, on; a company lock is a floor; lowering needs a second person), which model may be the second reviewer (any source the company connected; another
// known company than every recorded model; allowed, not forbidden; the strongest suggestion by default; the company may choose), when `on` is allowed (evidence recomputed from the stored replay
// run, else shadow), and what a finished second review means (accepted only for the planned model, the code review and the current candidate; shadow never blocks; on blocks; no answer blocks nothing).
// Also the replay check's fields and bar, which the quality suite fills.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  HowWeWorkStageSchema, SECOND_REVIEW_BAR, SECOND_REVIEW_MODES, SecondOpinionSchema, SecondReviewReplayRunSchema, configuredSecondReviewMode,
  lockSecondReviewLoweringNeedsSecondPerson, projectSecondReviewLoweringNeedsSecondPerson, secondReviewModelKey, secondReviewShadowPassed,
  stricterSecondReviewMode, summarizeSecondReviewReplay, workflowFindingFingerprint,
  type ModelIdentifier, type SecondReviewReplayCase, type SecondReviewReplayRun, type SecondReviewVerdict, type WorkflowReviewReport,
} from "@agentx/contracts";
import {
  admitSecondReview, againstModels, estimateSecondReviewUsd, planSecondReview, secondOpinionOf, secondOpinionPrLines, secondOpinionShownOn,
  mergeWaitsForSecondReview, secondOpinionUnavailable, secondReviewAcknowledgement, secondReviewAlreadyRan, secondReviewBlocksWhenUnavailable,
  type SecondReviewPlan, type SecondReviewPlanInput,
} from "../../packages/broker/src/core/second-review/plan.js";

const SONNET: ModelIdentifier = { provider: "anthropic", modelId: "claude-sonnet-4-6" };
const OPUS: ModelIdentifier = { provider: "anthropic", modelId: "claude-opus-4-6" };
const GPT: ModelIdentifier = { provider: "openai", modelId: "gpt-5.5" };
const NOVA_PRO: ModelIdentifier = { provider: "amazon-bedrock", modelId: "us.amazon.nova-pro-v1:0" };
const NOVA_PREMIER: ModelIdentifier = { provider: "amazon-bedrock", modelId: "us.amazon.nova-premier-v1:0" };
const BEDROCK_GPT_OSS: ModelIdentifier = { provider: "amazon-bedrock", modelId: "openai.gpt-oss-120b-1:0" };

const plan = (overrides: Partial<SecondReviewPlanInput> = {}): SecondReviewPlan => planSecondReview({
  switchOn: true, mode: "shadow", against: [SONNET], project: {}, forbidden: [], sources: [SONNET, OPUS, GPT, NOVA_PRO, NOVA_PREMIER, BEDROCK_GPT_OSS],
  verdicts: [], replayRuns: [], ...overrides,
});
const ran = (result: SecondReviewPlan) => (result.run ? { mode: result.mode, model: `${result.model.provider}/${result.model.modelId}`, company: result.company, downgraded: result.downgraded } : { skipped: result.reason });

// ---- replay runs and verdicts (built from the real bar)
const replayCases = (spec: { known: number; planted: number; both: number; baselineOnly: number; extra: number; neither?: number }): SecondReviewReplayCase[] => {
  const shapes: Array<[boolean, boolean, number]> = [[true, true, spec.both], [true, false, spec.baselineOnly], [false, true, spec.extra], [false, false, spec.neither ?? 0]];
  const out: SecondReviewReplayCase[] = [];
  for (const [baselineCaught, candidateCaught, count] of shapes) {
    for (let i = 0; i < count; i += 1) out.push({ caseId: `c${String(out.length + 1)}`, kind: "known_defect", baselineCaught, candidateCaught, candidateBlockingFindings: 0, candidateDismissedBlocking: 0 });
  }
  return out.map((entry, index) => ({ ...entry, kind: index < spec.known ? "known_defect" as const : "planted_bug" as const }));
};
const PASSING_CASES = replayCases({ known: 30, planted: 20, both: 32, baselineOnly: 8, extra: 5, neither: 5 });
const runFor = (model: ModelIdentifier, over: Partial<SecondReviewReplayRun> = {}): SecondReviewReplayRun => ({ runId: "run-1", ranAt: "2026-11-01T00:00:00.000Z", candidate: model, baseline: OPUS, cases: PASSING_CASES, ...over });
const verdictFor = (model: ModelIdentifier, over: Partial<SecondReviewVerdict> = {}): SecondReviewVerdict => ({
  model: secondReviewModelKey(model), replayRunId: "run-1", baseline: OPUS, shadow: { startedAt: "2026-11-02T00:00:00.000Z", endedAt: "2026-11-16T00:00:00.000Z", findings: 10, agreed: 4, reviews: 10 },
  createdAt: "2026-11-20T00:00:00.000Z", createdBy: "staff:alice", ...over,
});
/** Evidence that holds for a model: a passing replay run and a verdict on it. */
const proof = (model: ModelIdentifier) => ({ verdicts: [verdictFor(model)], replayRuns: [runFor(model)] });

describe("the setting review.otherCompany", () => {
  it("is off unless somebody chose; the project's choice beats the company's default", () => {
    expect(configuredSecondReviewMode({})).toBe("off");
    expect(configuredSecondReviewMode({ companyDefault: "shadow" })).toBe("shadow");
    expect(configuredSecondReviewMode({ companyDefault: "shadow", project: "off" })).toBe("off");
    expect(configuredSecondReviewMode({ companyDefault: "off", project: "on" })).toBe("on");
  });

  it("a company lock is a floor: it raises a project and never lowers one", () => {
    expect(configuredSecondReviewMode({ project: "off", companyLock: "shadow" })).toBe("shadow");
    expect(configuredSecondReviewMode({ companyDefault: "off", companyLock: "on" })).toBe("on");
    expect(configuredSecondReviewMode({ project: "on", companyLock: "shadow" })).toBe("on");
    expect(configuredSecondReviewMode({ project: "on", companyLock: "off" })).toBe("on");
    expect(stricterSecondReviewMode("shadow", "off")).toBe("shadow");
    expect(stricterSecondReviewMode("off", "on")).toBe("on");
  });

  it("lowering needs a second person (W8): on to shadow or off for a project, any lower lock; raising and observing do not", () => {
    expect(projectSecondReviewLoweringNeedsSecondPerson("on", "shadow")).toBe(true);
    expect(projectSecondReviewLoweringNeedsSecondPerson("on", "off")).toBe(true);
    expect(projectSecondReviewLoweringNeedsSecondPerson("shadow", "off")).toBe(false);
    expect(projectSecondReviewLoweringNeedsSecondPerson("off", "on")).toBe(false);
    expect(projectSecondReviewLoweringNeedsSecondPerson("on", "on")).toBe(false);
    expect(lockSecondReviewLoweringNeedsSecondPerson("on", "shadow")).toBe(true);
    expect(lockSecondReviewLoweringNeedsSecondPerson("shadow", undefined)).toBe(true);
    expect(lockSecondReviewLoweringNeedsSecondPerson("on", "off")).toBe(true);
    expect(lockSecondReviewLoweringNeedsSecondPerson(undefined, "shadow")).toBe(false);
    expect(lockSecondReviewLoweringNeedsSecondPerson("shadow", "on")).toBe(false);
    expect(lockSecondReviewLoweringNeedsSecondPerson(undefined, undefined)).toBe(false);
    expect(lockSecondReviewLoweringNeedsSecondPerson("shadow", "shadow")).toBe(false);
  });
});

describe("againstModels (W6)", () => {
  it("is every build operation's ran model, in every round, and the first reviewer's", () => {
    expect(againstModels({ buildRanModels: [SONNET, OPUS, SONNET], firstReviewerRan: BEDROCK_GPT_OSS })).toEqual([SONNET, OPUS, BEDROCK_GPT_OSS]);
  });

  it("is undefined when any model is unknown, because an unknown model cannot be shown to differ", () => {
    expect(againstModels({ buildRanModels: [SONNET, undefined], firstReviewerRan: OPUS })).toBeUndefined();
    expect(againstModels({ buildRanModels: [SONNET], firstReviewerRan: undefined })).toBeUndefined();
    expect(againstModels({ buildRanModels: [], firstReviewerRan: OPUS })).toBeUndefined();
  });

  it("a second round's build model counts: a reviewer that matches round 2's company is refused", () => {
    const against = againstModels({ buildRanModels: [SONNET, BEDROCK_GPT_OSS], firstReviewerRan: OPUS })!;
    expect(ran(plan({ against, sources: [BEDROCK_GPT_OSS, NOVA_PRO]}))).toMatchObject({ company: "amazon" });
    expect(ran(plan({ against, sources: [BEDROCK_GPT_OSS]}))).toEqual({ skipped: "no-candidate" });
  });
});

const digest = "a".repeat(64);
const report = (status: WorkflowReviewReport["status"], findings: WorkflowReviewReport["findings"] = [], extra: Partial<WorkflowReviewReport> = {}): WorkflowReviewReport => ({
  operationId: randomUUID(), candidateDigest: digest, role: "CRITIC", provider: GPT.provider, version: GPT.modelId, status, findings, readOnly: true, recordedAt: "2026-11-02T12:00:00.000Z", ...extra,
});
const BLOCKING = { text: "off by one in the loop bound", origin: "INTRODUCED" as const };
const runPlan = (mode: "shadow" | "on") => {
  const planned = plan({ mode, ...(mode === "on" ? proof(GPT) : {}) });
  if (!planned.run) throw new Error("expected a plan");
  return planned;
};
const opinion = (mode: "shadow" | "on", r: WorkflowReviewReport, over: Partial<Parameters<typeof secondOpinionOf>[0]> = {}) =>
  secondOpinionOf({ plan: runPlan(mode), report: r, currentCandidateDigest: digest, ...over });

describe("secondOpinionOf: what a finished second review means", () => {
  it("shadow never blocks, and records what on would have done", () => {
    expect(opinion("shadow", report("FINDINGS", [BLOCKING]))).toMatchObject({ mode: "shadow", blocked: false, wouldHaveBlocked: true, blockingCount: 1, unavailable: false, company: "openai" });
  });

  it("on blocks on a finding the change introduced", () => {
    expect(opinion("on", report("FINDINGS", [BLOCKING]))).toMatchObject({ mode: "on", blocked: true, wouldHaveBlocked: true, blockingCount: 1 });
  });

  it("on does not block on a pass, an advisory or pre-existing finding, or one the owner accepted as a risk", () => {
    expect(opinion("on", report("PASS"))).toMatchObject({ blocked: false, wouldHaveBlocked: false, blockingCount: 0 });
    expect(opinion("on", report("PASS", [{ text: "style nit", origin: "INTRODUCED", advisory: true }, { text: "old problem", origin: "PRE_EXISTING" }]))).toMatchObject({ blocked: false });
    const found = report("FINDINGS", [BLOCKING]);
    const accepted = [{ candidateDigest: digest, role: "CRITIC", fingerprint: workflowFindingFingerprint("CRITIC", { text: BLOCKING.text }) }];
    expect(opinion("on", found, { accepted })).toMatchObject({ blocked: false, wouldHaveBlocked: false });
    expect(opinion("on", found, { accepted: [{ ...accepted[0]!, fingerprint: "b".repeat(64) }] })).toMatchObject({ blocked: true });
  });

  it("a second review that gave no answer blocks nothing, in either mode, and says it did not run", () => {
    for (const status of ["FAILED", "INTERRUPTED", "UNKNOWN"] as const) {
      expect(opinion("on", report(status)), status).toMatchObject({ blocked: false, wouldHaveBlocked: false, unavailable: true, unavailableReason: "no-answer" });
      expect(opinion("shadow", report(status)), status).toMatchObject({ blocked: false, unavailable: true });
    }
  });

  it("keeps the downgrade on the record", () => {
    const downgraded = plan({ mode: "on" });
    if (!downgraded.run) throw new Error("expected a plan");
    expect(secondOpinionOf({ plan: downgraded, report: report("FINDINGS", [BLOCKING]), currentCandidateDigest: digest })).toMatchObject({ mode: "shadow", downgraded: "replay-not-passed", blocked: false });
  });

  it("the record cannot say a shadow opinion blocked, an unknown company, or an unavailable one with findings", () => {
    const good = opinion("shadow", report("FINDINGS", [BLOCKING]));
    expect(SecondOpinionSchema.safeParse({ ...good, blocked: true }).success).toBe(false);
    expect(SecondOpinionSchema.safeParse({ ...good, company: "other" }).success).toBe(false);
    expect(SecondOpinionSchema.safeParse({ ...good, extra: 1 }).success).toBe(false);
    expect(SecondOpinionSchema.safeParse({ ...good, unavailable: true }).success).toBe(false);
    const gone = secondOpinionUnavailable(runPlan("on"), "not-run");
    expect(SecondOpinionSchema.safeParse({ ...gone, wouldHaveBlocked: true }).success).toBe(false);
  });

  it("shows a shadow opinion on the task page and never on the pull request; an on opinion that blocked on both", () => {
    expect(secondOpinionShownOn({ mode: "shadow", blocked: false })).toEqual({ taskPage: true, pullRequest: false });
    expect(secondOpinionShownOn({ mode: "on", blocked: false })).toEqual({ taskPage: true, pullRequest: false });
    expect(secondOpinionShownOn({ mode: "on", blocked: true })).toEqual({ taskPage: true, pullRequest: true });
  });
});

describe("the pull request lines (W7)", () => {
  const hostile = "See [the fix](https://evil.example/x) @octocat #123 ![img](https://evil.example/i.png) <!-- hide --> GH-45 Fixes ENG-9 https://evil.example/path www.evil.example";

  it("are empty for a shadow opinion and a non-blocking one, and one fixed line for an on one that did not run", () => {
    expect(secondOpinionPrLines(opinion("shadow", report("FINDINGS", [{ text: hostile, origin: "INTRODUCED" }])))).toEqual([]);
    expect(secondOpinionPrLines(opinion("on", report("PASS")))).toEqual([]);
    // An `on` one that did not run is the one fixed line, no model text.
    expect(secondOpinionPrLines(secondOpinionUnavailable(runPlan("on"), "no-answer"))).toEqual(["Second review did not run: the reviewer gave no usable answer after retrying"]);
    expect(secondOpinionPrLines(secondOpinionUnavailable(runPlan("shadow"), "no-answer"))).toEqual([]);
  });

  it("make model text inert: no link, mention, image, comment, issue reference or closing word survives", () => {
    const lines = secondOpinionPrLines(opinion("on", report("FINDINGS", [{ text: hostile, origin: "INTRODUCED", file: "src/@evil/[x](y).ts", line: 9 }], { version: "@octocat <b>model</b>" })));
    const text = lines.join("\n");
    expect(lines[0]).toContain("Second review");
    expect(text).not.toMatch(/\]\(/u);
    expect(text).not.toMatch(/<!--|<b>|<\/b>/u);
    expect(text).not.toMatch(/(?<!‍)@octocat|(?<!‍)@evil/u);
    expect(text).not.toMatch(/!\[/u);
    expect(text).not.toMatch(/https?:\/\/(?!‍)/u);
    expect(text).not.toMatch(/#(?=\d)/u);
    expect(text).not.toMatch(/Fixes ENG-9/u);
  });

  it("list the same blocking findings the opinion blocked on: one the owner accepted as a risk is not listed (and with all accepted there are no lines)", () => {
    const two = opinion("on", report("FINDINGS", [BLOCKING, { text: "second problem", origin: "INTRODUCED" }]));
    const accepted = [{ candidateDigest: digest, role: "CRITIC", fingerprint: workflowFindingFingerprint("CRITIC", { text: BLOCKING.text }) }];
    const text = secondOpinionPrLines(two, accepted).join("\n");
    expect(text).toContain("1 blocking finding");
    expect(text).toContain("second problem");
    expect(text).not.toContain(BLOCKING.text);
    const both = [...accepted, { candidateDigest: digest, role: "CRITIC", fingerprint: workflowFindingFingerprint("CRITIC", { text: "second problem" }) }];
    expect(secondOpinionPrLines(two, both)).toEqual([]);
  });

  it("are bounded: at most five findings, each cut", () => {
    const many = Array.from({ length: 12 }, (_, n) => ({ text: `finding ${String(n)} ${"x".repeat(1000)}`.slice(0, 600), origin: "INTRODUCED" as const }));
    const lines = secondOpinionPrLines(opinion("on", report("FINDINGS", many)));
    expect(lines).toHaveLength(6);
    expect(lines[0]).toContain("12 blocking findings");
    for (const line of lines.slice(1)) expect(Array.from(line).length).toBeLessThanOrEqual(480);
  });
});

describe("cost and admission", () => {
  it("estimates from the catalog price with no caching", () => {
    expect(estimateSecondReviewUsd({ inputUsdPerMTok: 0.8, outputUsdPerMTok: 3.2 }, { input: 100_000, maxOutput: 4_000 })).toBeCloseTo(0.0928, 6);
  });

  it("admits when the estimate fits the payer's room, once per candidate per round", () => {
    expect(admitSecondReview({ mode: "shadow", estimateUsd: 0.09, roomUsd: 0.1, alreadyRan: false })).toEqual({ admit: true });
    expect(admitSecondReview({ mode: "shadow", estimateUsd: 0.09, roomUsd: 0.09, alreadyRan: false })).toEqual({ admit: true });
    expect(admitSecondReview({ mode: "shadow", estimateUsd: 0.1, roomUsd: 0.09, alreadyRan: false })).toEqual({ admit: false, reason: "budget" });
    expect(admitSecondReview({ mode: "on", estimateUsd: 0.1, roomUsd: 0.09, alreadyRan: false })).toEqual({ admit: false, reason: "budget" });
    expect(admitSecondReview({ mode: "shadow", estimateUsd: 0.01, roomUsd: 5, alreadyRan: true })).toEqual({ admit: false, reason: "not-run" });
  });

  it("fails closed on a number it cannot read", () => {
    expect(admitSecondReview({ mode: "shadow", estimateUsd: Number.NaN, roomUsd: 5, alreadyRan: false })).toEqual({ admit: false, reason: "budget" });
    expect(admitSecondReview({ mode: "shadow", estimateUsd: 0.01, roomUsd: Number.NaN, alreadyRan: false })).toEqual({ admit: false, reason: "budget" });
  });

  it("knows a second review already ran for a candidate in a round, by its tag", () => {
    const ops = [{ secondReview: true, candidateDigest: digest, round: 1 }, { candidateDigest: digest, round: 2 }];
    expect(secondReviewAlreadyRan(ops, digest, 1)).toBe(true);
    expect(secondReviewAlreadyRan(ops, digest, 2)).toBe(false); // an untagged operation is the first review's
    expect(secondReviewAlreadyRan(ops, "e".repeat(64), 1)).toBe(false);
  });
});

const cases = (spec: { known: number; planted: number; both: number; baselineOnly: number; extra: number; neither?: number }): SecondReviewReplayCase[] => {
  const shapes: Array<[boolean, boolean, number]> = [[true, true, spec.both], [true, false, spec.baselineOnly], [false, true, spec.extra], [false, false, spec.neither ?? 0]];
  const out: SecondReviewReplayCase[] = [];
  for (const [baselineCaught, candidateCaught, count] of shapes) {
    for (let i = 0; i < count; i += 1) out.push({ caseId: `c${String(out.length + 1)}`, kind: "known_defect", baselineCaught, candidateCaught, candidateBlockingFindings: 0, candidateDismissedBlocking: 0 });
  }
  // The first `known` cases are past tasks with a known defect, the rest are planted-bug diffs.
  return out.map((entry, index) => ({ ...entry, kind: index < spec.known ? "known_defect" as const : "planted_bug" as const }));
};
const withDismissed = (list: SecondReviewReplayCase[], dismissed: number): SecondReviewReplayCase[] =>
  list.map((entry, index) => (index === 0 ? { ...entry, candidateBlockingFindings: dismissed, candidateDismissedBlocking: dismissed } : entry));

describe("the replay check (section 9.2)", () => {
  it("passes a run that meets every part of the bar, at the exact edges", () => {
    // 50 tasks: 30 known + 20 planted. Baseline catches 40; the candidate catches 32 of them (80%) and adds 5 (1 in 10).
    const list = cases({ known: 30, planted: 20, both: 32, baselineOnly: 8, extra: 5, neither: 5 });
    expect(list).toHaveLength(50);
    expect(summarizeSecondReviewReplay(list)).toMatchObject({ tasks: 50, knownDefects: 30, plantedBugs: 20, baselineCaught: 40, bothCaught: 32, extraCatches: 5, dismissedBlocking: 0, passed: true, failures: [] });
  });

  it("fails just under each edge, naming the part", () => {
    expect(summarizeSecondReviewReplay(cases({ known: 30, planted: 20, both: 31, baselineOnly: 9, extra: 5, neither: 5 })).failures).toEqual(["catch-share-low"]);
    expect(summarizeSecondReviewReplay(cases({ known: 30, planted: 20, both: 32, baselineOnly: 8, extra: 4, neither: 6 })).failures).toEqual(["few-extra-catches"]);
    // Dismissed blocking findings must stay UNDER one per 5 tasks: 10 over 50 tasks is one per 5, which fails; 9 passes.
    const base = cases({ known: 30, planted: 20, both: 32, baselineOnly: 8, extra: 5, neither: 5 });
    expect(summarizeSecondReviewReplay(withDismissed(base, 10)).failures).toEqual(["too-many-dismissed"]);
    expect(summarizeSecondReviewReplay(withDismissed(base, 9)).passed).toBe(true);
  });

  it("a set that is too small does not pass, however well it did", () => {
    expect(summarizeSecondReviewReplay(cases({ known: 29, planted: 20, both: 32, baselineOnly: 8, extra: 5, neither: 4 })).failures).toEqual(["too-few-known-defects"]);
    expect(summarizeSecondReviewReplay(cases({ known: 30, planted: 19, both: 32, baselineOnly: 8, extra: 5, neither: 4 })).failures).toEqual(["too-few-planted-bugs"]);
    const empty = summarizeSecondReviewReplay([]);
    expect(empty.passed).toBe(false);
    expect(empty.failures).toEqual(["too-few-known-defects", "too-few-planted-bugs", "baseline-caught-nothing", "few-extra-catches"]);
  });

  it("a baseline that caught nothing gives no share to compare with, so it fails", () => {
    expect(summarizeSecondReviewReplay(cases({ known: 30, planted: 20, both: 0, baselineOnly: 0, extra: 50 })).failures).toContain("baseline-caught-nothing");
  });

  it("reads a run's fields strictly: counts and flags only, no repeated case, dismissed within blocking", () => {
    const entry: SecondReviewReplayCase = { caseId: "t-1", kind: "known_defect", baselineCaught: true, candidateCaught: true, candidateBlockingFindings: 2, candidateDismissedBlocking: 1 };
    const run = { runId: "r-1", ranAt: "2026-11-20T00:00:00.000Z", candidate: { provider: "amazon-bedrock", modelId: "amazon.nova-premier-v1:0" }, baseline: { provider: "anthropic", modelId: "claude-opus-4-6" }, cases: [entry] };
    expect(SecondReviewReplayRunSchema.safeParse(run).success).toBe(true);
    expect(SecondReviewReplayRunSchema.safeParse({ ...run, cases: [entry, entry] }).success).toBe(false);
    expect(SecondReviewReplayRunSchema.safeParse({ ...run, cases: [{ ...entry, candidateDismissedBlocking: 3 }] }).success).toBe(false);
    expect(SecondReviewReplayRunSchema.safeParse({ ...run, cases: [{ ...entry, text: "model output" }] }).success).toBe(false);
  });

  it("the shadow phase needs two weeks, at least 10 counted reviews, and more than 30% of findings agreed with or fixed", () => {
    expect(secondReviewShadowPassed({ days: 14, reviews: 10, findings: 10, agreed: 4 })).toBe(true);
    expect(secondReviewShadowPassed({ days: 14, reviews: 10, findings: 10, agreed: 3 })).toBe(false); // exactly 30% is not above 30%
    expect(secondReviewShadowPassed({ days: 13, reviews: 10, findings: 10, agreed: 10 })).toBe(false);
    expect(secondReviewShadowPassed({ days: 30, reviews: 10, findings: 0, agreed: 0 })).toBe(false);
    expect(secondReviewShadowPassed({ days: 14, reviews: 9, findings: 10, agreed: 10 })).toBe(false);
    // A count that was never recorded is none.
    expect(secondReviewShadowPassed({ days: 14, findings: 10, agreed: 10 })).toBe(false);
    expect(SECOND_REVIEW_BAR.shadowMinReviews).toBe(10);
    expect(SECOND_REVIEW_BAR.shadowDays).toBe(14);
  });
});

describe("How we work: the second opinion row", () => {
  const mark = <T,>(value: T, locked = false) => ({ value, source: "company" as const, locked, ...(locked ? { lockedBy: "company" as const } : {}) });
  const stage = (who: Record<string, unknown>) => ({
    id: "review", name: "Review", kind: "review", who: { model: mark(null), thinking: mark(null), differentCompanyFrom: mark([]), ...who },
    knows: { instructions: [] }, may: { tools: mark(null), readOnly: true }, checked: { items: [] }, evidence: { items: [] }, approves: { items: [] },
  });

  it("is optional, so a view without it (switch off, or an older broker) still reads", () => {
    expect(HowWeWorkStageSchema.safeParse(stage({})).success).toBe(true);
  });

  it("takes exactly the three modes, with a company lock marked as locked", () => {
    for (const mode of SECOND_REVIEW_MODES) expect(HowWeWorkStageSchema.safeParse(stage({ secondOpinion: mark(mode, true) })).success, mode).toBe(true);
    expect(HowWeWorkStageSchema.safeParse(stage({ secondOpinion: mark("maybe") })).success).toBe(false);
    expect(HowWeWorkStageSchema.safeParse(stage({ secondOpinion: { value: "on", source: "company", locked: true } })).success).toBe(false);
  });
});

describe("the acknowledgement seam (an on review that did not run waits for the owner)", () => {
  const flagged = secondOpinionUnavailable({ mode: "on", company: "openai" }, "no-answer");
  it("never blocks the review itself, but the merge waits for the owner's acknowledgement of that candidate and reason", () => {
    expect(secondReviewBlocksWhenUnavailable({ mode: "on", reason: "no-answer" })).toBe(false);
    const ack = secondReviewAcknowledgement(flagged, digest);
    if (!ack.required) throw new Error("expected an ask");
    expect(ack.text).toBe("Second review did not run: the reviewer gave no usable answer after retrying. Acknowledge before merging.");
    expect(mergeWaitsForSecondReview(flagged, digest, [])).toBe(true);
    expect(mergeWaitsForSecondReview(flagged, digest, [ack.key])).toBe(false);
    expect(mergeWaitsForSecondReview(flagged, "d".repeat(64), [ack.key])).toBe(true);
    expect(mergeWaitsForSecondReview(secondOpinionUnavailable({ mode: "shadow", company: "openai" }, "no-answer"), digest, [])).toBe(false);
    expect(mergeWaitsForSecondReview(undefined, digest, [])).toBe(false);
  });
});
