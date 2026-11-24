// SETUP-CHECK-WATCH: a setup check whose preparation never settles (the worker's answer was refused or lost, the machine is healthy and idle) was left PREPARING and DISPATCHING for ever, and its machine running.
// The preparation watch (SETUP_WATCH, prepare-watch.ts) now covers a check as it covers a task's preparation, and an administrator can Stop a check (check-stop.ts). Each guard has a test that fails if it is removed.
import { describe, expect, it } from "vitest";
import { change, projectMetaKey } from "@agentx/contracts";
import { closeSetupCheck, setupStateOf, startProjectSetupCheck, SETUP_CHECK_STUCK_MS } from "../../packages/broker/src/core/setup-agent/check.js";
import { SETUP_CHECK_STOPPED_MESSAGE, stopProjectSetupChecks, stopSetupCheck } from "../../packages/broker/src/core/setup-agent/check-stop.js";
import { CHECK_STALLED_MESSAGE, PREPARATION_TIMEOUT_MS, expireStalledCheck, prepareWatchKey } from "../../packages/broker/src/core/task-flow/prepare-watch.js";
import { ADMIN_GRANT_MISSING, WORKSPACE_NOT_FOUND, stopWorkspaceAsAdministrator } from "../../packages/broker/src/core/task-flow/stop-request.js";
import { operationKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { runWatchKey } from "../../packages/broker/src/core/task-flow/run-watch-rows.js";
import type { OperationRecord, WorkspaceRecord } from "../../packages/broker/src/core/task-flow/records.js";
import { EVAL_HEALTH_RUN_MAX_MS } from "@agentx/contracts";
import { EVAL_HEALTH_WATCH_LIMIT_MS, launchEvalHealthRun } from "../../packages/broker/src/core/setup-agent/eval-health-launch.js";
import { prepareWatchItem } from "../../packages/broker/src/core/task-flow/prepare-watch.js";
import { CORE_JOBS } from "../../packages/broker/src/core-host/jobs.js";
import { createTaskFlow } from "../../packages/broker/src/core/task-flow/flow.js";
import { COMPANY, createHarness, newRequestId, type Harness } from "../support/task-flow-harness.js";

/** A project check, handed to a worker machine that took the preparation and never answers (the diagnosis: op DISPATCHING, machine healthy, no callback). */
async function deliveredCheck(h: Harness, project = "payments") {
  const started = await startProjectSetupCheck(h.deps, { project, requestId: newRequestId(), startedBy: "owner" });
  for (let round = 0; round < 12; round += 1) {
    if ((await h.flow.dispatchOnce({ maxMessages: 10 })).received === 0) break;
    h.clock.advance(70);
  }
  const workspace = (await h.store.get(workspaceKey(COMPANY, started.workspaceId))) as unknown as WorkspaceRecord;
  const operationId = workspace.activeOperationId as string;
  const operation = (await h.store.get(operationKey(COMPANY, started.workspaceId, operationId))) as unknown as OperationRecord;
  return { workspaceId: started.workspaceId, operationId, machineId: workspace.machine?.machineId, status: operation.status };
}

const workspaceOf = async (h: Harness, workspaceId: string) => (await h.store.get(workspaceKey(COMPANY, workspaceId))) as unknown as WorkspaceRecord;
const operationOf = async (h: Harness, workspaceId: string, operationId: string) => (await h.store.get(operationKey(COMPANY, workspaceId, operationId))) as unknown as OperationRecord;
const stateOf = async (h: Harness) => setupStateOf(h.deps, "payments", { revision: 1, setup: [], readiness: [] });
const machineState = async (h: Harness, machineId: string) => (await h.machines.health(machineId)).state;

describe("the setup check's preparation watch (bug A)", () => {
  it("uses the one limit the check's own status reads as failed at", () => {
    expect(PREPARATION_TIMEOUT_MS).toBe(SETUP_CHECK_STUCK_MS);
    expect(PREPARATION_TIMEOUT_MS).toBe(50 * 60_000);
  });

  it("ends the exact diagnosed check (prepare DISPATCHING, machine healthy and idle, no callback) after 50 minutes, closes the workspace, terminates the machine and reads failed", async () => {
    const h = createHarness();
    await h.registerProject();
    const check = await deliveredCheck(h);
    expect(check.status).toBe("DISPATCHING");
    expect(check.machineId).toBeDefined();
    // Everything the run-watch rule looks at says "fine": the machine is up, and the worker is idle (it finished and its answer was lost).
    h.machines.finish(check.machineId!, check.operationId);
    expect(await machineState(h, check.machineId!)).toBe("ready");
    const startedAt = Date.parse((await workspaceOf(h, check.workspaceId)).createdAt);

    // Inside the limit nothing is touched, however many sweeps run: the machine is healthy, so the machine-lost rule never fires either.
    h.clock.advance(Math.floor((startedAt + PREPARATION_TIMEOUT_MS - h.clock.now) / 1_000));
    expect(h.clock.now).toBe(startedAt + PREPARATION_TIMEOUT_MS);
    for (let sweep = 0; sweep < 3; sweep += 1) await h.flow.sweepRunsOnce();
    expect((await operationOf(h, check.workspaceId, check.operationId)).status).toBe("DISPATCHING");
    expect(await workspaceOf(h, check.workspaceId)).toMatchObject({ status: "PREPARING", activeOperationId: check.operationId });
    expect(await machineState(h, check.machineId!)).toBe("ready");

    h.clock.advance(1);
    await h.flow.sweepRunsOnce();
    expect(await operationOf(h, check.workspaceId, check.operationId)).toMatchObject({ status: "FAILED", error: CHECK_STALLED_MESSAGE });
    expect(await workspaceOf(h, check.workspaceId)).toMatchObject({ status: "CLOSED", closedFrom: "PREPARATION_FAILED", activeOperationId: null });
    expect(await machineState(h, check.machineId!)).toBe("terminated");
    expect(await h.store.get(prepareWatchKey(COMPANY, (await workspaceOf(h, check.workspaceId)).createdAt, check.workspaceId))).toBeUndefined();
    expect(await h.store.get(runWatchKey(COMPANY, check.workspaceId, check.operationId))).toBeUndefined();
    // The setup state shows the check failed, in plain words.
    expect(await stateOf(h)).toMatchObject({ status: "failed", failedStage: "other" });
    expect((await stateOf(h)).failedStep).toContain("didn't finish");
    // A later sweep changes nothing.
    const before = await operationOf(h, check.workspaceId, check.operationId);
    await h.flow.sweepRunsOnce();
    expect(await operationOf(h, check.workspaceId, check.operationId)).toEqual(before);
  });

  it("ends a check whose preparation was never delivered to a machine, the same way", async () => {
    const h = createHarness();
    await h.registerProject();
    const started = await startProjectSetupCheck(h.deps, { project: "payments", requestId: newRequestId(), startedBy: "owner" });
    const operationId = (await workspaceOf(h, started.workspaceId)).activeOperationId as string;
    h.clock.advance(PREPARATION_TIMEOUT_MS / 1_000 + 1);
    await h.flow.sweepRunsOnce();
    expect(await operationOf(h, started.workspaceId, operationId)).toMatchObject({ status: "FAILED", error: CHECK_STALLED_MESSAGE });
    expect(await workspaceOf(h, started.workspaceId)).toMatchObject({ status: "CLOSED", closedFrom: "PREPARATION_FAILED" });
  });

  it("leaves a check that finishes normally untouched (its result takes the watch; a later sweep past 50 minutes does nothing)", async () => {
    const h = createHarness();
    await h.registerProject();
    const check = await deliveredCheck(h);
    h.machines.finish(check.machineId!, check.operationId);
    await h.flow.recordResult({ workspaceId: check.workspaceId, operationId: check.operationId, fence: 1, status: "SUCCEEDED", outcome: { kind: "prepared" } });
    expect(await workspaceOf(h, check.workspaceId)).toMatchObject({ status: "CLOSED", closedFrom: "READY" });
    expect(await h.store.get(prepareWatchKey(COMPANY, (await workspaceOf(h, check.workspaceId)).createdAt, check.workspaceId))).toBeUndefined();
    h.clock.advance(PREPARATION_TIMEOUT_MS / 1_000 * 2);
    await h.flow.sweepRunsOnce();
    expect(await operationOf(h, check.workspaceId, check.operationId)).toMatchObject({ status: "SUCCEEDED" });
    expect(await workspaceOf(h, check.workspaceId)).toMatchObject({ status: "CLOSED", closedFrom: "READY" });
    expect(await stateOf(h)).toMatchObject({ status: "ready" });
  });

  it("a worker result that arrives just before the watch keeps its result (the watch ends only what is still open)", async () => {
    const h = createHarness();
    await h.registerProject();
    const check = await deliveredCheck(h);
    h.clock.advance(PREPARATION_TIMEOUT_MS / 1_000 + 5);
    const transact = h.store.transact.bind(h.store);
    let raced = false;
    h.store.transact = async (items) => {
      if (!raced && items.some((item) => item.kind === "update" && item.ops.some((op) => op.op === "set" && op.path[0] === "status" && op.value === "FAILED"))) {
        raced = true;
        await h.flow.recordResult({ workspaceId: check.workspaceId, operationId: check.operationId, fence: 1, status: "SUCCEEDED", outcome: { kind: "prepared" } });
      }
      return transact(items);
    };
    await h.flow.sweepRunsOnce();
    expect(raced).toBe(true);
    expect(await operationOf(h, check.workspaceId, check.operationId)).toMatchObject({ status: "SUCCEEDED" });
    expect(await workspaceOf(h, check.workspaceId)).toMatchObject({ status: "CLOSED", closedFrom: "READY" });
  });

  it("a task's preparation keeps the task's words and its own behaviour (the check's words apply only to a row with no task)", async () => {
    const h = createHarness();
    await h.registerProject();
    const { task } = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Rename a setting" });
    const workspace = await workspaceOf(h, task.workspaceId);
    h.clock.advance(PREPARATION_TIMEOUT_MS / 1_000 + 1);
    await h.flow.sweepRunsOnce();
    expect(await operationOf(h, task.workspaceId, workspace.activeOperationId as string)).toMatchObject({ status: "FAILED", error: "setup did not finish within 50 minutes; close this task and start a new one" });
  });

  it("ends a check that has no watch row (started before checks were watched), and only a check", async () => {
    const h = createHarness();
    await h.registerProject();
    const check = await deliveredCheck(h);
    const { task } = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Rename a setting" });
    const taskWorkspace = await workspaceOf(h, task.workspaceId);
    const createdAt = (await workspaceOf(h, check.workspaceId)).createdAt;
    await h.store.delete({ key: prepareWatchKey(COMPANY, createdAt, check.workspaceId) });
    // Too early: nothing.
    expect(await expireStalledCheck(h.deps, check.workspaceId, check.operationId, createdAt)).toBe(false);
    h.clock.advance(PREPARATION_TIMEOUT_MS / 1_000 + 1);
    // A task's workspace is not a check's: its preparation is the task's own watch's, never this.
    expect(await expireStalledCheck(h.deps, task.workspaceId, taskWorkspace.activeOperationId as string, taskWorkspace.createdAt)).toBe(false);
    expect((await operationOf(h, task.workspaceId, taskWorkspace.activeOperationId as string)).status).toBe("ACCEPTED");
    expect(await expireStalledCheck(h.deps, check.workspaceId, check.operationId, createdAt)).toBe(true);
    expect(await operationOf(h, check.workspaceId, check.operationId)).toMatchObject({ status: "FAILED", error: CHECK_STALLED_MESSAGE });
    expect(await machineState(h, check.machineId!)).toBe("terminated");
    expect(await expireStalledCheck(h.deps, check.workspaceId, check.operationId, createdAt)).toBe(false);
  });

  it("the scheduled run-watch (with its historical pass) ends an unwatched stuck check on a healthy machine, and is idempotent", async () => {
    const h = createHarness();
    await h.registerProject();
    const check = await deliveredCheck(h);
    await h.store.delete({ key: prepareWatchKey(COMPANY, (await workspaceOf(h, check.workspaceId)).createdAt, check.workspaceId) });
    const job = CORE_JOBS.find((row) => row.name === "run-watch")!;
    const pass = async (): Promise<void> => { await job.run({ flow: createTaskFlow(h.deps) } as Parameters<typeof job.run>[0], 30_000); };
    await pass();
    expect((await operationOf(h, check.workspaceId, check.operationId)).status).toBe("DISPATCHING");
    h.clock.advance(PREPARATION_TIMEOUT_MS / 1_000 + 1);
    // The historical pass walks one project per tick and starts over when a walk is complete, so the project's page comes round again within a pass or two.
    for (let tick = 0; tick < 3; tick += 1) await pass();
    expect(await operationOf(h, check.workspaceId, check.operationId)).toMatchObject({ status: "FAILED", error: CHECK_STALLED_MESSAGE });
    expect(await workspaceOf(h, check.workspaceId)).toMatchObject({ status: "CLOSED", closedFrom: "PREPARATION_FAILED" });
    expect(await machineState(h, check.machineId!)).toBe("terminated");
    const before = await operationOf(h, check.workspaceId, check.operationId);
    await pass();
    expect(await operationOf(h, check.workspaceId, check.operationId)).toEqual(before);
  });

  it("a check of another company is never settled by this company's watch row", async () => {
    const h = createHarness();
    await h.registerProject();
    const check = await deliveredCheck(h);
    const createdAt = (await workspaceOf(h, check.workspaceId)).createdAt;
    await h.store.update({ key: prepareWatchKey(COMPANY, createdAt, check.workspaceId), ops: [change.set("companyId", "org_aaaaaaaaaaaaaaaaaaaa")] });
    h.clock.advance(PREPARATION_TIMEOUT_MS / 1_000 + 5);
    await h.flow.sweepRunsOnce();
    expect(await workspaceOf(h, check.workspaceId)).toMatchObject({ status: "PREPARING" });
  });
});

describe("a watch row's own limit (the eval health run)", () => {
  const HEAD = "a".repeat(40);
  async function launched(h: Harness) {
    await h.registerProject({ name: "payments", revision: 1, repositories: [{ name: "web", url: "https://github.com/acme/web.git", path: "repo/web", defaultBranch: "main", credentialRef: "host-app" }], setup: [], readiness: [], orchestratorInstructions: "x" });
    expect(await launchEvalHealthRun(h.deps, { project: "payments", requestId: newRequestId(), claimId: newRequestId(), bases: [{ repositoryId: "web", baseCommitSha: HEAD }], owner: "maintainer" })).toBe(true);
    const [message] = await (await h.queues.queue("task-dispatch")).receive();
    const { workspaceId, operationId } = message!.body as { workspaceId: string; operationId: string };
    await h.store.update({ key: operationKey(COMPANY, workspaceId, operationId), ops: [change.set("status", "RUNNING")] });
    return { workspaceId, operationId };
  }

  it("limits an eval health run by its own window plus ten minutes, never by the default 50", async () => {
    expect(EVAL_HEALTH_WATCH_LIMIT_MS).toBeGreaterThanOrEqual(EVAL_HEALTH_RUN_MAX_MS + 10 * 60_000);
    const h = createHarness();
    const run = await launched(h);
    const created = Date.parse((await workspaceOf(h, run.workspaceId)).createdAt);
    h.clock.advance(Math.floor((created + EVAL_HEALTH_WATCH_LIMIT_MS - h.clock.now) / 1_000));
    await h.flow.sweepRunsOnce();
    expect((await operationOf(h, run.workspaceId, run.operationId)).status).toBe("RUNNING");
    h.clock.advance(1);
    await h.flow.sweepRunsOnce();
    expect(await operationOf(h, run.workspaceId, run.operationId)).toMatchObject({ status: "FAILED", error: "the run didn't finish within its time limit, so Rovara stopped it" });
    expect(await workspaceOf(h, run.workspaceId)).toMatchObject({ status: "CLOSED" });
  });

  it("a limit under the default never shortens the watch, and a row with no limit keeps 50 minutes", async () => {
    const h = createHarness();
    await h.registerProject();
    const check = await deliveredCheck(h);
    const createdAt = (await workspaceOf(h, check.workspaceId)).createdAt;
    const key = prepareWatchKey(COMPANY, createdAt, check.workspaceId);
    await h.store.update({ key, ops: [change.set("limitMs", 60_000)] });
    h.clock.advance(60 * 5);
    await h.flow.sweepRunsOnce();
    expect((await operationOf(h, check.workspaceId, check.operationId)).status).toBe("DISPATCHING");
    const plain = prepareWatchItem(COMPANY, createdAt, "w", "o");
    expect(plain.kind === "put" && "limitMs" in plain.item).toBe(false);
  });
});

describe("Stop for a setup check (C)", () => {
  it("ends the preparation CANCELLED with plain words, closes the workspace, terminates the machine and releases it; the check reads failed, and a repeat is a no-op", async () => {
    const h = createHarness();
    await h.registerProject();
    const check = await deliveredCheck(h);
    expect(await stopSetupCheck(h.deps, check.workspaceId)).toEqual({ found: true, nothingRunning: false });
    expect(await operationOf(h, check.workspaceId, check.operationId)).toMatchObject({ status: "CANCELLED", error: SETUP_CHECK_STOPPED_MESSAGE });
    expect(await workspaceOf(h, check.workspaceId)).toMatchObject({ status: "CLOSED", closedFrom: "PREPARATION_FAILED", activeOperationId: null });
    expect(await machineState(h, check.machineId!)).toBe("terminated");
    expect(await h.store.get(runWatchKey(COMPANY, check.workspaceId, check.operationId))).toBeUndefined();
    expect(await stateOf(h)).toMatchObject({ status: "failed" });
    expect((await stateOf(h)).failedStep).toContain("stopped");
    const before = [await operationOf(h, check.workspaceId, check.operationId), await workspaceOf(h, check.workspaceId)];
    expect(await stopSetupCheck(h.deps, check.workspaceId)).toEqual({ found: true, nothingRunning: true });
    expect([await operationOf(h, check.workspaceId, check.operationId), await workspaceOf(h, check.workspaceId)]).toEqual(before);
  });

  it("stops a check that was never delivered, and one a finished-but-unclosed workspace left behind is closed", async () => {
    const h = createHarness();
    await h.registerProject();
    const queued = await startProjectSetupCheck(h.deps, { project: "payments", requestId: newRequestId(), startedBy: "owner" });
    expect(await stopSetupCheck(h.deps, queued.workspaceId)).toEqual({ found: true, nothingRunning: false });
    expect(await workspaceOf(h, queued.workspaceId)).toMatchObject({ status: "CLOSED" });
    // A check whose preparation FAILED and whose close never ran (a store error): Stop closes it and says nothing was running.
    const second = await deliveredCheck(h);
    h.machines.finish(second.machineId!, second.operationId);
    await h.store.update({ key: operationKey(COMPANY, second.workspaceId, second.operationId), ops: [change.set("status", "FAILED")] });
    await h.store.update({ key: workspaceKey(COMPANY, second.workspaceId), ops: [change.set("status", "PREPARATION_FAILED"), change.set("activeOperationId", null)] });
    expect(await stopSetupCheck(h.deps, second.workspaceId)).toEqual({ found: true, nothingRunning: true });
    expect(await workspaceOf(h, second.workspaceId)).toMatchObject({ status: "CLOSED", closedFrom: "PREPARATION_FAILED" });
    expect(await machineState(h, second.machineId!)).toBe("terminated");
  });

  it("never touches a task's workspace (a setup RUN is a task too), a missing workspace or another company's", async () => {
    const h = createHarness();
    await h.registerProject();
    const { task } = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Rename a setting" });
    const workspace = await workspaceOf(h, task.workspaceId);
    // Even a task workspace that carries a check record (it never does) is a task's: the pointer decides.
    await h.store.put({ item: { pk: workspace.pk, sk: "SETUP_CHECK", entityType: "SETUP_CHECK", companyId: COMPANY, project: "payments", workspaceId: task.workspaceId, revision: 1, candidate: false, createdAt: workspace.createdAt } });
    expect(await stopSetupCheck(h.deps, task.workspaceId)).toEqual({ found: false, nothingRunning: true });
    expect(await workspaceOf(h, task.workspaceId)).toEqual(workspace);
    expect((await operationOf(h, task.workspaceId, workspace.activeOperationId as string)).status).toBe("ACCEPTED");
    expect(await stopSetupCheck(h.deps, "00000000-0000-4000-8000-000000000000")).toEqual({ found: false, nothingRunning: true });
    // A check of another company: its record names that company, so this company's runtime does not find it.
    const check = await deliveredCheck(h);
    await h.store.update({ key: { pk: (await workspaceOf(h, check.workspaceId)).pk, sk: "SETUP_CHECK" }, ops: [change.set("companyId", "org_aaaaaaaaaaaaaaaaaaaa")] });
    expect(await stopSetupCheck(h.deps, check.workspaceId)).toEqual({ found: false, nothingRunning: true });
    expect((await operationOf(h, check.workspaceId, check.operationId)).status).toBe("DISPATCHING");
  });

  it("stops the project's own check through the project's mark, and never a check the mark names for another project", async () => {
    const h = createHarness();
    await h.registerProject();
    const check = await deliveredCheck(h);
    expect(await stopProjectSetupChecks(h.deps, "ledger")).toEqual({ stopped: 0, nothingRunning: true });
    expect((await operationOf(h, check.workspaceId, check.operationId)).status).toBe("DISPATCHING");
    // A stale mark that names a check of ANOTHER project is not this project's to stop.
    await h.store.put({ item: { ...projectMetaKey(COMPANY, "ledger"), entityType: "PROJECT_META", setupCheck: { workspaceId: check.workspaceId, revision: 1, startedAt: "2026-11-09T10:00:00.000Z", startedBy: "owner" } } });
    expect(await stopProjectSetupChecks(h.deps, "ledger")).toEqual({ stopped: 0, nothingRunning: true });
    expect((await operationOf(h, check.workspaceId, check.operationId)).status).toBe("DISPATCHING");
    expect(await stopProjectSetupChecks(h.deps, "payments")).toEqual({ stopped: 1, nothingRunning: false });
    expect(await workspaceOf(h, check.workspaceId)).toMatchObject({ status: "CLOSED" });
    expect(await stopProjectSetupChecks(h.deps, "payments")).toEqual({ stopped: 0, nothingRunning: true });
  });

  it("the administrator's stop: a grant on the check's project and the check's company stop it; a refused grant, another company or an unknown workspace stop nothing", async () => {
    const h = createHarness();
    await h.registerProject();
    const check = await deliveredCheck(h);
    const asked: string[] = [];
    const refuse = async (project: string): Promise<void> => { asked.push(project); throw new Error("no grant"); };
    const grant = async (project: string): Promise<void> => { asked.push(project); };
    await expect(stopWorkspaceAsAdministrator(h.deps, check.workspaceId, { id: "admin", companyOf: async () => COMPANY }, refuse)).rejects.toThrow("no grant");
    expect(asked).toEqual(["payments"]);
    await expect(stopWorkspaceAsAdministrator(h.deps, check.workspaceId, { id: "admin", companyOf: async () => "org_aaaaaaaaaaaaaaaaaaaa" }, grant)).rejects.toMatchObject({ code: "NOT_FOUND", message: `NOT_FOUND: ${ADMIN_GRANT_MISSING}` });
    await expect(stopWorkspaceAsAdministrator(h.deps, check.workspaceId, { id: "admin", companyOf: async () => undefined }, grant)).rejects.toMatchObject({ code: "NOT_FOUND", message: `NOT_FOUND: ${ADMIN_GRANT_MISSING}` });
    await expect(stopWorkspaceAsAdministrator(h.deps, "00000000-0000-4000-8000-000000000000", { id: "admin", companyOf: async () => COMPANY }, grant)).rejects.toMatchObject({ code: "NOT_FOUND", message: `NOT_FOUND: ${WORKSPACE_NOT_FOUND}` });
    expect((await operationOf(h, check.workspaceId, check.operationId)).status).toBe("DISPATCHING");
    expect(h.audit.filter((event) => event.action === "setup_check.stop_requested")).toEqual([]);

    expect(await stopWorkspaceAsAdministrator(h.deps, check.workspaceId, { id: "admin", companyOf: async () => COMPANY }, grant)).toEqual({ nothingRunning: false });
    expect(await operationOf(h, check.workspaceId, check.operationId)).toMatchObject({ status: "CANCELLED" });
    expect(await workspaceOf(h, check.workspaceId)).toMatchObject({ status: "CLOSED" });
    expect(await machineState(h, check.machineId!)).toBe("terminated");
    // Idempotent: a repeat answers "nothing running".
    expect(await stopWorkspaceAsAdministrator(h.deps, check.workspaceId, { id: "admin", companyOf: async () => COMPANY }, grant)).toEqual({ nothingRunning: true });
  });

  it("the administrator's stop of a TASK's workspace is unchanged (a check's path is taken only for a workspace with no task)", async () => {
    const h = createHarness();
    await h.registerProject();
    const { task } = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Rename a setting" });
    const answer = await stopWorkspaceAsAdministrator(h.deps, task.workspaceId, { id: "admin", companyOf: async () => COMPANY }, async () => undefined);
    expect(answer).toMatchObject({ taskId: task.taskId });
  });
});

describe("a check's close is still the flow's own (closeSetupCheck)", () => {
  it("does not close a PREPARING check (the watch and the stop end its preparation first)", async () => {
    const h = createHarness();
    await h.registerProject();
    const check = await deliveredCheck(h);
    expect(await closeSetupCheck(h.deps, check.workspaceId)).toBe(false);
    expect(await workspaceOf(h, check.workspaceId)).toMatchObject({ status: "PREPARING" });
  });
});
