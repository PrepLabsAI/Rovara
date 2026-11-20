// Lane L6b: the approval gate. Approvals are authority, so each way to get one wrongly has a test: a forged proof, the wrong person, a stale revision, a replayed proof or request, a lost race,
// a request of another company, an expired request. The gate is built on W0's fakes (the memory document store, Code's default approvers).
/* eslint-disable @typescript-eslint/no-unsafe-assignment -- vitest's expect.* matchers are typed any */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  IMPLICIT_COMPANY_ID, createWorkflowSnapshot, submitWorkflowArtifact, when,
  type ApprovalProof, type ApprovalRequest, type ApprovalRequirement, type ApprovalVerdict, type Approvers, type AuditSink, type ExternalAccountRef, type Principal, type WorkflowSnapshot,
} from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { CODE_HOST_COMMENT_METHOD, LOCAL_SESSION_METHOD, createLocalOwnerApprovers, createNoopAuditSink, localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { approvalRecordKey, createDecisionGate, type DecisionAttempt } from "../../packages/broker/src/core/decisions/approval-gate.js";
import { createWorkflowDocumentSubject, workflowTaskKey, waitingDocumentDigest } from "../../packages/broker/src/core/decisions/workflow-subject.js";
import { commentReads, freshComment } from "../support/comment-fakes.js";
import type { FetchedComment } from "../../packages/broker/src/core/pr-commands/comment-checks.js";

const COMPANY = IMPLICIT_COMPANY_ID;
const OWNER = localOwnerPrincipal();
const TASK_ID = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const OWNER_HEX = "a".repeat(64);
// Tokens are built at run time: nothing in this file looks like a key.
const SESSION = ["local", "session", "secret", "for", "tests"].join("-");
const COMMENT = "comment-4711";
const COLLABORATOR: ExternalAccountRef = { provider: "any-code-host", tenant: "", accountId: "collab" };
const NOW = new Date("2026-11-09T12:00:00.000Z");

const planArtifact = (version: number, sha: string) => ({
  id: `plan-v${String(version)}`, type: "plan" as const, version, sha256: sha, producer: "agentx-planner",
  objectKey: `tasks/${TASK_ID}/plan-v${String(version)}.json`, createdAt: "2026-11-09T10:00:00.000Z", format: "structured" as const,
});

function waiting(version = 1, sha = "b".repeat(64)): WorkflowSnapshot {
  const initial = createWorkflowSnapshot({ taskId: TASK_ID, ownerId: OWNER_HEX, now: "2026-11-09T09:59:00.000Z" });
  return submitWorkflowArtifact(initial, { expectedRevision: initial.revision, artifact: planArtifact(version, sha), now: "2026-11-09T10:00:00.000Z" });
}

const R0 = waiting().revision;

function world(options: { workflow?: WorkflowSnapshot; approvers?: Approvers; risk?: "low" | "medium" | "high"; audit?: AuditSink; companyOnTask?: string; requestedBy?: Principal; expiresAt?: string; comment?: () => FetchedComment | undefined } = {}) {
  const store = new MemoryDocumentStore();
  const workflow = options.workflow ?? waiting();
  const put = (value: WorkflowSnapshot) => store.put({ item: { ...workflowTaskKey(TASK_ID), entityType: "DEVELOPER_TASK", orgId: options.companyOnTask ?? COMPANY, project: "web", workflow: JSON.parse(JSON.stringify(value)) } });
  const approvers = options.approvers ?? createLocalOwnerApprovers({
    owner: OWNER, now: () => NOW, verifySession: (token) => token === SESSION,
    ...commentReads(options.comment === undefined ? freshComment(COLLABORATOR) : options.comment(), { id: COMMENT }),
  });
  const subject = createWorkflowDocumentSubject({
    store, riskOf: () => options.risk ?? "low",
    ...(options.requestedBy === undefined ? {} : { requestedBy: () => options.requestedBy }), ...(options.expiresAt === undefined ? {} : { expiresAt: () => options.expiresAt }),
  });
  const gate = createDecisionGate({ store, approvers, audit: options.audit ?? createNoopAuditSink(), subjects: [subject], now: () => NOW });
  return { store, gate, put, ready: put(workflow), approvers, subject };
}

const taskWorkflow = async (store: MemoryDocumentStore): Promise<WorkflowSnapshot> => (await store.get(workflowTaskKey(TASK_ID)))!["workflow"] as unknown as WorkflowSnapshot;

function attempt(overrides: Partial<DecisionAttempt> & { workflow?: WorkflowSnapshot } = {}): DecisionAttempt {
  const workflow = overrides.workflow ?? waiting();
  return {
    companyId: COMPANY, kind: "workflow-document", subjectId: TASK_ID, requestId: randomUUID(), outcome: "approve",
    seen: { revision: workflow.revision, artifactDigest: waitingDocumentDigest(workflow)! },
    credentials: [{ method: LOCAL_SESSION_METHOD, token: SESSION }],
    ...overrides,
  };
}

describe("the approval gate: a right approval", () => {

  it("a repeat of a finished decision is answered again and changes nothing; the same id for another decision is refused", async () => {
    const { store, gate, ready } = world();
    await ready;
    const request = attempt();
    expect(await gate.decide(request)).toMatchObject({ status: "decided" });
    expect(await gate.decide(request)).toMatchObject({ status: "replayed", record: { requestId: request.requestId } });
    expect((await taskWorkflow(store)).revision).toBe(R0 + 1);
    expect(await gate.decide({ ...request, outcome: "reject" })).toMatchObject({ status: "refused", reason: "request_id_reused" });
    expect(await gate.decide({ ...request, seen: { ...request.seen, revision: 9 } })).toMatchObject({ status: "refused", reason: "request_id_reused" });
  });
});

describe("the approval gate: a forged or wrong proof", () => {

  it("an empty or missing proof and a method nobody offers are refused before anything is read", async () => {
    const { gate, ready } = world();
    await ready;
    expect(await gate.decide(attempt({ credentials: [] }))).toMatchObject({ reason: "invalid" });
    expect(await gate.decide(attempt({ credentials: [{ method: LOCAL_SESSION_METHOD, token: "" }] }))).toMatchObject({ reason: "invalid" });
    expect(await gate.decide(attempt({ credentials: [{ method: "browser-step-up", token: SESSION }] }))).toMatchObject({ reason: "method_not_allowed" });
    expect(await gate.decide(attempt({ requestId: "x" }))).toMatchObject({ reason: "invalid" });
    expect(await gate.decide(attempt({ outcome: "skip" as never }))).toMatchObject({ reason: "invalid" });
    expect(await gate.decide(attempt({ kind: "merge" }))).toMatchObject({ reason: "unsupported" });
  });

  it("an install can make the owner the only decider of plans: then a collaborator's comment is refused", async () => {
    const store = new MemoryDocumentStore();
    await store.put({ item: { ...workflowTaskKey(TASK_ID), orgId: COMPANY, workflow: JSON.parse(JSON.stringify(waiting())) } });
    const approvers = createLocalOwnerApprovers({ owner: OWNER, ...commentReads(freshComment(COLLABORATOR)) });
    const gate = createDecisionGate({ store, approvers, audit: createNoopAuditSink(), subjects: [createWorkflowDocumentSubject({ store, riskOf: () => "low", collaboratorsMayDecide: false })], now: () => NOW });
    expect(await gate.decide(attempt({ credentials: [{ method: CODE_HOST_COMMENT_METHOD, token: COMMENT }] }))).toMatchObject({ status: "refused", reason: "not_the_approver" });
    expect((await taskWorkflow(store)).revision).toBe(R0);
  });

  it("a comment from someone without write access, or from another account than the one claimed, is not an approval", async () => {
    const reader = world({ comment: () => freshComment(COLLABORATOR, { permission: "read" }) });
    await reader.ready;
    expect(await reader.gate.decide(attempt({ credentials: [{ method: CODE_HOST_COMMENT_METHOD, token: COMMENT }] }))).toMatchObject({ reason: "not_approved", detail: expect.stringContaining("not_a_collaborator") });
    const swapped = world();
    await swapped.ready;
    expect(await swapped.gate.decide(attempt({ credentials: [{ method: CODE_HOST_COMMENT_METHOD, token: COMMENT, claimedAccount: { ...COLLABORATOR, accountId: "someone-else" } }] }))).toMatchObject({ reason: "not_approved", detail: expect.stringContaining("account_mismatch") });
    const notApproving = world({ comment: () => freshComment(COLLABORATOR, { permission: "admin", body: "looks fine to me" }) });
    await notApproving.ready;
    expect(await notApproving.gate.decide(attempt({ credentials: [{ method: CODE_HOST_COMMENT_METHOD, token: COMMENT }] }))).toMatchObject({ reason: "not_approved" });
  });

  it("a comment never rejects, asks for changes only with a `/rovara changes:` command, and never approves a high-risk request", async () => {
    const reject = world();
    await reject.ready;
    expect(await reject.gate.decide(attempt({ outcome: "reject", credentials: [{ method: CODE_HOST_COMMENT_METHOD, token: COMMENT }] }))).toMatchObject({ reason: "method_not_allowed" });
    // Owner decision 62 (A3): asking for changes by comment is allowed, but a comment that says "approve" is no proof for it (decision 66: the answer is part of the check).
    expect(await reject.gate.decide(attempt({ outcome: "request_changes", reason: "keep the old API", credentials: [{ method: CODE_HOST_COMMENT_METHOD, token: COMMENT }] }))).toMatchObject({ reason: "not_approved", detail: expect.stringContaining("no_approving_comment") });
    const changes = world({ comment: () => freshComment(COLLABORATOR, { body: "/rovara changes: keep the old API" }) });
    await changes.ready;
    expect(await changes.gate.decide(attempt({ outcome: "request_changes", reason: "keep the old API", credentials: [{ method: CODE_HOST_COMMENT_METHOD, token: COMMENT }] }))).toMatchObject({ status: "decided" });
    const high = world({ risk: "high" });
    await high.ready;
    expect(await high.gate.decide(attempt({ credentials: [{ method: CODE_HOST_COMMENT_METHOD, token: COMMENT }] }))).toMatchObject({ reason: "method_not_allowed" });
    // The local session still approves it.
    expect(await high.gate.decide(attempt())).toMatchObject({ status: "decided" });
  });
});

describe("the approval gate: a stale revision or digest", () => {
  it("what the person saw must be what is waiting now: an older revision, another digest or both are stale", async () => {
    const { store, gate, ready } = world();
    await ready;
    const current = waiting();
    for (const seen of [{ revision: current.revision + 1, artifactDigest: waitingDocumentDigest(current)! }, { revision: current.revision, artifactDigest: "c".repeat(64) }, { revision: 0, artifactDigest: "d".repeat(64) }]) {
      expect(await gate.decide(attempt({ seen }))).toMatchObject({ status: "refused", reason: expect.stringMatching(/stale|invalid/u) });
    }
    expect((await taskWorkflow(store)).revision).toBe(R0);
  });

  it("a decided, closed or missing task is not waiting", async () => {
    const { gate, ready } = world();
    await ready;
    expect(await gate.decide(attempt())).toMatchObject({ status: "decided" });
    expect(await gate.decide(attempt({ workflow: { ...waiting(), revision: 2 } }))).toMatchObject({ reason: expect.stringMatching(/not_waiting|stale/u) });
    expect(await gate.decide(attempt({ subjectId: randomUUID() }))).toMatchObject({ reason: "not_found" });
    expect(await gate.decide(attempt({ subjectId: "../etc" }))).toMatchObject({ reason: "not_found" });
  });
});

describe("the approval gate: replayed proofs and lost races", () => {
  it("a repeat is answered only to someone who holds the proof that made the decision: knowing the request id is not enough", async () => {
    const { gate, ready } = world();
    await ready;
    const request = attempt();
    expect(await gate.decide(request)).toMatchObject({ status: "decided" });
    // Another person (a different credential) sends the same request id and the same body.
    expect(await gate.decide({ ...request, credentials: [{ method: CODE_HOST_COMMENT_METHOD, token: COMMENT }] })).toMatchObject({ status: "refused", reason: "request_id_reused" });
    expect(await gate.decide({ ...request, credentials: [{ method: LOCAL_SESSION_METHOD, token: "someone-elses-session" }] })).toMatchObject({ status: "refused", reason: "request_id_reused" });
    expect(await gate.decide(request)).toMatchObject({ status: "replayed" });
  });

  it("two requests racing for one request id: one decides, the other hears the same answer, and the task moves once", async () => {
    const { store, gate, ready } = world();
    await ready;
    const request = attempt();
    const [first, second] = await Promise.all([gate.decide(request), gate.decide(request)]);
    // The adapter may have seen the proof already (in this process), so the loser is told either the same answer or that the proof is used; the task moves once either way.
    expect([first, second].filter((result) => result.status === "decided")).toHaveLength(1);
    expect([first, second].filter((result) => result.status === "replayed" || (result.status === "refused" && result.reason === "proof_already_used"))).toHaveLength(1);
    expect((await taskWorkflow(store)).revision).toBe(R0 + 1);
    expect((await taskWorkflow(store)).decisions).toHaveLength(1);
  });
});

describe("the approval gate: the wrong company, an expired request, and who may approve", () => {

  it("an approver the adapter vouches for in another company is refused", async () => {
    const stranger: Principal = { ...OWNER, companyId: "org_zzzzzzzzzzzzzzzzzzzz" };
    const approvers: Approvers = {
      async requirement() { return { methods: [LOCAL_SESSION_METHOD], minApprovers: 1, selfApprovalAllowed: true }; },
      async verify(_request, proof) { return { approved: true, approver: stranger, method: proof.method, proofId: proof.proofId }; },
    };
    const { store, gate, ready } = world({ approvers });
    await ready;
    expect(await gate.decide(attempt())).toMatchObject({ reason: "not_approved", detail: expect.stringContaining("wrong_company") });
    expect((await taskWorkflow(store)).revision).toBe(R0);
  });

  it("an expired request is refused", async () => {
    const { store, gate, ready } = world({ expiresAt: "2026-11-09T11:59:59.000Z" });
    await ready;
    expect(await gate.decide(attempt())).toMatchObject({ status: "refused", reason: "expired" });
    expect((await taskWorkflow(store)).revision).toBe(R0);
  });

  it("when the request does not allow self-approval, the person who asked cannot approve it", async () => {
    const approvers: Approvers = {
      async requirement() { return { methods: [LOCAL_SESSION_METHOD], minApprovers: 1, selfApprovalAllowed: false }; },
      async verify(_request, proof) { return { approved: true, approver: OWNER, method: proof.method, proofId: proof.proofId }; },
    };
    const { gate, ready } = world({ approvers, requestedBy: OWNER });
    await ready;
    expect(await gate.decide(attempt())).toMatchObject({ reason: "self_approval_not_allowed" });
  });

  it("an adapter that asks for two approvers gets them: one proof is not enough, the same proof twice is not two people", async () => {
    const second: Principal = { ...OWNER, personId: "second-person", roles: ["owner"] };
    const approvers: Approvers = {
      async requirement() { return { methods: [LOCAL_SESSION_METHOD], minApprovers: 2, selfApprovalAllowed: true }; },
      async verify(_request, proof) { return { approved: true, approver: proof.token === "second" ? second : OWNER, method: proof.method, proofId: proof.proofId }; },
    };
    const { store, gate, ready } = world({ approvers });
    await ready;
    expect(await gate.decide(attempt({ credentials: [{ method: LOCAL_SESSION_METHOD, token: "first" }] }))).toMatchObject({ reason: "needs_more_approvers" });
    expect(await gate.decide(attempt({ credentials: [{ method: LOCAL_SESSION_METHOD, token: "first" }, { method: LOCAL_SESSION_METHOD, token: "first" }] }))).toMatchObject({ reason: "invalid" });
    expect(await gate.decide(attempt({ credentials: [{ method: LOCAL_SESSION_METHOD, token: "first" }, { method: LOCAL_SESSION_METHOD, token: "second" }] }))).toMatchObject({ status: "decided", record: { approvers: [{ personId: OWNER.personId }, { personId: "second-person" }] } });
    expect((await taskWorkflow(store)).revision).toBe(R0 + 1);
  });
});

describe("the approval gate: a failing store never half-decides", () => {
  it("a throttled store fails the call and leaves no decision, so the same request can be sent again with the same proof... once the adapter allows it", async () => {
    const { store, gate, ready } = world();
    await ready;
    store.injectFault(new (await import("@agentx/contracts")).DocumentStoreError("unavailable", "down"));
    const request = attempt();
    await expect(gate.decide(request)).rejects.toThrow();
    expect(await store.get(approvalRecordKey(COMPANY, request.requestId))).toBeUndefined();
    expect((await taskWorkflow(store)).revision).toBe(R0);
    void when;
  });
});

describe("the approval gate: what the review of round 1 found", () => {

  it("a task record that names its company as `companyId` (the task flow's) is read the same as one with `orgId`", async () => {
    const store = new MemoryDocumentStore();
    await store.put({ item: { ...workflowTaskKey(TASK_ID), companyId: COMPANY, workflow: JSON.parse(JSON.stringify(waiting())) } });
    const gate = createDecisionGate({ store, approvers: createLocalOwnerApprovers({ owner: OWNER, verifySession: (token) => token === SESSION }), audit: createNoopAuditSink(), subjects: [createWorkflowDocumentSubject({ store, riskOf: () => "low" })], now: () => NOW });
    expect(await gate.decide(attempt())).toMatchObject({ status: "decided" });
    await store.put({ item: { ...workflowTaskKey(TASK_ID), companyId: "org_zzzzzzzzzzzzzzzzzzzz", workflow: JSON.parse(JSON.stringify(waiting())) } });
    expect(await gate.decide(attempt())).toMatchObject({ status: "refused", reason: "not_found" });
  });
});

describe("the approval gate: a chat method is one act and no sign-in", () => {
  /** An approvers plug-in that names the chat method as a strong method and takes any proof of it as the owner's. */
  const chatNamed = (): Approvers => {
    const requirement: ApprovalRequirement = { methods: ["chat-examplechat"], minApprovers: 1, selfApprovalAllowed: true, strongMethods: ["chat-examplechat"], rejectMethods: ["chat-examplechat"], changesMethods: ["chat-examplechat"] };
    return {
      async requirement() { return requirement; },
      async verify(_request: ApprovalRequest, proof: ApprovalProof): Promise<ApprovalVerdict> { return { approved: true, approver: OWNER, method: proof.method, proofId: proof.proofId }; },
    };
  };
  const press = (overrides: Partial<DecisionAttempt> = {}): DecisionAttempt => attempt({
    credentials: [{ method: "chat-examplechat", token: "trigger-1", claimedAccount: { provider: "examplechat", tenant: "team1", accountId: "user1" } }], ...overrides,
  });

  it("is still the plug-in's to take for a low-risk approval", async () => {
    const low = world({ approvers: chatNamed(), risk: "low" });
    await low.ready;
    expect(await low.gate.decide(press())).toMatchObject({ status: "decided" });
  });

  it("is refused when the plug-in names nothing strong and the default would have been the local session", async () => {
    const plain: Approvers = { async requirement() { return { methods: ["chat-examplechat"], minApprovers: 1, selfApprovalAllowed: true }; }, async verify(_request, proof) { return { approved: true, approver: OWNER, method: proof.method, proofId: proof.proofId }; } };
    const high = world({ approvers: plain, risk: "high" });
    await high.ready;
    expect(await high.gate.decide(press())).toMatchObject({ status: "refused", reason: "method_not_allowed" });
  });
});
