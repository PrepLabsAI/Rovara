// Automation on a running `rovara up`: hidden by default, and, when the owner switches it on, an owner-only way to turn work on. The rules that matter:
//   1. off (the default), nothing of it is there: the routes answer as before, the page is not found, a tick does nothing, and the switch is not something a route or a token can change;
//   2. on, a trigger is made OFF; the API token cannot turn one on (it is told where), and the page turns it on for exactly what it shows;
//   3. an event the trigger meets then starts a Rovara Code task in the human-gated workflow, as the owner, and the task waits for the owner's plan approval: nothing automatic approves anything;
//   4. what the trigger needs is read again at the event: a project that went away turns it off.
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, WORKER_INVOCATION_FEATURES, builtinDefaultPin, type Admission, type AdapterRegistry, type TriggerEvent } from "@agentx/contracts";
import { createIntervalScheduler } from "../../packages/local-adapters/src/interval-scheduler.js";
import { developerIdOf } from "../../packages/broker/src/core/sessions/create.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { change } from "@agentx/contracts";
import { startLocalRuntime, type LocalRuntime } from "../../packages/broker/src/local/runtime.js";
import { FakeWorkerMachines } from "../../packages/broker/src/ports/fake-worker-machines.js";
import { FakeDocker } from "../support/local/fake-docker.js";
import { formBody, formOf, raw } from "../support/local-pages-fakes.js";
import { NOT_ON_THIS_INSTALL_MESSAGE } from "../../packages/broker/src/local/app/routes.js";
import { TRIGGER_ON_ON_THE_PAGE } from "../../packages/broker/src/local/app/automation.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length > 0) await cleanup.pop()!(); });

const PROJECT = {
  name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://examplehost/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
};
interface ApiBody {
  error?: { code: string; message: string };
  trigger?: { triggerId: string; enabled: boolean };
  chain?: { chainId: string };
  run?: { runId: string; status: string; failure?: { reason: string }; startedBy?: { developerId: string } };
  steps?: Array<{ status: string; taskId?: string }>;
  triggersTurnedOff?: string[];
}
const LABELED = { kind: "event", source: "github", type: "issues.labeled", filter: { label: ["rovara"] } };

/** An admission that holds what it is asked: the stand-in for an adapter that enforces a dollar cap (the default admission allows everything, and then no unattended run with a dollar limit is started). */
function holdingAdmission(held: string[]): Admission {
  return { async admit(request) { held.push(request.idempotencyKey); return { allowed: true, reservationId: `res-${String(held.length)}` }; }, async stage() { return { decision: { allowed: true }, items: [] }; }, async settle() {}, async release() {} };
}

async function launch(environment: NodeJS.ProcessEnv = {}, options: { admission?: Admission; timers?: boolean; scheduler?: (registry: AdapterRegistry) => void; automation?: { enabled(): boolean } } = {}) {
  const root = await mkdtemp(join(tmpdir(), "rovara-auto-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const stateDirectory = join(root, "state");
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const runtime: LocalRuntime = await startLocalRuntime({
    stateDirectory, cwd: join(root, "project"), environment, gh: async () => undefined, workerImage: "worker:test", docker: new FakeDocker(), version: "9.9.9", timers: options.timers ?? false, storage: "memory", ...(options.automation === undefined ? {} : { automation: options.automation }),
    machines: new FakeWorkerMachines({ startingChecks: 0, features: [...WORKER_INVOCATION_FEATURES] }), openBrowser: async () => undefined,
    registerAdapters: (registry: AdapterRegistry) => { if (options.admission !== undefined) registry.register("admission", "holding", options.admission); options.scheduler?.(registry); },
  });
  cleanup.push(() => runtime.stop());
  const token = (await readFile(runtime.sessionTokenPath, "utf8")).trim();
  const api = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const response = await fetch(`${runtime.url}${path}`, { method: init.method ?? "GET", headers: { authorization: `Bearer ${token}`, ...(init.body === undefined ? {} : { "content-type": "application/json" }) }, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
    return { status: response.status, body: JSON.parse(await response.text()) as ApiBody };
  };
  const page = async (path: string) => { const link = new URL(runtime.pageLink(path)); return raw(runtime.pagesUrl, { path: link.pathname, headers: { host: link.host } }); };
  return { runtime, api, page, store: runtime.registry.require("storage") };
}

const issueLabeled = (key: string, label = "rovara"): TriggerEvent => ({
  source: "github", type: "issues.labeled", eventKey: key, occurredAt: new Date().toISOString(), project: "payments",
  subject: { kind: "issue", id: key, title: "The health endpoint is missing", url: "https://github.com/example/demo/issues/4" }, fields: { label: [label] }, actor: { kind: "external", id: "maya" },
});

describe("automation is hidden by default", () => {
  it("mounts nothing, shows nothing and starts nothing while it is off", async () => {
    const h = await launch();
    expect(await h.runtime.app.automation.enabled()).toBe(false);
    // The routes answer as they did before the feature existed.
    expect((await h.api("/v1/app/triggers")).status).toBe(404);
    const agents = await h.api("/v1/app/agents");
    expect(agents.body.error?.message).toBe(NOT_ON_THIS_INSTALL_MESSAGE);
    expect((await h.api("/v1/app/chains", { method: "POST", body: {} })).status).toBe(404);
    expect((await h.page("/automation")).status).toBe(404);
    expect(await h.runtime.app.automation.dispatch(issueLabeled("k"))).toEqual([]);
    await h.runtime.tick();
  });

  it("is switched on only by the process that runs it (the owner's environment), never by a request", async () => {
    const on = await launch({ ROVARA_AUTOMATION: "on" });
    expect(await on.runtime.app.automation.enabled()).toBe(true);
    const off = await launch({ ROVARA_AUTOMATION: "yes" });
    expect(await off.runtime.app.automation.enabled()).toBe(false);
    // Nothing in a request can switch it.
    await off.api("/v1/app/triggers", { method: "POST", body: { automation: "on" } });
    expect(await off.runtime.app.automation.enabled()).toBe(false);
  });
});

describe("automation switched on", () => {
  it("makes a trigger OFF, refuses the API token turning it on, and the page turns it on for exactly what it shows", async () => {
    const h = await launch({ ROVARA_AUTOMATION: "on" }, { admission: holdingAdmission([]) });
    await h.api("/v1/admin/projects", { method: "POST", body: PROJECT });
    const made = await h.api("/v1/app/triggers", { method: "POST", body: { target: { kind: "agent", agentId: "rovara-code" }, project: "payments", spec: LABELED } });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const triggerId = made.body.trigger!.triggerId;
    expect(made.body.trigger!.enabled).toBe(false);
    const refused = await h.api(`/v1/app/triggers/${triggerId}/on`, { method: "POST", body: {} });
    expect(refused.status).toBe(403);
    expect(refused.body.error?.message).toBe(TRIGGER_ON_ON_THE_PAGE.slice(0));
    // An event meets an OFF trigger and starts nothing.
    expect(await h.runtime.app.automation.dispatch(issueLabeled("early"))).toEqual([]);
    const shown = await h.page("/automation");
    expect(shown.status).toBe(200);
    expect(shown.body).toContain("Rovara Code");
    const form = formOf(shown.body, "/automation/act");
    expect(form.fields["op"]).toBe("trigger-on");
    const link = new URL(h.runtime.pageLink("/automation"));
    const actPath = new URL(form.action, "http://127.0.0.1").pathname;
    const post = await raw(h.runtime.pagesUrl, { method: "POST", path: actPath, headers: { host: link.host, origin: h.runtime.pagesUrl, "content-type": "application/x-www-form-urlencoded" }, body: formBody(form.fields) });
    expect(post.status).toBe(303);
    expect((await h.api(`/v1/app/triggers/${triggerId}`)).body.trigger!.enabled).toBe(true);
    // The same form a second time is refused: it answers once.
    const again = await raw(h.runtime.pagesUrl, { method: "POST", path: actPath, headers: { host: link.host, origin: h.runtime.pagesUrl, "content-type": "application/x-www-form-urlencoded" }, body: formBody(form.fields) });
    expect(String(again.headers["location"])).toContain("n=form");
  });

  it("starts a Rovara Code task in the human-gated workflow for a met event, once, and it waits for the owner's plan approval", async () => {
    const h = await launch({ ROVARA_AUTOMATION: "on" }, { admission: holdingAdmission([]) });
    await h.api("/v1/admin/projects", { method: "POST", body: PROJECT });
    const { automation } = h.runtime.app;
    const trigger = await automation.dispatchDeps.triggers.create({ record: { orgId: IMPLICIT_COMPANY_ID, triggerId: "ctr_aaaaaaaaaaaaaaaaaaaa", target: { kind: "agent", agentId: "rovara-code" }, project: "payments", spec: LABELED as never, enabled: true, approvedVersion: builtinDefaultPin("rovara-code"), maxRunsPerHour: 5, createdBy: "local-owner" } });
    const [outcome] = await automation.dispatch(issueLabeled("issue-4"));
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ outcome: "started" });
    const task = (await h.store.get({ pk: `DEVTASK#${outcome!.taskId}`, sk: "META" }))!;
    expect(task["title"]).toBe("Automatic: The health endpoint is missing");
    expect(task["project"]).toBe("payments");
    expect((task["workflow"] as { state?: string } | undefined)?.state).not.toBe("APPROVED");
    const decisions = ((task["workflow"] as { decisions?: unknown[] } | undefined)?.decisions ?? []);
    expect(decisions).toEqual([]);
    expect((await automation.dispatch(issueLabeled("issue-4")))[0]).toMatchObject({ outcome: "duplicate", taskId: outcome!.taskId });
    expect(await automation.triggers.get(IMPLICIT_COMPANY_ID, trigger.triggerId)).toMatchObject({ lastTaskId: outcome!.taskId });
  });

  it("refuses an event whose label is not the one the trigger names, and turns a trigger off when its project went away", async () => {
    const h = await launch({ ROVARA_AUTOMATION: "on" }, { admission: holdingAdmission([]) });
    await h.api("/v1/admin/projects", { method: "POST", body: PROJECT });
    const { automation } = h.runtime.app;
    await automation.dispatchDeps.triggers.create({ record: { orgId: IMPLICIT_COMPANY_ID, triggerId: "ctr_bbbbbbbbbbbbbbbbbbbb", target: { kind: "agent", agentId: "rovara-code" }, project: "payments", spec: LABELED as never, enabled: true, approvedVersion: builtinDefaultPin("rovara-code"), maxRunsPerHour: 5, createdBy: "local-owner" } });
    expect(await automation.dispatch(issueLabeled("other", "something-else"))).toEqual([]);
    // The agent has no filter naming the label: the trigger does not qualify, and is turned off at the event.
    await automation.dispatchDeps.triggers.create({ record: { orgId: IMPLICIT_COMPANY_ID, triggerId: "ctr_cccccccccccccccccccc", target: { kind: "agent", agentId: "rovara-code" }, project: "payments", spec: { kind: "event", source: "github", type: "issues.assigned" } as never, enabled: true, approvedVersion: builtinDefaultPin("rovara-code"), maxRunsPerHour: 5, createdBy: "local-owner" } });
    const [outcome] = await automation.dispatch({ ...issueLabeled("assigned"), type: "issues.assigned", fields: { assignee: ["maya"] } });
    expect(outcome).toMatchObject({ outcome: "failed", reason: "trigger_invalid" });
    expect((await automation.triggers.get(IMPLICIT_COMPANY_ID, "ctr_cccccccccccccccccccc"))?.enabled).toBe(false);
  });
});


const TWO_STEPS = { start: "first", steps: [
  { kind: "agent", id: "first", name: "First", agent: { agentId: "rovara-code", version: "current" }, next: { kind: "go", to: "second" } },
  { kind: "agent", id: "second", name: "Second", agent: { agentId: "rovara-code", version: "current" }, next: { kind: "end" } },
], limits: { maxRunUsd: 6 } };

async function startChain(h: Awaited<ReturnType<typeof launch>>, definition: unknown = TWO_STEPS) {
  await h.api("/v1/admin/projects", { method: "POST", body: PROJECT });
  const made = await h.api("/v1/app/chains", { method: "POST", body: { name: "Two steps", definition } });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const chainId = made.body.chain!.chainId;
  expect((await h.api(`/v1/app/chains/${chainId}/publish`, { method: "POST", body: {} })).status).toBe(200);
  const run = await h.api(`/v1/app/chains/${chainId}/runs`, { method: "POST", body: { project: "payments" } });
  expect(run.status, JSON.stringify(run.body)).toBe(201);
  const runId = run.body.run!.runId;
  const state = async () => (await h.api(`/v1/app/chain-runs/${runId}`)).body;
  return { chainId, runId, state, run: run.body.run! };
}

describe("a chain step's task that is closed", () => {
  it("ends the run cancelled and starts nothing more, however the task came to be closed", async () => {
    const h = await launch({ ROVARA_AUTOMATION: "on" }, { admission: holdingAdmission([]) });
    const { runId, state } = await startChain(h);
    const first = (await state()).steps![0]!;
    expect(first).toMatchObject({ status: "running" });
    // The owner closes the step's task. A close frees the slot and writes `releasedAt` with `closedAt`, which is not a finish.
    expect((await h.api(`/v1/dev/tasks/${first.taskId}/close`, { method: "POST", body: {} })).status).toBe(200);
    const closed = await h.store.get({ pk: `DEVTASK#${first.taskId}`, sk: "META" });
    expect(closed?.["closedAt"]).toBeDefined();
    expect(closed?.["releasedAt"]).toBeDefined();
    await h.runtime.tick();
    const after = await state();
    expect(after.run).toMatchObject({ status: "cancelled" });
    expect(after.steps!.map((step) => step.status)).toEqual(["cancelled"]);
    expect((await h.api("/v1/dev/tasks")).body["tasks" as never]).toHaveLength(1);
    void runId;
  });

  it("goes on only when the step's pull request was merged", async () => {
    const h = await launch({ ROVARA_AUTOMATION: "on" }, { admission: holdingAdmission([]) });
    const { state } = await startChain(h);
    const first = (await state()).steps![0]!;
    await h.runtime.tick();
    expect((await state()).steps).toHaveLength(1);
    await h.store.update({ key: { pk: `DEVTASK#${first.taskId}`, sk: "META" }, ops: [change.set(["workflow", "stage"], "MERGED")] });
    await h.runtime.tick();
    expect((await state()).steps!.map((step) => step.status)).toEqual(["succeeded", "running"]);
  });

  it("is stopped with its run: cancelling the run closes the step's task", async () => {
    const h = await launch({ ROVARA_AUTOMATION: "on" }, { admission: holdingAdmission([]) });
    const { runId, state } = await startChain(h);
    const first = (await state()).steps![0]!;
    expect((await h.api(`/v1/app/chain-runs/${runId}/cancel`, { method: "POST", body: {} })).body.run).toMatchObject({ status: "cancelled" });
    expect((await h.store.get({ pk: `DEVTASK#${first.taskId}`, sk: "META" }))?.["closedAt"]).toBeDefined();
  });

  it("names the owner by the real developer id, not a made-up one", async () => {
    const h = await launch({ ROVARA_AUTOMATION: "on" }, { admission: holdingAdmission([]) });
    const { run } = await startChain(h);
    expect(run.startedBy?.developerId).toBe(developerIdOf(localOwnerPrincipal()));
  });
});

describe("the dollar cap on a default install", () => {
  it("starts no unattended work where nothing enforces a cap, and says so; the owner can still see it on the page", async () => {
    const h = await launch({ ROVARA_AUTOMATION: "on" });
    const { state } = await startChain(h);
    const after = await state();
    expect(after.run).toMatchObject({ status: "failed", failure: { reason: "AGENT_BUDGET_REQUIRED" } });
    expect((await h.api("/v1/dev/tasks")).body["tasks" as never]).toHaveLength(0);
    const made = await h.api("/v1/app/triggers", { method: "POST", body: { target: { kind: "agent", agentId: "rovara-code" }, project: "payments", spec: LABELED } });
    const shown = await h.page("/automation");
    expect(shown.body).toContain("no dollar cap");
    expect(shown.body).not.toContain('value="trigger-on"');
    void made;
  });
});

describe("a publish while a trigger is on", () => {
  it("turns the chain's triggers off, and says which", async () => {
    const h = await launch({ ROVARA_AUTOMATION: "on" }, { admission: holdingAdmission([]) });
    const { chainId } = await startChain(h);
    const { automation } = h.runtime.app;
    await automation.dispatchDeps.triggers.create({ record: { orgId: IMPLICIT_COMPANY_ID, triggerId: "ctr_dddddddddddddddddddd", target: { kind: "chain", chainId }, project: "payments", spec: { kind: "event", source: "github", type: "pull_request.opened" } as never, enabled: true, approvedVersion: 1, maxRunsPerHour: 5, createdBy: "local-owner" } });
    expect((await h.api(`/v1/app/chains/${chainId}`)).status).toBe(200);
    const saved = await h.api(`/v1/app/chains/${chainId}/draft`, { method: "POST", body: { definition: { ...TWO_STEPS, limits: { maxRunUsd: 9 } }, expectedRevision: 1 } });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const published = await h.api(`/v1/app/chains/${chainId}/publish`, { method: "POST", body: {} });
    expect(published.body.triggersTurnedOff).toEqual(["ctr_dddddddddddddddddddd"]);
    expect((await automation.triggers.get(IMPLICIT_COMPANY_ID, "ctr_dddddddddddddddddddd"))?.enabled).toBe(false);
  });
});

describe("the scheduler it shares with the nightly run", () => {
  const counting = (subscribed: Array<(due: never) => Promise<void>>) => (registry: AdapterRegistry): void => {
    const inner = createIntervalScheduler({ store: registry.require("storage"), timer: false });
    registry.register("scheduler", "counting", { ...inner, capabilities: inner.capabilities, put: inner.put.bind(inner), remove: inner.remove.bind(inner), get: inner.get.bind(inner), subscribe: (handler) => { subscribed.push(handler); return inner.subscribe(handler); } });
  };
  const due = (triggerId: string, kind = "trigger") => ({ companyId: IMPLICIT_COMPANY_ID, scheduleId: `trigger-${triggerId}`, scheduledAt: new Date().toISOString(), slotId: "slot-1", attempt: 1, target: { kind, ref: { orgId: IMPLICIT_COMPANY_ID, triggerId } } }) as never;

  it("subscribes once for both, hears a schedule trigger's fire only while automation is on, and leaves the nightly's fires alone", async () => {
    const heardOn: Array<(due: never) => Promise<void>> = [];
    const on = await launch({ ROVARA_AUTOMATION: "on" }, { admission: holdingAdmission([]), timers: true, scheduler: counting(heardOn) });
    const { chainId } = await startChain(on);
    expect(heardOn).toHaveLength(1);
    expect(on.runtime.app.automation.schedulesSubscribed()).toBe(true);
    const { automation } = on.runtime.app;
    await automation.triggers.create({ record: { orgId: IMPLICIT_COMPANY_ID, triggerId: "ctr_eeeeeeeeeeeeeeeeeeee", target: { kind: "chain", chainId }, project: "payments", spec: { kind: "schedule", schedule: { kind: "interval", minutes: 60 }, timezone: "UTC", missed: "skip" } as never, enabled: true, approvedVersion: 1, maxRunsPerHour: 5, createdBy: "local-owner" } });
    await heardOn[0]!(due("ctr_eeeeeeeeeeeeeeeeeeee", "nightly"));
    expect((await automation.triggers.get(IMPLICIT_COMPANY_ID, "ctr_eeeeeeeeeeeeeeeeeeee"))?.lastFiredAt).toBeUndefined();
    await heardOn[0]!(due("ctr_eeeeeeeeeeeeeeeeeeee"));
    expect((await automation.triggers.get(IMPLICIT_COMPANY_ID, "ctr_eeeeeeeeeeeeeeeeeeee"))?.lastRunId).toBeDefined();

    const heardOff: Array<(due: never) => Promise<void>> = [];
    const off = await launch({}, { timers: true, scheduler: counting(heardOff) });
    expect(heardOff).toHaveLength(1);
    expect(off.runtime.app.automation.schedulesSubscribed()).toBe(false);
    await heardOff[0]!(due("ctr_eeeeeeeeeeeeeeeeeeee"));
  });
});

describe("more of what a closed or waiting task does, and an install with no cap", () => {
  it("ends the run cancelled when the task's workflow is CLOSED, even with no closedAt on the task", async () => {
    const h = await launch({ ROVARA_AUTOMATION: "on" }, { admission: holdingAdmission([]) });
    const { state } = await startChain(h);
    const first = (await state()).steps![0]!;
    // The system closes the workflow (not the owner's close): the stage says so, and the task has no closedAt.
    await h.store.update({ key: { pk: `DEVTASK#${first.taskId}`, sk: "META" }, ops: [change.set(["workflow", "stage"], "CLOSED")] });
    expect((await h.store.get({ pk: `DEVTASK#${first.taskId}`, sk: "META" }))?.["closedAt"]).toBeUndefined();
    await h.runtime.tick();
    const after = await state();
    expect(after.run).toMatchObject({ status: "cancelled" });
    expect(after.steps!.map((step) => step.status)).toEqual(["cancelled"]);
  });

  it("tells a task that waits for the owner from one that is running, and one that has ended", async () => {
    const h = await launch({ ROVARA_AUTOMATION: "on" }, { admission: holdingAdmission([]) });
    const { state } = await startChain(h);
    const taskId = (await state()).steps![0]!.taskId!;
    const { createTaskFlowTasks } = await import("../../packages/broker/src/local/app/automation.js");
    const tasks = createTaskFlowTasks({ flow: h.runtime.app.flow, owner: localOwnerPrincipal() });
    const key = { pk: `DEVTASK#${taskId}`, sk: "META" };
    const at = async (stage: string, workflowState: string) => { await h.store.update({ key, ops: [change.set(["workflow", "stage"], stage), change.set(["workflow", "state"], workflowState)] }); return tasks.read(taskId); };
    expect(await at("PLAN_REVIEW", "WAITING")).toEqual({ waiting: true });
    expect(await at("IMPLEMENT", "BLOCKED")).toEqual({ waiting: true });
    expect(await at("IMPLEMENT", "RUNNING")).toEqual({ waiting: false });
    expect(await at("MERGED", "COMPLETE")).toEqual({ end: "succeeded", waiting: false });
    expect(await tasks.read("00000000-0000-4000-8000-000000000000")).toBeUndefined();
  });

  it("refuses a chain that names no limit on an install with no cap, with the page's words, and starts no task", async () => {
    const h = await launch({ ROVARA_AUTOMATION: "on" });
    const { state } = await startChain(h, { ...TWO_STEPS, limits: {} });
    expect((await state()).run).toMatchObject({ status: "failed", failure: { reason: "AGENT_BUDGET_REQUIRED" } });
    expect((await h.api("/v1/dev/tasks")).body["tasks" as never]).toHaveLength(0);
    // The owner is told on the page, next to a trigger that could never start.
    await h.api("/v1/app/triggers", { method: "POST", body: { target: { kind: "agent", agentId: "rovara-code" }, project: "payments", spec: LABELED } });
    expect((await h.page("/automation")).body.includes("no dollar cap")).toBe(true);
  });

  it("hears schedules when the switch turns on after the install started", async () => {
    const heard: Array<(due: never) => Promise<void>> = [];
    const flag = { on: false, enabled() { return this.on; } };
    const h = await launch({}, { timers: true, automation: flag, scheduler: (registry) => {
      const inner = createIntervalScheduler({ store: registry.require("storage"), timer: false });
      registry.register("scheduler", "counting", { ...inner, capabilities: inner.capabilities, put: inner.put.bind(inner), remove: inner.remove.bind(inner), get: inner.get.bind(inner), subscribe: (handler) => { heard.push(handler); return inner.subscribe(handler); } });
    } });
    expect(h.runtime.app.automation.schedulesSubscribed()).toBe(false);
    flag.on = true;
    await h.runtime.tick();
    expect(h.runtime.app.automation.schedulesSubscribed()).toBe(true);
  });
});
