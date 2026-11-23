// STOP-NON-DESTRUCTIVE (a P1 data-loss fix): on the hosted adapter a person's Stop ends the instance and KEEPS the workspace volume; only a Close deletes it.
// Composed as the deployed install composes it: the task flow (real) over a hybrid worker-machines adapter: the dispatcher half (start / deliver / health, the real session adapter) and
// the broker half (stop / terminate, `brokerCoreWorkerMachines`, brokerOnly), both over the real SessionManager on a fake table, with the provisioner, the deleter and the idle reaper played
// (tests/support/session-machines-world.ts). The flow's store and the sessions' table are two fakes here, so the workspace's active operation is MIRRORED into the sessions' table at each
// Stop (in the deployed install they are one table). Every fake: the EC2 instance, the EBS volume (a string id) and the state machines. The real instance kill and the volume are proved
// natively (DEPLOY-ORDER.md, rule #15), not here.
import { describe, expect, it } from "vitest";
import { type WorkerInvocation, type WorkerMachines } from "@agentx/contracts";
import { cancelTask } from "../../packages/broker/src/core/task-flow/cancel.js";
import { operationKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { requestSpendStop, type MoneyStop } from "../../packages/broker/src/core/task-flow/money-stop.js";
import { retryBlockedStep } from "../../packages/broker/src/core/task-flow/retry.js";
import type { WorkspaceRecord } from "../../packages/broker/src/core/task-flow/records.js";
import { SessionWorkerFleet, sessionMachineId } from "../../packages/broker/src/aws/worker-machines/session-worker-machines.js";
import { brokerCoreWorkerMachines } from "../../packages/broker/src/aws/worker-machines/broker-core.js";
import { createHarness, newRequestId, COMPANY, type Harness } from "../support/task-flow-harness.js";
import { TABLE, createSessionMachinesWorld } from "../support/session-machines-world.js";

async function compose(options: { moneyStop: boolean }) {
  const sw = createSessionMachinesWorld();
  const dispatcherHalf = sw.fleet().forCompany(COMPANY);
  const brokerDeps = brokerCoreWorkerMachines({ sessions: sw.sessions, documentClient: sw.db as never, tableName: TABLE });
  const deleteCalls: string[] = [];
  const realDelete = brokerDeps.sessions.deleteSession;
  brokerDeps.sessions.deleteSession = async (workspaceId) => { deleteCalls.push(workspaceId); return realDelete(workspaceId); };
  const brokerHalf = new SessionWorkerFleet(brokerDeps).forCompany(COMPANY);
  const calls: string[] = [];
  const deliveries: WorkerInvocation[] = [];
  const holder: { h?: Harness } = {};
  // The deployed install has one table: the flow's workspace record and the session manager's read of it are the same item. Here they are two fakes, so the active operation is copied across.
  const mirror = async (workspaceId: string) => {
    const record = (await holder.h!.store.get(workspaceKey(COMPANY, workspaceId))) as unknown as WorkspaceRecord | undefined;
    sw.db.set({ pk: `WORKSPACE#${workspaceId}`, sk: "META", entityType: "WORKSPACE", status: "READY", fence: 1, projectName: "payments", projectRevision: 1, companyId: COMPANY, orgId: COMPANY, activeOperationId: record?.activeOperationId ?? null });
  };
  const hybrid: WorkerMachines = {
    capabilities: dispatcherHalf.capabilities,
    start: async (spec) => { calls.push("start"); return dispatcherHalf.start(spec); },
    deliver: async (id, invocation) => { calls.push("deliver"); deliveries.push(structuredClone(invocation)); return dispatcherHalf.deliver(id, invocation); },
    health: (id) => dispatcherHalf.health(id),
    stop: async (id) => { calls.push("stop"); await mirror(id.replace("ec2ws.", "")); return brokerHalf.stop(id); },
    terminate: async (id) => { calls.push("terminate"); return brokerHalf.terminate(id); },
  };
  const kept: unknown[] = [];
  const onWait: { run?: (() => Promise<void>) | undefined } = {};
  const dispatcher: { run?: () => Promise<unknown> } = {};
  const h = createHarness({
    extra: (clock) => ({
      machines: hybrid,
      ...(options.moneyStop ? { moneyStop: {
        pollMs: 1_000,
        sleep: async (ms: number) => { clock.advance(ms / 1_000); await dispatcher.run?.(); const run = onWait.run; onWait.run = undefined; await run?.(); },
        async keepWholeHold(reservationId, mark) { kept.push({ reservationId, ...mark }); },
      } satisfies MoneyStop } : {}),
    }),
  });
  holder.h = h;
  dispatcher.run = () => h.flow.dispatchOnce({ maxMessages: 10 });
  await h.registerProject();
  const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Rename the flag", workflow: true, workflowPath: "FULL" });
  const workspaceId = started.task.workspaceId;
  await mirror(workspaceId);
  /** Dispatches, plays the provisioner and the reaper, and waits out the queue's delays until `until` holds. */
  const drain = async (until: () => boolean): Promise<void> => {
    for (let round = 0; round < 40 && !until(); round += 1) {
      await h.flow.dispatchOnce({ maxMessages: 10 });
      await sw.settle();
      await sw.reap();
      h.clock.advance(70);
    }
    expect(until()).toBe(true);
  };
  const sessionNow = async () => (await sw.sessions.get(workspaceId))!;
  const deleterRuns = () => sw.executions.filter((execution) => execution.stateMachineArn.endsWith(":deleter"));
  const workspaceRecord = async () => (await h.store.get(workspaceKey(COMPANY, workspaceId))) as unknown as WorkspaceRecord;
  /** The first step (prepare: a kind that never gets a cancel at the worker) is on its machine. */
  const prepareRunning = async () => { await drain(() => deliveries.length >= 1); };
  /** The prepare step is done and the plan step (a model run) is on its machine. */
  const planRunning = async () => {
    await prepareRunning();
    const prepare = deliveries[0]!;
    await h.flow.recordResult({ workspaceId, operationId: prepare.operationId, fence: prepare.fence, status: "SUCCEEDED", outcome: { kind: "prepared" } });
    await drain(() => deliveries.some((delivery) => delivery.kind === "task"));
    return deliveries.find((delivery) => delivery.kind === "task")!;
  };
  const reapTwice = async () => { await sw.reap(); await sw.reap(); };
  const terminate = () => hybrid.terminate(sessionMachineId(workspaceId));
  return { sw, h, calls, deliveries, deleteCalls, kept, onWait, taskId: started.task.taskId, workspaceId, drain, sessionNow, deleterRuns, workspaceRecord, prepareRunning, planRunning, reapTwice, mirror, dispatcherHalf, terminate };
}

describe.each([{ moneyStop: true }, { moneyStop: false }])("a person's Stop on a hosted task (moneyStop wired: $moneyStop)", ({ moneyStop }) => {
  it("T1 Stop of a prepare step (no worker cancel is sent): STOPPING at once, the deleter never runs, then STOPPED on the SAME volume, and Retry's start wakes it on a new generation", async () => {
    const c = await compose({ moneyStop });
    await c.prepareRunning();
    const before = await c.sessionNow();
    expect(before).toMatchObject({ state: "READY" });
    expect((await c.workspaceRecord()).activeOperationId).not.toBeNull();

    expect(await cancelTask(c.h.deps, c.taskId)).toEqual({ nothingRunning: false });
    expect(c.calls).toContain("stop");
    expect(c.calls).not.toContain("terminate");
    expect(c.deleteCalls).toEqual([]);
    expect(await c.sessionNow()).toMatchObject({ state: "STOPPING", volumeId: before.volumeId, generation: before.generation });
    await c.reapTwice();
    expect(await c.sessionNow()).toMatchObject({ state: "STOPPED", volumeId: before.volumeId });
    expect(c.sw.instances.get(before.instanceId!)!.running).toBe(false);
    expect(c.deleterRuns()).toEqual([]);

    // Retry: the dispatcher's start wakes the session on a new generation on the same volume (no not_found).
    await c.dispatcherHalf.start({ machineKey: c.workspaceId, companyId: COMPANY });
    await c.sw.settle();
    expect(await c.sessionNow()).toMatchObject({ state: "READY", generation: before.generation + 1, volumeId: before.volumeId });
    expect(c.deleterRuns()).toEqual([]);
  });

  it("T2 Stop of a model run whose worker never answers (the flush wait runs out, or there is none): the same, and the hold stays estimated when the install tracks money", async () => {
    const c = await compose({ moneyStop });
    const plan = await c.planRunning();
    const before = await c.sessionNow();
    expect(await cancelTask(c.h.deps, c.taskId)).toEqual({ nothingRunning: false });
    expect(c.calls).toContain("stop");
    expect(c.deleteCalls).toEqual([]);
    expect(c.kept).toHaveLength(moneyStop ? 1 : 0);
    expect(await c.sessionNow()).toMatchObject({ state: "STOPPING", volumeId: before.volumeId });
    await c.reapTwice();
    expect(await c.sessionNow()).toMatchObject({ state: "STOPPED", volumeId: before.volumeId });
    expect(c.deleterRuns()).toEqual([]);
    expect((await c.h.flow.get(c.h.owner, c.taskId)).workflow).toMatchObject({ state: "BLOCKED", blockReason: "You stopped this step. Retry to run it again." });

    // T4 Retry on the blocked step: it waits out the STOPPING window, wakes the session on a new generation on the same volume, and hands the step to the new instance.
    const deliveredBefore = c.deliveries.length;
    await retryBlockedStep(c.h.deps, c.taskId);
    await c.drain(() => c.deliveries.length > deliveredBefore && c.deliveries.at(-1)!.kind === "task");
    expect(c.deliveries.at(-1)!.workspaceId).toBe(plan.workspaceId);
    expect(await c.sessionNow()).toMatchObject({ state: "READY", generation: before.generation + 1, volumeId: before.volumeId });
    expect(c.deleterRuns()).toEqual([]);
  });

  it("T4b Retry pressed while the session is still STOPPING (before the reaper's second tick): not_found never appears; it waits and then wakes on the same volume", async () => {
    const c = await compose({ moneyStop });
    await c.planRunning();
    const before = await c.sessionNow();
    await cancelTask(c.h.deps, c.taskId);
    expect((await c.sessionNow()).state).toBe("STOPPING");
    const deliveredBefore = c.deliveries.length;
    await retryBlockedStep(c.h.deps, c.taskId);
    await c.drain(() => c.deliveries.length > deliveredBefore && c.deliveries.at(-1)!.kind === "task");
    expect(await c.sessionNow()).toMatchObject({ state: "READY", generation: before.generation + 1, volumeId: before.volumeId });
    expect(c.deleterRuns()).toEqual([]);
  });

  it("T6 a Close after a Stop still deletes the volume (terminate from STOPPED: the deleter's input has the volume id); Close is the only path", async () => {
    const c = await compose({ moneyStop });
    await c.prepareRunning();
    const before = await c.sessionNow();
    await cancelTask(c.h.deps, c.taskId);
    await c.reapTwice();
    expect((await c.sessionNow()).state).toBe("STOPPED");
    expect(c.deleterRuns()).toEqual([]);
    // The core's close ends its machines with `machines.terminate` (close.ts stopMachines); the callers are pinned by the census test.
    await c.terminate();
    await c.sw.settle();
    expect(c.deleterRuns()).toHaveLength(1);
    expect(c.deleterRuns()[0]!.input).toEqual({ workspaceId: c.workspaceId, instanceId: null, volumeId: before.volumeId });
  });

  it("T6b Stop, then Close while the session is still STOPPING: the volume is still deleted, and nothing is left STOPPED", async () => {
    const c = await compose({ moneyStop });
    await c.prepareRunning();
    const before = await c.sessionNow();
    await cancelTask(c.h.deps, c.taskId);
    expect((await c.sessionNow()).state).toBe("STOPPING");
    await c.terminate();
    await c.sw.settle();
    expect(c.deleterRuns()).toHaveLength(1);
    expect(c.deleterRuns()[0]!.input).toEqual({ workspaceId: c.workspaceId, instanceId: before.instanceId, volumeId: before.volumeId });
    await c.reapTwice();
    expect((await c.sessionNow()).state).toBe("DELETED");
  });
});

describe("T3 a run whose worker answers the cancel is not stopped at the machine at all", () => {
  it("the worker ends itself during the flush wait: machines.stop is never called, the session stays READY", async () => {
    const c = await compose({ moneyStop: true });
    const plan = await c.planRunning();
    c.onWait.run = async () => { await c.h.flow.recordResult({ workspaceId: c.workspaceId, operationId: plan.operationId, fence: plan.fence, status: "CANCELLED" }); };
    await cancelTask(c.h.deps, c.taskId);
    expect(c.calls).not.toContain("stop");
    expect((await c.sessionNow()).state).toBe("READY");
    expect(c.deleterRuns()).toEqual([]);
  });
});

describe("T5 every other path that reaches machines.stop keeps the volume", () => {
  it("the spend stop of a run whose worker never ended it (the run-lost sweep, past the flush wait)", async () => {
    const c = await compose({ moneyStop: true });
    const plan = await c.planRunning();
    const before = await c.sessionNow();
    const operation = (await c.h.store.get(operationKey(COMPANY, c.workspaceId, plan.operationId))) as never;
    await requestSpendStop(c.h.deps, operation, "company_day_cap");
    c.h.clock.advance(10_000);
    await c.h.flow.sweepRunsOnce();
    expect(c.calls).toContain("stop");
    expect(c.deleteCalls).toEqual([]);
    expect(await c.sessionNow()).toMatchObject({ state: "STOPPING", volumeId: before.volumeId });
    expect(c.deleterRuns()).toEqual([]);
  });
});

describe("T4c the Docker adapter (laptop) keeps its folder on stop", () => {
  it("is pinned by the adapter's own suite: stop never removes the workspace, only terminate does", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("packages/broker/src/local/docker-worker-machines.ts", "utf8");
    const stop = source.slice(source.indexOf("async stop("), source.indexOf("async terminate("));
    expect(stop).not.toMatch(/\brm\(|rmSync|removeWorkspace/u);
  });
});
