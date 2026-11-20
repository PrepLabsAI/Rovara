/* eslint-disable @typescript-eslint/no-unsafe-assignment -- vitest's expect.* matchers are typed any */
// Lane L6b + L8: the local pages' approval proofs through the registry's Approvers and the approval gate. A proof the pages sign for request A at revision R cannot approve request B or revision R+1; the raw
// page-session secret and the owner's sign-in secret are never approval proofs; and the default wiring without a proof verifier offers no local-session method at all.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, createWorkflowSnapshot, submitWorkflowArtifact, type WorkflowSnapshot } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createAdapterRegistry } from "../../packages/broker/src/ports/adapter-registry.js";
import { LOCAL_SESSION_METHOD, createNoopAuditSink, registerCodeDefaults } from "../../packages/broker/src/ports/policy-defaults.js";
import { LocalPageSessions } from "../../packages/broker/src/core/local-pages/guard.js";
import { createDecisionGate } from "../../packages/broker/src/core/decisions/approval-gate.js";
import { createDecisionActions } from "../../packages/broker/src/core/decisions/local-actions.js";
import { localSessionProofVerifier } from "../../packages/broker/src/core/decisions/local-session.js";
import { createWorkflowDocumentSubject, waitingDocumentDigest, workflowTaskKey } from "../../packages/broker/src/core/decisions/workflow-subject.js";

const COMPANY = IMPLICIT_COMPANY_ID;
const TASK_A = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const TASK_B = "9c68ac5c-fb98-4cf3-98cd-7ec97da97dc7";
const SIGN_IN_SECRET = ["owner", "sign", "in", "secret", "for", "tests"].join("-");

function waiting(taskId: string): WorkflowSnapshot {
  const initial = createWorkflowSnapshot({ taskId, ownerId: "a".repeat(64), now: "2026-11-09T09:59:00.000Z" });
  return submitWorkflowArtifact(initial, {
    expectedRevision: initial.revision, now: "2026-11-09T10:00:00.000Z",
    artifact: { id: "plan-v1", type: "plan", version: 1, sha256: taskId.startsWith("8") ? "b".repeat(64) : "c".repeat(64), producer: "agentx-planner", objectKey: `tasks/${taskId}/plan-v1.json`, createdAt: "2026-11-09T10:00:00.000Z", format: "structured" },
  });
}

async function world(options: { wired?: boolean } = {}) {
  const store = new MemoryDocumentStore();
  for (const taskId of [TASK_A, TASK_B]) await store.put({ item: { ...workflowTaskKey(taskId), orgId: COMPANY, project: "web", workflow: JSON.parse(JSON.stringify(waiting(taskId))) } });
  const sessions = new LocalPageSessions();
  const registry = createAdapterRegistry();
  registerCodeDefaults(registry, {
    isValidSession: (value) => value === SIGN_IN_SECRET, priceTable: { currency: "USD", models: {} },
    ...(options.wired === false ? {} : { approvers: { verifySession: localSessionProofVerifier(sessions) } }),
  });
  registry.seal();
  const gate = createDecisionGate({ store, approvers: registry.require("approvers"), audit: createNoopAuditSink(), subjects: [createWorkflowDocumentSubject({ store, riskOf: () => "low" })] });
  const actions = createDecisionActions({ gate, companyId: COMPANY });
  const minted = sessions.mint({ label: "owner" });
  const owner = { id: minted.session.id, token: minted.token };
  const offer = (taskId: string, requestId: string = randomUUID(), revision?: number): ApprovalOffer => ({ requestId, revision: revision ?? waiting(taskId).revision, artifactDigest: waitingDocumentDigest(waiting(taskId))!, kind: "plan" });
  const proofFor = (approval: ApprovalOffer, token?: string) => ({
    proofId: randomUUID(), method: LOCAL_SESSION_METHOD, requestId: approval.requestId, revision: approval.revision, artifactDigest: approval.artifactDigest,
    token: token ?? sessions.issueProof(owner.id, { requestId: approval.requestId, revision: approval.revision, artifactDigest: approval.artifactDigest }),
  });
  const stage = async (taskId: string) => ((await store.get(workflowTaskKey(taskId)))!["workflow"] as unknown as WorkflowSnapshot).stage;
  return { store, sessions, registry, gate, actions, owner, offer, proofFor, stage };
}

type ApprovalOffer = Parameters<ReturnType<typeof createDecisionActions>["decidePlan"]>[0]["approval"];

describe("the local pages' proofs through the registry's approvers and the gate", () => {

  it("the raw page-session secret and the owner's sign-in secret are refused as approval proofs", async () => {
    const w = await world();
    const approval = w.offer(TASK_A);
    expect(await w.actions.decidePlan({ taskId: TASK_A, decision: "approve", approval, proof: w.proofFor(approval, w.owner.token) })).toMatchObject({ ok: false, reason: "refused" });
    expect(await w.actions.decidePlan({ taskId: TASK_A, decision: "approve", approval, proof: w.proofFor(approval, SIGN_IN_SECRET) })).toMatchObject({ ok: false, reason: "refused" });
    expect(await w.stage(TASK_A)).toBe("PLAN_REVIEW");
  });

  it("a proof from another page-session store, a tampered proof and a proof of an ended session are refused", async () => {
    const w = await world();
    const approval = w.offer(TASK_A);
    const stranger = new LocalPageSessions();
    const strangerOwner = stranger.mint({ label: "owner" }).session;
    const foreign = stranger.issueProof(strangerOwner.id, { requestId: approval.requestId, revision: approval.revision, artifactDigest: approval.artifactDigest });
    expect(await w.actions.decidePlan({ taskId: TASK_A, decision: "approve", approval, proof: w.proofFor(approval, foreign) })).toMatchObject({ ok: false });
    const good = w.proofFor(approval).token;
    expect(await w.actions.decidePlan({ taskId: TASK_A, decision: "approve", approval, proof: w.proofFor(approval, `${good.slice(0, -2)}xx`) })).toMatchObject({ ok: false });
    w.sessions.revokeAll();
    expect(await w.actions.decidePlan({ taskId: TASK_A, decision: "approve", approval, proof: w.proofFor(approval, good) })).toMatchObject({ ok: false });
    expect(await w.stage(TASK_A)).toBe("PLAN_REVIEW");
  });

  it("the default wiring with no proof verifier offers no local-session method: the sign-in secret does not become one", async () => {
    const w = await world({ wired: false });
    const approval = w.offer(TASK_A);
    expect(await w.registry.require("approvers").requirement({ companyId: COMPANY, requestId: "x", kind: "plan", subject: { type: "task", id: TASK_A }, revision: 1, artifactDigest: "a".repeat(64) })).toMatchObject({ methods: [] });
    expect(await w.actions.decidePlan({ taskId: TASK_A, decision: "approve", approval, proof: w.proofFor(approval, SIGN_IN_SECRET) })).toMatchObject({ ok: false });
    expect(await w.actions.decidePlan({ taskId: TASK_A, decision: "approve", approval, proof: w.proofFor(approval) })).toMatchObject({ ok: false });
    expect(await w.stage(TASK_A)).toBe("PLAN_REVIEW");
  });

  it("the page's proof must match the offer it came with, and a change needs words", async () => {
    const w = await world();
    const approval = w.offer(TASK_A);
    expect(await w.actions.decidePlan({ taskId: TASK_A, decision: "approve", approval, proof: { ...w.proofFor(approval), revision: approval.revision + 1 } })).toMatchObject({ ok: false, reason: "invalid" });
    expect(await w.actions.decidePlan({ taskId: TASK_A, decision: "changes", approval, proof: w.proofFor(approval) })).toMatchObject({ ok: false, reason: "invalid" });
    expect(await w.actions.decidePlan({ taskId: TASK_A, decision: "changes", note: "Use the other table.", approval, proof: w.proofFor(approval) })).toMatchObject({ ok: true });
    expect(await w.stage(TASK_A)).toBe("PLAN");
  });

  it("a repeat of the same page decision is a success, and a second click of another request is not", async () => {
    const w = await world();
    const approval = w.offer(TASK_A);
    const proof = w.proofFor(approval);
    expect(await w.actions.decidePlan({ taskId: TASK_A, decision: "approve", approval, proof })).toMatchObject({ ok: true });
    expect(await w.actions.decidePlan({ taskId: TASK_A, decision: "approve", approval, proof })).toMatchObject({ ok: true });
    const again = w.offer(TASK_A, randomUUID(), approval.revision);
    expect(await w.actions.decidePlan({ taskId: TASK_A, decision: "approve", approval: again, proof: w.proofFor(again) })).toMatchObject({ ok: false });
  });
});
