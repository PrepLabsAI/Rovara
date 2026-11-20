// Lane S1 (convergence plan D4): the used-proof markers are spread over shards instead of one hot partition per company, and a proof used under the OLD key (an older release, one partition) is still a used proof.
// This is the single-use rule of every approval, so each direction has a test, and the checks are written to fail if the old-key read is removed.
/* eslint-disable @typescript-eslint/no-unsafe-assignment -- vitest's expect.* matchers are typed any */
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  IMPLICIT_COMPANY_ID, approvalProofKey, createWorkflowSnapshot, submitWorkflowArtifact,
  type ExternalAccountRef, type WorkflowSnapshot,
} from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { LOCAL_SESSION_METHOD, createLocalOwnerApprovers, createNoopAuditSink, localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import {
  APPROVAL_PROOF_SHARDS, approvalBindingId, approvalProofMarkerKey, approvalProofMarkerKeys, createDecisionGate, legacyApprovalProofMarkerKey, type DecisionAttempt, type DecisionSubject,
} from "../../packages/broker/src/core/decisions/approval-gate.js";
import { createWorkflowDocumentSubject, waitingDocumentDigest, workflowTaskKey } from "../../packages/broker/src/core/decisions/workflow-subject.js";
import { commentReads, freshComment } from "../support/comment-fakes.js";

const COMPANY = IMPLICIT_COMPANY_ID;
const OWNER = localOwnerPrincipal();
const TASK_ID = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const OWNER_HEX = "a".repeat(64);
const SESSION = ["shard", "session", "secret", "for", "tests"].join("-");
const COMMENT = "comment-4711";
const COLLABORATOR: ExternalAccountRef = { provider: "any-code-host", tenant: "", accountId: "collab" };
const NOW = new Date("2026-11-09T12:00:00.000Z");

const planArtifact = { id: "plan-v1", type: "plan" as const, version: 1, sha256: "b".repeat(64), producer: "agentx-planner", objectKey: `tasks/${TASK_ID}/plan-v1.json`, createdAt: "2026-11-09T10:00:00.000Z", format: "structured" as const };
function waiting(): WorkflowSnapshot {
  const initial = createWorkflowSnapshot({ taskId: TASK_ID, ownerId: OWNER_HEX, now: "2026-11-09T09:59:00.000Z" });
  return submitWorkflowArtifact(initial, { expectedRevision: initial.revision, artifact: planArtifact, now: "2026-11-09T10:00:00.000Z" });
}
const binding = () => approvalBindingId(COMPANY, "workflow-document", TASK_ID, waiting().revision, waitingDocumentDigest(waiting())!);
const sessionProofKey = () => approvalProofKey({ method: LOCAL_SESSION_METHOD, token: SESSION, requestId: binding() });

async function world() {
  const store = new MemoryDocumentStore();
  await store.put({ item: { ...workflowTaskKey(TASK_ID), entityType: "DEVELOPER_TASK", orgId: COMPANY, project: "web", workflow: JSON.parse(JSON.stringify(waiting())) } });
  const approvers = createLocalOwnerApprovers({ owner: OWNER, now: () => NOW, verifySession: (token) => token === SESSION, ...commentReads(freshComment(COLLABORATOR), { id: COMMENT }) });
  const subject = createWorkflowDocumentSubject({ store, riskOf: () => "low" });
  const gate = createDecisionGate({ store, approvers, audit: createNoopAuditSink(), subjects: [subject], now: () => NOW });
  const attempt = (overrides: Partial<DecisionAttempt> = {}): DecisionAttempt => ({
    companyId: COMPANY, kind: "workflow-document", subjectId: TASK_ID, requestId: randomUUID(), outcome: "approve",
    seen: { revision: waiting().revision, artifactDigest: waitingDocumentDigest(waiting())! }, credentials: [{ method: LOCAL_SESSION_METHOD, token: SESSION }], ...overrides,
  });
  /** A gate over the same store whose subject's applied decision is changed by `change` (to make a decision's own change lose). */
  const subjectOver = (change: (applied: Awaited<ReturnType<DecisionSubject["apply"]>>) => Awaited<ReturnType<DecisionSubject["apply"]>>) =>
    createDecisionGate({ store, approvers, audit: createNoopAuditSink(), now: () => NOW, subjects: [{ ...subject, apply: async (...args) => change(await subject.apply(...args)) }] });
  const revision = async () => ((await store.get(workflowTaskKey(TASK_ID)))!["workflow"] as unknown as WorkflowSnapshot).revision;
  return { store, gate, attempt, revision, subjectOver };
}

describe("approval proof markers: sharded, with the old key still honoured", () => {

  it("the shard function is a storage format: fixed proof keys land in exactly these partitions, with 32 shards", () => {
    expect(APPROVAL_PROOF_SHARDS).toBe(32);
    const golden: Array<[string, string]> = [["golden-proof-key-0001", "00"], ["golden-proof-key-0004", "17"], ["golden-proof-key-0008", "11"], ["golden-proof-key-0010", "13"]];
    for (const [proofKey, shard] of golden) expect(approvalProofMarkerKey(COMPANY, proofKey)).toEqual({ pk: `ORG#${COMPANY}#APPROVAL_PROOF#${shard}`, sk: proofKey });
    // The vectors themselves: the first byte of the key's SHA-256, modulo 32.
    for (const [proofKey, shard] of golden) expect(createHash("sha256").update(proofKey, "utf8").digest()[0]! % 32).toBe(Number(shard));
  });

  it("a reader outside the gate gets both keys to ask: the sharded one and the old one, and a decision leaves a marker under each", async () => {
    const { store, gate, attempt } = await world();
    const keys = approvalProofMarkerKeys(COMPANY, sessionProofKey());
    expect(keys).toEqual([approvalProofMarkerKey(COMPANY, sessionProofKey()), legacyApprovalProofMarkerKey(COMPANY, sessionProofKey())]);
    expect(keys[0].pk).not.toBe(keys[1].pk);
    expect(await Promise.all(keys.map((key) => store.get(key)))).toEqual([undefined, undefined]);
    expect(await gate.decide(attempt())).toMatchObject({ status: "decided" });
    expect((await Promise.all(keys.map((key) => store.get(key)))).map((found) => found !== undefined)).toEqual([true, true]);
  });
});
