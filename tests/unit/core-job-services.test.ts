import { expect, it, vi } from "vitest";
import { sweepOpenSessions } from "../../packages/broker/src/core/sessions/sweep.js";
import { deliverAttention } from "../../packages/broker/src/core/notify/attention.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createAdapterRegistry } from "../../packages/broker/src/ports/adapter-registry.js";
import { createTaskSessionItems, taskSessionId } from "../../packages/broker/src/core/sessions/create.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa", B = "org_bbbbbbbbbbbbbbbbbbbb";


it("session sweep refreshes only its company, even for the same raw session id", async () => {
  const store = new MemoryDocumentStore();
  const id = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
  const sessionId = taskSessionId(id);
  for (const orgId of [A, B]) await store.transact(createTaskSessionItems({ orgId, sessionId, taskId: id, project: "web", agent: { agentId: "rovara-code", name: "Rovara Code", version: 1 }, title: "Work", owner: localOwnerPrincipal(), origin: "app", payer: { kind: "member", developerId: "a".repeat(64) } as never, now: "2026-11-09T10:00:00.000Z" }));
  const query = vi.spyOn(store, "query");
  const read = vi.fn(async () => undefined);
  const result = await sweepOpenSessions({ store, facts: { read }, cost: { costUsd: async () => 0 }, now: () => new Date("2026-11-09T11:00:00.000Z") }, { companyId: A, maxItems: 100, budgetMs: 100 });
  expect(result.visited).toBe(1);
  expect(query).toHaveBeenCalledWith(expect.objectContaining({ sk: { op: "beginsWith", prefix: `${A}#` } }));
  expect(read).toHaveBeenCalledWith(A, id);
  expect(read).not.toHaveBeenCalledWith(B, id);
});

it("notification sweep leaves another company's identical raw ids queued", async () => {
  const store = new MemoryDocumentStore();
  for (const orgId of [A, B]) await store.put({ item: { pk: "NOTIFY_PENDING", sk: `${orgId}#person#session#ready`, orgId, developerId: "person", sessionId: "session", kind: "ready", at: "2026-11-09T10:00:00.000Z" } });
  const query = vi.spyOn(store, "query");
  const result = await deliverAttention({ store, registry: createAdapterRegistry(), now: () => Date.parse("2026-11-09T11:00:00.000Z"), log: () => undefined }, { companyId: A });
  expect(result.dropped).toBe(1);
  expect(query.mock.calls[0]?.[0]).toMatchObject({ sk: { op: "beginsWith", prefix: `${A}#` } });
  expect((await store.query({ pk: "NOTIFY_PENDING" })).items.map((row) => row["orgId"])).toEqual([B]);
});

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

it("resumes a capped session scan on the next pass", async () => {
  const store = new MemoryDocumentStore();
  for (let n = 0; n < 5; n++) await store.put({ item: { pk: "OPEN_AGENT_SESSIONS", sk: `${A}#${n}`, orgId: A, sessionId: `ses_${String(n).padStart(20, "0")}` } });
  const deps = { store, facts: { read: async () => undefined }, cost: { costUsd: async () => 0 }, now: () => new Date(1000) };
  const scan = { cursor: undefined as string | undefined };
  const first = await sweepOpenSessions(deps, { companyId: A, maxItems: 3, budgetMs: 100, scan });
  const second = await sweepOpenSessions(deps, { companyId: A, maxItems: 3, budgetMs: 100, scan });
  expect(first).toMatchObject({ visited: 3, complete: false });
  expect(second).toMatchObject({ visited: 2, complete: true });
});

it("refuses an unscoped notification transport with fixed words", async () => {
  const { host, ORG } = await import("../support/service-host.js");
  const { createBrokerCoreServices } = await import("../../packages/broker/src/aws/core-job-services.js");
  const w = await host();
  const services = createBrokerCoreServices({ companyId: ORG, flow: w.h.flow, registry: w.registry, ciMode: async () => "their_ci_fix" as const, people: w.people });
  await expect(services["notify-deliver"].pass({ budgetMs: 1000 })).rejects.toThrow(new Error("the core job could not finish"));
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
