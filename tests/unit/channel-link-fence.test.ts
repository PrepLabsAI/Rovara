// A linked chat account acts as the person it is linked to (owner decision 58; the earlier hosted line's "a linked account acts as its web account"), read live on every item. This file pins
// the part that closes the unlink race: whatever is written for the linked person carries, in the SAME transaction, a check that the link row still names that person. An unlink (or a
// re-link to someone else) that commits between the sink's read of the link and the write wins: the start commits nothing and the decision is refused with fixed words.
/* eslint-disable @typescript-eslint/no-unsafe-assignment -- vitest's expect.* matchers are typed any */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  IMPLICIT_COMPANY_ID, createWorkflowSnapshot, orgChannelLinkKey, submitWorkflowArtifact,
  type ActorRef, type ChannelDecision, type ConversationRef, type DocumentStore, type InboundMessage, type OrgId, type TransactItem, type WorkflowSnapshot,
} from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { FakeChannelAdapter } from "../../packages/broker/src/ports/fake-channel-adapter.js";
import { LOCAL_SESSION_METHOD, createLocalOwnerApprovers, createNoopAuditSink, localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import {
  DECISION_REFUSAL_WORDS, bindChannelSpace, channelLinkFence, createChannelSink, issueChannelLinkCode, postApprovalCard, redeemChannelLinkCode, removeChannelLink, type ChannelWork,
} from "../../packages/broker/src/core/channel/index.js";
import { approvalRecordKey, createDecisionGate, type DecisionAttempt } from "../../packages/broker/src/core/decisions/approval-gate.js";
import { createWorkflowDocumentSubject, waitingDocumentDigest, workflowTaskKey } from "../../packages/broker/src/core/decisions/workflow-subject.js";
import { withStartFence, withStartFenceExtras } from "../../packages/broker/src/core/task-flow/start-fence.js";
import { withStartFence as runtimeWithStartFence } from "../../packages/broker/src/core-host/core-runtime.js";
import { createLocalChat } from "../../packages/broker/src/local/app/chat.js";
import { createSessionStartExtras } from "../../packages/broker/src/local/app/session-start.js";
import { developerIdOf } from "../../packages/broker/src/core/sessions/create.js";
import { createHarness } from "../support/task-flow-harness.js";
import { commentReads, freshComment } from "../support/comment-fakes.js";

const ORG = IMPLICIT_COMPANY_ID as OrgId;
const clock = { ms: Date.parse("2026-11-10T10:00:00.000Z") };
const now = (): number => clock.ms;
const PERSON_A = "a".repeat(64);
const PERSON_B = "b".repeat(64);
const ACTOR: ActorRef = { channel: "examplechat", tenant: "team1", userId: "U0SECRETUSER" };
const CONVERSATION: ConversationRef = { channel: "examplechat", tenant: "team1", space: "room1", thread: "main" };

async function link(store: DocumentStore, personId: string, actor: ActorRef = ACTOR, orgId: OrgId = ORG): Promise<void> {
  const deps = { store, orgId, now };
  const { code } = await issueChannelLinkCode(deps, actor);
  await redeemChannelLinkCode(deps, personId, code);
}
const holds = async (store: MemoryDocumentStore, fence: readonly TransactItem[]): Promise<boolean> => (await store.transact([...fence])).applied;

describe("the link fence", () => {
  it("holds while the account is linked to that person, and fails once the link is removed", async () => {
    const store = new MemoryDocumentStore();
    await link(store, PERSON_A);
    const fence = [channelLinkFence(ORG, ACTOR, PERSON_A)];
    expect(fence[0]).toMatchObject({ kind: "check", key: orgChannelLinkKey(ORG, ACTOR) });
    expect(await holds(store, fence)).toBe(true);
    await removeChannelLink({ store, orgId: ORG, now }, ACTOR, PERSON_A);
    expect(await holds(store, fence)).toBe(false);
  });

  it("a re-link to another person: a fence built for the first person fails, one for the second holds", async () => {
    const store = new MemoryDocumentStore();
    await link(store, PERSON_A);
    const forA = [channelLinkFence(ORG, ACTOR, PERSON_A)];
    await removeChannelLink({ store, orgId: ORG, now }, ACTOR, PERSON_A);
    await link(store, PERSON_B);
    expect(await holds(store, forA)).toBe(false);
    expect(await holds(store, [channelLinkFence(ORG, ACTOR, PERSON_B)])).toBe(true);
  });

  it("is the company's own: a link in another company does not satisfy it", async () => {
    const store = new MemoryDocumentStore();
    const OTHER = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
    await link(store, PERSON_A, ACTOR, OTHER);
    expect(await holds(store, [channelLinkFence(ORG, ACTOR, PERSON_A)])).toBe(false);
    expect(await holds(store, [channelLinkFence(OTHER, ACTOR, PERSON_A)])).toBe(true);
  });
});

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
  it("a message from a linked account carries the link fence for exactly that person", async () => {
    const w = sinkWorld();
    await bindChannelSpace({ store: w.store, orgId: ORG, now }, { channel: "examplechat", tenant: "team1", space: "room1" }, "web");
    await link(w.store, PERSON_A);
    await w.sink.message(message("m1"));
    expect(w.seen.messages).toHaveLength(1);
    expect(w.seen.messages[0]!.fence).toEqual([channelLinkFence(ORG, ACTOR, PERSON_A)]);
  });

  it("a decision from a linked account carries the link fence", async () => {
    const w = sinkWorld();
    const deps = { store: w.store, orgId: ORG, now };
    await bindChannelSpace(deps, { channel: "examplechat", tenant: "team1", space: "room1" }, "web");
    await link(w.store, PERSON_A);
    const posted = await postApprovalCard(deps, { channel: "examplechat", adapter: w.adapter, conversation: CONVERSATION, kind: "other", subject: { type: "workflow-document", id: "task-1" }, revision: 2, artifactDigest: "d".repeat(64), text: "Approve?", actions: [{ decision: "APPROVE", label: "Approve" }] });
    const decision: ChannelDecision = {
      version: 1, channel: "examplechat", eventId: "d1", conversation: CONVERSATION, actor: ACTOR, requestId: posted.requestId, expectedRevision: 2, artifactDigest: "d".repeat(64), decision: "APPROVE", reason: "ok",
      receivedAt: "2026-11-10T10:00:00.000Z",
    };
    await w.sink.decision(decision);
    expect(w.seen.decisions).toHaveLength(1);
    expect(w.seen.decisions[0]!.fence).toEqual([channelLinkFence(ORG, ACTOR, PERSON_A)]);
  });

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

  it("an account that is not linked (never, or no longer) names nobody and hands nothing to the work seam (unchanged)", async () => {
    const w = sinkWorld();
    await bindChannelSpace({ store: w.store, orgId: ORG, now }, { channel: "examplechat", tenant: "team1", space: "room1" }, "web");
    await w.sink.message(message("u1"));
    await link(w.store, PERSON_A);
    await removeChannelLink({ store: w.store, orgId: ORG, now }, ACTOR, PERSON_A);
    await w.sink.message(message("u2"));
    expect(w.seen.messages).toEqual([]);
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

  it("with the link still in place the start commits", async () => {
    const { h, chat, ownerId, actor, msg } = await harnessed();
    await chat.work("examplechat").message({ orgId: h.deps.companyId, projectName: "payments", personId: ownerId, message: msg("e1"), fence: [channelLinkFence(h.deps.companyId, actor, ownerId)] });
    expect((await h.flow.list(h.owner)).tasks).toHaveLength(1);
  });

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

describe("a decision for the linked person loses to an unlink that committed first", () => {
  const TASK_ID = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
  const OWNER = localOwnerPrincipal();
  const SESSION = ["local", "session", "secret", "for", "tests"].join("-");
  const NOW = new Date("2026-11-09T12:00:00.000Z");
  const waiting = (): WorkflowSnapshot => {
    const initial = createWorkflowSnapshot({ taskId: TASK_ID, ownerId: PERSON_A, now: "2026-11-09T09:59:00.000Z" });
    return submitWorkflowArtifact(initial, { expectedRevision: initial.revision, artifact: { id: "plan-v1", type: "plan", version: 1, sha256: "b".repeat(64), producer: "agentx-planner", objectKey: `tasks/${TASK_ID}/plan-v1.json`, createdAt: "2026-11-09T10:00:00.000Z", format: "structured" }, now: "2026-11-09T10:00:00.000Z" });
  };
  const gateWorld = async () => {
    const store = new MemoryDocumentStore();
    await store.put({ item: { ...workflowTaskKey(TASK_ID), entityType: "DEVELOPER_TASK", orgId: ORG, project: "web", workflow: JSON.parse(JSON.stringify(waiting())) } });
    const approvers = createLocalOwnerApprovers({ owner: OWNER, now: () => NOW, verifySession: (token) => token === SESSION, ...commentReads(freshComment({ provider: "any-code-host", tenant: "", accountId: "collab" }), { id: "comment-1" }) });
    const gate = createDecisionGate({ store, approvers, audit: createNoopAuditSink(), subjects: [createWorkflowDocumentSubject({ store, riskOf: () => "low" })], now: () => NOW });
    await link(store, PERSON_A);
    return { store, gate };
  };
  const attempt = (fence?: readonly TransactItem[]): DecisionAttempt => ({
    companyId: ORG, kind: "workflow-document", subjectId: TASK_ID, requestId: randomUUID(), outcome: "approve",
    seen: { revision: waiting().revision, artifactDigest: waitingDocumentDigest(waiting())! }, credentials: [{ method: LOCAL_SESSION_METHOD, token: SESSION }],
    ...(fence === undefined ? {} : { fence }),
  });

  it("with the link still in place the decision commits", async () => {
    const { gate } = await gateWorld();
    expect(await gate.decide(attempt([channelLinkFence(ORG, ACTOR, PERSON_A)]))).toMatchObject({ status: "decided" });
  });

  it("the link removed between the read and the commit: refused link_gone, and nothing is recorded or moved", async () => {
    const { store, gate } = await gateWorld();
    const fence = [channelLinkFence(ORG, ACTOR, PERSON_A)];
    await removeChannelLink({ store, orgId: ORG, now }, ACTOR, PERSON_A);
    const request = attempt(fence);
    expect(await gate.decide(request)).toMatchObject({ status: "refused", reason: "link_gone" });
    expect(await store.get(approvalRecordKey(ORG, request.requestId))).toBeUndefined();
    expect(((await store.get(workflowTaskKey(TASK_ID)))!["workflow"] as unknown as WorkflowSnapshot).revision).toBe(waiting().revision);
  });

  it("re-linked to another person between the read and the commit: refused link_gone", async () => {
    const { store, gate } = await gateWorld();
    const fence = [channelLinkFence(ORG, ACTOR, PERSON_A)];
    await removeChannelLink({ store, orgId: ORG, now }, ACTOR, PERSON_A);
    await link(store, PERSON_B);
    expect(await gate.decide(attempt(fence))).toMatchObject({ status: "refused", reason: "link_gone" });
  });

  it("the laptop's chat seam passes the sink's fence to the gate", async () => {
    const attempts: DecisionAttempt[] = [];
    const owner = localOwnerPrincipal();
    const chat = createLocalChat({ registry: { get: () => undefined, names: () => [] }, store: new MemoryDocumentStore(), companyId: ORG, owner, now, flow: {} as never, gate: { decide: async (a: DecisionAttempt) => { attempts.push(a); return { status: "refused" as const, reason: "invalid" as const, detail: "x" }; } } });
    const fence = [channelLinkFence(ORG, ACTOR, developerIdOf(owner))];
    const card = { requestId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301", channel: "examplechat", kind: "other", subject: { type: "workflow-document", id: "task-1" }, revision: 3, artifactDigest: "d".repeat(64), conversation: CONVERSATION, offered: ["APPROVE"], sentAt: "2026-11-10T10:00:00.000Z", expiresAt: 4_000_000_000 } as const;
    const decision: ChannelDecision = { version: 1, channel: "examplechat", eventId: "d1", conversation: CONVERSATION, actor: ACTOR, requestId: card.requestId, expectedRevision: 3, artifactDigest: card.artifactDigest, decision: "APPROVE", reason: "pressed", receivedAt: "2026-11-10T10:00:00.000Z" };
    await chat.work("examplechat").decide({ orgId: ORG, card: card as never, decision, personId: developerIdOf(owner), projectName: "web", fence });
    expect(attempts[0]!.fence).toEqual(fence);
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
