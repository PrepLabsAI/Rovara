// The nightly joined to the ports: the schedule follows the approved environment, the scheduler's delivery reaches the fire, the run is started through the task flow's seam, and the worker's result goes through
// the callback rules (the capability's task, the slot, the revision, the commit).
import { describe, expect, it } from "vitest";
import { NIGHTLY_RUN_ORIGIN, NIGHTLY_RUN_PURPOSE, NightlyRunPayloadSchema, ROVARA_CODE_AGENT_ID, agentXError, projectPk, type OrgId, type TestEnvironment } from "@rovara-code/contracts";
import { taskKey, taskPointerKey } from "../../packages/core/src/developer/task-records.js";
import { handleNightlyResultCallback, nightlyRunOfOperation, type NightlyOperation } from "../../packages/core/src/core/test-env/nightly-callback.js";
import { isNightlyOperation, nightlyEndItems, nightlyRequestId, nightlyRunPayloadOf, nightlyRunPort, nightlyRunText, skipReasonOf, type NightlyAutomaticRun } from "../../packages/core/src/core/test-env/nightly-run.js";
import { nightlyScheduleName, nightlySlotId, readNightlyBaseline } from "../../packages/core/src/core/test-env/nightly.js";
import { fireTestEnvNightly, nightlyHooks, subscribeNightly } from "../../packages/core/src/core/test-env/nightly-wiring.js";
import { readNightRows } from "../../packages/core/src/core/test-env/night-status.js";
import { nightlyRunsOn } from "../../packages/core/src/core/test-env/health-switch.js";
import { createFakeScheduler } from "../../packages/core/src/ports/fake-scheduler.js";
import { HEAD1, ORG, PROJECT, SCHEDULED, T0, approveForTest, body, nightlyWorld, result, rows } from "../support/nightly-world.js";
import { documentOf } from "../../packages/core/src/core/test-env/deps.js";
import { readApprovedTestEnvironment } from "../../packages/core/src/core/test-env/environment.js";

const ON = { ROVARA_NIGHTLY_HEALTH: "1" } as NodeJS.ProcessEnv;
const WORKSPACE = "w-nightly-1";
const TASK = "task-nightly-1";

describe("the switches", () => {
  it("nightly runs exist only when the nightly switch is exactly 1 and the test environment is not turned off", () => {
    expect(nightlyRunsOn({})).toBe(false);
    expect(nightlyRunsOn({ ROVARA_NIGHTLY_HEALTH: "true" })).toBe(false);
    expect(nightlyRunsOn({ ROVARA_NIGHTLY_HEALTH: " 1" })).toBe(false);
    expect(nightlyRunsOn(ON)).toBe(true);
    expect(nightlyRunsOn({ ...ON, ROVARA_TEST_ENVIRONMENT: "0" })).toBe(false);
  });
});

describe("the schedule follows the approved environment", () => {
  const approved = (nightly: Partial<TestEnvironment["environment"]["nightly"]>): TestEnvironment => ({ revision: 1, approvedAt: new Date(T0).toISOString(), environment: body(nightly) });

  it("makes one schedule for a project that turned the nightly on, with the project's own time, and replaces it on the next approval", async () => {
    const scheduler = createFakeScheduler();
    const hooks = nightlyHooks({ scheduling: { scheduler } }, ON);
    await hooks.onApproved(ORG, PROJECT, approved({ cronUtc: "30 2 * * *" }));
    expect(scheduler.all().map((entry) => [entry.scheduleId, entry.when, entry.enabled, entry.target])).toEqual([[nightlyScheduleName(ORG, PROJECT), { kind: "cron", cron: "30 2 * * *", timezone: "UTC" }, true, { kind: "nightly", ref: { project: PROJECT } }]]);
    await hooks.onApproved(ORG, PROJECT, approved({ cronUtc: "0 4 * * *" }));
    expect(scheduler.all()).toHaveLength(1);
    expect(scheduler.all()[0]?.when).toEqual({ kind: "cron", cron: "0 4 * * *", timezone: "UTC" });
  });

  it("removes the project's schedule when the approved environment has it off, and makes none for a project that never had it on", async () => {
    const scheduler = createFakeScheduler();
    const hooks = nightlyHooks({ scheduling: { scheduler } }, ON);
    await hooks.onApproved(ORG, PROJECT, approved({ enabled: false }));
    expect(scheduler.all()).toEqual([]);
    await hooks.onApproved(ORG, PROJECT, approved({}));
    expect(scheduler.all()).toHaveLength(1);
    await hooks.onApproved(ORG, PROJECT, approved({ enabled: false }));
    expect(scheduler.all()).toEqual([]);
  });

  it("with the test environment off nothing is made, removed or asked, whatever the environment says", async () => {
    const scheduler = createFakeScheduler();
    let proved = 0;
    const hooks = nightlyHooks({ scheduling: { scheduler }, onProved: async () => { proved += 1; } }, { ROVARA_TEST_ENVIRONMENT: "0" });
    await hooks.onApproved(ORG, PROJECT, approved({}));
    expect(scheduler.all()).toEqual([]);
    expect(proved).toBe(0);
  });

  it("an install with no scheduler to ask makes nothing; a scheduler that says unavailable fails the call after the other step ran", async () => {
    await expect(nightlyHooks({}, ON).onApproved(ORG, PROJECT, approved({}))).resolves.toBeUndefined();
    let proved = 0;
    const down = createFakeScheduler();
    down.put = async () => { throw agentXError("RUNTIME_UNAVAILABLE", "scheduler down"); };
    const hooks = nightlyHooks({ scheduling: { scheduler: down }, onProved: async () => { proved += 1; } }, ON);
    await expect(hooks.onApproved(ORG, PROJECT, approved({}))).rejects.toThrow(/scheduler down/u);
    expect(proved).toBe(1);
    // A replay of an approval proves nothing new.
    await expect(hooks.onApproved(ORG, PROJECT, approved({}), { replayed: true })).rejects.toThrow(/scheduler down/u);
    expect(proved).toBe(1);
  });

  it("an hourly cron is refused before anything reaches the scheduler, and the approval's caller sees it", async () => {
    const scheduler = createFakeScheduler();
    await expect(nightlyHooks({ scheduling: { scheduler } }, ON).onApproved(ORG, PROJECT, approved({ cronUtc: "0 6 15 * 1" }))).rejects.toThrow(/day of the month/u);
    expect(scheduler.all()).toEqual([]);
  });
});

describe("a delivery from the scheduler", () => {
  it("with the nightly off reads nothing, and with no way to start a run charges and claims nothing", async () => {
    const h = await nightlyWorld();
    expect(await fireTestEnvNightly(h.deps, h.due(), h.deps.runs, {})).toEqual({ outcome: "off" });
    expect(await fireTestEnvNightly(h.deps, h.due(), h.deps.runs, { ...ON, ROVARA_TEST_ENVIRONMENT: "0" })).toEqual({ outcome: "off" });
    expect(await fireTestEnvNightly(h.deps, h.due(), undefined, ON)).toEqual({ outcome: "skipped", reason: "run_unavailable" });
    expect(h.admitted).toEqual([]);
    expect(await rows(h.store, "TESTENV#NIGHTLY#")).toEqual([]);
  });

  it("reaches the fire through the subscription: the scheduler's delivery starts one run, and a second delivery of the same fire starts nothing", async () => {
    const h = await nightlyWorld();
    const scheduler = createFakeScheduler();
    const log: unknown[] = [];
    subscribeNightly({ scheduler, deps: h.deps, runs: h.deps.runs, env: ON, log: (entry) => log.push(entry) });
    await scheduler.put({ companyId: ORG, scheduleId: nightlyScheduleName(ORG, PROJECT), when: { kind: "cron", cron: "0 6 * * *", timezone: "UTC" }, enabled: true, target: { kind: "nightly", ref: { project: PROJECT } } });
    expect(await scheduler.fireForTest(ORG, nightlyScheduleName(ORG, PROJECT), SCHEDULED)).toBe(true);
    expect(await scheduler.fireForTest(ORG, nightlyScheduleName(ORG, PROJECT), SCHEDULED)).toBe(true);
    expect(h.started).toHaveLength(1);
    expect(log).toEqual([{ event: "test_env.nightly_fire", outcome: "started", attempt: 1 }, { event: "test_env.nightly_fire", outcome: "skipped", reason: "already_handled", attempt: 1 }]);
  });

  it("leaves another feature's schedule alone, and passes a fault that may pass to the scheduler so it delivers the fire again", async () => {
    const h = await nightlyWorld();
    const scheduler = createFakeScheduler();
    subscribeNightly({ scheduler, deps: h.deps, runs: h.deps.runs, env: ON });
    await scheduler.put({ companyId: ORG, scheduleId: "chain-1", when: { kind: "every", minutes: 5 }, enabled: true, target: { kind: "chain", ref: { chain: "x" } } });
    expect(await scheduler.fireForTest(ORG, "chain-1", SCHEDULED)).toBe(true);
    expect(h.started).toEqual([]);
    h.startFails.value = true;
    await scheduler.put({ companyId: ORG, scheduleId: nightlyScheduleName(ORG, PROJECT), when: { kind: "cron", cron: "0 6 * * *", timezone: "UTC" }, enabled: true, target: { kind: "nightly", ref: { project: PROJECT } } });
    expect(await scheduler.fireForTest(ORG, nightlyScheduleName(ORG, PROJECT), SCHEDULED)).toBe(false);
    h.startFails.value = false;
    expect(await scheduler.fireForTest(ORG, nightlyScheduleName(ORG, PROJECT), SCHEDULED)).toBe(true);
    expect(h.started).toHaveLength(1);
  });

  it("a project whose approved environment has the nightly run off starts nothing", async () => {
    const h = await nightlyWorld({ enabled: false });
    expect(await fireTestEnvNightly(h.deps, h.due(), h.deps.runs, ON)).toEqual({ outcome: "skipped", reason: "nightly_off" });
    expect(h.started).toEqual([]);
  });
});

describe("starting the run through the task flow's seam", () => {
  const dueRun = (over: Partial<Parameters<typeof nightlyRunPort>[0]> = {}) => {
    const started: NightlyAutomaticRun[] = [];
    return { started, port: (h: Awaited<ReturnType<typeof nightlyWorld>>) => nightlyRunPort({
      store: h.store, now: () => h.deps.now(), admitProject: async () => undefined, defaultBranchOf: async () => "main", usesRegistries: async () => false, headOf: async () => HEAD1,
      startAutomaticRun: async (input) => { started.push(input); }, ...over }) };
  };

  it("starts a model-free run of the project's own with the facts the broker fixed, and the approver is on the record only", async () => {
    const h = await nightlyWorld();
    const { started, port } = dueRun();
    const slotId = nightlySlotId(ORG, PROJECT, SCHEDULED);
    expect(await port(h).startRun({ orgId: ORG, project: PROJECT, branch: "main", headSha: HEAD1, envRevision: 1, slotId, payer: { kind: "project", project: PROJECT }, source: "nightly_baseline" })).toBeUndefined();
    expect(started).toEqual([{
      orgId: ORG, project: PROJECT, job: "nightly", requestId: nightlyRequestId(slotId), agent: { agentId: ROVARA_CODE_AGENT_ID }, input: { text: nightlyRunText(PROJECT) },
      origin: NIGHTLY_RUN_ORIGIN, purpose: NIGHTLY_RUN_PURPOSE, setupApprovedBy: "person_a", nightlyRun: { slotId, envRevision: 1, branch: "main", headSha: HEAD1 },
    }]);
    expect(nightlyRequestId(slotId)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(nightlyRequestId(slotId)).toBe(nightlyRequestId(slotId));
    expect(nightlyRequestId("e".repeat(64))).not.toBe(nightlyRequestId(slotId));
  });

  it("still runs when no person is recorded as having approved the revision", async () => {
    const h = await nightlyWorld();
    await h.store.update({ key: { pk: projectPk(ORG, PROJECT), sk: "TESTENV#REV#00000001" }, ops: [{ op: "remove", path: ["approvedBy"] }] });
    const { started, port } = dueRun();
    await port(h).startRun({ orgId: ORG, project: PROJECT, branch: "main", headSha: HEAD1, envRevision: 1, slotId: "a".repeat(64), payer: { kind: "project", project: PROJECT }, source: "nightly_baseline" });
    expect(started[0]?.setupApprovedBy).toBeUndefined();
  });

  it("a night that cannot run today (a refusal with a known code) is a skip; a fault that may pass is thrown", async () => {
    const h = await nightlyWorld();
    const input = { orgId: ORG, project: PROJECT, branch: "main", headSha: HEAD1, envRevision: 1, slotId: "a".repeat(64), payer: { kind: "project" as const, project: PROJECT }, source: "nightly_baseline" as const };
    for (const [code, reason] of [["PROJECT_BUDGET_EXCEEDED", "budget"], ["TASK_STOP_TIME", "budget"], ["WORKSPACE_LIMIT", "workspace_limit"], ["FORBIDDEN", "owner_unavailable"], ["PROJECT_ARCHIVED", "owner_unavailable"]] as const) {
      const { port } = dueRun({ startAutomaticRun: async () => { throw Object.assign(new Error("no"), { code }); } });
      expect(await port(h).startRun(input), code).toEqual({ skipped: reason });
      expect(skipReasonOf(Object.assign(new Error("no"), { code }))).toBe(reason);
    }
    const { port } = dueRun({ startAutomaticRun: async () => { throw new Error("worker pool down"); } });
    await expect(port(h).startRun(input)).rejects.toThrow("worker pool down");
    const skipped = dueRun({ startAutomaticRun: async () => ({ skipped: "budget" as const }) });
    expect(await skipped.port(h).startRun(input)).toEqual({ skipped: "budget" });
    expect(skipReasonOf(new Error("plain"))).toBeUndefined();
  });

  it("sends the worker the approved environment of the revision the run was started for, and nothing else is accepted", async () => {
    const h = await nightlyWorld();
    const run = { slotId: "a".repeat(64), envRevision: 1, branch: "main", headSha: HEAD1 };
    const payload = await nightlyRunPayloadOf(h.deps, ORG, PROJECT, run);
    expect(NightlyRunPayloadSchema.safeParse(payload).success).toBe(true);
    expect(payload.environment).toEqual((await readApprovedTestEnvironment(h.deps, ORG, PROJECT))?.environment);
    await expect(nightlyRunPayloadOf(h.deps, ORG, PROJECT, { ...run, envRevision: 2 })).rejects.toThrow(/environment changed/u);
    await expect(nightlyRunPayloadOf(h.deps, ORG, PROJECT, { ...run, branch: "release" })).rejects.toThrow(/environment changed/u);
  });
});

describe("who is granted the nightly action", () => {
  it("only the verification operation of a nightly task: not another mode of it, not a task with no purpose", () => {
    expect(isNightlyOperation({ purpose: "nightly_run" }, "CHECKS")).toBe(true);
    expect(isNightlyOperation({ purpose: "nightly_run" }, "IMPLEMENT")).toBe(false);
    expect(isNightlyOperation({ purpose: "nightly_run" }, undefined)).toBe(false);
    expect(isNightlyOperation({}, "CHECKS")).toBe(false);
    expect(isNightlyOperation(undefined, "CHECKS")).toBe(false);
    expect(isNightlyOperation({ purpose: "setup_draft" }, "CHECKS")).toBe(false);
  });
});

describe("the result route", () => {
  async function running(over: { task?: Record<string, unknown>; operation?: Partial<NightlyOperation> } = {}) {
    const h = await nightlyWorld();
    const fire = await (await import("../../packages/core/src/core/test-env/nightly.js")).handleNightlyFire(h.deps, h.due());
    if (fire.outcome !== "started") throw new Error("not started");
    const nightlyRun = { slotId: fire.slotId, envRevision: 1, branch: "main", headSha: HEAD1 };
    await h.store.put({ item: documentOf({ ...taskKey(TASK), entityType: "DEVELOPER_TASK", orgId: ORG, taskId: TASK, project: PROJECT, workspaceId: WORKSPACE, purpose: "nightly_run", nightlyRun, ...over.task }) });
    await h.store.put({ item: { ...taskPointerKey(WORKSPACE), entityType: "DEVELOPER_TASK_POINTER", taskId: TASK } });
    const operation: NightlyOperation = { kind: "task", workflowMode: "CHECKS", status: "RUNNING", workspaceId: WORKSPACE, orgId: ORG, ...over.operation };
    const deps = { ...h.deps, maps: h.mapStore };
    return { h, deps, operation, slotId: fire.slotId };
  }
  const send = (r: Awaited<ReturnType<typeof running>>, over: Record<string, unknown> = {}, env = ON) => {
    const data = result(r.slotId, over);
    return handleNightlyResultCallback(r.deps, r.operation, { result: data.result, coverageMap: data.coverageMap }, env);
  };

  it("with the switch off answers CALLBACK_FORBIDDEN and reads nothing", async () => {
    const r = await running();
    await expect(send(r, {}, { ROVARA_NIGHTLY_HEALTH: "0" })).rejects.toMatchObject({ code: "CALLBACK_FORBIDDEN" });
    expect(await readNightlyBaseline(r.deps, ORG, PROJECT)).toBeUndefined();
  });

  it("records the night for the run it was started for: the baseline and the map; the lock is released; the org and project come from the task", async () => {
    const r = await running();
    expect(await nightlyRunOfOperation(r.deps, r.operation)).toMatchObject({ orgId: ORG, project: PROJECT, taskId: TASK });
    expect(await send(r)).toMatchObject({ recorded: true });
    expect(await readNightlyBaseline(r.deps, ORG, PROJECT)).toMatchObject({ headSha: HEAD1 });
    expect(await rows(r.h.store, "TESTENV#NIGHTLY#ACTIVE")).toEqual([]);
    // Recorded once: the run is no longer waiting.
    await expect(send(r)).rejects.toThrow(/no nightly run is waiting/u);
  });

  it("tells the listener once the baseline is stored", async () => {
    const r = await running();
    const heard: unknown[] = [];
    const data = result(r.slotId);
    await handleNightlyResultCallback({ ...r.deps, onRecorded: async (recorded) => { heard.push(recorded.slotId); } }, r.operation, { result: data.result, coverageMap: data.coverageMap }, ON);
    expect(heard).toEqual([r.slotId]);
  });

  it("a forged slot is refused: a valid operation cannot record a night for another slot, and the real slot stays waiting", async () => {
    const r = await running();
    await expect(send(r, { slotId: "f".repeat(64) })).rejects.toMatchObject({ code: "CALLBACK_FORBIDDEN" });
    expect(await rows(r.h.store, "TESTENV#NIGHTLY#ACTIVE")).toHaveLength(1);
    expect(await readNightlyBaseline(r.deps, ORG, PROJECT)).toBeUndefined();
  });

  it("another commit, another revision or an unreadable body is refused", async () => {
    const r = await running();
    await expect(send(r, { headSha: "c".repeat(40) })).rejects.toMatchObject({ code: "CALLBACK_FORBIDDEN" });
    await expect(send(r, { envRevision: 2 })).rejects.toMatchObject({ code: "CALLBACK_FORBIDDEN" });
    await expect(handleNightlyResultCallback(r.deps, r.operation, { nonsense: true }, ON)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(handleNightlyResultCallback(r.deps, r.operation, { result: { nonsense: true } }, ON)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(await rows(r.h.store, "TESTENV#NIGHTLY#ACTIVE")).toHaveLength(1);
  });

  it("another company's operation, an operation that is not running, not a task, not the verification mode, or whose task has closed, is refused", async () => {
    const r = await running();
    for (const operation of [{ orgId: "org_bbbbbbbbbbbbbbbbbbbb" }, { status: "SUCCEEDED" }, { kind: "prepare" }, { workflowMode: "IMPLEMENT" }, { workspaceId: "w-other" }]) {
      await expect(handleNightlyResultCallback(r.deps, { ...r.operation, ...operation }, { result: {} }, ON), JSON.stringify(operation)).rejects.toMatchObject({ code: "CALLBACK_FORBIDDEN" });
    }
    const closed = await running({ task: { closedAt: new Date(T0).toISOString() } });
    await expect(send(closed)).rejects.toMatchObject({ code: "CALLBACK_FORBIDDEN" });
    const notNightly = await running({ task: { purpose: "setup_draft" } });
    await expect(send(notNightly)).rejects.toMatchObject({ code: "CALLBACK_FORBIDDEN" });
    const wrongWorkspace = await running({ task: { workspaceId: "another" } });
    await expect(send(wrongWorkspace)).rejects.toMatchObject({ code: "CALLBACK_FORBIDDEN" });
    expect(await nightlyRunOfOperation(r.deps, { ...r.operation, orgId: "org_bbbbbbbbbbbbbbbbbbbb" })).toBeUndefined();
  });

  it("accepts the hosted product's task rows too (`orgId` or `companyId` names the company)", async () => {
    const r = await running({ task: { orgId: undefined, companyId: ORG } });
    expect(await send(r)).toMatchObject({ recorded: true });
  });

  it("a failure the worker reports is a row in fixed words; the lock is given back, the day's claim stays; an unknown word is refused", async () => {
    const r = await running();
    expect(await handleNightlyResultCallback(r.deps, r.operation, { failed: { reason: "wall_clock" } }, ON)).toEqual({ recorded: false, failed: "wall_clock" });
    expect((await readNightRows(r.deps, ORG, PROJECT)).map((row) => row.reason)).toEqual(["wall_clock"]);
    expect(await rows(r.h.store, "TESTENV#NIGHTLY#ACTIVE")).toEqual([]);
    expect((await rows(r.h.store, "TESTENV#NIGHTLY#DAY#")).length).toBe(1);
    await expect(handleNightlyResultCallback(r.deps, r.operation, { failed: { reason: "my own words" } }, ON)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});

describe("the end of the task", () => {
  const task = { taskId: TASK, purpose: "nightly_run", project: PROJECT, orgId: ORG as OrgId, nightlyRun: { slotId: "a".repeat(64), envRevision: 1, branch: "main", headSha: HEAD1 } };

  it("a finished or cancelled nightly task gives back its workspace through agentRunEnd; a failed prepare too; nothing else", () => {
    const now = new Date(T0).toISOString();
    const end = (state: string) => [{ kind: "update", key: taskKey(TASK), ops: [{ op: "setIfAbsent", path: ["agentRunEnd"], value: { state, at: now } }, { op: "set", path: ["updatedAt"], value: now }], condition: { op: "exists", path: ["pk"] } }];
    expect(nightlyEndItems(task, { kind: "task", workflowMode: "CHECKS" }, { status: "SUCCEEDED" }, now)).toEqual(end("COMPLETE"));
    expect(nightlyEndItems(task, { kind: "task", workflowMode: "CHECKS" }, { status: "CANCELLED" }, now)).toEqual(end("CANCELLED"));
    expect(nightlyEndItems(task, { kind: "prepare" }, { status: "SUCCEEDED" }, now)).toEqual([]);
    expect(nightlyEndItems(task, { kind: "task", workflowMode: "IMPLEMENT" }, { status: "SUCCEEDED" }, now)).toEqual([]);
    expect(nightlyEndItems({ ...task, purpose: "setup_draft" }, { kind: "task", workflowMode: "CHECKS" }, { status: "SUCCEEDED" }, now)).toEqual([]);
    expect(nightlyEndItems(task, { kind: "prepare" }, { status: "FAILED" }, now)).toHaveLength(2);
  });

  it("an operation that ends in failure with no word from the worker leaves an infra row; the worker's own word stands; a stop and a success leave none", async () => {
    const h = await nightlyWorld();
    const now = new Date(T0).toISOString();
    const items = nightlyEndItems(task, { kind: "task", workflowMode: "CHECKS" }, { status: "FAILED" }, now);
    expect(items).toHaveLength(2);
    await h.store.put({ item: { ...taskKey(TASK), entityType: "DEVELOPER_TASK" } });
    expect((await h.store.transact(items)).applied).toBe(true);
    expect((await readNightRows(h.deps, ORG, PROJECT)).map((row) => row.reason)).toEqual(["infra"]);
    expect((await h.store.get(taskKey(TASK)))?.["agentRunEnd"]).toEqual({ state: "FAILED", at: now });
    // The first value is kept: a late repeat changes nothing.
    await h.store.transact(nightlyEndItems(task, { kind: "task", workflowMode: "CHECKS" }, { status: "SUCCEEDED" }, new Date(T0 + 1_000).toISOString()));
    expect((await h.store.get(taskKey(TASK)))?.["agentRunEnd"]).toEqual({ state: "FAILED", at: now });
    expect(nightlyEndItems(task, { kind: "task", workflowMode: "CHECKS" }, { status: "CANCELLED" }, now)).toHaveLength(1);
    expect(nightlyEndItems(task, { kind: "task", workflowMode: "CHECKS" }, { status: "SUCCEEDED" }, now)).toHaveLength(1);
  });
});

describe("a later approval", () => {
  it("is the revision the next fire starts for", async () => {
    const h = await nightlyWorld();
    await approveForTest(h.store, body({ cronUtc: "0 7 * * *" }), 2);
    await (await import("../../packages/core/src/core/test-env/nightly.js")).handleNightlyFire(h.deps, h.due());
    expect(h.started[0]).toMatchObject({ envRevision: 2 });
  });
});
