// journey-gate: removed-member-acts
// REMOVED-MEMBER-ACTS (briefs/arch-cleanup/REMOVED-MEMBER-READ-REPRO.md, the acts half): a person STARTS a task (the task has no People list, so they are its stored person) and is then removed from the PROJECT
// (still in the company) or from the COMPANY. May they still MOVE the task? Every case presses an act as the removed person, on the real hosted core (the journey world), and expects it REFUSED as a missing
// task or a sign-in is refused (401, 403, 404; or the registry's TASK_NOT_FOUND / FORBIDDEN / SLACK_ACCOUNT_NOT_LINKED), with nothing written. A case that fails says what answered instead.
//   web acts   the web app's own routes (decision card approve, close, stop, merge press, send back), as the same client the person used before
//   slack acts the task action registry's press from a chat account that resolves to the person (`coreTasks.taskAction`, the entry the Slack interactivity handler calls), describe then perform
//   registry   the "who" rule of EVERY registry entry, judged on the real hosted access for the removed person (the standing the registry computes before any `when` or write)
// An answer of any other kind (400 invalid, 409 stale, "not offered") is a case whose request was wrong, not an access answer: it fails too, so the case is fixed rather than passing for the wrong reason.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { Principal } from "@agentx/contracts";
import { revokeProjectAccess } from "../../packages/broker/src/aws/admin-actions.js";
import { createJourneyWorld, MAYA, type JourneyWorld } from "./harness/hosted-core.js";
import { removeFromCompany } from "./harness/page.js";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { FILE_CHECK_PLAN, buildUntilPullRequest, hostReady, planUntilCard, startTask } from "./harness/task.js";

let world: JourneyWorld | undefined;
afterEach(async () => { await world?.close(); world = undefined; });

type Scenario = "project" | "company";
const SCENARIOS: Array<[string, Scenario]> = [["removed from the PROJECT only (still in the company)", "project"], ["removed from the COMPANY (membership ended, sign-in sessions still alive)", "company"]];

const CHAT = { channel: "examplechat", tenant: "journey-team" };
const CONVERSATION = { ...CHAT, space: "C1", thread: "t1" };
const ACTOR = { ...CHAT, userId: "U0MAYA" };
const CALLER = { developerId: MAYA.developerId, sessionId: "core", name: MAYA.name };
const ACCESS_REFUSALS = new Set(["TASK_NOT_FOUND", "FORBIDDEN", "SLACK_ACCOUNT_NOT_LINKED"]);

const newWorld = async () => {
  world = await createJourneyWorld({ chatPerson: async (_company, actor) => actor.userId === ACTOR.userId ? { personId: MAYA.developerId, via: "signin" } : undefined });
  return world;
};
const tasksOf = (w: JourneyWorld) => w.harness.core.coreTasks!;

async function remove(w: JourneyWorld, scenario: Scenario): Promise<void> {
  if (scenario === "company") { removeFromCompany(w, MAYA); return; }
  expect(await revokeProjectAccess({ documentClient: w.harness.db, tableName: "state" }, "payments", MAYA.developerId, w.harness.runtime.flow.deps.companyId)).toEqual({ revoked: true });
}

/** Everything a task move would change: the task's row and the operations (a started coding run is one) and decisions. */
const snapshot = (w: JourneyWorld, taskId: string): string => JSON.stringify([w.taskRow(taskId), w.harness.db.find((row) => row.entityType === "OPERATION").map((row) => [row.id, row.status]),
  w.harness.db.find((row) => String(row.entityType).includes("DECISION")).length]);

interface Outcome { answer: string; access: boolean; moved: boolean }

/** A web act's answer: an access refusal is 401, 403 or 404 and moves nothing. */
const probed = (w: JourneyWorld) => (method: string, path: string, body?: unknown) => w.proof.probe(() => w.maya(method, path, body));
const webOutcome = (w: JourneyWorld, taskId: string, before: string, reply: { status: number; body: unknown }): Outcome => ({
  answer: `${String(reply.status)} ${JSON.stringify((reply.body as { error?: unknown }).error ?? reply.body).slice(0, 160)}`,
  access: [401, 403, 404].includes(reply.status), moved: snapshot(w, taskId) !== before,
});

/**
 * A chat press as the registry's entry takes it: describe (what the Slack card or modal asks first), then perform with the digest of the confirm it showed. `controlled`: the owner's own describe of the same press
 * answered "ok" before the removal, so a refusal of ANY kind after it (not just "not found") is the removal's doing (the plan's actions are "not offered" to someone the decision list no longer shows the card).
 */
async function slackPress(w: JourneyWorld, taskId: string, actionId: string, binding: { revision: number; digest?: string }, values: Record<string, string> = {}, controlled = false): Promise<Outcome> {
  const before = snapshot(w, taskId);
  const tasks = tasksOf(w);
  const common = { actionId, taskId, binding, conversation: CONVERSATION, actor: ACTOR } as never;
  const described = await tasks.taskAction!(CALLER, { mode: "describe", ...(common as object), values } as never);
  if (described.mode === "describe" && described.description.status === "refused") {
    const code = described.description.code;
    return { answer: `describe refused ${code} ${described.description.reason}`, access: controlled || ACCESS_REFUSALS.has(code), moved: false };
  }
  const confirmDigest = described.mode === "describe" && described.description.status === "ok" ? described.description.confirmDigest : undefined;
  const performed = await tasks.taskAction!(CALLER, { mode: "perform", ...(common as object), values, ...(confirmDigest === undefined ? {} : { confirmDigest }), requestKey: randomUUID() } as never);
  if (performed.mode !== "perform") throw new Error("the press did not answer a perform");
  const result = performed.result;
  const refused = result.status === "refused";
  return { answer: refused ? `perform refused ${result.code} ${result.reason}` : `perform ${result.status}`, access: refused && (controlled || ACCESS_REFUSALS.has(result.code)), moved: snapshot(w, taskId) !== before };
}

const waitingPlanBinding = (w: JourneyWorld, taskId: string) => {
  const workflow = w.taskRow(taskId)!.workflow as unknown as { revision: number; artifacts: Array<{ sha256: string }> };
  return { revision: workflow.revision, digest: workflow.artifacts.at(-1)!.sha256 };
};
type State = "plan" | "running" | "blocked" | "pull request";
interface Act { name: string; state: State; run(w: JourneyWorld, taskId: string, pre: Record<string, unknown>): Promise<Outcome>; prepare?(w: JourneyWorld, taskId: string, pre: Record<string, unknown>): Promise<void> }

const decisionCard = async (w: JourneyWorld, taskId: string) => {
  const listed = await w.maya("GET", "/v1/app/decisions");
  const card = (listed.body.cards as Array<{ id: string; taskId?: string; risk: string }>).find((item) => item.taskId === taskId);
  expect(card, "before a removal the plan waits as a decision card").toBeDefined();
  return { path: card!.id.replace(":", "/"), shownDigest: (listed.body.digests as Record<string, string>)[card!.id]!, risk: card!.risk };
};
const revisionOf = (w: JourneyWorld, taskId: string) => (w.taskRow(taskId)!.workflow as unknown as { revision: number }).revision;

/** A registry press from a chat account. The control (before the removal, as the owner): the press is describable or offered, so the same press can only be refused later because of the removal. */
function slackAct(name: string, state: State, actionId: string, binding: (w: JourneyWorld, taskId: string) => { revision: number; digest?: string | undefined } | Promise<{ revision: number; digest?: string | undefined }>, values: Record<string, string> = {}): Act {
  return { name, state,
    prepare: async (w, taskId, pre) => {
      pre.binding = await binding(w, taskId);
      const described = await tasksOf(w).taskAction!(CALLER, { mode: "describe", actionId, taskId, binding: pre.binding, conversation: CONVERSATION, actor: ACTOR, values } as never);
      const offered = (await tasksOf(w).taskActions!(CALLER, taskId))?.some((offer) => offer.id === actionId) === true;
      expect(described.mode === "describe" && described.description.status === "ok" || offered, `control: before a removal the owner can press ${actionId} (${JSON.stringify(described)})`).toBe(true);
    },
    run: async (w, taskId, pre) => slackPress(w, taskId, actionId, pre.binding as never, values, true) };
}
const offeredBinding = (id: string) => async (w: JourneyWorld, taskId: string) => {
  const offers = await tasksOf(w).taskActions!(CALLER, taskId);
  const offer = offers?.find((candidate) => candidate.id === id);
  expect(offer, `before a removal the owner is offered ${id} (offers: ${JSON.stringify(offers?.map((o) => o.id))})`).toBeDefined();
  return offer!.binding;
};
const webPost = (path: (taskId: string) => string, body: (w: JourneyWorld, taskId: string) => Record<string, unknown>) => async (w: JourneyWorld, taskId: string): Promise<Outcome> => {
  const before = snapshot(w, taskId);
  return webOutcome(w, taskId, before, await probed(w)("POST", path(taskId), body(w, taskId)));
};

const ACTS: Act[] = [
  { name: "web: approve the plan (the decision card; starts the coding run)", state: "plan",
    prepare: async (w, taskId, pre) => { pre.card = await decisionCard(w, taskId); },
    run: async (w, taskId, pre) => {
      const card = pre.card as Awaited<ReturnType<typeof decisionCard>>; const before = snapshot(w, taskId);
      if (card.risk === "medium") await probed(w)("POST", `/v1/app/decisions/${card.path}/evidence-opened`, { shownDigest: card.shownDigest, requestId: randomUUID() });
      return webOutcome(w, taskId, before, await probed(w)("POST", `/v1/app/decisions/${card.path}/approve`, { shownDigest: card.shownDigest, requestId: randomUUID() }));
    } },
  slackAct("slack: approve the plan (registry plan.approve; starts the coding run)", "plan", "plan.approve", waitingPlanBinding),
  slackAct("slack: request changes on the plan (registry plan.request-changes)", "plan", "plan.request-changes", waitingPlanBinding, { note: "Please change it." }),
  slackAct("slack: reject the plan (registry plan.reject)", "plan", "plan.reject", waitingPlanBinding),
  { name: "web: close the task (irreversible)", state: "plan", run: (w, taskId) => webPost((id) => `/v1/dev/tasks/${id}/close`, () => ({ requestId: randomUUID() }))(w, taskId) },
  slackAct("slack: close the task (registry task.close)", "plan", "task.close", offeredBinding("task.close")),
  { name: "web: stop the running task", state: "running", run: (w, taskId) => webPost((id) => `/v1/dev/tasks/${id}/cancel`, () => ({ requestId: randomUUID() }))(w, taskId) },
  slackAct("slack: stop the running task (registry task.stop)", "running", "task.stop", offeredBinding("task.stop")),
  { name: "web: send the failed work back to coding (spends)", state: "blocked",
    run: (w, taskId) => webPost((id) => `/v1/dev/tasks/${id}/workflow/send-back`, (world, id) => ({ requestId: randomUUID(), expectedRevision: revisionOf(world, id), instructions: "Write the endpoint's answer to health.txt." }))(w, taskId) },
  slackAct("slack: send the failed work back to coding (registry work.send-back; spends)", "blocked", "work.send-back", offeredBinding("work.send-back"), { instructions: "Write the endpoint's answer to health.txt." }),
  { name: "web: retry the blocked step (spends)", state: "blocked",
    run: (w, taskId) => webPost((id) => `/v1/dev/tasks/${id}/workflow/retry`, (world, id) => ({ requestId: randomUUID(), expectedRevision: revisionOf(world, id), instructions: "Try again." }))(w, taskId) },
  slackAct("slack: retry the blocked step (registry step.retry; spends)", "blocked", "step.retry", offeredBinding("step.retry")),
  { name: "web: the Merge press (merges the pull request)", state: "pull request",
    prepare: async (w, taskId, pre) => {
      await w.linkGithubAsConnected(MAYA, "maya-gh");
      const ready = await w.maya("GET", `/v1/app/tasks/${taskId}/merge`);
      expect(ready.body, JSON.stringify(ready.body)).toMatchObject({ mayMerge: true, ready: true });
      pre.heads = ready.body.heads; pre.risk = ready.body.risk;
    },
    run: async (w, taskId, pre) => {
      const before = snapshot(w, taskId);
      const reply = await probed(w)("POST", `/v1/app/tasks/${taskId}/merge`, { requestId: randomUUID(), expectedHeads: pre.heads, risk: pre.risk });
      const outcome = webOutcome(w, taskId, before, reply);
      return { ...outcome, moved: outcome.moved || (pre.pullRequest as { draft: { state: string } }).draft.state !== "open" };
    } },
  { ...slackAct("slack: the Merge press (registry task.merge; merges the pull request)", "pull request", "task.merge", offeredBinding("task.merge")),
    prepare: async (w, taskId, pre) => {
      await w.linkGithubAsConnected(MAYA, "maya-gh");
      pre.binding = await offeredBinding("task.merge")(w, taskId);
    },
    run: async (w, taskId, pre) => {
      const outcome = await slackPress(w, taskId, "task.merge", pre.binding as never, {}, true);
      return { ...outcome, moved: outcome.moved || (pre.pullRequest as { draft: { state: string } }).draft.state !== "open" };
    } },
];

async function reach(w: JourneyWorld, state: State): Promise<{ taskId: string; pullRequest?: Awaited<ReturnType<typeof buildUntilPullRequest>> }> {
  const taskId = await startTask(w);
  if (state === "blocked") {
    // The plan's check (health.txt must exist) fails on a first run that writes the wrong file: the task is blocked at VERIFY (journey 8).
    await planUntilCard(w, taskId, { plan: FILE_CHECK_PLAN });
    await w.approvePlan(taskId);
    const first = await w.runStep("IMPLEMENT", [fauxAssistantMessage([fauxToolCall("bash", { command: "printf wrong > repo/demo/other.txt" })], { stopReason: "toolUse" }), fauxAssistantMessage("I added the health endpoint.")]);
    expect(first.operation.status, String(first.operation.error)).toBe("SUCCEEDED");
    expect(w.taskRow(taskId)!.workflow).toMatchObject({ stage: "VERIFY", state: "BLOCKED" });
    return { taskId };
  }
  await planUntilCard(w, taskId);
  if (state === "plan") return { taskId };
  await w.approvePlan(taskId);
  if (state === "running") {
    // A step is running: the worker's own run is instant in this world, so the task's state is the one a running step has (the only row this suite writes; the registry offers Stop only then).
    const row = w.harness.db.get(`DEVTASK#${taskId}`, "META")!;
    w.harness.db.set({ ...row, workflow: { ...(row.workflow as object), state: "RUNNING" } });
    return { taskId };
  }
  const pullRequest = await buildUntilPullRequest(w, taskId);
  await hostReady(w, pullRequest);
  return { taskId, pullRequest };
}

describe("a person who started a task (no People list) and is then removed cannot MOVE it", () => {
  for (const [label, scenario] of SCENARIOS) {
    describe(label, () => {
      for (const act of ACTS) {
        it(act.name, async () => {
          const w = await newWorld();
          const { taskId, pullRequest } = await reach(w, act.state);
          const pre: Record<string, unknown> = { pullRequest };
          await act.prepare?.(w, taskId, pre);
          await remove(w, scenario);
          const outcome = await act.run(w, taskId, pre);
          expect(outcome, `${act.name} as the removed person: ${outcome.answer}`).toMatchObject({ access: true, moved: false });
          w.proof.assertAllCore();
        }, 300_000);
      }
    });
  }

  for (const [label, scenario] of SCENARIOS) {
    it(`registry: no action's who rule lets the person in, ${label}`, async () => {
      const w = await newWorld();
      // Imported here, after the world exists: these modules pull in the registry's import cycle in a different order if they load first.
      const { deployedCallerFromMembership, membershipWithRoleFromDynamo } = await import("../../packages/broker/src/aws/core-engine-root.js");
      const { TASK_ACTION_ENTRIES } = await import("../../packages/broker/src/core/task-actions/entries.js");
      const { satisfies, standingOf } = await import("../../packages/broker/src/core/task-actions/standing.js");
      const { readTask } = await import("../../packages/broker/src/core/task-flow/reads.js");
      const taskId = await startTask(w);
      await planUntilCard(w, taskId);
      const deps = w.harness.runtime.flow.deps;
      const deployed = await deployedCallerFromMembership(membershipWithRoleFromDynamo(w.harness.db, "signin"))(CALLER);
      expect(deployed, "before a removal the person is a member").toBeDefined();
      const principal: Principal = deployed!.principal;
      await remove(w, scenario);
      const task = (await readTask(deps, taskId))!;
      const standing = await standingOf(deps, { principal, companyRole: "member" } as never, task);
      // `merge` and `take-over` are the host's own check (the Merge press above), `held` is never offered.
      const allowed = TASK_ACTION_ENTRIES.filter((entry) => !["merge", "take-over", "held"].includes(entry.who) && satisfies(entry.who, standing)).map((entry) => entry.id);
      expect(allowed, `registry actions whose who rule passes for the removed person (standing ${JSON.stringify(standing)})`).toEqual([]);
      w.proof.assertAllCore();
    }, 240_000);
  }
});
