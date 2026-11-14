// Revise the plan with a live change: the pure workflow move. Coding stopped for the owner's live message (a change outside the approved plan); the owner (and only the owner) sends the work back to
// PLANNING with that change, which the existing plan approval then decides. Nothing here can approve anything, and no message text is in the workflow.
import { describe, expect, it } from "vitest";
import { WORKFLOW_BLOCK_REASONS } from "../../packages/contracts/src/task-workflow.js";
import { WorkflowSnapshotSchema, createWorkflowSnapshot, WorkflowTransitionError, type WorkflowSnapshot } from "../../packages/contracts/src/task-workflow-node.js";
import { liveSteerCodingBlockReason, revisePlanWithLiveChange, workflowReviseOffered, workflowRedirectReviseOffered, WORKFLOW_CODING_STOPPED_REASONS, WORKFLOW_REVISE_PLAN_DECISION_REASON } from "../../packages/contracts/src/task-workflow-revise.js";
import { WORKFLOW_REDIRECT_PLAN_DECISION_REASON } from "../../packages/contracts/src/live-interaction.js";

const taskId = "11111111-1111-4111-8111-111111111111";
const owner = "a".repeat(64);
const stranger = "b".repeat(64);
const now = "2026-10-30T12:00:00.000Z";
const later = "2026-10-30T12:05:00.000Z";
const requestId = "22222222-2222-4222-8222-222222222222";
const REASON = WORKFLOW_BLOCK_REASONS.liveSteerReapprovalRevise;
const plan = { id: "plan-v1", type: "plan", version: 1, sha256: "c".repeat(64), producer: "p", objectKey: "private/o/w/op/plan.md", createdAt: now };

/** A coding step that stopped for the owner's live message, as the broker stores it. */
const blocked = (extra: Record<string, unknown> = {}, reason: string = REASON): WorkflowSnapshot => WorkflowSnapshotSchema.parse({
  ...createWorkflowSnapshot({ taskId, ownerId: owner, now, definitionVersion: "1.1.0", understand: true, pathFrom: "understand" }),
  revision: 9, stage: "IMPLEMENT", state: "BLOCKED", blockReason: reason, outcome: "PASSED", artifacts: [plan],
  decisions: [{ requestId: "33333333-3333-4333-8333-333333333333", workflowRevision: 5, decision: "APPROVE", actorId: owner, actorRole: "TASK_OWNER", reason: "Approved", artifactDigest: plan.sha256, at: now }],
  ...extra,
});

describe("the move from a blocked coding step back to planning", () => {
  it("is offered only for a coding step blocked with the revise reason, with nothing open that a new plan would strand", () => {
    expect(workflowReviseOffered(blocked())).toBe(true);
    // The round-2 reason (a shape that cannot revise) and every other block offer nothing.
    expect(workflowReviseOffered(blocked({}, WORKFLOW_BLOCK_REASONS.liveSteerReapprovalCoding))).toBe(false);
    expect(workflowReviseOffered(blocked({}, "Coding stopped"))).toBe(false);
    expect(workflowReviseOffered(blocked({ state: "RUNNING", blockReason: undefined }))).toBe(false);
    expect(workflowReviseOffered(blocked({ stage: "VERIFY" }))).toBe(false);
    expect(workflowReviseOffered(blocked({ fixSource: "ci" }))).toBe(false);
    expect(workflowReviseOffered(blocked({ pullRequests: [{ repositoryId: "demo", number: 1, url: "https://github.com/example/demo/pull/1", state: "OPEN", required: true, candidateDigest: "d".repeat(64), headSha: "e".repeat(40), observedAt: now }] }))).toBe(false);
  });

  it("goes to planning, ready, with the owner's request recorded as a request for changes to the approved plan and no message text anywhere", () => {
    const current = blocked();
    const next = revisePlanWithLiveChange(current, { requestId, actorId: owner, now: later }, undefined);
    expect(next).toMatchObject({ stage: "PLAN", state: "READY", revision: 10, updatedAt: later, outcome: "CHANGES_REQUESTED" });
    expect(next.blockReason).toBeUndefined();
    expect(next.decisions).toHaveLength(2);
    expect(next.decisions.at(-1)).toMatchObject({ requestId, workflowRevision: 9, decision: "REQUEST_CHANGES", actorId: owner, actorRole: "TASK_OWNER", artifactDigest: plan.sha256, reason: WORKFLOW_REVISE_PLAN_DECISION_REASON, at: later });
    // The old enums are untouched: the decision is the ordinary gate kind (no source), so an old client reads it as it reads any request for changes.
    expect(next.decisions.at(-1)!.source).toBeUndefined();
    expect(next.artifacts).toEqual(current.artifacts);
    expect(WorkflowSnapshotSchema.safeParse(next).success).toBe(true);
  });

  it("drops what belongs to the plan it replaces (the plan's check, its browser and API state, the ordered work approval) and keeps the code's history", () => {
    const current = blocked({
      critique: { status: "done", critiques: [], revisions: 0 },
      e2e: { contractDigest: "1".repeat(64), policyDigest: "2".repeat(64), bundleDigest: "3".repeat(64), executionPlanDigest: "4".repeat(64), required: true, currentGroupRunIds: [], resultRefs: [] },
      workflowDependenciesApproval: { artifactDigest: plan.sha256, graphDigest: "5".repeat(64), workflowRevision: 5, actorId: owner, runId: "44444444-4444-4444-8444-444444444444" }, workflowDependenciesProgress: [],
      decisions: [{ requestId: "33333333-3333-4333-8333-333333333333", workflowRevision: 5, decision: "APPROVE", actorId: owner, actorRole: "TASK_OWNER", reason: "Approved", artifactDigest: plan.sha256, workBreakdownDigest: "5".repeat(64), at: now }],
    });
    const next = revisePlanWithLiveChange(current, { requestId, actorId: owner, now: later }, undefined);
    expect(next.critique).toBeUndefined();
    expect(next.e2e).toBeUndefined();
    expect(next.workflowDependenciesApproval).toBeUndefined();
    expect(next.workflowDependenciesProgress).toBeUndefined();
  });

  it("is the task owner's alone, and an owner is whoever the People list names", () => {
    expect(() => revisePlanWithLiveChange(blocked(), { requestId, actorId: stranger, now: later }, undefined)).toThrow(WorkflowTransitionError);
    expect(() => revisePlanWithLiveChange(blocked(), { requestId, actorId: stranger, now: later }, undefined)).toThrow(/only the task owner/u);
    // With the People list's authority: the owners listed decide, the creator no longer does by being the creator.
    expect(() => revisePlanWithLiveChange(blocked(), { requestId, actorId: owner, now: later }, { actorId: owner, ownerIds: [stranger] })).toThrow(/only the task owner/u);
    expect(revisePlanWithLiveChange(blocked(), { requestId, actorId: stranger, now: later }, { actorId: stranger, ownerIds: [stranger] })).toMatchObject({ stage: "PLAN", state: "READY" });
  });

  it("refuses a work state that is not offered, a request id used before, and a full history, writing nothing", () => {
    expect(() => revisePlanWithLiveChange(blocked({}, "Coding stopped"), { requestId, actorId: owner, now: later }, undefined)).toThrow(WorkflowTransitionError);
    const used = blocked();
    expect(() => revisePlanWithLiveChange(used, { requestId: used.decisions[0]!.requestId, actorId: owner, now: later }, undefined)).toThrow(/already used/u);
    const full = blocked({ decisions: Array.from({ length: 100 }, (_, index) => ({ requestId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, workflowRevision: 5, decision: "APPROVE", actorId: owner, actorRole: "TASK_OWNER", reason: "Approved", at: now })) });
    expect(() => revisePlanWithLiveChange(full, { requestId, actorId: owner, now: later }, undefined)).toThrow(/history is full/u);
  });
});

describe("which block reason coding stops with", () => {
  it("is the revise reason when the plan can take the change in, and the round-2 reason (Retry coding or a new task) for a shape it cannot", () => {
    expect(liveSteerCodingBlockReason(blocked({ stage: "IMPLEMENT", state: "RUNNING", blockReason: undefined }))).toBe(WORKFLOW_BLOCK_REASONS.liveSteerReapprovalRevise);
    expect(liveSteerCodingBlockReason(blocked({ fixSource: "ci" }))).toBe(WORKFLOW_BLOCK_REASONS.liveSteerReapprovalCoding);
    expect(liveSteerCodingBlockReason(blocked({ artifacts: [] }))).toBe(WORKFLOW_BLOCK_REASONS.liveSteerReapprovalCoding);
  });

  it("each reason names only what its card offers", () => {
    expect(REASON).toMatch(/Revise the plan/u);
    expect(REASON).toMatch(/approve the revised plan/u);
    expect(REASON).toMatch(/Retry coding/u);
    expect(WORKFLOW_BLOCK_REASONS.liveSteerReapprovalCoding).not.toMatch(/Revise the plan/u);
  });
});

// ---- Stop & redirect "this changes the plan": the same move, from a coding step the owner's stop blocked (R3)

describe("the move widened for Stop & redirect", () => {
  const STOPPED = WORKFLOW_CODING_STOPPED_REASONS[0]!;

  it("accepts coding blocked by its stop (cancelled or interrupted) when the redirect asks for it, and not otherwise", () => {
    expect(WORKFLOW_CODING_STOPPED_REASONS).toEqual(["implementation operation ended cancelled", "implementation operation ended interrupted"]);
    for (const reason of WORKFLOW_CODING_STOPPED_REASONS) {
      expect(workflowRedirectReviseOffered(blocked({}, reason))).toBe(true);
      expect(workflowReviseOffered(blocked({}, reason)), "the live-steer gate is unchanged").toBe(false);
    }
    // A failed run, a budget pause and the re-approval stops are not the owner's stop.
    for (const reason of ["implementation operation ended failed", WORKFLOW_BLOCK_REASONS.budgetPaused, WORKFLOW_BLOCK_REASONS.liveSteerReapprovalCoding]) expect(workflowRedirectReviseOffered(blocked({}, reason)), reason).toBe(false);
    // The plan must be able to take the change in (no pull request open, no fix round, no custom sequence).
    expect(workflowRedirectReviseOffered(blocked({ fixSource: "ci" }, STOPPED))).toBe(false);
    expect(workflowRedirectReviseOffered(blocked({ stage: "VERIFY" }, STOPPED))).toBe(false);
    expect(workflowRedirectReviseOffered(blocked({ state: "RUNNING", blockReason: undefined }, STOPPED))).toBe(false);
  });

  it("goes to planning with a fixed-words request for changes (never the instruction), only for the owner, and only with the redirect flag", () => {
    const current = blocked({}, STOPPED);
    const next = revisePlanWithLiveChange(current, { requestId, actorId: owner, now: later, redirect: true }, undefined);
    expect(next).toMatchObject({ stage: "PLAN", state: "READY", revision: 10, outcome: "CHANGES_REQUESTED" });
    expect(next.decisions.at(-1)).toMatchObject({ requestId, decision: "REQUEST_CHANGES", actorId: owner, actorRole: "TASK_OWNER", reason: WORKFLOW_REDIRECT_PLAN_DECISION_REASON });
    expect(next.blockReason).toBeUndefined();
    // Without the flag the live-steer rule still holds: a stop that is not the re-approval stop is refused.
    expect(() => revisePlanWithLiveChange(current, { requestId, actorId: owner, now: later }, undefined)).toThrow(WorkflowTransitionError);
    // Anyone but the owner is refused, flag or not.
    expect(() => revisePlanWithLiveChange(current, { requestId, actorId: stranger, now: later, redirect: true }, undefined)).toThrow("only the task owner");
    // The flag does not open the re-approval stop to the other reason's checks, and a repeated request id is refused.
    expect(() => revisePlanWithLiveChange(next as never, { requestId, actorId: owner, now: later, redirect: true }, undefined)).toThrow(WorkflowTransitionError);
    expect(() => revisePlanWithLiveChange(blocked({ decisions: [{ requestId, workflowRevision: 5, decision: "APPROVE", actorId: owner, actorRole: "TASK_OWNER", reason: "Approved", artifactDigest: plan.sha256, at: now }] }, STOPPED), { requestId, actorId: owner, now: later, redirect: true }, undefined)).toThrow("already used");
  });
});
