// Review tests (lead 4 Opus, CLOSE-RETENTION 39d814dcd): dispatch.ts deliverNotingRuntime. A step that supersedes a retention records the
// machine's runtime (which drops the SESSION's closeRetention) only AFTER the worker took the invocation; a refused hand-over leaves the
// retention recorded. Every other step records it before the hand-over.
import { textField } from "../support/close-recovery-harness.js";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { MachineError, change, workspaceSessionKey } from "@agentx/contracts";
import { createHarness } from "../support/task-flow-harness.js";
import { prepareCloseInspection } from "../../packages/broker/src/core/task-flow/close-inspection.js";
import { createTaskActions } from "../../packages/broker/src/core/task-flow/task-actions.js";
import { operationKey, taskPointerKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import type { OperationRecord } from "../../packages/broker/src/core/task-flow/records.js";

async function successorDispatch(refuse: boolean) {
  const h = createHarness({ machines: { startingChecks: 0 } }); await h.registerProject();
  const { task } = await h.flow.start(h.owner, { requestId: randomUUID(), project: "payments", instructions: "retained follow-up" });
  const wk = workspaceKey(h.deps.companyId, task.workspaceId), workspace = (await h.store.get(wk))!, id = textField(workspace, "activeOperationId");
  const op = operationKey(h.deps.companyId, task.workspaceId, id), sk = workspaceSessionKey(task.workspaceId);
  const generation = { sessionGeneration: 1, instanceId: "i-0123456789abcdef0", volumeId: "vol-0123456789abcdef0", dataGeneration: randomUUID() };
  const retained = { inspectionOperationId: id, inspectionFence: Number(workspace.fence), retentionId: randomUUID(), contentDigest: "a".repeat(64), generation };
  await h.store.update({ key: wk, ops: [change.set("status", "READY")] });
  await h.store.update({ key: op, ops: [change.set("kind", "close"), change.set("status", "RUNNING"), change.set("closePreflight", { schemaVersion: 1, target: generation })] });
  await h.store.update({ key: taskPointerKey(h.deps.companyId, task.workspaceId), ops: [change.remove("pendingPrompt")] });
  const order: string[] = [];
  const noteRuntime = vi.fn(async (_workspaceId: string, _health: unknown, operation?: OperationRecord) => { order.push(operation?.supersedesRetention === undefined ? "note" : "note-successor"); });
  h.deps.closeInspection = { raiseFence: async () => {}, retained: async () => true, noteRuntime,
    inspectWorkspaceForClose: async () => ({ retentionId: retained.retentionId, inspection: { safeToClose: true, repositories: [], contentDigest: retained.contentDigest }, retentionProof: { schemaVersion: 1, generation } }) };
  expect(await prepareCloseInspection(h.deps, task.workspaceId, id)).toBe(true);
  await h.store.put({ item: { ...sk, state: "READY", closeRetention: { retained }, workspaceDataIdentity: generation } });
  const deliver = h.machines.deliver.bind(h.machines);
  vi.spyOn(h.machines, "deliver").mockImplementation(async (machine, invocation) => {
    order.push(invocation.supersedesRetention === undefined ? "deliver" : "deliver-successor");
    if (refuse && invocation.supersedesRetention !== undefined) throw new MachineError("unavailable", "worker not reachable");
    return deliver(machine, invocation);
  });
  await createTaskActions(h.deps).continue(h.owner, task.taskId, { requestId: randomUUID(), instructions: "more work" });
  order.length = 0;
  await h.flow.dispatchOnce();
  return { order };
}

it("a superseding step records the runtime only after the worker took its invocation", async () => {
  const { order } = await successorDispatch(false);
  expect(order).toContain("deliver-successor");
  expect(order.indexOf("note-successor")).toBeGreaterThan(order.indexOf("deliver-successor"));
  expect(order.filter((entry) => entry === "note-successor")).toHaveLength(1);
});

it("a superseding step whose hand-over is refused never records the runtime that drops the retention", async () => {
  const { order } = await successorDispatch(true);
  expect(order).toContain("deliver-successor");
  expect(order).not.toContain("note-successor");
});
