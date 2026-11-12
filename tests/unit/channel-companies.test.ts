// Owner decision 131: spec 062's channel design in Code's core, for a host that serves many companies. Two companies share one chat adapter, each with its own
// tenant; every channel path (bindings, conversations, links, routing of what is heard, cards and decisions, commands and the directory) keeps them apart, and a
// host's explicit-member rule decides whether a linked person is served. The adapters are fakes and no chat tool is named.
import { describe, expect, it } from "vitest";
import { ChannelCommandFailed, type ActorRef, type ChannelCommand, type ChannelDecision, type ConversationRef, type InboundMessage, type OrgId } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { FAKE_CHANNEL_CAPABILITIES, FakeChannelAdapter } from "../../packages/broker/src/ports/fake-channel-adapter.js";
import {
  bindChannelSpace, createChannelSink, directoryUser, directoryUserByEmail, issueChannelLinkCode, linkedPerson, listAllChannelBindings, postApprovalCard, readApprovalCard, readChannelBinding, readTaskThread,
  recordTaskThread, redeemChannelLinkCode, sendChannelCommand, unbindChannelSpace, previewChannelLinkCode, type ChannelMemberRule, type ChannelWork,
} from "../../packages/broker/src/core/channel/index.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const clock = { ms: Date.parse("2026-11-12T10:00:00.000Z") };
const now = (): number => clock.ms;
const PERSON_A = "a".repeat(64);
const PERSON_B = "b".repeat(64);
const DIGEST = "c".repeat(64);
// Each company has its own tenant; the same space and account ids appear in both, so only the company keeps them apart.
const TENANT = { [A]: "teamA", [B]: "teamB" } as Record<OrgId, string>;
const companyOf = ({ tenant }: { channel: string; tenant: string }): OrgId | undefined => (tenant === "teamA" ? A : tenant === "teamB" ? B : undefined);
const actorOf = (org: OrgId): ActorRef => ({ channel: "examplechat", tenant: TENANT[org]!, userId: "user1" });
const conversationOf = (org: OrgId): ConversationRef => ({ channel: "examplechat", tenant: TENANT[org]!, space: "room1", thread: "main" });
const message = (org: OrgId, id: string): InboundMessage => ({ version: 2, channel: "examplechat", eventId: id, conversation: conversationOf(org), actor: actorOf(org), text: "add a retry", receivedAt: "2026-11-12T10:00:00.000Z" });

function world(options: { isMember?: ChannelMemberRule } = {}) {
  const store = new MemoryDocumentStore();
  const adapter = new FakeChannelAdapter();
  Object.assign(adapter, { projects: ["web-a", "web-b"] });
  const ran: Array<{ orgId: OrgId; projectName: string; personId: string }> = [];
  const decided: Array<{ orgId: OrgId; requestId: string }> = [];
  const work: ChannelWork = {
    async message(item) { ran.push({ orgId: item.orgId, projectName: item.projectName, personId: item.personId }); },
    async decide(item) { decided.push({ orgId: item.orgId, requestId: item.card.requestId }); return { status: "decided" }; },
  };
  const logs: Array<Record<string, unknown>> = [];
  // The sink's own `orgId` is a third company: with `companyOf`, nothing may fall back to it.
  const sink = createChannelSink({
    channel: "examplechat", adapter, store, orgId: "org_zzzzzzzzzzzzzzzzzzzz" as OrgId, companyOf, now, work, linkWords: (code) => `Link with ${code}.`, log: (entry) => logs.push(entry),
    ...(options.isMember === undefined ? {} : { isMember: options.isMember }),
  });
  const deps = (orgId: OrgId) => ({ store, orgId, now });
  return { store, adapter, sink, ran, decided, logs, deps };
}

async function linkIn(w: ReturnType<typeof world>, org: OrgId, person: string): Promise<void> {
  const { code } = await issueChannelLinkCode(w.deps(org), actorOf(org));
  await redeemChannelLinkCode(w.deps(org), person, code);
}

/** Both companies bound the same space id in their own tenant to their own project, and linked their own person under the same account id. */
async function twoCompanies(options: { isMember?: ChannelMemberRule } = {}) {
  const w = world(options);
  await bindChannelSpace(w.deps(A), { channel: "examplechat", tenant: "teamA", space: "room1" }, "web-a");
  await bindChannelSpace(w.deps(B), { channel: "examplechat", tenant: "teamB", space: "room1" }, "web-b");
  await linkIn(w, A, PERSON_A);
  await linkIn(w, B, PERSON_B);
  return w;
}

describe("companies stay apart: bindings", () => {
  it("one company's binding is not read, listed or removed by another, even for the same tenant and space", async () => {
    const w = world();
    const ref = { channel: "examplechat", tenant: "teamA", space: "room1" };
    await bindChannelSpace(w.deps(A), ref, "web-a");
    expect(await readChannelBinding(w.deps(B), ref)).toBeUndefined();
    expect(await listAllChannelBindings(w.deps(B))).toEqual([]);
    expect(await unbindChannelSpace(w.deps(B), ref)).toBe(false);
    expect(await readChannelBinding(w.deps(A), ref)).toMatchObject({ projectName: "web-a" });
    // B binding the same ref writes its own row and leaves A's alone.
    await bindChannelSpace(w.deps(B), ref, "web-b");
    expect(await readChannelBinding(w.deps(A), ref)).toMatchObject({ projectName: "web-a" });
    expect(await listAllChannelBindings(w.deps(A))).toEqual([expect.objectContaining({ projectName: "web-a" })]);
  });
});

describe("companies stay apart: conversations and links", () => {
  it("the conversation a session started from is read only by its own company, and another company cannot write over it", async () => {
    const w = world();
    await recordTaskThread(w.deps(A), { sessionId: "s1", conversation: conversationOf(A), personId: PERSON_A });
    expect(await readTaskThread(w.store, B, "s1")).toBeUndefined();
    await recordTaskThread(w.deps(B), { sessionId: "s1", conversation: conversationOf(B), personId: PERSON_B });
    expect(await readTaskThread(w.store, A, "s1")).toEqual({ conversation: conversationOf(A), personId: PERSON_A });
    expect(await readTaskThread(w.store, B, "s1")).toEqual({ conversation: conversationOf(B), personId: PERSON_B });
  });

  it("a link and a link code of one company are nothing in another", async () => {
    const w = world();
    const { code } = await issueChannelLinkCode(w.deps(A), actorOf(A));
    expect(await previewChannelLinkCode(w.deps(B), code)).toBeUndefined();
    await expect(redeemChannelLinkCode(w.deps(B), PERSON_B, code)).rejects.toThrow();
    await redeemChannelLinkCode(w.deps(A), PERSON_A, code);
    expect(await linkedPerson(w.deps(A), actorOf(A))).toBe(PERSON_A);
    expect(await linkedPerson(w.deps(B), actorOf(A))).toBeUndefined();
  });
});

describe("companies stay apart: routing what an adapter hears", () => {
  it("runs each tenant's message under its own company, its own binding and its own linked person, and a tenant nobody owns runs nothing", async () => {
    const w = await twoCompanies();
    await w.sink.message(message(A, "m1"));
    await w.sink.message(message(B, "m2"));
    expect(w.ran).toEqual([{ orgId: A, projectName: "web-a", personId: PERSON_A }, { orgId: B, projectName: "web-b", personId: PERSON_B }]);
    const stranger: InboundMessage = { ...message(A, "m3"), conversation: { ...conversationOf(A), tenant: "teamZ" }, actor: { ...actorOf(A), tenant: "teamZ" } };
    await w.sink.message(stranger);
    expect(w.ran).toHaveLength(2);
    expect(w.logs.at(-1)).toMatchObject({ reason: "company_unknown" });
  });

  it("does not run B's message on A's binding: with only A's binding, B's tenant gets nothing", async () => {
    const w = world();
    await bindChannelSpace(w.deps(A), { channel: "examplechat", tenant: "teamB", space: "room1" }, "web-a");
    await linkIn(w, A, PERSON_A);
    await linkIn(w, B, PERSON_B);
    await w.sink.message(message(B, "m1"));
    expect(w.ran).toEqual([]);
    expect(w.logs.at(-1)).toMatchObject({ reason: "space_not_bound" });
  });

  it("does not take A's link for B's account of the same id: the B account is told to link, in B, and nothing runs", async () => {
    const w = world();
    await bindChannelSpace(w.deps(B), { channel: "examplechat", tenant: "teamB", space: "room1" }, "web-b");
    // Linked in A under B's tenant and account id: B must not see it.
    const { code } = await issueChannelLinkCode(w.deps(A), actorOf(B));
    await redeemChannelLinkCode(w.deps(A), PERSON_A, code);
    await w.sink.message(message(B, "m1"));
    expect(w.ran).toEqual([]);
    expect(w.logs.some((entry) => entry["event"] === "channel.link_required")).toBe(true);
    expect((await w.store.query({ pk: `ORG#${B}#CHANNEL_CLAIM#examplechat/LINK_NOTICE#teamB/user1` })).items).toHaveLength(1);
    expect((await w.store.query({ pk: `ORG#${A}#CHANNEL_CLAIM#examplechat/LINK_NOTICE#teamB/user1` })).items).toHaveLength(0);
  });
});

describe("companies stay apart: cards and decisions", () => {
  const decisionFor = (org: OrgId, requestId: string): ChannelDecision => ({
    version: 1, channel: "examplechat", eventId: `d-${org}`, conversation: conversationOf(org), actor: actorOf(org), requestId, expectedRevision: 3, artifactDigest: DIGEST, decision: "APPROVE", reason: "pressed", receivedAt: "2026-11-12T10:00:00.000Z",
  });
  const cardIn = (w: ReturnType<typeof world>, org: OrgId, conversation: ConversationRef) => postApprovalCard({ ...w.deps(org), companyOf }, {
    channel: "examplechat", adapter: w.adapter, conversation, kind: "other", subject: { type: "workflow-document", id: "task-1" }, revision: 3, artifactDigest: DIGEST,
    text: "Plan waits.", taskUrl: "https://example.test/tasks/1", actions: [{ decision: "APPROVE", label: "Approve" }],
  });

  it("posts no card into another company's conversation and writes nothing for it", async () => {
    const w = await twoCompanies();
    const rows = w.store.size;
    await expect(cardIn(w, A, conversationOf(B))).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(w.adapter.delivered.filter((event) => event.type === "approval_request")).toEqual([]);
    expect(w.store.size).toBe(rows);
  });

  it("a card of A is not readable by B, and a decision for it from B's conversation decides nothing", async () => {
    const w = await twoCompanies();
    const { requestId } = await cardIn(w, A, conversationOf(A));
    expect(await readApprovalCard(w.deps(B), requestId)).toBeUndefined();
    await w.sink.decision(decisionFor(B, requestId));
    expect(w.decided).toEqual([]);
    await w.sink.decision(decisionFor(A, requestId));
    expect(w.decided).toEqual([{ orgId: A, requestId }]);
  });
});

describe("companies stay apart: commands and the directory", () => {
  function commanding() {
    const adapter = new FakeChannelAdapter({ ...FAKE_CHANNEL_CAPABILITIES, directory: true, proactive: true });
    const sent: ChannelCommand[] = [];
    const people: Record<string, { userId: string; tenant?: string; bot: boolean; deleted: boolean; email?: string }> = {
      "teamA/u1": { userId: "u1", tenant: "teamA", bot: false, deleted: false },
      // A guest of A's shared space whose own tenant is B's.
      "teamA/guest": { userId: "guest", tenant: "teamB", bot: false, deleted: false, external: true } as never,
      "teamA/plain": { userId: "plain", bot: false, deleted: false },
    };
    Object.assign(adapter, {
      async command(command: ChannelCommand) {
        sent.push(command);
        if (command.kind === "user") return { ok: true, result: { user: people[`${command.tenant}/${command.userId}`] } };
        if (command.kind === "user_by_email") return { ok: true, result: { user: people["teamA/guest"] } };
        if (command.kind === "post_message") return { ok: true, result: { space: command.space, messageId: "m1" } };
        if (command.kind === "check") return { ok: true, result: { tenant: "teamA" } };
        return { ok: false, error: { code: "unsupported", message: "no" } };
      },
    });
    const deps = (orgId: OrgId, many = true) => ({ channel: "examplechat", adapter, orgId, now, ...(many ? { companyOf } : {}) });
    return { adapter, sent, deps };
  }

  it("sends no command into another company's tenant, or a tenant nobody owns, and the adapter never hears it", async () => {
    const c = commanding();
    await expect(directoryUser(c.deps(A), "teamB", "u1")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(sendChannelCommand(c.deps(A), "post_message", { tenant: "teamZ", space: "room1", message: { text: "hi" } })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(c.sent).toEqual([]);
    expect(await sendChannelCommand(c.deps(A), "post_message", { tenant: "teamA", space: "room1", message: { text: "hi" } })).toEqual({ space: "room1", messageId: "m1" });
  });

  it("answers a directory person whose own tenant is another company's as unknown, and one of its own as found", async () => {
    const c = commanding();
    expect(await directoryUser(c.deps(A), "teamA", "u1")).toMatchObject({ userId: "u1" });
    expect(await directoryUser(c.deps(A), "teamA", "guest")).toBeUndefined();
    expect(await directoryUserByEmail(c.deps(A), "teamA", "guest@example.test")).toBeUndefined();
    // A person whose answer names no tenant is of the tenant asked about.
    expect(await directoryUser(c.deps(A), "teamA", "plain")).toMatchObject({ userId: "plain" });
  });

  it("sends a kind that names no tenant only in an install of one company", async () => {
    const c = commanding();
    await expect(sendChannelCommand(c.deps(A), "check", {})).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await sendChannelCommand(c.deps(A, false), "check", {})).toEqual({ tenant: "teamA" });
  });

  it("sends nothing an adapter did not declare, and reads a refusal or a broken answer as the webhook client does", async () => {
    const c = commanding();
    await expect(sendChannelCommand(c.deps(A), "create_document", { tenant: "teamA", space: "room1", title: "Plan", markdown: "x" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    const refusing = { ...c.deps(A), adapter: { capabilities: c.adapter.capabilities, command: async () => ({ ok: false, error: { code: "not_in_space", message: "no" } }) } };
    await expect(directoryUser(refusing, "teamA", "u1")).rejects.toBeInstanceOf(ChannelCommandFailed);
    const broken = { ...c.deps(A), adapter: { capabilities: c.adapter.capabilities, command: async () => ({ ok: true, result: { user: { userId: 7 } } }) } };
    await expect(directoryUser(broken, "teamA", "u1")).rejects.toMatchObject({ outcome: "unanswered" });
  });
});

describe("the host's explicit-member rule (owner decision 131)", () => {
  it("serves a linked person only when the host says they are a member, and is asked with the company, the person and the account", async () => {
    const asked: string[] = [];
    const w = await twoCompanies({ isMember: (orgId, personId, actor) => { asked.push(`${orgId}/${personId}/${actor.tenant}/${actor.userId}`); return orgId === A; } });
    await w.sink.message(message(A, "m1"));
    await w.sink.message(message(B, "m2"));
    expect(w.ran).toEqual([{ orgId: A, projectName: "web-a", personId: PERSON_A }]);
    expect(asked).toEqual([`${A}/${PERSON_A}/teamA/user1`, `${B}/${PERSON_B}/teamB/user1`]);
    expect(w.logs.at(-1)).toMatchObject({ event: "channel.refused", reason: "not_member", kind: "message" });
  });

  it("a host that refuses everyone: nothing runs, nothing is said, no event is claimed, and a decision is not passed on", async () => {
    const w = await twoCompanies({ isMember: () => false });
    const { requestId } = await postApprovalCard(w.deps(A), {
      channel: "examplechat", adapter: w.adapter, conversation: conversationOf(A), kind: "other", subject: { type: "workflow-document", id: "task-1" }, revision: 3, artifactDigest: DIGEST,
      text: "Plan waits.", taskUrl: "https://example.test/tasks/1", actions: [{ decision: "APPROVE", label: "Approve" }],
    });
    const before = w.adapter.delivered.length;
    await w.sink.message(message(A, "m1"));
    await w.sink.decision({ version: 1, channel: "examplechat", eventId: "d1", conversation: conversationOf(A), actor: actorOf(A), requestId, expectedRevision: 3, artifactDigest: DIGEST, decision: "APPROVE", reason: "pressed", receivedAt: "2026-11-12T10:00:00.000Z" });
    expect(w.ran).toEqual([]);
    expect(w.decided).toEqual([]);
    expect(w.adapter.delivered.length).toBe(before);
    expect((await w.store.query({ pk: `ORG#${A}#CHANNEL_CLAIM#examplechat/EVENT#message/m1` })).items).toHaveLength(0);
  });

  it("serves nobody when the rule fails", async () => {
    const w = await twoCompanies({ isMember: async () => { throw new Error("directory down"); } });
    await w.sink.message(message(A, "m1"));
    expect(w.ran).toEqual([]);
  });

  it("without a rule, every linked person is served (Code's one company)", async () => {
    const w = await twoCompanies();
    await w.sink.message(message(A, "m1"));
    expect(w.ran).toHaveLength(1);
  });
});
