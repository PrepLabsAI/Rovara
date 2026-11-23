import { IMPLICIT_COMPANY_ID as T1_COMPANY, USAGE_CHECKPOINTS_FEATURE } from "@agentx/contracts";
// The run-lost watchdog also ends a SETUP run whose worker went silent on a machine that is still up (setup-run-hang, prod P1): the page already read such a run as stopped, but its operation stayed
// RUNNING, so the project stayed "running" and its hold stayed open. The same rule (`setupRunGone`) ends the operation, and the unreported usage is kept as spent.
import { change } from "@agentx/contracts";
import { describe, expect, it } from "vitest";
import { operationKey, taskKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { SETUP_RUN_SILENT_MESSAGE } from "../../packages/broker/src/core/task-flow/run-watch.js";
import { SETUP_RUN_SILENT_MS } from "../../packages/broker/src/core/setup-agent/agent.js";
import type { OperationRecord, WorkspaceRecord } from "../../packages/broker/src/core/task-flow/records.js";
import { createHarness, newRequestId, type Harness } from "../support/task-flow-harness.js";
import type { MoneyStop } from "../../packages/broker/src/core/task-flow/money-stop.js";
import { endSilentSetupRun } from "../../packages/broker/src/core/task-flow/setup-run-watch.js";
import { runWatchKey, type RunWatchRecord } from "../../packages/broker/src/core/task-flow/run-watch-rows.js";

/** A running planning step, turned into a setup run's operation: its task is the project's setup task and the worker spoke at `seenAt`. */
async function runningSetup(h: Harness, seenAtSecondsAgo: number | undefined) {
  const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Set up the project", workflow: true, workflowPath: "FULL" });
  const drain = async (): Promise<void> => { for (let round = 0; round < 12; round += 1) { if ((await h.flow.dispatchOnce({ maxMessages: 10 })).received === 0) return; h.clock.advance(70); } };
  await drain();
  const workspace = (await h.store.get(workspaceKey(T1_COMPANY, started.task.workspaceId))) as unknown as WorkspaceRecord;
  const machineId = workspace.machine!.machineId;
  const prepare = h.machines.delivered(machineId).at(-1)!;
  h.machines.finish(machineId, prepare.operationId);
  await h.flow.recordResult({ workspaceId: workspace.id, operationId: prepare.operationId, fence: 1, status: "SUCCEEDED", outcome: { kind: "prepared" } });
  await drain();
  const plan = h.machines.delivered(machineId).at(-1)!;
  const seen = seenAtSecondsAgo === undefined ? undefined : new Date(h.deps.now!().getTime() - seenAtSecondsAgo * 1_000).toISOString();
  await h.store.update({ key: operationKey(T1_COMPANY, workspace.id, plan.operationId), ops: [change.set("workflowMode", "SETUP_AGENT")] });
  await h.store.update({ key: taskKey(started.task.taskId), ops: [change.set("purpose", "setup_agent"), ...(seen === undefined ? [] : [change.set("setupAgentSeenAt", seen)])] });
  return { workspaceId: workspace.id, operationId: plan.operationId };
}
const statusOf = async (h: Harness, run: { workspaceId: string; operationId: string }) => ((await h.store.get(operationKey(T1_COMPANY, run.workspaceId, run.operationId))) as unknown as OperationRecord);

describe("a setup run whose worker went silent on a machine that is still up", () => {
  it("keeps the whole hold of the run as spent (its usage never reached the broker)", async () => {
    const kept: Array<{ operationId: string }> = [];
    const h = createHarness({ machines: { features: ["task.workflowMode", "task.structuredPlans", USAGE_CHECKPOINTS_FEATURE] }, extra: () => ({ moneyStop: { pollMs: 1_000, sleep: async () => undefined, async keepWholeHold(_reservationId: string | undefined, mark: { operationId: string }) { kept.push(mark); } } satisfies MoneyStop }) });
    await h.registerProject();
    const run = await runningSetup(h, 30);
    h.clock.advance(SETUP_RUN_SILENT_MS / 1_000 + 1);
    expect(await h.flow.sweepRunsOnce()).toMatchObject({ interrupted: 1 });
    expect(kept.map((entry) => entry.operationId)).toEqual([run.operationId]);
    expect(await statusOf(h, run)).toMatchObject({ usageUnflushed: true });
  });
  it("is ended INTERRUPTED once the worker has been silent past the silence bound, and not before", async () => {
    const h = createHarness();
    await h.registerProject();
    const run = await runningSetup(h, 30);
    expect(await h.flow.sweepRunsOnce()).toMatchObject({ interrupted: 0, waiting: 1 });
    expect((await statusOf(h, run)).status).not.toBe("INTERRUPTED");
    h.clock.advance(SETUP_RUN_SILENT_MS / 1_000 + 1);
    expect(await h.flow.sweepRunsOnce()).toMatchObject({ interrupted: 1 });
    expect(await statusOf(h, run)).toMatchObject({ status: "INTERRUPTED", error: SETUP_RUN_SILENT_MESSAGE });
  });
  it("keeps a run whose worker is talking, and ends one that never spoke after the first-word hour", async () => {
    const h = createHarness();
    await h.registerProject();
    const talking = await runningSetup(h, 5);
    expect(await h.flow.sweepRunsOnce()).toMatchObject({ interrupted: 0 });
    expect((await statusOf(h, talking)).status).not.toBe("INTERRUPTED");
    const h2 = createHarness();
    await h2.registerProject();
    const mute = await runningSetup(h2, undefined);
    h2.clock.advance(30 * 60);
    expect(await h2.flow.sweepRunsOnce()).toMatchObject({ interrupted: 0 });
    h2.clock.advance(31 * 60);
    expect(await h2.flow.sweepRunsOnce()).toMatchObject({ interrupted: 1 });
    expect(await statusOf(h2, mute)).toMatchObject({ status: "INTERRUPTED", error: SETUP_RUN_SILENT_MESSAGE });
  });
  it("never ends an ordinary step for silence: only a setup run reports to the setup callback", async () => {
    const h = createHarness();
    await h.registerProject();
    const run = await runningSetup(h, 30);
    await h.store.update({ key: operationKey(T1_COMPANY, run.workspaceId, run.operationId), ops: [change.set("workflowMode", "PLAN")] });
    h.clock.advance(SETUP_RUN_SILENT_MS / 1_000 * 3);
    expect(await h.flow.sweepRunsOnce()).toMatchObject({ interrupted: 0 });
    expect((await statusOf(h, run)).status).not.toBe("INTERRUPTED");
  });
});

describe("review (lead 4 Opus): the worker's own result wins the race with the silence end", () => {
  it("keeps no hold as spent and records nothing when the operation already ended by the worker's result (its usage was booked)", async () => {
    const kept: Array<{ operationId: string }> = [];
    const h = createHarness({ machines: { features: ["task.workflowMode", "task.structuredPlans", USAGE_CHECKPOINTS_FEATURE] }, extra: () => ({ moneyStop: { pollMs: 1_000, sleep: async () => undefined, async keepWholeHold(_reservationId: string | undefined, mark: { operationId: string }) { kept.push(mark); } } satisfies MoneyStop }) });
    await h.registerProject();
    const run = await runningSetup(h, 30);
    h.clock.advance(SETUP_RUN_SILENT_MS / 1_000 + 1);
    // The sweep read the row and the operation while it was still running ...
    const row = (await h.store.get(runWatchKey(T1_COMPANY, run.workspaceId, run.operationId))) as unknown as RunWatchRecord;
    const stale = await statusOf(h, run);
    expect(["DISPATCHING", "RUNNING"]).toContain(stale.status);
    // ... and the worker's own result landed before the sweep's end.
    // (written straight to the operation, so the task is still open and only the operation's own end tells the two apart)
    await h.store.update({ key: operationKey(T1_COMPANY, run.workspaceId, run.operationId), ops: [change.set("status", "SUCCEEDED")] });
    const ended = await statusOf(h, run);
    expect(["SUCCEEDED", "FAILED"]).toContain(ended.status);
    expect(await endSilentSetupRun(h.deps, row, stale)).toBe("cleared");
    expect(kept).toEqual([]);
    expect((await statusOf(h, run)).usageUnflushed).toBeUndefined();
    expect((await statusOf(h, run)).status).toBe(ended.status);
  });
});
