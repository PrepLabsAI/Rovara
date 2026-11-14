import { describe, expect, it } from "vitest";
import {
  FINDING_SCALES, FLOW_CATCH_COUNTERS_MAX, FLOW_MAX_BYTES, FLOW_QUICK_CHECKS_MAX, FLOW_REASON_CODE_MAX, FLOW_REASON_PATH_MAX, FLOW_TIER_HISTORY_MAX, FLOW_TIER_REASONS_MAX,
  DesignFindingSchema, PlanCritiqueSchema, WorkflowFlowSchema, WorkflowReviewFindingSchema, WorkflowReviewReportSchema, WorkflowSecondReviewBlockSchema,
  WorkflowSnapshotSchema, WorkflowSnapshotShapeSchema, WorkflowDesignReviewSchema, createWorkflowSnapshot, flowRecordBytes,
} from "../../packages/contracts/src/index.js";
import { WorkflowSnapshotReaderSchema } from "../../packages/contracts/src/task-workflow.js";

const at = "2026-11-13T10:00:00.000Z";
const taskId = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const ownerId = "a".repeat(64);
const sha = "c".repeat(40);
const digest = "b".repeat(64);

const tier = {
  level: "small", kinds: ["docs", "ci_file"], source: "estimate", reasons: [{ code: "docs_only", path: "docs/readme.md" }, { code: "no_code" }], headSha: sha, mergeBase: sha, at,
} as const;
const fullFlow = {
  rulesVersion: 1,
  tier,
  tierHistory: [{ ...tier, level: "small", source: "estimate" }, { ...tier, level: "standard", source: "diff" }],
  skippedSteps: ["plan_check", "design_review", "requirements_approval", "design_approval", "plan_approval"],
  quickChecks: [{ kind: "docs", outcome: "passed", detail: "links ok", at }, { kind: "ci_file", outcome: "not_run", at }],
  grewAfterBuild: { from: "small", to: "standard", at },
  reviewDoubt: { open: 0 },
  moments: { used: 2, budget: 5 },
  catchCounters: [{ step: "code_review", findings: 3, mustFix: 1, changedCode: 1 }],
};

// A design review as the writer stores it today (the same shape tests/contract/design-review-contracts.test.ts parses).
const run = {
  role: "critic", promptId: "design-critic", promptVersion: 1, promptDigest: digest, model: { provider: "anthropic", modelId: "claude-opus-5-5" }, sourceId: "src_1",
  sessionId: "ses_1", modelKeyId: "key_1", packetDigest: digest,
  packet: [{ kind: "design", ref: "design.md", commitOrFetchedAt: sha, digest, bytes: 1200 }],
  filesRead: ["packages/a.ts"], verified: true, inputProof: "proxy_first_call", tokensIn: 1000, tokensOut: 200, costUsd: 0.01, startedAt: "2026-11-03T10:00:00Z", endedAt: "2026-11-03T10:01:00Z",
};
const designFinding = { id: "f1", severity: "major", section: "§3", text: "Retries are not bounded.", citations: [{ kind: "design", section: "§3" }], fromReviewers: ["critic"], rawIds: ["critic-1"], fingerprint: digest };
const designReview = { decidedBy: "auto", reasons: ["new_api"], status: "done", tier: "standard", spentUsd: 0.4, rounds: [{ round: 1, designDigest: digest, reviewers: [run], findings: [designFinding], resolutions: [] }] };

// Rows as today's writer stores them, made by the real writer.
const quickRow = () => JSON.parse(JSON.stringify(createWorkflowSnapshot({ taskId, ownerId, now: at, path: "QUICK" }))) as Record<string, unknown>;
const quick11Row = () => JSON.parse(JSON.stringify(createWorkflowSnapshot({ taskId, ownerId, now: at, path: "QUICK", definitionVersion: "1.1.0" }))) as Record<string, unknown>;
const fullRow = () => JSON.parse(JSON.stringify(createWorkflowSnapshot({ taskId, ownerId, now: at, path: "FULL", definitionVersion: "1.1.0" }))) as Record<string, unknown>;

describe("the lighter flow record (readers only)", () => {
  it("parses every field of the shape", () => {
    const parsed = WorkflowFlowSchema.parse(fullFlow);
    expect(parsed).toEqual(fullFlow);
    expect(WorkflowFlowSchema.parse({ rulesVersion: 0 })).toEqual({ rulesVersion: 0 });
  });

  it("needs rulesVersion and refuses an unknown key at every level", () => {
    expect(WorkflowFlowSchema.safeParse({}).success).toBe(false);
    expect(WorkflowFlowSchema.safeParse({ rulesVersion: 1.5 }).success).toBe(false);
    expect(WorkflowFlowSchema.safeParse({ rulesVersion: 1, extra: 1 }).success).toBe(false);
    expect(WorkflowFlowSchema.safeParse({ rulesVersion: 1, tier: { ...tier, extra: 1 } }).success).toBe(false);
    expect(WorkflowFlowSchema.safeParse({ rulesVersion: 1, tier: { ...tier, reasons: [{ code: "a", extra: 1 }] } }).success).toBe(false);
    expect(WorkflowFlowSchema.safeParse({ rulesVersion: 1, quickChecks: [{ kind: "docs", outcome: "passed", at, extra: 1 }] }).success).toBe(false);
    expect(WorkflowFlowSchema.safeParse({ rulesVersion: 1, grewAfterBuild: { from: "small", to: "risky", at, extra: 1 } }).success).toBe(false);
    expect(WorkflowFlowSchema.safeParse({ rulesVersion: 1, reviewDoubt: { open: 1, extra: 1 } }).success).toBe(false);
    expect(WorkflowFlowSchema.safeParse({ rulesVersion: 1, moments: { used: 1, budget: 1, extra: 1 } }).success).toBe(false);
    expect(WorkflowFlowSchema.safeParse({ rulesVersion: 1, catchCounters: [{ step: "a", findings: 0, mustFix: 0, changedCode: 0, extra: 1 }] }).success).toBe(false);
  });

  it("enforces the tier limits: one over fails, at the limit passes", () => {
    const withTier = (t: Record<string, unknown>) => WorkflowFlowSchema.safeParse({ rulesVersion: 1, tier: { ...tier, ...t } }).success;
    expect(withTier({ level: "huge" })).toBe(false);
    expect(withTier({ source: "guess" })).toBe(false);
    expect(withTier({ kinds: ["docs", "code_config", "dependency", "install_link", "ci_file"] })).toBe(true);
    expect(withTier({ kinds: ["docs", "code_config", "dependency", "install_link", "ci_file", "docs"] })).toBe(false);
    expect(withTier({ kinds: ["docs", "docs"] })).toBe(false);
    expect(withTier({ kinds: ["other"] })).toBe(false);
    expect(FLOW_TIER_REASONS_MAX).toBe(50);
    expect(withTier({ reasons: Array.from({ length: 50 }, () => ({ code: "x" })) })).toBe(true);
    expect(withTier({ reasons: Array.from({ length: 51 }, () => ({ code: "x" })) })).toBe(false);
    expect(withTier({ reasons: [{ code: "a".repeat(FLOW_REASON_CODE_MAX) }] })).toBe(true);
    expect(withTier({ reasons: [{ code: "a".repeat(FLOW_REASON_CODE_MAX + 1) }] })).toBe(false);
    expect(withTier({ reasons: [{ code: "Upper" }] })).toBe(false);
    expect(withTier({ reasons: [{ code: "has-dash" }] })).toBe(false);
    expect(withTier({ reasons: [{ code: "" }] })).toBe(false);
    expect(withTier({ reasons: [{ code: "a", path: "p".repeat(FLOW_REASON_PATH_MAX) }] })).toBe(true);
    expect(withTier({ reasons: [{ code: "a", path: "p".repeat(FLOW_REASON_PATH_MAX + 1) }] })).toBe(false);
    expect(withTier({ headSha: "c".repeat(39) })).toBe(false);
    expect(withTier({ headSha: "C".repeat(40) })).toBe(false);
    expect(withTier({ mergeBase: "g".repeat(40) })).toBe(false);
    expect(withTier({ at: "yesterday" })).toBe(false);
  });

  it("enforces the history, skipped step, quick check and counter limits", () => {
    const small = { ...tier, reasons: [] };
    const flowWith = (extra: Record<string, unknown>) => WorkflowFlowSchema.safeParse({ rulesVersion: 1, ...extra }).success;
    expect(flowWith({ tierHistory: Array.from({ length: FLOW_TIER_HISTORY_MAX }, () => small) })).toBe(true);
    expect(flowWith({ tierHistory: Array.from({ length: FLOW_TIER_HISTORY_MAX + 1 }, () => small) })).toBe(false);
    expect(flowWith({ skippedSteps: ["plan_check", "plan_check"] })).toBe(false);
    expect(flowWith({ skippedSteps: ["code_review"] })).toBe(false);
    expect(flowWith({ skippedSteps: [] })).toBe(true);
    const check = { kind: "docs", outcome: "passed", at };
    expect(flowWith({ quickChecks: Array.from({ length: FLOW_QUICK_CHECKS_MAX }, () => check) })).toBe(true);
    expect(flowWith({ quickChecks: Array.from({ length: FLOW_QUICK_CHECKS_MAX + 1 }, () => check) })).toBe(false);
    expect(flowWith({ quickChecks: [{ ...check, outcome: "skipped" }] })).toBe(false);
    expect(flowWith({ quickChecks: [{ ...check, detail: "d".repeat(500) }] })).toBe(true);
    expect(flowWith({ quickChecks: [{ ...check, detail: "d".repeat(501) }] })).toBe(false);
    const counter = { step: "s", findings: 0, mustFix: 0, changedCode: 0 };
    expect(flowWith({ catchCounters: Array.from({ length: FLOW_CATCH_COUNTERS_MAX }, () => counter) })).toBe(true);
    expect(flowWith({ catchCounters: Array.from({ length: FLOW_CATCH_COUNTERS_MAX + 1 }, () => counter) })).toBe(false);
    expect(flowWith({ catchCounters: [{ ...counter, step: "s".repeat(40) }] })).toBe(true);
    expect(flowWith({ catchCounters: [{ ...counter, step: "s".repeat(41) }] })).toBe(false);
    expect(flowWith({ catchCounters: [{ ...counter, mustFix: -1 }] })).toBe(false);
    expect(flowWith({ catchCounters: [{ ...counter, findings: 1.5 }] })).toBe(false);
    expect(flowWith({ reviewDoubt: { open: -1 } })).toBe(false);
    expect(flowWith({ moments: { used: 0, budget: 0 } })).toBe(true);
    expect(flowWith({ moments: { used: -1, budget: 0 } })).toBe(false);
    expect(flowWith({ grewAfterBuild: { from: "small", to: "enormous", at } })).toBe(false);
  });

  it("keeps the whole record under 8 KB", () => {
    expect(FLOW_MAX_BYTES).toBe(8192);
    expect(flowRecordBytes(fullFlow)).toBeLessThan(FLOW_MAX_BYTES);
    const reasons = (n: number) => Array.from({ length: n }, (_, index) => ({ code: `r${String(index)}`, path: "x".repeat(150) }));
    const grow = (n: number) => ({ rulesVersion: 1, tier: { ...tier, reasons: reasons(n) } });
    let fits = 0;
    while (flowRecordBytes(grow(fits + 1)) <= FLOW_MAX_BYTES) fits += 1;
    expect(fits).toBeGreaterThan(5);
    expect(fits).toBeLessThan(FLOW_TIER_REASONS_MAX);
    expect(WorkflowFlowSchema.safeParse(grow(fits)).success).toBe(true);
    expect(WorkflowFlowSchema.safeParse(grow(fits + 1)).success).toBe(false);
    // The worst case the field limits alone allow is far over the cap: the cap is what bounds it.
    const worst = { rulesVersion: 1, tier: { ...tier, reasons: Array.from({ length: 50 }, () => ({ code: "c".repeat(64), path: "p".repeat(500) })) } };
    expect(WorkflowFlowSchema.safeParse(worst).success).toBe(false);
  });
});

describe("a workflow snapshot with a flow record", () => {
  it("reads every row today's writer stores, unchanged", () => {
    for (const row of [quickRow(), quick11Row(), fullRow()]) {
      expect(WorkflowSnapshotShapeSchema.parse(row)).toEqual(row);
      expect(WorkflowSnapshotSchema.parse(row)).toEqual(row);
      expect(WorkflowSnapshotReaderSchema.parse(row)).toMatchObject({ taskId });
    }
    expect(quickRow().definitionVersion).toBe("1.0.0");
  });

  it("reads a 1.1.0 Full row with a design review as before", () => {
    const row = { ...fullRow(), designReview };
    expect(WorkflowSnapshotShapeSchema.safeParse(row).success).toBe(true);
    expect(WorkflowSnapshotShapeSchema.safeParse({ ...fullRow(), designReview, flow: fullFlow }).success).toBe(true);
  });

  it("takes flow on 1.0.0 and on 1.1.0, Quick and Full", () => {
    for (const row of [quickRow(), quick11Row(), fullRow()]) {
      const parsed = WorkflowSnapshotShapeSchema.parse({ ...row, flow: fullFlow });
      expect(parsed.flow).toEqual(fullFlow);
      expect(WorkflowSnapshotSchema.safeParse({ ...row, flow: fullFlow }).success).toBe(true);
    }
    expect(WorkflowSnapshotShapeSchema.safeParse({ ...quickRow(), flow: { rulesVersion: 1, extra: true } }).success).toBe(false);
    expect(WorkflowSnapshotShapeSchema.safeParse({ ...quickRow(), flow: { ...fullFlow, rulesVersion: undefined } }).success).toBe(false);
    // A client reading with the tolerant reader sees it too.
    expect((WorkflowSnapshotReaderSchema.parse({ ...quickRow(), flow: fullFlow }) as { flow?: unknown }).flow).toEqual(fullFlow);
  });

  it("allows a design review on the Quick path only with a flow record", () => {
    expect(WorkflowSnapshotShapeSchema.safeParse({ ...quick11Row(), designReview }).success).toBe(false);
    expect(WorkflowSnapshotShapeSchema.safeParse({ ...quick11Row(), designReview, flow: { rulesVersion: 1 } }).success).toBe(true);
    // Cloud's Quick runs 1.0.0: the same rule holds there.
    expect(WorkflowSnapshotShapeSchema.safeParse({ ...quickRow(), designReview }).success).toBe(false);
    expect(WorkflowSnapshotShapeSchema.safeParse({ ...quickRow(), designReview, flow: { rulesVersion: 1 } }).success).toBe(true);
    // A 1.0.0 task with no flow record still cannot hold a design review, even on the Full path.
    const full10 = JSON.parse(JSON.stringify(createWorkflowSnapshot({ taskId, ownerId, now: at, path: "FULL" }))) as Record<string, unknown>;
    expect(full10.definitionVersion).toBe("1.0.0");
    expect(WorkflowSnapshotShapeSchema.safeParse({ ...full10, designReview }).success).toBe(false);
    expect(WorkflowSnapshotShapeSchema.safeParse({ ...full10, designReview, flow: { rulesVersion: 1 } }).success).toBe(true);
    // The other 1.1.0-only fields stay refused on 1.0.0, flow or not.
    expect(WorkflowSnapshotShapeSchema.safeParse({ ...quickRow(), risk: { level: "low", reasons: [], candidateDigest: digest }, flow: { rulesVersion: 1 } }).success).toBe(false);
  });
});

describe("the scale on review findings", () => {
  it("is optional on every finding shape and takes only the three words", () => {
    expect(FINDING_SCALES).toEqual(["must_fix", "should_fix", "note"]);
    const review = { text: "x", origin: "INTRODUCED", severity: "HIGH" };
    const secondReview = { candidateDigest: digest, findings: [{ text: "x" }] };
    const point = { verdict: "revise", points: [{ id: "p1", severity: "blocking", text: "x" }], model: { company: "anthropic", provider: "anthropic", modelId: "claude-opus-5-5" } };
    const critique = (scale?: string) => PlanCritiqueSchema.safeParse({ ...point, points: [{ ...point.points[0], ...(scale === undefined ? {} : { scale }) }] });
    for (const scale of FINDING_SCALES) {
      expect(WorkflowReviewFindingSchema.parse({ ...review, scale }).scale).toBe(scale);
      expect(WorkflowSecondReviewBlockSchema.parse({ ...secondReview, findings: [{ text: "x", scale }] }).findings[0]?.scale).toBe(scale);
      expect(DesignFindingSchema.parse({ ...designFinding, scale }).scale).toBe(scale);
      expect(WorkflowDesignReviewSchema.parse({ ...designReview, rounds: [{ ...designReview.rounds[0], findings: [{ ...designFinding, scale }] }] }).rounds[0]?.findings[0]?.scale).toBe(scale);
      expect(critique(scale).success, `plan critique ${scale}`).toBe(true);
    }
    expect(WorkflowReviewFindingSchema.parse(review)).toEqual(review);
    expect(WorkflowSecondReviewBlockSchema.parse(secondReview)).toEqual(secondReview);
    expect(DesignFindingSchema.parse(designFinding)).toEqual(designFinding);
    expect(critique().success).toBe(true);
    for (const bad of ["blocker", "MUST_FIX", ""]) {
      expect(WorkflowReviewFindingSchema.safeParse({ ...review, scale: bad }).success).toBe(false);
      expect(WorkflowSecondReviewBlockSchema.safeParse({ ...secondReview, findings: [{ text: "x", scale: bad }] }).success).toBe(false);
      expect(DesignFindingSchema.safeParse({ ...designFinding, scale: bad }).success).toBe(false);
      expect(critique(bad).success).toBe(false);
    }
  });

  it("reads inside a stored review report, and an old string finding still reads", () => {
    const report = { operationId: taskId, candidateDigest: digest, role: "CRITIC", provider: "p", version: "v", status: "FINDINGS", readOnly: true, recordedAt: at };
    const parsed = WorkflowReviewReportSchema.parse({ ...report, findings: [{ text: "x", origin: "INTRODUCED", scale: "must_fix" }, "an old plain string"] });
    expect(parsed.findings.map((finding) => finding.scale)).toEqual(["must_fix", undefined]);
  });
});
