// REVIEW (Opus, DEC 254zzz447): a NIGHT setup check (system owner, not a person) that failed refuses new starts until its adopted re-check settles broken. Reproduction of the review finding.
// when that check later fails at a setup command, `adoptNightlyBreak` takes it over as the first attempt of a re-check, and the re-check's own machinery (one retry for a machine fault, then "broken", the project's one card,
// the admins' notice through the one marker) does the rest. The hourly pass settles every project whose upkeep is ON. Mutants are listed in the PR body with the test that kills each.
import { describe, expect, it } from "vitest";
import { WORKER_INVOCATION_FEATURES, projectMetaKey, queryAll, systemOwnerIdOf, type DocumentStore, type OrgId, type ProjectDefinition } from "@agentx/contracts";
import { startProjectSetupCheck } from "../../packages/broker/src/core/setup-agent/check.js";
import { RECHECK_RETRY_DELAY_MS, adoptNightlyBreak, advanceCurrentRecheck, readSetupRepairCard, type RecheckRow } from "../../packages/broker/src/core/setup-agent/recheck.js";
import { setupPartition } from "../../packages/broker/src/core/setup-agent/keys.js";
import { takeSetupSnapshot, snapshotItem } from "../../packages/broker/src/core/setup-agent/snapshot.js";
import { readWorkspace } from "../../packages/broker/src/core/task-flow/stage-machine.js";
import { queueSetupBroken } from "../../packages/broker/src/core/notify/index.js";
import { FakeCodeHost } from "../../packages/broker/src/plugins/fake/code-host.js";
import { FakeHostModel } from "../../packages/broker/src/plugins/fake/model.js";
import { createAdapterRegistry } from "../../packages/broker/src/ports/adapter-registry.js";
import { createHarness, definition, newRequestId, type Harness } from "../support/task-flow-harness.js";

const URL_ = "https://examplehost.test/acme/app";
const ADMIN = "ab".repeat(32);
const SETUP_FAILS = "setup step 0 (npm ci) failed: exit 1";
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


describe("REVIEW: a night check's failure must not refuse a start (DEC 254zzz447)", () => {
  const startRequest = (w: World) => w.h.flow.start(w.h.owner, { requestId: newRequestId(), project: "payments", instructions: "Change a thing", workflow: true, workflowPath: "QUICK" });
  it("after the night's failed check is adopted (first failure seen, retry pending), a new task still starts", async () => {
    const w = await world();
    await nightCheck(w, { status: "FAILED", error: SETUP_FAILS });
    expect(await adoptNightlyBreak(w.h.deps, "payments")).toBe("adopted");
    expect(await readSetupRepairCard(w.h.deps, "payments")).toBeUndefined();
    await expect(startRequest(w)).resolves.toBeDefined();
  });
  it("while the adopted re-check's retry is running, a new task still starts", async () => {
    const w = await world();
    await nightCheck(w, { status: "FAILED", error: SETUP_FAILS });
    await adoptNightlyBreak(w.h.deps, "payments");
    w.h.clock.advance(RECHECK_RETRY_DELAY_MS / 1000 + 1);
    await advanceCurrentRecheck(w.h.deps, "payments");
    expect((await rechecksOf(w.h.store, w.h.deps.companyId))[0]!.attempt).toBe(2);
    await expect(startRequest(w)).resolves.toBeDefined();
  });
  it("once the adopted re-check is broken (card open), a new task starts (passes today)", async () => {
    const w = await world();
    await nightCheck(w, { status: "FAILED", error: SETUP_FAILS });
    await adoptNightlyBreak(w.h.deps, "payments");
    w.h.clock.advance(RECHECK_RETRY_DELAY_MS / 1000 + 1);
    await advanceCurrentRecheck(w.h.deps, "payments");
    const retry = (await rechecksOf(w.h.store, w.h.deps.companyId))[0]!;
    await finishCheck(w.h, retry.check.workspaceId, { status: "FAILED", error: SETUP_FAILS });
    expect((await advanceCurrentRecheck(w.h.deps, "payments"))?.state).toBe("broken");
    await expect(startRequest(w)).resolves.toBeDefined();
  });
});

describe("REVIEW: starts are no longer refused while broken, so every new commit starts another re-check and another admins' notice", () => {
  const startRequest = (w: World) => w.h.flow.start(w.h.owner, { requestId: newRequestId(), project: "payments", instructions: "Change a thing", workflow: true, workflowPath: "QUICK" });
  async function failBoth(w: World): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const current = (await rechecksOf(w.h.store, w.h.deps.companyId)).find((row) => row.state === "running")!;
      await finishCheck(w.h, current.check.workspaceId, { status: "FAILED", error: SETUP_FAILS });
      await advanceCurrentRecheck(w.h.deps, "payments");
      w.h.clock.advance(RECHECK_RETRY_DELAY_MS / 1000 + 1);
      await advanceCurrentRecheck(w.h.deps, "payments");
    }
  }
  it("a project whose setup is already broken (card open) starts no NEW re-check for a task on a newer commit, and the admins are told once", async () => {
    const w = await world();
    w.model.commit("main", { "package-lock.json": "lock-2" });
    await startRequest(w);
    await failBoth(w);
    expect(await readSetupRepairCard(w.h.deps, "payments")).toBeDefined();
    expect(new Set(w.told.map((entry) => entry.recheckKey)).size).toBe(1);
    w.model.commit("main", { "package-lock.json": "lock-3" });
    await startRequest(w);
    expect((await rechecksOf(w.h.store, w.h.deps.companyId)).filter((row) => row.state === "running")).toHaveLength(0);
  });
  it("(shows the cost today) the second commit's re-check also breaks and tells the admins a SECOND time", async () => {
    const w = await world();
    w.model.commit("main", { "package-lock.json": "lock-2" });
    await startRequest(w);
    await failBoth(w);
    w.model.commit("main", { "package-lock.json": "lock-3" });
    await startRequest(w);
    if ((await rechecksOf(w.h.store, w.h.deps.companyId)).some((row) => row.state === "running")) await failBoth(w);
    expect(new Set(w.told.map((entry) => entry.recheckKey)).size).toBe(1);
  });
});
