// Review tests (lead 4 Opus, CLOSE-RETENTION 39d814dcd): code/next's queued-checks Stop (cancel.ts stopQueuedChecks) checks the workspace key in the
// same commitWorkflow transaction where this lane's planClosePreparation writes that key. mergeCloseConditions must fold the check into the write
// (a store refuses two steps on one key), and both sides' conditions must hold.
import { expect, it, vi } from "vitest";
import { change } from "@agentx/contracts";
import { createHarness, newRequestId } from "../support/task-flow-harness.js";
import { cancelTask } from "../../packages/broker/src/core/task-flow/cancel.js";
import { toDocument } from "../../packages/broker/src/core/task-flow/records.js";
import { dispatchRowKey, taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { dispatchRowItem } from "../../packages/broker/src/core/task-flow/dispatch-rows.js";
import { workspaceKeys } from "../../packages/broker/src/core/task-flow/workspace-location.js";
import { readTask } from "../../packages/broker/src/core/task-flow/reads.js";

async function waitingChecks() {
  const h = createHarness();
  await h.registerProject();
  const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Check the application", workflow: true, workflowPath: "QUICK" });
  const task = (await readTask(h.deps, started.task.taskId))!;
  const workflow = { ...task.workflow!, stage: "VERIFY" as const, state: "WAITING" as const,
    checkPolicy: { required: [], optional: [], proposed: [], selectedOptionalIds: [], noneReason: "Application scenarios only" },
    e2e: { required: true, contractDigest: "a".repeat(64), policyDigest: "b".repeat(64), bundleDigest: "c".repeat(64), executionPlanDigest: "d".repeat(64), currentGroupRunIds: [], resultRefs: [] } };
  await h.store.update({ key: taskKey(task.taskId), ops: [change.set("workflow", toDocument(workflow))] });
  const location = await workspaceKeys(h.deps, task.workspaceId);
  // An idle retention-capable worker: the owner-waiting boundary the Stop creates plans a close preflight.
  await h.store.update({ key: location.workspaceKey, ops: [change.set("status", "READY"), change.set("activeOperationId", null), change.set("machine", { machineId: "machine", machineKey: task.workspaceId })] });
  h.deps.closeInspection = { raiseFence: async () => {}, inspectWorkspaceForClose: async () => { throw new Error("not called"); }, retained: async () => false, ready: async () => true };
  await h.store.transact([dispatchRowItem(h.deps, task.taskId, workflow.revision, "CHECKS", new Date(h.clock.now).toISOString())]);
  return { h, task, workflow, location };
}

it("queued-checks Stop and the close preflight it plans commit as one transaction on the workspace key", async () => {
  const { h, task, workflow, location } = await waitingChecks();
  const before = (await h.store.get(location.workspaceKey))!;
  expect(await cancelTask(h.deps, task.taskId)).toMatchObject({ nothingRunning: false });
  const after = (await readTask(h.deps, task.taskId))!.workflow!;
  expect(after.state).toBe("BLOCKED");
  expect(after.revision).toBe(workflow.revision + 1);
  const workspace = (await h.store.get(location.workspaceKey))!;
  expect(workspace["fence"]).toBe(Number(before["fence"]) + 1);
  const preflightId = workspace["activeOperationId"];
  if (typeof preflightId !== "string") throw new Error("no close preflight was planned");
  expect(await h.store.get(location.operationKey(preflightId))).toMatchObject({ kind: "close", status: "ACCEPTED", closePreflight: { schemaVersion: 1 } });
});

it.each(["operation", "fence"] as const)("queued-checks Stop with a planned preflight writes nothing when the workspace %s changes before commit", async (race) => {
  const { h, task, workflow, location } = await waitingChecks();
  const keys = [taskKey(task.taskId), dispatchRowKey(h.deps.companyId, task.taskId, workflow.revision)];
  const before = await h.store.getMany(keys);
  const workspace = (await h.store.get(location.workspaceKey))!;
  const successor = newRequestId();
  const transact = h.store.transact.bind(h.store);
  let commits = 0;
  h.store.transact = async (items) => {
    commits += 1;
    await h.store.update({ key: location.workspaceKey, ops: race === "operation"
      ? [change.set("activeOperationId", successor)] : [change.set("fence", Number(workspace["fence"]) + 1)] });
    return transact(items);
  };
  expect(await cancelTask(h.deps, task.taskId)).toEqual({ nothingRunning: true });
  expect(commits).toBe(1);
  expect(await h.store.getMany(keys)).toEqual(before);
  const operations = await h.store.query({ pk: location.workspaceKey.pk, sk: { op: "beginsWith", prefix: "OPERATION#" } });
  expect(operations.items.filter((item) => item["closePreflight"] !== undefined)).toEqual([]);
});

it("the folded write keeps the Stop's own workspace check: a fence that moved after the Stop read refuses even though the preflight read the new fence", async () => {
  const { h, task, workflow, location } = await waitingChecks();
  const keys = [taskKey(task.taskId), dispatchRowKey(h.deps.companyId, task.taskId, workflow.revision)];
  const before = await h.store.getMany(keys);
  const get = h.store.get.bind(h.store);
  let reads = 0;
  h.store.get = async (key) => {
    const value = await get(key);
    // Read 1 locates the workspace; read 2 is the Stop's own read (cancel.ts); another operation then holds and releases it (fence + 1) before the preflight reads it.
    if (key.pk === location.workspaceKey.pk && key.sk === location.workspaceKey.sk && (reads += 1) === 2) {
      await h.store.update({ key: location.workspaceKey, ops: [change.set("fence", Number(value!["fence"]) + 1)] });
    }
    return value;
  };
  expect(await cancelTask(h.deps, task.taskId)).toEqual({ nothingRunning: true });
  expect(reads).toBeGreaterThan(1);
  expect(await h.store.getMany(keys)).toEqual(before);
  const operations = await h.store.query({ pk: location.workspaceKey.pk, sk: { op: "beginsWith", prefix: "OPERATION#" } });
  expect(operations.items.filter((item) => item["closePreflight"] !== undefined)).toEqual([]);
});

it("Stop while a close preflight holds the workspace ends only that preflight: no money flush, the workspace is released and a later delivery never re-holds it", async () => {
  const { h, task, location } = await waitingChecks();
  expect(await cancelTask(h.deps, task.taskId)).toMatchObject({ nothingRunning: false });
  const held = (await h.store.get(location.workspaceKey))!;
  const preflightId = held["activeOperationId"];
  if (typeof preflightId !== "string") throw new Error("no close preflight was planned");
  const workflowBefore = (await readTask(h.deps, task.taskId))!.workflow;
  let stops = 0, keptHolds = 0;
  h.deps.machines.stop = async () => { stops += 1; };
  h.deps.moneyStop = { keepWholeHold: async () => { keptHolds += 1; } };
  expect(await cancelTask(h.deps, task.taskId)).toMatchObject({ nothingRunning: false });
  expect(keptHolds).toBe(0);
  expect(stops).toBe(1);
  const released = (await h.store.get(location.workspaceKey))!;
  expect(released).toMatchObject({ status: "READY", activeOperationId: null, fence: held["fence"] });
  expect(await h.store.get(location.operationKey(preflightId))).toMatchObject({ status: "CANCELLED" });
  expect((await readTask(h.deps, task.taskId))!.workflow).toEqual(workflowBefore);
  const deliver = vi.spyOn(h.machines, "deliver");
  await h.flow.dispatchOnce();
  expect(deliver).not.toHaveBeenCalled();
  expect((await h.store.get(location.workspaceKey))!).toMatchObject({ activeOperationId: null, fence: held["fence"] });
});
