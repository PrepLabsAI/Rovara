import { expect, it, vi } from "vitest";
import { IMPLICIT_COMPANY_ID, change, companyScoped } from "@agentx/contracts";
import { host, ORG } from "../support/service-host.js";
import { TASK_ID } from "../support/merge-world.js";
import { createMergeTrackingService, createMilestoneService } from "../../packages/broker/src/services/merge-tracking.js";
import { fixedCodeSettings } from "../../packages/broker/src/core/merge/defaults.js";
import { recoveryRowKey } from "../../packages/broker/src/core/merge/store.js";

it("skips foreign recovery rows before touching their tracking rows or host", async () => {
  const w = await host();
  const other = "org_bbbbbbbbbbbbbbbbbbbb";
  const before = await w.h.store.get(recoveryRowKey(TASK_ID));
  const otherTask = "22222222-2222-4222-8222-222222222222";
  const ownTask = (await w.h.store.get({ pk: `DEVTASK#${TASK_ID}`, sk: "META" }))!;
  await w.h.store.put({ item: { ...ownTask, pk: `DEVTASK#${otherTask}`, taskId: otherTask, companyId: other } });
  const foreignRecovery = { ...recoveryRowKey(otherTask), kind: "tracking", taskId: otherTask, nextAttemptAt: 0 };
  await w.h.store.put({ item: foreignRecovery });
  const repository = vi.fn(w.world.host.repository);
  const tracking = createMergeTrackingService({ flow: w.h.deps, registry: w.registry, companyId: other, milestones: createMilestoneService({ store: w.h.store, now: () => w.clock.ms }), people: w.people, settings: fixedCodeSettings(), repository, now: () => w.clock.ms });
  // The B pass may touch B's task (same raw PR number), but never A's recovery row.
  await tracking.sweep({ budgetMs: 1000 });
  expect(await w.h.store.get(recoveryRowKey(TASK_ID))).toEqual(before);
  expect(repository.mock.calls.every((call) => call[3] === other)).toBe(true);
  repository.mockClear();
  await w.h.store.put({ item: foreignRecovery });
  // Positive control: same raw PR id is reached only by its own company's pass.
  const own = createMergeTrackingService({ flow: w.h.deps, registry: w.registry, companyId: ORG, milestones: createMilestoneService({ store: w.h.store, now: () => w.clock.ms }), people: w.people, settings: fixedCodeSettings(), repository, ciMode: async () => "their_ci_fix" as const, now: () => w.clock.ms });
  expect(await own.sweep({ budgetMs: 1000 })).toEqual({ attempted: 1 });
  expect(repository).toHaveBeenCalledWith("web", 1, "app", ORG);
  expect(repository.mock.calls.every((call) => call[3] === ORG)).toBe(true);
  expect(await w.h.store.get(recoveryRowKey(otherTask))).toEqual(foreignRecovery);
});

it("does no merge reads or writes with zero, invalid or exhausted total budget", async () => {
  const w = await host();
  const get = vi.spyOn(w.h.store, "get"), query = vi.spyOn(w.h.store, "query"), put = vi.spyOn(w.h.store, "put");
  for (const budgetMs of [0, -1, NaN, Infinity]) expect(await w.tracking.sweep({ budgetMs })).toEqual({ attempted: 0 });
  expect(get).not.toHaveBeenCalled();
  expect(query).not.toHaveBeenCalled();
  expect(put).not.toHaveBeenCalled();
});

it("caps the recovery queue read across pages on a frozen clock", async () => {
  const w = await host();
  await w.h.store.update({ key: recoveryRowKey(TASK_ID), ops: [change.set("nextAttemptAt", w.clock.ms + 10000)] });
  for (let n = 0; n < 1001; n++) await w.h.store.put({ item: { pk: "WORKFLOW_MERGE_RECOVERY", sk: `TASK#${n}`, kind: "tracking", taskId: `other${n}`, nextAttemptAt: 0 } });
  const query = vi.spyOn(w.h.store, "query");
  await w.tracking.sweep({ budgetMs: 1000 });
  const reads = query.mock.calls.filter(([q]) => q.pk === "WORKFLOW_MERGE_RECOVERY");
  expect(reads.length).toBeLessThanOrEqual(10);
  expect(reads.every(([q]) => q.limit !== undefined && q.limit <= 100)).toBe(true);
});

it("isolates each company's persisted host cooldown", async () => {
  const w = await host();
  const other = "org_bbbbbbbbbbbbbbbbbbbb";
  const tracking = createMergeTrackingService({ flow: w.h.deps, registry: w.registry, companyId: other, milestones: createMilestoneService({ store: w.h.store, now: () => w.clock.ms }), people: w.people, settings: fixedCodeSettings(), now: () => w.clock.ms });
  tracking.pauseUntil(w.clock.ms + 1000);
  await tracking.idle();
  expect(await w.h.store.get({ pk: `ORG#${other}#WORKFLOW_MERGE_SWEEP`, sk: "COOLDOWN" })).toMatchObject({ until: w.clock.ms + 1000 });
  expect(await w.h.store.get({ pk: "WORKFLOW_MERGE_SWEEP", sk: "COOLDOWN" })).toBeUndefined();
});

it("refuses a foreign resolver scope without invoking the injected host", async () => {
  const w = await host();
  const repository = vi.fn(w.world.host.repository);
  const tracking = createMergeTrackingService({ flow: w.h.deps, registry: w.registry, companyId: ORG, milestones: createMilestoneService({ store: w.h.store, now: () => w.clock.ms }), people: w.people, settings: fixedCodeSettings(), repository, now: () => w.clock.ms });
  expect(await tracking.deps.repository("web", 1, "app", "org_bbbbbbbbbbbbbbbbbbbb")).toBeUndefined();
  expect(repository).not.toHaveBeenCalled();
  expect(() => createMergeTrackingService({ flow: w.h.deps, registry: w.registry, companyId: "private-canary", milestones: createMilestoneService({ store: w.h.store, now: () => w.clock.ms }), people: w.people, settings: fixedCodeSettings(), now: () => w.clock.ms })).toThrow(new Error("the merge tracking company is invalid"));
});

it("leaves tier due rows untouched when the pass budget is exhausted", async () => {
  const w = await host();
  const company = "org_aaaaaaaaaaaaaaaaaaaa";
  const taskId = "55555555-5555-4555-8555-555555555555";
  const key = { pk: companyScoped(company, "TIER_CHECKS_DUE"), sk: `TASK#${taskId}` };
  const due = { ...key, entityType: "TIER_CHECKS_DUE", companyId: company, taskId, lastRunAt: 0, dueAt: w.clock.ms };
  await w.h.store.put({ item: due });
  let timeReads = 0;
  const now = () => timeReads++ === 0 ? 0 : 10 * 60_000;
  const tracking = createMergeTrackingService({
    flow: w.h.deps, registry: w.registry, companyId: company, milestones: createMilestoneService({ store: w.h.store, now: () => w.clock.ms }),
    people: w.people, settings: fixedCodeSettings(), now,
  });

  expect(await tracking.tierChecks()).toBe(0);
  expect(await w.h.store.get(key)).toEqual(due);
});

it("reads a legacy implicit tier row without a company as implicit, only in the implicit partition", async () => {
  const w = await host();
  const taskId = "66666666-6666-4666-8666-666666666666";
  const key = { pk: "TIER_CHECKS_DUE", sk: `TASK#${taskId}` };
  await w.h.store.put({ item: { ...key, entityType: "TIER_CHECKS_DUE", taskId, lastRunAt: 0, dueAt: w.clock.ms } });
  const logged: Record<string, unknown>[] = [];
  const tracking = createMergeTrackingService({
    flow: w.h.deps, registry: w.registry, companyId: IMPLICIT_COMPANY_ID, milestones: createMilestoneService({ store: w.h.store, now: () => w.clock.ms }),
    people: w.people, settings: fixedCodeSettings(), now: () => w.clock.ms, log: (entry) => logged.push(entry),
  });
  await tracking.tierChecks();
  // Owned by the implicit company: not reported as unowned; its task does not exist, so the row is cleared rather than held forever.
  expect(logged).not.toContainEqual(expect.objectContaining({ event: "tier_checks.unowned_item", taskId }));
  expect(await w.h.store.get(key)).toBeUndefined();
});

it("never runs tier checks for a task whose record belongs to another company", async () => {
  const w = await host();
  const company = "org_cccccccccccccccccccc";
  // TASK_ID is the harness's task, owned by the harness company, not by `company`.
  const key = { pk: companyScoped(company, "TIER_CHECKS_DUE"), sk: `TASK#${TASK_ID}` };
  const due = { ...key, entityType: "TIER_CHECKS_DUE", companyId: company, taskId: TASK_ID, lastRunAt: 0, dueAt: w.clock.ms };
  await w.h.store.put({ item: due });
  const tracking = createMergeTrackingService({
    flow: w.h.deps, registry: w.registry, companyId: company, milestones: createMilestoneService({ store: w.h.store, now: () => w.clock.ms }),
    people: w.people, settings: fixedCodeSettings(), now: () => w.clock.ms,
  });
  expect(await tracking.tierChecks()).toBe(0);
  expect(await w.h.store.get(key)).toBeUndefined();
});


it("mounts collection before tracking can mark a core pull request ready", async () => {
  const { feedbackWorld } = await import("../support/pr-feedback-world.js");
  const w = await feedbackWorld();
  const tracking = createMergeTrackingService({ flow: w.h.deps, registry: w.registry, companyId: ORG,
    milestones: createMilestoneService({ store: w.h.store, now: () => w.clock.ms }), people: w.people,
    settings: fixedCodeSettings(), repository: w.deps.repository, now: () => w.clock.ms });
  await tracking.sweep({ budgetMs: 1000 });
  const { readTask } = await import("../../packages/broker/src/core/task-flow/reads.js");
  expect((await readTask(w.h.deps, TASK_ID))!.workflow!.feedbackReview?.status).toBe("COLLECTING");
  expect(w.read).toHaveBeenCalled();
});


it.each(["COMPLETE", "BLOCKED"] as const)("composes the real feedback soundness and reply hooks for a %s report", async status => {
  const { reviewedFeedbackWorld } = await import("../support/pr-feedback-world.js");
  const w = await reviewedFeedbackWorld(status);
  const tracking = createMergeTrackingService({ flow: w.h.deps, registry: w.registry, companyId: ORG,
    milestones: createMilestoneService({ store: w.h.store, now: () => w.clock.ms }), people: w.people,
    settings: fixedCodeSettings(), repository: w.deps.repository, now: () => w.clock.ms });
  const task = (await tracking.deps.loadTask(w.task.taskId))!;
  expect(await tracking.deps.feedbackRoundCheck?.(task as never)).toBe(status === "COMPLETE");
  expect(await tracking.deps.feedbackRoundCheck?.({ ...task, taskId: "99999999-9999-4999-8999-999999999999" } as never)).toBe(false);
  w.objects.delete(w.task.workflow!.feedbackReview!.reviewRef!.objectKey);
  expect(await tracking.deps.feedbackRoundCheck?.(task as never)).toBe(false);
  const write = vi.spyOn(w.h.store, "transact");
  expect(await tracking.deps.sendFeedbackReplies?.(task as never)).toBeUndefined();
  expect(write).not.toHaveBeenCalled();
});

it.each(["new-comments", "unreadable"])("a direct merge load checks %s before returning eligibility", async kind => {
  const { feedbackWorld } = await import("../support/pr-feedback-world.js");
  const { withFeedbackMergeReads } = await import("../../packages/broker/src/core/pr-feedback/service.js");
  const w = await feedbackWorld();
  const merge = withFeedbackMergeReads(w.world.deps, w.h.deps, w.registry);
  if (kind === "unreadable") w.read.mockRejectedValue(new Error("host unavailable"));
  const loading = merge.host.loadTask(w.task.taskId);
  if (kind === "new-comments") expect((await loading)!.workflow!.feedbackReview?.status).toBe("COLLECTING");
  else await expect(loading).rejects.toMatchObject({ code: "MERGE_NOT_READY" });
  expect(w.read).toHaveBeenCalledOnce();
});

it.each(["missing", "foreign-company"])("direct merge reads hide %s tasks before host calls", async kind => {
  const { feedbackWorld } = await import("../support/pr-feedback-world.js");
  const { withFeedbackMergeReads } = await import("../../packages/broker/src/core/pr-feedback/service.js");
  const w = await feedbackWorld();
  if (kind === "foreign-company") await w.h.store.update({ key: w.task, ops: [change.set("companyId", "org_bbbbbbbbbbbbbbbbbbbb")] });
  const merge = withFeedbackMergeReads(w.world.deps, w.h.deps, w.registry);
  await expect(merge.host.loadTask(kind === "missing" ? "99999999-9999-4999-8999-999999999999" : w.task.taskId)).resolves.toBeUndefined();
  expect(w.read).not.toHaveBeenCalled();
});

it("the tracking feedback adapter leaves an unstamped task to its existing owner", async () => {
  const { feedbackWorld } = await import("../support/pr-feedback-world.js");
  const { collectTrackedFeedback } = await import("../../packages/broker/src/core/pr-feedback/service.js");
  const { engineStampKey } = await import("../../packages/broker/src/core-host/engine-stamp.js");
  const w = await feedbackWorld();
  await w.h.store.delete({ key: engineStampKey(w.task.taskId) });
  await expect(collectTrackedFeedback({ ...w.deps, registry: w.registry }, w.task, w.budget)).resolves.toBe("unchanged");
  expect(w.read).not.toHaveBeenCalled();
});

it("unchanged empty feedback still permits normal tracking reads", async () => {
  const { feedbackWorld } = await import("../support/pr-feedback-world.js");
  const w = await feedbackWorld();
  w.feedback.comments = [];
  const home = (await w.world.host.repository("web", 1, "app", ORG))!;
  const status = vi.spyOn(home.codeHost, "changeRequestStatus");
  const tracking = createMergeTrackingService({ flow: w.h.deps, registry: w.registry, companyId: ORG,
    milestones: createMilestoneService({ store: w.h.store, now: () => w.clock.ms }), people: w.people,
    settings: fixedCodeSettings(), repository: w.deps.repository, now: () => w.clock.ms });
  await tracking.sweep({ budgetMs: 1000 });
  expect(status).toHaveBeenCalled();
});

import { feedbackWorld, reviewedFeedbackWorld } from "../support/pr-feedback-world.js";
import { decidePrFeedback } from "../../packages/broker/src/core/pr-feedback/decide.js";
import { readTask } from "../../packages/broker/src/core/task-flow/reads.js";

it("outside push: tracking still reads PR status (reconcileTrackingTask runs)", async () => {
  const w = await feedbackWorld();
  // Establish the existing tracking observation before a person pushes.
  w.feedback.comments = [];
  await w.tracking.sweep({ budgetMs: 1000 });
  w.clock.ms += 10 * 60_000;
  w.read.mockClear();
  // Someone else pushed: the host's PR head is no longer the head Rovara recorded.
  w.feedback.changeRequest.headRevision = "e".repeat(40);
  const home = (await w.world.host.repository("web", 1, "app", ORG))!;
  const originalStatus = home.codeHost.changeRequestStatus.bind(home.codeHost);
  const status = vi.spyOn(home.codeHost, "changeRequestStatus").mockImplementation(async (...args) => ({ ...await originalStatus(...args), headRevision: "e".repeat(40) }));
  const originalDetails = home.codeHost.getChangeRequest.bind(home.codeHost);
  vi.spyOn(home.codeHost, "getChangeRequest").mockImplementation(async (...args) => ({ ...await originalDetails(...args), headRevision: "e".repeat(40) }));
  const timeline = vi.spyOn(w.h.store, "transact");
  const tracking = createMergeTrackingService({ flow: w.h.deps, registry: w.registry, companyId: ORG,
    milestones: createMilestoneService({ store: w.h.store, now: () => w.clock.ms }), people: w.people,
    settings: fixedCodeSettings(), repository: w.deps.repository, now: () => w.clock.ms });
  for (let i = 0; i < 3; i += 1) { await tracking.sweep({ budgetMs: 1000 }); w.clock.ms += 10 * 60_000; }

  expect(status).toHaveBeenCalledTimes(3);
  expect(w.read).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(timeline.mock.calls)).toContain("Someone else pushed to this pull request");
});

it.each(["control", "pushed"])("outside push %s: owner can still dismiss a pending card", async (kind) => {
  const w = await reviewedFeedbackWorld();
  if (kind === "pushed") w.feedback.changeRequest.headRevision = "e".repeat(40);
  const request = { ...w.request, decision: "DISMISS" as const, selectedFindingIds: [], ownerNote: "The owner kept the pull request as it is." };
  let error: unknown;
  try { await decidePrFeedback(w.h.deps, w.h.owner, w.task.taskId, request); } catch (e) { error = e; }

  expect(error).toBeUndefined();
  expect((await readTask(w.h.deps, w.task.taskId))!.workflow!.feedbackReview?.status).toBe("DISMISSED");
});

it("outside push: direct merge load", async () => {
  const { withFeedbackMergeReads } = await import("../../packages/broker/src/core/pr-feedback/service.js");
  const w = await feedbackWorld();
  w.feedback.changeRequest.headRevision = "e".repeat(40);
  const merge = withFeedbackMergeReads(w.world.deps, w.h.deps, w.registry);
  await expect(merge.host.loadTask(w.task.taskId)).resolves.toBeDefined();
});
