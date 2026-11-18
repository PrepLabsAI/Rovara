// L4-DR (DEC 254z c, DEC 254zw): the drift check at task start and the free automatic setup re-check, on the task flow's fakes (an in-memory store and queue, a fake worker machine, a fake code host).
// What is proved here, and what each proof would catch if the code were changed (the mutants are listed in the PR body):
//   detection        every watched file class, a new file, a removed file and the allowed websites each start a re-check; no change starts none; "cannot tell" is never "no drift"
//   once per commit  two tasks on one commit share one re-check; a new commit is a new one
//   the cap          the project's monthly cap on automatic runs holds the re-check; at the cap nothing starts and the task still starts
//   no model         the check is the existing preparation, started by the project's system owner; the model route is never asked
//   the wait         only the first coding run waits; Understand and Plan go on; a pass is silent and moves the baseline
//   what blocks      ONLY a setup step failing twice; failing tests and an unclear result never do; nothing here approves a setup
//   isolation        another project and another company never meet the snapshot, the re-check or the card
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  IMPLICIT_COMPANY_ID, WORKER_INVOCATION_FEATURES, orgProjectCatalogKey, projectMetaKey, projectRevisionKey, queryAll, systemOwnerIdOf,
  type DocumentStore, type JsonValue, type OrgId, type ProjectDefinition, type WorkflowSnapshot,
} from "@agentx/contracts";
import { claimAutomaticRun, readAutomaticRunsUse, setAutomaticRunsCap } from "../../packages/broker/src/core/automatic-runs/cap.js";
import { startImplementation } from "../../packages/broker/src/core/build-step/start.js";
import { SETUP_CHECK_STUCK_MS, setupFailedMessage, setupStateOf } from "../../packages/broker/src/core/setup-agent/check.js";
import {
  RECHECK_RETRY_DELAY_MS, RECHECK_WAIT_MAX_MS, SETUP_CHECKING_WORDS, advanceCurrentRecheck, classifySetupRecheck, driftTaskKey, readSetupRepairCard, recheckCurrentKey, recheckRowKey, repairNoticeKey, setupGateBeforeBuild, setupRecheckLineOf,
  setupBrokenTaskWords, setupDriftAtStart, setupStillWorksWords, type RecheckRow,
} from "../../packages/broker/src/core/setup-agent/recheck.js";
import { readSetupSnapshot, setupSnapshotKey, snapshotItem, takeSetupSnapshot } from "../../packages/broker/src/core/setup-agent/snapshot.js";
import { setupPartition } from "../../packages/broker/src/core/setup-agent/keys.js";
import { readTask, taskViewOf, workspaceOperations } from "../../packages/broker/src/core/task-flow/reads.js";
import { readWorkspace } from "../../packages/broker/src/core/task-flow/stage-machine.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { createAdapterRegistry } from "../../packages/broker/src/ports/adapter-registry.js";
import { FakeCodeHost } from "../../packages/broker/src/plugins/fake/code-host.js";
import { FakeHostModel } from "../../packages/broker/src/plugins/fake/model.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { MemoryQueueService } from "../../packages/broker/src/ports/memory-queue.js";
import { TASK_FLOW_INDEXES } from "../../packages/broker/src/core/task-flow/flow.js";
import { createHarness, definition, newRequestId, type Harness } from "../support/task-flow-harness.js";

const URL_ = "https://examplehost.test/acme/app";
const COMPANY_B: OrgId = "org_bbbbbbbbbbbbbbbbbbbb";
const FILES: Record<string, string> = {
  "README.md": "readme", "src/index.ts": "export {}", "package.json": "{}", "package-lock.json": "lock-1", "docker-compose.yml": "services: {}", "services/api/Dockerfile": "FROM node:22",
  ".devcontainer/devcontainer.json": "{}", ".env.example": "A=", ".nvmrc": "22", "vitest.config.ts": "export default {}", ".github/workflows/ci.yml": "on: push",
};
/** One file per class, and the text it is changed to. */
const CLASSES: Array<[string, string]> = [
  ["marker", "package.json"], ["lockfile", "package-lock.json"], ["compose", "docker-compose.yml"], ["dockerfile", "services/api/Dockerfile"], ["devcontainer", ".devcontainer/devcontainer.json"],
  ["env_example", ".env.example"], ["version", ".nvmrc"], ["test_config", "vitest.config.ts"], ["ci", ".github/workflows/ci.yml"],
];

const projectOf = (name = "payments", extra: Partial<ProjectDefinition> = {}): ProjectDefinition => ({
  ...definition, name, setup: [{ cwd: "repo/demo", executable: "npm", args: ["ci"], timeoutSeconds: 60 }], readiness: [{ cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 60 }], ...extra,
  repositories: [{ ...definition.repositories[0]!, url: URL_, host: { kind: "fake" } }],
});

interface World { h: Harness; model: FakeHostModel; host: FakeCodeHost; project: ProjectDefinition; modelRoute: ReturnType<typeof vi.fn> }

async function world(options: { companyId?: OrgId; project?: ProjectDefinition; snapshot?: boolean; files?: Record<string, string>; backend?: Parameters<typeof createHarness>[0] extends infer O ? (O extends { backend?: infer B } ? B : never) : never; understandFirst?: boolean; audit?: "recording" } = {}): Promise<World> {
  const modelRoute = vi.fn(async () => undefined);
  const h = createHarness({
    understandFirst: options.understandFirst ?? false, machines: { startingChecks: 0, features: [...WORKER_INVOCATION_FEATURES] },
    ...(options.audit === undefined ? {} : { audit: options.audit }), ...(options.companyId === undefined ? {} : { companyId: options.companyId }), ...(options.backend === undefined ? {} : { backend: options.backend }),
  });
  const project = options.project ?? projectOf();
  await h.registerProject(project);
  // The project's own record (a registered project has one; the setup state's mark lives on it).
  await h.store.put({ item: { ...projectMetaKey(h.deps.companyId, project.name), entityType: "PROJECT_META" } });
  const model = new FakeHostModel({ url: URL_, id: "1", fullName: "acme/app", initialFiles: options.files ?? FILES });
  const host = new FakeCodeHost(model);
  const registry = createAdapterRegistry();
  registry.register("code-host", "fake", host);
  h.deps.codeHosts = registry;
  // The model route is the one door a model call goes through for a step: it must never be asked for a re-check.
  h.deps.modelAccess = { route: modelRoute };
  const built: World = { h, model, host, project, modelRoute };
  if (options.snapshot !== false) await saveSnapshot(built);
  return built;
}

/** What approval saves: the setup files at the head now. */
async function saveSnapshot(w: World, definitionOf: ProjectDefinition = w.project): Promise<void> {
  const snapshot = await takeSetupSnapshot({ companyId: w.h.deps.companyId, codeHosts: w.h.deps.codeHosts }, { definition: definitionOf, setupRevision: definitionOf.revision, at: "2026-11-09T10:00:00.000Z" });
  expect(snapshot).toBeDefined();
  expect((await w.h.store.transact([snapshotItem(w.h.deps.companyId, definitionOf.name, snapshot!)])).applied).toBe(true);
}

const startTask = async (w: World, project = w.project.name) => (await w.h.flow.start(w.h.owner, { requestId: newRequestId(), project, instructions: "Change a thing", workflow: true, workflowPath: "QUICK" })).task;
const rechecksOf = async (store: DocumentStore, orgId: OrgId, project: string): Promise<RecheckRow[]> =>
  (await queryAll(store, { pk: setupPartition(orgId, project), sk: { op: "beginsWith", prefix: "RECHECK#" } })).map((item) => item as unknown as RecheckRow);
/** The preparation messages staged for dispatch: one per workspace made (a task's own, and each check). */
const stagedPreparations = async (h: Harness): Promise<number> => {
  const queue = await h.queues.queue("task-dispatch");
  let total = 0;
  for (let round = 0; round < 20; round += 1) {
    const batch = await queue.receive();
    if (batch.length === 0) break;
    total += batch.length;
  }
  return total;
};
const linkOf = async (w: World, taskId: string, project = w.project.name) => w.h.store.get(driftTaskKey(w.h.deps.companyId, project, taskId));

/** Answers the check's preparation as a worker would, delivering it first. */
async function finishCheck(h: Harness, workspaceId: string, outcome: { status: "SUCCEEDED" } | { status: "FAILED"; error: string }): Promise<void> {
  for (let round = 0; round < 8; round += 1) {
    await h.flow.dispatchOnce({ maxMessages: 10 });
    const workspace = await readWorkspace(h.deps, workspaceId);
    const job = workspace?.machine === undefined ? undefined : h.machines.delivered(workspace.machine.machineId).find((entry) => entry.kind === "prepare" && entry.workspaceId === workspaceId);
    if (job !== undefined) {
      await h.flow.recordResult({ workspaceId, operationId: job.operationId, fence: job.fence ?? workspace!.fence, ...outcome });
      return;
    }
    h.clock.advance(70);
  }
  throw new Error("the check's preparation was never delivered");
}
/** The first failure is seen, and the retry waits out its delay (a short outage must not fail both tries): then the re-check moves on. */
async function advanceAfterFailure(h: Harness, org = "payments") {
  await advanceCurrentRecheck(h.deps, org);
  h.clock.advance(RECHECK_RETRY_DELAY_MS / 1000 + 1);
  return advanceCurrentRecheck(h.deps, org);
}
const SETUP_FAILS = "setup step 0 (npm ci) failed: exit 1";
const TESTS_FAIL = "readiness check 0 (npm test) failed: exit 1";

describe("the drift check at task start", () => {
  it("no change in any watched file: nothing is started, nothing is written for the task, no line, and the check is not even asked for", async () => {
    const w = await world();
    const task = await startTask(w);
    expect(await rechecksOf(w.h.store, w.h.deps.companyId, "payments")).toEqual([]);
    expect(await linkOf(w, task.taskId)).toBeUndefined();
    expect(await w.h.store.get(recheckCurrentKey(w.h.deps.companyId, "payments"))).toBeUndefined();
    expect((await readAutomaticRunsUse({ store: w.h.store, now: () => w.h.clock.now }, w.h.deps.companyId, "payments")).used).toBe(0);
    expect(await setupRecheckLineOf(w.h.deps, "payments", task.taskId)).toBeUndefined();
    expect((await taskViewOf(w.h.deps, (await readTask(w.h.deps, task.taskId))!)).setupRecheck).toBeUndefined();
  });

  it("a change to source files only is no drift (they are not watched, so they are not even listed)", async () => {
    const w = await world();
    w.model.commit("main", { "src/index.ts": "export const changed = true;", "README.md": "new readme" });
    const task = await startTask(w);
    expect(await rechecksOf(w.h.store, w.h.deps.companyId, "payments")).toEqual([]);
    expect(await linkOf(w, task.taskId)).toBeUndefined();
  });

  it.each(CLASSES)("a changed %s file (%s) starts the re-check, for that class only, and the task is linked to it", async (watchClass, path) => {
    const w = await world();
    w.model.commit("main", { [path]: `${FILES[path]!} changed` });
    const task = await startTask(w);
    const rows = await rechecksOf(w.h.store, w.h.deps.companyId, "payments");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "running", attempt: 1, classes: [watchClass], project: "payments", orgId: w.h.deps.companyId });
    expect(await linkOf(w, task.taskId)).toMatchObject({ state: "pending", recheckKey: rows[0]!.key, taskId: task.taskId });
    expect(await setupRecheckLineOf(w.h.deps, "payments", task.taskId)).toBe(SETUP_CHECKING_WORDS);
  });

  it.each(CLASSES)("a new %s file is drift of that class", async (watchClass, path) => {
    const files = Object.fromEntries(Object.entries(FILES).filter(([name]) => name !== path));
    const w = await world({ files });
    w.model.commit("main", { [path]: "brand new" });
    await startTask(w);
    expect((await rechecksOf(w.h.store, w.h.deps.companyId, "payments")).map((row) => row.classes)).toEqual([[watchClass]]);
  });

  it.each(CLASSES)("a removed %s file is drift of that class", async (watchClass, path) => {
    const w = await world();
    w.model.commit("main", { [path]: null });
    await startTask(w);
    expect((await rechecksOf(w.h.store, w.h.deps.companyId, "payments")).map((row) => row.classes)).toEqual([[watchClass]]);
  });

  it("a website the setup now allows that the snapshot did not is drift, with no file changed", async () => {
    const w = await world();
    const allowed = projectOf("payments", { revision: 2, network: { allowedDomains: ["api.stripe.com"] } });
    await w.h.registerProject(allowed);
    await startTask(w);
    expect((await rechecksOf(w.h.store, w.h.deps.companyId, "payments")).map((row) => row.classes)).toEqual([["websites"]]);
  });

  it("cannot tell, so it re-checks: a project whose setup was checked before snapshots existed (no baseline yet)", async () => {
    const w = await world({ snapshot: false });
    // Its own setup check passed: the promise to keep exists, the baseline does not.
    await w.h.store.put({ item: { ...projectMetaKey(w.h.deps.companyId, "payments"), entityType: "PROJECT_META" } });
    const ready = await readyCheckMark(w);
    await w.h.store.update({ key: projectMetaKey(w.h.deps.companyId, "payments"), ops: [{ op: "set", path: ["setupCheck"], value: ready as unknown as JsonValue }] });
    expect((await setupStateOf(w.h.deps, "payments", w.project)).status).toBe("ready");
    const task = await startTask(w);
    const rows = await rechecksOf(w.h.store, w.h.deps.companyId, "payments");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.classes).toEqual([]);
    expect(await linkOf(w, task.taskId)).toBeDefined();
  });

  it("a project whose setup was never checked has no promise to keep: no baseline, no re-check", async () => {
    const w = await world({ snapshot: false });
    const task = await startTask(w);
    expect(await rechecksOf(w.h.store, w.h.deps.companyId, "payments")).toEqual([]);
    expect(await linkOf(w, task.taskId)).toBeUndefined();
  });

  it("a listing the host cut short is unknown, never no drift: the re-check starts", async () => {
    const w = await world();
    const head = w.model.commit("main", { "README.md": "another" });
    w.model.incompleteTrees.add(head);
    await startTask(w);
    expect(await rechecksOf(w.h.store, w.h.deps.companyId, "payments")).toHaveLength(1);
  });

  it("a snapshot that does not parse is unknown, never no drift: the re-check starts", async () => {
    const w = await world();
    await w.h.store.put({ item: { ...setupSnapshotKey(w.h.deps.companyId, "payments"), entityType: "SETUP_SNAPSHOT", orgId: w.h.deps.companyId, project: "payments", snapshot: { nonsense: true } } });
    await startTask(w);
    expect(await rechecksOf(w.h.store, w.h.deps.companyId, "payments")).toHaveLength(1);
  });

  it("a code host that cannot be reached does not block the task and starts no re-check ('drift not checked')", async () => {
    const w = await world();
    w.model.commit("main", { "package-lock.json": "changed" });
    w.host.setupFileVersions = async () => { throw new Error("host is down"); };
    const task = await startTask(w);
    expect(task.status).toBe("STARTING");
    expect(await rechecksOf(w.h.store, w.h.deps.companyId, "payments")).toEqual([]);
    // DEC 254zzl: the task started all the same, and says so quietly.
    expect(await linkOf(w, task.taskId)).toMatchObject({ state: "released", noRecheck: { classes: [] }, recheckKey: "" });
    expect(await setupRecheckLineOf(w.h.deps, "payments", task.taskId)).toBe("Couldn't re-check setup.");
    expect(await setupGateBeforeBuild(w.h.deps, { project: "payments", taskId: task.taskId })).toEqual({ answer: "go" });
  });

  it("an install with no code host starts exactly as before", async () => {
    const w = await world();
    delete w.h.deps.codeHosts;
    const task = await startTask(w);
    expect(task.status).toBe("STARTING");
    expect(await rechecksOf(w.h.store, w.h.deps.companyId, "payments")).toEqual([]);
  });

  it("a setup run (the fix itself) is never drift-checked", async () => {
    const w = await world();
    w.model.commit("main", { "package-lock.json": "changed" });
    const { startTask: start } = await import("../../packages/broker/src/core/task-flow/start.js");
    const { effectiveSetupAgentLimits } = await import("@agentx/contracts");
    await start(w.h.deps, w.h.owner, { project: "payments", requestId: newRequestId(), instructions: "Set up payments" }, { setupAgent: { limits: effectiveSetupAgentLimits(), seenTaskId: undefined } });
    expect(await rechecksOf(w.h.store, w.h.deps.companyId, "payments")).toEqual([]);
  });

  it("never throws into the start: a store fault while checking is logged and the start goes on", async () => {
    const w = await world();
    w.model.commit("main", { "package-lock.json": "changed" });
    const logs: Array<Record<string, unknown>> = [];
    w.h.deps.log = (entry) => logs.push(entry);
    w.h.deps.codeHosts = { ...w.h.deps.codeHosts!, get: () => { throw new Error("registry fault"); } } as never;
    const items = await setupDriftAtStart(w.h.deps, { project: "payments", taskId: "t1", definition: w.project });
    // The start goes on with only a released link and the quiet note; nothing is started.
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "put", item: { entityType: "SETUP_DRIFT_TASK", state: "released", noRecheck: { classes: [] } } });
    expect(logs.some((entry) => entry["event"] === "setup_drift.failed" || entry["event"] === "setup_drift.not_checked")).toBe(true);
  });
});

/** A passing check the project's own mark points at (the way a person's "check the setup" leaves it). */
async function readyCheckMark(w: World): Promise<{ workspaceId: string; revision: number; startedAt: string; startedBy: string }> {
  const { buildSetupCheck, relayCheck } = await import("../../packages/broker/src/core/setup-agent/check.js");
  const check = buildSetupCheck(w.h.deps, { project: "payments", revision: 1, startedBy: "local-owner", requestId: newRequestId(), candidate: false });
  expect((await w.h.store.transact(check.items)).applied).toBe(true);
  await relayCheck(w.h.deps, check);
  await finishCheck(w.h, check.workspaceId, { status: "SUCCEEDED" });
  return check.mark;
}

describe("the company's system-runs switch (DEC 254zzl: hosted default off)", () => {
  it("off: nothing is started, nothing is spent, the task starts normally, and its page says quietly that the setup may be out of date", async () => {
    const w = await world();
    w.h.deps.systemRuns = { enabled: () => false };
    w.model.commit("main", { "package-lock.json": "lock-2", "docker-compose.yml": "services: { db: {} }" });
    const task = await startTask(w);
    expect(task.status).toBe("STARTING");
    expect(await rechecksOf(w.h.store, w.h.deps.companyId, "payments")).toEqual([]);
    expect(await w.h.store.get(recheckCurrentKey(w.h.deps.companyId, "payments"))).toBeUndefined();
    expect((await readAutomaticRunsUse({ store: w.h.store, now: () => w.h.clock.now }, w.h.deps.companyId, "payments")).used).toBe(0);
    expect(await linkOf(w, task.taskId)).toMatchObject({ state: "released", recheckKey: "", noRecheck: { classes: ["lockfile", "compose"], reason: "off" } });
    const line = "Setup may be out of date after dependency files and a compose file changed.";
    expect(await setupRecheckLineOf(w.h.deps, "payments", task.taskId)).toBe(line);
    expect((await taskViewOf(w.h.deps, (await readTask(w.h.deps, task.taskId))!)).setupRecheck).toBe(line);
    expect(await setupGateBeforeBuild(w.h.deps, { project: "payments", taskId: task.taskId })).toEqual({ answer: "go" });
    expect(await stagedPreparations(w.h)).toBe(1);
    expect(w.modelRoute).not.toHaveBeenCalled();
  });

  it("off: no drift says nothing at all, and a comparison that cannot be told says it without naming a change", async () => {
    const quiet = await world();
    quiet.h.deps.systemRuns = { enabled: () => false };
    const calm = await startTask(quiet);
    expect(await linkOf(quiet, calm.taskId)).toBeUndefined();
    expect(await setupRecheckLineOf(quiet.h.deps, "payments", calm.taskId)).toBeUndefined();
    const w = await world({ snapshot: false });
    w.h.deps.systemRuns = { enabled: () => false };
    await w.h.store.put({ item: { ...projectMetaKey(w.h.deps.companyId, "payments"), entityType: "PROJECT_META" } });
    await w.h.store.update({ key: projectMetaKey(w.h.deps.companyId, "payments"), ops: [{ op: "set", path: ["setupCheck"], value: (await readyCheckMark(w)) as unknown as JsonValue }] });
    const task = await startTask(w);
    expect(await setupRecheckLineOf(w.h.deps, "payments", task.taskId)).toBe("Setup may be out of date.");
    expect(await rechecksOf(w.h.store, w.h.deps.companyId, "payments")).toEqual([]);
  });

  it("on (the hosted flag set) and absent (the laptop) both re-check; switching it on later starts re-checks again", async () => {
    const w = await world();
    w.h.deps.systemRuns = { enabled: () => false };
    w.model.commit("main", { "package-lock.json": "lock-2" });
    await startTask(w);
    expect(await rechecksOf(w.h.store, w.h.deps.companyId, "payments")).toEqual([]);
    w.h.deps.systemRuns = { enabled: () => true };
    const task = await startTask(w);
    expect(await rechecksOf(w.h.store, w.h.deps.companyId, "payments")).toHaveLength(1);
    expect(await linkOf(w, task.taskId)).toMatchObject({ state: "pending" });
    delete w.h.deps.systemRuns;
    w.model.commit("main", { "package-lock.json": "lock-3" });
    await finishCheck(w.h, (await rechecksOf(w.h.store, w.h.deps.companyId, "payments"))[0]!.check.workspaceId, { status: "SUCCEEDED" });
    await advanceCurrentRecheck(w.h.deps, "payments");
    await startTask(w);
    expect(await rechecksOf(w.h.store, w.h.deps.companyId, "payments")).toHaveLength(2);
  });

  it("switched off after a first attempt began: the retry is not started, the re-check ends unclear, and nothing blocks", async () => {
    const w = await world();
    w.h.deps.systemRuns = { enabled: () => true };
    w.model.commit("main", { "package-lock.json": "lock-2" });
    const task = await startTask(w);
    const [first] = await rechecksOf(w.h.store, w.h.deps.companyId, "payments");
    await finishCheck(w.h, first!.check.workspaceId, { status: "FAILED", error: SETUP_FAILS });
    await advanceCurrentRecheck(w.h.deps, "payments");
    w.h.deps.systemRuns = { enabled: () => false };
    w.h.clock.advance(RECHECK_RETRY_DELAY_MS / 1000 + 1);
    expect(await advanceCurrentRecheck(w.h.deps, "payments")).toMatchObject({ state: "unclear", attempt: 1 });
    expect((await readAutomaticRunsUse({ store: w.h.store, now: () => w.h.clock.now }, w.h.deps.companyId, "payments")).used).toBe(1);
    expect((await rechecksOf(w.h.store, w.h.deps.companyId, "payments"))[0]!.check.workspaceId).toBe(first!.check.workspaceId);
    expect(await setupGateBeforeBuild(w.h.deps, { project: "payments", taskId: task.taskId })).toEqual({ answer: "go" });
    expect(await setupRecheckLineOf(w.h.deps, "payments", task.taskId)).toBe("Couldn't re-check setup after dependency files changed.");
  });

  it("a re-check is the company's and the project's: its place in the cap and its audit event name them, and the actor is Rovara, not a person", async () => {
    const w = await world({ audit: "recording" });
    w.h.deps.systemRuns = { enabled: () => true };
    w.model.commit("main", { "package-lock.json": "lock-2" });
    await startTask(w);
    const [row] = await rechecksOf(w.h.store, w.h.deps.companyId, "payments");
    const claim = await w.h.store.get({ pk: `ORG#${w.h.deps.companyId}#PROJECT#payments`, sk: `AUTOMATIC_RUNS#RUN#setup-recheck-${row!.key}-1` });
    expect(claim).toMatchObject({ orgId: w.h.deps.companyId, project: "payments", job: "scheduled_check" });
    expect(row).toMatchObject({ orgId: w.h.deps.companyId, project: "payments", check: { startedBy: systemOwnerIdOf(w.h.deps.companyId, "payments") } });
    const events = w.h.audit.filter((event) => event.action === "setup_recheck.started");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ companyId: w.h.deps.companyId, actor: { type: "system", id: "rovara" }, subject: { type: "project", id: "payments" }, details: { job: "scheduled_check", attempt: 1 } });
    // The check's own workspace is the company's and the project's too (what machine time is booked by).
    const workspace = await readWorkspace(w.h.deps, row!.check.workspaceId);
    expect(workspace).toMatchObject({ companyId: w.h.deps.companyId, projectName: "payments" });
  });
});

describe("once per commit, and the monthly cap", () => {
  it("two tasks on one commit share one re-check and one place in the cap; a new commit is a new re-check", async () => {
    const w = await world();
    w.model.commit("main", { "package-lock.json": "lock-2" });
    const first = await startTask(w);
    const second = await startTask(w);
    const rows = await rechecksOf(w.h.store, w.h.deps.companyId, "payments");
    expect(rows).toHaveLength(1);
    expect(await stagedPreparations(w.h)).toBe(3);
    expect((await readAutomaticRunsUse({ store: w.h.store, now: () => w.h.clock.now }, w.h.deps.companyId, "payments")).used).toBe(1);
    expect((await linkOf(w, first.taskId))?.["recheckKey"]).toBe(rows[0]!.key);
    expect((await linkOf(w, second.taskId))?.["recheckKey"]).toBe(rows[0]!.key);
    // The first re-check passes (its baseline moves to its commit); a NEW commit after that is a new re-check.
    await finishCheck(w.h, rows[0]!.check.workspaceId, { status: "SUCCEEDED" });
    await advanceCurrentRecheck(w.h.deps, "payments");
    w.model.commit("main", { "package-lock.json": "lock-3" });
    await startTask(w);
    expect(await rechecksOf(w.h.store, w.h.deps.companyId, "payments")).toHaveLength(2);
    expect((await readAutomaticRunsUse({ store: w.h.store, now: () => w.h.clock.now }, w.h.deps.companyId, "payments")).used).toBe(2);
  });

  it("one re-check in flight per project: a task that starts on a NEWER commit while one runs joins it, and starts none of its own", async () => {
    const w = await world();
    w.model.commit("main", { "package-lock.json": "lock-2" });
    const first = await startTask(w);
    const [running] = await rechecksOf(w.h.store, w.h.deps.companyId, "payments");
    w.model.commit("main", { "package-lock.json": "lock-3" });
    const second = await startTask(w);
    expect(await rechecksOf(w.h.store, w.h.deps.companyId, "payments")).toHaveLength(1);
    expect((await linkOf(w, second.taskId))?.["recheckKey"]).toBe(running!.key);
    expect((await linkOf(w, first.taskId))?.["recheckKey"]).toBe(running!.key);
    expect((await readAutomaticRunsUse({ store: w.h.store, now: () => w.h.clock.now }, w.h.deps.companyId, "payments")).used).toBe(1);
    expect(await stagedPreparations(w.h)).toBe(3);
  });

  it("a comparison that can never be told (no baseline can be saved) re-checks once per revision per day, not once per commit", async () => {
    const w = await world({ snapshot: false });
    await w.h.store.put({ item: { ...projectMetaKey(w.h.deps.companyId, "payments"), entityType: "PROJECT_META" } });
    const ready = await readyCheckMark(w);
    await w.h.store.update({ key: projectMetaKey(w.h.deps.companyId, "payments"), ops: [{ op: "set", path: ["setupCheck"], value: ready as unknown as JsonValue }] });
    await startTask(w);
    const [first] = await rechecksOf(w.h.store, w.h.deps.companyId, "payments");
    // It ends without saving a baseline (the listing is over the limits), and more commits land the same day.
    await finishCheck(w.h, first!.check.workspaceId, { status: "SUCCEEDED" });
    w.model.incompleteTrees.add(w.model.headOf("main"));
    await advanceCurrentRecheck(w.h.deps, "payments");
    for (const n of [2, 3, 4]) { const head = w.model.commit("main", { "README.md": `readme ${String(n)}` }); w.model.incompleteTrees.add(head); await startTask(w); }
    expect(await rechecksOf(w.h.store, w.h.deps.companyId, "payments")).toHaveLength(1);
    expect((await readAutomaticRunsUse({ store: w.h.store, now: () => w.h.clock.now }, w.h.deps.companyId, "payments")).used).toBe(1);
    // The next day it is looked at again.
    w.h.clock.advance(86_400);
    const head = w.model.commit("main", { "README.md": "next day" }); w.model.incompleteTrees.add(head);
    await startTask(w);
    expect(await rechecksOf(w.h.store, w.h.deps.companyId, "payments")).toHaveLength(2);
  });

  it("two tasks that start at the same moment still start one re-check and spend one place in the cap", async () => {
    const w = await world();
    w.model.commit("main", { "package-lock.json": "lock-2" });
    await Promise.all([startTask(w), startTask(w), startTask(w)]);
    expect(await rechecksOf(w.h.store, w.h.deps.companyId, "payments")).toHaveLength(1);
    expect((await readAutomaticRunsUse({ store: w.h.store, now: () => w.h.clock.now }, w.h.deps.companyId, "payments")).used).toBe(1);
    // Three tasks' own preparations and exactly ONE check's: no second machine was made for the same commit.
    expect(await stagedPreparations(w.h)).toBe(4);
  });

  it("a cap that is used up starts no re-check, writes no link, and the task still starts; the pause is recorded once", async () => {
    const w = await world();
    const deps = { store: w.h.store, now: () => w.h.clock.now, companyId: w.h.deps.companyId, audit: w.h.deps.audit };
    await setAutomaticRunsCap(deps, { orgId: w.h.deps.companyId, project: "payments", changedBy: "local-owner", cap: 1, requestId: "cap-one-1234" });
    expect((await claimAutomaticRun(deps, { orgId: w.h.deps.companyId, project: "payments", requestId: "someone-elses-run", job: "nightly" })).claimed).toBe(true);
    w.model.commit("main", { "package-lock.json": "lock-2" });
    const task = await startTask(w);
    expect(task.status).toBe("STARTING");
    expect(await rechecksOf(w.h.store, w.h.deps.companyId, "payments")).toEqual([]);
    // DEC 254zzl: the task started all the same, nothing waits, and its page says quietly that the re-check could not be made.
    expect(await linkOf(w, task.taskId)).toMatchObject({ state: "released", noRecheck: { classes: ["lockfile"] }, recheckKey: "" });
    expect(await setupRecheckLineOf(w.h.deps, "payments", task.taskId)).toBe("Couldn't re-check setup after dependency files changed.");
    expect((await taskViewOf(w.h.deps, (await readTask(w.h.deps, task.taskId))!)).setupRecheck).toBe("Couldn't re-check setup after dependency files changed.");
    expect(await setupGateBeforeBuild(w.h.deps, { project: "payments", taskId: task.taskId })).toEqual({ answer: "go" });
    const use = await readAutomaticRunsUse(deps, w.h.deps.companyId, "payments");
    expect(use).toMatchObject({ used: 1, cap: 1, paused: true });
    expect(await w.h.store.get({ pk: `ORG#${w.h.deps.companyId}#PROJECT#payments`, sk: `AUTOMATIC_RUNS#PAUSED#${use.month}` }).catch(() => undefined) ?? true).toBeDefined();
  });

  it("a cap of zero pauses the re-check as it pauses every automatic run", async () => {
    const w = await world();
    const deps = { store: w.h.store, now: () => w.h.clock.now, companyId: w.h.deps.companyId, audit: w.h.deps.audit };
    await setAutomaticRunsCap(deps, { orgId: w.h.deps.companyId, project: "payments", changedBy: "local-owner", cap: 0, requestId: "cap-zero-1234" });
    w.model.commit("main", { "package-lock.json": "lock-2" });
    await startTask(w);
    expect(await rechecksOf(w.h.store, w.h.deps.companyId, "payments")).toEqual([]);
  });

  it("the retry takes its own place in the cap; a cap that is full at the retry ends the re-check as unclear, never as broken", async () => {
    const w = await world();
    const deps = { store: w.h.store, now: () => w.h.clock.now, companyId: w.h.deps.companyId, audit: w.h.deps.audit };
    await setAutomaticRunsCap(deps, { orgId: w.h.deps.companyId, project: "payments", changedBy: "local-owner", cap: 1, requestId: "cap-one-5678" });
    w.model.commit("main", { "package-lock.json": "lock-2" });
    const task = await startTask(w);
    const [row] = await rechecksOf(w.h.store, w.h.deps.companyId, "payments");
    await finishCheck(w.h, row!.check.workspaceId, { status: "FAILED", error: SETUP_FAILS });
    const settled = await advanceAfterFailure(w.h);
    expect(settled?.state).toBe("unclear");
    expect(await setupRecheckLineOf(w.h.deps, "payments", task.taskId)).toBe("Couldn't re-check setup after dependency files changed.");
    expect(await setupGateBeforeBuild(w.h.deps, { project: "payments", taskId: task.taskId })).toEqual({ answer: "go" });
  });
});

describe("no model, no person: the check is the existing preparation, run by the project's system owner", () => {
  it("starts a preparation-only workspace owned by the system owner, with no model prompt, no model route and no workflow mode", async () => {
    const w = await world();
    w.model.commit("main", { "package-lock.json": "lock-2" });
    await startTask(w);
    const [row] = await rechecksOf(w.h.store, w.h.deps.companyId, "payments");
    const operations = await workspaceOperations(w.h.deps, row!.check.workspaceId);
    expect(operations.map((operation) => operation.kind)).toEqual(["prepare"]);
    expect(operations[0]!.workflowMode).toBeUndefined();
    expect(JSON.stringify(operations[0]!.dispatch)).not.toMatch(/prompt|model/iu);
    expect(row!.check.startedBy).toBe(systemOwnerIdOf(w.h.deps.companyId, "payments"));
    await finishCheck(w.h, row!.check.workspaceId, { status: "SUCCEEDED" });
    await advanceCurrentRecheck(w.h.deps, "payments");
    expect(w.modelRoute).not.toHaveBeenCalled();
    // The workspace is closed with the check (a finished check keeps no machine).
    expect((await readWorkspace(w.h.deps, row!.check.workspaceId))?.status).toBe("CLOSED");
  });

  it("nothing in the re-check can approve a setup: no setup run, no candidate, no change of the project's revision", async () => {
    const w = await world();
    w.model.commit("main", { "package-lock.json": "lock-2" });
    const task = await startTask(w);
    const [row] = await rechecksOf(w.h.store, w.h.deps.companyId, "payments");
    await finishCheck(w.h, row!.check.workspaceId, { status: "FAILED", error: SETUP_FAILS });
    await advanceAfterFailure(w.h);
    const retry = (await rechecksOf(w.h.store, w.h.deps.companyId, "payments"))[0]!;
    await finishCheck(w.h, retry.check.workspaceId, { status: "FAILED", error: SETUP_FAILS });
    expect((await advanceAfterFailure(w.h))?.state).toBe("broken");
    expect(await setupGateBeforeBuild(w.h.deps, { project: "payments", taskId: task.taskId })).toMatchObject({ answer: "blocked" });
    expect(await w.h.store.get(orgProjectCatalogKey(w.h.deps.companyId, "payments"))).toMatchObject({ latestRevision: 1 });
    expect(await w.h.store.get(projectRevisionKey(w.h.deps.companyId, "payments", 2))).toBeUndefined();
    expect(await w.h.store.get({ pk: setupPartition(w.h.deps.companyId, "payments"), sk: "APPLY" })).toBeUndefined();
    expect(await w.h.store.get({ pk: setupPartition(w.h.deps.companyId, "payments"), sk: "AGENT" })).toBeUndefined();
    expect(w.modelRoute).not.toHaveBeenCalled();
  });

  it("the module has no path to an approval, a setup run or a model (a guard on the source, beside the behaviour above)", () => {
    const source = readFileSync(new URL("../../packages/broker/src/core/setup-agent/recheck.ts", import.meta.url), "utf8");
    for (const forbidden of [/confirmSetupAgent/u, /createSetupProposalSubject/u, /startSetupAgent/u, /setupApplyKey/u, /modelAccess/u, /latestRevision/u, /startUnattendedRun/u, /\.prompts\b/u]) {
      expect(source, String(forbidden)).not.toMatch(forbidden);
    }
  });
});

describe("the wait before Build, and only there", () => {
  it("Understand and Plan go on while the re-check runs; the first coding run waits, and goes when the check passes (silent)", async () => {
    const w = await world({ understandFirst: true });
    w.model.commit("main", { "package-lock.json": "lock-2" });
    const task = await startTask(w);
    const [row] = await rechecksOf(w.h.store, w.h.deps.companyId, "payments");
    // The task's own preparation ends and its Understand step is handed to the worker while the re-check is still running.
    const workspace = (await readWorkspace(w.h.deps, task.workspaceId))!;
    for (let round = 0; round < 8; round += 1) {
      await w.h.flow.dispatchOnce({ maxMessages: 10 });
      const after = (await readWorkspace(w.h.deps, task.workspaceId))!;
      const prepare = after.machine === undefined ? undefined : w.h.machines.delivered(after.machine.machineId).find((entry) => entry.kind === "prepare" && entry.workspaceId === task.workspaceId);
      if (prepare !== undefined) { await w.h.flow.recordResult({ workspaceId: after.id, operationId: prepare.operationId, fence: prepare.fence ?? after.fence, status: "SUCCEEDED", outcome: { kind: "prepared" } }); break; }
      w.h.clock.advance(70);
    }
    for (let round = 0; round < 6; round += 1) { await w.h.flow.dispatchOnce({ maxMessages: 10 }); w.h.clock.advance(70); }
    const delivered = w.h.machines.delivered((await readWorkspace(w.h.deps, task.workspaceId) ?? workspace).machine!.machineId);
    expect(delivered.some((entry) => entry.kind === "task" && (entry as { payload?: { workflowMode?: string } }).payload?.workflowMode === "UNDERSTAND")).toBe(true);
    expect((await advanceCurrentRecheck(w.h.deps, "payments"))?.state).toBe("running");
    expect(await setupGateBeforeBuild(w.h.deps, { project: "payments", taskId: task.taskId })).toEqual({ answer: "wait" });
    await finishCheck(w.h, row!.check.workspaceId, { status: "SUCCEEDED" });
    expect(await setupGateBeforeBuild(w.h.deps, { project: "payments", taskId: task.taskId })).toEqual({ answer: "go" });
    // Asked again after it went on: go at once, whatever the re-check says now.
    expect((await linkOf(w, task.taskId))?.["state"]).toBe("released");
    expect(await setupGateBeforeBuild(w.h.deps, { project: "payments", taskId: task.taskId })).toEqual({ answer: "go" });
  });

  it("a task with no drift link goes straight on", async () => {
    const w = await world();
    const task = await startTask(w);
    expect(await setupGateBeforeBuild(w.h.deps, { project: "payments", taskId: task.taskId })).toEqual({ answer: "go" });
  });

  it("a re-check that has not answered after the wait limit is unclear: the task goes on (it is never blocked on silence)", async () => {
    const w = await world();
    w.model.commit("main", { "package-lock.json": "lock-2" });
    const task = await startTask(w);
    expect(await setupGateBeforeBuild(w.h.deps, { project: "payments", taskId: task.taskId })).toEqual({ answer: "wait" });
    w.h.clock.advance((RECHECK_WAIT_MAX_MS - SETUP_CHECK_STUCK_MS + 60_000) / 1000);
    // Still within the check's own limit: it is still running.
    expect(await setupGateBeforeBuild(w.h.deps, { project: "payments", taskId: task.taskId })).toEqual({ answer: "wait" });
    w.h.clock.advance(SETUP_CHECK_STUCK_MS / 1000 + 120);
    // The check stalled and its retry is in flight, but the wait limit has passed: the task goes on (never blocked on silence).
    expect(await setupGateBeforeBuild(w.h.deps, { project: "payments", taskId: task.taskId })).toEqual({ answer: "go" });
    expect((await linkOf(w, task.taskId))?.["state"]).toBe("released");
  });

  it("the first coding run is held and then released (startImplementation): WAITING while it runs, STARTED after a pass", async () => {
    const w = await world();
    w.model.commit("main", { "package-lock.json": "lock-2" });
    const task = await startTask(w);
    const [row] = await rechecksOf(w.h.store, w.h.deps.companyId, "payments");
    const ready = await readyWorkflow(w, task.taskId);
    expect(await startImplementation(w.h.deps, { taskId: task.taskId, workflowRevision: ready.revision })).toBe("WAITING");
    expect((await readTask(w.h.deps, task.taskId))!.workflow!.state).toBe("READY");
    // The check's answer is recorded without a dispatch round (a round would also hand the task's own queued step to the worker and hold its workspace).
    const [prepare] = await workspaceOperations(w.h.deps, row!.check.workspaceId);
    await w.h.flow.recordResult({ workspaceId: row!.check.workspaceId, operationId: prepare!.id, fence: prepare!.fence, status: "SUCCEEDED" });
    expect(await startImplementation(w.h.deps, { taskId: task.taskId, workflowRevision: ready.revision })).toBe("STARTED");
  });
});

/** Puts the task where the first coding run is due: its own preparation and first step answered, the workspace free. */
async function readyWorkflow(w: World, taskId: string): Promise<WorkflowSnapshot> {
  const task = (await readTask(w.h.deps, taskId))!;
  const answered = new Set<string>();
  for (let round = 0; round < 8; round += 1) {
    const current = (await readWorkspace(w.h.deps, task.workspaceId))!;
    if (current.status === "READY" && current.activeOperationId === null) break;
    await w.h.flow.dispatchOnce({ maxMessages: 10 }); w.h.clock.advance(70);
    const after = (await readWorkspace(w.h.deps, task.workspaceId))!;
    const job = after.machine === undefined ? undefined : w.h.machines.delivered(after.machine.machineId).find((entry) => entry.workspaceId === task.workspaceId && !answered.has(entry.operationId));
    if (job === undefined) continue;
    answered.add(job.operationId);
    await w.h.flow.recordResult({ workspaceId: after.id, operationId: job.operationId, fence: job.fence ?? after.fence, status: "SUCCEEDED" });
  }
  const workflow = { ...(await readTask(w.h.deps, taskId))!.workflow!, revision: task.workflow!.revision + 1, stage: "IMPLEMENT", state: "READY", fixSource: "conflict", fixProblems: ["a.txt"],
    checkPolicy: { required: [], optional: [], selectedOptionalIds: [], proposed: [] } } as unknown as WorkflowSnapshot;
  await w.h.store.update({ key: taskKey(task.taskId), ops: [{ op: "set", path: ["workflow"], value: JSON.parse(JSON.stringify(workflow)) as JsonValue }] });
  w.h.deps.artifacts = { get: async () => undefined };
  return workflow;
}

describe("what the re-check says, and what blocks", () => {
  it("a pass is silent, moves the baseline to the re-checked commit (so the next task has no drift), and leaves one quiet evidence line on the task", async () => {
    const w = await world();
    const head = w.model.commit("main", { "package-lock.json": "lock-2", "docker-compose.yml": "services: { db: {} }" });
    const task = await startTask(w);
    const [row] = await rechecksOf(w.h.store, w.h.deps.companyId, "payments");
    await finishCheck(w.h, row!.check.workspaceId, { status: "SUCCEEDED" });
    const settled = await advanceCurrentRecheck(w.h.deps, "payments");
    expect(settled?.state).toBe("passed");
    const baseline = await readSetupSnapshot(w.h.store, w.h.deps.companyId, "payments") as { repositories: Array<{ commit: string }> };
    expect(baseline.repositories[0]!.commit).toBe(head);
    // The same commit again: no new re-check.
    const next = await startTask(w);
    expect(await rechecksOf(w.h.store, w.h.deps.companyId, "payments")).toHaveLength(1);
    expect(await linkOf(w, next.taskId)).toBeUndefined();
    const line = "Setup re-checked after dependency files and a compose file changed: still works.";
    expect(setupStillWorksWords(["lockfile", "compose"])).toBe(line);
    expect(await setupRecheckLineOf(w.h.deps, "payments", task.taskId)).toBe(line);
    expect((await taskViewOf(w.h.deps, (await readTask(w.h.deps, task.taskId))!)).setupRecheck).toBe(line);
    // Nothing for the project's people to act on, and the project's own setup state is untouched.
    expect(await readSetupRepairCard(w.h.deps, "payments")).toBeUndefined();
    expect((await w.h.store.get(projectMetaKey(w.h.deps.companyId, "payments")))?.["setupCheck"]).toBeUndefined();
    expect(await w.h.flow.start(w.h.owner, { requestId: newRequestId(), project: "payments", instructions: "More work" })).toBeDefined();
  });

  it("failing TESTS never block: the setup commands passed, so the setup works; the baseline moves and no retry is made", async () => {
    const w = await world();
    const head = w.model.commit("main", { "package-lock.json": "lock-2" });
    const task = await startTask(w);
    const [row] = await rechecksOf(w.h.store, w.h.deps.companyId, "payments");
    await finishCheck(w.h, row!.check.workspaceId, { status: "FAILED", error: TESTS_FAIL });
    const settled = await advanceCurrentRecheck(w.h.deps, "payments");
    expect(settled).toMatchObject({ state: "tests_failing", attempt: 1 });
    expect(await setupGateBeforeBuild(w.h.deps, { project: "payments", taskId: task.taskId })).toEqual({ answer: "go" });
    expect(await rechecksOf(w.h.store, w.h.deps.companyId, "payments")).toHaveLength(1);
    expect((await readSetupSnapshot(w.h.store, w.h.deps.companyId, "payments") as { repositories: Array<{ commit: string }> }).repositories[0]!.commit).toBe(head);
    expect(await readSetupRepairCard(w.h.deps, "payments")).toBeUndefined();
    expect((await w.h.store.get(projectMetaKey(w.h.deps.companyId, "payments")))?.["setupCheck"]).toBeUndefined();
    expect(await setupRecheckLineOf(w.h.deps, "payments", task.taskId)).toBe("Setup re-checked after dependency files changed: the setup works; some tests were already failing.");
    await w.h.flow.start(w.h.owner, { requestId: newRequestId(), project: "payments", instructions: "Still allowed" });
  });

  it("a setup step that fails is retried ONCE for a machine fault; a pass on the retry is a pass", async () => {
    const w = await world();
    w.model.commit("main", { "package-lock.json": "lock-2" });
    const task = await startTask(w);
    const [first] = await rechecksOf(w.h.store, w.h.deps.companyId, "payments");
    await finishCheck(w.h, first!.check.workspaceId, { status: "FAILED", error: SETUP_FAILS });
    expect(await advanceAfterFailure(w.h)).toMatchObject({ state: "running", attempt: 2 });
    expect(await setupGateBeforeBuild(w.h.deps, { project: "payments", taskId: task.taskId })).toEqual({ answer: "wait" });
    const [second] = await rechecksOf(w.h.store, w.h.deps.companyId, "payments");
    expect(second!.check.workspaceId).not.toBe(first!.check.workspaceId);
    expect((await readAutomaticRunsUse({ store: w.h.store, now: () => w.h.clock.now }, w.h.deps.companyId, "payments")).used).toBe(2);
    await finishCheck(w.h, second!.check.workspaceId, { status: "SUCCEEDED" });
    expect(await setupGateBeforeBuild(w.h.deps, { project: "payments", taskId: task.taskId })).toEqual({ answer: "go" });
    expect((await readSetupRepairCard(w.h.deps, "payments"))).toBeUndefined();
  });

  it("a setup step that fails twice is 'setup broken': the task pauses before Build with fixed words, the project is refused new starts, and the admins get ONE card", async () => {
    const w = await world();
    w.model.commit("main", { "package-lock.json": "lock-2" });
    const task = await startTask(w);
    const other = await startTask(w);
    const [first] = await rechecksOf(w.h.store, w.h.deps.companyId, "payments");
    await finishCheck(w.h, first!.check.workspaceId, { status: "FAILED", error: SETUP_FAILS });
    await advanceAfterFailure(w.h);
    const [second] = await rechecksOf(w.h.store, w.h.deps.companyId, "payments");
    await finishCheck(w.h, second!.check.workspaceId, { status: "FAILED", error: SETUP_FAILS });
    const broken = await advanceAfterFailure(w.h);
    expect(broken).toMatchObject({ state: "broken", attempt: 2, failedStep: "setup: npm ci - setup step 0 (npm ci) failed: exit 1" });
    // No third attempt, whoever asks and however often.
    await advanceCurrentRecheck(w.h.deps, "payments"); await advanceCurrentRecheck(w.h.deps, "payments");
    expect((await readAutomaticRunsUse({ store: w.h.store, now: () => w.h.clock.now }, w.h.deps.companyId, "payments")).used).toBe(2);
    const words = setupBrokenTaskWords(broken!.failedStep!);
    expect(await setupGateBeforeBuild(w.h.deps, { project: "payments", taskId: task.taskId })).toEqual({ answer: "blocked", words });
    expect(await setupGateBeforeBuild(w.h.deps, { project: "payments", taskId: other.taskId })).toEqual({ answer: "blocked", words });
    expect(words).toBe("I can't build this yet. This project's setup stopped working after recent code changes (setup: npm ci - setup step 0 (npm ci) failed: exit 1). I've asked the project's admins to approve a fix. Retry this step once the setup is fixed.");
    // The project's own state is now the failed check, so a new start is refused by today's rule.
    expect((await setupStateOf(w.h.deps, "payments", w.project)).status).toBe("failed");
    await expect(w.h.flow.start(w.h.owner, { requestId: newRequestId(), project: "payments", instructions: "Another" })).rejects.toThrow(setupFailedMessage("setup: npm ci - setup step 0 (npm ci) failed: exit 1"));
    // One card per project, in fixed words, with the two ways out.
    expect(await readSetupRepairCard(w.h.deps, "payments")).toMatchObject({
      title: "Setup needs repair", classes: ["lockfile"],
      body: "The project's setup stopped working after recent code changes (setup: npm ci - setup step 0 (npm ci) failed: exit 1). Rovara cannot build on this project until it is fixed.",
      actions: [{ id: "fix_setup", label: "Fix setup (uses your AI)" }, { id: "edit_commands", label: "Edit commands myself" }],
    });
    expect((await queryAll(w.h.store, { pk: setupPartition(w.h.deps.companyId, "payments"), sk: { op: "beginsWith", prefix: "REPAIR_NOTICE" } }))).toHaveLength(1);
    expect(await setupRecheckLineOf(w.h.deps, "payments", task.taskId)).toBe(words);
  });

  it("a broken setup pauses the first coding run (startImplementation) with the fixed words, and a newly approved setup lets a retry through", async () => {
    const w = await world();
    w.model.commit("main", { "package-lock.json": "lock-2" });
    const task = await startTask(w);
    const ready = await readyWorkflow(w, task.taskId);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const [row] = await rechecksOf(w.h.store, w.h.deps.companyId, "payments");
      await finishCheck(w.h, row!.check.workspaceId, { status: "FAILED", error: SETUP_FAILS });
      await advanceAfterFailure(w.h);
    }
    expect(await startImplementation(w.h.deps, { taskId: task.taskId, workflowRevision: ready.revision })).toBe("STALE");
    const paused = (await readTask(w.h.deps, task.taskId))!.workflow!;
    expect(paused.state).toBe("BLOCKED");
    expect(paused.blockReason).toContain("I can't build this yet.");
    // A person approved a new setup (a new revision): the old break no longer holds the task.
    await w.h.registerProject(projectOf("payments", { revision: 2 }));
    expect(await setupGateBeforeBuild(w.h.deps, { project: "payments", taskId: task.taskId })).toEqual({ answer: "go" });
    expect(await readSetupRepairCard(w.h.deps, "payments")).toBeUndefined();
  });

  it("a stalled check (no worker ever answered) is unclear, twice over: it never blocks anyone", async () => {
    const w = await world();
    w.model.commit("main", { "package-lock.json": "lock-2" });
    const task = await startTask(w);
    w.h.clock.advance(SETUP_CHECK_STUCK_MS / 1000 + 60);
    expect(await advanceAfterFailure(w.h)).toMatchObject({ state: "running", attempt: 2 });
    w.h.clock.advance(SETUP_CHECK_STUCK_MS / 1000 + 60);
    expect(await advanceCurrentRecheck(w.h.deps, "payments")).toMatchObject({ state: "unclear", attempt: 2 });
    expect(await setupGateBeforeBuild(w.h.deps, { project: "payments", taskId: task.taskId })).toEqual({ answer: "go" });
    // DEC 254zzl: it could not be settled, the task went on all the same, and its page says so quietly.
    expect(await setupRecheckLineOf(w.h.deps, "payments", task.taskId)).toBe("Couldn't re-check setup after dependency files changed.");
    expect((await setupStateOf(w.h.deps, "payments", w.project)).status).not.toBe("failed");
    await w.h.flow.start(w.h.owner, { requestId: newRequestId(), project: "payments", instructions: "Still allowed" });
  });

  it("the retry waits out its delay: a first failure is seen, and nothing is retried before the delay has passed (a short outage must not fail both tries)", async () => {
    const w = await world();
    w.model.commit("main", { "package-lock.json": "lock-2" });
    await startTask(w);
    const [first] = await rechecksOf(w.h.store, w.h.deps.companyId, "payments");
    await finishCheck(w.h, first!.check.workspaceId, { status: "FAILED", error: SETUP_FAILS });
    expect(await advanceCurrentRecheck(w.h.deps, "payments")).toMatchObject({ state: "running", attempt: 1 });
    w.h.clock.advance(RECHECK_RETRY_DELAY_MS / 1000 - 5);
    expect(await advanceCurrentRecheck(w.h.deps, "payments")).toMatchObject({ state: "running", attempt: 1 });
    expect((await readAutomaticRunsUse({ store: w.h.store, now: () => w.h.clock.now }, w.h.deps.companyId, "payments")).used).toBe(1);
    w.h.clock.advance(10);
    expect(await advanceCurrentRecheck(w.h.deps, "payments")).toMatchObject({ state: "running", attempt: 2 });
  });

  it("two callers that move the same failed re-check on together start ONE retry and keep its place in the cap", async () => {
    const w = await world();
    w.model.commit("main", { "package-lock.json": "lock-2" });
    await startTask(w);
    const [first] = await rechecksOf(w.h.store, w.h.deps.companyId, "payments");
    await finishCheck(w.h, first!.check.workspaceId, { status: "FAILED", error: SETUP_FAILS });
    await advanceCurrentRecheck(w.h.deps, "payments");
    w.h.clock.advance(RECHECK_RETRY_DELAY_MS / 1000 + 1);
    await Promise.all([advanceCurrentRecheck(w.h.deps, "payments"), advanceCurrentRecheck(w.h.deps, "payments"), advanceCurrentRecheck(w.h.deps, "payments")]);
    expect((await rechecksOf(w.h.store, w.h.deps.companyId, "payments"))[0]).toMatchObject({ attempt: 2 });
    expect((await readAutomaticRunsUse({ store: w.h.store, now: () => w.h.clock.now }, w.h.deps.companyId, "payments")).used).toBe(2);
  });

  it("a person's passing 'check again' lifts the break: tasks go on, the card goes, and new tasks on the same commit are not held", async () => {
    const w = await world();
    w.model.commit("main", { "package-lock.json": "lock-2" });
    const task = await startTask(w);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const [row] = await rechecksOf(w.h.store, w.h.deps.companyId, "payments");
      await finishCheck(w.h, row!.check.workspaceId, { status: "FAILED", error: SETUP_FAILS });
      await advanceAfterFailure(w.h);
    }
    expect(await setupGateBeforeBuild(w.h.deps, { project: "payments", taskId: task.taskId })).toMatchObject({ answer: "blocked" });
    expect(await readSetupRepairCard(w.h.deps, "payments")).toBeDefined();
    // Someone fixed the setup outside Rovara and ran "check the setup" again: it passed, and its mark replaced the failed one.
    w.h.clock.advance(120);
    const { buildSetupCheck, relayCheck } = await import("../../packages/broker/src/core/setup-agent/check.js");
    const again = buildSetupCheck(w.h.deps, { project: "payments", revision: 1, startedBy: "local-owner", requestId: newRequestId(), candidate: false });
    expect((await w.h.store.transact(again.items)).applied).toBe(true);
    await relayCheck(w.h.deps, again);
    await finishCheck(w.h, again.workspaceId, { status: "SUCCEEDED" });
    await w.h.store.update({ key: projectMetaKey(w.h.deps.companyId, "payments"), ops: [{ op: "set", path: ["setupCheck"], value: again.mark as unknown as JsonValue }] });
    expect(await readSetupRepairCard(w.h.deps, "payments")).toBeUndefined();
    expect(await setupGateBeforeBuild(w.h.deps, { project: "payments", taskId: task.taskId })).toEqual({ answer: "go" });
    const next = await startTask(w);
    expect(await setupGateBeforeBuild(w.h.deps, { project: "payments", taskId: next.taskId })).toEqual({ answer: "go" });
    // And the break does not put its failed mark back over the person's.
    await advanceCurrentRecheck(w.h.deps, "payments");
    expect(((await w.h.store.get(projectMetaKey(w.h.deps.companyId, "payments")))?.["setupCheck"] as { workspaceId: string }).workspaceId).toBe(again.workspaceId);
  });

  it("a break whose mark could not be written at once is written again when a task asks, and still holds", async () => {
    const w = await world();
    w.model.commit("main", { "package-lock.json": "lock-2" });
    const task = await startTask(w);
    const realUpdate = w.h.store.update.bind(w.h.store);
    let failures = 0;
    w.h.store.update = (async (input: Parameters<DocumentStore["update"]>[0]) => { if (input.key.sk === "META" && input.ops.some((op) => (op as { path?: unknown }).path?.toString() === "setupCheck" || (op as { path?: unknown }).path === "setupCheck") && failures < 1) { failures += 1; throw new Error("store fault"); } return realUpdate(input); });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const [row] = await rechecksOf(w.h.store, w.h.deps.companyId, "payments");
      await finishCheck(w.h, row!.check.workspaceId, { status: "FAILED", error: SETUP_FAILS });
      if (attempt === 0) await advanceAfterFailure(w.h); else await advanceCurrentRecheck(w.h.deps, "payments");
    }
    expect(failures).toBe(1);
    expect((await w.h.store.get(projectMetaKey(w.h.deps.companyId, "payments")))?.["setupCheck"]).toBeUndefined();
    expect(await setupGateBeforeBuild(w.h.deps, { project: "payments", taskId: task.taskId })).toMatchObject({ answer: "blocked" });
  });

  it("a re-check of an older revision that passes after a newer setup was approved does not move the baseline", async () => {
    const w = await world();
    const before = (await readSetupSnapshot(w.h.store, w.h.deps.companyId, "payments")) as { repositories: Array<{ commit: string }> };
    w.model.commit("main", { "package-lock.json": "lock-2" });
    await startTask(w);
    const [row] = await rechecksOf(w.h.store, w.h.deps.companyId, "payments");
    await w.h.registerProject(projectOf("payments", { revision: 2 }));
    await finishCheck(w.h, row!.check.workspaceId, { status: "SUCCEEDED" });
    expect((await advanceCurrentRecheck(w.h.deps, "payments"))?.state).toBe("passed");
    expect(((await readSetupSnapshot(w.h.store, w.h.deps.companyId, "payments")) as { repositories: Array<{ commit: string }> }).repositories[0]!.commit).toBe(before.repositories[0]!.commit);
  });

  it("a break never overwrites the mark of a newer setup", async () => {
    const w = await world();
    w.model.commit("main", { "package-lock.json": "lock-2" });
    await startTask(w);
    const newer = { workspaceId: "0e1a2b3c-0000-4000-8000-000000000001", revision: 2, startedAt: "2026-11-09T09:00:00.000Z", startedBy: "local-owner" };
    await w.h.store.update({ key: projectMetaKey(w.h.deps.companyId, "payments"), ops: [{ op: "set", path: ["setupCheck"], value: newer as unknown as JsonValue }] });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const [row] = await rechecksOf(w.h.store, w.h.deps.companyId, "payments");
      await finishCheck(w.h, row!.check.workspaceId, { status: "FAILED", error: SETUP_FAILS });
      await advanceAfterFailure(w.h);
    }
    expect((await w.h.store.get(projectMetaKey(w.h.deps.companyId, "payments")))?.["setupCheck"]).toEqual(newer);
  });

  it("a failure with no recorded step is unclear and never blocks", async () => {
    const w = await world();
    w.model.commit("main", { "package-lock.json": "lock-2" });
    const task = await startTask(w);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const [row] = await rechecksOf(w.h.store, w.h.deps.companyId, "payments");
      await finishCheck(w.h, row!.check.workspaceId, { status: "FAILED", error: "" });
      await advanceAfterFailure(w.h);
    }
    expect((await rechecksOf(w.h.store, w.h.deps.companyId, "payments"))[0]!.state).not.toBe("broken");
    expect((await setupGateBeforeBuild(w.h.deps, { project: "payments", taskId: task.taskId })).answer).toBe("go");
  });

  it("the health class of each result: only a failing setup COMMAND is 'environment'", () => {
    expect(classifySetupRecheck({ status: "failed", failedStep: "setup: npm ci - exit 1", failedStage: "setup_command" })).toMatchObject({ class: "environment", cause: "setup_failed" });
    // A clone, a credential, a machine or a dev container that failed says nothing about the project's setup commands.
    expect(classifySetupRecheck({ status: "failed", failedStep: "setup: could not clone", failedStage: "other" })).toMatchObject({ class: "unclear" });
    expect(classifySetupRecheck({ status: "failed", failedStep: "test: npm test - exit 1", failedStage: "test_command" })).toMatchObject({ class: "tests", setupProved: true });
    expect(classifySetupRecheck({ status: "failed", failedStep: "setup did not finish" })).toMatchObject({ class: "unclear" });
    expect(classifySetupRecheck({ status: "failed" })).toMatchObject({ class: "unclear" });
    expect(classifySetupRecheck({ status: "failed", failedStep: "something else" })).toMatchObject({ class: "unclear" });
  });

  it("a preparation that failed for a reason that is not a setup command (a clone, a machine) is retried and then unclear: it never pauses the project", async () => {
    const w = await world();
    w.model.commit("main", { "package-lock.json": "lock-2" });
    const task = await startTask(w);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const [row] = await rechecksOf(w.h.store, w.h.deps.companyId, "payments");
      await finishCheck(w.h, row!.check.workspaceId, { status: "FAILED", error: "could not clone the repository" });
      await advanceAfterFailure(w.h);
    }
    expect((await rechecksOf(w.h.store, w.h.deps.companyId, "payments"))[0]!.state).toBe("unclear");
    expect(await setupRecheckLineOf(w.h.deps, "payments", task.taskId)).toBe("Couldn't re-check setup after dependency files changed.");
    expect((await setupStateOf(w.h.deps, "payments", w.project)).status).not.toBe("failed");
    expect(await setupGateBeforeBuild(w.h.deps, { project: "payments", taskId: task.taskId })).toEqual({ answer: "go" });
  });

  it("repository text never reaches the line or card except the check's own redacted failing step", async () => {
    const w = await world();
    w.model.commit("main", { "package-lock.json": "lock-2" });
    const task = await startTask(w);
    const [row] = await rechecksOf(w.h.store, w.h.deps.companyId, "payments");
    expect(JSON.stringify(row)).not.toContain("package-lock");
    expect(await setupRecheckLineOf(w.h.deps, "payments", task.taskId)).not.toMatch(/package-lock|\.json|\//u);
  });
});

describe("isolation", () => {
  it("another project of the company has its own snapshot, re-check and card: drift in one starts nothing for the other", async () => {
    const w = await world();
    await w.h.registerProject(projectOf("billing"));
    await saveSnapshot(w, projectOf("billing"));
    w.model.commit("main", { "package-lock.json": "lock-2" });
    const task = await startTask(w, "payments");
    expect(await rechecksOf(w.h.store, w.h.deps.companyId, "payments")).toHaveLength(1);
    expect(await rechecksOf(w.h.store, w.h.deps.companyId, "billing")).toEqual([]);
    expect(await linkOf(w, task.taskId, "billing")).toBeUndefined();
    expect(await readSetupSnapshot(w.h.store, w.h.deps.companyId, "billing")).toBeDefined();
    // The other project's drift is its own re-check and its own place in its own cap.
    const billing = await startTask(w, "billing");
    expect(await rechecksOf(w.h.store, w.h.deps.companyId, "billing")).toHaveLength(1);
    expect((await readAutomaticRunsUse({ store: w.h.store, now: () => w.h.clock.now }, w.h.deps.companyId, "billing")).used).toBe(1);
    expect(await setupGateBeforeBuild(w.h.deps, { project: "payments", taskId: billing.taskId })).toEqual({ answer: "go" });
    // Breaking one project's setup does not break the other.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const [row] = await rechecksOf(w.h.store, w.h.deps.companyId, "payments");
      await finishCheck(w.h, row!.check.workspaceId, { status: "FAILED", error: SETUP_FAILS });
      await advanceAfterFailure(w.h);
    }
    expect(await readSetupRepairCard(w.h.deps, "payments")).toBeDefined();
    expect(await readSetupRepairCard(w.h.deps, "billing")).toBeUndefined();
  });

  it("another company's project of the same name never meets this company's snapshot, re-check, link or card", async () => {
    const shared = new MemoryDocumentStore({ indexes: TASK_FLOW_INDEXES, nowSeconds: () => Math.floor(Date.parse("2026-11-09T10:00:00.000Z") / 1_000) });
    const backend = (): { store: DocumentStore; queues: MemoryQueueService } => ({ store: shared, queues: new MemoryQueueService({ now: () => Date.parse("2026-11-09T10:00:00.000Z") }) });
    const a = await world({ backend });
    const b = await world({ backend, companyId: COMPANY_B });
    expect(a.h.deps.companyId).toBe(IMPLICIT_COMPANY_ID);
    // Company A drifts and breaks; company B's identical project, files and snapshot do not.
    a.model.commit("main", { "package-lock.json": "lock-2" });
    const task = await startTask(a);
    expect(await rechecksOf(shared, a.h.deps.companyId, "payments")).toHaveLength(1);
    expect(await rechecksOf(shared, COMPANY_B, "payments")).toEqual([]);
    expect(await readSetupSnapshot(shared, COMPANY_B, "payments")).toBeDefined();
    expect(await a.h.store.get(driftTaskKey(COMPANY_B, "payments", task.taskId))).toBeUndefined();
    // B's flow cannot read A's rows even by their keys, and A's task is not B's.
    expect(await setupGateBeforeBuild(b.h.deps, { project: "payments", taskId: task.taskId })).toEqual({ answer: "go" });
    expect(await setupRecheckLineOf(b.h.deps, "payments", task.taskId)).toBeUndefined();
    const [row] = await rechecksOf(shared, a.h.deps.companyId, "payments");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const [current] = await rechecksOf(shared, a.h.deps.companyId, "payments");
      await finishCheck(a.h, current!.check.workspaceId, { status: "FAILED", error: SETUP_FAILS });
      await advanceAfterFailure(a.h);
    }
    expect(row).toBeDefined();
    expect(await readSetupRepairCard(a.h.deps, "payments")).toBeDefined();
    expect(await readSetupRepairCard(b.h.deps, "payments")).toBeUndefined();
    expect((await setupStateOf(b.h.deps, "payments", b.project)).status).not.toBe("failed");
    expect(await advanceCurrentRecheck(b.h.deps, "payments")).toBeUndefined();
    // Rows of one company copied under the other's keys read as nothing: each row names its own company and project.
    const copyAll = async (to: { orgId: OrgId; project: string }): Promise<void> => {
      const sourceKeys = [recheckRowKey(a.h.deps.companyId, "payments", row!.key), driftTaskKey(a.h.deps.companyId, "payments", task.taskId), repairNoticeKey(a.h.deps.companyId, "payments"), setupSnapshotKey(a.h.deps.companyId, "payments")];
      const targetKeys = [recheckRowKey(to.orgId, to.project, row!.key), driftTaskKey(to.orgId, to.project, task.taskId), repairNoticeKey(to.orgId, to.project), setupSnapshotKey(to.orgId, to.project)];
      for (const [index, key] of sourceKeys.entries()) {
        const original = await shared.get(key);
        expect(original, key.sk).toBeDefined();
        await shared.put({ item: { ...original!, ...targetKeys[index]! } });
      }
    };
    await copyAll({ orgId: COMPANY_B, project: "payments" });
    expect(await setupRecheckLineOf(b.h.deps, "payments", task.taskId)).toBeUndefined();
    expect(await readSetupRepairCard(b.h.deps, "payments")).toBeUndefined();
    expect(await setupGateBeforeBuild(b.h.deps, { project: "payments", taskId: task.taskId })).toEqual({ answer: "go" });
    // The same, one project over inside one company: another project's partition holds this project's rows, and they read as nothing there.
    await a.h.registerProject(projectOf("billing"));
    await copyAll({ orgId: a.h.deps.companyId, project: "billing" });
    expect(await setupRecheckLineOf(a.h.deps, "billing", task.taskId)).toBeUndefined();
    expect(await readSetupRepairCard(a.h.deps, "billing")).toBeUndefined();
  });
});

describe("the task page's line", () => {
  it("shows nothing for a task with no re-check and one line for a task with one, whoever reads the view", async () => {
    const w = await world();
    const quiet = await startTask(w);
    expect((await taskViewOf(w.h.deps, (await readTask(w.h.deps, quiet.taskId))!)).setupRecheck).toBeUndefined();
    w.model.commit("main", { ".nvmrc": "24" });
    const loud = await startTask(w);
    expect((await taskViewOf(w.h.deps, (await readTask(w.h.deps, loud.taskId))!)).setupRecheck).toBe(SETUP_CHECKING_WORDS);
  });
});
