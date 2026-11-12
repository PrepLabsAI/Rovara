// What a task tells the chat thread it was started from: the plan's approval card (by risk) and three milestone lines. The decision gate, the approvers, the chat work seam and the sink are the real ones over the memory
// store; the chat adapter is a fake and no chat tool is named. A decision pressed in the chat goes through the same gate as the web app's.
import { describe, expect, it } from "vitest";
import {
  IMPLICIT_COMPANY_ID, change, createWorkflowSnapshot, submitWorkflowArtifact, type ActorRef, type ChannelDecision, type ChannelEvent, type CodeMilestone, type ConversationRef, type DecisionRisk, type JsonValue, type OrgId, type WorkflowSnapshot,
} from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { FakeChannelAdapter } from "../../packages/broker/src/ports/fake-channel-adapter.js";
import { createLocalOwnerApprovers, createNoopAuditSink, localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { createDecisionGate } from "../../packages/broker/src/core/decisions/approval-gate.js";
import { createWorkflowDocumentSubject, workflowTaskKey } from "../../packages/broker/src/core/decisions/workflow-subject.js";
import {
  bindChannelSpace, channelThreadHandler, createChannelSink, decisionRefusalWords, issueChannelLinkCode, linkedPerson, readApprovalCard, recordTaskThread, redeemChannelLinkCode, threadFollows, cardKey,
  type ChannelCompanyOf, type ChannelMemberRule,
} from "../../packages/broker/src/core/channel/index.js";
import { createDocumentMilestones } from "../../packages/broker/src/core/milestones/milestones.js";
import { ticketMomentsOnChange } from "../../packages/broker/src/core/ticket-updates/moments.js";
import { developerIdOf, taskSessionId } from "../../packages/broker/src/core/sessions/create.js";
import { createLocalChat } from "../../packages/broker/src/local/app/chat.js";

const ORG = IMPLICIT_COMPANY_ID as OrgId;
const OTHER = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const TASK = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const SESSION = taskSessionId(TASK);
const DIGEST = "b".repeat(64);
const DIGEST_2 = "c".repeat(64);
const clock = { ms: Date.parse("2026-11-12T10:00:00.000Z") };
const now = (): number => clock.ms;
const owner = localOwnerPrincipal();
const OWNER_ID = developerIdOf(owner);
const STRANGER_ID = "d".repeat(64);
const ACTOR: ActorRef = { channel: "examplechat", tenant: "team1", userId: "user1" };
const STRANGER_ACTOR: ActorRef = { channel: "examplechat", tenant: "team1", userId: "user2" };
const CONVERSATION: ConversationRef = { channel: "examplechat", tenant: "team1", space: "room1", thread: "main" };
const PAGE = "https://example.test/tasks/1";

function waitingWorkflow(): WorkflowSnapshot {
  const initial = createWorkflowSnapshot({ taskId: TASK, ownerId: OWNER_ID, now: "2026-11-12T09:59:00.000Z" });
  return submitWorkflowArtifact(initial, {
    expectedRevision: initial.revision, now: "2026-11-12T10:00:00.000Z",
    artifact: { id: "plan-v1", type: "plan", version: 1, sha256: DIGEST, producer: "agentx-planner", objectKey: `tasks/${TASK}/plan-v1.json`, createdAt: "2026-11-12T10:00:00.000Z", format: "markdown" },
  });
}

interface WorldOptions {
  risk?: DecisionRisk;
  /** The approvers take a decision made in the chat (default yes). */
  chatApprovers?: boolean;
  companyOf?: ChannelCompanyOf;
  isMember?: ChannelMemberRule;
  milestones?: boolean;
  withGate?: boolean;
  taskUrl?: boolean;
  /** The task's company on its record (default the install's). */
  taskOrg?: OrgId;
}

async function world(options: WorldOptions = {}) {
  const store = new MemoryDocumentStore();
  const adapter = new FakeChannelAdapter();
  const deliveries: ChannelEvent[] = [];
  const realDeliver = adapter.deliver.bind(adapter);
  adapter.deliver = async (event) => { deliveries.push(event); await realDeliver(event); };
  const risk = { value: options.risk ?? "low" };
  const workflow = waitingWorkflow();
  await store.put({ item: { ...workflowTaskKey(TASK), orgId: options.taskOrg ?? ORG, project: "web", title: "Add a retry", sessionId: SESSION, workflow: JSON.parse(JSON.stringify(workflow)) as JsonValue } });
  const approvers = createLocalOwnerApprovers({
    owner,
    ...(options.chatApprovers === false ? {} : {
      chat: {
        channels: () => ["examplechat"],
        linkedToOwner: async (account) => (await linkedPerson({ store, orgId: ORG, now }, { channel: account.provider, tenant: account.tenant, userId: account.accountId })) === OWNER_ID,
      },
    }),
  });
  const gate = createDecisionGate({ store, approvers, audit: createNoopAuditSink(), now: () => new Date(clock.ms), subjects: [createWorkflowDocumentSubject({ store, riskOf: () => risk.value })] });
  const registry = { get: (point: string, name: string) => (point === "channel" && name === "examplechat" ? adapter : undefined) } as never;
  const chat = createLocalChat({ registry: { get: () => undefined, names: () => [] }, store, companyId: ORG, owner, now, flow: {} as never, gate });
  const sink = createChannelSink({ channel: "examplechat", adapter, store, orgId: ORG, now, work: chat.work("examplechat"), linkWords: (code) => code, log: () => undefined });
  const deps = { store, orgId: ORG, now };
  await bindChannelSpace(deps, { channel: "examplechat", tenant: "team1", space: "room1" }, "web");
  await redeemChannelLinkCode(deps, OWNER_ID, (await issueChannelLinkCode(deps, ACTOR)).code);
  await redeemChannelLinkCode(deps, STRANGER_ID, (await issueChannelLinkCode(deps, STRANGER_ACTOR)).code);
  await recordTaskThread(deps, { sessionId: SESSION, conversation: CONVERSATION, personId: OWNER_ID, actor: ACTOR });
  const handler = channelThreadHandler({
    store, registry, now, ...(options.companyOf === undefined ? {} : { companyOf: options.companyOf }), ...(options.isMember === undefined ? {} : { isMember: options.isMember }),
    ...(options.milestones === undefined ? {} : { milestones: options.milestones }), ...(options.taskUrl === false ? {} : { taskUrl: () => PAGE }), footer: "Open it with `rovara open`.",
    ...(options.withGate === false ? {} : { plan: { gate } }),
  });
  return { store, adapter, deliveries, risk, gate, sink, handler, deps };
}

const milestone = (kind: CodeMilestone["kind"], extra: Partial<CodeMilestone> = {}, org: OrgId = ORG): CodeMilestone => ({ kind, orgId: org, taskId: TASK, at: "2026-11-12T10:00:00.000Z", text: "x", ...extra });
const ofType = (events: readonly ChannelEvent[], type: string) => events.filter((event) => event.type === type);
const decisionFor = (requestId: string, overrides: Partial<ChannelDecision> = {}): ChannelDecision => ({
  version: 1, channel: "examplechat", eventId: "press1", conversation: CONVERSATION, actor: ACTOR, requestId, expectedRevision: 2, artifactDigest: DIGEST, decision: "APPROVE", reason: "Pressed in chat.", receivedAt: "2026-11-12T10:00:00.000Z", ...overrides,
});
const workflowOf = async (w: Awaited<ReturnType<typeof world>>): Promise<WorkflowSnapshot> => (await w.store.get(workflowTaskKey(TASK)))!["workflow"] as unknown as WorkflowSnapshot;
const approvals = async (w: Awaited<ReturnType<typeof world>>) => (await workflowOf(w)).decisions.filter((entry) => entry.decision === "APPROVE").length;

/** Posts the plan card and answers the card event that went out. */
async function card(w: Awaited<ReturnType<typeof world>>) {
  await w.handler.on(milestone("plan_ready"));
  const event = ofType(w.deliveries, "approval_request").at(-1) as (ChannelEvent & { data: { requestId: string; text: string; actions?: Array<{ decision: string }>; taskUrl?: string; expectedRevision: number; artifactDigest: string } }) | undefined;
  return event;
}

describe("the plan card, by risk", () => {
  for (const risk of ["low", "medium"] as const) {
    it(`a ${risk} risk plan: the card shows the risk, has Approve and Request changes, and Approve in the thread approves through the gate`, async () => {
      const w = await world({ risk });
      const event = await card(w);
      expect(event?.data.text).toContain(`Risk: ${risk}`);
      expect(event?.data.actions?.map((action) => action.decision)).toEqual(["APPROVE", "REQUEST_CHANGES"]);
      expect(event?.data.expectedRevision).toBe((await workflowOf(w)).revision);
      expect(await approvals(w)).toBe(0);
      await w.sink.decision(decisionFor(event!.data.requestId, { expectedRevision: event!.data.expectedRevision }));
      expect(await approvals(w)).toBe(1);
      expect((await workflowOf(w)).decisions.at(-1)).toMatchObject({ decision: "APPROVE", requestId: event!.data.requestId });
      expect((ofType(w.deliveries, "progress").at(-1) as { data: { text: string } }).data.text).toBe("Recorded.");
    });
  }

  it("Request changes in the thread sends the plan back through the gate", async () => {
    const w = await world({ risk: "medium" });
    const event = (await card(w))!;
    await w.sink.decision(decisionFor(event.data.requestId, { expectedRevision: event.data.expectedRevision, decision: "REQUEST_CHANGES" }));
    expect((await workflowOf(w)).decisions.at(-1)).toMatchObject({ decision: "REQUEST_CHANGES" });
  });

  it("a high risk plan: no button, a link to the task page, and a forged button press is refused at the sink and again at the gate", async () => {
    const w = await world({ risk: "high" });
    const event = (await card(w))!;
    expect(event.data.actions).toBeUndefined();
    expect(event.data.text).toContain(`Risk: high`);
    expect(event.data.text).toContain(PAGE);
    expect(event.data.taskUrl).toBe(PAGE);
    expect(await readApprovalCard({ store: w.store, orgId: ORG, now }, event.data.requestId)).toMatchObject({ kind: "plan_approval", risk: "high", offered: [] });
    // A press nobody offered: refused by the sink in fixed words, nothing reaches the gate.
    await w.sink.decision(decisionFor(event.data.requestId, { expectedRevision: event.data.expectedRevision }));
    expect(await approvals(w)).toBe(0);
    expect((ofType(w.deliveries, "error").at(-1) as { data: { text: string } }).data.text).toContain("task page");
    // The same press with a card record forged to offer it (the sink's own list and kind rules say no again).
    await w.store.update({ key: cardKey(ORG, event.data.requestId), ops: [change.set("offered", ["APPROVE"])] });
    await w.sink.decision(decisionFor(event.data.requestId, { eventId: "press2", expectedRevision: event.data.expectedRevision }));
    expect(await approvals(w)).toBe(0);
    expect((ofType(w.deliveries, "error").at(-1) as { data: { text: string } }).data.text).toBe(decisionRefusalWords("step_up"));
  });

  it("a high risk approval pressed in a chat is refused by the gate itself, whatever the sink let through", async () => {
    const w = await world({ risk: "high" });
    const attempt = await w.gate.decide({
      companyId: ORG, kind: "workflow-document", subjectId: TASK, requestId: "chat-forged-1", outcome: "approve", seen: { revision: (await workflowOf(w)).revision, artifactDigest: DIGEST },
      credentials: [{ method: "chat-examplechat", token: "t1", claimedAccount: { provider: "examplechat", tenant: "team1", accountId: "user1" } }], reason: "Pressed in chat.",
    });
    expect(attempt).toMatchObject({ status: "refused", reason: "method_not_allowed" });
    expect(await approvals(w)).toBe(0);
  });

  it("a plan whose approvers do not take a chat decision gets no button even at low risk", async () => {
    const w = await world({ risk: "low", chatApprovers: false });
    const event = (await card(w))!;
    expect(event.data.actions).toBeUndefined();
    expect(event.data.text).toContain(PAGE);
  });

  it("without an https address the high risk card says where to open the task instead", async () => {
    const w = await world({ risk: "high", taskUrl: false });
    const event = (await card(w))!;
    expect(event.data.taskUrl).toBeUndefined();
    expect(event.data.text).toContain("rovara open");
  });

  it("a press from someone who is not the owner is refused, and so is one from an account nobody linked", async () => {
    const w = await world({ risk: "low" });
    const event = (await card(w))!;
    await w.sink.decision(decisionFor(event.data.requestId, { eventId: "other", actor: STRANGER_ACTOR, expectedRevision: event.data.expectedRevision }));
    await w.sink.decision(decisionFor(event.data.requestId, { eventId: "nobody", actor: { ...ACTOR, userId: "ghost" }, expectedRevision: event.data.expectedRevision }));
    expect(await approvals(w)).toBe(0);
    expect((await workflowOf(w)).decisions).toHaveLength(0);
  });

  it("a press for a revision that is no longer the plan is refused", async () => {
    const w = await world({ risk: "low" });
    const event = (await card(w))!;
    // A wrong revision or digest on the press is the sink's refusal.
    await w.sink.decision(decisionFor(event.data.requestId, { eventId: "a", expectedRevision: event.data.expectedRevision + 1 }));
    await w.sink.decision(decisionFor(event.data.requestId, { eventId: "b", expectedRevision: event.data.expectedRevision, artifactDigest: DIGEST_2 }));
    // The plan is replaced after the card was posted: the press names what the card showed, and the gate refuses it as stale.
    const before = await workflowOf(w);
    const replaced = { ...before, revision: before.revision + 1, artifacts: [...before.artifacts, { ...before.artifacts.at(-1)!, id: "plan-v2", version: 2, sha256: DIGEST_2 }] };
    await w.store.update({ key: workflowTaskKey(TASK), ops: [change.set("workflow", JSON.parse(JSON.stringify(replaced)) as JsonValue)] });
    await w.sink.decision(decisionFor(event.data.requestId, { eventId: "c", expectedRevision: event.data.expectedRevision }));
    expect(await approvals(w)).toBe(0);
    expect((ofType(w.deliveries, "error").at(-1) as { data: { text: string } }).data.text).toContain("changed");
  });

  it("a repeated press is idempotent: one approval, and the second answer is the same", async () => {
    const w = await world({ risk: "low" });
    const event = (await card(w))!;
    const press = (eventId: string) => w.sink.decision(decisionFor(event.data.requestId, { eventId, expectedRevision: event.data.expectedRevision }));
    await press("p1");
    await press("p2");
    await press("p1");
    expect(await approvals(w)).toBe(1);
    expect((await workflowOf(w)).decisions.filter((entry) => entry.requestId === event.data.requestId)).toHaveLength(1);
    expect(ofType(w.deliveries, "progress").filter((entry) => (entry as { data: { text: string } }).data.text === "Recorded.")).toHaveLength(2);
    expect(ofType(w.deliveries, "error")).toHaveLength(0);
  });

  it("the card is posted once per plan revision, and the milestone told again posts nothing", async () => {
    const w = await world({ risk: "low" });
    await w.handler.on(milestone("plan_ready"));
    await w.handler.on(milestone("plan_ready"));
    expect(ofType(w.deliveries, "approval_request")).toHaveLength(1);
    // A plan that is no longer waiting has no card.
    await w.store.update({ key: workflowTaskKey(TASK), ops: [change.set("closedAt", "2026-11-12T11:00:00.000Z")] });
    const second = await world({ risk: "low" });
    await second.store.update({ key: workflowTaskKey(TASK), ops: [change.set("closedAt", "2026-11-12T11:00:00.000Z")] });
    await second.handler.on(milestone("plan_ready"));
    expect(second.deliveries).toEqual([]);
  });

  it("a failed send takes back its claim, so the hook's retry sends the card", async () => {
    const w = await world({ risk: "low" });
    let fail = true;
    const real = w.adapter.deliver.bind(w.adapter);
    w.adapter.deliver = async (event) => { if (fail) throw new Error("down"); await real(event); };
    await expect(w.handler.on(milestone("plan_ready"))).rejects.toThrow("down");
    fail = false;
    await w.handler.on(milestone("plan_ready"));
    expect(ofType(w.adapter.delivered, "approval_request")).toHaveLength(1);
  });

  it("another company's thread never gets the card, and a failing company or member rule sends nothing", async () => {
    const other = await world({ companyOf: () => OTHER });
    await other.handler.on(milestone("plan_ready"));
    expect(other.deliveries).toEqual([]);
    const nobody = await world({ companyOf: () => undefined });
    await nobody.handler.on(milestone("plan_ready"));
    expect(nobody.deliveries).toEqual([]);
    const failing = await world({ companyOf: () => { throw new Error("directory down"); } });
    await failing.handler.on(milestone("plan_ready"));
    expect(failing.deliveries).toEqual([]);
    const notMember = await world({ companyOf: () => ORG, isMember: () => false });
    await notMember.handler.on(milestone("plan_ready"));
    expect(notMember.deliveries).toEqual([]);
    const memberFails = await world({ companyOf: () => ORG, isMember: () => { throw new Error("members down"); } });
    await memberFails.handler.on(milestone("plan_ready"));
    expect(memberFails.deliveries).toEqual([]);
    // Nothing was written for any of them: no card record.
    expect((await other.store.query({ pk: `ORG#${ORG}#CHANNEL_NOTICE#${SESSION}` })).items).toEqual([]);
    // A thread of this company's own tenant, with the member served, does get it.
    const served = await world({ companyOf: () => ORG, isMember: () => true, risk: "low" });
    await served.handler.on(milestone("plan_ready"));
    expect(ofType(served.deliveries, "approval_request")).toHaveLength(1);
  });

  it("a task of another company is never told, even through a thread row", async () => {
    const w = await world({ taskOrg: OTHER });
    await w.handler.on(milestone("plan_ready"));
    await w.handler.on(milestone("merged"));
    expect(w.deliveries).toEqual([]);
    const own = await world();
    await own.handler.on(milestone("merged", {}, OTHER));
    expect(own.deliveries).toEqual([]);
  });
});

describe("the milestone lines", () => {
  const PR = { repository: "acme/web", number: 7, url: "https://git.example.test/acme/web/pull/7" };

  it("tells plan ready (with the link), pull request opened (with its link) and done, each once, and nothing else", async () => {
    const w = await world({ withGate: false });
    await w.handler.on(milestone("plan_ready"));
    await w.handler.on(milestone("pr_ready", { pullRequests: [PR] }));
    await w.handler.on(milestone("merged"));
    expect(w.deliveries.map((event) => event.type)).toEqual(["progress", "pr", "done"]);
    expect((w.deliveries[0] as { data: { text: string } }).data.text).toBe(`The plan for "Add a retry" is ready for review. ${PAGE}`);
    expect(w.deliveries[1]).toMatchObject({ data: { url: PR.url, title: "Add a retry", action: "opened" } });
    expect(w.deliveries[2]).toMatchObject({ data: { text: "\"Add a retry\" is merged.", outcome: "succeeded" } });
    // Milestones that are not these say nothing.
    for (const kind of ["questions", "answered", "review_nudge", "fixing", "stuck", "approved", "started"] as const) await w.handler.on(milestone(kind));
    expect(w.deliveries).toHaveLength(3);
  });

  it("a closed task is one line too, and the same task is done once whichever ending comes", async () => {
    const w = await world({ withGate: false });
    await w.handler.on(milestone("closed"));
    await w.handler.on(milestone("merged"));
    expect(ofType(w.deliveries, "done")).toHaveLength(1);
    expect(ofType(w.deliveries, "done")[0]).toMatchObject({ data: { text: "\"Add a retry\" was closed without a merge.", outcome: "cancelled" } });
  });

  it("a redelivery sends nothing: the adapter is not even asked", async () => {
    const w = await world({ withGate: false });
    for (let round = 0; round < 3; round += 1) {
      await w.handler.on(milestone("plan_ready"));
      await w.handler.on(milestone("pr_ready", { pullRequests: [PR] }));
      await w.handler.on(milestone("merged"));
    }
    expect(w.deliveries).toHaveLength(3);
  });

  it("tells a new plan revision again, and another pull request, but never the same one twice", async () => {
    const w = await world({ withGate: false });
    await w.handler.on(milestone("plan_ready"));
    const before = await workflowOf(w);
    await w.store.update({ key: workflowTaskKey(TASK), ops: [change.set("workflow", JSON.parse(JSON.stringify({ ...before, revision: before.revision + 1 })) as JsonValue)] });
    await w.handler.on(milestone("plan_ready"));
    await w.handler.on(milestone("pr_ready", { pullRequests: [PR] }));
    await w.handler.on(milestone("pr_ready", { pullRequests: [{ ...PR, number: 8, url: "https://git.example.test/acme/web/pull/8" }] }));
    expect(w.deliveries.map((event) => event.type)).toEqual(["progress", "progress", "pr", "pr"]);
  });

  it("sends none of the three when the host turns milestones off, but the plan card is not a milestone and still goes", async () => {
    const off = await world({ milestones: false, withGate: false });
    await off.handler.on(milestone("plan_ready"));
    await off.handler.on(milestone("pr_ready", { pullRequests: [PR] }));
    await off.handler.on(milestone("merged"));
    await off.handler.on(milestone("closed"));
    expect(off.deliveries).toEqual([]);
    const card = await world({ milestones: false, risk: "low" });
    await card.handler.on(milestone("plan_ready"));
    await card.handler.on(milestone("pr_ready", { pullRequests: [PR] }));
    await card.handler.on(milestone("merged"));
    expect(card.deliveries.map((event) => event.type)).toEqual(["approval_request"]);
  });

  it("can be switched by a function read at each use", async () => {
    const state = { on: false };
    const w = await world({ withGate: false, milestones: false });
    void state;
    const handler = channelThreadHandler({ store: w.store, registry: { get: () => w.adapter } as never, now, milestones: () => state.on });
    await handler.on(milestone("merged"));
    expect(w.deliveries).toEqual([]);
    state.on = true;
    await handler.on(milestone("merged"));
    expect(ofType(w.deliveries, "done")).toHaveLength(1);
  });

  it("goes only to the task's own thread: a task started elsewhere, or with no thread, tells nobody", async () => {
    const w = await world({ withGate: false });
    await w.store.put({ item: { ...workflowTaskKey("11111111-1111-4111-8111-111111111111"), orgId: ORG, title: "Another", workflow: JSON.parse(JSON.stringify(waitingWorkflow())) as JsonValue } });
    await w.handler.on({ ...milestone("merged"), taskId: "11111111-1111-4111-8111-111111111111" });
    expect(w.deliveries).toEqual([]);
    expect(await threadFollows({ store: w.store })(ORG, SESSION)).toBe(true);
    expect(await threadFollows({ store: w.store })(ORG, taskSessionId("11111111-1111-4111-8111-111111111111"))).toBe(false);
    expect(await threadFollows({ store: w.store })(OTHER, SESSION)).toBe(false);
  });

  it("nothing crosses companies: another company's thread, a failing company rule and a member who is not served get nothing", async () => {
    for (const options of [{ companyOf: () => OTHER }, { companyOf: () => undefined }, { companyOf: (): never => { throw new Error("down"); } }, { companyOf: () => ORG, isMember: () => false }, { companyOf: () => ORG, isMember: (): never => { throw new Error("down"); } }] as WorldOptions[]) {
      const w = await world({ ...options, withGate: false });
      await w.handler.on(milestone("plan_ready"));
      await w.handler.on(milestone("pr_ready", { pullRequests: [PR] }));
      await w.handler.on(milestone("merged"));
      expect(w.deliveries).toEqual([]);
    }
    const served = await world({ withGate: false, companyOf: () => ORG, isMember: () => true });
    await served.handler.on(milestone("merged"));
    expect(served.deliveries).toHaveLength(1);
  });

  it("a pull request with no plain https address is told without a link instead of failing", async () => {
    const w = await world({ withGate: false });
    await w.handler.on(milestone("pr_ready", { pullRequests: [{ ...PR, url: "http://user:pw@git.example.test/x" }] }));
    expect(w.deliveries).toHaveLength(1);
    expect(JSON.stringify(w.deliveries[0])).not.toContain("user:pw");
  });
});

describe("the owner's approvers, in a chat they opted into", () => {
  const request = (overrides: Record<string, unknown> = {}) => ({ companyId: ORG, requestId: "req-12345678.x", kind: "plan", subject: { type: "task", id: TASK }, revision: 2, artifactDigest: DIGEST, risk: "low" as const, outcome: "approve" as const, ...overrides });
  const proof = (claimed: { provider: string; tenant: string; accountId: string } = { provider: "examplechat", tenant: "team1", accountId: "user1" }) => ({ proofId: "p1", method: "chat-examplechat", requestId: "req-12345678.x", revision: 2, artifactDigest: DIGEST, token: "t", claimedAccount: claimed });
  const omitClaim = (given: ReturnType<typeof proof>) => ({ proofId: given.proofId, method: given.method, requestId: given.requestId, revision: given.revision, artifactDigest: given.artifactDigest, token: given.token });
  const make = (linked: (account: { provider: string; tenant: string; accountId: string }) => boolean | Promise<boolean> = (account) => account.accountId === "user1") => createLocalOwnerApprovers({ owner, chat: { channels: () => ["examplechat"], linkedToOwner: linked } });

  it("offers the chat's method, never as a strong or a rejecting one, and offers none when no chat was named", async () => {
    const requirement = await make().requirement(request());
    expect(requirement.methods).toContain("chat-examplechat");
    expect(requirement.strongMethods ?? []).not.toContain("chat-examplechat");
    expect(requirement.rejectMethods ?? []).not.toContain("chat-examplechat");
    expect((await createLocalOwnerApprovers({ owner }).requirement(request())).methods).not.toContain("chat-examplechat");
  });

  it("accepts the owner's linked account for a low or medium risk approval or request for changes", async () => {
    for (const risk of ["low", "medium"] as const) {
      for (const outcome of ["approve", "request_changes"] as const) {
        const verdict = await make().verify(request({ risk, outcome }), proof());
        expect(verdict).toMatchObject({ approved: true, approver: { personId: owner.personId } });
      }
    }
  });

  it("refuses a high risk request, a request with no risk, a rejection, an account that is not the owner's, a failing link check and another chat", async () => {
    const refused = async (approvers: ReturnType<typeof make>, req: ReturnType<typeof request>, p: Parameters<ReturnType<typeof make>["verify"]>[1] = proof()) => (await approvers.verify(req, p)).approved;
    expect(await refused(make(), request({ risk: "high" }))).toBe(false);
    expect(await refused(make(), request({ risk: undefined }))).toBe(false);
    expect(await refused(make(), request({ outcome: "reject" }))).toBe(false);
    expect(await refused(make(), request(), proof({ provider: "examplechat", tenant: "team1", accountId: "user2" }))).toBe(false);
    expect(await refused(make(), request(), omitClaim(proof()))).toBe(false);
    expect(await refused(make(), request(), proof({ provider: "otherchat", tenant: "team1", accountId: "user1" }))).toBe(false);
    expect(await refused(make(() => { throw new Error("store down"); }), request())).toBe(false);
    expect(await refused(createLocalOwnerApprovers({ owner }), request())).toBe(false);
    expect(await refused(make(), request(), { ...proof(), method: "chat-unknown" })).toBe(false);
  });
});

describe("from a session change to the card", () => {
  const OTHER_TASK = "11111111-1111-4111-8111-111111111111";
  const changeOf = (taskId: string, sessionId: string, state: string, ended = false) => ({ orgId: ORG, sessionId, session: { subject: { kind: "task", taskId } }, summary: { display: { state } }, ended }) as never;

  it("writes the plan_ready milestone for a task started from a thread and not for one that was not, and the hook then delivers the card once", async () => {
    const w = await world({ risk: "low" });
    const v2 = (workflow: WorkflowSnapshot) => JSON.parse(JSON.stringify({ ...workflow, definitionVersion: "1.1.0" })) as JsonValue;
    await w.store.update({ key: workflowTaskKey(TASK), ops: [change.set("workflow", v2(await workflowOf(w)))] });
    await w.store.put({ item: { ...workflowTaskKey(OTHER_TASK), orgId: ORG, project: "web", title: "Another", sessionId: taskSessionId(OTHER_TASK), workflow: v2(waitingWorkflow()) } });
    const hook = createDocumentMilestones({ store: w.store, now });
    hook.register(w.handler);
    const onChange = ticketMomentsOnChange({ store: w.store, milestones: hook, now, follows: threadFollows({ store: w.store }) });
    await onChange(changeOf(OTHER_TASK, taskSessionId(OTHER_TASK), "needs_you"));
    expect(w.deliveries).toEqual([]);
    expect((await w.store.query({ pk: `DEVTASK#${OTHER_TASK}`, sk: { op: "beginsWith", prefix: "CODE_MILESTONE#" } })).items).toEqual([]);
    await onChange(changeOf(TASK, SESSION, "needs_you"));
    await onChange(changeOf(TASK, SESSION, "needs_you"));
    expect(ofType(w.deliveries, "approval_request")).toHaveLength(1);
    // A task the thread follows that ended closed gets its `closed` milestone as well.
    await onChange(changeOf(TASK, SESSION, "closed", true));
    expect((await w.store.query({ pk: `DEVTASK#${TASK}`, sk: { op: "beginsWith", prefix: "CODE_MILESTONE#closed" } })).items).toHaveLength(1);
  });
});
