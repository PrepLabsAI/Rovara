// Web task channel C7b: on the hosted core nothing may be able to message anyone (no chat, no email), yet a person must still find what waits for them in the in-app inbox. The notice service then keeps
// the inbox rows and nothing else; every other host (a laptop) queues exactly what it queued before.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, type OrgId } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createAdapterRegistry } from "../../packages/broker/src/ports/adapter-registry.js";
import { FakeChannelAdapter } from "../../packages/broker/src/ports/fake-channel-adapter.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { createTaskSessionItems, developerIdOf, refreshSessionSummary, taskSessionId, type SessionTaskFacts, type SummaryDependencies } from "../../packages/broker/src/core/sessions/index.js";
import { PENDING_PK, inboxPartition } from "../../packages/broker/src/core/notify/index.js";
import { createNoticeService } from "../../packages/broker/src/services/notices.js";

const ORG = IMPLICIT_COMPANY_ID as OrgId;
const OWNER = localOwnerPrincipal();
const OWNER_ID = developerIdOf(OWNER);
const T0 = "2026-11-09T10:00:00.000Z";
const NOW = Date.parse("2026-11-09T12:00:00.000Z");
const AGENT = { agentId: "rovara-code", name: "Rovara Code", version: 1 };
const TASK = "00000000-0000-4000-8000-000000000001";
const SESSION = taskSessionId(TASK);

async function world(options: { inbox?: boolean; channel?: boolean } = {}) {
  const store = new MemoryDocumentStore();
  const registry = createAdapterRegistry();
  if (options.channel === true) registry.register("channel", "examplechat", new FakeChannelAdapter());
  const notices = createNoticeService({ store, registry, now: () => new Date(NOW), log: () => undefined, ...(options.inbox === undefined ? {} : { inbox: options.inbox }) });
  await store.transact(createTaskSessionItems({ orgId: ORG, sessionId: SESSION, taskId: TASK, project: "web", agent: AGENT, title: "Add retry", owner: OWNER, origin: "app", payer: { kind: "member", developerId: OWNER_ID } as never, now: T0 }));
  const facts: { value: SessionTaskFacts } = { value: { companyId: ORG, taskId: TASK, project: "web", ownerDeveloperId: OWNER_ID, runStatus: "RUNNING", workflow: { stage: "IMPLEMENT", state: "RUNNING" }, step: "Coding", updatedAt: T0 } };
  let ms = NOW - 3_600_000;
  const deps: SummaryDependencies = { store, facts: { read: async () => facts.value }, cost: { costUsd: async () => 0 }, now: () => new Date(ms), log: () => undefined, onChange: [async (change) => { await notices.queue(change); }] };
  const move = async (stage: string, state: string) => { facts.value = { ...facts.value, workflow: { stage, state } }; ms += 1_000; await refreshSessionSummary(deps, ORG, SESSION); };
  await move("IMPLEMENT", "RUNNING");
  const rows = async (pk: string) => (await store.query({ pk })).items;
  return { store, notices, move, pending: () => rows(PENDING_PK), inbox: () => rows(inboxPartition(ORG, OWNER_ID)) };
}

describe("the notice service's queue", () => {
  it("queues nothing at all on a host that can tell nobody and was not asked to keep an inbox (a laptop: unchanged)", async () => {
    for (const options of [{}, { inbox: false }]) {
      const w = await world(options);
      await w.move("PLAN_REVIEW", "WAITING");
      expect(await w.pending()).toEqual([]);
      expect(await w.inbox()).toEqual([]);
      expect(w.notices.canNotify()).toBe(false);
      expect(await w.notices.deliver()).toBeUndefined();
    }
  });

  it("keeps only the inbox row, and no pending row, on the hosted core when nothing can message anyone", async () => {
    const w = await world({ inbox: true });
    await w.move("PLAN_REVIEW", "WAITING");
    expect(await w.pending()).toEqual([]);
    const inbox = await w.inbox();
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ entityType: "NOTIFY_INBOX", orgId: ORG, developerId: OWNER_ID, sessionId: SESSION, kind: "needs_you" });
    expect(w.notices.canNotify()).toBe(false);
    expect(await w.notices.deliver()).toBeUndefined();
  });

  it("is switched on by the hosted job services alone", () => {
    const jobs = readFileSync("packages/broker/src/aws/core-job-services.ts", "utf8");
    // Batch b18 (#1030): the thread notification may bring its own registry view; the job services' registry is the fallback.
    expect(jobs).toContain("createNoticeService({ store, now: clock, log, inbox: true, peopleOf: taskPeopleRecipients(store), ...options.notification, registry: options.notification?.registry ?? registry })");
    const others = ["packages/broker/src/services/notices.ts", "packages/broker/src/core-host/code-modules.ts"].map((file) => readFileSync(file, "utf8")).join("\n");
    expect(others).not.toMatch(/inbox:\s*true/u);
  });
});
