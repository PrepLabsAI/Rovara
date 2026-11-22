import { expect, it } from "vitest";
import { change, type OrgId } from "@agentx/contracts";
import { createHarness, newRequestId } from "../support/task-flow-harness.js";
import { cancelTask } from "../../packages/broker/src/core/task-flow/cancel.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { workspaceKeys } from "../../packages/broker/src/core/task-flow/workspace-location.js";
import { readTask } from "../../packages/broker/src/core/task-flow/reads.js";
import { holdItems, holdKey, reservationIdOf } from "../../packages/broker/src/core/cost/holds.js";
import { companyDayKey, costPartition } from "../../packages/broker/src/core/cost/ledger.js";
import { createHostedLedger, createHostedMoneyStop, unflushedEntryId } from "../../packages/broker/src/core-host/hosted-modules.js";

const COMPANY = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const DAY = "2026-11-09";

async function running() {
  const h = createHarness({ companyId: COMPANY, machines: { startingChecks: 0 } });
  await h.registerProject();
  const { task } = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Rename a setting", workflow: true, workflowPath: "FULL" });
  const location = await workspaceKeys(h.deps, task.workspaceId);
  await h.flow.dispatchOnce({ maxMessages: 10 });
  const workspace = (await h.store.get(location.workspaceKey))!;
  const machine = workspace["machine"] as { machineId: string };
  const prepare = h.machines.delivered(machine.machineId).at(-1)!;
  h.machines.finish(machine.machineId, prepare.operationId);
  await h.flow.recordResult({ workspaceId: task.workspaceId, operationId: prepare.operationId, fence: prepare.fence, status: "SUCCEEDED", outcome: { kind: "prepared" } });
  await h.flow.dispatchOnce({ maxMessages: 10 });
  const run = h.machines.delivered(machine.machineId).at(-1)!;
  expect(run).toMatchObject({ kind: "task", payload: { workflowMode: "PLAN" } });
  const reservationId = reservationIdOf(COMPANY, `task.start:${task.taskId}`);
  expect((await h.store.transact(holdItems({ companyId: COMPANY, reservationId, action: "task.start", taskId: task.taskId, day: DAY,
    micros: 5_000_000, capMicros: 25_000_000, nowSeconds: h.clock.now / 1_000, holdSeconds: 3_600 }))).applied).toBe(true);
  await h.store.update({ key: { pk: costPartition(COMPANY, task.taskId), sk: "TOTAL" }, ops: [change.set("holdId", reservationId)] });
  await h.store.update({ key: taskKey(task.taskId), ops: [change.set("admissionReservationId", reservationId)] });
  const now = () => new Date(h.clock.now);
  const ledger = createHostedLedger({ store: h.store, now, metering: { async price() { return null; }, async record() { return { cost: { micros: 250_000, currency: "USD" }, source: "price-table" }; } } });
  const onWait: { run?: () => Promise<void> } = {};
  h.deps.moneyStop = createHostedMoneyStop({ store: h.store, companyId: COMPANY, settings: { taskCapMicros: 5_000_000, companyDayCapMicros: 25_000_000 }, now }, {
    flushWaitMs: 1_000, pollMs: 1_000, sleep: async (ms) => { h.clock.advance(ms / 1_000); const action = onWait.run; delete onWait.run; await action?.(); },
  });
  const stopped: string[] = [];
  const stop = h.machines.stop.bind(h.machines);
  h.machines.stop = async (id) => { stopped.push(id); return stop(id); };
  return { h, task, location, run, reservationId, ledger, onWait, stopped, machineId: machine.machineId };
}

it.each(["SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"] as const)("Stop after a %s operation refuses the claim without changing workflow, workspace or money", async (status) => {
  const w = await running(); const { h, task, location, run } = w;
  await h.store.update({ key: location.operationKey(run.operationId), ops: [change.set("status", status)] });
  const keys = [taskKey(task.taskId), location.workspaceKey, location.operationKey(run.operationId), holdKey(COMPANY, w.reservationId),
    companyDayKey(COMPANY, DAY), { pk: costPartition(COMPANY, task.taskId), sk: "TOTAL" },
    { pk: costPartition(COMPANY, task.taskId), sk: `ENTRY#${unflushedEntryId(run.operationId)}` }];
  const before = await h.store.getMany(keys);
  let transactions = 0;
  const transact = h.store.transact.bind(h.store);
  h.store.transact = async (items) => { transactions += 1; return transact(items); };
  let waits = 0;
  w.onWait.run = async () => { waits += 1; };
  expect(await cancelTask(h.deps, task.taskId)).toEqual({ nothingRunning: true });
  expect(w.stopped).toEqual([]);
  expect(waits).toBe(0);
  expect(transactions).toBe(0);
  expect(await h.store.getMany(keys)).toEqual(before);
});

// Removing the ordinary caller's operation/fence guard must stop the reused machine and fail (a).
it.each(["operation", "fence"] as const)("(a) ordinary Stop records a finishing worker's spend without stopping the machine after a %s move", async (move) => {
  const w = await running(); const { h, task, location, run } = w;
  w.onWait.run = async () => {
    await w.ledger.recordUsage({ companyId: COMPANY, taskId: task.taskId, entryId: "worker-final", at: new Date(h.clock.now).toISOString(), usage: { provider: "test", modelId: "test", tokens: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } } });
    await h.flow.recordResult({ workspaceId: task.workspaceId, operationId: run.operationId, fence: run.fence, status: "SUCCEEDED" });
    await h.store.update({ key: location.workspaceKey, ops: [change.set("activeOperationId", move === "operation" ? newRequestId() : run.operationId), change.set("fence", move === "fence" ? run.fence + 1 : run.fence)] });
  };
  expect(await cancelTask(h.deps, task.taskId)).toEqual({ nothingRunning: false });
  expect(w.stopped).toEqual([]);
  expect(await h.store.get(location.operationKey(run.operationId))).toMatchObject({ status: "SUCCEEDED" });
  expect((await w.ledger.taskCost(COMPANY, task.taskId)).micros).toBe(250_000);
  expect(await h.store.get(holdKey(COMPANY, w.reservationId))).toMatchObject({ state: "open", heldMicros: 5_000_000, drawnMicros: 250_000 });
  expect(await h.store.get(companyDayKey(COMPANY, DAY))).toMatchObject({ usdMicros: 250_000, reservedMicros: 4_750_000, loadMicros: 5_000_000 });
});

it("(a) ordinary Stop retains unflushed spend and records cancellation when the workspace moves", async () => {
  const w = await running(); const { h, task, location, run } = w;
  w.onWait.run = async () => { await h.store.update({ key: location.workspaceKey, ops: [change.set("activeOperationId", newRequestId()), change.set("fence", run.fence + 1)] }); };
  expect(await cancelTask(h.deps, task.taskId)).toEqual({ nothingRunning: false });
  expect(w.stopped).toEqual([]);
  expect(await h.store.get(location.operationKey(run.operationId))).toMatchObject({ status: "CANCELLED", usageUnflushed: true });
  await expectRetained(w);
});

it("(b) ordinary Stop stops the machine when the operation and fence still own it", async () => {
  const w = await running();
  expect(await cancelTask(w.h.deps, w.task.taskId)).toEqual({ nothingRunning: false });
  expect(w.stopped).toEqual([w.machineId]);
  expect(await w.h.store.get(w.location.operationKey(w.run.operationId))).toMatchObject({ status: "CANCELLED", usageUnflushed: true });
  await expectRetained(w);
});

// Removing the named early return or its endUnflushed call loses these records or mutates the successor's workflow.
it("(c) named cancellation after a move retains spend before returning without recording a result or blocking the next step", async () => {
  const w = await running(); const { h, task, location, run } = w;
  const workflow = (await readTask(h.deps, task.taskId))!.workflow;
  const next = newRequestId();
  w.onWait.run = async () => { await h.store.update({ key: location.workspaceKey, ops: [change.set("activeOperationId", next), change.set("fence", run.fence + 1)] }); };
  expect(await cancelTask(h.deps, task.taskId, run.operationId)).toEqual({ nothingRunning: false });
  expect(w.stopped).toEqual([]);
  expect(await h.store.get(location.workspaceKey)).toMatchObject({ activeOperationId: next, fence: run.fence + 1 });
  expect(await h.store.get(location.operationKey(run.operationId))).toMatchObject({ status: "CANCEL_REQUESTED", usageUnflushed: true });
  expect((await readTask(h.deps, task.taskId))!.workflow).toEqual(workflow);
  await expectRetained(w);
});

async function expectRetained(w: Awaited<ReturnType<typeof running>>) {
  expect(await w.h.store.get(holdKey(COMPANY, w.reservationId))).toMatchObject({ state: "settled", keptMicros: 5_000_000, drawnMicros: 0, estimated: true, estimatedFor: w.run.operationId });
  expect(await w.h.store.get(companyDayKey(COMPANY, DAY))).toMatchObject({ reservedMicros: 0, settledMicros: 5_000_000, estimatedMicros: 5_000_000, loadMicros: 5_000_000 });
  expect(await w.h.store.get({ pk: costPartition(COMPANY, w.task.taskId), sk: `ENTRY#${unflushedEntryId(w.run.operationId)}` })).toMatchObject({ chargeStatus: "estimated", micros: 0 });
}
