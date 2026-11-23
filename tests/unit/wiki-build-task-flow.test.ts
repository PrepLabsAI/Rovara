// Wiki W3b: the wiki build as a task of the task flow. Start (one transaction with the pointer, a read-only pinned preparation), the first step (WIKI_BUILD with the limits and pins and its own callback capability), the end
// (the first end word stands, the workspace is given back), the payer (the project, whatever surface started it) and the hosted standing rule (the person the run is for must still manage the project).
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { PREPARE_PIN_MOVED_LEGACY_MARKER, PREPARE_PIN_MOVED_MARKER, SETUP_AGENT_LIMITS_DEFAULT, WIKI_BUILD_WORDS, WORKER_INVOCATION_FEATURES, type OrgId } from "@agentx/contracts";
import { createTaskTokenDescriber } from "../../packages/broker/src/core/model-gateway/describer.js";
import { createWikiBuildStarter } from "../../packages/broker/src/core/wiki-build/starter.js";
import { continueWikiBuild, readWikiBuildPointer, resnapshotWikiBuild, startWikiBuild, wikiBuildPointerItem, wikiBuildState, type WikiBuildDeps, type WikiBuildPointer } from "../../packages/broker/src/core/wiki-build/run.js";
import { startTask } from "../../packages/broker/src/core/task-flow/start.js";
import { operationKey, taskKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { locateWorkspace } from "../../packages/broker/src/core/task-flow/workspace-location.js";
import { hostedTaskAccess, setupRunStandingFrom, NOT_A_MEMBER_HERE } from "../../packages/broker/src/aws/core-engine-root.js";
import { SETUP_RUN_NOT_ALLOWED } from "../../packages/broker/src/core-host/setup-run-routes.js";
import { createHarness, definition, type Harness } from "../support/task-flow-harness.js";
import { API_SHA, area, fileMap, repoEntry } from "../support/wiki-build-fixtures.js";

const companyId = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const HEAD = "b".repeat(40);
const features = [...WORKER_INVOCATION_FEATURES];

interface Built { h: Harness; deps: WikiBuildDeps; cancelled: string[]; ended: Array<{ project: string; taskId: string }> }

function build(options: { features?: string[]; standing?: "manage" | "view" } = {}): Built {
  const cancelled: string[] = [];
  const ended: Array<{ project: string; taskId: string }> = [];
  const h = createHarness({
    companyId, machines: { startingChecks: 0, features: options.features ?? features },
    extra: () => ({ wikiBuildEnded: async (scope) => { ended.push({ project: scope.project, taskId: scope.taskId }); } }),
  });
  const map = { ...fileMap([repoEntry("demo", [area("src", { rank: 1 })])]), project: "payments" };
  const deps: WikiBuildDeps = {
    store: h.store, companyId, now: () => h.deps.now!().getTime(), starter: createWikiBuildStarter({ flow: h.deps, caller: h.owner, cancel: async (request) => { cancelled.push(request.taskId); } }),
    standing: async () => ({ access: options.standing ?? "manage" }), modelAccessConfigured: true, aiKey: async () => "connected",
    fileMap: async () => map, defaultBranchHeads: async () => [{ repo: "demo", commit: HEAD }], limitSetting: async () => ({ budgetCents: 700, pageReserveCents: 50 }),
  };
  return { h, deps, cancelled, ended };
}

async function started(b: Built) {
  await b.h.registerProject();
  await startWikiBuild(b.deps, b.h.owner.principal.personId, "payments", { requestId: randomUUID(), notes: "src matters" });
  const pointer = (await readWikiBuildPointer(b.h.store, companyId, "payments"))!;
  const task = (await b.h.store.get(taskKey(pointer.taskId)))!;
  return { pointer, task, workspaceId: task["workspaceId"] as string };
}

/** Delivers the preparation and answers it as the worker would, then delivers the build step. */
async function toBuildStep(b: Built, workspaceId: string) {
  expect(await b.h.flow.dispatchOnce()).toMatchObject({ delivered: 1 });
  const machine = ((await locateWorkspace(b.h.deps, workspaceId))!.workspace["machine"] as { machineId: string }).machineId;
  const [prepare] = b.h.machines.delivered(machine);
  await b.h.flow.recordResult({ workspaceId, operationId: prepare!.operationId, fence: prepare!.fence, status: "SUCCEEDED", outcome: { kind: "prepared", base: [{ repositoryId: "demo", baseCommitSha: HEAD }] } });
  expect(await b.h.flow.dispatchOnce()).toMatchObject({ delivered: 1 });
  const job = b.h.machines.delivered(machine)[1]!;
  return { prepare: prepare!, job, machine };
}

describe("start: a task with purpose wiki_build, the pointer in the same transaction", () => {
  it("writes the task, its pointer, its notes and a read-only pinned preparation together", async () => {
    const b = build();
    const startExtras = vi.fn(() => ({ items: [] }));
    b.h.deps.startExtras = startExtras;
    const { pointer, task, workspaceId } = await started(b);
    expect(startExtras).toHaveBeenCalledWith(expect.objectContaining({ purpose: "wiki_build" }));
    expect(task).toMatchObject({ purpose: "wiki_build", project: "payments", wikiBuild: { limits: { budgetCents: 700, pageReserveCents: 50 }, pins: [{ repo: "demo", commit: HEAD }] } });
    expect(task["setupAgentLimits"]).toBeUndefined();
    expect(pointer).toMatchObject({ taskId: task["taskId"], payer: { kind: "project", project: "payments" } });
    const taskPointer = (await b.h.store.get((await locateWorkspace(b.h.deps, workspaceId))!.taskPointerKey()))!;
    expect(taskPointer["pendingWorkflowMode"]).toBe("WIKI_BUILD");
    // The preparation only clones, and refuses a repository that is not at the commit the broker pinned.
    expect(await b.h.flow.dispatchOnce()).toMatchObject({ delivered: 1 });
    const machine = ((await locateWorkspace(b.h.deps, workspaceId))!.workspace["machine"] as { machineId: string }).machineId;
    expect(b.h.machines.delivered(machine)[0]).toMatchObject({ kind: "prepare", payload: { readOnly: true, pins: [{ repository: "demo", commit: HEAD }] } });
  });

  // MUTANT atomic start: the pointer is written after the task (or without its condition), so a lost race leaves a task with no pointer, or two runs.
  it("a pointer that moved refuses the whole start: no task, no workspace, WORKSPACE_BUSY", async () => {
    const b = build();
    await b.h.registerProject();
    const first = await startTask(b.h.deps, b.h.owner, { project: "payments", requestId: randomUUID(), instructions: "x" }, { wikiBuild: { wire: { limits: { pages: 300, budgetCents: 700, wallClockMin: 180, pageReserveCents: 50 }, pins: [{ repo: "demo", commit: HEAD }] }, itemsFor: (taskId) => [wikiBuildPointerItem(pointerOf(taskId), undefined)] } });
    const before = await b.h.store.query({ pk: `ORG#${companyId}#WIKI_BUILD#payments` });
    // A second start that read "no pointer" while the first wrote one: its transaction fails and nothing of it exists.
    await expect(startTask(b.h.deps, b.h.owner, { project: "payments", requestId: randomUUID(), instructions: "y" }, { wikiBuild: { wire: { limits: { pages: 300, budgetCents: 700, wallClockMin: 180, pageReserveCents: 50 }, pins: [{ repo: "demo", commit: HEAD }] }, itemsFor: (taskId) => [wikiBuildPointerItem(pointerOf(taskId), undefined)] } }))
      .rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
    expect((await b.h.store.query({ pk: `ORG#${companyId}#WIKI_BUILD#payments` })).items).toEqual(before.items);
    expect((await readWikiBuildPointer(b.h.store, companyId, "payments"))!.taskId).toBe(first.task.taskId);
  });

  // MUTANT payer: the starter accepts any payer (a member), so a person's own limit pays for the build.
  it("a start that names a payer other than the project starts nothing", async () => {
    const b = build();
    await b.h.registerProject();
    const starter = createWikiBuildStarter({ flow: b.h.deps, caller: b.h.owner, cancel: async () => undefined });
    const request = { requestId: randomUUID(), project: "payments", text: "x", limits: { pages: 1, budgetCents: 100, wallClockMin: 10, pageReserveCents: 10 }, pins: [{ repo: "demo", commit: HEAD }], pointerItemFor: (taskId: string) => wikiBuildPointerItem(pointerOf(taskId), undefined), notesItemFor: () => undefined };
    await expect(starter.start({ ...request, payer: { kind: "member", developerId: "a".repeat(64) } as never })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(starter.start({ ...request, payer: { kind: "project", project: "other" } })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(await readWikiBuildPointer(b.h.store, companyId, "payments")).toBeUndefined();
  });

});

function pointerOf(taskId: string): WikiBuildPointer {
  return {
    orgId: companyId, project: "payments", taskId, requestId: randomUUID(), requestedBy: "p", startedAt: "2026-11-09T10:00:00.000Z", limits: { pages: 300, budgetCents: 700, wallClockMin: 180, pageReserveCents: 50 },
    pins: [{ repo: "demo", commit: HEAD }], plan: [], keptFromEarlier: [], doneIds: [], pagesWritten: 0, claimsKept: 0, claimsDropped: 0, spentCents: 0, spentEarlierCents: 0, payer: { kind: "project", project: "payments" }, buildKind: "first",
  };
}

describe("the end", () => {

  it("a run whose worker fails with no word ends infrastructure; a cancel after Stop is the person's stop; the first word stands", async () => {
    const failed = build();
    const f = await started(failed);
    const fs = await toBuildStep(failed, f.workspaceId);
    await failed.h.flow.recordResult({ workspaceId: f.workspaceId, operationId: fs.job.operationId, fence: fs.job.fence, status: "FAILED", error: "boom" });
    expect((await readWikiBuildPointer(failed.h.store, companyId, "payments"))!.end).toMatchObject({ word: "infrastructure" });

    const stopped = build();
    const s = await started(stopped);
    const ss = await toBuildStep(stopped, s.workspaceId);
    await stopped.h.store.update({ key: { pk: `ORG#${companyId}#WIKI_BUILD#payments`, sk: "RUN" }, ops: [{ op: "set", path: ["stop"], value: { by: "p", at: "2026-11-09T10:01:00.000Z" } }] } as never);
    await stopped.h.flow.recordResult({ workspaceId: s.workspaceId, operationId: ss.job.operationId, fence: ss.job.fence, status: "CANCELLED" });
    expect((await readWikiBuildPointer(stopped.h.store, companyId, "payments"))!.end).toMatchObject({ word: "stopped_by_person" });
    // A repeat of the end changes nothing.
    await stopped.h.flow.recordResult({ workspaceId: s.workspaceId, operationId: ss.job.operationId, fence: ss.job.fence, status: "CANCELLED" });
    expect((await readWikiBuildPointer(stopped.h.store, companyId, "payments"))!.end).toMatchObject({ word: "stopped_by_person" });
  });

});

describe("the payer is the project", () => {
  async function describing(origin: string, purpose: string | undefined) {
    const b = build();
    await b.h.registerProject();
    const started = purpose === "wiki_build"
      ? await startTask(b.h.deps, b.h.owner, { project: "payments", requestId: randomUUID(), instructions: "x" }, { wikiBuild: { wire: { limits: { pages: 1, budgetCents: 100, wallClockMin: 10, pageReserveCents: 10 }, pins: [{ repo: "demo", commit: HEAD }] }, itemsFor: () => [] } })
      : await b.h.flow.start(b.h.owner, { project: "payments", instructions: "x", requestId: randomUUID() });
    const workspace = (await b.h.store.get(workspaceKey(companyId, started.task.workspaceId)))!;
    const scope = { workspaceId: started.task.workspaceId, operationId: workspace["activeOperationId"] as string, fence: 1 };
    const key = operationKey(companyId, scope.workspaceId, scope.operationId);
    const operation = { ...(await b.h.store.get(key))!, kind: "task", status: "RUNNING", workflowMode: purpose === "wiki_build" ? "WIKI_BUILD" : "PLAN", requester: { personId: "a".repeat(64), provider: "test" }, dispatch: { kind: "task", payload: {} } };
    delete (operation as Record<string, unknown>)["programStepId"];
    await b.h.store.put({ item: operation });
    b.h.deps.modelAccess = { route: async () => ({ alias: "claude-sonnet-4-5", api: "anthropic-messages", catalog: "claude-sonnet-4-5" }) };
    const tk = taskKey(started.task.taskId);
    await b.h.store.put({ item: { ...(await b.h.store.get(tk))!, origin } });
    return createTaskTokenDescriber(b.h.deps).describe(scope);
  }

  // MUTANT payer: the describer ignores the task's purpose, so a build started from the app is paid by the person who pressed Build.
  it.each(["app"])("a wiki build started from %s is paid by the project, its monthly limit, never the person", async (origin) => {
    expect(await describing(origin, "wiki_build")).toMatchObject({ project: "payments", payer: { kind: "project", project: "payments" }, step: "wiki_build" });
  });

});

describe("hosted standing: the person the run is for must still manage the project", () => {
  const ORG = "org_staging0000000000001" as OrgId;
  const OTHER = "org_other00000000000001" as OrgId;
  const memberships: Record<string, { companyId: OrgId; role: "owner" | "admin" | "member" }> = {
    owner: { companyId: ORG, role: "owner" }, padmin: { companyId: ORG, role: "member" }, dev: { companyId: ORG, role: "member" }, foreign: { companyId: OTHER, role: "owner" },
  };
  const grants: Record<string, "developer" | "administrator"> = { padmin: "administrator", dev: "developer" };
  const standing = setupRunStandingFrom({ membershipOf: async (id) => memberships[id], projectGrantRole: async (id, project) => (project === "payments" ? grants[id] : undefined) });

  it("a wiki build task steps only while its person manages the project; the refusal is the build's own words", async () => {
    const { MemoryDocumentStore } = await import("../../packages/broker/src/ports/memory-document-store.js");
    const store = new MemoryDocumentStore();
    const task = async (taskId: string, developerId: string, extra: Record<string, unknown>) => store.put({ item: { pk: `DEVTASK#${taskId}`, sk: "META", taskId, developerId, project: "payments", companyId: ORG, ...extra } });
    await task("wiki-owner", "owner", { purpose: "wiki_build" });
    await task("wiki-padmin", "padmin", { purpose: "wiki_build" });
    await task("wiki-dev", "dev", { purpose: "wiki_build" });
    await task("wiki-foreign-row", "owner", { purpose: "wiki_build", companyId: OTHER });
    await task("setup-dev", "dev", { purpose: "setup_agent" });
    await task("plain-owner", "owner", {});
    const projectGrant = async (id: string, project: string) => project === "payments" && grants[id] !== undefined;
    const access = hostedTaskAccess({ companyId: ORG, membershipOf: async (id) => memberships[id], projectGrant, storage: async () => store, setupRunStanding: standing });
    expect(await access.checkStep({ taskId: "wiki-owner", developerId: "owner", project: "payments" })).toEqual({ allowed: true });
    expect(await access.checkStep({ taskId: "wiki-padmin", developerId: "padmin", project: "payments" })).toEqual({ allowed: true });
    // A project user with a grant (who lost the admin standing) is refused in the build's words, not the setup run's.
    expect(await access.checkStep({ taskId: "wiki-dev", developerId: "dev", project: "payments" })).toEqual({ allowed: false, message: WIKI_BUILD_WORDS.notAllowed });
    expect(await access.checkStep({ taskId: "setup-dev", developerId: "dev", project: "payments" })).toEqual({ allowed: false, message: SETUP_RUN_NOT_ALLOWED });
    // Another company's stored row, and another company's person, never step.
    expect(await access.checkStep({ taskId: "wiki-foreign-row", developerId: "owner", project: "payments" })).toEqual({ allowed: false, message: NOT_A_MEMBER_HERE });
    expect(await access.checkStep({ taskId: "wiki-owner", developerId: "foreign", project: "payments" })).toEqual({ allowed: false, message: NOT_A_MEMBER_HERE });
    // An owner with no grant: the build runs on the manage rule, an ordinary task on the grant rule (unchanged).
    expect(await access.checkStep({ taskId: "plain-owner", developerId: "owner", project: "payments" })).toMatchObject({ allowed: false });
    // Without the rule wired, a wiki build is held to the grant rule (never looser).
    const plain = hostedTaskAccess({ companyId: ORG, membershipOf: async (id) => memberships[id], projectGrant, storage: async () => store });
    expect(await plain.checkStep({ taskId: "wiki-owner", developerId: "owner", project: "payments" })).toMatchObject({ allowed: false });
  });
});
// The stale pin of the prod wiki build (2026-11-23): the build pinned the commit its kept file map was read at, the default branch moved before the worker cloned it, the preparation refused, and the run ended with
// the generic "could not go on" while Continue (which reuses the pins) could never work. A moved branch is now read at the pin by the worker; a pin the branch no longer holds ends the run with its own words, and the next Build pins again.
describe("a preparation that finds the pinned commit gone from the default branch", () => {
  const MOVED = "c".repeat(40);
  const movedError = `the commit the control plane pinned for demo ${PREPARE_PIN_MOVED_MARKER} (main); start again to pin the current head`;
  const legacyError = `the default branch of demo ${PREPARE_PIN_MOVED_LEGACY_MARKER}; try again`;

  /** Delivers the run's preparation to its machine and answers it FAILED with `error`, as the worker would. */
  async function failPreparation(b: Built, workspaceId: string, error: string) {
    expect(await b.h.flow.dispatchOnce()).toMatchObject({ delivered: 1 });
    const machine = ((await locateWorkspace(b.h.deps, workspaceId))!.workspace["machine"] as { machineId: string }).machineId;
    const [prepare] = b.h.machines.delivered(machine);
    await b.h.flow.recordResult({ workspaceId, operationId: prepare!.operationId, fence: prepare!.fence, status: "FAILED", error });
  }
  async function preparationFailed(b: Built, error: string) {
    const run = await started(b);
    await failPreparation(b, run.workspaceId, error);
    return run;
  }
  /** The file map the build plans from, with its calls recorded (whether a new map was asked for). */
  const mapSpy = () => vi.fn(async (project: string, options?: { remake?: boolean }) => { void options; return { ...fileMap([repoEntry("demo", [area("src", { rank: 1 })])]), project }; });
  const withResnapshot = (b: Built) => { b.h.deps.wikiBuildResnapshot = ({ project, taskId }) => resnapshotWikiBuild(b.deps, project, taskId); };
  const movedHeads = (b: Built) => { b.deps.defaultBranchHeads = async () => [{ repo: "demo", commit: MOVED }]; };

  // MUTANT words: the preparation's failure ends the run `infrastructure` whatever its cause, so the owner reads "could not go on" and Continue offers the same dead pin again.
  it.each([["the worker's words", movedError], ["an older worker's words", legacyError]])("%s end the run code_moved (with no automatic retry wired), in its own sentence", async (_name, error) => {
    const b = build();
    const run = await preparationFailed(b, error);
    expect((await readWikiBuildPointer(b.h.store, companyId, "payments"))!.end).toMatchObject({ word: "code_moved" });
    expect(await wikiBuildState(b.deps, "payments")).toMatchObject({ status: "stopped", stop: "code_moved", message: WIKI_BUILD_WORDS.code_moved });
    expect(WIKI_BUILD_WORDS.code_moved).toMatch(/start the build again/iu);
    // Nothing is lost: the run was read-only (a clone, no setup command), its pages live in the wiki store, and the run's own workspace is given back as for every end.
    expect((await b.h.store.get(taskKey(run.pointer.taskId)))!["closedAt"]).toBeTypeOf("string");
    expect(b.ended).toEqual([{ project: "payments", taskId: run.pointer.taskId }]);
  });

  // MUTANT resnapshot: the end does not start the run again, or starts it from the kept map (pins the same dead commit), or does it without the one-per-attempt mark.
  it("a rewrite takes ONE new snapshot automatically: a new file map, new pins, a new run, the old one closed", async () => {
    const b = build();
    withResnapshot(b);
    const fileMap = mapSpy();
    b.deps.fileMap = fileMap;
    const events: Array<Record<string, unknown>> = [];
    b.h.deps.log = (entry) => { events.push(entry); };
    const run = await started(b);
    movedHeads(b);
    await failPreparation(b, run.workspaceId, movedError);
    const next = (await readWikiBuildPointer(b.h.store, companyId, "payments"))!;
    expect(next.taskId).not.toBe(run.pointer.taskId);
    expect(next).toMatchObject({ pins: [{ repo: "demo", commit: MOVED }], resnapshotOf: run.pointer.taskId, continuedFrom: run.pointer.taskId });
    expect(next.end).toBeUndefined();
    expect(fileMap).toHaveBeenLastCalledWith("payments", { remake: true });
    expect(await b.h.store.get(taskKey(next.taskId))).toMatchObject({ purpose: "wiki_build", wikiBuild: { pins: [{ repo: "demo", commit: MOVED }] } });
    expect((await b.h.store.get(taskKey(run.pointer.taskId)))!["closedAt"]).toBeTypeOf("string");
    // The log says it, with the old and the new pins.
    expect(events).toContainEqual(expect.objectContaining({ event: "wiki_build.resnapshot", taskId: run.pointer.taskId, newTaskId: next.taskId, oldPins: [{ repo: "demo", commit: HEAD }], newPins: [{ repo: "demo", commit: MOVED }] }));
    // The new run's preparation goes on as for any run: it succeeds and the build step is delivered.
    const workspaceId = (await b.h.store.get(taskKey(next.taskId)))!["workspaceId"] as string;
    expect((await toBuildStep(b, workspaceId)).job).toMatchObject({ payload: { workflowMode: "WIKI_BUILD", wikiBuild: { pins: [{ repo: "demo", commit: MOVED }] } } });
  });

  // MUTANT loop: the retry is itself retried, so a branch that is rewritten twice (or a pin that never reads) starts runs for ever.
  it("a rewrite twice (the retry's preparation fails the same way) ends in the plain code_moved: exactly one automatic snapshot, no loop", async () => {
    const b = build();
    withResnapshot(b);
    const fileMap = mapSpy();
    b.deps.fileMap = fileMap;
    const run = await started(b);
    movedHeads(b);
    await failPreparation(b, run.workspaceId, movedError);
    const retry = (await readWikiBuildPointer(b.h.store, companyId, "payments"))!;
    expect(retry.taskId).not.toBe(run.pointer.taskId);
    await failPreparation(b, (await b.h.store.get(taskKey(retry.taskId)))!["workspaceId"] as string, movedError);
    const last = (await readWikiBuildPointer(b.h.store, companyId, "payments"))!;
    expect(last.taskId).toBe(retry.taskId);
    expect(last.end).toMatchObject({ word: "code_moved" });
    expect(fileMap.mock.calls.filter(([, options]) => options?.remake === true)).toHaveLength(1);
    expect(await wikiBuildState(b.deps, "payments")).toMatchObject({ status: "stopped", stop: "code_moved", message: WIKI_BUILD_WORDS.code_moved });
    // A repeat of the hook for the first run starts nothing either.
    expect(await resnapshotWikiBuild(b.deps, "payments", run.pointer.taskId)).toBeUndefined();
    expect((await readWikiBuildPointer(b.h.store, companyId, "payments"))!.taskId).toBe(retry.taskId);
  });

  // MUTANT continue: Continue after a rewrite is refused, or reuses the dead pins.
  it("Continue after a rewrite takes a new snapshot instead of refusing (same plan, new pins), and Build after it asks for a new map", async () => {
    const b = build();
    const fileMap = mapSpy();
    b.deps.fileMap = fileMap;
    const run = await preparationFailed(b, movedError);
    expect(await wikiBuildState(b.deps, "payments")).toMatchObject({ stop: "code_moved", canContinue: true });
    movedHeads(b);
    await continueWikiBuild(b.deps, b.h.owner.principal.personId, "payments", { requestId: randomUUID() });
    expect(fileMap).toHaveBeenLastCalledWith("payments", { remake: true });
    const next = (await readWikiBuildPointer(b.h.store, companyId, "payments"))!;
    expect(next).toMatchObject({ continuedFrom: run.pointer.taskId, pins: [{ repo: "demo", commit: MOVED }] });
    expect(next.plan).toEqual(run.pointer.plan);
    // A person's Build after an end that was code_moved reads the branches again as well.
    const other = build();
    const kept = mapSpy();
    other.deps.fileMap = kept;
    await preparationFailed(other, movedError);
    expect(kept).toHaveBeenLastCalledWith("payments", { remake: false });
    movedHeads(other);
    await startWikiBuild(other.deps, other.h.owner.principal.personId, "payments", { requestId: randomUUID() });
    expect(kept).toHaveBeenLastCalledWith("payments", { remake: true });
    expect((await readWikiBuildPointer(other.h.store, companyId, "payments"))!.pins).toEqual([{ repo: "demo", commit: MOVED }]);
    // After an ordinary end the kept map is used.
    const third = build();
    const keptMap = mapSpy();
    third.deps.fileMap = keptMap;
    await started(third);
    await third.h.store.update({ key: { pk: `ORG#${companyId}#WIKI_BUILD#payments`, sk: "RUN" }, ops: [{ op: "set", path: ["end"], value: { word: "time_used", at: "2026-11-09T10:01:00.000Z" } }] } as never);
    await startWikiBuild(third.deps, third.h.owner.principal.personId, "payments", { requestId: randomUUID() });
    expect(keptMap).toHaveBeenLastCalledWith("payments", { remake: false });
  });

  // MUTANT kind: the end reads the error of any failed step, so a build step that quotes the words (a model's text) ends the run code_moved.
  it("only a failed PREPARATION with those words is code_moved; any other failure still ends infrastructure and can be continued", async () => {
    const plain = build();
    withResnapshot(plain);
    await preparationFailed(plain, "boom");
    expect((await readWikiBuildPointer(plain.h.store, companyId, "payments"))!.end).toMatchObject({ word: "infrastructure" });
    expect(await wikiBuildState(plain.deps, "payments")).toMatchObject({ stop: "infrastructure", message: WIKI_BUILD_WORDS.infrastructure, canContinue: true });
    const step = build();
    withResnapshot(step);
    const run = await started(step);
    const at = await toBuildStep(step, run.workspaceId);
    await step.h.flow.recordResult({ workspaceId: run.workspaceId, operationId: at.job.operationId, fence: at.job.fence, status: "FAILED", error: movedError });
    const pointer = (await readWikiBuildPointer(step.h.store, companyId, "payments"))!;
    expect(pointer.end).toMatchObject({ word: "infrastructure" });
    expect(pointer.taskId).toBe(run.pointer.taskId);
  });

  // MUTANT repositories: the preparation is sent every repository of the project while the pins cover only the ones the file map could read, so the worker refuses the repository with no pin ("not at the commit the control plane pinned") and the build can never start (prod 2026-11-23).
  it("a pinned preparation is sent only the pinned repositories; a repository the file map could not read does not fail the build", async () => {
    const b = build();
    await b.h.registerProject({ ...definition, repositories: [...definition.repositories, { name: "legacy", url: "https://examplehost/example/legacy.git", path: "repo/legacy", defaultBranch: "main", credentialRef: "host-app" }] });
    await startWikiBuild(b.deps, b.h.owner.principal.personId, "payments", { requestId: randomUUID() });
    const pointer = (await readWikiBuildPointer(b.h.store, companyId, "payments"))!;
    expect(pointer.pins).toEqual([{ repo: "demo", commit: HEAD }]);
    const workspaceId = (await b.h.store.get(taskKey(pointer.taskId)))!["workspaceId"] as string;
    expect(await b.h.flow.dispatchOnce()).toMatchObject({ delivered: 1 });
    const machine = ((await locateWorkspace(b.h.deps, workspaceId))!.workspace["machine"] as { machineId: string }).machineId;
    const [prepare] = b.h.machines.delivered(machine);
    const sent = (prepare as unknown as { payload: { project: { repositories: Array<{ name: string }> } } }).payload.project.repositories.map((repository) => repository.name);
    expect(sent).toEqual(["demo"]);
    // An ordinary task is sent the whole project.
    const plain = build();
    await plain.h.registerProject({ ...definition, repositories: [...definition.repositories, { name: "legacy", url: "https://examplehost/example/legacy.git", path: "repo/legacy", defaultBranch: "main", credentialRef: "host-app" }] });
    const task = await plain.h.flow.start(plain.h.owner, { project: "payments", instructions: "fix", requestId: randomUUID() });
    expect(await plain.h.flow.dispatchOnce()).toMatchObject({ delivered: 1 });
    const m2 = ((await locateWorkspace(plain.h.deps, task.task.workspaceId))!.workspace["machine"] as { machineId: string }).machineId;
    expect((plain.h.machines.delivered(m2)[0] as unknown as { payload: { project: { repositories: unknown[] } } }).payload.project.repositories).toHaveLength(2);
  });

  // An ordinary task and a setup run carry no pin at all (the worker reads the head as it is when it clones), so a moved branch cannot stop their start; and an ordinary task whose preparation fails is not closed by the flow.
  it("an ordinary task and a setup run are sent no pins, and a failed preparation of an ordinary task closes nothing", async () => {
    const b = build();
    await b.h.registerProject();
    const task = await b.h.flow.start(b.h.owner, { project: "payments", instructions: "fix the bug", requestId: randomUUID() });
    expect(await b.h.flow.dispatchOnce()).toMatchObject({ delivered: 1 });
    const machine = ((await locateWorkspace(b.h.deps, task.task.workspaceId))!.workspace["machine"] as { machineId: string }).machineId;
    const [prepare] = b.h.machines.delivered(machine);
    expect(prepare).toMatchObject({ kind: "prepare" });
    expect((prepare as { payload: Record<string, unknown> }).payload["pins"]).toBeUndefined();
    await b.h.flow.recordResult({ workspaceId: task.task.workspaceId, operationId: prepare!.operationId, fence: prepare!.fence, status: "FAILED", error: legacyError });
    expect((await b.h.store.get(taskKey(task.task.taskId)))!["closedAt"]).toBeUndefined();

    const setup = build();
    await setup.h.registerProject();
    const run = await startTask(setup.h.deps, setup.h.owner, { project: "payments", requestId: randomUUID(), instructions: "Set up payments", title: "Set up payments" }, { setupAgent: { limits: { ...SETUP_AGENT_LIMITS_DEFAULT }, seenTaskId: undefined } });
    expect(await setup.h.flow.dispatchOnce()).toMatchObject({ delivered: 1 });
    const setupMachine = ((await locateWorkspace(setup.h.deps, run.task.workspaceId))!.workspace["machine"] as { machineId: string }).machineId;
    const [setupPrepare] = setup.h.machines.delivered(setupMachine);
    expect(setupPrepare).toMatchObject({ kind: "prepare" });
    expect((setupPrepare as { payload: Record<string, unknown> }).payload["pins"]).toBeUndefined();
  });
});

void API_SHA;
