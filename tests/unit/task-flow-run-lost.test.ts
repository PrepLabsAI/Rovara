import { IMPLICIT_COMPANY_ID as T1_COMPANY } from "@agentx/contracts";
// The run-lost watchdog (`sweepLostRuns`): a worker machine lost after the delivery of an operation must not leave the operation, and the task with it, running for ever.
import { brokerCoreWorkerMachines } from "../../packages/broker/src/aws/worker-machines/broker-core.js";
import { SessionWorkerFleet } from "../../packages/broker/src/aws/worker-machines/session-worker-machines.js";
import { sweepLostRuns } from "../../packages/broker/src/core/task-flow/run-watch.js";
import { createSessionMachinesWorld, TABLE } from "../support/session-machines-world.js";
import { describe, expect, it } from "vitest";
import { change, queryAll } from "@agentx/contracts";
import { operationKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { RUN_LOST_GRACE_SECONDS, RUN_LOST_MESSAGE } from "../../packages/broker/src/core/task-flow/run-watch.js";
import { runWatchKey, runWatchPartition } from "../../packages/broker/src/core/task-flow/run-watch-rows.js";
import type { OperationRecord, WorkspaceRecord } from "../../packages/broker/src/core/task-flow/records.js";
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
  const workspace = (await h.store.get(workspaceKey(T1_COMPANY, started.task.workspaceId))) as unknown as WorkspaceRecord;
  const machineId = workspace.machine!.machineId;
  const prepare = h.machines.delivered(machineId).at(-1)!;
  h.machines.finish(machineId, prepare.operationId);
  await h.flow.recordResult({ workspaceId: workspace.id, operationId: prepare.operationId, fence: 1, status: "SUCCEEDED", outcome: { kind: "prepared" } });
  await drain();
  const plan = h.machines.delivered(machineId).at(-1)!;
  expect(plan).toMatchObject({ kind: "task", payload: { workflowMode: "PLAN" } });
  return { taskId: started.task.taskId, workspaceId: workspace.id, machineId, operationId: plan.operationId, fence: plan.fence };
}

const operationOf = async (h: Harness, run: { workspaceId: string; operationId: string }): Promise<OperationRecord> => (await h.store.get(operationKey(T1_COMPANY, run.workspaceId, run.operationId))) as unknown as OperationRecord;
const watchRows = async (h: Harness) => queryAll(h.store, { pk: runWatchPartition(COMPANY) });

describe("an operation whose worker machine is lost", () => {

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

});


it("the broker watchdog waits on unavailable live health and interrupts a recorded deleted session", async () => {
  const h = createHarness();
  await h.registerProject();
  const run = await runningPlan(h, "Rename the flag");
  const world = createSessionMachinesWorld();
  const workspace = world.workspace(COMPANY);
  const machine = await world.machinesFor(COMPANY).start({ companyId: COMPANY, machineKey: workspace });
  await world.settle();
  await h.store.update({ key: operationKey(h.deps.companyId, run.workspaceId, run.operationId), ops: [change.set("machineId", machine.machineId)] });
  await h.store.update({ key: runWatchKey(COMPANY, run.workspaceId, run.operationId), ops: [change.set("machineId", machine.machineId)] });
  const fleet = new SessionWorkerFleet(brokerCoreWorkerMachines({ sessions: world.sessions, documentClient: world.db, tableName: TABLE }));
  const deps = { ...h.deps, machines: fleet.forCompany(COMPANY) };
  expect(await sweepLostRuns(deps)).toMatchObject({ waiting: 1, interrupted: 0 });
  expect(await h.store.get(runWatchKey(COMPANY, run.workspaceId, run.operationId))).not.toHaveProperty("unhealthySince");
  await deps.machines.stop(machine.machineId);
  await world.settle();
  expect(await sweepLostRuns(deps)).toMatchObject({ waiting: 1, interrupted: 0 });
  h.clock.advance(RUN_LOST_GRACE_SECONDS + 1);
  expect(await sweepLostRuns(deps)).toMatchObject({ interrupted: 1 });
  expect(await operationOf(h, run)).toMatchObject({ status: "INTERRUPTED", error: RUN_LOST_MESSAGE });
});
