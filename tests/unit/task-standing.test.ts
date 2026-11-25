// F2-A (A2): the standing of a task for one person. Three layers, each tested on its own:
//   1. `stateOf`, the person-free rule, as a decision table (stage x state x facts): phase, step, the strip, the pill when no person is looking, the status line. Every engine stage and state maps to the mock's words; MERGED and CLOSED
//      are `Merged` and `Closed`; a blocked step is a decision (a person may retry) or Stopped (nobody can) and never "Blocked"; a round the facts do not name is `working`.
//   2. `taskStandingFor`, which adds the reader: the rule per persona (owner, co-owner, live company admin, colleague, stranger, removed admin), the pill each sees, who it waits on, and S1's own offers as `actions` (one field). Merge
//      tracking is read from the store.
//   3. the served shape's tolerant reader: an action id this build does not know is skipped, never a failure; and standing is reachable from no stored schema.
import { describe, expect, it } from "vitest";
import {
  AgentSessionRecordSchema, OWNER_LEFT_PROJECT_WORDS, SessionSummarySchema, TASK_ACTION_IDS, TaskStandingReaderSchema, TaskStatusSchema, WorkflowSnapshotSchema, WORKFLOW_BLOCK_REASONS, createWorkflowSnapshot, mergeTrackingDecisionDigest, mergeTrackingKey, readLooseOffers,
  type TaskStandingMembers,
} from "@agentx/contracts";
import { z } from "zod";
import { actionsFor, performRegistryAction, type ActionCaller, type ActionEnv, type MergeHost, type PlanHost } from "../../packages/broker/src/core/task-actions/index.js";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { stateOf, taskStandingFor, type StandingFacts, type StandingWorkflow } from "../../packages/broker/src/core/task-view/index.js";
import { OWNER_KEY, NOW, PARSER, TASK_ID, TOKEN, blockedReview, code, report, seed, taskOf, type Seeded } from "../support/task-actions-world.js";

// ---- 1. the person-free rule

type Strip = Array<[string, string]>;
const wf = (stage: string, state: string, extra: Record<string, unknown> = {}): StandingWorkflow => ({ stage, state, path: "QUICK", definitionVersion: "1.1.0", revision: 5, ...extra }) as StandingWorkflow;
const base: Omit<StandingFacts, "workflow"> = { closed: false, budgetPaused: false, failedPrepare: false, needsPerson: false, planRevisionsUsed: 0, failedChecks: false };
const CRITIQUE = { status: "done" } as never;
const QUICK_KEYS = ["understand", "spec3", "approve_spec", "build", "tests", "review", "pull_request"];
const quick = (...states: string[]): Strip => QUICK_KEYS.map((key, index) => [key, states[index]!]);

interface Row { name: string; facts: Partial<StandingFacts>; pill: string; state?: string; reason?: string; phase?: string; step?: [string, string]; strip?: Strip; noSteps?: true }
const ROWS: Row[] = [
  { name: "understand runs", facts: { workflow: wf("UNDERSTAND", "RUNNING") }, pill: "working", state: "understanding", phase: "prepare", step: ["understand", "doing"], strip: quick("doing", "todo", "todo", "todo", "todo", "todo", "todo") },
  { name: "understand asks questions", facts: { workflow: wf("UNDERSTAND", "WAITING"), needsPerson: true }, pill: "decision", state: "needs_you", phase: "prepare", step: ["understand", "needs"] },
  { name: "quick plan runs (one pass)", facts: { workflow: wf("PLAN", "RUNNING") }, pill: "working", state: "planning", phase: "spec", step: ["spec3", "doing"], strip: quick("done", "doing", "todo", "todo", "todo", "todo", "todo") },
  { name: "full plan, requirements", facts: { workflow: wf("PLAN", "RUNNING", { path: "FULL", reviewPhase: "REQUIREMENTS" }) }, pill: "working", step: ["spec1", "doing"],
    strip: [["understand", "done"], ["spec1", "doing"], ["spec2", "todo"], ["spec3", "todo"], ["approve_spec", "todo"], ["build", "todo"], ["tests", "todo"], ["review", "todo"], ["pull_request", "todo"]] },
  { name: "full plan, design", facts: { workflow: wf("PLAN", "RUNNING", { path: "FULL", reviewPhase: "DESIGN" }) }, pill: "working", step: ["spec2", "doing"], strip: [["understand", "done"], ["spec1", "done"], ["spec2", "doing"], ["spec3", "todo"], ["approve_spec", "todo"], ["build", "todo"], ["tests", "todo"], ["review", "todo"], ["pull_request", "todo"]] },
  { name: "full plan, coding plan after a design review", facts: { workflow: wf("PLAN", "RUNNING", { path: "FULL", reviewPhase: "IMPLEMENTATION_PLAN", critique: CRITIQUE }) }, pill: "working", step: ["spec3", "doing"],
    strip: [["understand", "done"], ["spec1", "done"], ["spec2", "done"], ["design", "done"], ["spec3", "doing"], ["approve_spec", "todo"], ["build", "todo"], ["tests", "todo"], ["review", "todo"], ["pull_request", "todo"]] },
  { name: "plan asked again for a fuller plan", facts: { workflow: wf("PLAN", "RUNNING"), planRevisionsUsed: 1 }, pill: "working", state: "planning", reason: "Rovara is asking for a fuller plan" },
  { name: "plan, no revision spent: no reason", facts: { workflow: wf("PLAN", "RUNNING"), planRevisionsUsed: 0 }, pill: "working", state: "planning" },
  { name: "design review runs (full)", facts: { workflow: wf("PLAN_CRITIQUE", "RUNNING", { path: "FULL", reviewPhase: "DESIGN" }) }, pill: "working", state: "planning", phase: "spec", step: ["design", "doing"] },
  { name: "design review on Quick is the lighter one", facts: { workflow: wf("PLAN_CRITIQUE", "RUNNING") }, pill: "working", step: ["design", "doing"] },
  { name: "spec approval, requirements layer (full)", facts: { workflow: wf("PLAN_REVIEW", "WAITING", { path: "FULL", reviewPhase: "REQUIREMENTS" }), needsPerson: true }, pill: "decision", state: "needs_you", phase: "spec", step: ["approve_spec", "needs"],
    strip: [["understand", "done"], ["spec1", "done"], ["spec2", "todo"], ["spec3", "todo"], ["approve_spec", "needs"], ["build", "todo"], ["tests", "todo"], ["review", "todo"], ["pull_request", "todo"]] },
  { name: "spec approval, design layer (full) with its review done", facts: { workflow: wf("PLAN_REVIEW", "WAITING", { path: "FULL", reviewPhase: "DESIGN", critique: CRITIQUE }), needsPerson: true }, pill: "decision", step: ["approve_spec", "needs"],
    strip: [["understand", "done"], ["spec1", "done"], ["spec2", "done"], ["design", "done"], ["spec3", "todo"], ["approve_spec", "needs"], ["build", "todo"], ["tests", "todo"], ["review", "todo"], ["pull_request", "todo"]] },
  { name: "spec approval on Quick", facts: { workflow: wf("PLAN_REVIEW", "WAITING"), needsPerson: true }, pill: "decision", step: ["approve_spec", "needs"], strip: quick("done", "done", "needs", "todo", "todo", "todo", "todo") },
  { name: "build runs", facts: { workflow: wf("IMPLEMENT", "RUNNING") }, pill: "working", state: "building", phase: "build", step: ["build", "doing"], strip: quick("done", "done", "done", "doing", "todo", "todo", "todo") },
  { name: "build is queued", facts: { workflow: wf("IMPLEMENT", "READY") }, pill: "working", step: ["build", "doing"] },
  { name: "a CI fix round, round 2 of 3", facts: { workflow: wf("IMPLEMENT", "RUNNING", { fixSource: "ci", fixRounds: { ci: 2, conflict: 0, feedbackAuto: 0 } }) }, pill: "fixing", state: "building", reason: "Rovara is fixing the failing checks (round 2 of 3)" },
  { name: "a conflict fix round, round 1 of 2", facts: { workflow: wf("IMPLEMENT", "RUNNING", { fixSource: "conflict", fixRounds: { ci: 0, conflict: 1, feedbackAuto: 0 } }) }, pill: "fixing", reason: "Rovara is resolving a conflict with the base branch (round 1 of 2)" },
  { name: "a feedback fix the owner chose (no automatic round counted)", facts: { workflow: wf("IMPLEMENT", "RUNNING", { fixSource: "feedback" }) }, pill: "fixing", reason: "Rovara is fixing the review comments" },
  { name: "an automatic feedback round, round 2 of 3", facts: { workflow: wf("IMPLEMENT", "RUNNING", { fixSource: "feedback", fixRounds: { ci: 0, conflict: 0, feedbackAuto: 2 } }) }, pill: "fixing", reason: "Rovara is fixing the review comments (round 2 of 3)" },
  { name: "a fix round's later step is still fixing (verify)", facts: { workflow: wf("VERIFY", "RUNNING", { fixSource: "ci", fixRounds: { ci: 1, conflict: 0, feedbackAuto: 0 } }) }, pill: "fixing", phase: "verify", step: ["tests", "doing"] },
  { name: "a review round whose problems are fixed (round 1 of 2)", facts: { workflow: wf("IMPLEMENT", "RUNNING"), reviewRound: { round: 1, max: 2 } }, pill: "fixing", reason: "Rovara is fixing what the review found (round 1 of 2)" },
  { name: "a review round shown at the plan is nothing (not a fix stage)", facts: { workflow: wf("PLAN", "RUNNING"), reviewRound: { round: 1, max: 2 } }, pill: "working" },
  { name: "a fix stopped (blocked) is a decision, not fixing", facts: { workflow: wf("IMPLEMENT", "BLOCKED", { fixSource: "ci", blockReason: "The fix changed nothing." }) }, pill: "decision", state: "needs_you", step: ["build", "needs"] },
  { name: "checks run", facts: { workflow: wf("VERIFY", "RUNNING") }, pill: "working", state: "checking", phase: "verify", step: ["tests", "doing"], strip: quick("done", "done", "done", "done", "doing", "todo", "todo") },
  { name: "checks failed on the current code", facts: { workflow: wf("VERIFY", "BLOCKED", { blockReason: "A check failed." }), failedChecks: true }, pill: "decision", state: "needs_you", step: ["tests", "failed"] },
  { name: "checks stopped for another reason", facts: { workflow: wf("VERIFY", "BLOCKED", { blockReason: "The checks could not run." }) }, pill: "decision", step: ["tests", "needs"] },
  { name: "reviews run", facts: { workflow: wf("REVIEW", "RUNNING") }, pill: "working", state: "checking", phase: "verify", step: ["review", "doing"], strip: quick("done", "done", "done", "done", "done", "doing", "todo") },
  { name: "review findings wait for a person", facts: { workflow: wf("REVIEW", "WAITING"), needsPerson: true }, pill: "decision", step: ["review", "needs"] },
  { name: "review blocked on the budget pause: nobody's retry lifts it", facts: { workflow: wf("REVIEW", "BLOCKED", { blockReason: WORKFLOW_BLOCK_REASONS.budgetPaused }) }, pill: "stopped", state: "paused_budget", step: ["review", "stopped"] },
  { name: "review blocked on a run limit waiting for approval", facts: { workflow: wf("REVIEW", "BLOCKED", { blockReason: "Waiting for a project maintainer to accept the $12 run limit." }) }, pill: "stopped", state: "paused_budget", step: ["review", "stopped"] },
  { name: "the pull request opens", facts: { workflow: wf("PULL_REQUEST", "RUNNING") }, pill: "working", state: "checking", phase: "deliver", step: ["pull_request", "doing"], strip: quick("done", "done", "done", "done", "done", "done", "doing") },
  { name: "a pull request waits: In review, the step is done", facts: { workflow: wf("WAIT_FOR_MERGE", "WAITING") }, pill: "in_review", state: "ready_to_merge", phase: "deliver", step: ["pull_request", "done"], strip: quick("done", "done", "done", "done", "done", "done", "done") },
  { name: "the base branch is being merged in: still In review", facts: { workflow: wf("WAIT_FOR_MERGE", "RUNNING") }, pill: "in_review", step: ["pull_request", "done"] },
  { name: "a feedback card waits: Needs you, not In review", facts: { workflow: wf("WAIT_FOR_MERGE", "WAITING"), needsPerson: true }, pill: "decision", step: ["pull_request", "needs"] },
  { name: "the push of a fix failed", facts: { workflow: wf("WAIT_FOR_MERGE", "BLOCKED", { blockReason: "The push failed." }) }, pill: "decision", step: ["pull_request", "needs"] },
  { name: "checks failing on the open pull request: the Verify step failed, the pill stays In review", facts: { workflow: wf("WAIT_FOR_MERGE", "WAITING"), failedChecks: true }, pill: "in_review", strip: quick("done", "done", "done", "done", "failed", "done", "done") },
  { name: "merged", facts: { workflow: wf("MERGED", "COMPLETE", { outcome: "MERGED" }) }, pill: "merged", state: "merged", strip: quick("done", "done", "done", "done", "done", "done", "done") },
  { name: "merged, though the task is marked closed too", facts: { workflow: wf("MERGED", "COMPLETE"), closed: true }, pill: "merged", state: "merged" },
  { name: "closed by its owner", facts: { workflow: wf("IMPLEMENT", "RUNNING"), closed: true }, pill: "closed", state: "closed", noSteps: true },
  { name: "the workflow's own closed stage", facts: { workflow: wf("CLOSED", "COMPLETE", { outcome: "CLOSED" }) }, pill: "closed", state: "closed", noSteps: true },
  { name: "answered with no code change", facts: { workflow: wf("PLAN_REVIEW", "COMPLETE", { outcome: "ANSWERED" }) }, pill: "closed", state: "closed", reason: "Answered: no code change was needed", noSteps: true },
  { name: "the repository could not be prepared: Stopped, never Failed", facts: { workflow: wf("UNDERSTAND", "RUNNING"), failedPrepare: true }, pill: "stopped", state: "failed", reason: "the repository could not be prepared for the task" },
  { name: "the budget pauses the task", facts: { workflow: wf("IMPLEMENT", "RUNNING"), budgetPaused: true }, pill: "stopped", state: "paused_budget", step: ["build", "stopped"] },
  { name: "a person stopped it (the fact supplied): Stopped, the work is kept", facts: { workflow: wf("IMPLEMENT", "BLOCKED", { blockReason: "stopped" }), stoppedByPerson: true }, pill: "stopped", state: "finished_run", reason: "it was stopped before it finished", step: ["build", "stopped"] },
  { name: "a person stopped a running step (the fact supplied)", facts: { workflow: wf("VERIFY", "RUNNING"), stoppedByPerson: true }, pill: "stopped", step: ["tests", "stopped"] },
  { name: "a stop never hides a merge", facts: { workflow: wf("MERGED", "COMPLETE"), stoppedByPerson: true }, pill: "merged", state: "merged" },
  { name: "a stop never hides a close", facts: { workflow: wf("IMPLEMENT", "BLOCKED"), closed: true, stoppedByPerson: true }, pill: "closed", noSteps: true },
  { name: "the Slack access check is down at this revision", facts: { workflow: wf("IMPLEMENT", "READY", { accessCheckWaitSince: { revision: 5, since: NOW } }) }, pill: "waiting", reason: "Rovara is waiting for Slack to answer the access check" },
  { name: "a note from an earlier revision is no wait", facts: { workflow: wf("IMPLEMENT", "READY", { accessCheckWaitSince: { revision: 4, since: NOW } }) }, pill: "working" },
  { name: "no machine is free: one Waiting pill, the reason says why", facts: { workflow: wf("IMPLEMENT", "READY"), wait: "no_machine" }, pill: "waiting", reason: "No machine is free; Rovara will try again" },
  { name: "the AI provider limits requests", facts: { workflow: wf("IMPLEMENT", "READY"), wait: "rate_limit" }, pill: "waiting", reason: "The AI provider is limiting requests; Rovara will try again" },
  { name: "the daily allowance is used up", facts: { workflow: wf("IMPLEMENT", "READY"), wait: "allowance" }, pill: "waiting", reason: "The daily allowance is used up; the work goes on when it resets" },
  { name: "a spending stop beats a wait", facts: { workflow: wf("IMPLEMENT", "READY"), wait: "no_machine", budgetPaused: true }, pill: "stopped" },
  { name: "a task with no workflow is working (never a guess)", facts: {}, pill: "working", noSteps: true },
  { name: "the first definition has no Understand step", facts: { workflow: wf("IMPLEMENT", "RUNNING", { definitionVersion: "1.0.0" }) }, pill: "working", strip: QUICK_KEYS.slice(1).map((key) => [key, key === "build" ? "doing" : ["spec3", "approve_spec"].includes(key) ? "done" : "todo"] as [string, string]) },
];

describe("stateOf: the person-free rule", () => {
  it("has about forty rows, and every engine stage appears in one", () => {
    expect(ROWS.length).toBeGreaterThanOrEqual(40);
    const stages = new Set<string | undefined>(ROWS.map((row) => row.facts.workflow?.stage));
    for (const stage of ["UNDERSTAND", "PLAN", "PLAN_CRITIQUE", "PLAN_REVIEW", "IMPLEMENT", "VERIFY", "REVIEW", "PULL_REQUEST", "WAIT_FOR_MERGE", "MERGED", "CLOSED"]) expect(stages.has(stage), stage).toBe(true);
  });

  for (const row of ROWS) {
    it(row.name, () => {
      const state = stateOf({ ...base, ...row.facts });
      expect(state.pill).toBe(row.pill);
      if (row.state !== undefined) expect(state.status.state).toBe(row.state);
      if (row.reason !== undefined) expect(state.status.reason).toBe(row.reason);
      if (row.phase !== undefined) expect(state.phase).toEqual({ key: row.phase, words: { prepare: "Prepare", spec: "Spec", build: "Build", verify: "Verify", deliver: "Deliver" }[row.phase] });
      if (row.step !== undefined) expect([state.step?.key, state.step?.state]).toEqual(row.step);
      if (row.strip !== undefined) expect(state.steps?.map((step) => [step.key, step.state])).toEqual(row.strip);
      if (row.noSteps === true) { expect(state.steps).toBeUndefined(); expect(state.step).toBeUndefined(); expect(state.phase).toBeUndefined(); }
      if (row.pill === "merged") { expect(state.step).toBeUndefined(); expect(state.phase).toBeUndefined(); expect(state.steps?.every((step) => step.state === "done")).toBe(true); }
      // The status the stored summary and the served view share is always one the strict schema accepts: no raw code, no new key.
      expect(TaskStatusSchema.safeParse(state.status).success, JSON.stringify(state.status)).toBe(true);
      // The status line and the pill agree: a Stopped pill never sits beside a status that says Needs you, and a decision always does.
      if (state.pill === "stopped") expect(["paused_budget", "failed", "finished_run"], JSON.stringify(state.status)).toContain(state.status.state);
      if (state.pill === "decision") expect(state.status.state).toBe("needs_you");
    });
  }

  it("titles a Quick design review the lighter one and a full one the plain one, and each step has a phase", () => {
    expect(stateOf({ ...base, workflow: wf("PLAN_CRITIQUE", "RUNNING") }).step?.title).toBe("Design review (lighter)");
    expect(stateOf({ ...base, workflow: wf("PLAN_CRITIQUE", "RUNNING", { path: "FULL", reviewPhase: "DESIGN" }) }).step?.title).toBe("Design review");
    for (const step of stateOf({ ...base, workflow: wf("IMPLEMENT", "RUNNING") }).steps!) expect(["prepare", "spec", "build", "verify", "deliver"]).toContain(step.phase);
  });

  it("never serves the words Failed or Blocked as a pill, whatever the facts", () => {
    const stages = ["UNDERSTAND", "PLAN", "PLAN_CRITIQUE", "PLAN_REVIEW", "IMPLEMENT", "VERIFY", "REVIEW", "PULL_REQUEST", "WAIT_FOR_MERGE"];
    for (const stage of stages) for (const state of ["READY", "RUNNING", "WAITING", "BLOCKED", "COMPLETE"]) for (const failedChecks of [false, true]) {
      const shown = stateOf({ ...base, workflow: wf(stage, state), failedChecks, needsPerson: state === "WAITING" });
      expect(shown.pill, `${stage} ${state}`).toMatch(/^(decision|working|fixing|waiting|in_review|stopped|merged|closed)$/u);
    }
  });

  it("names who a decision waits on", () => {
    expect(stateOf({ ...base, workflow: wf("PLAN_REVIEW", "WAITING"), needsPerson: true }).role).toBe("task_owner");
    expect(stateOf({ ...base, workflow: wf("PLAN_REVIEW", "WAITING"), needsPerson: true, askedRole: "company_admin" }).role).toBe("company_admin");
  });
});

// ---- 2. the rule per person

const WORLD_OWNERS = ["local-owner", "co-owner"];
/** The hosted rules in one place: the person the task runs for and a co-owner act as its owner; a colleague may read it; everyone else (an admin, a stranger, a removed admin) has neither. */
const access = () => ({
  ...createOwnerTaskAccess(),
  canAct: async (principal: { personId: string }) => WORLD_OWNERS.includes(principal.personId),
  canRead: async (principal: { personId: string }) => [...WORLD_OWNERS, "colleague"].includes(principal.personId),
  ownerActing: async (principal: { personId: string }, task: { ownerKey: string }) => (WORLD_OWNERS.includes(principal.personId) ? { actorId: task.ownerKey } : undefined),
});
const person = (world: Seeded, personId: string, companyRole?: "owner" | "admin" | "member"): ActionCaller => ({ principal: { ...world.h.owner.principal, personId, roles: [] }, ...(companyRole === undefined ? {} : { companyRole }) });
const PERSONAS = (world: Seeded): Record<string, ActionCaller> => ({
  owner: person(world, "local-owner", "member"), coOwner: person(world, "co-owner", "member"), liveAdmin: person(world, "an-admin", "admin"), colleague: person(world, "colleague", "member"),
  stranger: person(world, "stranger", "member"), removedAdmin: person(world, "removed-admin"),
});
const planHost: PlanHost = { facts: async () => ({ risk: "low", riskReasons: [], reasonRequired: false }), decide: async () => ({ status: "decided" }) };
const mergeHost = (allowed: string[]): MergeHost => ({ standing: async (caller) => ({ may: allowed.includes(caller.principal.personId) }), readiness: async () => ({ ready: true }), press: async () => undefined });
const envOf = (world: Seeded, extra: Partial<ActionEnv> = {}): ActionEnv => ({ deps: world.h.deps, options: {}, ...extra });
const idsOf = (members: TaskStandingMembers | undefined): string[] => (members?.actions ?? []).map((offer) => offer.id).sort();
const running = () => WorkflowSnapshotSchema.parse({ ...blockedReview(), stage: "IMPLEMENT", state: "RUNNING", blockReason: undefined });
const planWaiting = () => WorkflowSnapshotSchema.parse({
  ...createWorkflowSnapshot({ taskId: TASK_ID, ownerId: OWNER_KEY, now: NOW, definitionVersion: "1.1.0" }), stage: "PLAN_REVIEW", state: "WAITING", revision: 4,
  artifacts: [{ id: "plan-1", type: "plan", version: 1, sha256: "a".repeat(64), producer: "agentx-worker-untrusted", objectKey: `tasks/${TASK_ID}/plan-1.md`, createdAt: NOW }],
});
const waitingForMerge = () => WorkflowSnapshotSchema.parse({
  ...blockedReview({}, [report("CRITIC", "PASS", []), report("SECURITY", "PASS", [])]), stage: "WAIT_FOR_MERGE", state: "WAITING", blockReason: undefined,
  pullRequests: [{ repositoryId: "demo", number: 7, url: "https://example.com/pull/7", required: true, state: "OPEN", candidateDigest: code.digest, headSha: "b".repeat(40) }],
});

describe("taskStandingFor: a running step", () => {
  it("shows every reader who may read it the same working pill, and each only their own moves", async () => {
    const world = await seed({ workflow: running(), access: access() });
    const task = await taskOf(world.h);
    const who = PERSONAS(world);
    const standing = Object.fromEntries(await Promise.all(Object.entries(who).map(async ([name, caller]) => [name, await taskStandingFor(envOf(world), caller, task)] as const)));
    for (const name of ["owner", "coOwner", "liveAdmin", "colleague"]) {
      expect(standing[name]?.standing.pill, name).toMatchObject({ key: "working", words: "Rovara is working", tone: "running" });
      expect(standing[name]?.standing.phase, name).toEqual({ key: "build", words: "Build" });
      expect(standing[name]?.standing.step, name).toMatchObject({ key: "build", title: "Build", state: "doing" });
      expect(standing[name]?.standing.waitingOn, name).toBeUndefined();
    }
    expect(idsOf(standing["owner"]?.standing)).toEqual(["task.close", "task.stop"]);
    expect(idsOf(standing["coOwner"]?.standing)).toEqual(["task.close", "task.stop"]);
    // A live company admin may stop it and nothing more; a colleague only reads.
    expect(idsOf(standing["liveAdmin"]?.standing)).toEqual(["task.stop"]);
    expect(idsOf(standing["colleague"]?.standing)).toEqual([]);
    // A stranger and an admin who was removed have no standing at all: the surface says "not found".
    expect(standing["stranger"]).toBeUndefined();
    expect(standing["removedAdmin"]).toBeUndefined();
  });

  it("serves S1's own offers as `actions`: the same set actionsFor gives the same person", async () => {
    const world = await seed({ workflow: running(), access: access() });
    const task = await taskOf(world.h);
    for (const [name, caller] of Object.entries(PERSONAS(world))) {
      const served = await taskStandingFor(envOf(world), caller, task);
      if (served !== undefined) expect(served.standing.actions, name).toEqual(await actionsFor(envOf(world), caller, task));
    }
  });

  it("keeps the person-free status line out of the standing, and the same for every reader", async () => {
    const world = await seed({ workflow: running(), access: access() });
    const task = await taskOf(world.h);
    const who = PERSONAS(world);
    const lines = await Promise.all(["owner", "liveAdmin", "colleague"].map(async (name) => (await taskStandingFor(envOf(world), who[name]!, task))!.statusView));
    expect(lines[0]).toEqual(lines[1]);
    expect(lines[1]).toEqual(lines[2]);
    expect(lines[0]).toMatchObject({ state: "building" });
    expect(Object.keys((await taskStandingFor(envOf(world), who["owner"]!, task))!.standing)).not.toContain("statusView");
  });
});

describe("taskStandingFor: a plan waits for approval", () => {
  it("is Needs you for the owner and a co-owner, and Needs the task owner for a live admin and a colleague, who are offered no plan move", async () => {
    const world = await seed({ workflow: planWaiting(), access: access() });
    const task = await taskOf(world.h);
    const env = envOf(world, { plan: planHost });
    const who = PERSONAS(world);
    for (const name of ["owner", "coOwner"]) {
      const served = (await taskStandingFor(env, who[name]!, task))!.standing;
      expect(served.pill, name).toMatchObject({ key: "needs_you", words: "Needs you", tone: "attention" });
      expect(served.waitingOn, name).toBeUndefined();
      expect(idsOf(served), name).toEqual(expect.arrayContaining(["plan.approve", "plan.request-changes", "plan.reject"]));
      expect(served.step, name).toMatchObject({ key: "approve_spec", title: "Approve the spec", state: "needs" });
      expect(served.phase, name).toEqual({ key: "spec", words: "Spec" });
    }
    for (const name of ["liveAdmin", "colleague"]) {
      const served = (await taskStandingFor(env, who[name]!, task))!.standing;
      expect(served.pill, name).toMatchObject({ key: "needs_role", words: "Needs the task owner", tone: "attention" });
      expect(served.waitingOn, name).toEqual({ role: "task_owner", words: "task owner" });
      expect(idsOf(served).filter((id) => id.startsWith("plan.")), name).toEqual([]);
    }
    expect(await taskStandingFor(env, who["stranger"]!, task)).toBeUndefined();
    expect(await taskStandingFor(env, who["removedAdmin"]!, task)).toBeUndefined();
  });

  it("stays Needs you for the owner of a plan the host will not let them approve here (a high risk plan): they are the person it waits on", async () => {
    const world = await seed({ workflow: planWaiting(), access: access() });
    const high: PlanHost = { facts: async () => ({ risk: "high", riskReasons: [], reasonRequired: false }), decide: async () => ({ status: "decided" }) };
    const served = (await taskStandingFor(envOf(world, { plan: high }), PERSONAS(world)["owner"]!, await taskOf(world.h)))!.standing;
    expect(idsOf(served).some((id) => id.startsWith("plan."))).toBe(false);
    expect(served.pill.key).toBe("needs_you");
  });

  it("reads Needs you for the owner even when the host serves no plan card at all", async () => {
    const world = await seed({ workflow: planWaiting(), access: access() });
    const served = (await taskStandingFor(envOf(world), PERSONAS(world)["owner"]!, await taskOf(world.h)))!.standing;
    expect(served.pill.key).toBe("needs_you");
  });
});

describe("taskStandingFor: nobody who owns the task still has its project (TASK-TAKEOVER PR A)", () => {
  it("waits on a project admin: a reader who is not an admin reads Needs a project admin and who it waits on; a live company admin is the person it asks", async () => {
    const noOwner = WorkflowSnapshotSchema.parse({ ...blockedReview(), stage: "IMPLEMENT", state: "BLOCKED", blockReason: OWNER_LEFT_PROJECT_WORDS });
    const world = await seed({ workflow: noOwner, access: access() });
    const task = await taskOf(world.h);
    const who = PERSONAS(world);
    const colleague = (await taskStandingFor(envOf(world), who["colleague"]!, task))!.standing;
    expect(colleague.pill).toMatchObject({ key: "needs_role", words: "Needs a project admin" });
    expect(colleague.waitingOn).toEqual({ role: "project_admin", words: "project admin" });
    const admin = (await taskStandingFor(envOf(world), who["liveAdmin"]!, task))!.standing;
    expect(admin.pill.key).toBe("needs_you");
    expect(admin.waitingOn).toBeUndefined();
    // Any other stopped step still reads as before: it waits on the task owner.
    const other = WorkflowSnapshotSchema.parse({ ...blockedReview(), stage: "IMPLEMENT", state: "BLOCKED", blockReason: "the step stopped" });
    const otherWorld = await seed({ workflow: other, access: access() });
    expect((await taskStandingFor(envOf(otherWorld), PERSONAS(otherWorld)["colleague"]!, await taskOf(otherWorld.h)))!.standing.pill.words).toBe("Needs the task owner");
  });
});

describe("taskStandingFor: a stopped step", () => {
  it("is Needs you for the owner, who may retry, and Needs the task owner for the admin; the Retry label names the step", async () => {
    const stopped = WorkflowSnapshotSchema.parse({ ...blockedReview(), stage: "IMPLEMENT", state: "BLOCKED", blockReason: "the step stopped" });
    const world = await seed({ workflow: stopped, access: access() });
    const task = await taskOf(world.h);
    const who = PERSONAS(world);
    const owner = (await taskStandingFor(envOf(world), who["owner"]!, task))!.standing;
    expect(owner.pill.key).toBe("needs_you");
    expect(owner.actions.find((offer) => offer.id === "step.retry")?.label).toBe("Retry coding");
    expect(owner.step).toMatchObject({ key: "build", state: "needs" });
    const admin = (await taskStandingFor(envOf(world), who["liveAdmin"]!, task))!.standing;
    expect(admin.pill.key).toBe("needs_role");
    expect(idsOf(admin)).not.toContain("step.retry");
  });

  it("is Stopped for everyone when only a spending approval lifts it (the budget pause)", async () => {
    const paused = WorkflowSnapshotSchema.parse({ ...blockedReview(), stage: "IMPLEMENT", state: "BLOCKED", blockReason: WORKFLOW_BLOCK_REASONS.budgetPaused });
    const world = await seed({ workflow: paused, access: access() });
    const task = await taskOf(world.h);
    for (const name of ["owner", "liveAdmin", "colleague"]) {
      const served = (await taskStandingFor(envOf(world), PERSONAS(world)[name]!, task))!;
      expect(served.standing.pill, name).toMatchObject({ key: "stopped", words: "Stopped", tone: "idle" });
      expect(served.standing.step, name).toMatchObject({ key: "build", state: "stopped" });
      expect(idsOf(served.standing).includes("step.retry"), name).toBe(false);
    }
  });

  it("is Needs you at a review that found problems, and the failed-check fact shows on the Verify step", async () => {
    const world = await seed({ workflow: blockedReview({}, [report("CRITIC", "FINDINGS", [PARSER]), report("SECURITY", "FINDINGS", [TOKEN])]), access: access() });
    const owner = (await taskStandingFor(envOf(world), PERSONAS(world)["owner"]!, await taskOf(world.h)))!.standing;
    expect(owner.pill.key).toBe("needs_you");
    expect(idsOf(owner)).toEqual(expect.arrayContaining(["findings.resolve", "work.send-back"]));
    expect(owner.actions.find((offer) => offer.id === "work.send-back")?.label).toBe("Send back with instructions");
    expect(owner.step).toMatchObject({ key: "review", state: "needs" });
    const failing = WorkflowSnapshotSchema.parse({ ...blockedReview(), stage: "VERIFY", state: "BLOCKED", blockReason: "A check failed.", verification: { candidateDigest: code.digest, producer: "agentx-broker", environmentId: "ci", recordedAt: NOW, results: [{ checkId: "unit", status: "FAILED" }] } });
    const failed = await seed({ workflow: failing, access: access() });
    const served = (await taskStandingFor(envOf(failed), PERSONAS(failed)["owner"]!, await taskOf(failed.h)))!.standing;
    expect(served.step).toMatchObject({ key: "tests", state: "failed" });
    expect(served.steps?.find((step) => step.key === "tests")?.state).toBe("failed");
  });
});

describe("taskStandingFor: a pull request waits, and the failed-checks fact reads merge tracking from the store", () => {
  const seedTracking = async (world: Seeded, overrides: Record<string, unknown>) => {
    const fields = {
      orgId: world.h.deps.companyId, taskId: TASK_ID, repositoryId: "demo", number: 7, headSha: "b".repeat(40), draft: false, state: "open" as const, baseBranch: "main", ci: "passing" as const, ciBasis: "all_checks" as const, checksEverSeen: true,
      failingChecks: [] as string[], review: "approved" as const, branch: "up_to_date" as const, headByRovara: true, nudges: { count: 0 }, syncs: { day: "2026-11-09", count: 0 }, ...overrides,
    };
    const item = { ...fields, version: 1, decisionDigest: mergeTrackingDecisionDigest(fields), observedAt: NOW };
    await world.h.store.put({ item: JSON.parse(JSON.stringify({ ...mergeTrackingKey(TASK_ID, "demo", 7), entityType: "MERGE_TRACKING", ...item })) as never });
  };

  it("is In review for the owner and an admin who both may merge, and for a colleague who may not; merge is never a Needs you move", async () => {
    const world = await seed({ workflow: waitingForMerge(), access: access() });
    await seedTracking(world, {});
    const task = await taskOf(world.h);
    const env = envOf(world, { merge: mergeHost(["local-owner", "an-admin"]) });
    const who = PERSONAS(world);
    for (const name of ["owner", "liveAdmin", "colleague"]) {
      const served = (await taskStandingFor(env, who[name]!, task))!;
      expect(served.standing.pill, name).toMatchObject({ key: "in_review", words: "In review", tone: "ok" });
      expect(served.standing.waitingOn, name).toBeUndefined();
      expect(served.standing.phase, name).toEqual({ key: "deliver", words: "Deliver" });
      expect(served.statusView.state, name).toBe("ready_to_merge");
    }
    expect(idsOf((await taskStandingFor(env, who["owner"]!, task))!.standing)).toContain("task.merge");
    expect(idsOf((await taskStandingFor(env, who["liveAdmin"]!, task))!.standing)).toContain("task.merge");
    expect(idsOf((await taskStandingFor(env, who["colleague"]!, task))!.standing)).not.toContain("task.merge");
  });

  it("says Ready to merge only when the pull request is ready (B2): tracking not read, pending or failing checks, a draft, a review asked for, a conflict or a head someone else pushed all read Checking, the pill stays In review", async () => {
    const world = await seed({ workflow: waitingForMerge(), access: access() });
    const task = await taskOf(world.h);
    const owner = PERSONAS(world)["owner"]!;
    const read = async () => (await taskStandingFor(envOf(world), owner, task))!;
    // nothing read yet: not ready
    expect((await read()).statusView).toMatchObject({ state: "checking", reason: "the pull request is not ready to merge yet" });
    for (const [name, overrides, reason] of [
      ["checks pending", { ci: "pending" }, "the pull request is not ready to merge yet"],
      ["checks failing", { ci: "failing", failingChecks: ["unit"] }, "the pull request's checks are failing"],
      ["a draft", { draft: true }, "the pull request is not ready to merge yet"],
      ["a review asked for and not come", { review: "requested" }, "the pull request is not ready to merge yet"],
      ["a conflict with its base", { branch: "conflicted" }, "the pull request is not ready to merge yet"],
      ["someone else's push", { headByRovara: false }, "the pull request is not ready to merge yet"],
    ] as const) {
      await seedTracking(world, overrides);
      const served = await read();
      expect(served.statusView, name).toMatchObject({ state: "checking", reason });
      expect(served.standing.pill.key, name).toBe("in_review");
    }
    await seedTracking(world, {});
    const ready = await read();
    expect(ready.statusView.state).toBe("ready_to_merge");
    expect(ready.standing.pill.key).toBe("in_review");
  });

  it("marks the Verify step failed when tracking says an open pull request's checks fail, and not when they pass or the pull request is closed", async () => {
    const world = await seed({ workflow: waitingForMerge(), access: access() });
    const task = await taskOf(world.h);
    const owner = PERSONAS(world)["owner"]!;
    const testsState = async () => (await taskStandingFor(envOf(world), owner, task))!.standing.steps?.find((step) => step.key === "tests")?.state;
    expect(await testsState()).toBe("done");
    await seedTracking(world, { ci: "failing", failingChecks: ["unit"] });
    expect(await testsState()).toBe("failed");
    await seedTracking(world, { ci: "passing", failingChecks: [] });
    expect(await testsState()).toBe("done");
    await seedTracking(world, { ci: "failing", failingChecks: ["unit"], state: "closed" });
    expect(await testsState()).toBe("done");
    await seedTracking(world, { ci: "pending", failingChecks: ["lint"] });
    expect(await testsState()).toBe("failed");
  });
});

describe("taskStandingFor: a person's own Stop reads Stopped", () => {
  const stopped = () => WorkflowSnapshotSchema.parse({ ...blockedReview(), stage: "IMPLEMENT", state: "BLOCKED", blockReason: "the step stopped" });

  it("is Stopped for every reader once the host supplies the fact, and the owner may still retry (the work is kept)", async () => {
    const world = await seed({ workflow: stopped(), access: access() });
    const task = await taskOf(world.h);
    for (const name of ["owner", "coOwner", "liveAdmin", "colleague"]) {
      const served = (await taskStandingFor(envOf(world), PERSONAS(world)[name]!, task, { stoppedByPerson: true }))!;
      expect(served.standing.pill, name).toMatchObject({ key: "stopped", words: "Stopped", tone: "idle" });
      expect(served.standing.waitingOn, name).toBeUndefined();
      expect(served.standing.step, name).toMatchObject({ key: "build", state: "stopped" });
      expect(served.statusView.state, name).not.toBe("needs_you");
    }
    expect(idsOf((await taskStandingFor(envOf(world), PERSONAS(world)["owner"]!, task, { stoppedByPerson: true }))!.standing)).toContain("step.retry");
    // Without the fact the same task reads as any stopped step does (Needs you for the owner): the fact is the only difference.
    expect((await taskStandingFor(envOf(world), PERSONAS(world)["owner"]!, task))!.standing.pill.key).toBe("needs_you");
  });

  // F2-B supplies the fact: the real Stop writes `personStop` on the task row with its claim, and `standingFactsOf` reads it, so a task stopped through the real Stop press reads Stopped to its owner with no fact passed by the caller.
  it("a task stopped through the real Stop press reads Stopped to its owner, with no fact passed by the caller", async () => {
    const world = await seed({ workflow: running(), access: access() });
    const owner = PERSONAS(world)["owner"]!;
    const task = await taskOf(world.h);
    expect((await performRegistryAction(envOf(world), owner, { actionId: "task.stop", taskId: TASK_ID, binding: { revision: 0 }, requestKey: "known-gap-stop", via: "slack" })).status).toBe("done");
    const after = await taskOf(world.h);
    expect(after.workflow).toBeDefined();
    expect((await taskStandingFor(envOf(world), owner, after))!.standing.pill.key).toBe("stopped");
    expect(task.taskId).toBe(after.taskId);
  });
});

describe("taskStandingFor: a closed task", () => {
  it("is Closed for every reader, with no phase or step and no move to make", async () => {
    const world = await seed({ workflow: running(), access: access(), task: { closedAt: "2026-11-10T11:00:00.000Z" } });
    const task = await taskOf(world.h);
    for (const name of ["owner", "coOwner", "liveAdmin", "colleague"]) {
      const served = (await taskStandingFor(envOf(world), PERSONAS(world)[name]!, task))!;
      expect(served.standing.pill, name).toMatchObject({ key: "closed", words: "Closed" });
      expect(served.standing.phase, name).toBeUndefined();
      expect(served.standing.steps, name).toBeUndefined();
      expect(served.standing.actions, name).toEqual([]);
      expect(served.statusView.state, name).toBe("closed");
    }
  });
});

// ---- 3. the served shape

describe("the served shape's tolerant reader", () => {
  const offer = (id: string, extra: Record<string, unknown> = {}) => ({ id, label: "Something", risk: "routine", needsDialog: false, binding: { revision: 3 }, ...extra });

  it("skips an action this build does not know and keeps the rest, instead of failing the answer", () => {
    const read = readLooseOffers([offer("task.stop"), offer("task.teleport"), offer("task.close", { risk: "a-risk-from-a-newer-code" }), { nonsense: true }, "text", offer("plan.approve", { newField: 1 })]);
    expect(read.map((entry) => entry.id)).toEqual(["task.stop", "task.close", "plan.approve"]);
    expect(read[1]?.risk).toBe("a-risk-from-a-newer-code");
    expect((read[2] as Record<string, unknown>)["newField"]).toBe(1);
    expect(readLooseOffers("not a list")).toEqual([]);
    expect(readLooseOffers(undefined)).toEqual([]);
    // A reader with an older list of ids skips an id a newer one knows.
    expect(readLooseOffers([offer("task.stop"), offer("task.merge")], ["task.stop"]).map((entry) => entry.id)).toEqual(["task.stop"]);
  });

  it("reads a real served standing, keeps unknown keys, and draws a pill key it has never seen", async () => {
    const world = await seed({ workflow: planWaiting(), access: access() });
    const served = (await taskStandingFor(envOf(world, { plan: planHost }), PERSONAS(world)["owner"]!, await taskOf(world.h)))!.standing;
    const read = TaskStandingReaderSchema.parse(JSON.parse(JSON.stringify(served)));
    expect(read.pill).toMatchObject({ key: "needs_you", words: "Needs you", tone: "attention" });
    expect(read.actions.map((entry) => entry.id).sort()).toEqual(idsOf(served));
    const future = TaskStandingReaderSchema.parse({
      pill: { key: "a_new_pill", words: "Brand new", tone: "a-new-tone" }, phase: { key: "a_new_phase", words: "Somewhere" }, step: { key: "x", title: "X", state: "a-new-state" }, extra: { anything: true },
      actions: [offer("task.stop"), offer("task.from-the-future")],
    });
    expect(future.pill.words).toBe("Brand new");
    expect(future.step?.state).toBe("a-new-state");
    expect(future.actions.map((entry) => entry.id)).toEqual(["task.stop"]);
    expect((future as Record<string, unknown>)["extra"]).toEqual({ anything: true });
  });

  it("reads every registry id Code can offer (an id this build knows is never dropped)", () => {
    expect(readLooseOffers(TASK_ACTION_IDS.map((id) => offer(id))).map((entry) => entry.id)).toEqual([...TASK_ACTION_IDS]);
  });
});

// The task read (and the session view that embeds it for a reader) is served per reader and never stored, so it MAY carry `standing`; what is stored is the session record, its summary and the status that is the summary's display.
describe("standing is reachable from no stored schema", () => {
  /** Every property name anywhere in a schema's JSON form, for every schema a person's reading could be written into. */
  const namesIn = (schema: z.ZodType): Set<string> => {
    const names = new Set<string>();
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (node === null || typeof node !== "object") return;
      for (const [key, value] of Object.entries(node)) {
        if (key === "properties" && value !== null && typeof value === "object") for (const name of Object.keys(value as object)) names.add(name);
        walk(value);
      }
    };
    walk(z.toJSONSchema(schema, { unrepresentable: "any", io: "input" }));
    return names;
  };
  const STORED: Array<[string, z.ZodType]> = [["the session record (stored)", AgentSessionRecordSchema], ["the session summary (stored)", SessionSummarySchema], ["the status (stored as the summary's display)", TaskStatusSchema]];

  for (const [name, schema] of STORED) {
    it(`${name} holds no standing, pill, waiting-on, strip or actions member`, () => {
      const names = namesIn(schema);
      for (const forbidden of ["standing", "pill", "waitingOn", "steps", "actions", "phase", "tone"]) expect(names.has(forbidden), `${name}: ${forbidden}`).toBe(false);
    });
  }

  it("is a guard that can fail: the standing reader itself does carry those names", () => {
    const names = namesIn(TaskStandingReaderSchema);
    for (const expected of ["pill", "actions", "waitingOn", "steps"]) expect(names.has(expected), expected).toBe(true);
  });
});
