// What bounds an unattended run, and what gives its allowance back. The rules that matter:
//   1. no run that carries a dollar limit starts where nothing enforces one (the default admission allows everything): the door refuses, and a trigger is not turned on;
//   2. a chain step holds only ITS share of the run's dollar limit, never more than the run has left, and the share it was told to Admission is that figure;
//   3. a reservation is settled when its run's task ends (with what the install says it cost), once; it is given back on every path where no run was made;
//   4. a task that is stopped is stopped by the step's timeout, the run's own time and a cancel; a step whose task waits for the owner does not time out; a retry never starts beside a task that may still run.
import { describe, expect, it } from "vitest";
import { NO_CAP_MESSAGE, startUnattendedRun, sweepUnattendedRuns, type AutomatedRunRequest } from "../../packages/core/src/core/automation/run-seam.js";
import { cancelChainRun, onStepEnded, readChainRun, readStepAttempts, startChainRun, stepShareUsd, sweepChainRuns } from "../../packages/core/src/core/chains/runner.js";
import { createTrigger, enableTrigger, triggerEnableRequest } from "../../packages/core/src/core/triggers/lifecycle.js";
import { COMPANY, OWNER, PROJECT, createAutomationWorld, publishAgent, publishChain, type AutomationWorld } from "../support/automation-world.js";

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const request = (n: number, usd?: number): AutomatedRunRequest => ({ requestId: uuid(n), project: PROJECT, agent: { agentId: "rovara-code" }, input: { text: "Go." }, origin: "event", limits: { maxMinutes: 30, ...(usd === undefined ? {} : { maxRunUsd: usd }) } });
const start = (world: AutomationWorld, chainId: string) => startChainRun(world.chainRuns, { orgId: COMPANY, chainId: chainId, project: PROJECT, origin: "app", startedBy: { kind: "member", developerId: "d".repeat(64) }, owner: { developerId: OWNER.personId } });
const twoSteps = (agentId: string, extra: Record<string, unknown> = {}) => ({
  start: "a",
  steps: [
    { kind: "agent", id: "a", name: "A", agent: { agentId, version: "current" }, next: { kind: "go", to: "b" }, ...extra },
    { kind: "agent", id: "b", name: "B", agent: { agentId, version: "current" }, next: { kind: "end" } },
  ],
  limits: { maxRunUsd: 6 },
});

describe("a dollar cap that nothing enforces", () => {
  it("is refused at the door, before Admission is asked, whether or not the run names a dollar limit; only a model-free job is let through", async () => {
    const world = createAutomationWorld();
    world.enforces.dollars = false;
    await expect(startUnattendedRun(world.unattended, request(1, 5))).rejects.toThrow(NO_CAP_MESSAGE);
    // No limit at all is the run with nothing holding it: it is refused too.
    await expect(startUnattendedRun(world.unattended, request(2))).rejects.toThrow(NO_CAP_MESSAGE);
    expect(world.admissions).toHaveLength(0);
    expect(world.starts).toHaveLength(0);
    // A model-free automatic job is given no model key: it has nothing to cap.
    await startUnattendedRun(world.unattended, { ...request(3), origin: "automatic", automatic: { job: "scheduled_check", purpose: "saved_env_rebuild" } });
    expect(world.starts).toHaveLength(1);
  });

  it("refuses a chain with no limit of its own on an install with no cap, and starts no task", async () => {
    const world = createAutomationWorld();
    world.enforces.dollars = false;
    const { agentId } = await publishAgent(world);
    const chainId = await publishChain(world, agentId, { limits: {} });
    const run = await start(world, chainId);
    expect(run).toMatchObject({ status: "failed", failure: { reason: "AGENT_BUDGET_REQUIRED" } });
    expect(world.starts).toHaveLength(0);
    expect(world.admissions).toHaveLength(0);
  });

  it("is told to the owner when a trigger is turned on, and the trigger stays off", async () => {
    const world = createAutomationWorld();
    const { agentId } = await publishAgent(world);
    const trigger = await createTrigger(world.dispatch, { orgId: COMPANY, target: { kind: "agent", agentId }, project: PROJECT, spec: { kind: "event", source: "github", type: "pull_request.opened" }, by: OWNER.personId });
    world.enforces.dollars = false;
    await expect(enableTrigger(world.dispatch, COMPANY, trigger.triggerId, world.proofFor(await triggerEnableRequest(world.dispatch, trigger)))).rejects.toThrow(/no dollar cap/u);
    expect((await world.triggers.get(COMPANY, trigger.triggerId))?.enabled).toBe(false);
  });

  it("tells Admission the figure the run is held to", async () => {
    const world = createAutomationWorld();
    await startUnattendedRun(world.unattended, request(3, 2.5));
    expect(world.admissions[0]?.estimate?.cost).toEqual({ micros: 2_500_000, currency: "USD" });
  });
});

describe("a chain step's share of the run's dollar limit", () => {
  it("is an equal share per agent step, never more than what the run has left", () => {
    const definition = { start: "a", steps: [{ kind: "agent" }, { kind: "agent" }, { kind: "agent" }] } as never;
    expect(stepShareUsd(definition, { runLimitUsd: 6 })).toBe(2);
    expect(stepShareUsd(definition, { runLimitUsd: 6, spentUsd: 5 })).toBe(1);
    expect(stepShareUsd(definition, { runLimitUsd: 6, spentUsd: 6 })).toBe(0);
    expect(stepShareUsd(definition, {})).toBeUndefined();
  });

  it("starts each step with its own share, and counts what a step really cost against the run", async () => {
    const world = createAutomationWorld();
    const { agentId } = await publishAgent(world);
    const chainId = await publishChain(world, agentId, twoSteps(agentId));
    world.chainRuns.stepSpendUsd = async () => 4;
    const run = await start(world, chainId);
    expect(world.starts[0]?.limits.maxRunUsd).toBe(3);
    expect(world.admissions[0]?.estimate?.cost?.micros).toBe(3_000_000);
    await onStepEnded(world.chainRuns, COMPANY, { taskId: "task-1", status: "succeeded", report: "Done." });
    // The first step cost 4 of the run's 6: the second may have 2, though its equal share is 3.
    expect(world.starts[1]?.limits.maxRunUsd).toBe(2);
    expect((await readChainRun(world.table, COMPANY, run.runId))?.spentUsd).toBe(4);
  });

  it("counts a step with no cost figure at the whole share it was granted, and fails the step that has nothing left", async () => {
    const world = createAutomationWorld();
    const { agentId } = await publishAgent(world);
    const design = { start: "a", steps: [{ kind: "agent", id: "a", name: "A", agent: { agentId, version: "current" }, next: { kind: "branch", choices: [{ id: "again", description: "Once more", to: "a", maxTraversals: 3 }, { id: "done", description: "Finish", to: "$end" }], default: "done" } }], limits: { maxRunUsd: 5 } };
    const chainId = await publishChain(world, agentId, design);
    const run = await start(world, chainId);
    await onStepEnded(world.chainRuns, COMPANY, { taskId: "task-1", status: "succeeded", report: "Again.", branch: "again" });
    expect(world.starts).toHaveLength(1);
    expect(await readChainRun(world.table, COMPANY, run.runId)).toMatchObject({ status: "failed", failure: { reason: "run_limit_used_up" } });
  });
});

describe("settling and releasing an unattended run's allowance", () => {
  it("settles a reservation once, when its task ends, with what the install says the task cost", async () => {
    const world = createAutomationWorld();
    await startUnattendedRun(world.unattended, request(10, 4));
    expect(world.settles).toEqual([]);
    expect(await sweepUnattendedRuns(world.unattended)).toMatchObject({ open: 1, settled: 0 });
    world.taskCosts.set("task-1", 1.25);
    world.taskStates.get("task-1")!.end = "succeeded";
    expect(await sweepUnattendedRuns(world.unattended)).toMatchObject({ settled: 1 });
    expect(world.settles).toEqual([{ id: "res-1", actual: { cost: { micros: 1_250_000, currency: "USD" } } }]);
    // A second pass finds nothing open: nothing is settled twice.
    expect(await sweepUnattendedRuns(world.unattended)).toMatchObject({ settled: 0, open: 0 });
    expect(world.settles).toHaveLength(1);
    expect(world.releases).toEqual([]);
  });

  it("settles a run whose task is gone, and a chain step's reservation like any other", async () => {
    const world = createAutomationWorld();
    const { agentId } = await publishAgent(world);
    const chainId = await publishChain(world, agentId);
    await start(world, chainId);
    world.taskStates.delete("task-1");
    expect(await sweepUnattendedRuns(world.unattended)).toMatchObject({ settled: 1 });
    expect(world.settles).toHaveLength(1);
  });

  it("gives the reservation back when Admission is held and the start is refused or fails with no run", async () => {
    const world = createAutomationWorld();
    world.starter.failWith = Object.assign(new Error("PROJECT_ARCHIVED: gone"), { code: "PROJECT_ARCHIVED" });
    await expect(startUnattendedRun(world.unattended, request(11, 1))).rejects.toThrow();
    world.starter.failWith = new Error("socket hang up");
    await expect(startUnattendedRun(world.unattended, request(12, 1))).rejects.toThrow();
    expect(world.releases).toEqual(["res-1", "res-2"]);
    expect(world.settles).toEqual([]);
  });

  it("stops a run that outlives its minutes, not counting the time its task waited for the owner", async () => {
    const world = createAutomationWorld();
    await startUnattendedRun(world.unattended, request(13, 1));
    world.taskStates.get("task-1")!.waiting = true;
    world.clock.now += 3 * 3_600_000;
    await sweepUnattendedRuns(world.unattended);
    expect(world.cancelled).toEqual([]);
    world.taskStates.get("task-1")!.waiting = false;
    world.clock.now += 10 * 60_000;
    await sweepUnattendedRuns(world.unattended);
    expect(world.cancelled).toEqual([]);
    world.clock.now += 25 * 60_000;
    await sweepUnattendedRuns(world.unattended);
    expect(world.cancelled).toEqual(["task-1"]);
    // It then ends, and settles on the next pass.
    expect(await sweepUnattendedRuns(world.unattended)).toMatchObject({ settled: 1 });
  });
});

describe("stopping a step's task", () => {
  const stepTimeout = (agentId: string, retries?: number) => ({ start: "a", steps: [{ kind: "agent", id: "a", name: "A", agent: { agentId, version: "current" }, timeoutMinutes: 10, ...(retries === undefined ? {} : { retries }), next: { kind: "end" } }], limits: { maxRunUsd: 5 } });

  it("does not time out a step whose task waits for the owner's approval, and counts its minutes from when it stopped waiting", async () => {
    const world = createAutomationWorld();
    const { agentId } = await publishAgent(world);
    const chainId = await publishChain(world, agentId, stepTimeout(agentId));
    const run = await start(world, chainId);
    world.taskStates.get("task-1")!.waiting = true;
    world.clock.now += 5 * 3_600_000;
    await sweepChainRuns(world.chainRuns);
    expect(world.cancelled).toEqual([]);
    expect((await readStepAttempts(world.table, COMPANY, run.runId))[0]).toMatchObject({ status: "running" });
    world.taskStates.get("task-1")!.waiting = false;
    world.clock.now += 5 * 60_000;
    await sweepChainRuns(world.chainRuns);
    expect(world.cancelled).toEqual([]);
    world.clock.now += 6 * 60_000;
    await sweepChainRuns(world.chainRuns);
    expect(world.cancelled).toEqual(["task-1"]);
    expect(await readChainRun(world.table, COMPANY, run.runId)).toMatchObject({ status: "timed_out" });
  });

  it("stops the task first, and while it cannot be stopped marks nothing and starts nothing", async () => {
    const world = createAutomationWorld();
    const { agentId } = await publishAgent(world);
    const chainId = await publishChain(world, agentId, stepTimeout(agentId, 1));
    world.chainRuns.stepSpendUsd = async () => 0.1;
    const run = await start(world, chainId);
    const stop = world.chainRuns.cancelTask!;
    world.chainRuns.cancelTask = async () => { throw new Error("the host is away"); };
    world.clock.now += 11 * 60_000;
    await sweepChainRuns(world.chainRuns);
    expect((await readStepAttempts(world.table, COMPANY, run.runId))[0]).toMatchObject({ status: "running" });
    expect(world.starts).toHaveLength(1);
    world.chainRuns.cancelTask = stop;
    await sweepChainRuns(world.chainRuns);
    // Stopped now: the attempt ends and, with its one retry, the step starts again, beside nothing that is running.
    expect(world.cancelled).toEqual(["task-1"]);
    expect(world.starts).toHaveLength(2);
    expect(world.taskStates.get("task-1")?.end).toBe("cancelled");
  });

  it("never retries beside a task that is still open: the run ends instead", async () => {
    const world = createAutomationWorld();
    const { agentId } = await publishAgent(world);
    const chainId = await publishChain(world, agentId, stepTimeout(agentId, 1));
    world.chainRuns.stepSpendUsd = async () => 0.1;
    const run = await start(world, chainId);
    // The host reports the task ended with a failure but still shows it open and cannot stop it.
    world.chainRuns.cancelTask = async () => undefined;
    await onStepEnded(world.chainRuns, COMPANY, { taskId: "task-1", status: "failed", reason: "boom" });
    expect(world.starts).toHaveLength(1);
    expect(await readChainRun(world.table, COMPANY, run.runId)).toMatchObject({ status: "failed", failure: { reason: "step_task_open" } });
  });

  it("never retries when the host cannot say whether the task is open", async () => {
    const world = createAutomationWorld();
    const { agentId } = await publishAgent(world);
    const chainId = await publishChain(world, agentId, stepTimeout(agentId, 1));
    world.chainRuns.taskOpen = undefined;
    // A cost figure keeps the run inside its limit, so the retry is refused for the right reason: the earlier task cannot be shown closed.
    world.chainRuns.stepSpendUsd = async () => 0.1;
    const run = await start(world, chainId);
    await onStepEnded(world.chainRuns, COMPANY, { taskId: "task-1", status: "failed", reason: "boom" });
    expect(world.starts).toHaveLength(1);
    expect(await readChainRun(world.table, COMPANY, run.runId)).toMatchObject({ status: "failed", failure: { reason: "step_task_open" } });
  });

  it("stops the step's task when the run is cancelled, and when the run's own time is up, even for a step whose start was only written", async () => {
    const world = createAutomationWorld();
    const { agentId } = await publishAgent(world);
    const chainId = await publishChain(world, agentId, twoSteps(agentId));
    const run = await start(world, chainId);
    await cancelChainRun(world.chainRuns, COMPANY, run.runId, "the owner");
    expect(world.cancelled).toEqual(["task-1"]);

    const slow = createAutomationWorld();
    const published = await publishAgent(slow);
    const slowChain = await publishChain(slow, published.agentId, { start: "a", steps: [{ kind: "agent", id: "a", name: "A", agent: { agentId: published.agentId, version: "current" }, timeoutMinutes: 1440, next: { kind: "end" } }], limits: { maxRunUsd: 5, maxRunHours: 2 } });
    await start(slow, slowChain);
    slow.clock.now += 3 * 3_600_000;
    await sweepChainRuns(slow.chainRuns);
    expect(slow.cancelled).toEqual(["task-1"]);

    // A step written `starting` whose task was already made (the record of it was lost): cancelling the run finds the task by the attempt's request id.
    const half = createAutomationWorld();
    const third = await publishAgent(half);
    const halfChain = await publishChain(half, third.agentId);
    half.starter.failWith = new Error("socket hang up");
    half.starter.failAfterCommit = true;
    const halfRun = await start(half, halfChain);
    expect((await readStepAttempts(half.table, COMPANY, halfRun.runId))[0]).toMatchObject({ status: "starting" });
    await cancelChainRun(half.chainRuns, COMPANY, halfRun.runId, "the owner");
    expect(half.cancelled).toEqual(["task-1"]);
  });
});
