import type { TaskFlowDeps } from "../../packages/broker/src/core/task-flow/deps.js";
import type { DocumentStore } from "@agentx/contracts";
import { expect, it, vi } from "vitest";
import { sweepOpenSessions } from "../../packages/broker/src/core/sessions/sweep.js";
import { deliverAttention } from "../../packages/broker/src/core/notify/attention.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createAdapterRegistry } from "../../packages/broker/src/ports/adapter-registry.js";
import { createTaskSessionItems, taskSessionId } from "../../packages/broker/src/core/sessions/create.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa", B = "org_bbbbbbbbbbbbbbbbbbbb";

it("session sweep caps all scanned items even when its clock does not advance", async () => {
  const store = new MemoryDocumentStore();
  for (let n = 0; n < 101; n++) await store.put({ item: { pk: "OPEN_AGENT_SESSIONS", sk: `${A}#${n}`, orgId: A, sessionId: `ses_${String(n).padStart(20, "0")}` } });
  const result = await sweepOpenSessions({ store, facts: { read: async () => undefined }, cost: { costUsd: async () => 0 }, now: () => new Date(1000) }, { companyId: A, maxItems: 10, pageSize: 7, budgetMs: 100 });
  expect(result).toMatchObject({ visited: 10, complete: false });
});

it("notification sweep reads nothing once the total deadline expires", async () => {
  const store = new MemoryDocumentStore();
  const query = vi.spyOn(store, "query");
  await deliverAttention({ store, registry: createAdapterRegistry(), now: () => 1000 }, { companyId: A, deadlineMs: 1000 });
  expect(query).not.toHaveBeenCalled();
});

it("notification budget caps a large queue even with an oversized page", async () => {
  const store = new MemoryDocumentStore();
  let inspected = 0;
  const items = Array.from({ length: 100_000 }, (_, n) => ({ pk: "NOTIFY_PENDING", sk: `${B}#person#${n}#ready`, get orgId() { inspected++; return B; }, developerId: "person", sessionId: String(n), kind: "ready", at: "2026-11-09T10:00:00.000Z" }));
  vi.spyOn(store, "query").mockResolvedValue({ items, cursor: "more" });
  const get = vi.spyOn(store, "get");
  const result = await deliverAttention({ store, registry: createAdapterRegistry(), now: () => 1000, log: () => undefined }, { companyId: A, maxItems: 10, deadlineMs: 2000 });
  expect(result.people).toBe(0);
  expect(inspected).toBe(10);
  expect(get).not.toHaveBeenCalled();
});

it("rechecks company on shared index rows even if a store returns foreign rows", async () => {
  const store = new MemoryDocumentStore();
  vi.spyOn(store, "query").mockResolvedValue({ items: [{ pk: "OPEN_AGENT_SESSIONS", sk: `${B}#session`, orgId: B, sessionId: "session" }] });
  const get = vi.spyOn(store, "get");
  expect(await sweepOpenSessions({ store, facts: { read: async () => undefined }, cost: { costUsd: async () => 0 } }, { companyId: A })).toMatchObject({ visited: 0 });
  expect(get).not.toHaveBeenCalled();
});

it("composes exactly the three L3 company passes and rejects a flow from another company", async () => {
  const { host, ORG } = await import("../support/service-host.js");
  const { createBrokerCoreServices } = await import("../../packages/broker/src/aws/core-job-services.js");
  const w = await host();
  const options = { companyId: ORG, flow: w.h.flow, registry: w.registry, ciMode: async () => "their_ci_fix" as const, people: w.people, summary: { facts: w.sessions.deps.facts, cost: w.sessions.deps.cost }, notification: { companyOf: async () => ORG }, now: () => new Date(w.clock.ms) };
  await w.h.store.transact(createTaskSessionItems({ orgId: B, sessionId: taskSessionId("8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6"), taskId: "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6", project: "web", agent: { agentId: "rovara-code", name: "Rovara Code", version: 1 }, title: "Other", owner: localOwnerPrincipal(), origin: "app", payer: { kind: "member", developerId: "a".repeat(64) } as never, now: "2026-11-09T10:00:00.000Z" }));
  const services = createBrokerCoreServices(options);
  expect(Object.keys(services).sort()).toEqual(["merge-tracking", "notify-deliver", "session-sweep"]);
  expect(await services["session-sweep"].pass({ budgetMs: 1000 })).toMatchObject({ visited: 1 });
  expect(await services["merge-tracking"].pass({ budgetMs: 1000 })).toMatchObject({ attempted: 1 });
  for (const orgId of [ORG, B]) await w.h.store.put({ item: { pk: "NOTIFY_PENDING", sk: `${orgId}#person#session#ready`, orgId, developerId: "person", sessionId: "session", kind: "ready", at: "2026-11-09T10:00:00.000Z" } });
  expect(await services["notify-deliver"].pass({ budgetMs: 1000 })).toMatchObject({ dropped: 1 });
  expect((await w.h.store.query({ pk: "NOTIFY_PENDING" })).items.some((row) => row["orgId"] === B)).toBe(true);
  expect(() => createBrokerCoreServices({ ...options, companyId: B })).toThrow("the core job company does not match its flow");
});

it("refuses an unscoped notification transport with fixed words", async () => {
  const { host, ORG } = await import("../support/service-host.js");
  const { createBrokerCoreServices } = await import("../../packages/broker/src/aws/core-job-services.js");
  const w = await host();
  const services = createBrokerCoreServices({ companyId: ORG, flow: w.h.flow, registry: w.registry, ciMode: async () => "their_ci_fix" as const, people: w.people });
  await expect(services["notify-deliver"].pass({ budgetMs: 1000 })).rejects.toThrow(new Error("the core job could not finish"));
});

it("hosted job delivery keeps E2E results company-bound while composing the inbox service", async () => {
  const { host, ORG, SESSION, OWNER_ID, CONVERSATION } = await import("../support/service-host.js");
  const { createHostedBrokerCoreServices } = await import("../../packages/broker/src/aws/core-job-services.js");
  const { taskKey } = await import("../../packages/broker/src/core/task-flow/keys.js");
  const { change, agentSessionKey } = await import("@agentx/contracts");
  for (const kind of ["task", "chain"] as const) for (const companyId of [ORG, B]) {
    const w = await host();
    w.clock.ms = Date.now(); // The fixture store expires notification rows against the real clock.
    const notice = vi.fn(async () => [{ type: "section", text: { type: "mrkdwn", text: "Recorded E2E result" } }]);
    w.h.deps.applicationE2E = { results: { notice } } as never;
    const deliver = vi.spyOn(w.chat, "deliver");
    await w.sessions.refresh(ORG, SESSION);
    w.state.facts.workflow = { stage: "PLAN_REVIEW", state: "WAITING" };
    await w.sessions.refresh(ORG, SESSION);
    expect((await w.h.store.query({ pk: "NOTIFY_PENDING" })).items).toHaveLength(1);
    await w.h.store.update({ key: taskKey(w.state.facts.taskId), ops: [change.set("companyId", companyId)] });
    if (kind === "chain") await w.h.store.update({ key: agentSessionKey(ORG, SESSION, "META"), ops: [
      change.set("kind", "chain"), change.set("subject", { kind: "chain", chainRunId: "crn_00000000000000000000" }),
    ] });
    const get = vi.spyOn(w.h.store, "get");
    const services = createHostedBrokerCoreServices({ companyId: ORG, flow: w.h.flow, registry: w.registry, ciMode: async () => "their_ci_fix" as const, people: w.people,
      notification: { companyOf: async () => ORG, access: async () => ({ owner: true }), thread: async () => ({ personId: OWNER_ID, conversation: CONVERSATION }) }, now: () => new Date(w.clock.ms) });
    expect(await services["notify-deliver"].pass({ budgetMs: 1000 })).toMatchObject({ sent: 1 });
    expect(notice).toHaveBeenCalledTimes(kind === "task" && companyId === ORG ? 1 : 0);
    expect(JSON.stringify(deliver.mock.calls).includes("Recorded E2E result")).toBe(kind === "task" && companyId === ORG);
    expect(get.mock.calls.some(([key]) => key.pk === "DEVTASK#undefined")).toBe(false);
    get.mockRestore();
  }
});

it("runs the deployed session defaults over a real flow task and cost ledger", async () => {
  const { randomUUID } = await import("node:crypto");
  const { createHarness, COMPANY } = await import("../support/task-flow-harness.js");
  const { createHostedMetering } = await import("../../packages/broker/src/core-host/hosted-modules.js");
  const { createBrokerCoreServices } = await import("../../packages/broker/src/aws/core-job-services.js");
  const { soleOwnerPeople } = await import("../../packages/broker/src/core/merge/people.js");
  const h = createHarness();
  await h.registerProject();
  const started = await h.flow.start(h.owner, { requestId: randomUUID(), project: "payments", instructions: "Make a change" });
  await h.store.transact(createTaskSessionItems({ orgId: COMPANY, sessionId: taskSessionId(started.task.taskId), taskId: started.task.taskId, project: "payments", agent: { agentId: "rovara-code", name: "Rovara Code", version: 1 }, title: "Work", owner: h.owner.principal, origin: "app", payer: { kind: "member", developerId: "a".repeat(64) } as never, now: new Date(h.clock.now).toISOString() }));
  const registry = createAdapterRegistry();
  registry.register("metering", "test", createHostedMetering());
  const services = createBrokerCoreServices({ companyId: COMPANY, flow: h.flow, registry, ciMode: async () => "their_ci_fix" as const, people: soleOwnerPeople, now: () => new Date(h.clock.now) });
  expect(await services["session-sweep"].pass({ budgetMs: 1000 })).toMatchObject({ visited: 1, failed: 0 });
  expect(started.task.taskId).toBeTruthy();
  await h.store.put({ item: { pk: `ORG#${COMPANY}#COST#${started.task.taskId}`, sk: "TOTAL", currency: "EUR", micros: 100 } });
  expect(await services["session-sweep"].pass({ budgetMs: 1000 })).toMatchObject({ visited: 1, failed: 1, updated: 0 });
});

it("rejects malformed company scopes before any queue read", async () => {
  const store = new MemoryDocumentStore();
  const query = vi.spyOn(store, "query");
  await expect(sweepOpenSessions({ store, facts: { read: async () => undefined }, cost: { costUsd: async () => 0 } }, { companyId: "private-canary" })).rejects.toThrow(new Error("the session sweep company is invalid"));
  await expect(deliverAttention({ store, registry: createAdapterRegistry(), now: () => 1000 }, { companyId: "private-canary" })).rejects.toThrow(new Error("the notification company is invalid"));
  expect(query).not.toHaveBeenCalled();
});

it("refuses a missing runtime CI reader instead of inheriting merge's fallback", async () => {
  const { host, ORG } = await import("../support/service-host.js");
  const { createBrokerCoreServices } = await import("../../packages/broker/src/aws/core-job-services.js");
  const w = await host();
  expect(() => createBrokerCoreServices({ companyId: ORG, flow: w.h.flow, registry: w.registry, ciMode: undefined as never, people: w.people })).toThrow(new Error("the core jobs need a CI mode reader"));
});

it("processes an owned task in a large mixed queue before spending the pass on foreign locators", async () => {
  const { host, ORG } = await import("../support/service-host.js");
  const { createBrokerCoreServices } = await import("../../packages/broker/src/aws/core-job-services.js");
  const w = await host();
  for (let n = 0; n < 300; n++) for (const side of ["0000", "zzzz"]) await w.h.store.put({ item: { pk: "WORKFLOW_MERGE_RECOVERY", sk: `TASK#${side}-${String(n).padStart(4, "0")}`, kind: "tracking", taskId: `${side}-${n}`, nextAttemptAt: 0 } });
  const services = createBrokerCoreServices({ companyId: ORG, flow: w.h.flow, registry: w.registry, ciMode: async () => "their_ci_fix" as const, people: w.people, now: () => new Date(w.clock.ms) });
  const reports = [];
  for (let n = 0; n < 4; n++) reports.push(await services["merge-tracking"].pass({ budgetMs: 1000 }));
  expect(reports.some((report) => report["attempted"] === 1)).toBe(true);
});

it("reports a failed merge queue read explicitly without echoing its cause", async () => {
  const { host, ORG } = await import("../support/service-host.js");
  const { createBrokerCoreServices } = await import("../../packages/broker/src/aws/core-job-services.js");
  const w = await host();
  vi.spyOn(w.h.store, "query").mockRejectedValue(new Error("private-canary"));
  const logs: unknown[] = [];
  const services = createBrokerCoreServices({ companyId: ORG, flow: w.h.flow, registry: w.registry, ciMode: async () => "their_ci_fix" as const, people: w.people, now: () => new Date(w.clock.ms), log: (entry) => logs.push(entry) });
  const report = await services["merge-tracking"].pass({ budgetMs: 1000 });
  expect(report).toMatchObject({ attempted: 0, failed: 1, complete: false });
  expect(JSON.stringify([report, logs])).not.toContain("private-canary");
});

it("reports an incomplete notification pass when its people cap leaves recipients queued", async () => {
  const { host, ORG, SESSION, CONVERSATION } = await import("../support/service-host.js");
  const { writeNotifyPrefs } = await import("../../packages/broker/src/core/notify/prefs.js");
  const w = await host();
  w.state.facts.workflow = { stage: "PLAN_REVIEW", state: "WAITING" };
  await w.sessions.refresh(ORG, SESSION);
  for (let n = 0; n < 50; n++) {
    const developerId = String(n).padStart(64, "0");
    await writeNotifyPrefs({ store: w.h.store, now: () => new Date(w.clock.ms) }, ORG, developerId, { targets: [{ channel: CONVERSATION.channel, conversation: CONVERSATION }] });
    await w.h.store.put({ item: { pk: "NOTIFY_PENDING", sk: `${ORG}#${developerId}#${SESSION}#needs_you`, orgId: ORG, developerId, sessionId: SESSION, kind: "needs_you", at: "2026-11-09T10:00:00.000Z" } });
  }
  const report = await deliverAttention({ store: w.h.store, registry: w.registry, now: () => w.clock.ms, access: async () => ({ owner: false }), companyOf: async () => ORG, log: () => undefined }, { companyId: ORG, maxItems: 100, deadlineMs: w.clock.ms + 1000 });
  expect(report).toMatchObject({ people: 40, sent: 40, complete: false });
  expect((await w.h.store.query({ pk: "NOTIFY_PENDING" })).items).toHaveLength(10);
});

it("shares the notification deadline across targets instead of resetting it per send", async () => {
  const { host, ORG, OWNER_ID, SESSION, CONVERSATION } = await import("../support/service-host.js");
  const { writeNotifyPrefs } = await import("../../packages/broker/src/core/notify/prefs.js");
  const w = await host();
  w.state.facts.workflow = { stage: "PLAN_REVIEW", state: "WAITING" };
  await w.sessions.refresh(ORG, SESSION);
  await writeNotifyPrefs({ store: w.h.store, now: () => new Date(w.clock.ms) }, ORG, OWNER_ID, { targets: [CONVERSATION, { ...CONVERSATION, space: "other" }].map((conversation) => ({ channel: conversation.channel, conversation })) });
  await w.h.store.put({ item: { pk: "NOTIFY_PENDING", sk: `${ORG}#${OWNER_ID}#${SESSION}#needs_you`, orgId: ORG, developerId: OWNER_ID, sessionId: SESSION, kind: "needs_you", at: "2026-11-09T10:00:00.000Z" } });
  const deliver = vi.spyOn(w.chat, "deliver").mockImplementation(async () => { w.clock.ms += 6; });
  await deliverAttention({ store: w.h.store, registry: w.registry, now: () => w.clock.ms, companyOf: async () => ORG, log: () => undefined }, { companyId: ORG, deadlineMs: w.clock.ms + 5 });
  expect(deliver).toHaveBeenCalledTimes(1);
});

it("shares one recovery-index read across company passes in a scheduled invocation", async () => {
  const { host, ORG } = await import("../support/service-host.js");
  const { createBrokerCoreServices, withSharedMergeRecovery } = await import("../../packages/broker/src/aws/core-job-services.js");
  const { TASK_ID } = await import("../support/merge-world.js");
  const { recoveryRowKey } = await import("../../packages/broker/src/core/merge/store.js");
  const w = await host();
  const otherId = "33333333-3333-4333-8333-333333333333";
  const original = (await w.h.store.get({ pk: `DEVTASK#${TASK_ID}`, sk: "META" }))!;
  await w.h.store.put({ item: { ...original, pk: `DEVTASK#${otherId}`, taskId: otherId, companyId: B } });
  const { coreTaskMarkKey } = await import("../../packages/broker/src/core-host/core-task-mark.js");
  await w.h.store.put({ item: { ...(await w.h.store.get(coreTaskMarkKey(TASK_ID)))!, ...coreTaskMarkKey(otherId), taskId: otherId } });
  await w.h.store.put({ item: { ...recoveryRowKey(otherId), taskId: otherId, kind: "tracking", nextAttemptAt: 0 } });
  const query = vi.spyOn(w.h.store, "query");
  const services = [ORG, B].map((companyId) => createBrokerCoreServices({ companyId, flow: { ...w.h.flow, deps: { ...w.h.deps, companyId } }, registry: w.registry,
    ciMode: async () => "their_ci_fix" as const, repository: w.world.host.repository, people: w.people, now: () => new Date(w.clock.ms) }));
  await withSharedMergeRecovery(async () => {
    for (const service of services) expect(await service["merge-tracking"].pass({ budgetMs: 1000 })).toMatchObject({ attempted: 1 });
  });
  expect(query.mock.calls.filter(([input]) => input.pk === "WORKFLOW_MERGE_RECOVERY")).toHaveLength(1);
});

it("delivers pending attention when no application summary reader is installed", async () => {
  const { host, ORG, SESSION, OWNER_ID, CONVERSATION } = await import("../support/service-host.js");
  const w = await host(); w.clock.ms = Date.now();
  await w.sessions.refresh(ORG, SESSION);
  w.state.facts.workflow = { stage: "PLAN_REVIEW", state: "WAITING" }; await w.sessions.refresh(ORG, SESSION);
  const deliver = vi.spyOn(w.chat, "deliver");
  const result = await deliverAttention({ store: w.h.store, registry: w.registry, now: () => w.clock.ms, companyOf: async () => ORG,
    access: async () => ({ owner: true }), thread: async () => ({ personId: OWNER_ID, conversation: CONVERSATION }) }, { companyId: ORG, deadlineMs: w.clock.ms + 10000 });
  expect(result.sent).toBe(1); expect(deliver).toHaveBeenCalled();
});

it("retries thread refreshes from the real company session pass even when the summary is unchanged", async () => {
  const { host, ORG } = await import("../support/service-host.js");
  const { createBrokerCoreServices } = await import("../../packages/broker/src/aws/core-job-services.js");
  const w = await host();
  const threadRefresh = vi.fn(async (_orgId: string, _sessionId: string, store: DocumentStore) => { expect(store).not.toBe(w.h.store); });
  const services = createBrokerCoreServices({ companyId: ORG, flow: w.h.flow, registry: w.registry, ciMode: async () => "their_ci_fix" as const, people: w.people,
    summary: { facts: w.sessions.deps.facts, cost: w.sessions.deps.cost }, threadRefresh, now: () => new Date(w.clock.ms) });
  await services["session-sweep"].pass({ budgetMs: 1000 });
  await services["session-sweep"].pass({ budgetMs: 1000 });
  expect(threadRefresh).toHaveBeenCalledTimes(2);
  expect(threadRefresh.mock.calls.every(([org]) => org === ORG)).toBe(true);
});

it("thread refresh cannot read past the company session pass deadline", async () => {
  const { agentSessionKey } = await import("@agentx/contracts");
  const { host, ORG, SESSION } = await import("../support/service-host.js");
  const { createBrokerCoreServices } = await import("../../packages/broker/src/aws/core-job-services.js");
  const w = await host();
  let attempted = false, permitted = false;
  const services = createBrokerCoreServices({ companyId: ORG, flow: w.h.flow, registry: w.registry, ciMode: async () => "their_ci_fix" as const, people: w.people,
    summary: { facts: w.sessions.deps.facts, cost: w.sessions.deps.cost }, now: () => new Date(w.clock.ms),
    threadRefresh: async (_orgId, _sessionId, store) => {
      w.clock.ms += 1001;
      attempted = true;
      await store.get(agentSessionKey(ORG, SESSION, "META"));
      permitted = true;
    } });
  await services["session-sweep"].pass({ budgetMs: 1000 });
  expect(attempted).toBe(true);
  expect(permitted).toBe(false);
});

import { feedbackWorld } from "../support/pr-feedback-world.js";
import { composeHostedPrFeedbackRoutes, servesPrFeedbackDecisions } from "../../packages/broker/src/core-host/pr-feedback-routes.js";
import * as trackingModule from "../../packages/broker/src/services/merge-tracking.js";
import * as edgesModule from "../../packages/broker/src/core/merge/repository-edges.js";

it.each([false, true])("cold hosted job propagates only a served base (%s) to its exact bounded tracking object", async served => {
  const w = await feedbackWorld();
  w.h.deps.access.ownerActing = async () => ({ actorId: w.task.ownerKey });
  w.h.deps.taskCapUsd = async () => 10;
  w.h.deps.taskSpendUsd = async () => 0;
  const { createBrokerCoreServices } = await import("../../packages/broker/src/aws/core-job-services.js");
  const services = createBrokerCoreServices({ companyId: w.h.deps.companyId, flow: w.h.flow, registry: w.registry, ciMode: async () => "their_ci_watch" as const, people: w.people, repository: w.deps.repository, now: () => new Date(w.clock.ms) });
  if (served) composeHostedPrFeedbackRoutes(w.h.deps);
  const tracking = vi.spyOn(trackingModule, "createMergeTrackingService");
  const edges = vi.spyOn(edgesModule, "createTaskRepositoryEdgesSeam");
  await services["merge-tracking"].pass({ budgetMs: 1000 });
  const deps = tracking.mock.calls.at(-1)![0].flow;
  const sibling = edges.mock.calls.at(-1)![0].flow;
  expect(deps).not.toBe(w.h.deps);
  expect(deps.store).not.toBe(w.h.deps.store);
  expect(servesPrFeedbackDecisions(deps)).toBe(served);
  expect(servesPrFeedbackDecisions(sibling as TaskFlowDeps)).toBe(false);
  expect(w.read).toHaveBeenCalledTimes(served ? 1 : 0);
  const task = await w.h.store.get(w.task);
  expect(task?.["workflow"]).toMatchObject(served ? { feedbackReview: { status: "COLLECTING" } } : { revision: w.task.workflow!.revision });
});

it("a cold hosted job with a missing spend seam never recovers a collecting paid review", async () => {
  const { collectPrFeedback } = await import("../../packages/broker/src/core/pr-feedback/collect.js");
  const { readTask } = await import("../../packages/broker/src/core/task-flow/reads.js");
  const { dispatchRowKey, dispatchPartition } = await import("../../packages/broker/src/core/task-flow/keys.js");
  const { createBrokerCoreServices } = await import("../../packages/broker/src/aws/core-job-services.js");
  const w = await feedbackWorld();
  await collectPrFeedback(w.deps, w.task, w.budget);
  const before = (await readTask(w.h.deps, w.task.taskId))!;
  expect(before.workflow!.feedbackReview?.status).toBe("COLLECTING");
  await w.h.store.delete({ key: dispatchRowKey(w.h.deps.companyId, before.taskId, before.workflow!.revision) });
  w.h.deps.access.ownerActing = async () => ({ actorId: w.task.ownerKey });
  w.h.deps.taskCapUsd = async () => 10;
  delete w.h.deps.taskSpendUsd;
  composeHostedPrFeedbackRoutes(w.h.deps);
  expect(servesPrFeedbackDecisions(w.h.deps)).toBe(false);
  w.read.mockClear(); w.put.mockClear();
  const admit = vi.spyOn(w.h.deps.admission, "admit");
  const services = createBrokerCoreServices({ companyId: w.h.deps.companyId, flow: w.h.flow, registry: w.registry, people: w.people, repository: w.deps.repository, ciMode: async () => "their_ci_watch" as const, now: () => new Date(w.clock.ms) });
  expect(await services["merge-tracking"].pass({ budgetMs: 1000 })).toMatchObject({ attempted: 1 });
  expect((await w.h.store.query({ pk: dispatchPartition(w.h.deps.companyId) })).items).toEqual([]);
  expect((await readTask(w.h.deps, w.task.taskId))!.workflow).toMatchObject(before.workflow!);
  expect(w.read).not.toHaveBeenCalled(); expect(w.put).not.toHaveBeenCalled(); expect(admit).not.toHaveBeenCalled();
});
