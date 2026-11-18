// L4-P1 (owner DEC 254zzl): Rovara's own free re-check at task start is a SYSTEM start, so on an install that has the per-company SystemRuns flag it stands behind it: with the flag off nothing is read,
// claimed or started for it (the task starts as it always did); on, it starts as before; on a laptop (no flag at all) nothing changed. Also: the purpose of a task start reaches the access rule.
import { describe, expect, it, vi } from "vitest";
import { WORKER_INVOCATION_FEATURES, projectMetaKey, queryAll, type DocumentStore, type OrgId, type ProjectDefinition } from "@agentx/contracts";
import { readSystemRunUsage } from "../../packages/broker/src/core/system-runs/usage.js";
import { readAutomaticRunsUse } from "../../packages/broker/src/core/automatic-runs/cap.js";
import { type RecheckRow } from "../../packages/broker/src/core/setup-agent/recheck.js";
import { snapshotItem, takeSetupSnapshot } from "../../packages/broker/src/core/setup-agent/snapshot.js";
import { setupPartition } from "../../packages/broker/src/core/setup-agent/keys.js";
import { createAdapterRegistry } from "../../packages/broker/src/ports/adapter-registry.js";
import { FakeCodeHost } from "../../packages/broker/src/plugins/fake/code-host.js";
import { FakeHostModel } from "../../packages/broker/src/plugins/fake/model.js";
import { createHarness, definition, newRequestId, type Harness } from "../support/task-flow-harness.js";

const URL_ = "https://examplehost.test/acme/app";
const FILES: Record<string, string> = {
  "README.md": "readme", "src/index.ts": "export {}", "package.json": "{}", "package-lock.json": "lock-1", "docker-compose.yml": "services: {}", "services/api/Dockerfile": "FROM node:22",
  ".devcontainer/devcontainer.json": "{}", ".env.example": "A=", ".nvmrc": "22", "vitest.config.ts": "export default {}", ".github/workflows/ci.yml": "on: push",
};
const projectOf = (name = "payments", extra: Partial<ProjectDefinition> = {}): ProjectDefinition => ({
  ...definition, name, setup: [{ cwd: "repo/demo", executable: "npm", args: ["ci"], timeoutSeconds: 60 }], readiness: [{ cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 60 }], ...extra,
  repositories: [{ ...definition.repositories[0]!, url: URL_, host: { kind: "fake" } }],
});

interface World { h: Harness; model: FakeHostModel; host: FakeCodeHost; project: ProjectDefinition; modelRoute: ReturnType<typeof vi.fn> }

async function world(options: { companyId?: OrgId } = {}): Promise<World> {
  const modelRoute = vi.fn(async () => undefined);
  const h = createHarness({
    understandFirst: false, audit: "recording", machines: { startingChecks: 0, features: [...WORKER_INVOCATION_FEATURES] },
    ...(options.companyId === undefined ? {} : { companyId: options.companyId }),
  });
  const project = projectOf();
  await h.registerProject(project);
  // The project's own record (a registered project has one; the setup state's mark lives on it).
  await h.store.put({ item: { ...projectMetaKey(h.deps.companyId, project.name), entityType: "PROJECT_META" } });
  const model = new FakeHostModel({ url: URL_, id: "1", fullName: "acme/app", initialFiles: FILES });
  const host = new FakeCodeHost(model);
  const registry = createAdapterRegistry();
  registry.register("code-host", "fake", host);
  h.deps.codeHosts = registry;
  // The model route is the one door a model call goes through for a step: it must never be asked for a re-check.
  h.deps.modelAccess = { route: modelRoute };
  const built: World = { h, model, host, project, modelRoute };
  await saveSnapshot(built);
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

const used = async (w: World): Promise<number> => (await readAutomaticRunsUse({ store: w.h.store, now: () => w.h.clock.now }, w.h.deps.companyId, "payments")).used;

describe("the free re-check at task start stands behind the SystemRuns flag", () => {
  it("flag OFF: the task starts, and nothing is claimed or started for a re-check, even with drift", async () => {
    const w = await world();
    w.h.deps.systemRuns = { enabled: () => false };
    w.model.commit("main", { "package-lock.json": "lock-2" });
    const task = await startTask(w);
    expect(task.taskId).toBeDefined();
    expect(await rechecksOf(w.h.store, w.h.deps.companyId, "payments")).toEqual([]);
    expect(await used(w)).toBe(0);
  });

  it("flag ON: the same drift starts one re-check, as before", async () => {
    const w = await world();
    w.h.deps.systemRuns = { enabled: () => true };
    w.model.commit("main", { "package-lock.json": "lock-2" });
    await startTask(w);
    expect(await rechecksOf(w.h.store, w.h.deps.companyId, "payments")).toHaveLength(1);
    expect(await used(w)).toBe(1);
  });

  it("no flag at all (a laptop): nothing changed, the drift starts the re-check", async () => {
    const w = await world();
    expect(w.h.deps.systemRuns).toBeUndefined();
    w.model.commit("main", { "package-lock.json": "lock-2" });
    await startTask(w);
    expect(await rechecksOf(w.h.store, w.h.deps.companyId, "payments")).toHaveLength(1);
  });

  it("is read on every start: turned off between two tasks, the second starts no re-check", async () => {
    const w = await world();
    const gate = { on: true };
    w.h.deps.systemRuns = { enabled: () => gate.on };
    w.model.commit("main", { "package-lock.json": "lock-2" });
    await startTask(w);
    gate.on = false;
    w.model.commit("main", { "package-lock.json": "lock-3" });
    await startTask(w);
    expect(await rechecksOf(w.h.store, w.h.deps.companyId, "payments")).toHaveLength(1);
  });
});

describe("the re-check at task start is attributed to the company (REVIEW-1 M1)", () => {
  it("flag ON: a re-check writes a usage row for kind setup_check and audits with its kind and reason", async () => {
    const w = await world();
    w.h.deps.systemRuns = { enabled: () => true };
    w.model.commit("main", { "package-lock.json": "lock-2" });
    await startTask(w);
    const report = await readSystemRunUsage(w.h.deps, { project: "payments" });
    expect(report).toMatchObject({ runs: 1, byKind: { setup_check: { runs: 1 } } });
    const event = w.h.audit.find((entry) => entry.action === "setup_recheck.started")!;
    expect(event.actor).toEqual({ type: "system", id: "rovara" });
    expect(event.details).toMatchObject({ kind: "setup_check", reason: "task_start", attempt: 1 });
  });

  it("flag OFF: no usage row and no event, because no re-check exists", async () => {
    const w = await world();
    w.h.deps.systemRuns = { enabled: () => false };
    w.model.commit("main", { "package-lock.json": "lock-2" });
    await startTask(w);
    expect((await readSystemRunUsage(w.h.deps, { project: "payments" })).runs).toBe(0);
    expect(w.h.audit.filter((event) => event.action === "setup_recheck.started")).toHaveLength(0);
  });
});

describe("a task start tells the access rule what it is for", () => {
  it("an ordinary task has no purpose (a system owner is never accepted for it)", async () => {
    const w = await world();
    const seen: Array<string | undefined> = [];
    const original = w.h.deps.access.checkStart.bind(w.h.deps.access);
    w.h.deps.access.checkStart = async (principal, project, purpose) => { seen.push(purpose); return original(principal, project, purpose); };
    await startTask(w);
    expect(seen).toEqual([undefined]);
  });
});
