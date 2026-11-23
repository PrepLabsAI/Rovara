import { toDocument } from "../../packages/broker/src/core/task-flow/records.js";
import { expect, it, vi } from "vitest";
import { change } from "@agentx/contracts";
import { ORG } from "../support/service-host.js";
import { feedbackWorld as world } from "../support/pr-feedback-world.js";
import { TASK_ID } from "../support/merge-world.js";
import { collectPrFeedback, feedbackUnchanged, readCurrentFeedback } from "../../packages/broker/src/core/pr-feedback/collect.js";
import { engineStampKey } from "../../packages/broker/src/core-host/engine-stamp.js";
import { dispatchPartition } from "../../packages/broker/src/core/task-flow/keys.js";
import { readTask } from "../../packages/broker/src/core/task-flow/reads.js";

it("archived suppression rejects oversized exact bytes even from an adapter ignoring its read limit", async () => {
  const { reviewedFeedbackWorld } = await import("../support/pr-feedback-world.js");
  const { feedbackDigest, feedbackPrefix } = await import("../../packages/broker/src/core/pr-feedback/artifacts.js");
  const w = await reviewedFeedbackWorld();
  const wf = w.task.workflow!, old = wf.feedbackReview!.bundleRefs[0]!, review = wf.feedbackReview!.reviewRef!;
  const bytes = Buffer.from(" ".repeat(1_000_001) + Buffer.from(w.objects.get(old.objectKey)!).toString("utf8"));
  const digest = feedbackDigest(bytes);
  w.objects.set(`${feedbackPrefix(w.task)}${digest}.json`, bytes);
  w.task.workflow = { ...wf, feedbackReview: undefined, feedbackReviewHistory: [{ ...review, bundleDigests: [digest],
    candidateBindings: review.candidateBindings.map(b => ({ ...b, bundleDigest: digest })), findingRefs: review.findingRefs.map(f => ({ ...f, bundleDigest: digest })) }] };
  expect(await collectPrFeedback(w.deps, w.task, w.budget)).toBe("retry");
});

it("an unchanged complete owner card performs no recollection or artifact writes", async () => {
  const { reviewedFeedbackWorld } = await import("../support/pr-feedback-world.js");
  const w = await reviewedFeedbackWorld();
  w.h.clock.advance(60);
  w.put.mockClear();
  const transact = vi.spyOn(w.h.store, "transact");
  expect(await collectPrFeedback(w.deps, w.task, w.budget)).toBe("unchanged");
  expect(w.put).not.toHaveBeenCalled();
  expect(transact).not.toHaveBeenCalled();
});

it("an empty host observation does not erase earlier thread observations", async () => {
  const w = await world();
  w.feedback.comments[0] = { ...w.feedback.comments[0]!, kind: "review_comment", threadId: "thread" };
  w.feedback.threads = [{ id: "thread", resolved: true, commentIds: ["comment-1"] }];
  await collectPrFeedback(w.deps, w.task, w.budget);
  const task = (await readTask(w.h.deps, w.task.taskId))!;
  w.feedback.comments = []; w.feedback.threads = [];
  expect(await collectPrFeedback(w.deps, task, w.budget)).toBe("unchanged");
  expect((await readTask(w.h.deps, task.taskId))!.workflow).toEqual(task.workflow);
});


it("collects neutral-only core feedback and queues exactly one REVIEW atomically", async () => {
  const w = await world();
  expect(await collectPrFeedback(w.deps, w.task, w.budget)).toBe("collected");
  const next = (await readTask(w.h.deps, TASK_ID))!;
  expect(next.workflow!.feedbackReview?.status).toBe("COLLECTING");
  expect(next.workflow!.feedbackReview?.bundleRefs[0]?.comments).toHaveLength(1);
  expect(w.put).toHaveBeenCalledTimes(1);
  const rows = await w.h.store.query({ pk: dispatchPartition(ORG), sk: { op: "beginsWith", prefix: "" } });
  expect(rows.items).toHaveLength(1);
  expect(rows.items[0]).toMatchObject({ kind: "REVIEW", workflowRevision: next.workflow!.revision });
  w.read.mockClear();
  expect(await collectPrFeedback(w.deps, next, w.budget)).toBe("unchanged");
  expect(w.read).not.toHaveBeenCalled();
  expect(w.put).toHaveBeenCalledTimes(1);
});

it("collects an unresolved inline thread without requiring an earlier observation", async () => {
  const w = await world();
  w.feedback.comments[0] = { ...w.feedback.comments[0]!, kind: "review_comment", threadId: "t" };
  w.feedback.threads = [{ id: "t", resolved: false, commentIds: ["comment-1"] }];
  await collectPrFeedback(w.deps, w.task, w.budget);
  const task = (await readTask(w.h.deps, w.task.taskId))!;
  expect(task.workflow!.feedbackReview?.bundleRefs[0]!.comments.map(c => c.id)).toEqual(["comment-1"]);
});

it.each(["reopened", "unchanged-unresolved"])("previously reviewed inline comments handle %s threads", async kind => {
  const { reviewedFeedbackWorld } = await import("../support/pr-feedback-world.js");
  const w = await reviewedFeedbackWorld("COMPLETE", undefined, undefined, input => {
    input.feedback.comments[0] = { ...input.feedback.comments[0]!, kind: "review_comment", threadId: "t" };
    input.feedback.threads = [{ id: "t", resolved: false, commentIds: ["comment-1"] }];
  });
  const wf = w.task.workflow!;
  const review = wf.feedbackReview!;
  const observations = review.threadObservations!.map(o => kind === "reopened" ? { ...o, resolved: true, eligibleCommentIds: [] } : o);
  w.task.workflow = { ...wf, feedbackReview: undefined, feedbackReviewHistory: [review.reviewRef!], feedbackThreadObservations: observations };
  await w.h.store.put({ item: toDocument(w.task) });
  expect(await collectPrFeedback(w.deps, w.task, w.budget)).toBe(kind === "reopened" ? "collected" : "unchanged");
  expect((await readTask(w.h.deps, w.task.taskId))!.workflow!.feedbackReview?.status).toBe(kind === "reopened" ? "COLLECTING" : undefined);
});

it.each(["foreign-company", "missing-stamp", "retired-stamp", "foreign-link", "stale-link"])("refuses %s before host or artifact writes", async (kind) => {
  const w = await world();
  if (kind === "foreign-company") {
    w.task.companyId = "org_bbbbbbbbbbbbbbbbbbbb";
    await w.h.store.update({ key: engineStampKey(TASK_ID), ops: [change.set("orgId", w.task.companyId)] });
  }
  if (kind === "missing-stamp") await w.h.store.delete({ key: engineStampKey(TASK_ID) });
  if (kind === "retired-stamp") await w.h.store.update({ key: engineStampKey(TASK_ID), ops: [change.set(["coreEngine", "areas", "flow"], "workflow")] });
  if (kind === "foreign-link") await w.h.store.update({ key: w.link, ops: [change.set("taskId", "22222222-2222-4222-8222-222222222222")] });
  if (kind === "stale-link") await w.h.store.update({ key: w.link, ops: [change.set("candidateDigest", "0".repeat(64))] });
  expect(await collectPrFeedback(w.deps, w.task, w.budget)).toBe("retry");
  expect(w.read).not.toHaveBeenCalled();
  expect(w.put).not.toHaveBeenCalled();
});

it.each(["tree", "read", "duplicate-thread", "missing-thread-member", "missing-thread"])("keeps %s failures from creating partial cards", async (kind) => {
  const w = await world();
  if (kind === "tree") w.feedback.changeRequest.headTreeRevision = "f".repeat(40);
  if (kind === "read") w.read.mockRejectedValue(new Error("unavailable"));
  if (kind === "duplicate-thread") w.feedback.threads = [{ id: "t", resolved: false, commentIds: [] }, { id: "t", resolved: true, commentIds: [] }];
  if (kind === "missing-thread-member") w.feedback.threads = [{ id: "t", resolved: false, commentIds: ["absent"] }];
  if (kind === "missing-thread") w.feedback.comments[0] = { ...w.feedback.comments[0]!, kind: "review_comment", threadId: "absent" };
  expect(await collectPrFeedback(w.deps, w.task, w.budget)).toBe("retry");
  expect(w.put).not.toHaveBeenCalled();
  expect((await readTask(w.h.deps, TASK_ID))!.workflow).toEqual(w.task.workflow);
});

it("remembers resolved-only observations once, then an unchanged delivery writes nothing", async () => {
  const w = await world();
  w.feedback.comments[0] = { ...w.feedback.comments[0]!, kind: "review_comment", threadId: "t" };
  w.feedback.threads = [{ id: "t", resolved: true, commentIds: ["comment-1"] }];
  expect(await collectPrFeedback(w.deps, w.task, w.budget)).toBe("collected");
  expect(w.put).not.toHaveBeenCalled();
  const observed = (await readTask(w.h.deps, TASK_ID))!;
  expect(observed.workflow!.feedbackReview).toBeUndefined();
  expect(observed.workflow!.feedbackThreadObservations).toHaveLength(1);
  expect(await collectPrFeedback(w.deps, observed, w.budget)).toBe("unchanged");
  expect((await readTask(w.h.deps, TASK_ID))!.workflow).toEqual(observed.workflow);
  w.feedback.comments[0].body = "An edited failure inside the resolved thread.";
  expect(await collectPrFeedback(w.deps, observed, w.budget)).toBe("collected");
});

it("refuses comments outside the pinned pull request before writing evidence", async () => {
  const w = await world();
  w.feedback.comments[0]!.url = "https://github.com/other/repo/pull/1#issuecomment-1";
  expect(await collectPrFeedback(w.deps, w.task, w.budget)).toBe("retry");
  expect(w.put).not.toHaveBeenCalled();
});

it.each(["missing-link", "pull-request", "path", "query"])("retains the existing host feedback contract for a %s comment URL", async kind => {
  const w = await world();
  const url = w.task.workflow!.pullRequests![0]!.url;
  w.feedback.comments[0]!.url = kind === "missing-link" ? "" : kind === "pull-request" ? url : kind === "path" ? `${url}/comments/1` : `${url}?discussionId=1`;
  expect(await collectPrFeedback(w.deps, w.task, w.budget)).toBe("collected");
  expect((await readTask(w.h.deps, w.task.taskId))!.workflow!.feedbackReview?.bundleRefs[0]!.comments[0]!.url).toBe(kind === "missing-link" ? url : w.feedback.comments[0]!.url);
});

it("refuses an incomplete published candidate set before any host read", async () => {
  const w = await world();
  w.task.workflow!.candidate!.repositories.push({ ...w.task.workflow!.candidate!.repositories[0]!, repositoryId: "missing" });
  expect(await collectPrFeedback(w.deps, w.task, w.budget)).toBe("retry");
  expect(w.read).not.toHaveBeenCalled();
  expect(w.put).not.toHaveBeenCalled();
});

it("suppresses dismissed identical evidence, but recollects edits and reopened threads", async () => {
  const w = await world();
  expect(await collectPrFeedback(w.deps, w.task, w.budget)).toBe("collected");
  const current = (await readTask(w.h.deps, TASK_ID))!;
  // Suppression uses immutable identities, including body digests, regardless of the previous card's disposition.
  expect(await collectPrFeedback(w.deps, current, w.budget)).toBe("unchanged");
  current.workflow!.feedbackReview = undefined;
  current.workflow!.feedbackThreadObservations = [{ repositoryId: "app", number: 1, threadId: "t", resolved: true,
    comments: [], eligibleCommentIds: [] }];
  w.feedback.comments[0] = { ...w.feedback.comments[0]!, kind: "review_comment", threadId: "t" };
  w.feedback.threads = [{ id: "t", resolved: false, commentIds: ["comment-1"] }];
  await w.h.store.update({ key: { pk: `DEVTASK#${TASK_ID}`, sk: "META" }, ops: [change.set("workflow", toDocument(current.workflow!))] });
  expect(await collectPrFeedback(w.deps, current, w.budget)).toBe("collected");
});


it("does not write partial evidence when a second pinned PR cannot be read", async () => {
  const w = await world({ repositories: ["app", "api"] });
  w.reads.get("api")!.mockRejectedValue(new Error("unavailable"));
  expect(await collectPrFeedback(w.deps, w.task, w.budget)).toBe("retry");
  expect(w.read).toHaveBeenCalledOnce();
  expect(w.put).not.toHaveBeenCalled();
  expect((await readTask(w.h.deps, TASK_ID))!.workflow).toEqual(w.task.workflow);
});

it.each(["outdated-line", "new-comment"])("archived reviewed identities handle %s without losing new feedback", async kind => {
  const { reviewedFeedbackWorld } = await import("../support/pr-feedback-world.js");
  const w = await reviewedFeedbackWorld();
  const wf = w.task.workflow!;
  const archived = { ...wf, feedbackReview: undefined, feedbackReviewHistory: [wf.feedbackReview!.reviewRef!] };
  w.task.workflow = archived;
  await w.h.store.update({ key: w.task, ops: [change.set("workflow", toDocument(archived))] });
  w.feedback.comments[0]!.line = 5;
  if (kind === "new-comment") w.feedback.comments.push({ ...w.feedback.comments[0]!, id: "comment-2", url: `${w.task.workflow.pullRequests![0]!.url}#comment-2`, body: "A different failure needs attention." });
  expect(await collectPrFeedback(w.deps, w.task, w.budget)).toBe(kind === "new-comment" ? "collected" : "unchanged");
});

it.each(["closed", "released", "wrong-stage", "not-waiting", "no-candidate", "no-open-pr"])("does not collect %s tasks", async kind => {
  const w = await world();
  if (kind === "closed") w.task.closedAt = new Date(w.clock.ms).toISOString();
  if (kind === "released") w.task.releasedAt = new Date(w.clock.ms).toISOString();
  if (kind === "wrong-stage") w.task.workflow!.stage = "IMPLEMENT";
  if (kind === "not-waiting") w.task.workflow!.state = "RUNNING";
  if (kind === "no-candidate") w.task.workflow!.candidate = undefined;
  if (kind === "no-open-pr") w.task.workflow!.pullRequests = [];
  expect(await collectPrFeedback(w.deps, w.task, w.budget)).toBe("unchanged");
  expect(w.read).not.toHaveBeenCalled();
  expect(w.put).not.toHaveBeenCalled();
});

it("empty host feedback leaves watching unchanged without artifacts", async () => {
  const w = await world();
  w.feedback.comments = [];
  expect(await collectPrFeedback(w.deps, w.task, w.budget)).toBe("unchanged");
  expect(w.put).not.toHaveBeenCalled();
});

it.each(["duplicate-comments", "duplicate-thread-members", "missing-member"])("validates %s before projecting thread evidence", async kind => {
  const w = await world();
  const reason = kind === "duplicate-comments" ? "duplicate feedback comment identity" : kind === "duplicate-thread-members" ? "duplicate feedback thread membership" : "feedback thread membership is incomplete";
  if (kind === "duplicate-comments") w.feedback.comments.push({ ...w.feedback.comments[0]! });
  if (kind === "duplicate-thread-members") {
    w.feedback.comments[0] = { ...w.feedback.comments[0]!, kind: "review_comment", threadId: "t" };
    w.feedback.threads = [{ id: "t", resolved: false, commentIds: ["comment-1", "comment-1"] }];
  }
  if (kind === "missing-member") w.feedback.threads = [{ id: "t", resolved: false, commentIds: ["absent"] }];
  await expect(readCurrentFeedback(w.deps, w.task, w.budget)).rejects.toThrow(reason);
  expect(w.put).not.toHaveBeenCalled();
});

it("a cancelled read returns immediately and removes its timer and abort listener", async () => {
  const w = await world();
  const controller = new AbortController();
  controller.abort();
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  w.read.mockImplementation(() => new Promise(() => undefined));
  vi.useFakeTimers();
  try {
    let settled = false;
    const result = readCurrentFeedback(w.deps, w.task, { signal: controller.signal, beforeRequest: () => undefined }).catch(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    await result;
  } finally { vi.useRealTimers(); }
});

it("an uncancelled asynchronous host read can finish inside its deadline", async () => {
  const w = await world();
  w.read.mockImplementation(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 5));
    return w.feedback;
  });
  vi.useFakeTimers();
  try {
    const result = collectPrFeedback(w.deps, w.task, w.budget);
    await vi.advanceTimersByTimeAsync(5);
    expect(await result).toBe("collected");
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

it("host throttling preserves the scheduled retry time without partial evidence", async () => {
  const { HostRateLimitError } = await import("@agentx/contracts");
  const w = await world();
  const error = new HostRateLimitError(w.clock.ms + 60_000);
  w.read.mockRejectedValue(error);
  await expect(collectPrFeedback(w.deps, w.task, w.budget)).rejects.toBe(error);
  expect(w.put).not.toHaveBeenCalled();
});

it("reopened threads invalidate even a matching collected comment digest", async () => {
  const w = await world();
  await collectPrFeedback(w.deps, w.task, w.budget);
  const task = (await readTask(w.h.deps, TASK_ID))!;
  const { WorkflowFeedbackBundleSchema } = await import("@agentx/contracts");
  const ref = task.workflow!.feedbackReview!.bundleRefs[0]!;
  const bundle = WorkflowFeedbackBundleSchema.parse(JSON.parse(Buffer.from(w.objects.get(ref.objectKey)!).toString("utf8")));
  expect(feedbackUnchanged(task.workflow!, [bundle], false)).toBe(true);
  expect(feedbackUnchanged(task.workflow!, [bundle], true)).toBe(false);
  task.workflow!.feedbackReview = undefined;
  expect(feedbackUnchanged(task.workflow!, [{ ...bundle, comments: [] }], false)).toBe(true);
  expect(feedbackUnchanged(task.workflow!, [bundle], false)).toBe(false);
});

it("unchanged feedback requires every pull request to match, including when only one changed", async () => {
  const w = await world({ repositories: ["app", "api"] });
  await collectPrFeedback(w.deps, w.task, w.budget);
  const task = (await readTask(w.h.deps, w.task.taskId))!;
  w.feedback.comments[0]!.body = "A fresh edit on one pull request.";
  const fresh = await readCurrentFeedback(w.deps, task, w.budget);
  expect(feedbackUnchanged(task.workflow!, fresh.bundles, false)).toBe(false);
  const review = task.workflow!.feedbackReview!;
  task.workflow!.feedbackReview = undefined;
  const { lifecycleReport, saveFeedbackReport } = await import("../../packages/broker/src/core/pr-feedback/recovery.js");
  const report = lifecycleReport({ ...task, workflow: { ...task.workflow!, feedbackReview: review } },
    { id: "99999999-9999-4999-8999-999999999999", workflowRevision: task.workflow!.revision }, new Date(w.clock.ms).toISOString(), "Fixture");
  report.status = "COMPLETE";
  delete report.blockReason;
  task.workflow!.feedbackReviewHistory = [await saveFeedbackReport(w.h.deps, task, report)];
  expect(feedbackUnchanged(task.workflow!, fresh.bundles, false)).toBe(false);
});

it.each(["candidate", "repository"])("fresh feedback refuses a missing %s before reading the host", async kind => {
  const w = await world();
  if (kind === "candidate") w.task.workflow!.candidate = undefined;
  if (kind === "repository") w.deps.repository = async () => undefined;
  await expect(readCurrentFeedback(w.deps, w.task, w.budget)).rejects.toThrow(kind === "candidate" ? "feedback candidate is missing" : "feedback evidence does not match the pinned candidate");
  expect(w.read).not.toHaveBeenCalled();
});

it.each(["digest", "foreign-task"])("archived suppression refuses %s evidence", async kind => {
  const { reviewedFeedbackWorld } = await import("../support/pr-feedback-world.js");
  const { feedbackDigest, feedbackPrefix } = await import("../../packages/broker/src/core/pr-feedback/artifacts.js");
  const { WorkflowFeedbackBundleSchema } = await import("@agentx/contracts");
  const w = await reviewedFeedbackWorld();
  const wf = w.task.workflow!;
  const ref = wf.feedbackReview!.bundleRefs[0]!;
  const report = wf.feedbackReview!.reviewRef!;
  w.task.workflow = { ...wf, feedbackReview: undefined, feedbackReviewHistory: [report] };
  const text = Buffer.from(w.objects.get(ref.objectKey)!).toString("utf8");
  if (kind === "digest") w.objects.set(ref.objectKey, Buffer.from(`\n${text}`));
  if (kind === "foreign-task") {
    const bundle = WorkflowFeedbackBundleSchema.parse(JSON.parse(text));
    bundle.taskId = "99999999-9999-4999-8999-999999999999";
    const changed = JSON.stringify(bundle);
    const digest = feedbackDigest(changed);
    report.candidateBindings[0]!.bundleDigest = digest;
    w.objects.set(`${feedbackPrefix(w.task)}${digest}.json`, Buffer.from(changed));
  }
  w.put.mockClear();
  expect(await collectPrFeedback(w.deps, w.task, w.budget)).toBe("retry");
  expect(w.put).not.toHaveBeenCalled();
});

it("archived suppression verifies bytes before decoding an earlier reviewed bundle", async () => {
  const { reviewedFeedbackWorld, corruptReplacementByte } = await import("../support/pr-feedback-world.js");
  const w = await reviewedFeedbackWorld("COMPLETE", undefined, undefined, input => { input.feedback.comments[0]!.body = "\uFFFD"; });
  const wf = w.task.workflow!, ref = wf.feedbackReview!.bundleRefs[0]!;
  w.task.workflow = { ...wf, feedbackReview: undefined, feedbackReviewHistory: [wf.feedbackReview!.reviewRef!] };
  w.objects.set(ref.objectKey, corruptReplacementByte(w.objects.get(ref.objectKey)!));
  await w.h.store.put({ item: toDocument(w.task) });
  w.put.mockClear();
  expect(await collectPrFeedback(w.deps, w.task, w.budget)).toBe("retry");
  expect(w.put).not.toHaveBeenCalled();
});

it.each(["new-comments", "resolved-observations"])("collection cannot persist %s after the task changes company", async kind => {
  const w = await world();
  if (kind === "resolved-observations") {
    w.feedback.comments[0] = { ...w.feedback.comments[0]!, kind: "review_comment", threadId: "t" };
    w.feedback.threads = [{ id: "t", resolved: true, commentIds: ["comment-1"] }];
  }
  w.read.mockImplementation(async () => {
    await w.h.store.update({ key: w.task, ops: [change.set("companyId", "org_bbbbbbbbbbbbbbbbbbbb")] });
    return w.feedback;
  });
  expect(await collectPrFeedback(w.deps, w.task, w.budget)).toBe("retry");
  expect((await readTask(w.h.deps, w.task.taskId))!.workflow).toEqual(w.task.workflow);
  const dispatches = await w.h.store.query({ pk: dispatchPartition(ORG), sk: { op: "beginsWith", prefix: "" } });
  expect(dispatches.items).toHaveLength(0);
});

it.each(["single-artifact", "aggregate"])("collection rejects the %s byte overflow before any artifact write", async kind => {
  const repositories = kind === "aggregate" ? ["app", ...Array.from({ length: 8 }, (_, i) => `repo${i}`)] : ["app", "api"];
  const w = await world({ repositories });
  for (const [repositoryId, read] of w.reads) {
    const value = await read();
    read.mockClear();
    if (kind === "single-artifact" && repositoryId === "app") continue;
    value.comments = Array.from({ length: kind === "aggregate" ? 15 : 18 }, (_, i) => ({ id: `comment-${i}`, kind: "discussion", author: "reviewer",
      url: `${value.changeRequest.ref.url}#comment-${i}`, updatedAt: new Date(w.clock.ms).toISOString(), body: "x".repeat(60_000) }));
  }
  expect(await collectPrFeedback(w.deps, w.task, w.budget)).toBe("retry");
  expect(w.put).not.toHaveBeenCalled();
  expect((await readTask(w.h.deps, w.task.taskId))!.workflow).toEqual(w.task.workflow);
});
