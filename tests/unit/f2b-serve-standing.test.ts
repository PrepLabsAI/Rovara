// F2-B: the standing is SERVED, from the one rule, to every surface that shows where a task stands. Two layers:
//   1. the facts the rule takes, now read from what the core stores: a person's own Stop (the mark the stop writes), a prepare that failed, the review round of a custom sequence. The known gap of F2-A ("the real Stop reads Stopped")
//      is closed in `task-standing.test.ts`; here are its edges (a retry leaves it behind, a waiting plan is not stopped, a closed task is closed).
//   2. the surfaces: the web task read (every answer carries `standing` and `statusView`), Slack (the in-process standing and the card's status line), MCP (the task's lines), and the stored session summary the notifications and the
//      lists read, each equal to the rule's own output for the same task; and the answer still parses with what released readers hold.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  DeveloperTaskClientViewSchema, DeveloperTaskStatusSchema, DeveloperTaskViewSchema, OperationStatusSchema, change, TaskStandingReaderSchema, TaskStatusSchema, mergeTrackingDecisionDigest, mergeTrackingKey, WORKFLOW_BLOCK_REASONS, WorkflowSnapshotSchema, taskStatusFromSession, taskStatusText, type JsonValue, type WorkflowProgram, type WorkflowSnapshot,
} from "@agentx/contracts";
import { DEVELOPER_TOOLS } from "../../packages/mcp/src/index.js";
import { computeTaskState } from "../../packages/broker/src/core/sessions/summary.js";
import { createTaskFactsSource } from "../../packages/broker/src/core-host/app/facts.js";
import { performRegistryAction, type ActionCaller, type ActionEnv } from "../../packages/broker/src/core/task-actions/index.js";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import type { TaskFlowDeps } from "../../packages/broker/src/core/task-flow/deps.js";
import { dispatchRowKey, taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { workspaceKeys } from "../../packages/broker/src/core/task-flow/workspace-location.js";
import { workspaceOperations } from "../../packages/broker/src/core/task-flow/reads.js";
import { statusLineOf } from "../../packages/broker/src/core/channel/thread-task-actions.js";
import { reviewRoundOf, standingFactsOf, stateOf, taskStandingFor } from "../../packages/broker/src/core/task-view/index.js";
import { PENDING_PK } from "../../packages/broker/src/core/notify/index.js";
import { createCoreHostApp, type CoreHostApp } from "../../packages/broker/src/core-host/index.js";
import { createCoreDevRoutes, type CompanyMembership, type CoreDevWiring, type DeployedCaller } from "../../packages/broker/src/core-host/dev-routes.js";
import { developerIdOf, taskSessionId } from "../../packages/broker/src/core/sessions/create.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { FAKE_COMPANY, createFakeWorld, type FakeWorld } from "../support/core-host-fakes.js";
import { NOW, TASK_ID, blockedReview, code, plain, report, seed, seedPlain, taskOf, type Seeded } from "../support/task-actions-world.js";
import { orgProjectCatalogKey, projectRevisionKey, type ProjectDefinition } from "@agentx/contracts";

// ---- 1. the facts the rule takes

const ownerRule = (): TaskFlowDeps["access"] => ({
  ...createOwnerTaskAccess(),
  canAct: async (principal: { personId: string }) => principal.personId === "local-owner",
  ownerActing: async (principal: { personId: string }, task: { ownerKey: string }) => (principal.personId === "local-owner" ? { actorId: task.ownerKey } : undefined),
});
const ownerOf = (world: Seeded): ActionCaller => ({ principal: { ...world.h.owner.principal, personId: "local-owner", roles: [] }, companyRole: "member" });
const envOf = (world: Seeded): ActionEnv => ({ deps: world.h.deps, options: {} });
const wf = (extra: Record<string, unknown>): WorkflowSnapshot => WorkflowSnapshotSchema.parse({ ...blockedReview(), blockReason: undefined, ...extra });
const factsOf = async (world: Seeded) => standingFactsOf(world.h.deps, await taskOf(world.h));

describe("the facts F2-B reads from the stored task", () => {
  it("a person's Stop holds while it is the latest move: the step it blocked (one or two revisions on), or the step still running at the revision it stopped at", async () => {
    for (const [name, workflow, revision, expected] of [
      ["blocked one revision on", wf({ stage: "IMPLEMENT", state: "BLOCKED", blockReason: "You stopped this step. Retry to run it again.", revision: 6 }), 5, true],
      ["blocked two revisions on", wf({ stage: "IMPLEMENT", state: "BLOCKED", blockReason: "You stopped this step. Retry to run it again.", revision: 7 }), 5, true],
      ["running at the same revision (nothing was in flight)", wf({ stage: "IMPLEMENT", state: "RUNNING", revision: 5 }), 5, true],
      ["a retry started the work again", wf({ stage: "IMPLEMENT", state: "RUNNING", revision: 7 }), 5, false],
      ["blocked again much later", wf({ stage: "IMPLEMENT", state: "BLOCKED", blockReason: "The fix changed nothing.", revision: 9 }), 5, false],
      ["a plan that waits is not a stopped step", wf({ stage: "PLAN_REVIEW", state: "WAITING", revision: 5 }), 5, false],
    ] as const) {
      const world = await seed({ workflow, access: ownerRule(), task: { personStop: { at: NOW, revision } } });
      expect((await factsOf(world)).stoppedByPerson === true, name).toBe(expected);
    }
  });

  it("no mark is no Stop, and a closed task is closed whatever it was stopped at", async () => {
    const world = await seed({ workflow: wf({ stage: "IMPLEMENT", state: "BLOCKED", revision: 6 }), access: ownerRule() });
    expect((await factsOf(world)).stoppedByPerson).toBeUndefined();
    const closed = await seed({ workflow: wf({ stage: "IMPLEMENT", state: "BLOCKED", revision: 6 }), access: ownerRule(), task: { personStop: { at: NOW, revision: 5 }, closedAt: NOW } });
    expect((await factsOf(closed)).stoppedByPerson).toBeUndefined();
    const served = (await taskStandingFor(envOf(closed), ownerOf(closed), await taskOf(closed.h)))!;
    expect(served.standing.pill.key).toBe("closed");
  });

  it("a task with no workflow stays Stopped until a run begins after the stop, and the real Stop press writes the mark", async () => {
    const world = await seedPlain({ first: "running", access: ownerRule() });
    const before = (await taskStandingFor(envOf(world), ownerOf(world), await taskOf(world.h)))!;
    expect(before.standing.pill.key).toBe("working");
    const press = await performRegistryAction(envOf(world), ownerOf(world), { actionId: "task.stop", taskId: TASK_ID, binding: { revision: 0 }, requestKey: randomUUID(), via: "web" });
    expect(press.status).toBe("done");
    const stopped = await taskOf(world.h);
    expect(typeof stopped.personStop?.at).toBe("string");
    const served = (await taskStandingFor(envOf(world), ownerOf(world), stopped))!;
    expect(served.standing.pill).toMatchObject({ key: "stopped", words: "Stopped" });
    expect(served.statusView.state).toBe("finished_run");
    // A run that begins after the stop reads as work again.
    const later = { ...stopped, personStop: { at: "2026-11-09T08:00:00.000Z" } };
    expect((await standingFactsOf(world.h.deps, later)).stoppedByPerson).toBeUndefined();
  });

  it("a workspace that could not be prepared is Stopped, and the line says so in the status model's words, never Failed as a pill", async () => {
    const world = await seed({ workflow: wf({ stage: "UNDERSTAND", state: "RUNNING", revision: 2 }), access: ownerRule(), workspace: { status: "PREPARATION_FAILED" } });
    expect((await factsOf(world)).failedPrepare).toBe(true);
    const served = (await taskStandingFor(envOf(world), ownerOf(world), await taskOf(world.h)))!;
    expect(served.standing.pill.key).toBe("stopped");
    expect(served.statusView.state).toBe("failed");
    expect(served.standing.pill.words).not.toMatch(/failed|blocked/iu);
  });

  it("the review round of a custom sequence is read from its count: fixing, round 1 of 3, from the coding that follows a review that sent findings back, until the re-review", async () => {
    const program: WorkflowProgram = { steps: [
      { id: "plan", kind: "plan" }, { id: "plan_critic", kind: "plan_critic" }, { id: "build", kind: "build" }, { id: "check", kind: "check" },
      { id: "review", kind: "review", reviewers: ["code", "security"], onFindings: { backTo: "build", maxRounds: 3 } }, { id: "pull_request", kind: "pull_request" },
    ] };
    const fixing = wf({ stage: "IMPLEMENT", state: "RUNNING", revision: 8, program, programStepId: "build", programRounds: { review: 1 } });
    expect(reviewRoundOf(fixing)).toEqual({ round: 1, max: 3 });
    // The checks of the fix are still the fix; the re-review is not.
    expect(reviewRoundOf({ ...fixing, stage: "VERIFY", programStepId: "check" })).toEqual({ round: 1, max: 3 });
    expect(reviewRoundOf({ ...fixing, stage: "REVIEW", programStepId: "review" })).toBeUndefined();
    expect(reviewRoundOf({ ...fixing, programRounds: undefined })).toBeUndefined();
    expect(reviewRoundOf(wf({ stage: "IMPLEMENT", state: "RUNNING", revision: 8 }))).toBeUndefined();
    const world = await seed({ workflow: fixing, access: ownerRule() });
    const served = (await taskStandingFor(envOf(world), ownerOf(world), await taskOf(world.h)))!;
    expect(served.standing.pill).toMatchObject({ key: "fixing", words: "Rovara is fixing it" });
    expect(served.statusView.reason).toBe("Rovara is fixing what the review found (round 1 of 3)");
  });

  it("the session summary of a task a person stopped reads stopped and names nobody who is needed, with the same line the standing serves", () => {
    const facts = { companyId: FAKE_COMPANY, taskId: TASK_ID, project: "payments", ownerDeveloperId: "a".repeat(64), workflow: { stage: "IMPLEMENT", state: "BLOCKED", blockReason: "You stopped this step. Retry to run it again." }, runStatus: "IDLE" as const, stoppedByPerson: true, updatedAt: NOW };
    const { summary } = computeTaskState(facts, 0, undefined, Date.parse(NOW));
    expect(summary.status).toBe("stopped");
    expect(summary.needsPeople).toEqual([]);
    expect(summary.workflowBlocked).toBe(true);
    expect(summary.display).toMatchObject({ state: "finished_run", reason: "it was stopped before it finished" });
    expect(summary.display).toEqual(stateOf({ workflow: { stage: "IMPLEMENT", state: "BLOCKED", path: "QUICK", definitionVersion: "1.1.0", revision: 6, blockReason: "x" }, closed: false, budgetPaused: false, failedPrepare: false, needsPerson: true, planRevisionsUsed: 0, failedChecks: false, stoppedByPerson: true }).status);
  });

  it("the legacy status of a session Stopped by a person is the one the Stopped pill agrees with, not Needs you", () => {
    expect(taskStatusFromSession({ status: "stopped" })).toMatchObject({ state: "finished_run", reason: "it was stopped before it finished" });
    expect(taskStatusFromSession({ status: "stopped" }).state).not.toBe("needs_you");
  });
});

// ---- 2. the surfaces

const PROJECT: ProjectDefinition = {
  name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
};
const SERVICES = () => ({ "merge-tracking": { pass: async () => ({}) }, "session-sweep": { pass: async () => ({}) }, "notify-deliver": { pass: async () => ({}) }, "admission-hold-sweep": { pass: async () => ({}) } });
const WIRED: CoreDevWiring = { origin: () => "https://api.example", scriptTokens: { enabled: () => true }, taskActions: { roundCap: async () => undefined } };
const get = (path: string) => ({ method: "GET", path, headers: {}, body: "" });
const post = (path: string, body: unknown = {}) => ({ method: "POST", path, headers: {}, body: JSON.stringify(body) });

async function hosted() {
  const world: FakeWorld = createFakeWorld();
  await world.store.put({ item: { ...projectRevisionKey(FAKE_COMPANY, PROJECT.name, PROJECT.revision), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(PROJECT)) as JsonValue } });
  await world.store.put({ item: { ...orgProjectCatalogKey(FAKE_COMPANY, PROJECT.name), entityType: "PROJECT_CATALOG", latestRevision: PROJECT.revision } });
  const access: TaskFlowDeps["access"] = {
    ...createOwnerTaskAccess(),
    ownerActing: async (principal, task) => (principal.personId === task.developerId || developerIdOf(principal) === task.developerId ? { actorId: task.ownerKey } : undefined),
  };
  const app: CoreHostApp = createCoreHostApp({
    modules: world.modules, context: () => world.context(), nowMs: () => world.clock.now,
    runtime: () => ({ callbackSigningKey: Buffer.alloc(32, 7), access, repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(world.clock.now), log: () => undefined, services: SERVICES, ciReporting: { honest: true as const, ciMode: () => "their_ci_fix" as const } }),
  });
  const member = new Map<string, CompanyMembership>();
  const companyOf = vi.fn(async (caller: DeployedCaller) => member.get(caller.principal.personId + caller.principal.companyId));
  const own: DeployedCaller = { principal: localOwnerPrincipal({ companyId: FAKE_COMPANY }), client: "web", webApp: true };
  const admin = (displayName: string): DeployedCaller => {
    const caller: DeployedCaller = { ...own, principal: { ...own.principal, personId: "an-admin-person", displayName } };
    member.set(caller.principal.personId + FAKE_COMPANY, { companyId: FAKE_COMPANY, role: "admin" });
    return caller;
  };
  member.set(own.principal.personId + FAKE_COMPANY, { companyId: FAKE_COMPANY, role: "owner" });
  const routes = createCoreDevRoutes({ app, companyOf, wiring: () => WIRED });
  const runtime = await app.runtimeFor(FAKE_COMPANY);
  const { task } = await runtime.flow.start({ principal: own.principal, client: "test", origin: "app" }, { requestId: randomUUID(), project: "payments", instructions: "Add a /health endpoint", workflow: true, workflowPath: "QUICK" });
  const put = async (workflow: WorkflowSnapshot, extra: Record<string, unknown> = {}) => {
    const record = (await world.store.get(taskKey(task.taskId))) as unknown as Record<string, unknown> & { workflow: WorkflowSnapshot };
    const next = WorkflowSnapshotSchema.parse({ ...workflow, taskId: task.taskId, ownerId: record.workflow.ownerId });
    await world.store.put({ item: { ...record, ...extra, workflow: plain(next) as unknown as JsonValue } as never });
  };
  const read = async () => (JSON.parse((await routes.route(get(`/v1/dev/tasks/${task.taskId}`), own))!.body) as { task: Record<string, unknown> }).task;
  const ruleOf = async () => {
    const stored = (await runtime.flow.deps.store.get(taskKey(task.taskId)))!;
    return stateOf(await standingFactsOf(runtime.flow.deps, stored as never));
  };
  return { world, app, routes, own, admin, runtime, taskId: task.taskId, put, read, ruleOf };
}

const PASSING = [report("CRITIC", "PASS", []), report("SECURITY", "PASS", [])];
const pullRequest = (state: "OPEN" | "MERGED") => ({ repositoryId: "demo", number: 7, url: "https://example.com/pull/7", required: true, state, candidateDigest: code.digest, headSha: "b".repeat(40) });
const merging = (): WorkflowSnapshot => WorkflowSnapshotSchema.parse({ ...blockedReview({}, PASSING), stage: "WAIT_FOR_MERGE", state: "WAITING", blockReason: undefined, pullRequests: [pullRequest("OPEN")] });
const merged = (): WorkflowSnapshot => WorkflowSnapshotSchema.parse({ ...blockedReview({}, PASSING), stage: "MERGED", state: "COMPLETE", outcome: "MERGED", blockReason: undefined, revision: 9, pullRequests: [pullRequest("MERGED")] });
const STATES: Array<[string, () => WorkflowSnapshot, Record<string, unknown>?]> = [
  ["a plan is written", () => wf({ stage: "PLAN", state: "RUNNING", revision: 3 })],
  ["the code is built", () => wf({ stage: "IMPLEMENT", state: "RUNNING", revision: 4 })],
  ["a CI fix round runs", () => wf({ stage: "IMPLEMENT", state: "RUNNING", revision: 4, fixSource: "ci", fixRounds: { ci: 1, conflict: 0, feedbackAuto: 0 } })],
  ["the checks run", () => wf({ stage: "VERIFY", state: "RUNNING", revision: 5 })],
  ["the reviews found problems", () => blockedReview()],
  ["the budget paused a step", () => wf({ stage: "REVIEW", state: "BLOCKED", revision: 6, blockReason: WORKFLOW_BLOCK_REASONS.budgetPaused })],
  ["a pull request waits", merging],
  ["a person stopped the step", () => wf({ stage: "IMPLEMENT", state: "BLOCKED", revision: 6, blockReason: "You stopped this step. Retry to run it again." }), { personStop: { at: NOW, revision: 5 } }],
  ["merged", merged],
];

describe("the web task read serves the standing, and every surface reads the same rule", () => {
  for (const [name, workflow, extra] of STATES) {
    it(`${name}: the web read, Slack, MCP and the stored summary equal the rule's own output`, async () => {
      const world = await hosted();
      await world.put(workflow(), extra);
      const rule = await world.ruleOf();
      const task = await world.read();

      // web: `statusView` is the rule's person-free status, `standing` its phase, step, strip and pill for this reader
      expect(task["statusView"]).toEqual(rule.status);
      const standing = TaskStandingReaderSchema.parse(task["standing"]);
      expect(standing.step).toEqual(rule.step === undefined ? undefined : { ...rule.step });
      expect(standing.steps).toEqual(rule.steps);
      expect(standing.phase).toEqual(rule.phase);
      expect(standing.pill.key).toBe(rule.pill === "decision" ? "needs_you" : rule.pill);
      expect(standing.actions.map((offer) => offer.id).sort()).toEqual(((await world.routes.taskActions(world.own, world.taskId)) ?? []).map((offer) => offer.id).sort());

      // Slack: the in-process standing is the web's, the offers are the standing's own `actions`, and the card's status line is the rule's words
      const slack = (await world.routes.taskStanding(world.own, world.taskId))!;
      expect(slack.statusView).toEqual(task["statusView"]);
      expect(JSON.parse(JSON.stringify(slack.standing))).toEqual(task["standing"]);
      expect(await world.routes.taskActions(world.own, world.taskId)).toEqual(slack.standing.actions);
      const stored = (await world.runtime.flow.deps.store.get(taskKey(world.taskId)))!;
      expect(await statusLineOf({ store: world.runtime.flow.deps.store, companyId: FAKE_COMPANY }, stored as never)).toBe(rule.status.state === "needs_you" ? undefined : taskStatusText(rule.status));

      // MCP: the lines of agentx_get_task are the served status and pill
      const mcp = DEVELOPER_TOOLS.find((entry) => entry.name === "agentx_get_task")!;
      const client = { getTask: vi.fn(async () => DeveloperTaskClientViewSchema.parse(task)) };
      const shown = await mcp.handler({ client } as never, { task_id: world.taskId }, {} as never);
      expect(shown.structured["status_text"]).toBe(taskStatusText(rule.status));
      expect(shown.structured["pill"]).toBe(standing.pill.words);
      expect(shown.structured["current_step"]).toBe(rule.step?.title);
      // the status words are not said twice: the next step never opens with the words `status_text` already holds
      const next = shown.structured["next_step"];
      if (typeof next === "string") expect(next.startsWith(`${taskStatusText(rule.status)}:`)).toBe(false);

      // the stored session summary (notifications, lists): the same status state
      const read = await createTaskFactsSource(world.runtime.flow.deps).read(FAKE_COMPANY, world.taskId);
      const display = TaskStatusSchema.parse(read?.display ?? rule.status);
      expect(display.state).toBe(rule.status.state);
    });
  }

  const track = async (world: Awaited<ReturnType<typeof hosted>>, overrides: Record<string, unknown> = {}) => {
    const fields = {
      orgId: FAKE_COMPANY, taskId: world.taskId, repositoryId: "demo", number: 7, headSha: "b".repeat(40), draft: false, state: "open" as const, baseBranch: "main", ci: "passing" as const, ciBasis: "all_checks" as const, checksEverSeen: true,
      failingChecks: [] as string[], review: "approved" as const, branch: "up_to_date" as const, headByRovara: true, nudges: { count: 0 }, syncs: { day: "2026-11-09", count: 0 }, ...overrides,
    };
    const item = { ...fields, version: 1, decisionDigest: mergeTrackingDecisionDigest(fields), observedAt: NOW };
    await world.world.store.put({ item: JSON.parse(JSON.stringify({ ...mergeTrackingKey(world.taskId, "demo", 7), entityType: "MERGE_TRACKING", ...item })) as never });
  };

  it("B2: a pull request whose checks are pending or failing is never served as Ready to merge (web, MCP, Slack heading, stored summary), and is once it is ready", async () => {
    const world = await hosted();
    await world.put(merging());
    const mcp = DEVELOPER_TOOLS.find((entry) => entry.name === "agentx_get_task")!;
    const lineOf = async () => {
      const task = await world.read();
      const shown = await mcp.handler({ client: { getTask: async () => DeveloperTaskClientViewSchema.parse(task) } } as never, { task_id: world.taskId }, {} as never);
      const stored = (await world.runtime.flow.deps.store.get(taskKey(world.taskId)))!;
      const summary = await createTaskFactsSource(world.runtime.flow.deps).read(FAKE_COMPANY, world.taskId);
      return { web: (task["statusView"] as { state: string }).state, mcp: shown.structured["status_text"], slack: await statusLineOf({ store: world.runtime.flow.deps.store, companyId: FAKE_COMPANY }, stored as never), summary: summary?.display?.state };
    };
    expect(await lineOf()).toEqual({ web: "checking", mcp: "Checking", slack: "Checking", summary: "checking" });
    await track(world, { ci: "pending" });
    expect(await lineOf()).toEqual({ web: "checking", mcp: "Checking", slack: "Checking", summary: "checking" });
    await track(world, { ci: "failing", failingChecks: ["unit"] });
    expect(await lineOf()).toEqual({ web: "checking", mcp: "Checking", slack: "Checking", summary: "checking" });
    await track(world);
    expect(await lineOf()).toEqual({ web: "ready_to_merge", mcp: "Ready to merge", slack: "Ready to merge", summary: "ready_to_merge" });
  });

  it("a pull request that waits reads In review with its Ready to merge line said once", async () => {
    const world = await hosted();
    await world.put(merging());
    await track(world);
    const task = await world.read();
    expect((task["standing"] as { pill: { words: string } }).pill.words).toBe("In review");
    const mcp = DEVELOPER_TOOLS.find((entry) => entry.name === "agentx_get_task")!;
    const shown = await mcp.handler({ client: { getTask: async () => DeveloperTaskClientViewSchema.parse(task) } } as never, { task_id: world.taskId }, {} as never);
    expect(shown.structured["status_text"]).toBe("Ready to merge");
    expect(shown.structured["next_step"]).toBe("Review the pull request and merge it.");
  });

  it("the real Stop through the web route is answered Stopped, with the status model's words and the work kept", async () => {
    const world = await hosted();
    const answer = await world.routes.route(post(`/v1/dev/tasks/${world.taskId}/cancel`, { requestId: randomUUID() }), world.own);
    expect(answer?.statusCode, answer?.body).toBe(200);
    const task = (JSON.parse(answer!.body) as { task: { standing: { pill: { key: string; words: string } }; statusView: { state: string } } }).task;
    expect(task.standing.pill).toMatchObject({ key: "stopped", words: "Stopped" });
    expect(task.statusView.state).toBe("finished_run");
  });

  it("every task answer carries the standing: the read, and the answer of each press", async () => {
    const world = await hosted();
    const read = await world.read();
    expect(read["standing"]).toBeDefined();
    const stopped = JSON.parse((await world.routes.route(post(`/v1/dev/tasks/${world.taskId}/cancel`, { requestId: randomUUID() }), world.own))!.body) as { task: Record<string, unknown> };
    expect(stopped.task["standing"]).toBeDefined();
    expect(stopped.task["statusView"]).toBeDefined();
  });

  it("the answer still parses with what released readers hold: the strict status, a schema with no `standing`, and a standing a newer Code extended", async () => {
    const world = await hosted();
    await world.put(blockedReview());
    const task = await world.read();
    // released readers: statusView is the strict stored schema; a reader that does not know `standing` drops it
    expect(TaskStatusSchema.safeParse(task["statusView"]).success).toBe(true);
    const released = DeveloperTaskViewSchema.omit({ standing: true }).safeParse(task);
    expect(released.success, JSON.stringify(released)).toBe(true);
    expect(released.success && "standing" in released.data).toBe(false);
    // this reader: an action it does not know is skipped, an unknown key passes, and a standing that cannot be read at all never fails the answer
    const newer = { ...task, standing: { ...(task["standing"] as object), pill: { ...(task["standing"] as { pill: object }).pill, key: "from_a_newer_code" }, tomorrow: 1, actions: [...((task["standing"] as { actions: unknown[] }).actions), { id: "task.teleport", label: "Teleport", risk: "routine", needsDialog: false, binding: { revision: 1 } }] } };
    const parsed = DeveloperTaskViewSchema.parse(newer);
    expect(parsed.standing?.pill.key).toBe("from_a_newer_code");
    expect(parsed.standing?.actions.some((offer) => offer.id === "task.teleport")).toBe(false);
    expect(DeveloperTaskViewSchema.parse({ ...task, standing: "garbage" }).standing).toBeUndefined();
  });

  it("each reader sees their own pill: the owner is asked, a colleague who may read is told whose it is", async () => {
    const world = await hosted();
    await world.put(blockedReview());
    const owner = (await world.read())["standing"] as { pill: { key: string } };
    expect(owner.pill.key).toBe("needs_you");
    const stored = (await world.runtime.flow.deps.store.get(taskKey(world.taskId)))!;
    const colleague = { principal: { ...world.own.principal, personId: "a-colleague" }, companyRole: "member" as const };
    const served = await taskStandingFor({ deps: world.runtime.flow.deps, options: {} }, colleague, stored as never);
    // no reader rule for a colleague on this install: no standing at all, never somebody else's pill
    expect(served === undefined || served.standing.pill.key !== "needs_you").toBe(true);
  });
});

// ---- REQUIRED case (arch ruling 2026-11-25): a blocked review says WHY a person is needed, and offers the registry's moves

describe("a blocked review reads Needs you with a reason that tells the two apart, and offers the registry's moves", () => {
  const unreadable = () => blockedReview({}, [report("CRITIC", "FAILED", []), report("SECURITY", "PASS", [])]);

  it("the review could not finish: Needs you, its own reason, retry the review and send back are offered", async () => {
    const world = await hosted();
    await world.put(unreadable());
    const task = await world.read();
    const standing = TaskStandingReaderSchema.parse(task["standing"]);
    expect(standing.pill).toMatchObject({ key: "needs_you", words: "Needs you" });
    expect(task["statusView"]).toMatchObject({ state: "needs_you", reason: "the review could not finish" });
    const ids = standing.actions.map((offer) => offer.id);
    // The moves are the registry's: retrying the review is offered; send back follows the engine's own rule (it needs findings or failed checks to send back), and Stop needs a running step, so neither is offered for a review that did not finish.
    expect(ids).toContain("task.review");
    expect(ids).not.toContain("findings.resolve");
    expect(taskStatusText(task["statusView"] as never)).toBe("Needs you: the review could not finish");
  });

  it("the review found problems: Needs you, a different reason, accept-or-fix and send back are offered", async () => {
    const world = await hosted();
    await world.put(blockedReview());
    const task = await world.read();
    const standing = TaskStandingReaderSchema.parse(task["standing"]);
    expect(standing.pill.key).toBe("needs_you");
    expect(task["statusView"]).toMatchObject({ state: "needs_you", reason: "the review found problems with the change" });
    const ids = standing.actions.map((offer) => offer.id);
    expect(ids).toContain("findings.resolve");
    expect(ids).toContain("work.send-back");
  });

  it("the reviews could not start: Needs you in fixed plain words (never the raw cause), with the registry's retry offered", async () => {
    const world = await hosted();
    await world.put(blockedReview({ blockReason: WORKFLOW_BLOCK_REASONS.reviewsCouldNotStart }, [report("CRITIC", "FAILED", []), report("SECURITY", "PASS", [])]));
    const task = await world.read();
    const standing = TaskStandingReaderSchema.parse(task["standing"]);
    expect(standing.pill).toMatchObject({ key: "needs_you", words: "Needs you" });
    expect(task["statusView"]).toMatchObject({ state: "needs_you", reason: "Rovara could not start the reviews", next: "Press Retry." });
    expect(standing.actions.map((offer) => offer.id)).toContain("task.review");
    expect((await createTaskFactsSource(world.runtime.flow.deps).read(FAKE_COMPANY, world.taskId))?.display).toMatchObject({ reason: "Rovara could not start the reviews" });
    expect(JSON.stringify(task["standing"])).not.toMatch(/Dynamo|Exception|transaction/u);
  });

  it("while the sweep is still retrying the start of the reviews the task is Waiting, not stuck and not asking anyone; only the last attempt makes it Needs you", async () => {
    const world = await hosted();
    const reviewing = wf({ stage: "REVIEW", state: "WAITING", revision: 6 });
    await world.put(reviewing);
    const row = (attempts: number) => world.world.store.put({ item: { ...dispatchRowKey(FAKE_COMPANY, world.taskId, 6), entityType: "WORKFLOW_DISPATCH", companyId: FAKE_COMPANY, taskId: world.taskId, workflowRevision: 6, kind: "REVIEW", attempts } });
    for (const attempts of [1, 4, 7]) {
      await row(attempts);
      const task = await world.read();
      expect((task["standing"] as { pill: { key: string; words: string } }).pill).toMatchObject({ key: "waiting", words: "Waiting" });
      expect(task["statusView"]).toMatchObject({ reason: "Starting the reviews, trying again" });
      expect((task["statusView"] as { state: string }).state).not.toBe("needs_you");
      expect((await createTaskFactsSource(world.runtime.flow.deps).read(FAKE_COMPANY, world.taskId))?.display?.state).not.toBe("needs_you");
    }
    // the last attempt failed: the row is gone and the step is blocked with the fixed words
    await world.world.store.delete({ key: dispatchRowKey(FAKE_COMPANY, world.taskId, 6) });
    await world.put(blockedReview({ blockReason: WORKFLOW_BLOCK_REASONS.reviewsCouldNotStart, revision: 7 }, [report("CRITIC", "FAILED", []), report("SECURITY", "PASS", [])]));
    const task = await world.read();
    expect((task["standing"] as { pill: { key: string } }).pill.key).toBe("needs_you");
    expect(task["statusView"]).toMatchObject({ state: "needs_you", reason: "Rovara could not start the reviews", next: "Press Retry." });
    expect(WORKFLOW_BLOCK_REASONS.reviewsCouldNotStart).toBe("Rovara could not start the reviews. Press Retry.");
  });

  it("the stored summary the notifications read says the same two reasons, and a colleague is told whose it is", async () => {
    const world = await hosted();
    await world.put(unreadable());
    expect((await createTaskFactsSource(world.runtime.flow.deps).read(FAKE_COMPANY, world.taskId))?.display).toMatchObject({ state: "needs_you", reason: "the review could not finish" });
    await world.put(blockedReview());
    expect((await createTaskFactsSource(world.runtime.flow.deps).read(FAKE_COMPANY, world.taskId))?.display).toMatchObject({ state: "needs_you", reason: "the review found problems with the change" });
  });
});

// ---- an admin's stop tells the owner once; the owner's own stop tells nobody

describe("a company admin who is not the owner stops the owner's task", () => {
  const pendingRows = async (world: Awaited<ReturnType<typeof hosted>>) => (await world.world.store.query({ pk: PENDING_PK })).items.filter((row) => row["kind"] === "stopped_by_admin");

  it("writes ONE notice for the owner with the admin's name, none for the owner's own stop, and the task reads Stopped, never Needs you", async () => {
    const own = await hosted();
    await own.put(wf({ stage: "IMPLEMENT", state: "RUNNING", revision: 4 }), { sessionId: taskSessionId(own.taskId) });
    expect((await own.routes.route(post(`/v1/dev/tasks/${own.taskId}/cancel`, { requestId: randomUUID() }), own.own))?.statusCode).toBe(200);
    expect(await pendingRows(own)).toHaveLength(0);

    const world = await hosted();
    await world.put(wf({ stage: "IMPLEMENT", state: "RUNNING", revision: 4 }), { sessionId: taskSessionId(world.taskId) });
    const admin = world.admin("Alex Admin");
    const requestId = randomUUID();
    const answer = await world.routes.route(post(`/v1/dev/tasks/${world.taskId}/cancel`, { requestId }), admin);
    expect(answer?.statusCode, answer?.body).toBe(200);
    const task = (JSON.parse(answer!.body) as { task: { standing: { pill: { key: string } }; statusView: { state: string } } }).task;
    expect(task.standing.pill.key).toBe("stopped");
    expect(task.statusView.state).not.toBe("needs_you");
    const rows = await pendingRows(world);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "stopped_by_admin", stoppedBy: "Alex Admin", developerId: developerIdOf(world.own.principal) });
    // the same request again is one stop, so still one notice
    await world.routes.route(post(`/v1/dev/tasks/${world.taskId}/cancel`, { requestId }), admin);
    expect(await pendingRows(world)).toHaveLength(1);
  });
});

// ---- the standing never says what the worker's operation says

describe("the standing is the task's, never an operation's", () => {
  it("no value of the operation or task status enums appears in `standing` or `statusView`, and the standing does not depend on them", async () => {
    const world = await hosted();
    const states: Array<[string, WorkflowSnapshot]> = [["blocked review", blockedReview()], ["building", wf({ stage: "IMPLEMENT", state: "RUNNING", revision: 4 })], ["a pull request waits", merging()], ["merged", merged()]];
    const words = [...new Set([...OperationStatusSchema.options, ...DeveloperTaskStatusSchema.options])];
    expect(words.length).toBeGreaterThanOrEqual(8);
    for (const [name, workflow] of states) {
      await world.put(workflow);
      const workspaceId = (await world.world.store.get(taskKey(world.taskId)))!["workspaceId"] as string;
      const location = await workspaceKeys({ store: world.world.store, companyId: FAKE_COMPANY }, workspaceId);
      const operations = await workspaceOperations({ store: world.world.store, companyId: FAKE_COMPANY }, workspaceId);
      expect(operations.length, name).toBeGreaterThan(0);
      let first: string | undefined;
      for (const status of words) {
        for (const operation of operations) await world.world.store.update({ key: location.operationKey(operation.id), ops: [change.set("status", status)] });
        const task = await world.read();
        const served = JSON.stringify({ standing: task["standing"], statusView: task["statusView"] });
        for (const word of words) expect(served, `${name} with the operation ${status}: ${word}`).not.toContain(word);
        first ??= served;
        expect(served, `${name}: the standing does not move with the operation status ${status}`).toBe(first);
      }
    }
  });
});
