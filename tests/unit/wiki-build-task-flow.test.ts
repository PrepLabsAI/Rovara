// Wiki W3b: the wiki build as a task of the task flow. Start (one transaction with the pointer, a read-only pinned preparation), the first step (WIKI_BUILD with the limits and pins and its own callback capability), the end
// (the first end word stands, the workspace is given back), the payer (the project, whatever surface started it) and the hosted standing rule (the person the run is for must still manage the project).
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { WIKI_BUILD_FEATURE, WIKI_BUILD_WORDS, WORKER_INVOCATION_FEATURES, PREPARE_PINS_FEATURE, type OrgId } from "@agentx/contracts";
import { CallbackCapabilities } from "../../packages/broker/src/callbacks.js";
import { createTaskTokenDescriber } from "../../packages/broker/src/core/model-gateway/describer.js";
import { createWikiBuildStarter } from "../../packages/broker/src/core/wiki-build/starter.js";
import { readWikiBuildPointer, startWikiBuild, wikiBuildPointerItem, type WikiBuildDeps, type WikiBuildPointer } from "../../packages/broker/src/core/wiki-build/run.js";
import { startTask } from "../../packages/broker/src/core/task-flow/start.js";
import { operationKey, taskKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { locateWorkspace } from "../../packages/broker/src/core/task-flow/workspace-location.js";
import { hostedTaskAccess, setupRunStandingFrom, NOT_A_MEMBER_HERE } from "../../packages/broker/src/aws/core-engine-root.js";
import { SETUP_RUN_NOT_ALLOWED } from "../../packages/broker/src/core-host/setup-run-routes.js";
import { SIGNING_KEY, createHarness, type Harness } from "../support/task-flow-harness.js";
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

  it("a project whose own setup check failed still takes a wiki build (it only reads code)", async () => {
    const b = build();
    await b.h.registerProject();
    await b.h.store.put({ item: { pk: `ORG#${companyId}#SETUP_CHECK#payments`, sk: "META", entityType: "SETUP_CHECK", status: "failed" } });
    expect((await startWikiBuild(b.deps, b.h.owner.principal.personId, "payments", { requestId: randomUUID() })).status).toBe(202);
  });
});

function pointerOf(taskId: string): WikiBuildPointer {
  return {
    orgId: companyId, project: "payments", taskId, requestId: randomUUID(), requestedBy: "p", startedAt: "2026-11-09T10:00:00.000Z", limits: { pages: 300, budgetCents: 700, wallClockMin: 180, pageReserveCents: 50 },
    pins: [{ repo: "demo", commit: HEAD }], plan: [], keptFromEarlier: [], doneIds: [], pagesWritten: 0, claimsKept: 0, claimsDropped: 0, spentCents: 0, spentEarlierCents: 0, payer: { kind: "project", project: "payments" }, buildKind: "first",
  };
}

describe("the first step: WIKI_BUILD with its limits, pins and its own callback capability", () => {
  it("is queued after the preparation with the task's wire and a capability for wiki-build only", async () => {
    const b = build();
    const { workspaceId } = await started(b);
    const { prepare, job } = await toBuildStep(b, workspaceId);
    expect(job).toMatchObject({ kind: "task", payload: { workflowMode: "WIKI_BUILD", wikiBuild: { limits: { budgetCents: 700 }, pins: [{ repo: "demo", commit: HEAD }] } } });
    expect((job as { payload: Record<string, unknown> }).payload["setupAgent"]).toBeUndefined();
    const capabilities = new CallbackCapabilities(SIGNING_KEY);
    expect(() => capabilities.verify(job.callbackCapability, "wiki-build")).not.toThrow();
    // The step's capability does not reach the setup run's action, and the preparation's reaches neither.
    expect(() => capabilities.verify(job.callbackCapability, "setup-agent")).toThrow();
    expect(() => capabilities.verify(prepare.callbackCapability, "wiki-build")).toThrow();
    expect(() => capabilities.verify(prepare.callbackCapability, "setup-agent")).toThrow();
  });

  it("goes only to a worker that lists the wiki build feature; an older worker is never handed it", async () => {
    const without = features.filter((name) => name !== WIKI_BUILD_FEATURE);
    const b = build({ features: without });
    const { workspaceId } = await started(b);
    expect(await b.h.flow.dispatchOnce()).toMatchObject({ delivered: 1 });
    const machine = ((await locateWorkspace(b.h.deps, workspaceId))!.workspace["machine"] as { machineId: string }).machineId;
    const [prepare] = b.h.machines.delivered(machine);
    await b.h.flow.recordResult({ workspaceId, operationId: prepare!.operationId, fence: prepare!.fence, status: "SUCCEEDED", outcome: { kind: "prepared", base: [{ repositoryId: "demo", baseCommitSha: HEAD }] } });
    await b.h.flow.dispatchOnce();
    expect(b.h.machines.delivered(machine).filter((job) => job.kind === "task")).toHaveLength(0);
    // And a worker with no pinned preparation never gets the preparation either.
    const noPins = build({ features: features.filter((name) => name !== PREPARE_PINS_FEATURE) });
    await started(noPins);
    expect(await noPins.h.flow.dispatchOnce()).toMatchObject({ delivered: 0 });
  });
});

describe("the end", () => {
  it("a run that ended by its own word keeps it; the workspace is given back and the build record is told", async () => {
    const b = build();
    const { pointer, workspaceId } = await started(b);
    const { job } = await toBuildStep(b, workspaceId);
    await b.h.store.update({ key: { pk: `ORG#${companyId}#WIKI_BUILD#payments`, sk: "RUN" }, ops: [{ op: "set", path: ["end"], value: { word: "budget_used", at: "2026-11-09T10:05:00.000Z" } }] } as never);
    await b.h.flow.recordResult({ workspaceId, operationId: job.operationId, fence: job.fence, status: "SUCCEEDED", outcome: { kind: "ended" } });
    expect((await readWikiBuildPointer(b.h.store, companyId, "payments"))!.end).toMatchObject({ word: "budget_used" });
    expect((await b.h.store.get(taskKey(pointer.taskId)))!["closedAt"]).toBeTypeOf("string");
    expect(b.ended).toEqual([{ project: "payments", taskId: pointer.taskId }]);
  });

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

  it("a preparation that fails ends the run (the pins did not hold, the host was unreadable) and gives the workspace back", async () => {
    const b = build();
    const { pointer, workspaceId } = await started(b);
    expect(await b.h.flow.dispatchOnce()).toMatchObject({ delivered: 1 });
    const machine = ((await locateWorkspace(b.h.deps, workspaceId))!.workspace["machine"] as { machineId: string }).machineId;
    const [prepare] = b.h.machines.delivered(machine);
    await b.h.flow.recordResult({ workspaceId, operationId: prepare!.operationId, fence: prepare!.fence, status: "FAILED", error: "the workspace holds demo at another commit than the control plane pinned" });
    expect((await readWikiBuildPointer(b.h.store, companyId, "payments"))!.end).toMatchObject({ word: "infrastructure" });
    expect((await b.h.store.get(taskKey(pointer.taskId)))!["closedAt"]).toBeTypeOf("string");
  });

  it("an end of an older task never ends a newer run of the project", async () => {
    const b = build();
    const { workspaceId } = await started(b);
    const { job } = await toBuildStep(b, workspaceId);
    // The project's pointer now names a different (newer) task.
    const newer = randomUUID();
    await b.h.store.put({ item: { ...(await b.h.store.get({ pk: `ORG#${companyId}#WIKI_BUILD#payments`, sk: "RUN" }))!, taskId: newer } });
    await b.h.flow.recordResult({ workspaceId, operationId: job.operationId, fence: job.fence, status: "FAILED", error: "late" });
    const pointer = (await readWikiBuildPointer(b.h.store, companyId, "payments"))!;
    expect(pointer.taskId).toBe(newer);
    expect(pointer.end).toBeUndefined();
    expect(b.ended).toEqual([]);
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
  it.each(["app", "cli", "mcp", "slack"])("a wiki build started from %s is paid by the project, its monthly limit, never the person", async (origin) => {
    expect(await describing(origin, "wiki_build")).toMatchObject({ project: "payments", payer: { kind: "project", project: "payments" }, step: "wiki_build" });
  });

  it("an ordinary task started from the app is still paid by the person (the rule is the wiki build's own)", async () => {
    expect(await describing("app", undefined)).toMatchObject({ payer: { kind: "member", developerId: "a".repeat(64) } });
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
void API_SHA;
