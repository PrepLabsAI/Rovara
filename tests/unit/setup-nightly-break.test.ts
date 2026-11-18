// L4-U5b: a breakage found by the NIGHT's setup check tells the project's admins once, the same way the task-start re-check does. The night starts the project's own setup check as the system owner (`startProjectSetupCheck`);
// when that check later fails at a setup command, `adoptNightlyBreak` takes it over as the first attempt of a re-check, and the re-check's own machinery (one retry for a machine fault, then "broken", the project's one card,
// the admins' notice through the one marker) does the rest. The hourly pass settles every project whose upkeep is ON. Mutants are listed in the PR body with the test that kills each.
import { describe, expect, it, vi } from "vitest";
import { IMPLICIT_COMPANY_ID, WORKER_INVOCATION_FEATURES, projectMetaKey, queryAll, systemOwnerIdOf, type DocumentStore, type OrgId, type ProjectDefinition } from "@agentx/contracts";
import { buildSetupCheck, relayCheck, setupCheckRecordKey, startProjectSetupCheck } from "../../packages/broker/src/core/setup-agent/check.js";
import { RECHECK_RETRY_DELAY_MS, adoptNightlyBreak, advanceCurrentRecheck, readSetupRepairCard, recheckRowKey, type RecheckRow } from "../../packages/broker/src/core/setup-agent/recheck.js";
import { setupPartition } from "../../packages/broker/src/core/setup-agent/keys.js";
import { takeSetupSnapshot, snapshotItem } from "../../packages/broker/src/core/setup-agent/snapshot.js";
import { readWorkspace } from "../../packages/broker/src/core/task-flow/stage-machine.js";
import { inboxPartition, queueSetupBroken } from "../../packages/broker/src/core/notify/index.js";
import { runUpkeepNightPass, type UpkeepPassDeps } from "../../packages/broker/src/core/system-runs/night-pass.js";
import { setUpkeepEnabled } from "../../packages/broker/src/core/upkeep/settings.js";
import { systemRunsConsentKey } from "../../packages/broker/src/core/system-runs/consent.js";
import { FakeCodeHost } from "../../packages/broker/src/plugins/fake/code-host.js";
import { FakeHostModel } from "../../packages/broker/src/plugins/fake/model.js";
import { createAdapterRegistry } from "../../packages/broker/src/ports/adapter-registry.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { MemoryQueueService } from "../../packages/broker/src/ports/memory-queue.js";
import { TASK_FLOW_INDEXES } from "../../packages/broker/src/core/task-flow/flow.js";
import { createHarness, definition, newRequestId, type Harness } from "../support/task-flow-harness.js";

const URL_ = "https://examplehost.test/acme/app";
const COMPANY_B: OrgId = "org_bbbbbbbbbbbbbbbbbbbb";
const ADMIN = "ab".repeat(32);
const SETUP_FAILS = "setup step 0 (npm ci) failed: exit 1";
const TESTS_FAIL = "readiness check 0 (npm test) failed: exit 1";
const CLONE_FAILS = "clone failed: repository not found";
const FILES: Record<string, string> = { "README.md": "readme", "package.json": "{}", "package-lock.json": "lock-1" };

const projectOf = (name = "payments"): ProjectDefinition => ({
  ...definition, name, setup: [{ cwd: "repo/demo", executable: "npm", args: ["ci"], timeoutSeconds: 60 }], readiness: [{ cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 60 }],
  repositories: [{ ...definition.repositories[0]!, url: URL_, host: { kind: "fake" } }],
});

interface World { h: Harness; model: FakeHostModel; project: ProjectDefinition; told: Array<{ project: string; recheckKey: string }> }

async function world(options: { companyId?: OrgId; backend?: Parameters<typeof createHarness>[0] extends infer O ? (O extends { backend?: infer B } ? B : never) : never } = {}): Promise<World> {
  const h = createHarness({ understandFirst: false, machines: { startingChecks: 0, features: [...WORKER_INVOCATION_FEATURES] }, ...(options.companyId === undefined ? {} : { companyId: options.companyId }), ...(options.backend === undefined ? {} : { backend: options.backend }) });
  const project = projectOf();
  await h.registerProject(project);
  await h.store.put({ item: { ...projectMetaKey(h.deps.companyId, project.name), entityType: "PROJECT_META" } });
  const model = new FakeHostModel({ url: URL_, id: "1", fullName: "acme/app", initialFiles: FILES });
  const registry = createAdapterRegistry();
  registry.register("code-host", "fake", new FakeCodeHost(model));
  h.deps.codeHosts = registry;
  const snapshot = await takeSetupSnapshot({ companyId: h.deps.companyId, codeHosts: h.deps.codeHosts }, { definition: project, setupRevision: project.revision, at: "2026-11-09T10:00:00.000Z" });
  await h.store.transact([snapshotItem(h.deps.companyId, project.name, snapshot!)]);
  const told: World["told"] = [];
  // The host's writer: the real one (the once-marker, the pending row and the inbox row), recording each call.
  h.deps.setupBroken = async (input) => {
    told.push(input);
    await queueSetupBroken({ store: h.store, now: () => new Date(h.clock.now), recipients: async () => [ADMIN] }, { orgId: h.deps.companyId, ...input });
  };
  return { h, model, project, told };
}

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

/** The check the project's NIGHT starts (as the system owner, in the system's own request namespace), finished with `outcome`. */
async function nightCheck(w: World, outcome: Parameters<typeof finishCheck>[2], project = w.project.name): Promise<string> {
  const started = await startProjectSetupCheck(w.h.deps, { project, requestId: newRequestId(), startedBy: systemOwnerIdOf(w.h.deps.companyId, project), system: true });
  await finishCheck(w.h, started.workspaceId, outcome);
  return started.workspaceId;
}
const rechecksOf = async (store: DocumentStore, orgId: OrgId, project = "payments"): Promise<RecheckRow[]> =>
  (await queryAll(store, { pk: setupPartition(orgId, project), sk: { op: "beginsWith", prefix: "RECHECK#" } })).map((item) => item as unknown as RecheckRow);
const inboxRows = async (store: DocumentStore, orgId: OrgId): Promise<number> => (await store.query({ pk: inboxPartition(orgId, ADMIN) })).items.length;
const pendingRows = async (store: DocumentStore): Promise<number> => (await store.query({ pk: "NOTIFY_PENDING" })).items.length;

describe("a night's broken setup check tells the admins, once", () => {
  it("a check the night started that failed at a setup command is adopted, retried once, and then tells the admins exactly once", async () => {
    const w = await world();
    await nightCheck(w, { status: "FAILED", error: SETUP_FAILS });
    expect(w.told).toEqual([]);
    expect(await adoptNightlyBreak(w.h.deps, "payments")).toBe("adopted");
    const [row] = await rechecksOf(w.h.store, w.h.deps.companyId);
    // The first failure is seen; the retry waits out its delay. Nobody is told yet.
    expect(row).toMatchObject({ state: "running", attempt: 1, classes: [], project: "payments", orgId: w.h.deps.companyId });
    expect(row!.failedSeenAt).toBeDefined();
    expect(w.told).toEqual([]);
    w.h.clock.advance(RECHECK_RETRY_DELAY_MS / 1000 + 1);
    await advanceCurrentRecheck(w.h.deps, "payments");
    const retry = (await rechecksOf(w.h.store, w.h.deps.companyId))[0]!;
    expect(retry.attempt).toBe(2);
    expect(retry.check.workspaceId).not.toBe(row!.check.workspaceId);
    await finishCheck(w.h, retry.check.workspaceId, { status: "FAILED", error: SETUP_FAILS });
    const settled = await advanceCurrentRecheck(w.h.deps, "payments");
    expect(settled?.state).toBe("broken");
    // The notice: the same call the task-start re-check makes, with this re-check's key, and one marker, one pending row and one inbox row however often it is read.
    expect(w.told[0]).toEqual({ project: "payments", recheckKey: row!.key });
    await advanceCurrentRecheck(w.h.deps, "payments");
    await adoptNightlyBreak(w.h.deps, "payments");
    expect(new Set(w.told.map((entry) => entry.recheckKey))).toEqual(new Set([row!.key]));
    expect(await pendingRows(w.h.store)).toBe(1);
    expect(await inboxRows(w.h.store, w.h.deps.companyId)).toBe(1);
    expect(await rechecksOf(w.h.store, w.h.deps.companyId)).toHaveLength(1);
    // And the project's one repair card exists now (what the admins' notice and the inbox read at delivery).
    expect(await readSetupRepairCard(w.h.deps, "payments")).toMatchObject({ key: row!.key, failedStep: expect.stringContaining("npm ci") as unknown });
  });

  it("the retry passing ends it silently: nobody is told, and the project is not marked broken", async () => {
    const w = await world();
    await nightCheck(w, { status: "FAILED", error: SETUP_FAILS });
    await adoptNightlyBreak(w.h.deps, "payments");
    w.h.clock.advance(RECHECK_RETRY_DELAY_MS / 1000 + 1);
    await advanceCurrentRecheck(w.h.deps, "payments");
    const retry = (await rechecksOf(w.h.store, w.h.deps.companyId))[0]!;
    await finishCheck(w.h, retry.check.workspaceId, { status: "SUCCEEDED" });
    expect((await advanceCurrentRecheck(w.h.deps, "payments"))?.state).toBe("passed");
    expect(w.told).toEqual([]);
    expect(await pendingRows(w.h.store)).toBe(0);
    expect(await readSetupRepairCard(w.h.deps, "payments")).toBeUndefined();
  });

  it("two passes (or two workers) adopting the same failed check make one re-check", async () => {
    const w = await world();
    await nightCheck(w, { status: "FAILED", error: SETUP_FAILS });
    const answers = await Promise.all([adoptNightlyBreak(w.h.deps, "payments"), adoptNightlyBreak(w.h.deps, "payments")]);
    expect(answers.filter((answer) => answer === "adopted").length).toBeGreaterThanOrEqual(1);
    expect(await rechecksOf(w.h.store, w.h.deps.companyId)).toHaveLength(1);
    expect(await adoptNightlyBreak(w.h.deps, "payments")).toBe("none");
  });

  it.each([
    ["a test command that fails (the setup commands passed)", TESTS_FAIL],
    ["a clone that fails (nothing says the setup commands fail)", CLONE_FAILS],
  ])("%s is not a broken setup: nothing is adopted and nobody is told", async (_label, error) => {
    const w = await world();
    await nightCheck(w, { status: "FAILED", error });
    expect(await adoptNightlyBreak(w.h.deps, "payments")).toBe("none");
    expect(await rechecksOf(w.h.store, w.h.deps.companyId)).toEqual([]);
    expect(w.told).toEqual([]);
  });

  it("a check that passed, or is still running, is not adopted", async () => {
    const w = await world();
    await nightCheck(w, { status: "SUCCEEDED" });
    expect(await adoptNightlyBreak(w.h.deps, "payments")).toBe("none");
    const running = await startProjectSetupCheck(w.h.deps, { project: "payments", requestId: newRequestId(), startedBy: systemOwnerIdOf(w.h.deps.companyId, "payments"), system: true });
    expect(running.workspaceId).toBeDefined();
    expect(await adoptNightlyBreak(w.h.deps, "payments")).toBe("none");
    expect(await rechecksOf(w.h.store, w.h.deps.companyId)).toEqual([]);
  });

  it("a check record that names another project is not this project's: nothing is adopted", async () => {
    const w = await world();
    const workspaceId = await nightCheck(w, { status: "FAILED", error: SETUP_FAILS });
    await w.h.store.update({ key: setupCheckRecordKey(w.h.deps.companyId, workspaceId), ops: [{ op: "set", path: ["project"], value: "other" }] });
    expect(await adoptNightlyBreak(w.h.deps, "payments")).toBe("none");
    expect(await rechecksOf(w.h.store, w.h.deps.companyId)).toEqual([]);
  });

  it("a check a PERSON started is the person's to read on the setup page: it is never adopted", async () => {
    const w = await world();
    const started = await startProjectSetupCheck(w.h.deps, { project: "payments", requestId: newRequestId(), startedBy: "local-owner" });
    await finishCheck(w.h, started.workspaceId, { status: "FAILED", error: SETUP_FAILS });
    expect(await adoptNightlyBreak(w.h.deps, "payments")).toBe("none");
    expect(await rechecksOf(w.h.store, w.h.deps.companyId)).toEqual([]);
    expect(w.told).toEqual([]);
  });

  it("a re-check's own candidate check (marked on the project when it breaks) is never adopted again (no loop of retries)", async () => {
    const w = await world();
    const check = buildSetupCheck(w.h.deps, { project: "payments", revision: 1, startedBy: systemOwnerIdOf(w.h.deps.companyId, "payments"), requestId: newRequestId(), candidate: true });
    expect((await w.h.store.transact([...check.items, { kind: "update", key: projectMetaKey(w.h.deps.companyId, "payments"), ops: [{ op: "set", path: ["setupCheck"], value: { ...check.mark } as never }] }])).applied).toBe(true);
    await relayCheck(w.h.deps, check);
    await finishCheck(w.h, check.workspaceId, { status: "FAILED", error: SETUP_FAILS });
    expect(await adoptNightlyBreak(w.h.deps, "payments")).toBe("none");
    expect(await rechecksOf(w.h.store, w.h.deps.companyId)).toEqual([]);
  });

  it("a check of an older revision, a project with a re-check already running, and an install with no code host adopt nothing", async () => {
    const w = await world();
    await nightCheck(w, { status: "FAILED", error: SETUP_FAILS });
    // A newer revision was approved since: the failed check is outdated, not the current setup's.
    await w.h.registerProject({ ...w.project, revision: 2 });
    expect(await adoptNightlyBreak(w.h.deps, "payments")).toBe("none");
    const bare = await world();
    await nightCheck(bare, { status: "FAILED", error: SETUP_FAILS });
    delete bare.h.deps.codeHosts;
    expect(await adoptNightlyBreak(bare.h.deps, "payments")).toBe("none");
    // A re-check already running for this revision is the one in flight: this failed check waits for the next pass.
    const busy = await world();
    busy.model.commit("main", { "package-lock.json": "lock-2" });
    await busy.h.flow.start(busy.h.owner, { requestId: newRequestId(), project: "payments", instructions: "Change a thing", workflow: true, workflowPath: "QUICK" });
    expect((await rechecksOf(busy.h.store, busy.h.deps.companyId)).map((row) => row.state)).toEqual(["running"]);
    await nightCheck(busy, { status: "FAILED", error: SETUP_FAILS }).catch(() => undefined);
    expect(await adoptNightlyBreak(busy.h.deps, "payments")).toBe("none");
  });

  it("never throws: a store fault is logged in fixed words and answers none", async () => {
    const w = await world();
    await nightCheck(w, { status: "FAILED", error: SETUP_FAILS });
    const logs: Array<Record<string, unknown>> = [];
    w.h.deps.log = (entry) => logs.push(entry);
    vi.spyOn(w.h.store, "transact").mockRejectedValueOnce(new Error("store down"));
    expect(await adoptNightlyBreak(w.h.deps, "payments")).toBe("none");
    expect(logs.some((entry) => entry["event"] === "setup_drift.nightly_adopt_failed" && entry["error"] === "Error")).toBe(true);
    // The next pass finds it again and adopts it.
    expect(await adoptNightlyBreak(w.h.deps, "payments")).toBe("adopted");
  });

  it("two companies: company A's failed night adopts, tells and writes nothing under company B (same project name, same store)", async () => {
    const shared = new MemoryDocumentStore({ indexes: TASK_FLOW_INDEXES, nowSeconds: () => Math.floor(Date.parse("2026-11-09T10:00:00.000Z") / 1_000) });
    const backend = () => ({ store: shared as DocumentStore, queues: new MemoryQueueService({ now: () => Date.parse("2026-11-09T10:00:00.000Z") }) });
    const a = await world({ backend });
    const b = await world({ backend, companyId: COMPANY_B });
    expect(a.h.deps.companyId).toBe(IMPLICIT_COMPANY_ID);
    await nightCheck(a, { status: "FAILED", error: SETUP_FAILS });
    expect(await adoptNightlyBreak(b.h.deps, "payments")).toBe("none");
    expect(await adoptNightlyBreak(a.h.deps, "payments")).toBe("adopted");
    expect(await rechecksOf(shared, COMPANY_B)).toEqual([]);
    expect(await rechecksOf(shared, a.h.deps.companyId)).toHaveLength(1);
    expect(await shared.get(recheckRowKey(COMPANY_B, "payments", (await rechecksOf(shared, a.h.deps.companyId))[0]!.key))).toBeUndefined();
    expect(b.told).toEqual([]);
    expect(await readSetupRepairCard(b.h.deps, "payments")).toBeUndefined();
  });
});

describe("the hourly pass settles what a night found", () => {
  const A = IMPLICIT_COMPANY_ID as OrgId;
  const at = Date.parse("2026-11-18T08:30:00.000Z");
  async function passWorld(names: string[], enabled: string[]) {
    const store = new MemoryDocumentStore();
    await store.put({ item: { ...systemRunsConsentKey(A), entityType: "SYSTEM_RUNS_CONSENT", orgId: A, enabled: true, changedAt: "2026-11-17T00:00:00.000Z" } });
    for (const name of enabled) await setUpkeepEnabled({ store, companyId: A, now: () => at, standing: async () => ({ access: "manage" }) }, { personId: ADMIN, project: name, requestId: crypto.randomUUID(), on: true, fromPage: true });
    const settled: string[] = [];
    const base: Omit<UpkeepPassDeps, "settle"> = {
      store, companyId: A, now: () => at, enabled: () => true, projects: async () => names,
      night: async () => ({ outcome: "nothing_changed", setupCheck: "skipped", mockChecks: "skipped", wiki: "skipped" }),
    };
    return { store, settled, base };
  }

  it("settle runs for every project whose upkeep is ON (whether or not it is that project's own hour), and for none whose upkeep is off", async () => {
    const { settled, base } = await passWorld(["alpha", "beta", "gamma"], ["alpha", "gamma"]);
    await runUpkeepNightPass({ ...base, settle: async (project) => { settled.push(project); } }, { budgetMs: 60_000 });
    expect(settled.sort()).toEqual(["alpha", "gamma"]);
  });

  it("a settle that throws is logged and the pass goes on to the next project", async () => {
    const { settled, base } = await passWorld(["alpha", "beta"], ["alpha", "beta"]);
    const logs: Array<Record<string, unknown>> = [];
    await runUpkeepNightPass({ ...base, log: (entry) => logs.push(entry), settle: async (project) => { settled.push(project); if (project === "alpha") throw new Error("boom"); } }, { budgetMs: 60_000 });
    expect(settled.sort()).toEqual(["alpha", "beta"]);
    expect(logs).toContainEqual({ event: "upkeep_pass.settle_failed", error: "Error" });
  });

  it("with the company's system runs off the pass reads nothing and settles nothing", async () => {
    const { settled, base } = await passWorld(["alpha"], ["alpha"]);
    const report = await runUpkeepNightPass({ ...base, enabled: () => false, settle: async (project) => { settled.push(project); } }, { budgetMs: 60_000 });
    expect(report.skipped).toBe("system_runs_off");
    expect(settled).toEqual([]);
  });

  it("a pass without a settle behaves as before", async () => {
    const { base } = await passWorld(["alpha"], ["alpha"]);
    await expect(runUpkeepNightPass(base, { budgetMs: 60_000 })).resolves.toMatchObject({ due: expect.any(Number) as unknown });
  });
});
