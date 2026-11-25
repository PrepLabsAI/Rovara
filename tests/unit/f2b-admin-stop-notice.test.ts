// F2-B (controller addition): when a company admin who is not the owner stops the owner's task, the owner is told ONCE, in plain words from the shared table, with no "needs you". Delivery side: the pending row the stop writes
// reaches the owner's chat as one notice ("<name> stopped your task"), is not sent twice, is told to nobody but the owner, and is dropped when the session ended. (The writing side, and the owner's own stop telling nobody, are in
// `f2b-serve-standing.test.ts`.)
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, INDEX_EXPIRY_ATTRIBUTE, NOTICE_WORDS, type ConversationRef, type OrgId } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createAdapterRegistry } from "../../packages/broker/src/ports/adapter-registry.js";
import { FakeChannelAdapter } from "../../packages/broker/src/ports/fake-channel-adapter.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { createTaskSessionItems, developerIdOf, taskSessionId } from "../../packages/broker/src/core/sessions/index.js";
import { deliverAttention, writeNotifyPrefs } from "../../packages/broker/src/core/notify/index.js";
import { STOPPED_BY_ADMIN, pendingRowKey } from "../../packages/broker/src/core/notify/pending-keys.js";

const ORG = IMPLICIT_COMPANY_ID as OrgId;
const OWNER = localOwnerPrincipal();
const OWNER_ID = developerIdOf(OWNER);
const TASK = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const SESSION = taskSessionId(TASK);
const T0 = "2026-11-09T10:00:00.000Z";
const NOW_MS = Date.parse("2026-11-09T10:05:00.000Z");
const CONVERSATION: ConversationRef = { channel: "examplechat", tenant: "team1", space: "room1", thread: "main" };

async function world() {
  const store = new MemoryDocumentStore();
  await store.transact(createTaskSessionItems({ orgId: ORG, sessionId: SESSION, taskId: TASK, project: "web", agent: { agentId: "rovara-code", name: "Rovara Code", version: 1 }, title: "Add retry", owner: OWNER, origin: "app", payer: { kind: "member", developerId: OWNER_ID } as never, now: T0 }));
  const registry = createAdapterRegistry();
  const adapter = new FakeChannelAdapter();
  registry.register("channel", "examplechat", adapter);
  await writeNotifyPrefs({ store, now: () => new Date(NOW_MS) }, ORG, OWNER_ID, { targets: [{ channel: CONVERSATION.channel, conversation: CONVERSATION }], muted: false });
  const row = (developerId: string, stoppedBy = "Alex Admin") => store.put({ item: { ...pendingRowKey(ORG, developerId, SESSION, STOPPED_BY_ADMIN), entityType: "NOTIFY_PENDING", orgId: ORG, developerId, sessionId: SESSION, kind: STOPPED_BY_ADMIN, at: T0, stoppedBy, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(NOW_MS / 1000) + 86_400 } });
  const deliver = () => deliverAttention({ store, registry, now: () => NOW_MS, log: () => undefined, link: (session) => `https://example.test/sessions/${session.sessionId}` });
  return { store, adapter, row, deliver };
}

describe("the owner is told once that an admin stopped their task", () => {
  it("one plain notice with the admin's name from the shared words, no Needs you, and nothing the second time", async () => {
    const w = await world();
    await w.row(OWNER_ID);
    expect(await w.deliver()).toMatchObject({ sent: 1 });
    expect(w.adapter.delivered).toHaveLength(1);
    const text = JSON.stringify(w.adapter.delivered[0]);
    expect(text).toContain(NOTICE_WORDS.stoppedByAdmin("Alex Admin"));
    expect(text).toContain("A notice from Rovara:");
    expect(text).not.toMatch(/needs you|needs your attention/iu);
    expect(await w.deliver()).toMatchObject({ sent: 0 });
    expect(w.adapter.delivered).toHaveLength(1);
  });

  it("is told to the task's owner only: a row for anyone else is dropped without a word", async () => {
    const w = await world();
    await w.row(developerIdOf({ ...OWNER, personId: "someone-else" }));
    await w.deliver();
    expect(w.adapter.delivered).toEqual([]);
  });

  it("makes an email address in the name safe, and falls back to plain words for no name", async () => {
    const w = await world();
    await w.row(OWNER_ID, "alex@example.test");
    await w.deliver();
    expect(JSON.stringify(w.adapter.delivered[0])).not.toContain("alex@example.test");
    expect(NOTICE_WORDS.stoppedByAdmin("")).toBe("A company admin stopped your task");
  });
});
