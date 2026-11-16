import { expect, it, vi } from "vitest";
import { change, companyScoped } from "@agentx/contracts";
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

it("gives merge tracking the injected CI reader instead of its default", async () => {
  const w = await host();
  const ciMode = vi.fn(async () => "their_ci_watch" as const);
  const tracking = createMergeTrackingService({ flow: w.h.deps, registry: w.registry, companyId: ORG, milestones: createMilestoneService({ store: w.h.store, now: () => w.clock.ms }), people: w.people, settings: fixedCodeSettings(), ciMode, now: () => w.clock.ms });
  await tracking.sweep({ budgetMs: 1000 });
  expect(ciMode).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG, project: "web" }));
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

it("partitions tier due rows by company, rechecks ownership, and reports unowned rows", async () => {
  const w = await host();
  const companyA = "org_aaaaaaaaaaaaaaaaaaaa";
  const companyB = "org_bbbbbbbbbbbbbbbbbbbb";
  const taskId = "22222222-2222-4222-8222-222222222222";
  const dueKey = (companyId: string, id: string) => ({ pk: companyScoped(companyId, "TIER_CHECKS_DUE"), sk: `TASK#${id}` });
  const validA = { ...dueKey(companyA, taskId), entityType: "TIER_CHECKS_DUE", companyId: companyA, taskId, lastRunAt: 0, dueAt: w.clock.ms };
  const validB = { ...dueKey(companyB, taskId), entityType: "TIER_CHECKS_DUE", companyId: companyB, taskId, lastRunAt: 0, dueAt: w.clock.ms };
  const missingOwner = { ...dueKey(companyA, "33333333-3333-4333-8333-333333333333"), entityType: "TIER_CHECKS_DUE", taskId: "33333333-3333-4333-8333-333333333333", lastRunAt: 0, dueAt: w.clock.ms };
  const foreignOwner = { ...dueKey(companyA, "44444444-4444-4444-8444-444444444444"), entityType: "TIER_CHECKS_DUE", companyId: companyB, taskId: "44444444-4444-4444-8444-444444444444", lastRunAt: 0, dueAt: w.clock.ms };
  await Promise.all([validA, validB, missingOwner, foreignOwner].map((item) => w.h.store.put({ item })));
  const query = vi.spyOn(w.h.store, "query");
  const loggedA: Record<string, unknown>[] = [];
  const service = (companyId: string, log?: (entry: Record<string, unknown>) => void) => createMergeTrackingService({
    flow: w.h.deps, registry: w.registry, companyId: companyId as never, milestones: createMilestoneService({ store: w.h.store, now: () => w.clock.ms }),
    people: w.people, settings: fixedCodeSettings(), now: () => w.clock.ms, ...(log === undefined ? {} : { log }),
  });

  await service(companyA, (entry) => loggedA.push(entry)).tierChecks();
  expect(query.mock.calls.filter(([input]) => input.pk === companyScoped(companyA, "TIER_CHECKS_DUE")).length).toBeGreaterThan(0);
  expect(query.mock.calls.every(([input]) => input.pk !== companyScoped(companyB, "TIER_CHECKS_DUE"))).toBe(true);
  expect(await w.h.store.get(dueKey(companyB, taskId))).toEqual(validB);
  expect(await w.h.store.get(dueKey(companyA, missingOwner.sk.slice(5)))).toBeDefined();
  expect(await w.h.store.get(dueKey(companyA, foreignOwner.sk.slice(5)))).toBeDefined();
  expect(loggedA).toContainEqual(expect.objectContaining({ event: "tier_checks.unowned_item", taskId: missingOwner.taskId }));
  expect(loggedA).toContainEqual(expect.objectContaining({ event: "tier_checks.unowned_item", taskId: foreignOwner.taskId }));

  await service(companyB).tierChecks();
  expect(await w.h.store.get(dueKey(companyB, taskId))).toBeUndefined();
  expect(await w.h.store.get(dueKey(companyA, taskId))).toBeUndefined();
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
    flow: w.h.deps, registry: w.registry, companyId: company as never, milestones: createMilestoneService({ store: w.h.store, now: () => w.clock.ms }),
    people: w.people, settings: fixedCodeSettings(), now,
  });

  expect(await tracking.tierChecks()).toBe(0);
  expect(await w.h.store.get(key)).toEqual(due);
});
