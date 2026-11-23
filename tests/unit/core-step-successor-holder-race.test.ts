// Review test (lead 4 Opus, CLOSE-RETENTION 39d814dcd): holdWorkspaceItem now admits a READY workspace held by its exact retention holder
// (`activeOperationId = workspace.activeOperationId`, code/next had `= null`). The hold must still refuse when that holder changed after the read,
// even at the same fence and status.
import { textField } from "../support/close-recovery-harness.js";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { change, workspaceSessionKey } from "@agentx/contracts";
import { createHarness } from "../support/task-flow-harness.js";
import { prepareCloseInspection } from "../../packages/broker/src/core/task-flow/close-inspection.js";
import { createTaskActions } from "../../packages/broker/src/core/task-flow/task-actions.js";
import { operationKey, taskPointerKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";

it("a successor step does not hold the workspace when its retention holder changed after the read at the same fence", async () => {
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
  const fence = Number((await h.store.get(wk))!.fence);
  const transact = h.store.transact.bind(h.store);
  let raced = false;
  h.store.transact = async (items) => {
    if (!raced && items.some((item) => item.kind === "put" && item.item["entityType"] === "OPERATION" && item.item["supersedesRetention"] !== undefined)) {
      raced = true;
      // Another writer replaces the holder without a new fence (status and fence unchanged).
      await h.store.update({ key: wk, ops: [change.set("activeOperationId", "another-holder")] });
    }
    return transact(items);
  };
  await createTaskActions(h.deps).continue(h.owner, task.taskId, { requestId: randomUUID(), instructions: "more work" }).catch(() => undefined);
  expect(raced).toBe(true);
  expect(await h.store.get(wk)).toMatchObject({ activeOperationId: "another-holder", fence, status: "READY" });
  const operations = await h.store.query({ pk: wk.pk, sk: { op: "beginsWith", prefix: "OPERATION#" } });
  expect(operations.items.filter((item) => item["supersedesRetention"] !== undefined)).toEqual([]);
});
