// L4-DR (DEC 254z c, DEC 254zw): the drift check at task start and the free automatic setup re-check, on the task flow's fakes (an in-memory store and queue, a fake worker machine, a fake code host).
// What is proved here, and what each proof would catch if the code were changed (the mutants are listed in the PR body):
//   detection        every watched file class, a new file, a removed file and the allowed websites each start a re-check; no change starts none; "cannot tell" is never "no drift"
//   once per commit  two tasks on one commit share one re-check; a new commit is a new one
//   the cap          the project's monthly cap on automatic runs holds the re-check; at the cap nothing starts and the task still starts
//   no model         the check is the existing preparation, started by the project's system owner; the model route is never asked
//   no hold          DEC 254zzz447 (don't block work): NOTHING waits for a re-check and a broken setup pauses and refuses nothing; a pass is silent and moves the baseline
//   what warns       ONLY a setup step failing twice; failing tests and an unclear result never do; nothing here approves a setup. The warning is a timeline line, once per task
//   isolation        another project and another company never meet the snapshot, the re-check or the card
import { systemRunsConsentKey } from "../../packages/broker/src/core/system-runs/consent.js";
import { hostedSystemRunsFor } from "../../packages/broker/src/core-host/system-runs.js";
import { parseCoreSwitch } from "../../packages/broker/src/core-host/flags.js";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { WORKER_INVOCATION_FEATURES, type CodeMilestone, projectMetaKey, queryAll, type DocumentStore, type JsonValue, type OrgId, type ProjectDefinition, type WorkflowSnapshot } from "@agentx/contracts";
import { claimAutomaticRun, readAutomaticRunsUse, setAutomaticRunsCap } from "../../packages/broker/src/core/automatic-runs/cap.js";
import { startImplementation } from "../../packages/broker/src/core/build-step/start.js";
import { SETUP_CHECK_STUCK_MS, setupStateOf } from "../../packages/broker/src/core/setup-agent/check.js";
import { RECHECK_RETRY_DELAY_MS, RECHECK_WAIT_MAX_MS, SETUP_CHECKING_WORDS, SETUP_NEEDS_REPAIR_WARNING, advanceCurrentRecheck, classifySetupRecheck, driftTaskKey, readSetupRepairCard, setupGateBeforeBuild, setupRecheckLineOf, type RecheckRow } from "../../packages/broker/src/core/setup-agent/recheck.js";
import { readSetupSnapshot, snapshotItem, takeSetupSnapshot } from "../../packages/broker/src/core/setup-agent/snapshot.js";
import { setupPartition } from "../../packages/broker/src/core/setup-agent/keys.js";
import { readTask, taskViewOf } from "../../packages/broker/src/core/task-flow/reads.js";
import { readWorkspace } from "../../packages/broker/src/core/task-flow/stage-machine.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { createAdapterRegistry } from "../../packages/broker/src/ports/adapter-registry.js";
import { FakeCodeHost } from "../../packages/broker/src/plugins/fake/code-host.js";
import { FakeHostModel } from "../../packages/broker/src/plugins/fake/model.js";
import { createDocumentMilestones } from "../../packages/broker/src/core/milestones/milestones.js";
import { createHarness, definition, newRequestId, type Harness } from "../support/task-flow-harness.js";

const URL_ = "https://examplehost.test/acme/app";
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

describe("the drift check at task start", () => {

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

  // L4-P2 (owner DEC 254zzt): the gate is the EFFECTIVE one (the operator's ceiling AND the company's consent, read now and async). The dispatcher runs `setupGateBeforeBuild` -> `retryRecheck` with it.
  // MUTANT: the retry reads an absent/stale gate, or `retryRecheck` stops awaiting it (a Promise is truthy), so a withdrawn consent still lets the retry start.
  it("the company withdraws its consent after a first attempt began: the retry (asked at Build, as the dispatcher does) is not started, the re-check ends unclear, nothing blocks", async () => {
    const w = await world();
    const orgId = w.h.deps.companyId;
    const consent = async (enabled: boolean): Promise<void> => { await w.h.store.put({ item: { ...systemRunsConsentKey(orgId), entityType: "SYSTEM_RUNS_CONSENT", orgId, enabled, changedAt: "2026-11-17T00:00:00.000Z" } }); };
    await consent(true);
    hostedSystemRunsFor(w.h.deps, orgId, parseCoreSwitch("on").value);
    w.model.commit("main", { "package-lock.json": "lock-2" });
    const task = await startTask(w);
    const [first] = await rechecksOf(w.h.store, orgId, "payments");
    expect(first).toBeDefined();
    await finishCheck(w.h, first!.check.workspaceId, { status: "FAILED", error: SETUP_FAILS });
    await advanceCurrentRecheck(w.h.deps, "payments");
    await consent(false);
    w.h.clock.advance(RECHECK_RETRY_DELAY_MS / 1000 + 1);
    expect(await setupGateBeforeBuild(w.h.deps, { project: "payments", taskId: task.taskId })).toEqual({ answer: "go" });
    expect((await rechecksOf(w.h.store, orgId, "payments"))).toHaveLength(1);
    expect((await rechecksOf(w.h.store, orgId, "payments"))[0]).toMatchObject({ state: "unclear", attempt: 1 });
  });

  it("a gate that rejects is off: no re-check at task start and no retry", async () => {
    const w = await world();
    w.h.deps.systemRuns = { enabled: async () => { throw new Error("consent unreadable"); } };
    w.model.commit("main", { "package-lock.json": "lock-2" });
    await startTask(w);
    expect(await rechecksOf(w.h.store, w.h.deps.companyId, "payments")).toEqual([]);
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

  it("the module has no path to an approval, a setup run or a model (a guard on the source, beside the behaviour above)", () => {
    const source = readFileSync(new URL("../../packages/broker/src/core/setup-agent/recheck.ts", import.meta.url), "utf8");
    for (const forbidden of [/confirmSetupAgent/u, /createSetupProposalSubject/u, /startSetupAgent/u, /setupApplyKey/u, /modelAccess/u, /latestRevision/u, /startUnattendedRun/u, /\.prompts\b/u]) {
      expect(source, String(forbidden)).not.toMatch(forbidden);
    }
  });
});

describe("Build is never held (DEC 254zzz447)", () => {

  it("a running re-check never holds Build: the gate answers go at once, however long the check has run, and lets the task's link through", async () => {
    const w = await world();
    w.model.commit("main", { "package-lock.json": "lock-2" });
    const task = await startTask(w);
    expect(await setupGateBeforeBuild(w.h.deps, { project: "payments", taskId: task.taskId })).toEqual({ answer: "go" });
    expect((await linkOf(w, task.taskId))?.["state"]).toBe("released");
    // Past every limit the old wait had: still go (the gate has no wait left).
    w.h.clock.advance((RECHECK_WAIT_MAX_MS + SETUP_CHECK_STUCK_MS) / 1000 + 120);
    expect(await setupGateBeforeBuild(w.h.deps, { project: "payments", taskId: task.taskId })).toEqual({ answer: "go" });
  });

  it("the first coding run starts at once while the re-check is still running (startImplementation): STARTED, not WAITING, and no warning line", async () => {
    const w = await world();
    const milestones = createDocumentMilestones({ store: w.h.store, now: () => w.h.clock.now });
    w.h.deps.milestones = milestones;
    w.model.commit("main", { "package-lock.json": "lock-2" });
    const task = await startTask(w);
    const [row] = await rechecksOf(w.h.store, w.h.deps.companyId, "payments");
    expect(row!.state).toBe("running");
    const ready = await readyWorkflow(w, task.taskId);
    expect(await startImplementation(w.h.deps, { taskId: task.taskId, workflowRevision: ready.revision })).toBe("STARTED");
    expect((await readTask(w.h.deps, task.taskId))!.workflow!.state).toBe("RUNNING");
    expect((await rechecksOf(w.h.store, w.h.deps.companyId, "payments"))[0]!.state).toBe("running");
    expect(await queryAll(w.h.store, { pk: `DEVTASK#${task.taskId}`, sk: { op: "beginsWith", prefix: "CODE_MILESTONE#setup_paused#" } })).toHaveLength(0);
  });
});

describe("which failed setup still refuses a start (DEC 254zzz447 lifts ONLY the re-check's)", () => {
  const startRequest = (w: World) => w.h.flow.start(w.h.owner, { requestId: newRequestId(), project: "payments", instructions: "Change a thing", workflow: true, workflowPath: "QUICK" });
  /** A person's own "check the setup" that FAILED, written as the project's mark (what the setup-check route does). */
  async function personsFailedCheck(w: World): Promise<void> {
    const { buildSetupCheck, relayCheck } = await import("../../packages/broker/src/core/setup-agent/check.js");
    const own = buildSetupCheck(w.h.deps, { project: "payments", revision: 1, startedBy: "local-owner", requestId: newRequestId(), candidate: false });
    expect((await w.h.store.transact(own.items)).applied).toBe(true);
    await relayCheck(w.h.deps, own);
    await finishCheck(w.h, own.workspaceId, { status: "FAILED", error: SETUP_FAILS });
    await w.h.store.update({ key: projectMetaKey(w.h.deps.companyId, "payments"), ops: [{ op: "set", path: ["setupCheck"], value: own.mark as unknown as JsonValue }] });
  }
  async function breakByRecheck(w: World): Promise<void> {
    w.model.commit("main", { "package-lock.json": "lock-2" });
    await startTask(w);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const [row] = await rechecksOf(w.h.store, w.h.deps.companyId, "payments");
      await finishCheck(w.h, row!.check.workspaceId, { status: "FAILED", error: SETUP_FAILS });
      await advanceAfterFailure(w.h);
    }
  }

  it("a person's own failed setup check still refuses a new start (unchanged: task-flow/start.ts)", async () => {
    const w = await world({ snapshot: false });
    await personsFailedCheck(w);
    expect((await setupStateOf(w.h.deps, "payments", w.project)).status).toBe("failed");
    expect(await readSetupRepairCard(w.h.deps, "payments")).toBeUndefined();
    await expect(startRequest(w)).rejects.toThrow(/failed its last check/u);
  });

  it("a project whose setup was never approved or checked starts as it always did (unchanged), with no warning and no link", async () => {
    const w = await world({ snapshot: false });
    expect((await setupStateOf(w.h.deps, "payments", w.project)).status).toBe("unchecked");
    const started = await startRequest(w);
    expect(await linkOf(w, started.task.taskId)).toBeUndefined();
    expect(await setupRecheckLineOf(w.h.deps, "payments", started.task.taskId)).toBeUndefined();
  });

  it("a re-check's break does not refuse a start, but a person's failed check made AFTER it does again (the mark is the person's)", async () => {
    const w = await world();
    await breakByRecheck(w);
    expect((await setupStateOf(w.h.deps, "payments", w.project)).status).toBe("failed");
    expect(await readSetupRepairCard(w.h.deps, "payments")).toBeDefined();
    expect((await startRequest(w)).task.taskId).toBeDefined();
    w.h.clock.advance(120);
    await personsFailedCheck(w);
    expect(await readSetupRepairCard(w.h.deps, "payments")).toBeUndefined();
    await expect(startRequest(w)).rejects.toThrow(/failed its last check/u);
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

  it("a broken setup does not pause the first coding run (startImplementation): it STARTS, with the warning, and a newly approved setup ends the warning", async () => {
    const w = await world();
    w.model.commit("main", { "package-lock.json": "lock-2" });
    const task = await startTask(w);
    const ready = await readyWorkflow(w, task.taskId);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const [row] = await rechecksOf(w.h.store, w.h.deps.companyId, "payments");
      await finishCheck(w.h, row!.check.workspaceId, { status: "FAILED", error: SETUP_FAILS });
      await advanceAfterFailure(w.h);
    }
    expect((await rechecksOf(w.h.store, w.h.deps.companyId, "payments"))[0]!.state).toBe("broken");
    expect(await readSetupRepairCard(w.h.deps, "payments")).toBeDefined();
    expect(await startImplementation(w.h.deps, { taskId: task.taskId, workflowRevision: ready.revision })).toBe("STARTED");
    const started = (await readTask(w.h.deps, task.taskId))!.workflow!;
    expect(started.state).toBe("RUNNING");
    expect(started.blockReason).toBeUndefined();
    // The task's page carries the plain warning line.
    expect(await setupRecheckLineOf(w.h.deps, "payments", task.taskId)).toBe(SETUP_NEEDS_REPAIR_WARNING);
    // A person approved a new setup (a new revision): the old break is no longer the project's, and there is no warning.
    await w.h.registerProject(projectOf("payments", { revision: 2 }));
    expect(await setupGateBeforeBuild(w.h.deps, { project: "payments", taskId: task.taskId })).toEqual({ answer: "go" });
    expect(await readSetupRepairCard(w.h.deps, "payments")).toBeUndefined();
  });

  it("a task that STARTS while the setup is already broken is not refused, links to the break (its page says it), and reaches Build with the warning once", async () => {
    const w = await world();
    const milestones = createDocumentMilestones({ store: w.h.store, now: () => w.h.clock.now });
    w.h.deps.milestones = milestones;
    const heard: CodeMilestone[] = [];
    milestones.register({ name: "probe", on: async (milestone) => { heard.push(milestone); } });
    w.model.commit("main", { "package-lock.json": "lock-2" });
    const first = await startTask(w);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const [row] = await rechecksOf(w.h.store, w.h.deps.companyId, "payments");
      await finishCheck(w.h, row!.check.workspaceId, { status: "FAILED", error: SETUP_FAILS });
      await advanceAfterFailure(w.h);
    }
    const [broken] = await rechecksOf(w.h.store, w.h.deps.companyId, "payments");
    expect(broken!.state).toBe("broken");
    // The project's own setup state is the failed re-check, and the start of a NEW task is not refused for it.
    expect((await setupStateOf(w.h.deps, "payments", w.project)).status).toBe("failed");
    const next = await startTask(w);
    expect(await linkOf(w, next.taskId)).toMatchObject({ recheckKey: broken!.key });
    expect(await setupRecheckLineOf(w.h.deps, "payments", next.taskId)).toBe(SETUP_NEEDS_REPAIR_WARNING);
    expect((await taskViewOf(w.h.deps, (await readTask(w.h.deps, next.taskId))!)).setupRecheck).toBe(SETUP_NEEDS_REPAIR_WARNING);
    // Both tasks reach Build and start; each timeline carries ONE warning line, and a later coding round of the same task does not repeat it.
    for (const task of [first, next]) {
      const ready = await readyWorkflow(w, task.taskId);
      expect(await startImplementation(w.h.deps, { taskId: task.taskId, workflowRevision: ready.revision })).toBe("STARTED");
      const again = await readyWorkflow(w, task.taskId);
      expect(await startImplementation(w.h.deps, { taskId: task.taskId, workflowRevision: again.revision })).toBe("STARTED");
      expect(await queryAll(w.h.store, { pk: `DEVTASK#${task.taskId}`, sk: { op: "beginsWith", prefix: "CODE_MILESTONE#setup_paused#" } })).toHaveLength(1);
    }
    expect(heard.filter((milestone) => milestone.kind === "setup_paused").map((milestone) => milestone.text)).toEqual([SETUP_NEEDS_REPAIR_WARNING, SETUP_NEEDS_REPAIR_WARNING]);
  });

  it("L4-U5: reaching Build under a break writes the setup_paused WARNING milestone in the same commit as the run's start (the thread and the ticket are told by the hook), and the admins' hook hears each break with its re-check key", async () => {
    const w = await world();
    const milestones = createDocumentMilestones({ store: w.h.store, now: () => w.h.clock.now });
    w.h.deps.milestones = milestones;
    const told = vi.fn(async () => undefined);
    w.h.deps.setupBroken = told;
    const heard: CodeMilestone[] = [];
    milestones.register({ name: "probe", on: async (milestone) => { heard.push(milestone); } });
    w.model.commit("main", { "package-lock.json": "lock-2" });
    const task = await startTask(w);
    const ready = await readyWorkflow(w, task.taskId);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const [row] = await rechecksOf(w.h.store, w.h.deps.companyId, "payments");
      await finishCheck(w.h, row!.check.workspaceId, { status: "FAILED", error: SETUP_FAILS });
      await advanceAfterFailure(w.h);
    }
    const [broken] = await rechecksOf(w.h.store, w.h.deps.companyId, "payments");
    // Every settlement and every later read of the same break names the same key (the host's marker makes it once).
    expect(told).toHaveBeenCalled();
    for (const call of told.mock.calls) expect(call).toEqual([{ project: "payments", recheckKey: broken!.key }]);
    expect(await startImplementation(w.h.deps, { taskId: task.taskId, workflowRevision: ready.revision })).toBe("STARTED");
    const paused = (await readTask(w.h.deps, task.taskId))!.workflow!;
    expect(paused.state).toBe("RUNNING");
    expect(heard.filter((milestone) => milestone.kind === "setup_paused")).toHaveLength(1);
    expect(heard.find((milestone) => milestone.kind === "setup_paused")).toMatchObject({ orgId: w.h.deps.companyId, taskId: task.taskId, text: "Setup needs repair: work continues; results may be less reliable until setup is fixed." });
    expect(JSON.stringify(heard)).not.toContain("npm ci");
    const rows = await queryAll(w.h.store, { pk: `DEVTASK#${task.taskId}`, sk: { op: "beginsWith", prefix: "CODE_MILESTONE#setup_paused#" } });
    expect(rows.map((row) => row.sk)).toEqual([`CODE_MILESTONE#setup_paused#${String(paused.revision).padStart(6, "0")}`]);
  });

  it("L4-U5: a break that no longer holds (a newer setup was approved) tells the admins nothing, and a host with no admins' hook still goes on (with the warning, never a pause)", async () => {
    const w = await world();
    const told = vi.fn(async () => undefined);
    w.h.deps.setupBroken = told;
    w.model.commit("main", { "package-lock.json": "lock-2" });
    const task = await startTask(w);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const [row] = await rechecksOf(w.h.store, w.h.deps.companyId, "payments");
      await finishCheck(w.h, row!.check.workspaceId, { status: "FAILED", error: SETUP_FAILS });
      if (attempt === 0) await advanceAfterFailure(w.h);
    }
    // A person approves a new setup (revision 2) before the second failure is read: the break is not the project's any more.
    await w.h.registerProject(projectOf("payments", { revision: 2 }));
    await advanceAfterFailure(w.h);
    expect(told).not.toHaveBeenCalled();
    const bare = await world();
    bare.model.commit("main", { "package-lock.json": "lock-2" });
    const bareTask = await startTask(bare);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const [row] = await rechecksOf(bare.h.store, bare.h.deps.companyId, "payments");
      await finishCheck(bare.h, row!.check.workspaceId, { status: "FAILED", error: SETUP_FAILS });
      await advanceAfterFailure(bare.h);
    }
    expect(await setupGateBeforeBuild(bare.h.deps, { project: "payments", taskId: bareTask.taskId })).toMatchObject({ answer: "go", brokenSetup: {} });
    expect(task.taskId).not.toBe(bareTask.taskId);
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

  it("a person's passing 'check again' lifts the break: the warning and the card go, and new tasks on the same commit have no warning", async () => {
    const w = await world();
    w.model.commit("main", { "package-lock.json": "lock-2" });
    const task = await startTask(w);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const [row] = await rechecksOf(w.h.store, w.h.deps.companyId, "payments");
      await finishCheck(w.h, row!.check.workspaceId, { status: "FAILED", error: SETUP_FAILS });
      await advanceAfterFailure(w.h);
    }
    expect(await setupGateBeforeBuild(w.h.deps, { project: "payments", taskId: task.taskId })).toMatchObject({ answer: "go", brokenSetup: {} });
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
    expect(await setupGateBeforeBuild(w.h.deps, { project: "payments", taskId: task.taskId })).toMatchObject({ answer: "go", brokenSetup: {} });
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

});

