// The core around an in-process channel adapter: linking a chat account to a person, binding a space to a project, the cards Rovara posts, and the sink that checks everything an adapter hears before it runs anything.
// The adapters here are fakes and no chat tool is named.
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, type ActorRef, type ChannelDecision, type ConversationRef, type InboundMessage, type OrgId } from "@agentx/contracts";
import { createLocalOwnerApprovers } from "../../packages/broker/src/ports/policy-defaults.js";
import { CHAT_METHOD_PREFIX } from "../../packages/broker/src/core/decisions/strong-methods.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { FakeChannelAdapter } from "../../packages/broker/src/ports/fake-channel-adapter.js";
import {
  bindChannelSpace, createChannelSink, issueChannelLinkCode, linkedPerson, listChannelLinks, postApprovalCard, previewChannelLinkCode, readApprovalCard, redeemChannelLinkCode, removeChannelLink, type ChannelWork,
} from "../../packages/broker/src/core/channel/index.js";

const ORG = IMPLICIT_COMPANY_ID as OrgId;
const clock = { ms: Date.parse("2026-11-10T10:00:00.000Z") };
const now = (): number => clock.ms;
const OWNER = "a".repeat(64);
const ACTOR: ActorRef = { channel: "examplechat", tenant: "team1", userId: "user1" };
const CONVERSATION: ConversationRef = { channel: "examplechat", tenant: "team1", space: "room1", thread: "main" };
const DIGEST = "b".repeat(64);

function world(options: { projects?: string[] } = {}) {
  const store = new MemoryDocumentStore();
  const adapter = new FakeChannelAdapter();
  Object.assign(adapter, { projects: options.projects ?? ["web"] });
  const calls = { messages: [] as Array<{ message: InboundMessage; projectName: string; personId: string }>, decisions: [] as Array<{ decision: ChannelDecision; personId: string; requestId: string }> };
  const behaviour = { decide: { status: "decided" } as { status: "decided" } | { status: "refused"; reason: string }, failMessage: false };
  const work: ChannelWork = {
    async message(item) { if (behaviour.failMessage) throw new Error("store fault"); calls.messages.push(item); },
    async decide(item) { calls.decisions.push({ decision: item.decision, personId: item.personId, requestId: item.card.requestId }); return behaviour.decide; },
  };
  const logs: Array<Record<string, unknown>> = [];
  const sink = createChannelSink({ channel: "examplechat", adapter, store, orgId: ORG, now, work, linkWords: (code) => `Link with ${code}.`, log: (entry) => logs.push(entry) });
  const deps = { store, orgId: ORG, now };
  return { store, adapter, calls, behaviour, sink, deps, logs, work };
}
const sent = (adapter: FakeChannelAdapter, type: string) => adapter.delivered.filter((event) => event.type === type);
const message = (id = "m1", overrides: Partial<InboundMessage> = {}): InboundMessage => ({ version: 2, channel: "examplechat", eventId: id, conversation: CONVERSATION, actor: ACTOR, text: "add a retry", receivedAt: "2026-11-10T10:00:00.000Z", ...overrides });

async function ready() {
  const w = world();
  await bindChannelSpace(w.deps, { channel: "examplechat", tenant: "team1", space: "room1" }, "web");
  const { code } = await issueChannelLinkCode(w.deps, ACTOR);
  await redeemChannelLinkCode(w.deps, OWNER, code);
  return w;
}

describe("linking a chat account", () => {

  it("refuses a second link for an account already linked, and lets a person remove only their own", async () => {
    const { deps } = world();
    await redeemChannelLinkCode(deps, OWNER, (await issueChannelLinkCode(deps, ACTOR)).code);
    await expect(redeemChannelLinkCode(deps, "c".repeat(64), (await issueChannelLinkCode(deps, ACTOR)).code)).rejects.toThrow(/already linked/u);
    await expect(removeChannelLink(deps, ACTOR, "c".repeat(64))).rejects.toThrow(/not found/u);
    expect(await linkedPerson(deps, ACTOR)).toBe(OWNER);
    await removeChannelLink(deps, ACTOR, OWNER);
    expect(await linkedPerson(deps, ACTOR)).toBeUndefined();
    expect(await listChannelLinks(deps, OWNER)).toEqual([]);
  });

  it("does not take a text that is not a code", async () => {
    const { deps } = world();
    await expect(redeemChannelLinkCode(deps, OWNER, "short")).rejects.toThrow();
    expect(await previewChannelLinkCode(deps, "x".repeat(32))).toBeUndefined();
  });
});

describe("the sink: a message", () => {

  it("frees the hour's notice when the private send fails, so the next mention sends the code again", async () => {
    const w = world();
    await bindChannelSpace(w.deps, { channel: "examplechat", tenant: "team1", space: "room1" }, "web");
    const real = w.adapter.deliver.bind(w.adapter);
    let fail = true;
    w.adapter.deliver = async (event) => { if (fail) throw new Error("cannot show privately"); await real(event); };
    await w.sink.message(message("p1"));
    expect(w.adapter.delivered).toEqual([]);
    fail = false;
    await w.sink.message(message("p2"));
    expect(sent(w.adapter, "progress")).toHaveLength(1);
    // Sent: the hour's claim holds again.
    await w.sink.message(message("p3"));
    expect(sent(w.adapter, "progress")).toHaveLength(1);
  });

  it("refuses a message whose actor is from another tenant than its conversation, or whose channel is not the adapter's", async () => {
    const w = await ready();
    // The foreign account is linked too, so the tenant check is the only thing that stops it.
    await redeemChannelLinkCode(w.deps, OWNER, (await issueChannelLinkCode(w.deps, { ...ACTOR, tenant: "team2" })).code);
    await w.sink.message(message("m1", { actor: { ...ACTOR, tenant: "team2" } }));
    await w.sink.message(message("m2", { channel: "otherchat", conversation: { ...CONVERSATION, channel: "otherchat" }, actor: { ...ACTOR, channel: "otherchat" } }));
    expect(w.calls.messages).toEqual([]);
  });

  it("releases its claim when the work fails, so the adapter's retry runs", async () => {
    const w = await ready();
    w.behaviour.failMessage = true;
    await expect(w.sink.message(message("m1"))).rejects.toThrow("store fault");
    w.behaviour.failMessage = false;
    await w.sink.message(message("m1"));
    expect(w.calls.messages).toHaveLength(1);
  });

  it("drops a malformed message without running anything", async () => {
    const w = await ready();
    await w.sink.message({ ...message("m1"), text: "" });
    expect(w.calls.messages).toEqual([]);
  });
});

describe("approval cards and the decisions that come back", () => {
  const card = (w: Awaited<ReturnType<typeof ready>>, kind: "plan_approval" | "admin" | "other") => postApprovalCard(
    w.deps, {
      channel: "examplechat", adapter: w.adapter, conversation: CONVERSATION, kind, subject: { type: "workflow-document", id: "task-1" }, revision: 3, artifactDigest: DIGEST,
      text: "Plan for task 1 waits for you.", taskUrl: "https://example.test/tasks/1", actions: [{ decision: "APPROVE", label: "Approve" }, { decision: "REJECT", label: "Reject" }],
    },
  );

  it("gives a card up after a day", async () => {
    const w = await ready();
    const { requestId } = await card(w, "other");
    clock.ms += 25 * 3_600_000;
    expect(await readApprovalCard(w.deps, requestId)).toBeUndefined();
    clock.ms -= 25 * 3_600_000;
  });
});

describe("a chat press is never an approval on Code's own rules", () => {
  it("is not a method Code's approvers offer, and a proof of that method is refused whatever it carries", async () => {
    const approvers = createLocalOwnerApprovers({ verifySession: () => true });
    const request = { companyId: ORG, requestId: "req-12345678", kind: "plan", subject: { type: "workflow-document", id: "task-1" }, revision: 3, artifactDigest: DIGEST, risk: "low" as const };
    const method = `${CHAT_METHOD_PREFIX}examplechat`;
    expect(method).toBe("chat-examplechat");
    const requirement = await approvers.requirement(request);
    expect(requirement.methods).not.toContain(method);
    expect(requirement.strongMethods).not.toContain(method);
    expect(requirement.rejectMethods).not.toContain(method);
    const verdict = await approvers.verify(request, { proofId: "p1", method, requestId: request.requestId, revision: 3, artifactDigest: DIGEST, token: "evt-1" });
    expect(verdict.approved).toBe(false);
  });
});

describe("the company and the person are seams", () => {
  const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;

  it("reads and writes every key under the company that answers for the tenant, and asks the host for the person", async () => {
    const w = world();
    const asked: string[] = [];
    const sink = createChannelSink({
      channel: "examplechat", adapter: w.adapter, store: w.store, orgId: ORG, now, work: w.work, linkWords: (code) => `Link with ${code}.`, log: () => undefined,
      companyOf: ({ tenant }) => (tenant === "team1" ? ORG_B : undefined),
      personOf: async (orgId, actor) => { asked.push(`${orgId}/${actor.userId}`); return actor.userId === "user1" ? OWNER : undefined; },
    });
    // A binding under the default company is not the company of this tenant's.
    await bindChannelSpace(w.deps, { channel: "examplechat", tenant: "team1", space: "room1" }, "web");
    await sink.message(message("c1"));
    expect(w.calls.messages).toEqual([]);
    await bindChannelSpace({ ...w.deps, orgId: ORG_B }, { channel: "examplechat", tenant: "team1", space: "room1" }, "web");
    await sink.message(message("c2"));
    expect(w.calls.messages).toHaveLength(1);
    expect(w.calls.messages[0]).toMatchObject({ orgId: ORG_B, personId: OWNER });
    expect(asked).toEqual([`${ORG_B}/user1`]);
    expect(await w.store.get({ pk: `ORG#${ORG_B}#CHANNEL_CLAIM#examplechat/EVENT#message/c2`, sk: "CLAIM" })).toBeDefined();
    expect(await w.store.get({ pk: `ORG#${ORG}#CHANNEL_CLAIM#examplechat/EVENT#message/c2`, sk: "CLAIM" })).toBeUndefined();
    // A tenant nobody answers for runs nothing.
    await sink.message(message("c3", { conversation: { ...CONVERSATION, tenant: "team9" }, actor: { ...ACTOR, tenant: "team9" } }));
    expect(w.calls.messages).toHaveLength(1);
  });
});
