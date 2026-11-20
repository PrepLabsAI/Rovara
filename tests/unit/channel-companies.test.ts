// Owner decision 131: spec 062's channel design in Code's core, for a host that serves many companies. Two companies share one chat adapter, each with its own
// tenant; every channel path (bindings, conversations, links, routing of what is heard, cards and decisions, commands and the directory) keeps them apart, and a
// host's explicit-member rule decides whether a linked person is served. The adapters are fakes and no chat tool is named.
import { describe, expect, it } from "vitest";
import { ChannelCommandFailed, type ActorRef, type ChannelCommand, type ChannelDecision, type ConversationRef, type InboundMessage, type OrgId } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { FAKE_CHANNEL_CAPABILITIES, FakeChannelAdapter } from "../../packages/broker/src/ports/fake-channel-adapter.js";
import {
  bindChannelSpace, createChannelSink, directoryUser, directoryUserByEmail, issueChannelLinkCode, listAllChannelBindings, postApprovalCard, readApprovalCard, readChannelBinding, redeemChannelLinkCode, sendChannelCommand, unbindChannelSpace, type ChannelMemberRule, type ChannelWork,
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
    channel: "examplechat", adapter, store, orgId: "org_zzzzzzzzzzzzzzzzzzzz", companyOf, now, work, linkWords: (code) => `Link with ${code}.`, log: (entry) => logs.push(entry),
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
});
