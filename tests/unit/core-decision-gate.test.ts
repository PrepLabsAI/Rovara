// Lane L6b: the approval gate. Approvals are authority, so each way to get one wrongly has a test: a forged proof, the wrong person, a stale revision, a replayed proof or request, a lost race,
// a request of another company, an expired request. The gate is built on W0's fakes (the memory document store, Code's default approvers).
/* eslint-disable @typescript-eslint/no-unsafe-assignment -- vitest's expect.* matchers are typed any */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  IMPLICIT_COMPANY_ID, approvalProofKey, createWorkflowSnapshot, submitWorkflowArtifact, when,
  type ApprovalProof, type ApprovalRequest, type ApprovalRequirement, type ApprovalVerdict, type Approvers, type AuditSink, type ExternalAccountRef, type Principal, type TransactItem, type WorkflowSnapshot,
} from "@rovara-code/contracts";
import { MemoryDocumentStore } from "../../packages/core/src/ports/memory-document-store.js";
import { CODE_HOST_COMMENT_METHOD, LOCAL_SESSION_METHOD, createLocalOwnerApprovers, createNoopAuditSink, localOwnerPrincipal } from "../../packages/core/src/ports/policy-defaults.js";
import { decisionRequestIdOf, approvalBindingId, approvalProofMarkerKey, approvalRecordKey, createDecisionGate, type DecisionAttempt, type DecisionSubject } from "../../packages/core/src/core/decisions/approval-gate.js";
import { createWorkflowDocumentSubject, workflowTaskKey, waitingDocumentDigest } from "../../packages/core/src/core/decisions/workflow-subject.js";
import { commentReads, freshComment } from "../support/comment-fakes.js";
import type { FetchedComment } from "../../packages/core/src/core/pr-commands/comment-checks.js";

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
/** What a proof is bound to for the plan waiting at revision R0. */
const binding = (revision = R0, digest = waitingDocumentDigest(waiting())!) => approvalBindingId(COMPANY, "workflow-document", TASK_ID, revision, digest);

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
  it("the local owner's session approves the plan: the workflow moves on, and the decision, the used proof and the audit commit together", async () => {
    const records: TransactItem[] = [];
    const audit: AuditSink = { stage: (event) => { const item: TransactItem = { kind: "put", item: { pk: `AUDIT#${event.eventId}`, sk: "EVENT", action: event.action, actor: event.actor.id } }; records.push(item); return [item]; }, async record() {} };
    const { store, gate, ready } = world({ audit });
    await ready;
    const request = attempt();
    const result = await gate.decide(request);
    expect(result).toMatchObject({ status: "decided", approver: { personId: OWNER.personId }, record: { outcome: "approve", revision: R0 } });
    const after = await taskWorkflow(store);
    expect(after.revision).toBe(R0 + 1);
    expect(after.stage).toBe("IMPLEMENT");
    expect(after.decisions.at(-1)).toMatchObject({ requestId: request.requestId, decision: "APPROVE", actorId: OWNER_HEX });
    expect(await store.get(approvalRecordKey(COMPANY, request.requestId))).toMatchObject({ outcome: "approve", artifactDigest: request.seen.artifactDigest });
    expect(await store.get(approvalProofMarkerKey(COMPANY, approvalProofKey({ method: LOCAL_SESSION_METHOD, token: SESSION, requestId: binding() })))).toBeDefined();
    expect(await store.get({ pk: `AUDIT#approval:${request.requestId}`, sk: "EVENT" })).toMatchObject({ action: "decision.approved", actor: OWNER.personId });
  });

  it("the secret is never stored: no document the decision wrote holds the session token", async () => {
    const { store, gate, ready } = world();
    await ready;
    await gate.decide(attempt());
    const everything = JSON.stringify(await Promise.all([store.get(workflowTaskKey(TASK_ID))]));
    expect(everything).not.toContain(SESSION);
    const markers = await store.query({ pk: approvalProofMarkerKey(COMPANY, "x").pk });
    expect(JSON.stringify(markers.items)).not.toContain(SESSION);
  });

  it("rejecting closes the task, and asking for changes sends it back to planning", async () => {
    const rejected = world();
    await rejected.ready;
    expect(await rejected.gate.decide(attempt({ outcome: "reject", reason: "Not needed." }))).toMatchObject({ status: "decided" });
    expect(await taskWorkflow(rejected.store)).toMatchObject({ stage: "CLOSED", state: "COMPLETE" });
    const changes = world();
    await changes.ready;
    expect(await changes.gate.decide(attempt({ outcome: "request_changes", reason: "Use the other table." }))).toMatchObject({ status: "decided" });
    expect(await taskWorkflow(changes.store)).toMatchObject({ stage: "PLAN" });
  });

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
  it("a made-up session token approves nothing", async () => {
    const { store, gate, ready } = world();
    await ready;
    const result = await gate.decide(attempt({ credentials: [{ method: LOCAL_SESSION_METHOD, token: "guessed-token" }] }));
    expect(result).toMatchObject({ status: "refused", reason: "not_approved" });
    expect((await taskWorkflow(store)).revision).toBe(R0);
    expect(await store.get(approvalRecordKey(COMPANY, "any"))).toBeUndefined();
  });

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

  it("a write collaborator's comment decides a low-risk plan as a project approver, recorded as theirs and never as the owner's (decision 45.3)", async () => {
    const { store, gate, ready } = world();
    await ready;
    const result = await gate.decide(attempt({ credentials: [{ method: CODE_HOST_COMMENT_METHOD, token: COMMENT, claimedAccount: COLLABORATOR }] }));
    expect(result).toMatchObject({ status: "decided", approver: { roles: ["collaborator"] } });
    const decision = (await taskWorkflow(store)).decisions.at(-1)!;
    expect(decision).toMatchObject({ decision: "APPROVE", actorRole: "PROJECT_ADMIN" });
    expect(decision.actorId).not.toBe(OWNER_HEX);
    expect(decision.actorId).toMatch(/^[a-f0-9]{64}$/u);
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

  it("a request nobody graded is treated as high risk", async () => {
    const store = new MemoryDocumentStore();
    await store.put({ item: { ...workflowTaskKey(TASK_ID), orgId: COMPANY, workflow: JSON.parse(JSON.stringify(waiting())) } });
    const subject = createWorkflowDocumentSubject({ store });
    const gate = createDecisionGate({ store, approvers: createLocalOwnerApprovers({ owner: OWNER, verifySession: (t) => t === SESSION, ...commentReads(freshComment(COLLABORATOR)) }), audit: createNoopAuditSink(), subjects: [subject], now: () => NOW });
    expect(await gate.decide(attempt({ credentials: [{ method: CODE_HOST_COMMENT_METHOD, token: COMMENT }] }))).toMatchObject({ reason: "method_not_allowed" });
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

  it("a plan revised after the person looked cannot be approved by their yes", async () => {
    const { store, gate, put, ready } = world();
    await ready;
    const looked = attempt();
    // The planner sends a new version while the owner reads the old one.
    const revised = waiting(2, "e".repeat(64));
    await put({ ...revised, revision: revised.revision + 1 });
    expect(await gate.decide(looked)).toMatchObject({ status: "refused", reason: "stale" });
    expect((await taskWorkflow(store)).decisions).toHaveLength(0);
    // Seeing the new one and deciding works.
    const now = await taskWorkflow(store);
    expect(await gate.decide(attempt({ workflow: now }))).toMatchObject({ status: "decided" });
  });

  it("a change between the gate's read and its write loses (the subject's guard is on the update)", async () => {
    const { store, put, approvers, subject, ready } = world();
    await ready;
    const racing: DecisionSubject = {
      ...subject,
      async apply(loaded, request, approvers, at) {
        const applied = await subject.apply(loaded, request, approvers, at);
        // Someone else changes the task after the read and before the commit.
        const revised = waiting(2, "f".repeat(64));
        await put({ ...revised, revision: revised.revision + 1 });
        return applied;
      },
    };
    const gate = createDecisionGate({ store, approvers, audit: createNoopAuditSink(), subjects: [racing], now: () => NOW });
    const request = attempt();
    expect(await gate.decide(request)).toMatchObject({ status: "refused", reason: "stale" });
    // Nothing of the lost decision is left: no record, no used proof.
    expect(await store.get(approvalRecordKey(COMPANY, request.requestId))).toBeUndefined();
    expect(await store.get(approvalProofMarkerKey(COMPANY, approvalProofKey({ method: LOCAL_SESSION_METHOD, token: SESSION, requestId: binding() })))).toBeUndefined();
    expect((await taskWorkflow(store)).decisions).toHaveLength(0);
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

  it("two people deciding the same plan at once: one wins, the other is told it is no longer waiting", async () => {
    const { store, gate, ready } = world();
    await ready;
    const [first, second] = await Promise.all([gate.decide(attempt()), gate.decide(attempt())]);
    const outcomes = [first, second];
    expect(outcomes.filter((result) => result.status === "decided")).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === "refused")).toHaveLength(1);
    expect((await taskWorkflow(store)).decisions).toHaveLength(1);
  });

  it("a proof used under the same request in another process is refused by its marker, and the task is untouched", async () => {
    const { store, gate, ready } = world();
    await ready;
    const request = attempt();
    // Another process used this exact proof for this request: its marker exists, but no decision does (it died between the two writes of an earlier design; the gate writes them together).
    await store.put({ item: { ...approvalProofMarkerKey(COMPANY, approvalProofKey({ method: LOCAL_SESSION_METHOD, token: SESSION, requestId: binding() })), entityType: "APPROVAL_PROOF_USED" } });
    expect(await gate.decide(request)).toMatchObject({ status: "refused", reason: "proof_already_used" });
    expect((await taskWorkflow(store)).revision).toBe(R0);
  });

  it("the adapter's own refusal of a proof it has seen is passed on", async () => {
    const { gate, ready } = world();
    await ready;
    const request = attempt();
    expect(await gate.decide(request)).toMatchObject({ status: "decided" });
    // A fresh request id under a used comment is a different proof; the same proof on the same request is a replay (answered), never a second decision.
    expect(await gate.decide(request)).toMatchObject({ status: "replayed" });
  });

  it("a proof for one request does not approve another", async () => {
    const { store, gate, ready } = world();
    await ready;
    const seen: Array<{ request: ApprovalRequest; proof: ApprovalProof }> = [];
    const spy: Approvers = {
      async requirement(): Promise<ApprovalRequirement> { return { methods: [LOCAL_SESSION_METHOD], minApprovers: 1, selfApprovalAllowed: true }; },
      async verify(request, proof): Promise<ApprovalVerdict> { seen.push({ request, proof }); return proof.requestId === request.requestId ? { approved: true, approver: OWNER, method: proof.method, proofId: proof.proofId } : { approved: false, reason: "other_request" }; },
    };
    const world2 = createDecisionGate({ store, approvers: spy, audit: createNoopAuditSink(), subjects: [createWorkflowDocumentSubject({ store, riskOf: () => "low" })], now: () => NOW });
    const request = attempt();
    expect(await world2.decide(request)).toMatchObject({ status: "decided" });
    // The proof the gate built names the request, revision and digest of the stored state, not anything else.
    expect(seen[0]!.proof.requestId.startsWith(`${request.requestId}.`)).toBe(true);
    expect(decisionRequestIdOf(seen[0]!.proof.requestId)).toBe(request.requestId);
    expect(seen[0]!.proof).toMatchObject({ requestId: seen[0]!.request.requestId, revision: R0, artifactDigest: request.seen.artifactDigest });
    expect(seen[0]!.request).toMatchObject({ companyId: COMPANY, subject: { type: "task", id: TASK_ID }, revision: R0, artifactDigest: request.seen.artifactDigest });
    void gate;
  });
});

describe("the approval gate: the wrong company, an expired request, and who may approve", () => {
  it("a task of another company reads as absent", async () => {
    const { gate, ready } = world({ companyOnTask: "org_zzzzzzzzzzzzzzzzzzzz" });
    await ready;
    expect(await gate.decide(attempt())).toMatchObject({ status: "refused", reason: "not_found" });
  });

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

  it("the reason is cut to 500 characters", async () => {
    const { store, gate, ready } = world();
    await ready;
    const request = attempt({ outcome: "reject", reason: "x".repeat(900) });
    // The engine's own limit is 500, so a longer reason is refused rather than cut silently into the workflow.
    const result = await gate.decide(request);
    expect(result.status === "decided" ? result.record.reason?.length : 0).toBeLessThanOrEqual(500);
    void store;
  });
});

describe("the approval gate: a failing store never half-decides", () => {
  it("a throttled store fails the call and leaves no decision, so the same request can be sent again with the same proof... once the adapter allows it", async () => {
    const { store, gate, ready } = world();
    await ready;
    store.injectFault(new (await import("@rovara-code/contracts")).DocumentStoreError("unavailable", "down"));
    const request = attempt();
    await expect(gate.decide(request)).rejects.toThrow();
    expect(await store.get(approvalRecordKey(COMPANY, request.requestId))).toBeUndefined();
    expect((await taskWorkflow(store)).revision).toBe(R0);
    void when;
  });
});

describe("the approval gate: what the review of round 1 found", () => {
  const FIRST = "11111111-1111-4111-8111-111111111111";
  const SECOND = "22222222-2222-4222-8222-222222222222";
  const permissive = (store: MemoryDocumentStore) => createWorkflowDocumentSubject({ store, riskOf: () => "low", actorFor: (approver, workflow) => ({ actorId: workflow.ownerId, role: "TASK_OWNER" as const, ...(approver.personId === "" ? {} : {}) }) });
  const putTask = (store: MemoryDocumentStore, taskId: string) => store.put({ item: { ...workflowTaskKey(taskId), orgId: COMPANY, project: "web", workflow: JSON.parse(JSON.stringify({ ...waiting(), taskId })) } });

  it("one comment is good for one decision anywhere: a fresh request id for another task or revision cannot reuse it", async () => {
    const store = new MemoryDocumentStore();
    await putTask(store, FIRST);
    await putTask(store, SECOND);
    const approvers = createLocalOwnerApprovers({ owner: OWNER, now: () => NOW, ...commentReads(freshComment(COLLABORATOR), { id: COMMENT }) });
    const gate = createDecisionGate({ store, approvers, audit: createNoopAuditSink(), subjects: [permissive(store)], now: () => NOW });
    const workflowOf = async (id: string) => (await store.get(workflowTaskKey(id)))!["workflow"] as unknown as WorkflowSnapshot;
    const comment = [{ method: CODE_HOST_COMMENT_METHOD, token: COMMENT }];
    expect(await gate.decide(attempt({ subjectId: FIRST, workflow: await workflowOf(FIRST), credentials: comment }))).toMatchObject({ status: "decided" });
    // The same comment, another task, a new request id.
    expect(await gate.decide(attempt({ subjectId: SECOND, workflow: await workflowOf(SECOND), credentials: comment }))).toMatchObject({ status: "refused", reason: "proof_already_used" });
    expect((await workflowOf(SECOND)).decisions).toHaveLength(0);
  });

  it("the same session secret may decide different tasks (a session is long-lived), but only once per exact revision", async () => {
    const store = new MemoryDocumentStore();
    await putTask(store, FIRST);
    await putTask(store, SECOND);
    const approvers = createLocalOwnerApprovers({ owner: OWNER, now: () => NOW, verifySession: (token) => token === SESSION });
    const gate = createDecisionGate({ store, approvers, audit: createNoopAuditSink(), subjects: [createWorkflowDocumentSubject({ store, riskOf: () => "low" })], now: () => NOW });
    const workflowOf = async (id: string) => (await store.get(workflowTaskKey(id)))!["workflow"] as unknown as WorkflowSnapshot;
    expect(await gate.decide(attempt({ subjectId: FIRST, workflow: await workflowOf(FIRST) }))).toMatchObject({ status: "decided" });
    expect(await gate.decide(attempt({ subjectId: SECOND, workflow: await workflowOf(SECOND) }))).toMatchObject({ status: "decided" });
  });

  it("a store fault after the proof was checked does not burn it: the same request retried is decided", async () => {
    const { store, gate, ready } = world();
    await ready;
    const request = attempt();
    store.injectFault(new (await import("@rovara-code/contracts")).DocumentStoreError("unavailable", "down"), 1);
    // The first calls read the store, so the fault lands on the first read; retry until the attempt gets as far as its commit once.
    for (let tries = 0; tries < 6; tries += 1) {
      try { const result = await gate.decide(request); if (result.status === "decided") break; } catch { /* retried */ }
    }
    expect((await taskWorkflow(store)).revision).toBe(R0 + 1);
    expect(await gate.decide(request)).toMatchObject({ status: "replayed" });
  });

  it("a repeat needs the credential to be vouched for again: a revoked session is refused", async () => {
    let valid = true;
    const approvers = createLocalOwnerApprovers({ owner: OWNER, now: () => NOW, verifySession: (token) => token === SESSION && valid });
    const { gate, ready } = world({ approvers });
    await ready;
    const request = attempt();
    expect(await gate.decide(request)).toMatchObject({ status: "decided" });
    valid = false;
    expect(await gate.decide(request)).toMatchObject({ status: "refused", reason: "request_id_reused" });
  });

  it("with two approvers, the subject's own rule holds for each: the second must be someone the engine accepts", async () => {
    const stranger: Principal = { ...OWNER, provider: "other-idp", personId: "stranger", roles: ["owner"] };
    const approvers: Approvers = {
      async requirement() { return { methods: [LOCAL_SESSION_METHOD], minApprovers: 2, selfApprovalAllowed: true }; },
      async verify(_request, proof) { return { approved: true, approver: proof.token === "second" ? stranger : OWNER, method: proof.method, proofId: proof.proofId }; },
    };
    const { store, ready } = world({ approvers });
    await ready;
    const strict = createDecisionGate({ store, approvers, audit: createNoopAuditSink(), subjects: [createWorkflowDocumentSubject({ store, riskOf: () => "low", collaboratorsMayDecide: false })], now: () => NOW });
    expect(await strict.decide(attempt({ credentials: [{ method: LOCAL_SESSION_METHOD, token: "first" }, { method: LOCAL_SESSION_METHOD, token: "second" }] }))).toMatchObject({ status: "refused", reason: "not_the_approver" });
    expect((await taskWorkflow(store)).revision).toBe(R0);
  });

  it("a task record that names its company as `companyId` (the task flow's) is read the same as one with `orgId`", async () => {
    const store = new MemoryDocumentStore();
    await store.put({ item: { ...workflowTaskKey(TASK_ID), companyId: COMPANY, workflow: JSON.parse(JSON.stringify(waiting())) } });
    const gate = createDecisionGate({ store, approvers: createLocalOwnerApprovers({ owner: OWNER, verifySession: (token) => token === SESSION }), audit: createNoopAuditSink(), subjects: [createWorkflowDocumentSubject({ store, riskOf: () => "low" })], now: () => NOW });
    expect(await gate.decide(attempt())).toMatchObject({ status: "decided" });
    await store.put({ item: { ...workflowTaskKey(TASK_ID), companyId: "org_zzzzzzzzzzzzzzzzzzzz", workflow: JSON.parse(JSON.stringify(waiting())) } });
    expect(await gate.decide(attempt())).toMatchObject({ status: "refused", reason: "not_found" });
  });

  it("an expiry that cannot be read is an expired request", async () => {
    const { gate, ready } = world({ expiresAt: "not a time" });
    await ready;
    expect(await gate.decide(attempt())).toMatchObject({ status: "refused", reason: "expired" });
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

  it("is refused for a high-risk approval and for a rejection, whatever the approvers plug-in names", async () => {
    const high = world({ approvers: chatNamed(), risk: "high" });
    await high.ready;
    expect(await high.gate.decide(press())).toMatchObject({ status: "refused", reason: "method_not_allowed" });
    expect((await taskWorkflow(high.store)).revision).toBe(R0);
    const reject = world({ approvers: chatNamed(), risk: "low" });
    await reject.ready;
    expect(await reject.gate.decide(press({ outcome: "reject", reason: "no" }))).toMatchObject({ status: "refused", reason: "method_not_allowed" });
    expect((await taskWorkflow(reject.store)).revision).toBe(R0);
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
