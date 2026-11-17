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
import { PENDING_PK, inboxPartition, queueAttention } from "../../packages/broker/src/core/notify/index.js";
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

  it("keeps both the pending row and the inbox row when something can message people", async () => {
    const w = await world({ inbox: true, channel: true });
    await w.move("PLAN_REVIEW", "WAITING");
    expect(await w.pending()).toHaveLength(1);
    expect(await w.inbox()).toHaveLength(1);
    const plain = await world({ channel: true });
    await plain.move("PLAN_REVIEW", "WAITING");
    expect(await plain.pending()).toHaveLength(1);
    expect(await plain.inbox()).toHaveLength(1);
  });

  it("names the same recipients as the queue does, and the rows do not pile up: one per person, session and kind, replaced by the next change, each with the store's expiry", async () => {
    const both = await world({ inbox: true, channel: true });
    const only = await world({ inbox: true });
    for (const w of [both, only]) {
      await w.move("PLAN_REVIEW", "WAITING");
      for (let round = 0; round < 3; round += 1) { await w.move("IMPLEMENT", "RUNNING"); await w.move("PLAN_REVIEW", "WAITING"); }
    }
    const keys = async (w: typeof both) => (await w.inbox()).map((row) => `${String(row["pk"])}|${String(row["sk"])}`);
    expect(await keys(only)).toEqual(await keys(both));
    expect(await keys(only)).toHaveLength(1);
    expect((await both.pending()).map((row) => row["developerId"])).toEqual((await both.inbox()).map((row) => row["developerId"]));
    const row = (await only.inbox())[0]!;
    expect(row["indexExpiresAt"]).toBe(Math.floor(NOW / 1000) + 14 * 86_400);
    expect(row["expiresAtSec"]).toBe(row["indexExpiresAt"]);
  });

  it("queueAttention with pending: false writes no pending row and the same inbox row; an unset flag writes both", async () => {
    const run = async (pending: boolean | undefined) => {
      const store = new MemoryDocumentStore();
      await store.transact(createTaskSessionItems({ orgId: ORG, sessionId: SESSION, taskId: TASK, project: "web", agent: AGENT, title: "Add retry", owner: OWNER, origin: "app", payer: { kind: "member", developerId: OWNER_ID } as never, now: T0 }));
      const facts: { value: SessionTaskFacts } = { value: { companyId: ORG, taskId: TASK, project: "web", ownerDeveloperId: OWNER_ID, runStatus: "RUNNING", workflow: { stage: "IMPLEMENT", state: "RUNNING" }, step: "Coding", updatedAt: T0 } };
      let ms = NOW - 3_600_000;
      const deps: SummaryDependencies = { store, facts: { read: async () => facts.value }, cost: { costUsd: async () => 0 }, now: () => new Date(ms), log: () => undefined, onChange: [async (change) => { await queueAttention({ store, now: () => new Date(NOW), ...(pending === undefined ? {} : { pending }) }, change); }] };
      for (const [stage, state] of [["IMPLEMENT", "RUNNING"], ["PLAN_REVIEW", "WAITING"]] as const) { facts.value = { ...facts.value, workflow: { stage, state } }; ms += 1_000; await refreshSessionSummary(deps, ORG, SESSION); }
      return { pending: (await store.query({ pk: PENDING_PK })).items.length, inbox: (await store.query({ pk: inboxPartition(ORG, OWNER_ID) })).items.length };
    };
    expect(await run(false)).toEqual({ pending: 0, inbox: 1 });
    expect(await run(true)).toEqual({ pending: 1, inbox: 1 });
    expect(await run(undefined)).toEqual({ pending: 1, inbox: 1 });
  });

  it("is switched on by the hosted job services alone", () => {
    const jobs = readFileSync("packages/broker/src/aws/core-job-services.ts", "utf8");
    expect(jobs).toContain("createNoticeService({ store, registry, now: clock, log, inbox: true, ...options.notification })");
    const others = ["packages/broker/src/services/notices.ts", "packages/broker/src/core-host/code-modules.ts", "packages/broker/src/local/runtime.ts"].map((file) => readFileSync(file, "utf8")).join("\n");
    expect(others).not.toMatch(/inbox:\s*true/u);
  });
});
