
import { describe, expect, it } from "vitest";
import {
  IMPLICIT_COMPANY_ID,
  type ActorRef, type ConversationRef, type DocumentStore, type InboundMessage, type OrgId, type TransactItem,
} from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { FakeChannelAdapter } from "../../packages/broker/src/ports/fake-channel-adapter.js";
import {
  DECISION_REFUSAL_WORDS, bindChannelSpace, channelLinkFence, createChannelSink, issueChannelLinkCode, redeemChannelLinkCode, removeChannelLink, type ChannelWork,
} from "../../packages/broker/src/core/channel/index.js";
import { withStartFence, withStartFenceExtras } from "../../packages/broker/src/core/task-flow/start-fence.js";
import { withStartFence as runtimeWithStartFence } from "../../packages/broker/src/core-host/core-runtime.js";
import { createLocalChat } from "../../packages/broker/src/local/app/chat.js";
import { createSessionStartExtras } from "../../packages/broker/src/local/app/session-start.js";
import { developerIdOf } from "../../packages/broker/src/core/sessions/create.js";
import { createHarness } from "../support/task-flow-harness.js";

const ORG = IMPLICIT_COMPANY_ID as OrgId;
const clock = { ms: Date.parse("2026-11-10T10:00:00.000Z") };
const now = (): number => clock.ms;
const PERSON_A = "a".repeat(64);
const ACTOR: ActorRef = { channel: "examplechat", tenant: "team1", userId: "U0SECRETUSER" };
const CONVERSATION: ConversationRef = { channel: "examplechat", tenant: "team1", space: "room1", thread: "main" };

async function link(store: DocumentStore, personId: string, actor: ActorRef = ACTOR, orgId: OrgId = ORG): Promise<void> {
  const deps = { store, orgId, now };
  const { code } = await issueChannelLinkCode(deps, actor);
  await redeemChannelLinkCode(deps, personId, code);
}

function sinkWorld(options: { personOf?: (orgId: OrgId, actor: ActorRef) => Promise<string | undefined>; fenceOf?: (orgId: OrgId, actor: ActorRef, personId: string) => readonly TransactItem[] } = {}) {
  const store = new MemoryDocumentStore();
  const adapter = new FakeChannelAdapter();
  Object.assign(adapter, { projects: ["web"] });
  const seen = { messages: [] as Array<Parameters<ChannelWork["message"]>[0]>, decisions: [] as Array<Parameters<ChannelWork["decide"]>[0]> };
  const work: ChannelWork = {
    async message(item) { seen.messages.push(item); },
    async decide(item) { seen.decisions.push(item); return { status: "decided" }; },
  };
  const sink = createChannelSink({ channel: "examplechat", adapter, store, orgId: ORG, now, work, linkWords: (code) => `Link with ${code}.`, log: () => undefined, ...options });
  return { store, adapter, sink, seen };
}
const message = (id: string): InboundMessage => ({ version: 2, channel: "examplechat", eventId: id, conversation: CONVERSATION, actor: ACTOR, text: "add a retry", receivedAt: "2026-11-10T10:00:00.000Z" });

describe("the sink hands the fence to the work seam", () => {

  it("a host's own person rule gives its own fence, or none when it names none", async () => {
    const own: TransactItem = { kind: "check", key: { pk: "HOST#PERSON", sk: "x" }, condition: { op: "exists", path: ["pk"] } };
    const withFence = sinkWorld({ personOf: async () => PERSON_A, fenceOf: (orgId, actor, personId) => (orgId === ORG && actor.userId === ACTOR.userId && personId === PERSON_A ? [own] : []) });
    await bindChannelSpace({ store: withFence.store, orgId: ORG, now }, { channel: "examplechat", tenant: "team1", space: "room1" }, "web");
    await withFence.sink.message(message("h1"));
    expect(withFence.seen.messages[0]!.fence).toEqual([own]);
    const without = sinkWorld({ personOf: async () => PERSON_A });
    await bindChannelSpace({ store: without.store, orgId: ORG, now }, { channel: "examplechat", tenant: "team1", space: "room1" }, "web");
    await without.sink.message(message("h2"));
    expect(without.seen.messages[0]!.fence).toEqual([]);
  });
});

describe("a start for the linked person loses to an unlink that committed first", () => {
  const harnessed = async () => {
    const h = createHarness({ understandFirst: true });
    await h.registerProject();
    h.deps.startExtras = withStartFenceExtras(createSessionStartExtras(h.deps.companyId));
    const ownerId = developerIdOf(h.owner.principal);
    const chat = createLocalChat({ registry: { get: () => undefined, names: () => [] }, store: h.store, companyId: h.deps.companyId, owner: h.owner.principal, now: () => h.clock.now, flow: h.flow, gate: { decide: async () => ({ status: "refused", reason: "invalid" }) } as never });
    const actor: ActorRef = { channel: "examplechat", tenant: "T1", userId: "U1" };
    const msg = (eventId: string): InboundMessage => ({ version: 2, channel: "examplechat", eventId, text: "Build it", receivedAt: new Date(h.clock.now).toISOString(), actor, conversation: { channel: "examplechat", tenant: "T1", space: "C1", thread: "1" } });
    await link(h.store, ownerId, actor, h.deps.companyId);
    return { h, chat, ownerId, actor, msg };
  };

  it("the link removed between the sink's read and the start: nothing is started", async () => {
    const { h, chat, ownerId, actor, msg } = await harnessed();
    const fence = [channelLinkFence(h.deps.companyId, actor, ownerId)];
    await removeChannelLink({ store: h.store, orgId: h.deps.companyId, now: () => h.clock.now }, actor, ownerId);
    await expect(chat.work("examplechat").message({ orgId: h.deps.companyId, projectName: "payments", personId: ownerId, message: msg("e2"), fence })).rejects.toThrow();
    expect((await h.flow.list(h.owner)).tasks).toHaveLength(0);
  });

  it("the fence belongs to its own call: a start outside it is not fenced, and the host runtime uses the same fence", async () => {
    expect(runtimeWithStartFence).toBe(withStartFence);
    const base = () => ({ items: [{ kind: "put", item: { pk: "A", sk: "B" } } as TransactItem] });
    const joined = withStartFenceExtras(base);
    const input = {} as never;
    expect(joined(input).items).toHaveLength(1);
    const fence: TransactItem = { kind: "check", key: { pk: "L", sk: "L" }, condition: { op: "exists", path: ["pk"] } };
    expect(await withStartFence([fence], async () => joined(input).items)).toEqual([...base().items, fence]);
  });
});

describe("the words said for a lost link", () => {
  it("are fixed and name no chat account and no person", () => {
    const words = DECISION_REFUSAL_WORDS["link_gone"];
    expect(words).toBeDefined();
    expect(words).not.toContain(ACTOR.userId);
    expect(words).not.toContain(PERSON_A);
    expect(words).not.toMatch(/[0-9a-f]{16}|U[0-9A-Z]{6,}/u);
  });
});
