import { textField } from "../support/close-recovery-harness.js";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { change, workspaceSessionKey } from "@agentx/contracts";
import { createHarness } from "../support/task-flow-harness.js";
import { prepareCloseInspection } from "../../packages/broker/src/core/task-flow/close-inspection.js";
import { createTaskActions } from "../../packages/broker/src/core/task-flow/task-actions.js";
import { operationKey, taskPointerKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";

async function fixture() {
  const h = createHarness(); await h.registerProject();
  const { task } = await h.flow.start(h.owner, { requestId: randomUUID(), project: "payments", instructions: "retained follow-up" });
  const wk = workspaceKey(h.deps.companyId, task.workspaceId), workspace = (await h.store.get(wk))!, id = textField(workspace, "activeOperationId");
  const op = operationKey(h.deps.companyId, task.workspaceId, id), sk = workspaceSessionKey(task.workspaceId);
  const generation = { sessionGeneration: 1, instanceId: "i-0123456789abcdef0", volumeId: "vol-0123456789abcdef0", dataGeneration: randomUUID() };
  const retained = { inspectionOperationId: id, inspectionFence: Number(workspace.fence), retentionId: randomUUID(), contentDigest: "a".repeat(64), generation };
  await h.store.update({ key: wk, ops: [change.set("status", "READY")] });
  await h.store.update({ key: op, ops: [change.set("kind", "close"), change.set("status", "RUNNING"), change.set("closePreflight", { schemaVersion: 1, target: generation })] });
  await h.store.update({ key: taskPointerKey(h.deps.companyId, task.workspaceId), ops: [change.remove("pendingPrompt")] });
  h.deps.closeInspection = { raiseFence: async () => {}, retained: async () => true, inspectWorkspaceForClose: async () => ({ retentionId: retained.retentionId, inspection: { safeToClose: true, repositories: [], contentDigest: retained.contentDigest }, retentionProof: { schemaVersion: 1, generation } }) };
  expect(await prepareCloseInspection(h.deps, task.workspaceId, id)).toBe(true);
  await h.store.put({ item: { ...sk, state: "READY", closeRetention: { retained }, workspaceDataIdentity: generation } });
  return { h, task, wk, op, sk, retained };
}
it("a continued round atomically binds the old retention and the next fence without changing its sealed inspection", async () => {
  const w = await fixture(), before = await w.h.store.get(w.op);
  await createTaskActions(w.h.deps).continue(w.h.owner, w.task.taskId, { requestId: randomUUID(), instructions: "more work" });
  const workspace = (await w.h.store.get(w.wk))!;
  expect(await w.h.store.get(operationKey(w.h.deps.companyId, w.task.workspaceId, textField(workspace, "activeOperationId")))).toMatchObject({ kind: "task", supersedesRetention: w.retained, fence: w.retained.inspectionFence + 1 });
  expect(await w.h.store.get(w.op)).toEqual(before);
  // A step now holds the workspace (the continued round): the preview says `busy` (stop the step first), the answer the Close dialog fails closed on.
  expect(await w.h.flow.previewClose(w.h.owner, w.task.taskId, "close")).toEqual({ preview: null, unavailable: "busy" });
});
it("a retained SESSION accepted by Close cannot be acquired by a later writer", async () => {
  const w = await fixture(), before = await w.h.store.get(w.wk);
  await w.h.store.update({ key: w.sk, ops: [change.set("closeRetention.acceptedOperationId", randomUUID())] });
  await expect(createTaskActions(w.h.deps).continue(w.h.owner, w.task.taskId, { requestId: randomUUID(), instructions: "must not run" })).rejects.toMatchObject({ code: "TASK_BUSY" });
  expect(await w.h.store.get(w.wk)).toEqual(before);
});
