// F2-A Opus review (2026-11-24): extra checks the reviewer added (uncommitted).
//   1. defaultTaskDisplay (K4) keeps the SAME state key and reason as the pre-F2 switch for every combination of its inputs (stages x states x outcomes x flags x session status x ended); `next` differs only where F2-A
//      changed it on purpose (WAIT_FOR_MERGE), and `nextOthers` is added only to the person-needed states and WAIT_FOR_MERGE. Every output still parses with the strict stored TaskStatusSchema.
//   2. taskStandingFor gives NO standing to a caller of another company, a script token, or a task of another company, even when the person would otherwise be an owner or live admin.
//   3. The tolerant reader never fails the answer on a malformed `actions` (object, null, missing) and on offers with a bad binding.
import { describe, expect, it } from "vitest";
import { TaskStandingReaderSchema, TaskStatusSchema, WorkflowSnapshotSchema, failureCause, taskStatusFromSession, type SessionStatus, type TaskStatus } from "@agentx/contracts";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { defaultTaskDisplay } from "../../packages/broker/src/core/sessions/display.js";
import type { ActionCaller, ActionEnv } from "../../packages/broker/src/core/task-actions/index.js";
import { taskStandingFor } from "../../packages/broker/src/core/task-view/index.js";
import { blockedReview, seed, taskOf, type Seeded } from "../support/task-actions-world.js";

// ---- 1. K4 parity with the switch as it stood at S1 (54c76c532), copied verbatim
type Facts = Parameters<typeof defaultTaskDisplay>[0];
function oldDisplay(facts: Facts, status: SessionStatus, input: { lastRunFailed?: true | undefined; ended?: boolean; step?: string | undefined } = {}): TaskStatus {
  const workflow = facts.workflow;
  if (workflow?.stage === "MERGED") return { state: "merged", next: "Nothing; this task is complete." };
  if (workflow?.outcome === "ANSWERED") return { state: "closed", reason: "Answered: no code change was needed", next: "Nothing; no code change was needed." };
  if (facts.failedPrepare !== undefined) return { state: "failed", reason: "the repository could not be prepared for the task", next: "Close the task and start it again." };
  if (input.ended === true) {
    if (status === "failed") return { state: "failed", reason: failureCause(facts.failureCategory), next: "Start a new task." };
    return { state: "closed", next: "Nothing; this task is closed." };
  }
  if (facts.budgetPaused === true) return { state: "paused_budget", reason: "it reached its spending limit", next: "The work goes on once the limit is raised or the allowance changes." };
  if (workflow === undefined) return taskStatusFromSession({ status, ...(input.lastRunFailed === undefined ? {} : { lastRunFailed: input.lastRunFailed }), ...(input.step === undefined ? {} : { step: input.step }) });
  if (workflow.state === "BLOCKED") return { state: "needs_you", reason: "the task is blocked", next: "Retry it, or ask for changes." };
  if (workflow.stage === "PLAN_REVIEW" && workflow.state === "WAITING") return { state: "needs_you", reason: "the plan is waiting for approval", next: "Review it and approve, or ask for changes." };
  if (workflow.stage === "UNDERSTAND" && workflow.state === "WAITING") return { state: "needs_you", reason: "questions about the request need answers", next: "Answer them." };
  if (workflow.stage === "WAIT_FOR_MERGE") return { state: "ready_to_merge", next: "Review the pull request and merge it." };
  switch (workflow.stage) {
    case "UNDERSTAND": return { state: "understanding", next: "A plan follows once the request is understood." };
    case "PLAN": case "PLAN_CRITIQUE": case "PLAN_REVIEW": return { state: "planning", next: "You review the plan when it is ready." };
    case "IMPLEMENT": return { state: "building", next: "Checks and a pull request follow." };
    case "VERIFY": case "REVIEW": case "PULL_REQUEST": return { state: "checking", next: "A pull request is opened once the checks pass." };
    default: return { state: "building" };
  }
}

const STAGES = ["UNDERSTAND", "PLAN", "PLAN_CRITIQUE", "PLAN_REVIEW", "IMPLEMENT", "VERIFY", "REVIEW", "PULL_REQUEST", "WAIT_FOR_MERGE", "MERGED", "CLOSED"];
const STATES = ["READY", "RUNNING", "WAITING", "BLOCKED", "COMPLETE"];
const OUTCOMES = [undefined, "MERGED", "CLOSED", "ANSWERED"];
const SESSION: SessionStatus[] = ["starting", "running", "needs_person", "paused", "waiting", "stopped", "failed", "closed"] as SessionStatus[];

describe("F2-A review: defaultTaskDisplay keeps every state key and reason it had", () => {
  it("matches the pre-F2 switch on state and reason for every combination; next differs only at WAIT_FOR_MERGE; strict schema parses", () => {
    let cases = 0;
    const workflows: Array<Facts["workflow"]> = [undefined];
    for (const stage of STAGES) for (const state of STATES) for (const outcome of OUTCOMES) workflows.push({ stage, state, ...(outcome === undefined ? {} : { outcome }) });
    for (const workflow of workflows) for (const failedPrepare of [undefined, { at: "x" }]) for (const budgetPaused of [undefined, true]) for (const status of SESSION) for (const ended of [false, true]) for (const lastRunFailed of [undefined, true] as const) {
      const facts = { ...(workflow === undefined ? {} : { workflow }), ...(failedPrepare === undefined ? {} : { failedPrepare }), ...(budgetPaused === undefined ? {} : { budgetPaused }), failureCategory: "timed_out" } as Facts;
      const input = { ended, ...(lastRunFailed === undefined ? {} : { lastRunFailed }) };
      const before = oldDisplay(facts, status, input);
      const after = defaultTaskDisplay(facts, status, input);
      const label = JSON.stringify({ workflow, failedPrepare, budgetPaused, status, ended, lastRunFailed });
      expect(after.state, label).toBe(before.state);
      expect(after.reason, label).toBe(before.reason);
      if (before.state !== "ready_to_merge") expect(after.next, label).toBe(before.next);
      if (after.nextOthers !== undefined) expect(["needs_you", "ready_to_merge"], label).toContain(after.state);
      expect(TaskStatusSchema.safeParse(after).success, label).toBe(true);
      cases += 1;
    }
    expect(cases).toBeGreaterThan(2000);
  });
});

// ---- 2. no standing across a company boundary or for a script token

const access = () => ({
  ...createOwnerTaskAccess(),
  canAct: async (principal: { personId: string }) => principal.personId === "local-owner",
  canRead: async () => true,
  ownerActing: async (principal: { personId: string }, task: { ownerKey: string }) => (principal.personId === "local-owner" ? { actorId: task.ownerKey } : undefined),
});
const running = () => WorkflowSnapshotSchema.parse({ ...blockedReview(), stage: "IMPLEMENT", state: "RUNNING", blockReason: undefined });
const envOf = (world: Seeded): ActionEnv => ({ deps: world.h.deps, options: {} });

describe("F2-A review: taskStandingFor never crosses a company or serves a script token", () => {
  it("serves the owner and a live admin, and refuses the same people from another company, with a script token, or on a task of another company", async () => {
    const world = await seed({ workflow: running(), access: access() });
    const task = await taskOf(world.h);
    const base = world.h.owner.principal;
    const owner: ActionCaller = { principal: { ...base, personId: "local-owner", roles: [] }, companyRole: "member" };
    const admin: ActionCaller = { principal: { ...base, personId: "an-admin", roles: [] }, companyRole: "admin" };
    expect(await taskStandingFor(envOf(world), owner, task)).toBeDefined();
    expect(await taskStandingFor(envOf(world), admin, task)).toBeDefined();
    const otherCompany = (caller: ActionCaller): ActionCaller => ({ ...caller, principal: { ...caller.principal, companyId: "another-company" } });
    expect(await taskStandingFor(envOf(world), otherCompany(owner), task)).toBeUndefined();
    expect(await taskStandingFor(envOf(world), otherCompany(admin), task)).toBeUndefined();
    expect(await taskStandingFor(envOf(world), { ...owner, scriptToken: { id: "t" } } as never, task)).toBeUndefined();
    expect(await taskStandingFor(envOf(world), { ...admin, scriptToken: { id: "t" } } as never, task)).toBeUndefined();
    expect(await taskStandingFor(envOf(world), admin, { ...task, companyId: "another-company" })).toBeUndefined();
  });
});

// ---- 3. the tolerant reader never fails the whole answer on `actions`

describe("F2-A review: the tolerant reader and a malformed actions member", () => {
  const pill = { key: "working", words: "Rovara is working", tone: "running" };
  it("CONDITION: a standing with no actions member at all reads as no offers (today: fails with 'expected nonoptional')", () => {
    const parsed = TaskStandingReaderSchema.safeParse({ pill });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.actions).toEqual([]);
  });
  it("reads no offers for a null, object or string actions, and skips offers with a bad binding or label", () => {
    for (const actions of [null, {}, "x", 7]) {
      const parsed = TaskStandingReaderSchema.safeParse(actions === undefined ? { pill } : { pill, actions });
      expect(parsed.success, JSON.stringify(actions)).toBe(true);
      expect(parsed.success && parsed.data.actions, JSON.stringify(actions)).toEqual([]);
    }
    const good = { id: "task.stop", label: "Stop here and keep the work", risk: "routine", needsDialog: false, binding: { revision: 1 } };
    const parsed = TaskStandingReaderSchema.parse({ pill, actions: [good, { ...good, binding: { revision: -1 } }, { ...good, label: "" }, { ...good, binding: undefined }, { ...good, id: "task.close", risk: "cosmic" }] });
    expect(parsed.actions.map((offer) => offer.id)).toEqual(["task.stop", "task.close"]);
  });
});
