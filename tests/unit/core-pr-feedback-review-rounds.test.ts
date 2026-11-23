// DEC 254zzz398 (Code half): (1) the AI review starts automatically on new PR comments, at most three rounds per task, enforced here on the server; after that the owner can still Retry a failed review or Keep;
// (2) the owner OR a co-owner may start a paid fix (the payer stays the task's); (3) Keep is final for its round, and posts nothing on GitHub; new comments start a new round (subject to the cap).
import { describe, expect, it, vi } from "vitest";
import { WORKFLOW_KEEP_PULL_REQUESTS_NOTE, WorkflowFeedbackReviewRefSchema, workflowFeedbackReviewRounds, WORKFLOW_FEEDBACK_AUTO_REVIEW_ROUNDS_MAX, type WorkflowFeedbackReviewRef } from "@agentx/contracts";
import { collectPrFeedback } from "../../packages/broker/src/core/pr-feedback/collect.js";
import { collectTrackedFeedback } from "../../packages/broker/src/core/pr-feedback/service.js";
import { dispatchPartition } from "../../packages/broker/src/core/task-flow/keys.js";
import { readTask } from "../../packages/broker/src/core/task-flow/reads.js";
import { toDocument } from "../../packages/broker/src/core/task-flow/records.js";
import { hostedFeedbackWorld, type FeedbackRouteBody } from "../support/hosted-pr-feedback-world.js";

type World = Awaited<ReturnType<typeof hostedFeedbackWorld>>;
const keepBody = (w: World) => ({ ...w.request, decision: "DISMISS" as const, selectedFindingIds: [], ownerNote: WORKFLOW_KEEP_PULL_REQUESTS_NOTE });

/** An earlier, different round of review: the current report's shape over another set of bundles (digests swapped consistently, so every schema still reads it). */
function earlierRound(ref: WorkflowFeedbackReviewRef, n: number): WorkflowFeedbackReviewRef {
  const bundle = ref.bundleDigests[0]!;
  const nextBundle = `${n.toString(16)}b`.repeat(32).slice(0, 64);
  const nextSha = `${n.toString(16)}a`.repeat(32).slice(0, 64);
  return WorkflowFeedbackReviewRefSchema.parse(JSON.parse(JSON.stringify(ref).replaceAll(bundle, nextBundle).replaceAll(ref.sha256, nextSha)));
}

/** The owner kept the current round; `earlier` more rounds were reviewed before it; and one more comment has arrived on the pull request. */
async function newCommentAfterKeptRound(earlier: number, status: "COMPLETE" | "BLOCKED" = "COMPLETE") {
  const w = await hostedFeedbackWorld(status);
  if (status === "COMPLETE") expect((await w.send("POST", "/workflow/feedback-decision", keepBody(w)))?.statusCode).toBe(200);
  const task = (await readTask(w.h.deps, w.task.taskId))!;
  const ref = task.workflow!.feedbackReview!.reviewRef!;
  task.workflow!.feedbackReviewHistory = Array.from({ length: earlier }, (_, index) => earlierRound(ref, index + 1));
  await w.h.store.put({ item: toDocument(task) });
  w.feedback.comments.push({ id: "comment-2", kind: "discussion", url: "https://github.com/acme/app/pull/1#issuecomment-2", author: "reviewer", updatedAt: new Date(w.clock.ms).toISOString(), body: "One more thing." });
  return w;
}
const collect = async (w: World) => collectPrFeedback(w.deps, (await readTask(w.h.deps, w.task.taskId))!, w.budget);
const rows = async (w: World) => (await w.h.store.query({ pk: dispatchPartition(w.h.deps.companyId) })).items;

describe("at most three automatic review rounds per task, counted on the server", () => {
  it("counts one round per distinct set of reviewed bundles; a retry or request-changes reviews the same bundles", async () => {
    const w = await hostedFeedbackWorld();
    const workflow = (await readTask(w.h.deps, w.task.taskId))!.workflow!;
    expect(WORKFLOW_FEEDBACK_AUTO_REVIEW_ROUNDS_MAX).toBe(3);
    expect(workflowFeedbackReviewRounds(workflow)).toBe(1);
    const ref = workflow.feedbackReview!.reviewRef!;
    expect(workflowFeedbackReviewRounds({ ...workflow, feedbackReviewHistory: [ref] })).toBe(1);
    expect(workflowFeedbackReviewRounds({ ...workflow, feedbackReviewHistory: [ref, earlierRound(ref, 1), earlierRound(ref, 2)] })).toBe(3);
    expect(workflowFeedbackReviewRounds({ ...workflow, feedbackReview: undefined, feedbackReviewHistory: [] })).toBe(0);
  });

  it.each([0, 1])("new comments after a kept round start the next round (with %i earlier rounds): one collection, one review dispatch", async earlier => {
    const w = await newCommentAfterKeptRound(earlier);
    expect(await rows(w)).toEqual([]);
    expect(await collect(w)).toBe("collected");
    expect((await readTask(w.h.deps, w.task.taskId))!.workflow!.feedbackReview).toMatchObject({ status: "COLLECTING" });
    expect((await rows(w)).filter(row => row["kind"] === "REVIEW")).toHaveLength(1);
    expect(workflowFeedbackReviewRounds((await readTask(w.h.deps, w.task.taskId))!.workflow!)).toBe(earlier + 2);
  });

  it("the fourth automatic review is refused: nothing is saved, dispatched, admitted or written", async () => {
    const w = await newCommentAfterKeptRound(2);
    const before = await readTask(w.h.deps, w.task.taskId);
    expect(workflowFeedbackReviewRounds(before!.workflow!)).toBe(3);
    const writes = [vi.spyOn(w.h.store, "transact"), vi.spyOn(w.h.store, "put"), vi.spyOn(w.h.store, "update"), vi.spyOn(w.h.store, "delete")];
    w.put.mockClear();
    const start = vi.spyOn(w.h.deps.machines, "start"), queue = vi.spyOn(w.h.deps.queues, "queue");
    expect(await collect(w)).toBe("unchanged");
    for (const write of writes) expect(write).not.toHaveBeenCalled();
    expect(w.put).not.toHaveBeenCalled();
    expect(w.admit).not.toHaveBeenCalled(); expect(w.held.size).toBe(0);
    expect(start).not.toHaveBeenCalled(); expect(queue).not.toHaveBeenCalled();
    expect(await rows(w)).toEqual([]);
    expect(await readTask(w.h.deps, w.task.taskId)).toEqual(before);
    // Every later pass refuses the same way: no card spam.
    expect(await collect(w)).toBe("unchanged");
    expect(await rows(w)).toEqual([]);
  });

  it("the cap holds through the served tracking entry too (the scheduled pass), not only the direct collector", async () => {
    const w = await newCommentAfterKeptRound(2);
    expect(await collectTrackedFeedback({ ...w.deps, flow: w.h.deps, registry: w.registry }, (await readTask(w.h.deps, w.task.taskId))!, w.budget)).toBe("unchanged");
    expect(await rows(w)).toEqual([]);
    expect(w.admit).not.toHaveBeenCalled();
  });

  it("a different task's rounds never count: a task with one round reviews while another is at its cap", async () => {
    for (const earlier of [2, 0, 1]) {
      const w = await newCommentAfterKeptRound(earlier);
      expect(await collect(w)).toBe(earlier === 2 ? "unchanged" : "collected");
    }
    // Run again in a different order in the same process: a count kept across tasks would carry over.
    for (const earlier of [0, 0, 0, 0]) expect(await collect(await newCommentAfterKeptRound(earlier))).toBe("collected");
  });

  it("comments that did not change start nothing, before or after the cap", async () => {
    const w = await newCommentAfterKeptRound(0);
    w.feedback.comments.pop();
    expect(await collect(w)).toBe("unchanged");
    expect(await rows(w)).toEqual([]);
  });

  it("after the cap the owner can still Retry a failed review: it runs once, with the task's cap and admission", async () => {
    const w = await newCommentAfterKeptRound(2, "BLOCKED");
    w.feedback.comments.pop();
    expect(workflowFeedbackReviewRounds((await readTask(w.h.deps, w.task.taskId))!.workflow!)).toBe(3);
    expect(await collect(w)).toBe("unchanged");
    const answer = await w.send("POST", "/workflow/feedback-retry", { reviewDigest: w.request.reviewDigest });
    expect(answer?.statusCode).toBe(200);
    expect((JSON.parse(answer!.body) as FeedbackRouteBody).started).toBe(true);
    expect((await rows(w)).filter(row => row["kind"] === "REVIEW")).toHaveLength(1);
    expect(w.admit).toHaveBeenCalledOnce();
    expect((await readTask(w.h.deps, w.task.taskId))!.workflow!.feedbackReview).toMatchObject({ status: "COLLECTING" });
    // The same round: a Retry does not use up another.
    expect(workflowFeedbackReviewRounds((await readTask(w.h.deps, w.task.taskId))!.workflow!)).toBe(3);
    // ...and a second press of the same Retry starts nothing more.
    const again = await w.send("POST", "/workflow/feedback-retry", { reviewDigest: w.request.reviewDigest });
    expect((JSON.parse(again!.body) as FeedbackRouteBody).started).toBe(false);
    expect((await rows(w)).filter(row => row["kind"] === "REVIEW")).toHaveLength(1);
  });

  it("after the cap a manual Retry is still held to the task's spending cap", async () => {
    const w = await newCommentAfterKeptRound(2, "BLOCKED");
    w.h.deps.taskSpendUsd = async () => 10;
    const answer = await w.send("POST", "/workflow/feedback-retry", { reviewDigest: w.request.reviewDigest });
    expect(answer?.statusCode).toBe(402);
    expect(await rows(w)).toEqual([]);
  });
});

describe("Keep is final for its round", () => {
  /** A host that records every call but the read of the pull request's feedback. */
  function watchHost(w: World): string[] {
    const calls: string[] = [];
    const home = w.registry.require("code-host");
    const watched = new Proxy(home, { get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" && property !== "feedback" ? (...args: unknown[]) => { calls.push(String(property)); return (value as (...rest: unknown[]) => unknown).apply(target, args); } : value;
    } });
    w.registry.unregister("code-host", "github");
    w.registry.register("code-host", "github", watched);
    return calls;
  }

  it("after Keep the same round cannot be approved, changed, kept or retried: each refuses with no paid work", async () => {
    const w = await hostedFeedbackWorld();
    expect((await w.send("POST", "/workflow/feedback-decision", keepBody(w)))?.statusCode).toBe(200);
    w.admit.mockClear();
    const kept = await readTask(w.h.deps, w.task.taskId);
    const writes = [vi.spyOn(w.h.store, "transact")];
    const start = vi.spyOn(w.h.deps.machines, "start");
    const next = kept!.workflow!.revision;
    const attempts: Array<[string, unknown]> = [
      ["/workflow/feedback-decision", { ...w.request, requestId: "11111111-1111-4111-8111-111111111111", expectedRevision: next }],
      ["/workflow/feedback-decision", { ...w.request, requestId: "22222222-2222-4222-8222-222222222222", expectedRevision: next, decision: "REQUEST_CHANGES", selectedFindingIds: [], ownerNote: "Look again." }],
      ["/workflow/feedback-decision", { ...w.request, requestId: "33333333-3333-4333-8333-333333333333", expectedRevision: next, decision: "DISMISS", selectedFindingIds: [], ownerNote: WORKFLOW_KEEP_PULL_REQUESTS_NOTE }],
      ["/workflow/feedback-retry", { reviewDigest: w.request.reviewDigest }],
      ["/workflow/keep-pull-requests", { requestId: "44444444-4444-4444-8444-444444444444", expectedRevision: next }],
    ];
    for (const [route, body] of attempts) {
      const answer = await w.send("POST", route, body);
      expect(answer?.statusCode, route).toBeGreaterThanOrEqual(400);
      expect(writes[0], route).not.toHaveBeenCalled();
    }
    expect(w.admit).not.toHaveBeenCalled(); expect(w.held.size).toBe(0);
    expect(start).not.toHaveBeenCalled();
    expect(await rows(w)).toEqual([]);
    expect(await readTask(w.h.deps, w.task.taskId)).toEqual(kept);
  });

  it("a failed review the owner kept cannot be retried afterwards: refused, no paid work", async () => {
    const w = await hostedFeedbackWorld("BLOCKED");
    expect((await w.send("POST", "/workflow/feedback-decision", keepBody(w)))?.statusCode).toBe(200);
    w.admit.mockClear();
    const kept = await readTask(w.h.deps, w.task.taskId);
    const answer = await w.send("POST", "/workflow/feedback-retry", { reviewDigest: w.request.reviewDigest });
    expect(answer?.statusCode).toBeGreaterThanOrEqual(400);
    expect(w.admit).not.toHaveBeenCalled();
    expect(await rows(w)).toEqual([]);
    expect(await readTask(w.h.deps, w.task.taskId)).toEqual(kept);
  });

  it("the same Keep request repeats safely: one dismissal, one revision", async () => {
    const w = await hostedFeedbackWorld();
    for (let press = 0; press < 3; press++) expect((await w.send("POST", "/workflow/feedback-decision", keepBody(w)))?.statusCode).toBe(200);
    const task = (await readTask(w.h.deps, w.task.taskId))!;
    expect(task.workflow!.feedbackDecisions).toHaveLength(1);
    expect(task.workflow!.revision).toBe(w.request.expectedRevision + 1);
  });

  it("Keep posts nothing on GitHub: the host sees only the read of the feedback", async () => {
    const w = await hostedFeedbackWorld();
    const calls = watchHost(w);
    expect((await w.send("POST", "/workflow/feedback-decision", keepBody(w)))?.statusCode).toBe(200);
    expect(calls.filter(name => /comment|reply|post|create|update|merge|push|react|resolve|label|review/iu.test(name))).toEqual([]);
  });

  it("the collecting Keep posts nothing on GitHub either", async () => {
    const w = await hostedFeedbackWorld("BLOCKED");
    w.task.workflow!.feedbackReview = { status: "COLLECTING", bundleRefs: w.task.workflow!.feedbackReview!.bundleRefs, threadObservations: [] };
    await w.h.store.put({ item: toDocument(w.task) });
    const calls = watchHost(w);
    expect((await w.send("POST", "/workflow/keep-pull-requests", { requestId: w.request.requestId, expectedRevision: w.task.workflow!.revision }))?.statusCode).toBe(200);
    expect(calls.filter(name => /comment|reply|post|create|update|merge|push|react|resolve|label|review/iu.test(name))).toEqual([]);
  });

  it("the same comments after Keep start no new round; NEW comments do (subject to the cap)", async () => {
    const w = await hostedFeedbackWorld();
    expect((await w.send("POST", "/workflow/feedback-decision", keepBody(w)))?.statusCode).toBe(200);
    expect(await collect(w)).toBe("unchanged");
    expect(await rows(w)).toEqual([]);
    w.feedback.comments.push({ id: "comment-2", kind: "discussion", url: "https://github.com/acme/app/pull/1#issuecomment-2", author: "reviewer", updatedAt: new Date(w.clock.ms).toISOString(), body: "One more thing." });
    expect(await collect(w)).toBe("collected");
    expect((await rows(w)).filter(row => row["kind"] === "REVIEW")).toHaveLength(1);
    expect(workflowFeedbackReviewRounds((await readTask(w.h.deps, w.task.taskId))!.workflow!)).toBe(2);
  });
});

describe("the owner or a co-owner may start a paid fix; the payer stays the task's", () => {
  const CO_OWNER = "c".repeat(64);
  async function coOwnerWorld() {
    const w = await hostedFeedbackWorld();
    w.caller.principal = { ...w.caller.principal, personId: CO_OWNER, roles: ["member"] };
    w.h.deps.access.canAct = async () => true;
    w.h.deps.access.ownerActing = async principal => principal.personId === CO_OWNER ? { actorId: CO_OWNER, authority: { actorId: CO_OWNER, ownerIds: [CO_OWNER] } } : undefined;
    return w;
  }

  it("an authorized co-owner's Fix starts the one paid run, recorded under the co-owner, on the task's own payer", async () => {
    const w = await coOwnerWorld();
    const before = (await readTask(w.h.deps, w.task.taskId))!;
    const answer = await w.send("POST", "/workflow/feedback-decision", w.request);
    expect(answer?.statusCode).toBe(200);
    const task = (await readTask(w.h.deps, w.task.taskId))!;
    expect(task.workflow!.feedbackDecisions).toEqual([expect.objectContaining({ decision: "APPROVE", actorId: CO_OWNER, actorRole: "TASK_OWNER", selectedFindingIds: ["finding-1"] })]);
    expect(task.workflow).toMatchObject({ stage: "IMPLEMENT", state: "READY" });
    expect((await rows(w)).filter(row => row["kind"] === "IMPLEMENT")).toHaveLength(1);
    expect(w.admit).toHaveBeenCalledOnce();
    expect(w.admit.mock.calls[0]![0]).toMatchObject({ actor: { personId: CO_OWNER }, subject: { type: "task", id: w.task.taskId } });
    // The payer is the task's, never the person who pressed.
    expect(task.charge).toEqual(before.charge);
    expect(task.developerId).toBe(before.developerId);
    expect(w.h.audit.find(event => event.action === "task.feedback_decided")).toMatchObject({ actor: { type: "person", id: CO_OWNER } });
  });

  it("a person who is no owner of the task (a reader, a company admin) cannot start it", async () => {
    const w = await coOwnerWorld();
    w.h.deps.access.ownerActing = async () => undefined;
    w.membership.role = "admin";
    const answer = await w.send("POST", "/workflow/feedback-decision", w.request);
    expect(answer?.statusCode).toBe(404);
    expect(w.admit).not.toHaveBeenCalled();
    expect(await rows(w)).toEqual([]);
  });

  it("a co-owner revoked before the commit starts nothing", async () => {
    const w = await coOwnerWorld();
    const acting = vi.fn<NonNullable<typeof w.h.deps.access.ownerActing>>();
    acting.mockResolvedValueOnce({ actorId: CO_OWNER, authority: { actorId: CO_OWNER, ownerIds: [CO_OWNER] } }).mockResolvedValue(undefined);
    w.h.deps.access.ownerActing = acting;
    const answer = await w.send("POST", "/workflow/feedback-decision", w.request);
    expect(answer?.statusCode).toBeGreaterThanOrEqual(400);
    expect(await rows(w)).toEqual([]);
    expect((await readTask(w.h.deps, w.task.taskId))!.workflow!.feedbackDecisions ?? []).toEqual([]);
  });
});
