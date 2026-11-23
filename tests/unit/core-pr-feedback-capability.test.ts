import { expect, it, vi } from "vitest";
import { feedbackWorld } from "../support/pr-feedback-world.js";
import { ORG } from "../support/service-host.js";
import { createPrFeedbackRoutes } from "../../packages/broker/src/core-host/pr-feedback-routes.js";
import { createOwnerRoutes } from "../../packages/broker/src/local/app/routes.js";
import { collectTrackedFeedback, withFeedbackMergeReads } from "../../packages/broker/src/core/pr-feedback/service.js";
import { createMergeTrackingService, createMilestoneService } from "../../packages/broker/src/services/merge-tracking.js";
import { fixedCodeSettings } from "../../packages/broker/src/core/merge/defaults.js";
import { workflowRefusal } from "../../packages/broker/src/core/merge/merge.js";
import { readTask, workspaceOperations } from "../../packages/broker/src/core/task-flow/reads.js";
import { dispatchPartition, dispatchRowKey } from "../../packages/broker/src/core/task-flow/keys.js";

function tracking(w: Awaited<ReturnType<typeof feedbackWorld>>) {
  return createMergeTrackingService({ flow: w.h.deps, registry: w.registry, companyId: ORG,
    milestones: createMilestoneService({ store: w.h.store, now: () => w.clock.ms }), people: w.people,
    settings: fixedCodeSettings(), repository: w.deps.repository, now: () => w.clock.ms });
}

it.each(["sweep", "merge"])("hosted without decision routes: %s starts no paid review or card and leaves Merge unblocked", async path => {
  const w = await feedbackWorld();
  const admission = vi.spyOn(w.h.deps.admission, "admit");
  const before = structuredClone(w.task.workflow);
  if (path === "sweep") await tracking(w).sweep({ budgetMs: 1000 });
  else await withFeedbackMergeReads(w.world.deps, w.h.deps, w.registry).host.loadTask(w.task.taskId);
  await w.h.flow.sweepOnce();
  const task = (await readTask(w.h.deps, w.task.taskId))!;
  expect(task.workflow!.feedbackReview).toBeUndefined();
  expect(task.workflow!.revision).toBe(before!.revision);
  expect(workflowRefusal(task.workflow!)).toBeUndefined();
  expect(w.read).not.toHaveBeenCalled();
  expect(w.put).not.toHaveBeenCalled();
  expect(admission).not.toHaveBeenCalled();
  expect(await workspaceOperations(w.h.deps, task.workspaceId)).toEqual([]);
  expect((await w.h.store.query({ pk: dispatchPartition(ORG) })).items).toEqual([]);
});

it.each(["hosted", "local"])("%s with the real decision handler registered collects and queues review", async kind => {
  const w = await feedbackWorld();
  const service = tracking(w); // Registration must be visible to services already composed.
  const route = kind === "local"
    ? createOwnerRoutes({ flow: w.h.flow, blobs: w.registry.require("object-storage"), openPage: async () => undefined, version: "test" })
    : createPrFeedbackRoutes(w.h.deps, async () => ({ taskId: w.task.taskId }));
  await service.sweep({ budgetMs: 1000 });
  const task = (await readTask(w.h.deps, w.task.taskId))!;
  expect(task.workflow!.feedbackReview?.status).toBe("COLLECTING");
  expect(workflowRefusal(task.workflow!)).toBeDefined();
  expect(w.read).toHaveBeenCalledOnce();
  expect((await w.h.store.query({ pk: dispatchPartition(ORG) })).items).toEqual([expect.objectContaining({ kind: "REVIEW" })]);
  // Documented Keep input still reaches the same owner decision and returns the existing envelope.
  const response = await route({ method: "POST", path: `/v1/dev/tasks/${task.taskId}/workflow/keep-pull-requests`, headers: {},
    body: JSON.stringify({ requestId: "88888888-8888-4888-8888-888888888888", expectedRevision: task.workflow!.revision }) }, w.h.owner);
  expect(response?.statusCode).toBe(200);
  expect(Object.keys(JSON.parse(response!.body) as object)).toEqual(["task"]);
  expect((await readTask(w.h.deps, task.taskId))!.workflow!.feedbackReview?.status).toBe("DISMISSED");
});

it("a mounted sibling flow in the same company never grants a hosted flow the capability", async () => {
  const mounted = await feedbackWorld();
  createPrFeedbackRoutes(mounted.h.deps, async () => ({}));
  const hosted = await feedbackWorld();
  expect(await collectTrackedFeedback({ ...hosted.deps, registry: hosted.registry }, hosted.task, hosted.budget)).toBe("unchanged");
  expect(hosted.read).not.toHaveBeenCalled();
  expect(hosted.put).not.toHaveBeenCalled();
  expect(await collectTrackedFeedback({ ...mounted.deps, registry: mounted.registry }, mounted.task, mounted.budget)).toBe("collected");
});

it("a served decision handler permits the existing task-capped paid review admission", async () => {
  const { createBuildSteps } = await import("../../packages/broker/src/core/build-step/index.js");
  const w = await feedbackWorld();
  createPrFeedbackRoutes(w.h.deps, async () => ({}));
  const admit = vi.spyOn(w.h.deps.admission, "admit");
  expect(await collectTrackedFeedback({ ...w.deps, registry: w.registry }, w.task, w.budget)).toBe("collected");
  const task = (await readTask(w.h.deps, w.task.taskId))!;
  expect(await createBuildSteps().runRow(w.h.deps, { taskId: task.taskId, workflowRevision: task.workflow!.revision, kind: "REVIEW" })).toBe("STARTED");
  expect(admit).toHaveBeenCalledOnce();
  expect(await workspaceOperations(w.h.deps, task.workspaceId)).toEqual([expect.objectContaining({ workflowMode: "FEEDBACK_REVIEW" })]);
});

// Review test (lead 4 Opus): a card left COLLECTING by an earlier install whose queued review row is gone. An unserved flow over the same store
// must not run feedback recovery either: recovery re-queues the paid review row (recovery.ts recoverQueued), so the capability check stays first.
it("an unserved flow never re-queues the paid review of a card an earlier install left collecting", async () => {
  const w = await feedbackWorld();
  createPrFeedbackRoutes(w.h.deps, async () => ({}));
  expect(await collectTrackedFeedback({ ...w.deps, registry: w.registry }, w.task, w.budget)).toBe("collected");
  const left = (await readTask(w.h.deps, w.task.taskId))!;
  expect(left.workflow!.feedbackReview?.status).toBe("COLLECTING");
  await w.h.store.delete({ key: dispatchRowKey(ORG, left.taskId, left.workflow!.revision) });
  expect((await w.h.store.query({ pk: dispatchPartition(ORG) })).items).toEqual([]);
  const unserved = { ...w.h.deps };
  const admission = vi.spyOn(unserved.admission, "admit");
  w.read.mockClear();
  expect(await collectTrackedFeedback({ ...w.deps, flow: unserved, registry: w.registry }, left, w.budget)).toBe("unchanged");
  expect((await w.h.store.query({ pk: dispatchPartition(ORG) })).items).toEqual([]);
  expect(await readTask(w.h.deps, left.taskId)).toEqual(left);
  expect(w.read).not.toHaveBeenCalled();
  expect(admission).not.toHaveBeenCalled();
});

import { composeHostedPrFeedbackRoutes, propagatePrFeedbackDecisions, servesPrFeedbackDecisions } from "../../packages/broker/src/core-host/pr-feedback-routes.js";

it.each(["unserved", "served", "unreadable"])("the hosted Merge press consumer is %s before any browser request", async state => {
  const w = await feedbackWorld();
  w.h.deps.access.ownerActing = async () => ({ actorId: w.task.ownerKey });
  w.h.deps.taskCapUsd = async () => 10;
  w.h.deps.taskSpendUsd = async () => 0;
  if (state !== "unserved") composeHostedPrFeedbackRoutes(w.h.deps);
  if (state === "unreadable") w.read.mockRejectedValue(new Error("unreadable"));
  const merge = withFeedbackMergeReads(w.world.deps, w.h.deps, w.registry);
  if (state === "unreadable") await expect(merge.host.loadTask(w.task.taskId)).rejects.toMatchObject({ code: "MERGE_NOT_READY" });
  else await merge.host.loadTask(w.task.taskId);
  expect(w.read).toHaveBeenCalledTimes(state === "unserved" ? 0 : 1);
  const task = (await readTask(w.h.deps, w.task.taskId))!;
  expect(task.workflow!.feedbackReview?.status).toBe(state === "served" ? "COLLECTING" : undefined);
});

it("propagation grants only the actual job object and never a sibling or unserved recovery", async () => {
  const w = await feedbackWorld();
  const base = { ...w.h.deps }, job = { ...w.h.deps }, sibling = { ...w.h.deps };
  propagatePrFeedbackDecisions(base, job);
  expect(servesPrFeedbackDecisions(job)).toBe(false);
  createPrFeedbackRoutes(base, async () => ({}));
  propagatePrFeedbackDecisions(base, job);
  expect(servesPrFeedbackDecisions(job)).toBe(true);
  expect(servesPrFeedbackDecisions(sibling)).toBe(false);
});
