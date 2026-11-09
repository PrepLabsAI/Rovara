// Wire lane D (MD-1): "Re-plan" on a changed spec sends the work back to planning. The pure workflow move; the owner's approval of the revised plan is what lets anything be built again.
import { describe, expect, it } from "vitest";
import { WorkflowSnapshotSchema, createWorkflowSnapshot, WorkflowTransitionError, type WorkflowSnapshot } from "../../packages/contracts/src/task-workflow-node.js";
import { WORKFLOW_SPEC_REPLAN_DECISION_REASON, replanForChangedSpec, workflowSpecReplanOffered } from "../../packages/contracts/src/task-workflow-revise.js";

const taskId = "11111111-1111-4111-8111-111111111111";
const owner = "a".repeat(64);
const stranger = "b".repeat(64);
const now = "2026-10-31T12:00:00.000Z";
const later = "2026-10-31T12:05:00.000Z";
const requestId = "22222222-2222-4222-8222-222222222222";
const plan = { id: "plan-v1", type: "plan", version: 1, sha256: "c".repeat(64), producer: "p", objectKey: "private/o/w/op/plan.md", createdAt: now };

const waiting = (extra: Record<string, unknown> = {}): WorkflowSnapshot => WorkflowSnapshotSchema.parse({
  ...createWorkflowSnapshot({ taskId, ownerId: owner, now, definitionVersion: "1.1.0", understand: true, pathFrom: "understand" }),
  revision: 9, stage: "REVIEW", state: "WAITING", outcome: "PASSED", artifacts: [plan],
  decisions: [{ requestId: "33333333-3333-4333-8333-333333333333", workflowRevision: 5, decision: "APPROVE", actorId: owner, actorRole: "TASK_OWNER", reason: "Approved", artifactDigest: plan.sha256, at: now }],
  ...extra,
});

describe("re-planning for a changed spec", () => {
  it("is offered while the code waits at review or at its pull requests, and in no other place", () => {
    expect(workflowSpecReplanOffered(waiting())).toBe(true);
    expect(workflowSpecReplanOffered({ ...waiting(), stage: "PULL_REQUEST", state: "READY" })).toBe(true);
    for (const extra of [{ state: "RUNNING" }, { stage: "IMPLEMENT", state: "RUNNING" }, { stage: "PLAN", state: "READY" }, { stage: "WAIT_FOR_MERGE", state: "WAITING" }, { fixSource: "ci" }]) {
      expect(workflowSpecReplanOffered({ ...waiting(), ...extra } as WorkflowSnapshot), JSON.stringify(extra)).toBe(false);
    }
  });

  it("goes to planning, ready, as the owner's request for changes to the approved plan, with fixed words and no spec text", () => {
    const next = replanForChangedSpec(waiting(), { requestId, actorId: owner, now: later }, undefined);
    expect(next).toMatchObject({ stage: "PLAN", state: "READY", revision: 10, updatedAt: later, outcome: "CHANGES_REQUESTED" });
    expect(next.decisions.at(-1)).toMatchObject({ requestId, workflowRevision: 9, decision: "REQUEST_CHANGES", actorId: owner, actorRole: "TASK_OWNER", artifactDigest: plan.sha256, reason: WORKFLOW_SPEC_REPLAN_DECISION_REASON });
    expect(WorkflowSnapshotSchema.safeParse(next).success).toBe(true);
  });

  it("is the owner's alone (or the People list's), uses a request id once, and refuses when it is not offered", () => {
    expect(() => replanForChangedSpec(waiting(), { requestId, actorId: stranger, now: later }, undefined)).toThrow(/only the task owner/u);
    expect(replanForChangedSpec(waiting(), { requestId, actorId: stranger, now: later }, { actorId: stranger, ownerIds: [stranger] })).toMatchObject({ stage: "PLAN" });
    const again = replanForChangedSpec(waiting(), { requestId, actorId: owner, now: later }, undefined);
    expect(() => replanForChangedSpec({ ...again, stage: "REVIEW", state: "WAITING" }, { requestId, actorId: owner, now: later }, undefined)).toThrow(WorkflowTransitionError);
    expect(() => replanForChangedSpec({ ...waiting(), state: "RUNNING" }, { requestId, actorId: owner, now: later }, undefined)).toThrow(/not waiting on a changed spec/u);
  });
});
