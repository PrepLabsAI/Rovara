// A failed response read AFTER the commit must never look like a refused write (Opus review a074804fd, P2-1).
import { expect, it } from "vitest";
import { COMMITTED_REFRESH_NEEDED_MESSAGE, WORKFLOW_KEEP_PULL_REQUESTS_NOTE } from "@agentx/contracts";
import { reviewedFeedbackWorld } from "../support/pr-feedback-world.js";
import { createPrFeedbackRoutes } from "../../packages/broker/src/core-host/pr-feedback-routes.js";
import { taskNotFound } from "../../packages/broker/src/core/task-flow/access.js";
import { readTask } from "../../packages/broker/src/core/task-flow/reads.js";
import { toDocument } from "../../packages/broker/src/core/task-flow/records.js";

const routesUnderTest = ["feedback-decision", "feedback-retry", "keep-pull-requests"] as const;

async function world(route: (typeof routesUnderTest)[number]) {
  const w = await reviewedFeedbackWorld(route === "feedback-retry" ? "BLOCKED" : "COMPLETE");
  if (route === "keep-pull-requests") {
    w.task.workflow!.feedbackReview!.status = "COLLECTING";
    delete w.task.workflow!.feedbackReview!.reviewRef;
    await w.h.store.put({ item: toDocument(w.task) });
  }
  const revision = (await readTask(w.h.deps, w.task.taskId))!.workflow!.revision;
  const body = route === "feedback-decision" ? { ...w.request, decision: "DISMISS", selectedFindingIds: [], ownerNote: WORKFLOW_KEEP_PULL_REQUESTS_NOTE }
    : route === "feedback-retry" ? { reviewDigest: w.request.reviewDigest } : { requestId: w.request.requestId, expectedRevision: revision };
  const send = (view: () => Promise<Record<string, unknown>>) => createPrFeedbackRoutes(w.h.deps, async () => ({}))(
    { method: "POST", path: `/v1/dev/tasks/${w.task.taskId}/workflow/${route}`, headers: {}, body: JSON.stringify(body) }, w.h.owner, view);
  return { w, revision, send };
}

it.each(routesUnderTest)("%s: a refusal BEFORE the commit answers the plain refusal and writes nothing", async route => {
  const { w, revision, send } = await world(route);
  w.h.deps.access.ownerActing = async () => undefined;
  const answer = await send(async () => ({}));
  expect(answer?.statusCode).toBe(404);
  expect(JSON.parse(answer!.body)).toEqual({ error: { code: "TASK_NOT_FOUND", message: "no such task" } });
  expect((await readTask(w.h.deps, w.task.taskId))!.workflow!.revision).toBe(revision);
});

it.each(routesUnderTest)("%s: a response read that fails AFTER the commit answers COMMITTED_REFRESH_NEEDED, never a pre-write refusal", async route => {
  const { w, revision, send } = await world(route);
  const answer = await send(async () => { throw taskNotFound(); });
  // The move did commit.
  expect((await readTask(w.h.deps, w.task.taskId))!.workflow!.revision).toBeGreaterThan(revision);
  const body = JSON.parse(answer!.body) as { error: { code: string; message: string } };
  expect(body.error.code).toBe("COMMITTED_REFRESH_NEEDED");
  expect(body.error.message).toContain(COMMITTED_REFRESH_NEEDED_MESSAGE);
  expect(answer!.statusCode).toBe(409);
  expect(answer!.statusCode).not.toBe(404);
  expect(body.error.code).not.toBe("TASK_NOT_FOUND");
});

it.each(routesUnderTest)("%s: a non-refusal failure of the response read is also COMMITTED_REFRESH_NEEDED (no internal words)", async route => {
  const { send } = await world(route);
  const answer = await send(async () => { throw new Error("projection exploded: secret internals"); });
  expect(answer?.body).not.toContain("secret internals");
  expect((JSON.parse(answer!.body) as { error: { code: string } }).error.code).toBe("COMMITTED_REFRESH_NEEDED");
});

it.each(routesUnderTest)("%s: a good response read still answers the task (200)", async route => {
  const { send } = await world(route);
  const answer = await send(async () => ({ taskId: "t" }));
  expect(answer?.statusCode).toBe(200);
  expect((JSON.parse(answer!.body) as { task: unknown }).task).toEqual({ taskId: "t" });
});
