// The admin notice for an unusual amount of team knowledge read (owner decision 2026-11-17): it rides the attention queue, is told only to a person who is an admin now, in fixed words with no name and no text, and a task notice
// is unchanged by it.
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, type ConversationRef, type OrgId } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../../packages/broker/src/ports/memory-document-store.js";
import { createAdapterRegistry } from "../../../packages/broker/src/ports/adapter-registry.js";
import { FakeChannelAdapter } from "../../../packages/broker/src/ports/fake-channel-adapter.js";
import { ADMIN_NOTICE_LINE, PENDING_PK, deliverAttention, queueAdminNotice, writeNotifyPrefs } from "../../../packages/broker/src/core/notify/index.js";
import { createNoticeService } from "../../../packages/broker/src/services/notices.js";

const ORG = IMPLICIT_COMPANY_ID as OrgId;
const ADMIN = "local-owner";
const CONVERSATION: ConversationRef = { channel: "examplechat", tenant: "team1", space: "room1", thread: "main" };
const clock = { ms: Date.parse("2026-11-09T10:05:00.000Z") };

async function world() {
  const store = new MemoryDocumentStore();
  const registry = createAdapterRegistry();
  const adapter = new FakeChannelAdapter();
  registry.register("channel", "examplechat", adapter);
  await writeNotifyPrefs({ store, now: () => new Date(clock.ms) }, ORG, ADMIN, { targets: [{ channel: "examplechat", conversation: CONVERSATION }], muted: false });
  const deliver = (overrides: Record<string, unknown> = {}) => deliverAttention({ store, registry, now: () => clock.ms, log: () => undefined, adminNotice: async (_org, who) => who === ADMIN, ...overrides });
  return { store, registry, adapter, deliver, queue: () => queueAdminNotice({ store, now: () => new Date(clock.ms) }, { orgId: ORG, developerIds: [ADMIN], noticeId: "knowledge-2026-11-09-abcdef0123456789", kind: "knowledge_read" }) };
}

describe("an admin notice", () => {
  it("is queued once a day's id, told to the admin in fixed words with no name, id or text, and removed", async () => {
    const w = await world();
    expect(await w.queue()).toBe(1);
    expect(await w.queue()).toBe(1);
    expect((await w.store.query({ pk: PENDING_PK })).items).toHaveLength(1);
    expect(await w.deliver()).toMatchObject({ people: 1, sent: 1, dropped: 0 });
    const event = w.adapter.delivered[0]!;
    const words = (event.data as { text: string }).text;
    expect(words).toContain(ADMIN_NOTICE_LINE.knowledge_read.title);
    expect(words).toContain(ADMIN_NOTICE_LINE.knowledge_read.status);
    expect(words).not.toMatch(/needs your attention|task/iu);
    expect(words).not.toContain(ADMIN);
    expect(words).not.toContain("knowledge-2026");
    expect((await w.store.query({ pk: PENDING_PK })).items).toHaveLength(0);
  });

  it("is not told to a person who is not an admin now, or when nothing can say who is an admin (fail closed): the row goes and nothing is sent", async () => {
    for (const override of [{ adminNotice: async () => false }, { adminNotice: async () => { throw new Error("down"); } }, { adminNotice: undefined }]) {
      const w = await world();
      await w.queue();
      expect(await w.deliver(override)).toMatchObject({ sent: 0, dropped: 1 });
      expect(w.adapter.delivered).toHaveLength(0);
      expect((await w.store.query({ pk: PENDING_PK })).items).toHaveLength(0);
    }
  });

  it("refuses an id or a kind it does not know, writes nothing for a host that can tell nobody, and never throws on a store fault", async () => {
    const w = await world();
    for (const noticeId of ["", "has space", "x".repeat(65), "a#b"]) expect(await queueAdminNotice({ store: w.store }, { orgId: ORG, developerIds: [ADMIN], noticeId, kind: "knowledge_read" })).toBe(0);
    expect(await queueAdminNotice({ store: w.store }, { orgId: ORG, developerIds: [ADMIN], noticeId: "ok-id", kind: "other" as never })).toBe(0);
    expect(await queueAdminNotice({ store: w.store, pending: false }, { orgId: ORG, developerIds: [ADMIN], noticeId: "ok-id", kind: "knowledge_read" })).toBe(0);
    expect(await queueAdminNotice({ store: { put: async () => { throw new Error("down"); } }, log: () => undefined }, { orgId: ORG, developerIds: [ADMIN], noticeId: "ok-id", kind: "knowledge_read" })).toBe(0);
    expect((await w.store.query({ pk: PENDING_PK })).items).toHaveLength(0);
  });

  it("through the notice service: queued only when something can be told, and the same service delivers it", async () => {
    const w = await world();
    const service = createNoticeService({ store: w.store, registry: w.registry, now: () => new Date(clock.ms), adminNotice: async () => true });
    expect(await service.queueAdmin({ orgId: ORG, developerIds: [ADMIN], noticeId: "svc-1", kind: "knowledge_read" })).toBe(1);
    expect(await service.deliver()).toMatchObject({ sent: 1 });
    const nobody = createNoticeService({ store: new MemoryDocumentStore(), registry: createAdapterRegistry(), now: () => new Date(clock.ms) });
    expect(await nobody.queueAdmin({ orgId: ORG, developerIds: [ADMIN], noticeId: "svc-2", kind: "knowledge_read" })).toBe(0);
  });
});
