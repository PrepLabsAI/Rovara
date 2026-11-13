// The run-lost watchdog (`sweepLostRuns`): a worker machine lost after the delivery of an operation must not leave the operation, and the task with it, running for ever.
import { describe, expect, it } from "vitest";
import { change, queryAll } from "@rovara-code/contracts";
import { operationKey, workspaceKey } from "../../packages/core/src/core/task-flow/keys.js";
import { RUN_LOST_GRACE_SECONDS, RUN_LOST_MESSAGE } from "../../packages/core/src/core/task-flow/run-watch.js";
import { runWatchKey, runWatchPartition } from "../../packages/core/src/core/task-flow/run-watch-rows.js";
import type { OperationRecord, WorkspaceRecord } from "../../packages/core/src/core/task-flow/records.js";
import { COMPANY, createHarness, newRequestId, type Harness } from "../support/task-flow-harness.js";

/** A task on the Full path whose planning step has been handed to a worker machine and is running there. */
async function runningPlan(h: Harness, instructions: string) {
  const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions, workflow: true, workflowPath: "FULL" });
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
  expect(plan).toMatchObject({ kind: "task", payload: { workflowMode: "PLAN" } });
  return { taskId: started.task.taskId, workspaceId: workspace.id, machineId, operationId: plan.operationId, fence: plan.fence };
}

const operationOf = async (h: Harness, run: { workspaceId: string; operationId: string }): Promise<OperationRecord> => (await h.store.get(operationKey(run.workspaceId, run.operationId))) as unknown as OperationRecord;
const watchRows = async (h: Harness) => queryAll(h.store, { pk: runWatchPartition(COMPANY) });

describe("an operation whose worker machine is lost", () => {
  it("is watched from the hand-over, and ends INTERRUPTED with the reason only after the grace period, releasing the workspace", async () => {
    const h = createHarness();
    await h.registerProject();
    const run = await runningPlan(h, "Rename the flag");
    expect(await watchRows(h)).toEqual([expect.objectContaining({ operationId: run.operationId, machineId: run.machineId, fence: run.fence })]);
    expect((await operationOf(h, run)).status).toBe("DISPATCHING");

    await h.machines.terminate(run.machineId);
    // First sight of a lost machine starts the clock; nothing ends yet.
    expect(await h.flow.sweepRunsOnce()).toMatchObject({ watched: 1, waiting: 1, interrupted: 0 });
    h.clock.advance(RUN_LOST_GRACE_SECONDS - 1);
    expect(await h.flow.sweepRunsOnce()).toMatchObject({ interrupted: 0, waiting: 1 });
    expect((await operationOf(h, run)).status).toBe("DISPATCHING");

    h.clock.advance(2);
    expect(await h.flow.sweepRunsOnce()).toMatchObject({ watched: 1, interrupted: 1 });
    expect(await operationOf(h, run)).toMatchObject({ status: "INTERRUPTED", error: RUN_LOST_MESSAGE });
    expect(await h.store.get(workspaceKey(run.workspaceId))).toMatchObject({ status: "READY", activeOperationId: null });
    expect(await h.store.get(runWatchKey(COMPANY, run.workspaceId, run.operationId))).toBeUndefined();
    // The task follows the path of any interrupted step: it stops with the cause in words, for the owner's Retry.
    const view = await h.flow.get(h.owner, run.taskId);
    expect(view.workflow).toMatchObject({ stage: "PLAN", state: "BLOCKED" });
    expect(view.workflow?.blockReason).toContain("Rovara stopped while planning");
    expect(view.workflow?.blockReason).toContain(RUN_LOST_MESSAGE);
  });

  it("ends an operation whose machine is unhealthy for the whole grace period, and keeps one whose machine came back", async () => {
    const h = createHarness();
    await h.registerProject();
    const sick = await runningPlan(h, "Rename the flag");
    const healthy = await runningPlan(h, "Another change");
    const real = h.machines.health.bind(h.machines);
    let sickState: "unhealthy" | "busy" = "unhealthy";
    h.machines.health = async (machineId) => (machineId === sick.machineId ? { ...(await real(machineId)), state: sickState } : real(machineId));
    expect(await h.flow.sweepRunsOnce()).toMatchObject({ watched: 2, waiting: 2 });
    h.clock.advance(RUN_LOST_GRACE_SECONDS / 2);
    // The machine recovers: the clock stops, and a new bad spell starts it again from nothing.
    sickState = "busy";
    expect(await h.flow.sweepRunsOnce()).toMatchObject({ interrupted: 0 });
    expect(await h.store.get(runWatchKey(COMPANY, sick.workspaceId, sick.operationId))).not.toHaveProperty("unhealthySince");
    sickState = "unhealthy";
    await h.flow.sweepRunsOnce();
    h.clock.advance(RUN_LOST_GRACE_SECONDS / 2 + 1);
    expect(await h.flow.sweepRunsOnce()).toMatchObject({ interrupted: 0 });
    h.clock.advance(RUN_LOST_GRACE_SECONDS);
    expect(await h.flow.sweepRunsOnce()).toMatchObject({ interrupted: 1 });
    expect((await operationOf(h, sick)).status).toBe("INTERRUPTED");
    expect((await operationOf(h, healthy)).status).toBe("DISPATCHING");
  });

  it("leaves a healthy machine's operation alone, however many times it is swept", async () => {
    const h = createHarness();
    await h.registerProject();
    const run = await runningPlan(h, "Rename the flag");
    for (let round = 0; round < 3; round += 1) {
      h.clock.advance(RUN_LOST_GRACE_SECONDS * 2);
      expect(await h.flow.sweepRunsOnce()).toMatchObject({ watched: 1, interrupted: 0, cleared: 0 });
    }
    expect((await operationOf(h, run)).status).toBe("DISPATCHING");
    expect(await h.store.get(workspaceKey(run.workspaceId))).toMatchObject({ activeOperationId: run.operationId });
  });

  it("never touches an operation that already finished, even when its machine is gone", async () => {
    const h = createHarness();
    await h.registerProject();
    const done = await runningPlan(h, "Rename the flag");
    h.machines.finish(done.machineId, done.operationId);
    await h.flow.recordResult({ workspaceId: done.workspaceId, operationId: done.operationId, fence: done.fence, status: "FAILED", error: "the model refused" });
    // The end took the watch with it. A task closed under a running step ends its operation another way and leaves the watch for the sweep to drop.
    expect(await h.store.get(runWatchKey(COMPANY, done.workspaceId, done.operationId))).toBeUndefined();
    const closed = await runningPlan(h, "Another change");
    await h.flow.close(h.owner, closed.taskId);
    expect(await operationOf(h, closed)).toMatchObject({ status: "INTERRUPTED", error: "the task was closed" });
    expect(await h.store.get(runWatchKey(COMPANY, closed.workspaceId, closed.operationId))).toBeDefined();
    const before = [await operationOf(h, done), await operationOf(h, closed)];
    await h.machines.terminate(done.machineId);
    await h.machines.terminate(closed.machineId);
    h.clock.advance(RUN_LOST_GRACE_SECONDS * 3);
    expect(await h.flow.sweepRunsOnce()).toMatchObject({ interrupted: 0, cleared: 1 });
    expect([await operationOf(h, done), await operationOf(h, closed)]).toEqual(before);
    expect(await watchRows(h)).toEqual([]);
  });

  it("never touches another operation: only the one on the lost machine ends, at its own fence", async () => {
    const h = createHarness();
    await h.registerProject();
    const lost = await runningPlan(h, "Rename the flag");
    const other = await runningPlan(h, "Another change");
    await h.machines.terminate(lost.machineId);
    await h.flow.sweepRunsOnce();
    h.clock.advance(RUN_LOST_GRACE_SECONDS + 1);
    expect(await h.flow.sweepRunsOnce()).toMatchObject({ watched: 2, interrupted: 1 });
    expect((await operationOf(h, lost)).status).toBe("INTERRUPTED");
    expect((await operationOf(h, other)).status).toBe("DISPATCHING");
    expect(await h.store.get(workspaceKey(other.workspaceId))).toMatchObject({ activeOperationId: other.operationId });
    // A row whose operation has moved to a newer hold of the workspace names an old fence: it is dropped, and the newer operation is never ended through it.
    await h.store.update({ key: operationKey(other.workspaceId, other.operationId), ops: [change.set(["fence"], other.fence + 1)] });
    await h.machines.terminate(other.machineId);
    expect(await h.flow.sweepRunsOnce()).toMatchObject({ interrupted: 0, cleared: 1 });
    h.clock.advance(RUN_LOST_GRACE_SECONDS * 2);
    expect(await h.flow.sweepRunsOnce()).toMatchObject({ watched: 0, interrupted: 0 });
    expect((await operationOf(h, other)).status).toBe("DISPATCHING");
  });

  it("does nothing on a repeat sweep after it ended the operation", async () => {
    const h = createHarness();
    await h.registerProject();
    const run = await runningPlan(h, "Rename the flag");
    await h.machines.terminate(run.machineId);
    await h.flow.sweepRunsOnce();
    h.clock.advance(RUN_LOST_GRACE_SECONDS + 1);
    expect(await h.flow.sweepRunsOnce()).toMatchObject({ interrupted: 1 });
    const task = await h.flow.get(h.owner, run.taskId);
    const operation = await operationOf(h, run);
    h.clock.advance(RUN_LOST_GRACE_SECONDS * 5);
    expect(await h.flow.sweepRunsOnce()).toEqual({ watched: 0, interrupted: 0, waiting: 0, cleared: 0, failed: 0 });
    expect(await h.flow.get(h.owner, run.taskId)).toEqual(task);
    expect(await operationOf(h, run)).toEqual(operation);
  });
});
