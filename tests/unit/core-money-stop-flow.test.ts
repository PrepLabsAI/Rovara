// Lane core-money-stop, the flow's side (core/task-flow/money-stop.ts): on a deployed install a Stop and a close let a running model run send its usage before it is ended, a run whose
// usage never comes keeps its task's whole hold (marked estimated), a run past a cap is stopped with a fixed reason, and each model run is admitted before it is handed to a worker that
// reports usage while it runs. Without `moneyStop` (the laptop) every one of these paths is as before.
import { describe, expect, it } from "vitest";
import { USAGE_CHECKPOINTS_FEATURE, type Admission, type AdmissionRequest, type WorkerInvocation } from "@agentx/contracts";
import { cancelTask } from "../../packages/broker/src/core/task-flow/cancel.js";
import { operationKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { RUN_START_ACTION, SPEND_STOP_REASON, SPEND_UNKNOWN_STOP_REASON, USAGE_FLUSH_WAIT_MS, requestSpendStop, type MoneyStop } from "../../packages/broker/src/core/task-flow/money-stop.js";
import { RUN_LOST_GRACE_SECONDS, RUN_LOST_MESSAGE } from "../../packages/broker/src/core/task-flow/run-watch.js";
import type { OperationRecord, WorkspaceRecord } from "../../packages/broker/src/core/task-flow/records.js";
import { createAllowAllAdmission } from "../../packages/broker/src/ports/policy-defaults.js";
import { createHarness, newRequestId, type Harness, type HarnessOptions } from "../support/task-flow-harness.js";

const FEATURES = ["task.workflowMode", "task.structuredPlans", USAGE_CHECKPOINTS_FEATURE];

interface StopWorld {
  h: Harness;
  kept: Array<{ reservationId: string | undefined; operationId: string; taskId: string }>;
  /** Runs at each wait of a Stop (the worker's side: it may send its result here). */
  onWait: { run?: (() => Promise<void>) | undefined };
  cancels: WorkerInvocation[];
}

function world(options: { moneyStop?: boolean; features?: string[]; admission?: Admission } = {}): StopWorld {
  const kept: StopWorld["kept"] = [];
  const onWait: StopWorld["onWait"] = {};
  const dispatcher: { run?: () => Promise<unknown> } = {};
  const harness: HarnessOptions = {
    machines: { features: options.features ?? FEATURES },
    ...(options.admission === undefined ? {} : { admission: options.admission }),
    ...(options.moneyStop === false ? {} : {
      extra: (clock) => ({
        moneyStop: {
          pollMs: 1_000,
          // Each wait: the dispatcher hands over what was queued (the cancel), then the worker may answer.
          sleep: async (ms: number) => { clock.advance(ms / 1_000); await dispatcher.run?.(); const run = onWait.run; onWait.run = undefined; await run?.(); },
          async keepWholeHold(reservationId, mark) { kept.push({ reservationId, ...mark }); },
        } satisfies MoneyStop,
      }),
    }),
  };
  const h = createHarness(harness);
  dispatcher.run = () => h.flow.dispatchOnce({ maxMessages: 10 });
  // Every invocation handed to a machine, kept (the fake forgets a stopped machine's jobs).
  const deliver = h.machines.deliver.bind(h.machines);
  const cancels: WorkerInvocation[] = [];
  h.machines.deliver = async (machineId, invocation) => { if (invocation.kind === "cancel") cancels.push(structuredClone(invocation)); return deliver(machineId, invocation); };
  return { h, kept, onWait, cancels };
}

/** A Full task whose planning step has been handed to its worker machine. */
async function runningPlan(h: Harness) {
  await h.registerProject();
  const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Rename the flag", workflow: true, workflowPath: "FULL" });
  const drain = async (): Promise<void> => {
    for (let round = 0; round < 12; round += 1) {
      if ((await h.flow.dispatchOnce({ maxMessages: 10 })).received === 0) return;
      h.clock.advance(70);
    }
  };
  await drain();
  const workspace = (await h.store.get(workspaceKey(started.task.workspaceId))) as unknown as WorkspaceRecord;
  const machineId = workspace.machine!.machineId;
  const prepare = h.machines.delivered(machineId).at(-1)!;
  h.machines.finish(machineId, prepare.operationId);
  await h.flow.recordResult({ workspaceId: workspace.id, operationId: prepare.operationId, fence: 1, status: "SUCCEEDED", outcome: { kind: "prepared" } });
  await drain();
  const plan = h.machines.delivered(machineId).at(-1)!;
  return { taskId: started.task.taskId, workspaceId: workspace.id, machineId, operationId: plan.operationId, fence: plan.fence, plan, drain };
}

const operationOf = async (h: Harness, run: { workspaceId: string; operationId: string }): Promise<OperationRecord> => (await h.store.get(operationKey(run.workspaceId, run.operationId))) as unknown as OperationRecord;
const cancelsTo = (w: Pick<StopWorld, "cancels">, run: { operationId: string }) => w.cancels.filter((invocation) => invocation.kind === "cancel" && invocation.payload.targetOperationId === run.operationId);

describe("Stop on a deployed install: the worker sends its usage first", () => {
  it("asks the worker to stop, waits for its end, and keeps nothing estimated when the worker's result came", async () => {
    const w = world(); const { h, kept, onWait } = w;
    const run = await runningPlan(h);
    // The worker stops and reports (its usage batch precedes its result) during the wait.
    onWait.run = async () => { await h.flow.recordResult({ workspaceId: run.workspaceId, operationId: run.operationId, fence: run.fence, status: "CANCELLED" }); };
    const started = h.clock.now;
    expect(await cancelTask(h.deps, run.taskId)).toEqual({ nothingRunning: false });
    expect(cancelsTo(w, run)).toHaveLength(1);
    // The cancel carries no callback right: it is answered on its own request.
    expect(cancelsTo(w, run)[0]).toMatchObject({ kind: "cancel", workspaceId: run.workspaceId, fence: run.fence });
    expect(await operationOf(h, run)).toMatchObject({ status: "CANCELLED" });
    expect(await operationOf(h, run)).not.toHaveProperty("usageUnflushed");
    expect(kept).toEqual([]);
    expect(h.clock.now - started).toBeLessThan(USAGE_FLUSH_WAIT_MS);
    const view = await h.flow.get(h.owner, run.taskId);
    expect(view.workflow).toMatchObject({ state: "BLOCKED", blockReason: "You stopped this step. Retry to run it again." });
  });

  it("leaves the task's next move alone when the run finished on its own during the wait", async () => {
    const w = world(); const { h, kept, onWait } = w;
    const run = await runningPlan(h);
    onWait.run = async () => { await h.flow.recordResult({ workspaceId: run.workspaceId, operationId: run.operationId, fence: run.fence, status: "FAILED", error: "the plan failed" }); };
    await cancelTask(h.deps, run.taskId);
    expect(await operationOf(h, run)).toMatchObject({ status: "FAILED" });
    expect((await h.flow.get(h.owner, run.taskId)).workflow?.blockReason).not.toBe("You stopped this step. Retry to run it again.");
    expect(kept).toEqual([]);
  });

  it("records CANCELLED after the bounded wait when the worker never ends, keeping the task's whole hold as spent, marked estimated", async () => {
    const w = world(); const { h, kept } = w;
    const run = await runningPlan(h);
    const started = h.clock.now;
    await cancelTask(h.deps, run.taskId);
    expect(h.clock.now - started).toBeGreaterThanOrEqual(USAGE_FLUSH_WAIT_MS);
    expect(h.clock.now - started).toBeLessThan(USAGE_FLUSH_WAIT_MS + 2_000);
    expect(await operationOf(h, run)).toMatchObject({ status: "CANCELLED", usageUnflushed: true });
    expect(kept).toEqual([{ reservationId: undefined, operationId: run.operationId, taskId: run.taskId }]);
    expect((await h.flow.get(h.owner, run.taskId)).workflow).toMatchObject({ state: "BLOCKED" });
  });

  it("keeps the hold when the cancel cannot reach the worker (its machine is gone): the dispatcher drops it and the wait runs out", async () => {
    const w = world(); const { h, kept } = w;
    const run = await runningPlan(h);
    await h.machines.terminate(run.machineId);
    await cancelTask(h.deps, run.taskId);
    // The dispatcher tried it once (the machine answers "not found", which is not retried).
    expect(cancelsTo(w, run)).toHaveLength(1);
    expect(await operationOf(h, run)).toMatchObject({ status: "CANCELLED", usageUnflushed: true });
    expect(kept).toHaveLength(1);
  });

  it("the broker never reaches the worker itself: the cancel is a dispatch message the dispatcher delivers, and only while the run is being stopped", async () => {
    const w = world(); const { h } = w;
    const run = await runningPlan(h);
    const sent: string[] = [];
    const deliver = h.machines.deliver.bind(h.machines);
    h.machines.deliver = async (machineId, invocation) => { sent.push(invocation.kind); return deliver(machineId, invocation); };
    // The run already ended: a queued cancel of it is dropped, not delivered.
    expect(await requestSpendStop(h.deps, await operationOf(h, run), "task_cap")).toBe(true);
    expect(sent).toEqual([]);
    await h.flow.recordResult({ workspaceId: run.workspaceId, operationId: run.operationId, fence: run.fence, status: "CANCELLED" });
    expect(await h.flow.dispatchOnce({ maxMessages: 10 })).toMatchObject({ dropped: 1, delivered: 0 });
    expect(sent).toEqual([]);
    // One that is still being stopped gets its cancel, with no callback right.
    const other = world();
    const second = await runningPlan(other.h);
    await requestSpendStop(other.h.deps, await operationOf(other.h, second), "task_cap");
    expect(cancelsTo(other, second)).toEqual([]);
    expect(await other.h.flow.dispatchOnce({ maxMessages: 10 })).toMatchObject({ delivered: 1 });
    expect(cancelsTo(other, second)).toHaveLength(1);
  });

  it("without the money stop (the laptop): no cancel is sent, nothing waits, nothing is kept", async () => {
    const w = world({ moneyStop: false }); const { h, kept } = w;
    const run = await runningPlan(h);
    const started = h.clock.now;
    await cancelTask(h.deps, run.taskId);
    expect(h.clock.now).toBe(started);
    expect(cancelsTo(w, run)).toEqual([]);
    const ended = await operationOf(h, run);
    expect(ended.status).toBe("CANCELLED");
    expect(ended).not.toHaveProperty("usageUnflushed");
    expect(kept).toEqual([]);
  });
});

describe("closing a task with a run going, on a deployed install", () => {
  it("lets the worker end the run first (no estimate kept)", async () => {
    const w = world(); const { h, kept, onWait } = w;
    const run = await runningPlan(h);
    onWait.run = async () => { await h.flow.recordResult({ workspaceId: run.workspaceId, operationId: run.operationId, fence: run.fence, status: "CANCELLED" }); };
    await h.flow.close(h.owner, run.taskId);
    expect(cancelsTo(w, run)).toHaveLength(1);
    expect(await operationOf(h, run)).toMatchObject({ status: "CANCELLED" });
    expect(kept).toEqual([]);
  });

  it("ends the run INTERRUPTED and keeps the whole hold estimated when the worker does not answer", async () => {
    const w = world(); const { h, kept } = w;
    const run = await runningPlan(h);
    await h.flow.close(h.owner, run.taskId);
    expect(await operationOf(h, run)).toMatchObject({ status: "INTERRUPTED", error: "the task was closed", usageUnflushed: true });
    expect(kept).toEqual([{ reservationId: undefined, operationId: run.operationId, taskId: run.taskId }]);
  });

  it("without the money stop, closes as before", async () => {
    const w = world({ moneyStop: false }); const { h, kept } = w;
    const run = await runningPlan(h);
    await h.flow.close(h.owner, run.taskId);
    expect(cancelsTo(w, run)).toEqual([]);
    const ended = await operationOf(h, run);
    expect(ended).toMatchObject({ status: "INTERRUPTED", error: "the task was closed" });
    expect(ended).not.toHaveProperty("usageUnflushed");
    expect(kept).toEqual([]);
  });
});

describe("the per-run stop", () => {
  it("asks a running run to stop with its reason and sends its worker a cancel, and the worker's CANCELLED end blocks the step with the fixed reason", async () => {
    const w = world(); const { h, kept } = w;
    const run = await runningPlan(h);
    expect(await requestSpendStop(h.deps, await operationOf(h, run), "task_cap")).toBe(true);
    expect(await operationOf(h, run)).toMatchObject({ status: "CANCEL_REQUESTED", stopReason: "task_cap" });
    await h.flow.dispatchOnce({ maxMessages: 10 });
    expect(cancelsTo(w, run)).toHaveLength(1);
    // Asked again (the next booking): nothing more.
    expect(await requestSpendStop(h.deps, await operationOf(h, run), "task_cap")).toBe(false);
    await h.flow.dispatchOnce({ maxMessages: 10 });
    expect(cancelsTo(w, run)).toHaveLength(1);
    await h.flow.recordResult({ workspaceId: run.workspaceId, operationId: run.operationId, fence: run.fence, status: "CANCELLED" });
    expect((await h.flow.get(h.owner, run.taskId)).workflow).toMatchObject({ state: "BLOCKED", blockReason: SPEND_STOP_REASON });
    expect(kept).toEqual([]);
  });

  it("names spend that could not be read in its own words", async () => {
    const w = world(); const { h } = w;
    const run = await runningPlan(h);
    await requestSpendStop(h.deps, await operationOf(h, run), "spend_unknown");
    await h.flow.recordResult({ workspaceId: run.workspaceId, operationId: run.operationId, fence: run.fence, status: "CANCELLED" });
    expect((await h.flow.get(h.owner, run.taskId)).workflow?.blockReason).toBe(SPEND_UNKNOWN_STOP_REASON);
  });

  it("the run-lost sweep ends a stop the worker never answered, after the flush wait: CANCELLED with the reason, its hold kept estimated, its machine stopped", async () => {
    const w = world(); const { h, kept } = w;
    const run = await runningPlan(h);
    await requestSpendStop(h.deps, await operationOf(h, run), "company_day_cap");
    h.clock.advance(USAGE_FLUSH_WAIT_MS / 1_000 - 1);
    expect(await h.flow.sweepRunsOnce()).toMatchObject({ interrupted: 0 });
    expect((await operationOf(h, run)).status).toBe("CANCEL_REQUESTED");
    h.clock.advance(2);
    expect(await h.flow.sweepRunsOnce()).toMatchObject({ interrupted: 1 });
    expect(await operationOf(h, run)).toMatchObject({ status: "CANCELLED", error: SPEND_STOP_REASON, usageUnflushed: true });
    expect(kept).toEqual([{ reservationId: undefined, operationId: run.operationId, taskId: run.taskId }]);
    expect((await h.machines.health(run.machineId)).state).toBe("stopped");
    expect((await h.flow.get(h.owner, run.taskId)).workflow).toMatchObject({ state: "BLOCKED", blockReason: SPEND_STOP_REASON });
  });

  it("does nothing on an install without the money stop, or for a run already ended", async () => {
    const w = world({ moneyStop: false }); const { h } = w;
    const run = await runningPlan(h);
    const before = await operationOf(h, run);
    expect(await requestSpendStop(h.deps, before, "task_cap")).toBe(false);
    expect(await operationOf(h, run)).toEqual(before);
    const other = world();
    const ended = await runningPlan(other.h);
    await other.h.flow.recordResult({ workspaceId: ended.workspaceId, operationId: ended.operationId, fence: ended.fence, status: "FAILED", error: "x" });
    expect(await requestSpendStop(other.h.deps, await operationOf(other.h, ended), "task_cap")).toBe(false);
    expect(await operationOf(other.h, ended)).not.toHaveProperty("stopReason");
  });

  it("a worker lost under a run keeps the task's whole hold estimated (the run-lost end)", async () => {
    const w = world(); const { h, kept } = w;
    const run = await runningPlan(h);
    await h.machines.terminate(run.machineId);
    await h.flow.sweepRunsOnce();
    h.clock.advance(RUN_LOST_GRACE_SECONDS + 1);
    await h.flow.sweepRunsOnce();
    expect(await operationOf(h, run)).toMatchObject({ status: "INTERRUPTED", error: RUN_LOST_MESSAGE, usageUnflushed: true });
    expect(kept).toHaveLength(1);
  });
});

describe("dispatching a model run on a deployed install", () => {
  it("asks admission (run.start, holding nothing) for the task, tells the worker to report usage as it goes, and needs a worker that can", async () => {
    const asked: AdmissionRequest[] = [];
    const base = createAllowAllAdmission();
    const admission: Admission = { ...base, async admit(request) { asked.push(request); return base.admit(request); } };
    const w = world({ admission }); const { h } = w;
    const run = await runningPlan(h);
    expect(run.plan).toMatchObject({ kind: "task", payload: { workflowMode: "PLAN", usageCheckpoints: true } });
    expect(asked.filter((request) => request.action === RUN_START_ACTION)).toEqual([expect.objectContaining({ subject: { type: "task", id: run.taskId }, idempotencyKey: `${RUN_START_ACTION}:${run.operationId}` })]);
  });

  it("ends a run its task's cap refuses with the fixed reason, before any worker gets it", async () => {
    const base = createAllowAllAdmission();
    const admission: Admission = { ...base, async admit(request) { return request.action === RUN_START_ACTION ? { allowed: false, code: "task_cap", message: "over" } : base.admit(request); } };
    const w = world({ admission }); const { h } = w;
    await h.registerProject();
    const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Rename the flag", workflow: true, workflowPath: "FULL" });
    for (let round = 0; round < 12; round += 1) { if ((await h.flow.dispatchOnce({ maxMessages: 10 })).received === 0) break; h.clock.advance(70); }
    const workspace = (await h.store.get(workspaceKey(started.task.workspaceId))) as unknown as WorkspaceRecord;
    const prepare = h.machines.delivered(workspace.machine!.machineId).at(-1)!;
    h.machines.finish(workspace.machine!.machineId, prepare.operationId);
    await h.flow.recordResult({ workspaceId: workspace.id, operationId: prepare.operationId, fence: 1, status: "SUCCEEDED", outcome: { kind: "prepared" } });
    for (let round = 0; round < 12; round += 1) { if ((await h.flow.dispatchOnce({ maxMessages: 10 })).received === 0) break; h.clock.advance(70); }
    expect(h.machines.delivered(workspace.machine!.machineId).filter((invocation) => invocation.kind === "task")).toEqual([]);
    const view = await h.flow.get(h.owner, started.task.taskId);
    // Ended as a spend stop (CANCELLED with the reason), not as a failure a retry policy would repeat.
    expect(view.workflow).toMatchObject({ state: "BLOCKED", blockReason: SPEND_STOP_REASON });
    const operations = (await h.store.query({ pk: `WORKSPACE#${workspace.id}`, sk: { op: "beginsWith", prefix: "OPERATION#" } })).items as unknown as OperationRecord[];
    expect(operations.filter((operation) => operation.kind === "task")).toEqual([expect.objectContaining({ status: "CANCELLED", stopReason: "task_cap", error: SPEND_STOP_REASON })]);
  });

  it("refuses a model run to a worker that does not report usage while it runs", async () => {
    const w = world({ features: ["task.workflowMode", "task.structuredPlans"] }); const { h } = w;
    await h.registerProject();
    const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Rename the flag", workflow: true, workflowPath: "FULL" });
    for (let round = 0; round < 12; round += 1) { if ((await h.flow.dispatchOnce({ maxMessages: 10 })).received === 0) break; h.clock.advance(70); }
    const workspace = (await h.store.get(workspaceKey(started.task.workspaceId))) as unknown as WorkspaceRecord;
    const prepare = h.machines.delivered(workspace.machine!.machineId).at(-1)!;
    h.machines.finish(workspace.machine!.machineId, prepare.operationId);
    await h.flow.recordResult({ workspaceId: workspace.id, operationId: prepare.operationId, fence: 1, status: "SUCCEEDED", outcome: { kind: "prepared" } });
    for (let round = 0; round < 12; round += 1) { if ((await h.flow.dispatchOnce({ maxMessages: 10 })).received === 0) break; h.clock.advance(70); }
    expect(h.machines.delivered(workspace.machine!.machineId).filter((invocation) => invocation.kind === "task")).toEqual([]);
    expect((await h.flow.get(h.owner, started.task.taskId)).workflow?.blockReason).toContain("this worker is too old to run this step; upgrade it");
  });

  it("without the money stop: no run.start is asked and the payload has no usageCheckpoints (unchanged)", async () => {
    const asked: AdmissionRequest[] = [];
    const base = createAllowAllAdmission();
    const admission: Admission = { ...base, async admit(request) { asked.push(request); return base.admit(request); } };
    const w = world({ moneyStop: false, admission, features: ["task.workflowMode", "task.structuredPlans"] }); const { h } = w;
    const run = await runningPlan(h);
    expect(run.plan.kind).toBe("task");
    expect(run.plan.payload).not.toHaveProperty("usageCheckpoints");
    expect(asked.map((request) => request.action)).not.toContain(RUN_START_ACTION);
  });
});
