import { describe, expect, it } from "vitest";
import { change, LIVE_STEER_REAPPROVAL_REASON, WORKFLOW_BLOCK_REASONS, WorkflowSnapshotSchema } from "@agentx/contracts";
import * as services from "../../packages/broker/src/services/index.js";
import { taskKey, workspaceKey, operationKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { fromDocument, toDocument, type WorkspaceRecord } from "../../packages/broker/src/core/task-flow/records.js";
import { readTask } from "../../packages/broker/src/core/task-flow/reads.js";
import { blockTaskWorkflow, planFeedbackKey } from "../../packages/broker/src/core/task-flow/stage-machine.js";
import { liveSteerChangeKey } from "../../packages/broker/src/core/sessions/live-steer-reapproval.js";
import { messageKey } from "../../packages/broker/src/core/sessions/steer.js";
import { COMPANY, createHarness, newRequestId } from "../support/task-flow-harness.js";

async function setup() {
  const h = createHarness({ understandFirst: true });
  await h.registerProject();
  const { task } = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Add a health endpoint", workflow: true });
  expect(services.createSessionActionsService).toBeTypeOf("function");
  return { h, task, actions: services.createSessionActionsService(h.deps) };
}

describe("host session actions over injected ports", () => {
  it("retries the blocked revision and refuses a stale retry without changing it", async () => {
    const { h, task, actions } = await setup();
    await blockTaskWorkflow(h.deps, task.taskId, task.workflow!.revision, "Try again");
    const blocked = (await readTask(h.deps, task.taskId))!.workflow!;
    await expect(actions.retryBlockedStep(task.taskId, blocked.revision - 1)).rejects.toThrow("changed since you read it");
    expect((await readTask(h.deps, task.taskId))!.workflow).toEqual(blocked);
    await actions.retryBlockedStep(task.taskId, blocked.revision);
    const after = (await readTask(h.deps, task.taskId))!.workflow!;
    expect(after.revision).toBeGreaterThan(blocked.revision);
    expect(after.state).not.toBe("BLOCKED");
    expect(after.stage).toBe("UNDERSTAND");
  });

  it("cancels the active operation and leaves the workflow blocked for retry", async () => {
    const { h, task, actions } = await setup();
    const workspace = fromDocument<WorkspaceRecord>(await h.store.get(workspaceKey(task.workspaceId)))!;
    const opKey = operationKey(task.workspaceId, workspace.activeOperationId!);
    expect((await h.store.get(opKey))?.["status"]).toBe("ACCEPTED");
    expect(await actions.cancelTask(task.taskId)).toEqual({ nothingRunning: false });
    expect((await h.store.get(opKey))?.["status"]).toBe("CANCELLED");
    expect((await readTask(h.deps, task.taskId))!.workflow?.state).toBe("BLOCKED");
    expect(await actions.cancelTask(task.taskId)).toEqual({ nothingRunning: true });
  });

  it("revises with the owner's saved live message and repeats without another revision", async () => {
    const { h, task, actions } = await setup();
    const sessionId = "ses_aaaaaaaaaaaaaaaaaaaa";
    const messageId = "msg_aaaaaaaaaaaaaaaaaaaa";
    const ownerDeveloperId = "a".repeat(64);
    const at = h.deps.now!().toISOString();
    const workflow = WorkflowSnapshotSchema.parse({ ...(await readTask(h.deps, task.taskId))!.workflow, revision: 9, stage: "IMPLEMENT", state: "BLOCKED", blockReason: WORKFLOW_BLOCK_REASONS.liveSteerReapprovalRevise,
      artifacts: [{ id: "plan-v1", type: "plan", version: 1, sha256: "c".repeat(64), producer: "planner", objectKey: "plan.md", createdAt: at }] });
    await h.store.update({ key: taskKey(task.taskId), ops: [change.set("workflow", toDocument(workflow))] });
    await h.store.put({ item: { ...liveSteerChangeKey(task.taskId), workflowRevision: 9, messageIds: [messageId] } });
    const key = messageKey({ orgId: COMPANY, sessionId }, messageId);
    await h.store.put({ item: { ...key, orgId: COMPANY, sessionId, messageId, kind: "steer", source: "app", author: { developerId: ownerDeveloperId, name: "Owner" }, text: "Also record the request id.", createdAt: at, rev: 1, delivery: { state: "delivered", at, reason: LIVE_STEER_REAPPROVAL_REASON } } });
    const request = { requestId: newRequestId(), expectedRevision: 9 };
    const input = { taskId: task.taskId, ownerDeveloperId };
    await expect(actions.revisePlanWithLiveMessage(COMPANY, sessionId, { ...input, ownerDeveloperId: "b".repeat(64) }, request)).rejects.toThrow("message that asked for the change");
    expect((await readTask(h.deps, task.taskId))!.workflow).toEqual(workflow);
    expect(await actions.revisePlanWithLiveMessage(COMPANY, sessionId, input, request)).toBe("started");
    expect((await h.store.get(planFeedbackKey(task.taskId, 10)))?.["text"]).toBe("Also record the request id.");
    const revised = (await readTask(h.deps, task.taskId))!.workflow!;
    expect(revised.stage).toBe("PLAN");
    expect(await actions.revisePlanWithLiveMessage(COMPANY, sessionId, input, request)).toBe("repeated");
    expect((await readTask(h.deps, task.taskId))!.workflow).toEqual(revised);
  });
});
