// The core around an in-process channel adapter: linking a chat account to a person, binding a space to a project, the cards Rovara posts, and the sink that checks everything an adapter hears before it runs anything.
// The adapters here are fakes and no chat tool is named.
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, change, LINK_CODE_TTL_SECONDS, linkCodeHash, orgChannelLinkCodeKey, orgChannelLinkKey, type ActorRef, type ChannelDecision, type ConversationRef, type InboundMessage, type OrgId } from "@agentx/contracts";
import { createLocalOwnerApprovers } from "../../packages/broker/src/ports/policy-defaults.js";
import { chatDecisionMethod } from "../../packages/broker/src/local/app/chat.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { FakeChannelAdapter } from "../../packages/broker/src/ports/fake-channel-adapter.js";
import {
  bindChannelSpace, cardKey, createChannelSink, issueChannelLinkCode, linkedPerson, listAllChannelBindings, listChannelLinks, postApprovalCard, previewChannelLinkCode, readApprovalCard, readChannelBinding,
  recordTaskThread, readTaskThread, redeemChannelLinkCode, removeChannelLink, unbindChannelSpace, type ChannelWork,
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
  it("makes a one-use code whose hash is all that is stored, under the company scope, and links on redeem", async () => {
    const { deps, store } = world();
    const { code, expiresAt } = await issueChannelLinkCode(deps, ACTOR);
    expect(expiresAt).toBe(Math.floor(clock.ms / 1000) + LINK_CODE_TTL_SECONDS);
    const stored = await store.get(orgChannelLinkCodeKey(ORG, linkCodeHash(code)));
    expect(stored?.pk.startsWith(`ORG#${ORG}#CHANNEL_LINK_CODE#`)).toBe(true);
    expect(JSON.stringify(stored)).not.toContain(code);
    expect(await previewChannelLinkCode(deps, code)).toEqual({ channel: "examplechat", tenant: "team1", userId: "user1", maskedUserId: "•••" });
    expect(await linkedPerson(deps, ACTOR)).toBeUndefined();
    await redeemChannelLinkCode(deps, OWNER, code);
    expect(await linkedPerson(deps, ACTOR)).toBe(OWNER);
    expect((await store.get(orgChannelLinkKey(ORG, ACTOR)))?.pk).toBe(`ORG#${ORG}#CHANNEL_LINK#examplechat/team1`);
    expect(await listChannelLinks(deps, OWNER)).toHaveLength(1);
    // Once: the same code finds nothing now.
    await expect(redeemChannelLinkCode(deps, OWNER, code)).rejects.toThrow(/expired or was already used/u);
    expect(await previewChannelLinkCode(deps, code)).toBeUndefined();
  });

  it("refuses an expired code even before the store has deleted it", async () => {
    const { deps } = world();
    const { code } = await issueChannelLinkCode(deps, ACTOR);
    clock.ms += (LINK_CODE_TTL_SECONDS + 1) * 1000;
    expect(await previewChannelLinkCode(deps, code)).toBeUndefined();
    await expect(redeemChannelLinkCode(deps, OWNER, code)).rejects.toThrow();
    clock.ms -= (LINK_CODE_TTL_SECONDS + 1) * 1000;
  });

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

describe("binding a space to a project", () => {
  it("binds under the company scope, lists across tenants, and unbinds", async () => {
    const { deps, store } = world();
    const ref = { channel: "examplechat", tenant: "team1", space: "room1" };
    expect(await readChannelBinding(deps, ref)).toBeUndefined();
    await bindChannelSpace(deps, ref, "web");
    await bindChannelSpace(deps, { ...ref, tenant: "team2", space: "room9" }, "api");
    expect((await readChannelBinding(deps, ref))?.projectName).toBe("web");
    expect((await listAllChannelBindings(deps)).map((binding) => `${binding.tenant}/${binding.space}/${binding.projectName}`).sort()).toEqual(["team1/room1/web", "team2/room9/api"]);
    expect([...(await store.query({ pk: `ORG#${ORG}#BINDING#examplechat/team1` })).items].length).toBe(1);
    expect(await unbindChannelSpace(deps, ref)).toBe(true);
    expect(await unbindChannelSpace(deps, ref)).toBe(false);
    expect(await readChannelBinding(deps, ref)).toBeUndefined();
  });
});

describe("the conversation a task was started from", () => {
  it("is written once and read back", async () => {
    const { deps } = world();
    await recordTaskThread(deps, { sessionId: "s1", conversation: CONVERSATION, personId: OWNER });
    await recordTaskThread(deps, { sessionId: "s1", conversation: { ...CONVERSATION, thread: "other" }, personId: OWNER }).catch(() => undefined);
    expect(await readTaskThread(deps.store, ORG, "s1")).toEqual({ conversation: CONVERSATION, personId: OWNER });
    expect(await readTaskThread(deps.store, ORG, "s2")).toBeUndefined();
  });
});

describe("the sink: a message", () => {
  it("runs a message from a linked person in a bound space once, and acknowledges it", async () => {
    const w = await ready();
    await w.sink.message(message("m1"));
    expect(w.calls.messages).toHaveLength(1);
    expect(w.calls.messages[0]).toMatchObject({ projectName: "web", personId: OWNER });
    expect(sent(w.adapter, "ack")).toHaveLength(1);
    // The same event again (an adapter's retry) runs nothing.
    await w.sink.message(message("m1"));
    expect(w.calls.messages).toHaveLength(1);
    await w.sink.message(message("m2"));
    expect(w.calls.messages).toHaveLength(2);
  });

  it("runs nothing from a space that is not bound, or bound to a project the adapter does not serve, even from a linked person", async () => {
    const w = world();
    await w.sink.message(message("m1"));
    expect(w.calls.messages).toEqual([]);
    expect(sent(w.adapter, "progress")).toEqual([]);
    await redeemChannelLinkCode(w.deps, OWNER, (await issueChannelLinkCode(w.deps, ACTOR)).code);
    await bindChannelSpace(w.deps, { channel: "examplechat", tenant: "team1", space: "room1" }, "other-project");
    await w.sink.message(message("m2"));
    expect(w.calls.messages).toEqual([]);
    await bindChannelSpace(w.deps, { channel: "examplechat", tenant: "team1", space: "room1" }, "web");
    await w.sink.message(message("m3"));
    expect(w.calls.messages).toHaveLength(1);
  });

  it("tells an unlinked person how to link, once an hour, and runs nothing", async () => {
    const w = world();
    await bindChannelSpace(w.deps, { channel: "examplechat", tenant: "team1", space: "room1" }, "web");
    await w.sink.message(message("m1"));
    await w.sink.message(message("m2"));
    expect(w.calls.messages).toEqual([]);
    const notices = sent(w.adapter, "progress");
    expect(notices).toHaveLength(1);
    // The code goes to that person alone: the event names the account that may see it.
    expect((notices[0] as { data: { onlyTo?: string } }).data.onlyTo).toBe(ACTOR.userId);
    const text = (notices[0] as { data: { text: string } }).data.text;
    expect(text).toMatch(/Link with [A-Za-z0-9_-]{32}\./u);
    // The code in the notice is a real, unused code for that account.
    const code = /Link with ([A-Za-z0-9_-]{32})\./u.exec(text)![1]!;
    expect(await previewChannelLinkCode(w.deps, code)).toMatchObject({ channel: "examplechat" });
    clock.ms += 3_601_000;
    await w.sink.message(message("m3"));
    expect(sent(w.adapter, "progress")).toHaveLength(2);
    clock.ms -= 3_601_000;
  });

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
  const decisionFor = (requestId: string, overrides: Partial<ChannelDecision> = {}): ChannelDecision => ({
    version: 1, channel: "examplechat", eventId: "d1", conversation: CONVERSATION, actor: ACTOR, requestId, expectedRevision: 3, artifactDigest: DIGEST, decision: "APPROVE", reason: "pressed", receivedAt: "2026-11-10T10:00:00.000Z", ...overrides,
  });
  const card = (w: Awaited<ReturnType<typeof ready>>, kind: "plan_approval" | "admin" | "other") => postApprovalCard(
    w.deps, {
      channel: "examplechat", adapter: w.adapter, conversation: CONVERSATION, kind, subject: { type: "workflow-document", id: "task-1" }, revision: 3, artifactDigest: DIGEST,
      text: "Plan for task 1 waits for you.", taskUrl: "https://example.test/tasks/1", actions: [{ decision: "APPROVE", label: "Approve" }, { decision: "REJECT", label: "Reject" }],
    },
  );

  it("sends a card for a kind that asks for a sign-in with no buttons, and a card for another kind with its buttons", async () => {
    const w = await ready();
    const stepped = await card(w, "plan_approval");
    const open = await card(w, "other");
    const [first, second] = sent(w.adapter, "approval_request") as Array<{ data: { actions?: unknown[]; text: string; requestId: string } }>;
    expect(first!.data.actions).toBeUndefined();
    expect(first!.data.text).toContain("Approve on the task page");
    expect(second!.data.actions).toHaveLength(2);
    expect(first!.data.requestId).toBe(stepped.requestId);
    expect(await readApprovalCard(w.deps, open.requestId)).toMatchObject({ kind: "other", offered: ["APPROVE", "REJECT"], revision: 3 });
    expect((await readApprovalCard(w.deps, stepped.requestId))?.offered).toEqual([]);
  });

  it("writes the card first and removes it when the send fails", async () => {
    const w = await ready();
    const seen: { requestId?: string; existedWhenSent?: boolean } = {};
    w.adapter.deliver = async (event) => {
      if (event.type !== "approval_request") return;
      seen.requestId = event.data.requestId;
      seen.existedWhenSent = (await readApprovalCard(w.deps, event.data.requestId)) !== undefined;
      throw new Error("down");
    };
    await expect(card(w, "other")).rejects.toThrow("down");
    expect(seen.existedWhenSent).toBe(true);
    expect(await readApprovalCard(w.deps, seen.requestId!)).toBeUndefined();
  });

  it("gives a card up after a day", async () => {
    const w = await ready();
    const { requestId } = await card(w, "other");
    clock.ms += 25 * 3_600_000;
    expect(await readApprovalCard(w.deps, requestId)).toBeUndefined();
    clock.ms -= 25 * 3_600_000;
  });

  it("passes a decision for an open card of an allowed kind to the work seam, once", async () => {
    const w = await ready();
    const { requestId } = await card(w, "other");
    await w.sink.decision(decisionFor(requestId));
    expect(w.calls.decisions.map((entry) => `${entry.decision.decision}/${entry.personId}/${entry.requestId}`)).toEqual([`APPROVE/${OWNER}/${requestId}`]);
    expect(sent(w.adapter, "progress").at(-1)).toMatchObject({ data: { text: "Recorded." } });
    // The same chat event again is dropped, not decided twice.
    await w.sink.decision(decisionFor(requestId));
    expect(w.calls.decisions).toHaveLength(1);
  });

  it("never passes a decision for a kind that asks for a sign-in, however the message is made", async () => {
    const w = await ready();
    const { requestId } = await card(w, "plan_approval");
    await w.sink.decision(decisionFor(requestId));
    expect(w.calls.decisions).toEqual([]);
    expect((sent(w.adapter, "error").at(-1) as { data: { text: string } }).data.text).toContain("task page");
  });

  it("refuses a decision for a kind that asks for a sign-in even when a card record offers buttons for it", async () => {
    const w = await ready();
    const { requestId } = await card(w, "plan_approval");
    // A record that offers an answer for a stepped-up kind (written by another version, or by hand) still sends nothing to the gate.
    const key = cardKey(ORG, requestId);
    await w.store.update({ key, ops: [change.set("offered", ["APPROVE"])] });
    await w.sink.decision(decisionFor(requestId));
    expect(w.calls.decisions).toEqual([]);
    expect((sent(w.adapter, "error").at(-1) as { data: { text: string } }).data.text).toContain("task page");
  });

  it("refuses a decision the card did not offer, a stale revision or digest, another conversation and an unknown request", async () => {
    const w = await ready();
    const { requestId } = await card(w, "other");
    await w.sink.decision(decisionFor(requestId, { eventId: "d2", decision: "SKIP" }));
    await w.sink.decision(decisionFor(requestId, { eventId: "d3", expectedRevision: 4 }));
    await w.sink.decision(decisionFor(requestId, { eventId: "d4", artifactDigest: "c".repeat(64) }));
    await w.sink.decision(decisionFor(requestId, { eventId: "d5", conversation: { ...CONVERSATION, thread: "elsewhere" } }));
    await w.sink.decision(decisionFor("3f2504e0-4f89-41d3-9a0c-0305e82c3301", { eventId: "d6" }));
    expect(w.calls.decisions).toEqual([]);
    expect(sent(w.adapter, "error")).toHaveLength(5);
  });

  it("answers in fixed words when the gate refuses, and never quotes what the gate said", async () => {
    const w = await ready();
    const { requestId } = await card(w, "other");
    w.behaviour.decide = { status: "refused", reason: "method_not_allowed" };
    await w.sink.decision(decisionFor(requestId));
    const text = (sent(w.adapter, "error").at(-1) as { data: { text: string } }).data.text;
    expect(text).toBe("A reply here is not enough to decide this. Open the task page and decide there.");
  });

  it("does not hear a decision from a person who is not linked", async () => {
    const w = await ready();
    const { requestId } = await card(w, "other");
    await w.sink.decision(decisionFor(requestId, { eventId: "d9", actor: { ...ACTOR, userId: "stranger" } }));
    expect(w.calls.decisions).toEqual([]);
  });
});

describe("a chat press is never an approval on Code's own rules", () => {
  it("is not a method Code's approvers offer, and a proof of that method is refused whatever it carries", async () => {
    const approvers = createLocalOwnerApprovers({ verifySession: () => true });
    const request = { companyId: ORG, requestId: "req-12345678", kind: "plan", subject: { type: "workflow-document", id: "task-1" }, revision: 3, artifactDigest: DIGEST, risk: "low" as const };
    const method = chatDecisionMethod("examplechat");
    expect(method).toBe("chat-examplechat");
    const requirement = await approvers.requirement(request);
    expect(requirement.methods).not.toContain(method);
    expect(requirement.strongMethods).not.toContain(method);
    expect(requirement.rejectMethods).not.toContain(method);
    const verdict = await approvers.verify(request, { proofId: "p1", method, requestId: request.requestId, revision: 3, artifactDigest: DIGEST, token: "evt-1" });
    expect(verdict.approved).toBe(false);
  });
});

describe("what a busy bound channel can make the sink write", () => {
  const claimPk = (name: string) => `ORG#${ORG}#CHANNEL_CLAIM#examplechat/${name}`;

  it("gives an account of another workspace nothing: no notice, no code, no row", async () => {
    const w = world();
    await bindChannelSpace(w.deps, { channel: "examplechat", tenant: "team1", space: "room1" }, "web");
    await w.sink.message(message("g1", { actor: { ...ACTOR, tenant: "teamOther", userId: "guest1" } }));
    expect(w.adapter.delivered).toEqual([]);
    expect((await w.store.get({ pk: claimPk("LINK_NOTICE#teamOther/guest1"), sk: "CLAIM" }))).toBeUndefined();
  });

  it("writes no event claim for an account that is not linked, however often it mentions the bot", async () => {
    const w = world();
    await bindChannelSpace(w.deps, { channel: "examplechat", tenant: "team1", space: "room1" }, "web");
    for (let n = 0; n < 30; n += 1) await w.sink.message(message(`flood${String(n)}`));
    for (let n = 0; n < 30; n += 1) expect(await w.store.get({ pk: claimPk(`EVENT#message/flood${String(n)}`), sk: "CLAIM" })).toBeUndefined();
    expect(sent(w.adapter, "progress")).toHaveLength(1);
  });
});

describe("the sink for another adapter's items", () => {
  it("runs nothing for an item labelled with another channel, even when that channel has a binding and a link", async () => {
    const w = await ready();
    const slackSpace = { channel: "slack", tenant: "T0AAAAAAA", space: "C0ROOM001" };
    await bindChannelSpace(w.deps, slackSpace, "web");
    const slackActor: ActorRef = { channel: "slack", tenant: "T0AAAAAAA", userId: "U0PERSON1" };
    await redeemChannelLinkCode(w.deps, OWNER, (await issueChannelLinkCode(w.deps, slackActor)).code);
    const item: InboundMessage = { version: 2, channel: "slack", eventId: "Ev1", conversation: { channel: "slack", tenant: "T0AAAAAAA", space: "C0ROOM001", thread: "1700000000.000100" }, actor: slackActor, text: "do it", receivedAt: "2026-11-10T10:00:00.000Z" };
    await w.sink.message(item);
    expect(w.calls.messages).toEqual([]);
    expect(w.adapter.delivered).toEqual([]);
    // The sink of the adapter that owns the label hears it.
    expect(w.logs).toContainEqual({ event: "channel.refused", reason: "channel_mismatch" });
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
