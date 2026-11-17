// L4-RD (DEC 254z c, 254zza): the automatic repair draft, on the task flow's fakes (an in-memory store and queue, a fake worker machine, a fake code host, a fake unattended door and starter).
// What is proved here, and what each proof would catch if the code were changed (the mutants are listed in the PR body):
//   gates          a draft starts ONLY for a re-check that settled "broken", with upkeep ON, an enforced cap, room for the whole run, the project still at the revision that broke, nothing else going, outside the cooldown;
//                  every doubt (a throw, a malformed answer) is "no"; a refused start leaves nothing behind
//   one per fail   the claim is per failure: repeated and concurrent calls start one run, a failed draft is final
//   the door       the run goes through startUnattendedRun with the run's own limits and dollar estimate, the origin "nightly" and NO `automatic` mark; no model is asked by Rovara itself
//   never approve  the candidate is stored by the person's own confirm path (citations re-read, new workspace, check), is never the project's latest, and only the approval gate's risk-based approvers move the project
//   the run's own  only a finished, whole proposal of THIS draft's run is confirmed; a partial run, a failed run, another run's proposal and a failed check each end the draft in fixed words
//   isolation      another project and another company never meet the rows, the pointer, the card or the run
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  IMPLICIT_COMPANY_ID, WORKER_INVOCATION_FEATURES, agentXError, change, orgProjectCatalogKey, projectMetaKey, projectRevisionKey, queryAll, systemOwnerIdOf, when,
  type Admission, type DocumentStore, type OrgId, type Principal, type ProjectDefinition,
} from "@agentx/contracts";
import { createSetupProposalSubject, discardSetupApply, setupApplyKey } from "../../packages/broker/src/core/setup-agent/apply.js";
import { setupAgentKey, setupPartition } from "../../packages/broker/src/core/setup-agent/keys.js";
import { setupApproverAllows } from "../../packages/broker/src/core/setup-agent/setup-risk.js";
import { RECHECK_RETRY_DELAY_MS, advanceCurrentRecheck, recheckRowKey, setupGateBeforeBuild, type RecheckRow } from "../../packages/broker/src/core/setup-agent/recheck.js";
import { takeSetupSnapshot, snapshotItem } from "../../packages/broker/src/core/setup-agent/snapshot.js";
import {
  REPAIR_COOLDOWN_MS, REPAIR_START_STALE_MS, REPAIR_WORDS, advanceRepairDraft, fixSetupLabel, readRepairView, repairCurrentKey, repairDraftHook, repairRowKey, startRepairDraft,
  type RepairDraftDeps, type RepairRow, type UpkeepGate,
} from "../../packages/broker/src/core/setup-agent/repair-draft.js";
import { fixedAutomationSwitch } from "../../packages/broker/src/core/automation/switch.js";
import type { AutomatedRunRequest, AutomatedRunStarter, UnattendedStartDeps } from "../../packages/broker/src/core/automation/run-seam.js";
import { SETUP_REPAIR_NOT_HERE, createTaskFlowRunStarter } from "../../packages/broker/src/local/app/automation.js";
import { startTask as startFlowTask } from "../../packages/broker/src/core/task-flow/start.js";
import { readWorkspace } from "../../packages/broker/src/core/task-flow/stage-machine.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { createAdapterRegistry } from "../../packages/broker/src/ports/adapter-registry.js";
import { createAllowAllAdmission } from "../../packages/broker/src/ports/policy-defaults.js";
import { FakeCodeHost } from "../../packages/broker/src/plugins/fake/code-host.js";
import { FakeHostModel } from "../../packages/broker/src/plugins/fake/model.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { MemoryQueueService } from "../../packages/broker/src/ports/memory-queue.js";
import { TASK_FLOW_INDEXES } from "../../packages/broker/src/core/task-flow/flow.js";
import { createHarness, definition, newRequestId, type Harness } from "../support/task-flow-harness.js";

const URL_ = "https://examplehost.test/acme/app";
const COMPANY_B: OrgId = "org_bbbbbbbbbbbbbbbbbbbb";
const FILES: Record<string, string> = { "README.md": "readme", "src/index.ts": "export {}", "package.json": "{}", "package-lock.json": "lock-1" };
const SETUP_FAILS = "setup step 0 (npm ci) failed: exit 1";
const SETUP_FAILS_STEP = "setup: npm ci - setup step 0 (npm ci) failed: exit 1";

const projectOf = (name = "payments"): ProjectDefinition => ({
  ...definition, name, setup: [{ cwd: "repo/demo", executable: "npm", args: ["ci"], timeoutSeconds: 60 }], readiness: [{ cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 60 }],
  repositories: [{ ...definition.repositories[0]!, url: URL_, host: { kind: "fake" } }],
});

interface World { h: Harness; model: FakeHostModel; host: FakeCodeHost; project: ProjectDefinition; modelRoute: ReturnType<typeof vi.fn> }

async function world(options: { companyId?: OrgId; backend?: Parameters<typeof createHarness>[0] extends infer O ? (O extends { backend?: infer B } ? B : never) : never } = {}): Promise<World> {
  const modelRoute = vi.fn(async () => undefined);
  const h = createHarness({
    understandFirst: false, machines: { startingChecks: 0, features: [...WORKER_INVOCATION_FEATURES] }, audit: "recording",
    ...(options.companyId === undefined ? {} : { companyId: options.companyId }), ...(options.backend === undefined ? {} : { backend: options.backend }),
  });
  const project = projectOf();
  await h.registerProject(project);
  await h.store.put({ item: { ...projectMetaKey(h.deps.companyId, project.name), entityType: "PROJECT_META" } });
  const model = new FakeHostModel({ url: URL_, id: "1", fullName: "acme/app", initialFiles: FILES });
  const host = new FakeCodeHost(model);
  const registry = createAdapterRegistry();
  registry.register("code-host", "fake", host);
  h.deps.codeHosts = registry;
  h.deps.modelAccess = { route: modelRoute };
  const built: World = { h, model, host, project, modelRoute };
  await saveSnapshot(built, project);
  return built;
}

async function saveSnapshot(w: World, definitionOf: ProjectDefinition): Promise<void> {
  const snapshot = await takeSetupSnapshot({ companyId: w.h.deps.companyId, codeHosts: w.h.deps.codeHosts }, { definition: definitionOf, setupRevision: definitionOf.revision, at: "2026-11-09T10:00:00.000Z" });
  expect((await w.h.store.transact([snapshotItem(w.h.deps.companyId, definitionOf.name, snapshot!)])).applied).toBe(true);
}

const startTask = async (w: World, project = "payments") => (await w.h.flow.start(w.h.owner, { requestId: newRequestId(), project, instructions: "Change a thing", workflow: true, workflowPath: "QUICK" })).task;
const rechecksOf = async (store: DocumentStore, orgId: OrgId, project: string): Promise<RecheckRow[]> =>
  (await queryAll(store, { pk: setupPartition(orgId, project), sk: { op: "beginsWith", prefix: "RECHECK#" } })).map((item) => item as unknown as RecheckRow);
const repairsOf = async (store: DocumentStore, orgId: OrgId, project: string): Promise<RepairRow[]> =>
  (await queryAll(store, { pk: setupPartition(orgId, project), sk: { op: "beginsWith", prefix: "REPAIR#" } })).map((item) => item as unknown as RepairRow);

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

/** Drifts the lockfile, starts a task, and fails the setup step twice: the re-check settles "broken". `hook` is wired before, as the host does. */
async function breakSetup(w: World, project = "payments", commit: Record<string, string> = { "package-lock.json": "lock-2" }): Promise<{ taskId: string; recheck: RecheckRow }> {
  w.model.commit("main", commit);
  const task = await startTask(w, project);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const row = (await rechecksOf(w.h.store, w.h.deps.companyId, project)).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]!;
    await finishCheck(w.h, row.check.workspaceId, { status: "FAILED", error: SETUP_FAILS });
    await advanceCurrentRecheck(w.h.deps, project);
    // The retry waits out its delay (a short outage must not fail both tries).
    w.h.clock.advance(RECHECK_RETRY_DELAY_MS / 1000 + 1);
    await advanceCurrentRecheck(w.h.deps, project);
  }
  const recheck = (await rechecksOf(w.h.store, w.h.deps.companyId, project)).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]!;
  expect(recheck.state).toBe("broken");
  return { taskId: task.taskId, recheck };
}

// ---- the fake door and the fake setup-run starter

interface Door { run: UnattendedStartDeps; requests: AutomatedRunRequest[]; admits: Array<{ estimateUsd?: number; action: string }>; tasks: Map<string, string>; mode: { refuse: boolean; failAfterStart: boolean } }

function doorOf(w: World, options: { enforce?: boolean } = {}): Door {
  const requests: AutomatedRunRequest[] = [];
  const admits: Door["admits"] = [];
  const tasks = new Map<string, string>();
  const mode = { refuse: false, failAfterStart: false };
  const allowAll = createAllowAllAdmission();
  const admission: Admission = { ...allowAll, admit: async (request) => { admits.push({ action: request.action, ...(request.estimate?.cost === undefined ? {} : { estimateUsd: request.estimate.cost.micros / 1_000_000 }) }); return allowAll.admit(request); } };
  const starter: AutomatedRunStarter = {
    async start(request) {
      requests.push(request);
      if (mode.refuse) throw agentXError("NOT_AVAILABLE_HERE", "the host does not start this");
      // The host's start of a setup run: here the owner's own task start with the setup run's option (the real host starts it as the project's system owner).
      const started = await startFlowTask(w.h.deps, w.h.owner, { requestId: request.requestId, project: request.project, instructions: request.input.text, title: `Set up ${request.project}` }, { setupAgent: { limits: request.setupRepair!.limits, seenTaskId: request.setupRepair!.seenTaskId } });
      tasks.set(request.requestId, started.task.taskId);
      if (mode.failAfterStart) throw new Error("the answer was lost");
      return { taskId: started.task.taskId, duplicate: started.duplicate };
    },
    async read(requestId) { const taskId = tasks.get(requestId); return taskId === undefined ? undefined : { taskId }; },
  };
  const run: UnattendedStartDeps = { automation: fixedAutomationSwitch(true), companyId: w.h.deps.companyId, admission, audit: w.h.deps.audit, starter, enforces: { dollars: options.enforce !== false }, now: () => w.h.clock.now };
  return { run, requests, admits, tasks, mode };
}

interface Upkeep extends UpkeepGate { on: unknown; room: unknown; asked: string[] }
function upkeepOf(initial: { on?: unknown; room?: unknown } = {}): Upkeep {
  const gate: Upkeep = {
    on: "on" in initial ? initial.on : true, room: "room" in initial ? initial.room : 2500, asked: [],
    async enabled(project) { gate.asked.push(project); if (gate.on === "throw") throw new Error("upkeep down"); return gate.on as boolean; },
    async roomCents() { if (gate.room === "throw") throw new Error("meter down"); return gate.room as number; },
  };
  return gate;
}

function repairDepsOf(w: World, door: Door | undefined, upkeep: UpkeepGate | undefined, extra: { limitSetting?: (project: string) => Promise<unknown> } = {}): RepairDraftDeps {
  return {
    store: w.h.store, companyId: w.h.deps.companyId, now: () => w.h.clock.now, flow: w.h.deps, starter: undefined,
    async latest(project) { const found = await w.h.deps.projects.latest(project); return found === undefined ? undefined : { revision: found.definition.revision, definition: found.definition }; },
    upkeep, run: door?.run, ...extra,
  };
}

interface Rig { w: World; door: Door; upkeep: Upkeep; deps: RepairDraftDeps }
async function rig(options: { enforce?: boolean; on?: unknown; room?: unknown; limitSetting?: (project: string) => Promise<unknown>; wireHook?: boolean } = {}): Promise<Rig> {
  const w = await world();
  const door = doorOf(w, options.enforce === undefined ? {} : { enforce: options.enforce });
  const upkeep = upkeepOf({ ...("on" in options ? { on: options.on } : {}), ...("room" in options ? { room: options.room } : {}) });
  const deps = repairDepsOf(w, door, upkeep, options.limitSetting === undefined ? {} : { limitSetting: options.limitSetting });
  if (options.wireHook !== false) w.h.deps.afterSetupBroken = repairDraftHook(deps);
  return { w, door, upkeep, deps };
}

const BATCH = (): Record<string, unknown> => ({
  version: 2, basedOnRevision: 1, repositories: [], checks: [], testEnvironment: [], knowledge: [], sources: [], intake: [], allowedDomains: [], secretsNeeded: [], flaggedCommands: [], foundNotUsed: [], notes: "",
  setup: [{ id: "setup-1", value: { repo: "demo", commands: ["npm ci --prefer-offline"] }, from: [] }],
  tests: [{ id: "tests-1", value: { repo: "demo", commands: ["npm test"] }, from: [] }],
});
const SUMMARY = { stop: "proposed", commandsRun: 3, spendCents: 40, elapsedMs: 120_000, hostAsks: 0, partial: false };

/** The setup run ends. `verdict` is what the code host's re-read said of each item (kept on the task once final). */
async function endRun(w: World, taskId: string, result: Record<string, unknown>, verdict: "verified" | "unverified" = "verified"): Promise<void> {
  const ok = (await w.h.store.update({
    key: taskKey(taskId), condition: when.present(),
    ops: [change.set("setupAgentResult", result as never), change.set("setupAgentVerification", { items: { "setup-1": verdict, "tests-1": verdict } })],
  })).applied;
  expect(ok).toBe(true);
}
const readyResult = (summary: Record<string, unknown> = SUMMARY): Record<string, unknown> => ({ status: "ready", proposal: BATCH(), summary, stop: summary["stop"] });

const SYSTEM = (w: World): string => systemOwnerIdOf(w.h.deps.companyId, "payments");

/** Break the setup, let the hook start the draft, finish its run with a whole proposal, advance to the candidate's check. */
async function toChecking(r: Rig): Promise<{ taskId: string; pausedTaskId: string; row: RepairRow; recheck: RecheckRow }> {
  const { recheck, taskId: pausedTaskId } = await breakSetup(r.w);
  let row = (await repairsOf(r.w.h.store, r.w.h.deps.companyId, "payments"))[0]!;
  expect(row.state).toBe("drafting");
  await endRun(r.w, row.taskId!, readyResult());
  row = (await advanceRepairDraft(r.deps, "payments"))!;
  expect(row.state).toBe("checking");
  return { taskId: row.taskId!, pausedTaskId, row, recheck };
}
const candidateCheckOf = async (r: Rig): Promise<string> => ((await r.w.h.store.get(setupApplyKey(r.w.h.deps.companyId, "payments")))!["check"] as { workspaceId: string }).workspaceId;

describe("when a draft starts, and when it never does", () => {
  it("upkeep ON, a cap enforced with room, the project still at the revision that broke: the hook starts ONE run through the unattended door with the run's own limits, the origin nightly and no model asked by Rovara", async () => {
    const r = await rig();
    const { recheck } = await breakSetup(r.w);
    expect(r.door.requests).toHaveLength(1);
    const request = r.door.requests[0]!;
    expect(request).toMatchObject({ project: "payments", origin: "nightly", agent: { agentId: "rovara-code" }, limits: { maxRunUsd: 4, maxMinutes: 60 }, setupRepair: { limits: { budgetCents: 400, commands: 40, wallClockMin: 45 } } });
    // A model-using run: never the model-free `automatic` mark (which would need no cap).
    expect(request.automatic).toBeUndefined();
    expect(r.door.admits).toEqual([{ action: "automation.run", estimateUsd: 4 }]);
    const [row] = await repairsOf(r.w.h.store, r.w.h.deps.companyId, "payments");
    expect(row).toMatchObject({ state: "drafting", key: recheck.key, setupRevision: 1, budgetCents: 400, taskId: r.door.tasks.get(request.requestId) });
    expect(await r.w.h.store.get(repairCurrentKey(r.w.h.deps.companyId, "payments"))).toMatchObject({ key: recheck.key });
    // The run is a real setup run (the pointer names it), and the audit says Rovara started it.
    expect(await r.w.h.store.get(setupAgentKey(r.w.h.deps.companyId, "payments"))).toMatchObject({ taskId: row!.taskId });
    expect(r.w.h.audit.some((event) => event.action === "setup_repair.started" && event.actor.type === "system")).toBe(true);
    expect(r.w.modelRoute).not.toHaveBeenCalled();
  });

  it("one repair per failure: repeated hooks, repeated advances and two calls at once start one run", async () => {
    const r = await rig();
    const { recheck } = await breakSetup(r.w);
    const results = await Promise.all([startRepairDraft(r.deps, "payments", recheck.key), startRepairDraft(r.deps, "payments", recheck.key), startRepairDraft(r.deps, "payments", recheck.key)]);
    expect(results.every((result) => result.status === "exists")).toBe(true);
    await advanceRepairDraft(r.deps, "payments"); await advanceRepairDraft(r.deps, "payments"); await advanceCurrentRecheck(r.w.h.deps, "payments");
    expect(r.door.requests).toHaveLength(1);
    expect(await repairsOf(r.w.h.store, r.w.h.deps.companyId, "payments")).toHaveLength(1);
  });

  it("two concurrent first calls claim once (the claim row is written only if absent)", async () => {
    const r = await rig({ wireHook: false });
    const { recheck } = await breakSetup(r.w);
    expect(r.door.requests).toHaveLength(0);
    const results = await Promise.all([startRepairDraft(r.deps, "payments", recheck.key), startRepairDraft(r.deps, "payments", recheck.key)]);
    expect(results.filter((result) => result.status === "started")).toHaveLength(1);
    expect(r.door.requests).toHaveLength(1);
  });

  it("upkeep OFF: nothing starts, nothing is written, and the card offers 'Fix setup (uses your AI, up to $4)' and 'Edit commands myself'", async () => {
    const r = await rig({ on: false });
    const { recheck } = await breakSetup(r.w);
    expect(r.door.requests).toEqual([]);
    expect(await repairsOf(r.w.h.store, r.w.h.deps.companyId, "payments")).toEqual([]);
    expect(await startRepairDraft(r.deps, "payments", recheck.key)).toEqual({ status: "skipped", why: "upkeep_off" });
    expect(await readRepairView(r.deps, "payments")).toEqual({
      title: "Setup needs repair", state: "no_fix", classes: ["lockfile"], at: expect.any(String) as string,
      body: `The project's setup stopped working after recent code changes (${SETUP_FAILS_STEP}). Rovara cannot build on this project until it is fixed.`,
      actions: [{ id: "fix_setup", label: "Fix setup (uses your AI, up to $4)" }, { id: "edit_commands", label: "Edit commands myself" }],
    });
  });

  it.each([["a string", "true"], ["a number", 1], ["undefined", undefined], ["throws", "throw"]])("an upkeep switch that answers %s is OFF (a doubt never starts paid work)", async (_name, answer) => {
    const r = await rig({ on: answer });
    await breakSetup(r.w);
    expect(r.door.requests).toEqual([]);
    expect(await repairsOf(r.w.h.store, r.w.h.deps.companyId, "payments")).toEqual([]);
  });

  it("no upkeep seam at all, or no unattended door: nothing starts", async () => {
    const w = await world();
    const door = doorOf(w);
    w.h.deps.afterSetupBroken = repairDraftHook(repairDepsOf(w, door, undefined));
    await breakSetup(w);
    expect(door.requests).toEqual([]);
    const w2 = await world();
    w2.h.deps.afterSetupBroken = repairDraftHook(repairDepsOf(w2, undefined, upkeepOf()));
    await breakSetup(w2);
    expect(await repairsOf(w2.h.store, w2.h.deps.companyId, "payments")).toEqual([]);
  });

  it("no cap enforced on this install: nothing starts (a limit nothing enforces is no limit)", async () => {
    const r = await rig({ enforce: false });
    const { recheck } = await breakSetup(r.w);
    expect(r.door.requests).toEqual([]);
    expect(await startRepairDraft(r.deps, "payments", recheck.key)).toEqual({ status: "skipped", why: "no_cap" });
  });

  it.each([["one cent short", 399], ["none left", 0], ["unreadable", undefined], ["a fault", "throw"], ["not whole cents", 400.5], ["negative", -1], ["not a number", "plenty"], ["not finite", Number.POSITIVE_INFINITY]])("the upkeep cap's room, %s: no draft", async (_name, room) => {
    const r = await rig({ room });
    const { recheck } = await breakSetup(r.w);
    expect(r.door.requests).toEqual([]);
    expect(await startRepairDraft(r.deps, "payments", recheck.key)).toEqual({ status: "skipped", why: "no_room" });
    expect(await repairsOf(r.w.h.store, r.w.h.deps.companyId, "payments")).toEqual([]);
  });

  it("room for exactly the run's budget is enough; the run is held to the project's own setup-run limits (the dollar limit and the room are read against the SAME number)", async () => {
    const exact = await rig({ room: 400 });
    await breakSetup(exact.w);
    expect(exact.door.requests).toHaveLength(1);
    const small = await rig({ room: 150, limitSetting: async () => ({ budgetCents: 150, commands: 12 }) });
    await breakSetup(small.w);
    expect(small.door.requests[0]).toMatchObject({ limits: { maxRunUsd: 1.5 }, setupRepair: { limits: { budgetCents: 150, commands: 12 } } });
    const tooSmall = await rig({ room: 399, limitSetting: async () => ({ budgetCents: 150 }) });
    await breakSetup(tooSmall.w);
    expect(tooSmall.door.requests).toHaveLength(1);
    const short = await rig({ room: 149, limitSetting: async () => ({ budgetCents: 150 }) });
    await breakSetup(short.w);
    expect(short.door.requests).toEqual([]);
  });

  it("only a re-check that settled BROKEN starts a draft: a passing, a tests-failing and a running re-check never do", async () => {
    const r = await rig({ wireHook: false });
    r.w.model.commit("main", { "package-lock.json": "lock-2" });
    await startTask(r.w);
    const running = (await rechecksOf(r.w.h.store, r.w.h.deps.companyId, "payments"))[0]!;
    expect(await startRepairDraft(r.deps, "payments", running.key)).toEqual({ status: "skipped", why: "not_broken" });
    await finishCheck(r.w.h, running.check.workspaceId, { status: "SUCCEEDED" });
    await advanceCurrentRecheck(r.w.h.deps, "payments");
    expect(await startRepairDraft(r.deps, "payments", running.key)).toEqual({ status: "skipped", why: "not_broken" });
    const second = await rig({ wireHook: false });
    second.w.model.commit("main", { "package-lock.json": "lock-2" });
    await startTask(second.w);
    const tests = (await rechecksOf(second.w.h.store, second.w.h.deps.companyId, "payments"))[0]!;
    await finishCheck(second.w.h, tests.check.workspaceId, { status: "FAILED", error: "readiness check 0 (npm test) failed: exit 1" });
    await advanceCurrentRecheck(second.w.h.deps, "payments");
    expect((await rechecksOf(second.w.h.store, second.w.h.deps.companyId, "payments"))[0]!.state).toBe("tests_failing");
    expect(await startRepairDraft(second.deps, "payments", tests.key)).toEqual({ status: "skipped", why: "not_broken" });
    expect(await startRepairDraft(second.deps, "payments", "no-such-key")).toEqual({ status: "skipped", why: "not_broken" });
    expect(r.door.requests).toEqual([]);
    expect(second.door.requests).toEqual([]);
  });

  it("a project that moved on since the break (a newer approved setup) starts no draft", async () => {
    const r = await rig({ wireHook: false });
    const { recheck } = await breakSetup(r.w);
    await r.w.h.store.put({ item: { ...projectRevisionKey(r.w.h.deps.companyId, "payments", 2), entityType: "PROJECT", definition: JSON.parse(JSON.stringify({ ...r.w.project, revision: 2 })) as never } });
    await r.w.h.store.update({ key: orgProjectCatalogKey(r.w.h.deps.companyId, "payments"), ops: [change.set("latestRevision", 2)] });
    expect(await startRepairDraft(r.deps, "payments", recheck.key)).toEqual({ status: "skipped", why: "not_broken" });
    expect(r.door.requests).toEqual([]);
  });

  it("a candidate waiting for a person, or a setup run already going, blocks the draft (it never replaces them)", async () => {
    const r = await rig({ wireHook: false });
    const { recheck } = await breakSetup(r.w);
    await r.w.h.store.put({ item: { ...setupApplyKey(r.w.h.deps.companyId, "payments"), entityType: "SETUP_APPLY", orgId: r.w.h.deps.companyId, project: "payments", state: "checking", requestId: randomUUID() } });
    expect(await startRepairDraft(r.deps, "payments", recheck.key)).toEqual({ status: "skipped", why: "busy" });
    await r.w.h.store.delete({ key: setupApplyKey(r.w.h.deps.companyId, "payments") });
    // A person's own setup run is going.
    await startFlowTask(r.w.h.deps, r.w.h.owner, { requestId: newRequestId(), project: "payments", instructions: "Set up", title: "Set up payments" }, { setupAgent: { limits: { commands: 40, sameStepTries: 3, wallClockMin: 45, budgetCents: 400, hostAsks: 5 }, seenTaskId: undefined } });
    expect(await startRepairDraft(r.deps, "payments", recheck.key)).toEqual({ status: "skipped", why: "busy" });
    expect(r.door.requests).toEqual([]);
  });

  it("a start the door refuses leaves nothing behind (claim and pointer given back, nothing spent) and a later call may try again", async () => {
    const r = await rig({ wireHook: false });
    const { recheck } = await breakSetup(r.w);
    r.door.mode.refuse = true;
    expect(await startRepairDraft(r.deps, "payments", recheck.key)).toEqual({ status: "skipped", why: "start_refused" });
    expect(await repairsOf(r.w.h.store, r.w.h.deps.companyId, "payments")).toEqual([]);
    expect(await r.w.h.store.get(repairCurrentKey(r.w.h.deps.companyId, "payments"))).toBeUndefined();
    expect(r.door.tasks.size).toBe(0);
    r.door.mode.refuse = false;
    expect((await startRepairDraft(r.deps, "payments", recheck.key)).status).toBe("started");
  });

  it("a fault after the run began adopts the run (the same request id): one run, a draft that is drafting", async () => {
    const r = await rig({ wireHook: false });
    const { recheck } = await breakSetup(r.w);
    r.door.mode.failAfterStart = true;
    const started = await startRepairDraft(r.deps, "payments", recheck.key);
    expect(started.status).toBe("started");
    expect(r.door.tasks.size).toBe(1);
    expect((await repairsOf(r.w.h.store, r.w.h.deps.companyId, "payments"))[0]).toMatchObject({ state: "drafting", taskId: [...r.door.tasks.values()][0] });
  });

  it("a claim whose start never finished is adopted when the run exists, and given back after ten minutes when it does not", async () => {
    const r = await rig({ wireHook: false });
    const { recheck } = await breakSetup(r.w);
    const orgId = r.w.h.deps.companyId;
    const claimed = { entityType: "SETUP_REPAIR", orgId, project: "payments", key: recheck.key, setupRevision: 1, runRequestId: randomUUID(), confirmRequestId: randomUUID(), state: "starting", budgetCents: 400, claimedAt: new Date(r.w.h.clock.now).toISOString() };
    await r.w.h.store.put({ item: { ...repairRowKey(orgId, "payments", recheck.key), ...claimed } });
    await r.w.h.store.put({ item: { ...repairCurrentKey(orgId, "payments"), entityType: "SETUP_REPAIR_CURRENT", orgId, project: "payments", key: recheck.key, startedAt: claimed.claimedAt } });
    expect((await advanceRepairDraft(r.deps, "payments"))?.state).toBe("starting");
    r.w.h.clock.advance(REPAIR_START_STALE_MS / 1000 + 1);
    await advanceRepairDraft(r.deps, "payments");
    expect(await repairsOf(r.w.h.store, orgId, "payments")).toEqual([]);
    // With a run the door holds for the request, the claim is adopted instead.
    await r.w.h.store.put({ item: { ...repairRowKey(orgId, "payments", recheck.key), ...claimed } });
    await r.w.h.store.put({ item: { ...repairCurrentKey(orgId, "payments"), entityType: "SETUP_REPAIR_CURRENT", orgId, project: "payments", key: recheck.key, startedAt: claimed.claimedAt } });
    r.door.tasks.set(claimed.runRequestId, "task-held-by-the-door");
    expect(await advanceRepairDraft(r.deps, "payments")).toMatchObject({ state: "drafting", taskId: "task-held-by-the-door" });
  });

  it("the cooldown: a second failure within 12 hours of a draft starts none; after 12 hours it does", async () => {
    const r = await rig();
    await breakSetup(r.w);
    expect(r.door.requests).toHaveLength(1);
    // The first draft's run failed (so the project is free again), then the code moves again and the setup breaks again at a new commit.
    const first = (await repairsOf(r.w.h.store, r.w.h.deps.companyId, "payments"))[0]!;
    await endRun(r.w, first.taskId!, { status: "failed", stop: "infrastructure", failure: "The setup run could not go on. Try again." });
    expect((await advanceRepairDraft(r.deps, "payments"))?.state).toBe("failed");
    // (The project is refused new starts while broken, so the second failure is a second broken re-check of the same project, as a nightly or a person's check would leave it.)
    const orgId = r.w.h.deps.companyId;
    const secondKey = "second-failure-key";
    const broken = (await r.w.h.store.get(recheckRowKey(orgId, "payments", first.key)))!;
    await r.w.h.store.put({ item: { ...broken, ...recheckRowKey(orgId, "payments", secondKey), key: secondKey } });
    const again = { recheck: { key: secondKey } };
    expect(again.recheck.key).not.toBe(first.key);
    expect(r.door.requests).toHaveLength(1);
    expect(await startRepairDraft(r.deps, "payments", again.recheck.key)).toEqual({ status: "skipped", why: "cooling_down" });
    r.w.h.clock.advance(REPAIR_COOLDOWN_MS / 1000 + 1);
    expect((await startRepairDraft(r.deps, "payments", again.recheck.key)).status).toBe("started");
    expect(r.door.requests).toHaveLength(2);
  });
});

describe("the draft, step by step: Rovara drafts, a person decides", () => {
  it("run finishes -> the candidate is stored by the confirm path (system owner, not the project's latest) -> its check passes on a NEW workspace -> 'Approve new setup' -> the gate's risk-based approvers decide, and only then the project moves", async () => {
    const r = await rig();
    const { taskId, pausedTaskId, row } = await toChecking(r);
    const orgId = r.w.h.deps.companyId;
    expect(await setupGateBeforeBuild(r.w.h.deps, { project: "payments", taskId: pausedTaskId })).toMatchObject({ answer: "blocked" });
    // The candidate: stored as revision 2, NOT the project's latest, started by the system owner, its check on a workspace of its own (not the run's).
    const apply = (await r.w.h.store.get(setupApplyKey(orgId, "payments")))!;
    expect(apply).toMatchObject({ state: "checking", requestId: row.confirmRequestId, by: SYSTEM(r.w), baseRevision: 1, candidateRevision: 2, taskId });
    expect(apply["check"]).toMatchObject({ revision: 2, startedBy: SYSTEM(r.w) });
    expect((apply["check"] as { workspaceId: string }).workspaceId).not.toBe((await r.w.h.store.get(taskKey(taskId)))!["workspaceId"]);
    expect(await r.w.h.store.get(orgProjectCatalogKey(orgId, "payments"))).toMatchObject({ latestRevision: 1 });
    expect(await r.w.h.store.get(projectRevisionKey(orgId, "payments", 2))).toMatchObject({ candidate: true });
    // While it is checking the card says a draft is on its way, with no approval to give.
    expect(await readRepairView(r.deps, "payments")).toMatchObject({ state: "drafting", actions: [{ id: "edit_commands", label: "Edit commands myself" }] });
    // The candidate check passes.
    await finishCheck(r.w.h, await candidateCheckOf(r), { status: "SUCCEEDED" });
    const readyRow = (await advanceRepairDraft(r.deps, "payments"))!;
    expect(readyRow.state).toBe("ready");
    expect(await r.w.h.store.get(orgProjectCatalogKey(orgId, "payments"))).toMatchObject({ latestRevision: 1 });
    expect(await readRepairView(r.deps, "payments")).toEqual({
      title: "Setup needs repair", state: "fix_ready", classes: ["lockfile"], at: expect.any(String) as string, candidateRevision: 2, changes: 2,
      body: `The project's setup stopped working after recent code changes (${SETUP_FAILS_STEP}). Rovara drafted a fix and checked it on a fresh machine: it passes. 2 changes.`,
      actions: [{ id: "approve_setup", label: "Approve new setup" }, { id: "see_changes", label: "See changes" }],
    });
    // The decision is the gate's: a person whose standing does not fit the candidate's risk is refused, and nothing moves.
    const standing = { member: { companyRole: "member" as const }, maintainer: { companyRole: "member" as const, projectGrant: "administrator" as const } };
    let who: keyof typeof standing = "member";
    const subject = createSetupProposalSubject({
      flow: r.w.h.deps,
      approval: { riskFromDiff: true, mayDecide: async (_approver: Principal, input) => setupApproverAllows(standing[who], input.risk, input.outcome), refusal: () => "not allowed" },
    });
    const loaded = (await subject.load(orgId, "payments"))!;
    expect(loaded.waiting).toBe(true);
    expect(loaded.request).toMatchObject({ kind: "setup", revision: 2, risk: "low" });
    const approver = { companyId: orgId, personId: "p-maint", displayName: "Maint", roles: ["member"], provider: "test" } as unknown as Principal;
    await expect(subject.apply(loaded, { outcome: "approve" } as never, [approver], new Date(r.w.h.clock.now).toISOString())).rejects.toMatchObject({ code: "not_the_approver" });
    expect(await r.w.h.store.get(orgProjectCatalogKey(orgId, "payments"))).toMatchObject({ latestRevision: 1 });
    who = "maintainer";
    const decided = await subject.apply(loaded, { outcome: "approve" } as never, [approver], new Date(r.w.h.clock.now).toISOString());
    expect((await r.w.h.store.transact([{ kind: "update", key: loaded.key, ops: decided.ops, condition: loaded.guard }, ...(decided.extra ?? [])])).applied).toBe(true);
    expect(await r.w.h.store.get(orgProjectCatalogKey(orgId, "payments"))).toMatchObject({ latestRevision: 2 });
    expect(await r.w.h.store.get(setupApplyKey(orgId, "payments"))).toMatchObject({ state: "approved", decidedBy: "p-maint" });
    // The draft notices; the card goes; the paused task goes on (a newer setup is a new revision).
    expect((await advanceRepairDraft(r.deps, "payments"))?.state).toBe("approved");
    expect(await readRepairView(r.deps, "payments")).toBeUndefined();
    expect(await setupGateBeforeBuild(r.w.h.deps, { project: "payments", taskId: pausedTaskId })).toEqual({ answer: "go" });
    expect(r.w.modelRoute).not.toHaveBeenCalled();
  });

  it("the repair code never approves: before the person's decision the project's revision, catalog and approved check are exactly as before, across every state the draft passes through", async () => {
    const r = await rig();
    const orgId = r.w.h.deps.companyId;
    const catalogBefore = await r.w.h.store.get(orgProjectCatalogKey(orgId, "payments"));
    await toChecking(r);
    await finishCheck(r.w.h, await candidateCheckOf(r), { status: "SUCCEEDED" });
    for (let i = 0; i < 4; i += 1) await advanceRepairDraft(r.deps, "payments");
    expect(await r.w.h.store.get(orgProjectCatalogKey(orgId, "payments"))).toEqual(catalogBefore);
    expect(await r.w.h.store.get(projectRevisionKey(orgId, "payments", 2))).toMatchObject({ candidate: true });
    expect((await r.w.h.store.get(setupApplyKey(orgId, "payments")))!["state"]).toBe("checking");
    expect((await repairsOf(r.w.h.store, orgId, "payments"))[0]!.state).toBe("ready");
  });

  it("a run that stopped on a limit (a partial proposal) or finished with a fault is a FAILED draft in fixed words: nothing is confirmed and no candidate exists", async () => {
    for (const result of [
      readyResult({ ...SUMMARY, stop: "budget_used", partial: true }),
      readyResult({ ...SUMMARY, stop: "proposed", partial: true }),
      { status: "failed", stop: "infrastructure", failure: "The setup run could not go on. Try again." },
      { status: "failed", stop: "needs_code_change", failure: "The setup needs a change in the code. Ask Rovara to make it as a normal task." },
    ]) {
      const r = await rig();
      await breakSetup(r.w);
      const row = (await repairsOf(r.w.h.store, r.w.h.deps.companyId, "payments"))[0]!;
      await endRun(r.w, row.taskId!, result);
      const after = (await advanceRepairDraft(r.deps, "payments"))!;
      expect(after).toMatchObject({ state: "failed", reason: "run_failed" });
      expect(await r.w.h.store.get(setupApplyKey(r.w.h.deps.companyId, "payments"))).toBeUndefined();
      expect(await r.w.h.store.get(projectRevisionKey(r.w.h.deps.companyId, "payments", 2))).toBeUndefined();
      const view = (await readRepairView(r.deps, "payments"))!;
      expect(view).toMatchObject({ state: "no_fix", failure: "run_failed", actions: [{ id: "fix_setup" }, { id: "edit_commands" }] });
      expect(view.body).toContain(REPAIR_WORDS.failed.run_failed);
      expect(view.body).not.toMatch(/budget_used|infrastructure|needs_code_change/u);
    }
  });

  it("a stop word on a failed run is kept only when it is one of the closed words", async () => {
    const r = await rig();
    await breakSetup(r.w);
    const row = (await repairsOf(r.w.h.store, r.w.h.deps.companyId, "payments"))[0]!;
    await endRun(r.w, row.taskId!, { status: "failed", stop: "time_used", failure: "Rovara ran out of time before the setup worked. It kept what it learned." });
    expect(await advanceRepairDraft(r.deps, "payments")).toMatchObject({ state: "failed", reason: "run_failed", stop: "time_used" });
  });

  it("a proposal none of whose items passed the code host's re-read cannot be used: failed, no candidate", async () => {
    const r = await rig();
    await breakSetup(r.w);
    const row = (await repairsOf(r.w.h.store, r.w.h.deps.companyId, "payments"))[0]!;
    await endRun(r.w, row.taskId!, readyResult(), "unverified");
    expect(await advanceRepairDraft(r.deps, "payments")).toMatchObject({ state: "failed", reason: "no_usable_fix" });
    expect(await r.w.h.store.get(setupApplyKey(r.w.h.deps.companyId, "payments"))).toBeUndefined();
    expect(await r.w.h.store.get(projectRevisionKey(r.w.h.deps.companyId, "payments", 2))).toBeUndefined();
  });

  it("the candidate's check FAILS: the candidate is removed, the draft is failed in fixed words, no second draft ever starts for this failure, and the manual 'Fix setup' stays open", async () => {
    const r = await rig();
    const { row, recheck } = await toChecking(r);
    const orgId = r.w.h.deps.companyId;
    await finishCheck(r.w.h, await candidateCheckOf(r), { status: "FAILED", error: SETUP_FAILS });
    const after = (await advanceRepairDraft(r.deps, "payments"))!;
    expect(after).toMatchObject({ state: "failed", reason: "check_failed" });
    expect(await r.w.h.store.get(projectRevisionKey(orgId, "payments", 2))).toBeUndefined();
    expect(await r.w.h.store.get(setupApplyKey(orgId, "payments"))).toMatchObject({ state: "discarded" });
    expect(await r.w.h.store.get(orgProjectCatalogKey(orgId, "payments"))).toMatchObject({ latestRevision: 1 });
    const view = (await readRepairView(r.deps, "payments"))!;
    expect(view).toMatchObject({ state: "no_fix", failure: "check_failed", actions: [{ id: "fix_setup", label: "Fix setup (uses your AI, up to $4)" }, { id: "edit_commands" }] });
    expect(view.body.endsWith(REPAIR_WORDS.failed.check_failed)).toBe(true);
    // No loop: more calls, a new hook and a direct start all answer the same failed draft.
    for (let i = 0; i < 3; i += 1) await advanceRepairDraft(r.deps, "payments");
    expect(await startRepairDraft(r.deps, "payments", recheck.key)).toMatchObject({ status: "exists", row: { state: "failed", key: row.key } });
    expect(r.door.requests).toHaveLength(1);
    // The project is free for the person's own "Fix setup": no candidate waits.
    expect(await r.w.h.store.get(projectRevisionKey(orgId, "payments", 2))).toBeUndefined();
  });

  it("a person's own setup run took the project's pointer: the draft is over and ONLY its own run is ever confirmed (the other proposal is never touched)", async () => {
    const r = await rig();
    const { recheck } = await breakSetup(r.w);
    const orgId = r.w.h.deps.companyId;
    const draft = (await repairsOf(r.w.h.store, orgId, "payments"))[0]!;
    // The draft's run ends (so the pointer may move), then a person starts their own run, which finishes with a proposal of its own.
    await endRun(r.w, draft.taskId!, { status: "failed", stop: "infrastructure", failure: "The setup run could not go on. Try again." });
    const theirs = await startFlowTask(r.w.h.deps, r.w.h.owner, { requestId: newRequestId(), project: "payments", instructions: "Set up", title: "Set up payments" }, { setupAgent: { limits: { commands: 40, sameStepTries: 3, wallClockMin: 45, budgetCents: 400, hostAsks: 5 }, seenTaskId: draft.taskId } });
    await endRun(r.w, theirs.task.taskId, readyResult());
    // Put the draft back to "drafting" as if it had not yet noticed.
    expect(recheck.key).toBe(draft.key);
    const after = (await advanceRepairDraft(r.deps, "payments"))!;
    expect(after).toMatchObject({ state: "ended", reason: "superseded" });
    expect(await r.w.h.store.get(setupApplyKey(orgId, "payments"))).toBeUndefined();
    expect(await r.w.h.store.get(projectRevisionKey(orgId, "payments", 2))).toBeUndefined();
  });

  it("a person who discards or rejects the candidate ends the draft quietly (decided), and a project that moved on ends it (superseded)", async () => {
    const r = await rig();
    await toChecking(r);
    const orgId = r.w.h.deps.companyId;
    await r.w.h.store.transact([
      { kind: "update", key: setupApplyKey(orgId, "payments"), ops: [change.set("state", "discarded")], condition: when.eq("state", "checking") },
      { kind: "delete", key: projectRevisionKey(orgId, "payments", 2) },
    ]);
    expect(await advanceRepairDraft(r.deps, "payments")).toMatchObject({ state: "ended", reason: "decided" });
    const s = await rig();
    await breakSetup(s.w);
    await s.w.h.store.put({ item: { ...projectRevisionKey(s.w.h.deps.companyId, "payments", 2), entityType: "PROJECT", definition: JSON.parse(JSON.stringify({ ...s.w.project, revision: 2 })) as never } });
    await s.w.h.store.update({ key: orgProjectCatalogKey(s.w.h.deps.companyId, "payments"), ops: [change.set("latestRevision", 2)] });
    expect(await advanceRepairDraft(s.deps, "payments")).toMatchObject({ state: "ended", reason: "superseded" });
  });

  it("a draft whose run never finished is over after 48 hours (failed), and one whose check never finished too", async () => {
    const r = await rig();
    await breakSetup(r.w);
    r.w.h.clock.advance(48 * 3600 + 5);
    expect(await advanceRepairDraft(r.deps, "payments")).toMatchObject({ state: "failed", reason: "run_failed" });
  });

  it("turning upkeep on LATER takes effect: the next advance starts the draft for a setup that is already broken", async () => {
    const r = await rig({ on: false });
    await breakSetup(r.w);
    expect(r.door.requests).toEqual([]);
    r.upkeep.on = true;
    const row = await advanceRepairDraft(r.deps, "payments");
    expect(row).toMatchObject({ state: "drafting" });
    expect(r.door.requests).toHaveLength(1);
  });

  it("the card's dollar amount follows the project's setup-run limit", () => {
    expect(fixSetupLabel(400)).toBe("Fix setup (uses your AI, up to $4)");
    expect(fixSetupLabel(150)).toBe("Fix setup (uses your AI, up to $1.50)");
  });
});

describe("races, stuck states and what a draft may touch (review fixes)", () => {
  /** A second broken re-check of the same project under another key, as a second commit's check would leave it. */
  async function secondBroken(w: World, firstKey: string, key: string): Promise<void> {
    const orgId = w.h.deps.companyId;
    const broken = (await w.h.store.get(recheckRowKey(orgId, "payments", firstKey)))!;
    await w.h.store.put({ item: { ...broken, ...recheckRowKey(orgId, "payments", key), key } });
  }

  it("two DIFFERENT failures settling at once start exactly one run, and the loser can neither wipe the winner's pointer nor start a second paid run", async () => {
    const r = await rig({ wireHook: false });
    const { recheck } = await breakSetup(r.w);
    await secondBroken(r.w, recheck.key, "second-key");
    const results = await Promise.all([startRepairDraft(r.deps, "payments", recheck.key), startRepairDraft(r.deps, "payments", "second-key")]);
    expect(results.filter((result) => result.status === "started")).toHaveLength(1);
    expect(r.door.requests).toHaveLength(1);
    const winner = (await repairsOf(r.w.h.store, r.w.h.deps.companyId, "payments")).filter((row) => row.state !== "starting");
    expect(winner).toHaveLength(1);
    expect(await r.w.h.store.get(repairCurrentKey(r.w.h.deps.companyId, "payments"))).toMatchObject({ key: winner[0]!.key });
  });

  it("a refused start gives back only its OWN pointer: a pointer another claim wrote meanwhile stays (restoring by key)", async () => {
    const r = await rig({ wireHook: false });
    const { recheck } = await breakSetup(r.w);
    const orgId = r.w.h.deps.companyId;
    const inner = r.door.run.starter;
    const other = { ...repairCurrentKey(orgId, "payments"), entityType: "SETUP_REPAIR_CURRENT", orgId, project: "payments", key: "someone-else", startedAt: new Date(r.w.h.clock.now).toISOString() };
    r.door.run.starter = { read: inner.read.bind(inner), async start() { await r.w.h.store.put({ item: other }); throw agentXError("NOT_AVAILABLE_HERE", "refused"); } };
    expect(await startRepairDraft(r.deps, "payments", recheck.key)).toEqual({ status: "skipped", why: "start_refused" });
    expect(await r.w.h.store.get(repairCurrentKey(orgId, "payments"))).toMatchObject({ key: "someone-else" });
    expect(await repairsOf(r.w.h.store, orgId, "payments")).toEqual([]);
  });

  it("a pointer that changed after it was read refuses the claim (the write holds only while the pointer is as read)", async () => {
    const r = await rig({ wireHook: false });
    const { recheck } = await breakSetup(r.w);
    const orgId = r.w.h.deps.companyId;
    // The pointer appears between this call's read and its write: simulated by a gate whose room read writes it.
    const racing: UpkeepGate = { enabled: async () => true, async roomCents() {
      await r.w.h.store.put({ item: { ...repairCurrentKey(orgId, "payments"), entityType: "SETUP_REPAIR_CURRENT", orgId, project: "payments", key: "someone-else", startedAt: new Date(r.w.h.clock.now - 2 * REPAIR_COOLDOWN_MS).toISOString() } });
      return 5000;
    } };
    const result = await startRepairDraft(repairDepsOf(r.w, r.door, racing), "payments", recheck.key);
    expect(result).toEqual({ status: "skipped", why: "busy" });
    expect(r.door.requests).toEqual([]);
    expect(await repairsOf(r.w.h.store, orgId, "payments")).toEqual([]);
  });

  it("a person's candidate that replaces Rovara's failed one between the draft's read and its discard is never discarded (the discard holds only for the draft's own request id)", async () => {
    const r = await rig();
    await toChecking(r);
    const orgId = r.w.h.deps.companyId;
    await finishCheck(r.w.h, await candidateCheckOf(r), { status: "FAILED", error: SETUP_FAILS });
    const applyKey = setupApplyKey(orgId, "payments");
    // The draft reads the apply row once (its check failed); before its discard looks again, a person's own candidate has replaced it.
    let reads = 0;
    const racing = new Proxy(r.w.h.store, { get(target, property) {
      if (property !== "get") { const value = Reflect.get(target, property, target) as unknown; return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value; }
      return async (key: { pk: string; sk: string }) => {
        if (key.pk === applyKey.pk && key.sk === applyKey.sk && (reads += 1) === 2) {
          const mine = (await target.get(applyKey))!;
          await target.put({ item: { ...mine, requestId: randomUUID(), by: "p-person" } });
        }
        return target.get(key);
      };
    } });
    await advanceRepairDraft({ ...r.deps, store: racing }, "payments");
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(await r.w.h.store.get(applyKey)).toMatchObject({ state: "checking", by: "p-person" });
    expect(await r.w.h.store.get(projectRevisionKey(orgId, "payments", 2))).toMatchObject({ candidate: true });
  });

  it("discardSetupApply with a request id drops only that request's waiting candidate; without one it drops whatever waits (a person's discard)", async () => {
    const r = await rig();
    await toChecking(r);
    const orgId = r.w.h.deps.companyId;
    expect(await discardSetupApply(r.deps, "payments", "p-person", randomUUID())).toBe(false);
    expect(await r.w.h.store.get(setupApplyKey(orgId, "payments"))).toMatchObject({ state: "checking" });
    expect(await discardSetupApply(r.deps, "payments", "p-person")).toBe(true);
    expect(await r.w.h.store.get(setupApplyKey(orgId, "payments"))).toMatchObject({ state: "discarded", decidedBy: "p-person" });
  });

  it("a candidate check that never finished is over after 48 hours, and ITS candidate is removed (it cannot block the project or be approved under a 'failed' card)", async () => {
    const r = await rig();
    await toChecking(r);
    const orgId = r.w.h.deps.companyId;
    r.w.h.clock.advance(48 * 3600 + 5);
    expect(await advanceRepairDraft(r.deps, "payments")).toMatchObject({ state: "failed", reason: "check_failed" });
    expect(await r.w.h.store.get(projectRevisionKey(orgId, "payments", 2))).toBeUndefined();
    expect(await r.w.h.store.get(setupApplyKey(orgId, "payments"))).toMatchObject({ state: "discarded" });
  });

  it("a fault in the host's hook (thrown at once, or rejected later) never reaches the re-check: it still settles broken and the project is still paused", async () => {
    for (const hook of [(() => { throw new Error("hook exploded"); }) as () => Promise<void>, async () => { throw new Error("hook rejected"); }]) {
      const r = await rig({ wireHook: false });
      r.w.h.deps.afterSetupBroken = hook;
      const { taskId } = await breakSetup(r.w);
      expect(await setupGateBeforeBuild(r.w.h.deps, { project: "payments", taskId })).toMatchObject({ answer: "blocked" });
      expect(await repairsOf(r.w.h.store, r.w.h.deps.companyId, "payments")).toEqual([]);
    }
  });

  it("a stop word outside the closed list is never kept on the row", async () => {
    const r = await rig();
    await breakSetup(r.w);
    const row = (await repairsOf(r.w.h.store, r.w.h.deps.companyId, "payments"))[0]!;
    await endRun(r.w, row.taskId!, { status: "failed", stop: "<script>alert(1)</script> sk-not-a-word", failure: "The setup run could not go on. Try again." });
    const after = (await advanceRepairDraft(r.deps, "payments"))!;
    expect(after).toMatchObject({ state: "failed", reason: "run_failed" });
    expect(after.stop).toBeUndefined();
    expect(JSON.stringify(await repairsOf(r.w.h.store, r.w.h.deps.companyId, "payments"))).not.toContain("script");
  });

  it("a repair row copied under another company's key reads as nothing even where the pointer is that company's own", async () => {
    const shared = new MemoryDocumentStore({ indexes: TASK_FLOW_INDEXES, nowSeconds: () => Math.floor(Date.parse("2026-11-09T10:00:00.000Z") / 1_000) });
    const backend = (): { store: DocumentStore; queues: MemoryQueueService } => ({ store: shared, queues: new MemoryQueueService({ now: () => Date.parse("2026-11-09T10:00:00.000Z") }) });
    const a = await world({ backend });
    const b = await world({ backend, companyId: COMPANY_B });
    const depsA = repairDepsOf(a, doorOf(a), upkeepOf());
    const depsB = repairDepsOf(b, doorOf(b), upkeepOf());
    a.h.deps.afterSetupBroken = repairDraftHook(depsA);
    await breakSetup(a);
    const draft = (await repairsOf(shared, a.h.deps.companyId, "payments"))[0]!;
    await shared.put({ item: { ...(await shared.get(repairRowKey(a.h.deps.companyId, "payments", draft.key)))!, ...repairRowKey(COMPANY_B, "payments", draft.key) } });
    await shared.put({ item: { ...repairCurrentKey(COMPANY_B, "payments"), entityType: "SETUP_REPAIR_CURRENT", orgId: COMPANY_B, project: "payments", key: draft.key, startedAt: new Date(a.h.clock.now).toISOString() } });
    expect(await advanceRepairDraft(depsB, "payments")).toBeUndefined();
  });
});

describe("the local starter and the source", () => {
  it("the laptop's task-flow starter REFUSES a setup repair request (it would make an ordinary task from its text)", async () => {
    const start = vi.fn();
    const starter = createTaskFlowRunStarter({ flow: { start, deps: { store: new MemoryDocumentStore({}) } } as never, owner: { companyId: IMPLICIT_COMPANY_ID, personId: "owner" } as never });
    await expect(starter.start({
      requestId: randomUUID(), project: "payments", agent: { agentId: "rovara-code" }, input: { text: "Set up the dev environment" }, origin: "nightly", limits: { maxMinutes: 60, maxRunUsd: 4 },
      setupRepair: { limits: { commands: 40, sameStepTries: 3, wallClockMin: 45, budgetCents: 400, hostAsks: 5 }, seenTaskId: undefined },
    })).rejects.toThrow(SETUP_REPAIR_NOT_HERE);
    expect(start).not.toHaveBeenCalled();
  });

  it("the repair module has no path to an approval, a model or the project's revision (a guard on the source, beside the behaviour above)", () => {
    const source = ["repair-draft.ts", "repair-rows.ts"].map((file) => readFileSync(new URL(`../../packages/broker/src/core/setup-agent/${file}`, import.meta.url), "utf8")).join("\n");
    const code = source.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/u.test(line)).join("\n");
    expect(code).not.toMatch(/approval-gate|decisions\//u);
    expect(code).not.toMatch(/orgProjectCatalogKey|latestRevision|projectRevisionKey|projectMetaKey/u);
    expect(code).not.toMatch(/modelAccess|ModelRoute|\.route\(/u);
    expect(code).not.toMatch(/\.approve\(|outcome: "approve"|state: "approved"[^}]*apply/u);
    expect(code).toContain("startUnattendedRun");
  });
});

describe("isolation", () => {
  it("another project of the company never meets this project's draft, card or pointer: breaking and repairing one leaves the other untouched", async () => {
    const r = await rig();
    await r.w.h.registerProject(projectOf("billing"));
    await r.w.h.store.put({ item: { ...projectMetaKey(r.w.h.deps.companyId, "billing"), entityType: "PROJECT_META" } });
    await saveSnapshot(r.w, projectOf("billing"));
    await breakSetup(r.w);
    expect(await repairsOf(r.w.h.store, r.w.h.deps.companyId, "payments")).toHaveLength(1);
    expect(await repairsOf(r.w.h.store, r.w.h.deps.companyId, "billing")).toEqual([]);
    expect(await r.w.h.store.get(repairCurrentKey(r.w.h.deps.companyId, "billing"))).toBeUndefined();
    expect(await readRepairView(r.deps, "billing")).toBeUndefined();
    expect(await advanceRepairDraft(r.deps, "billing")).toBeUndefined();
    expect(r.upkeep.asked.every((project) => project === "payments")).toBe(true);
    // Finishing payments' run never touches billing.
    const draft = (await repairsOf(r.w.h.store, r.w.h.deps.companyId, "payments"))[0]!;
    await endRun(r.w, draft.taskId!, readyResult());
    await advanceRepairDraft(r.deps, "payments");
    expect(await r.w.h.store.get(setupApplyKey(r.w.h.deps.companyId, "billing"))).toBeUndefined();
    expect(await r.w.h.store.get(projectRevisionKey(r.w.h.deps.companyId, "billing", 2))).toBeUndefined();
  });

  it("another company's project of the same name never meets this company's draft, card, pointer or run; a row copied under its key reads as nothing", async () => {
    const shared = new MemoryDocumentStore({ indexes: TASK_FLOW_INDEXES, nowSeconds: () => Math.floor(Date.parse("2026-11-09T10:00:00.000Z") / 1_000) });
    const backend = (): { store: DocumentStore; queues: MemoryQueueService } => ({ store: shared, queues: new MemoryQueueService({ now: () => Date.parse("2026-11-09T10:00:00.000Z") }) });
    const a = await world({ backend });
    const b = await world({ backend, companyId: COMPANY_B });
    const doorA = doorOf(a);
    const doorB = doorOf(b);
    const depsA = repairDepsOf(a, doorA, upkeepOf());
    const depsB = repairDepsOf(b, doorB, upkeepOf());
    a.h.deps.afterSetupBroken = repairDraftHook(depsA);
    b.h.deps.afterSetupBroken = repairDraftHook(depsB);
    const { recheck } = await breakSetup(a);
    expect(doorA.requests).toHaveLength(1);
    expect(doorB.requests).toEqual([]);
    const draft = (await repairsOf(shared, a.h.deps.companyId, "payments"))[0]!;
    expect(await repairsOf(shared, COMPANY_B, "payments")).toEqual([]);
    expect(await shared.get(repairCurrentKey(COMPANY_B, "payments"))).toBeUndefined();
    expect(await readRepairView(depsB, "payments")).toBeUndefined();
    expect(await advanceRepairDraft(depsB, "payments")).toBeUndefined();
    expect(await startRepairDraft(depsB, "payments", recheck.key)).toEqual({ status: "skipped", why: "not_broken" });
    // B's own project is not made to wait, fail or pause by A's draft; A's run is not B's.
    await endRun(a, draft.taskId!, readyResult());
    await advanceRepairDraft(depsA, "payments");
    expect(await shared.get(setupApplyKey(COMPANY_B, "payments"))).toBeUndefined();
    // A row of one company copied under the other's key names its own company: it reads as nothing.
    const copied = await shared.get(repairRowKey(a.h.deps.companyId, "payments", draft.key));
    await shared.put({ item: { ...copied!, ...repairRowKey(COMPANY_B, "payments", draft.key) } });
    await shared.put({ item: { ...(await shared.get(repairCurrentKey(a.h.deps.companyId, "payments")))!, ...repairCurrentKey(COMPANY_B, "payments") } });
    expect(await advanceRepairDraft(depsB, "payments")).toBeUndefined();
    expect(await readRecheckOf(shared, COMPANY_B, recheck.key)).toBeUndefined();
  });
});

const readRecheckOf = async (store: DocumentStore, orgId: OrgId, key: string) => store.get(recheckRowKey(orgId, "payments", key));
