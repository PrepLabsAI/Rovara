// Lane S1 (convergence plan D4): the used-proof markers are spread over shards instead of one hot partition per company, and a proof used under the OLD key (an older release, one partition) is still a used proof.
// This is the single-use rule of every approval, so each direction has a test, and the checks are written to fail if the old-key read is removed.
/* eslint-disable @typescript-eslint/no-unsafe-assignment -- vitest's expect.* matchers are typed any */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  IMPLICIT_COMPANY_ID, INDEX_EXPIRY_ATTRIBUTE, approvalProofKey, createWorkflowSnapshot, submitWorkflowArtifact,
  type ExternalAccountRef, type WorkflowSnapshot,
} from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { CODE_HOST_COMMENT_METHOD, LOCAL_SESSION_METHOD, createLocalOwnerApprovers, createNoopAuditSink, localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import {
  APPROVAL_PROOF_SHARDS, approvalBindingId, approvalProofMarkerKey, approvalProofMarkerKeys, createDecisionGate, legacyApprovalProofMarkerKey, type DecisionAttempt,
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
  const revision = async () => ((await store.get(workflowTaskKey(TASK_ID)))!["workflow"] as unknown as WorkflowSnapshot).revision;
  return { store, gate, attempt, revision };
}

describe("approval proof markers: sharded, with the old key still honoured", () => {
  it("a new marker is written in one of the shard partitions, never in the old single partition, and carries its expiry", async () => {
    const { store, gate, attempt } = await world();
    expect(await gate.decide(attempt())).toMatchObject({ status: "decided" });
    const marker = await store.get(approvalProofMarkerKey(COMPANY, sessionProofKey()));
    expect(marker).toMatchObject({ entityType: "APPROVAL_PROOF_USED", method: LOCAL_SESSION_METHOD });
    expect(typeof marker![INDEX_EXPIRY_ATTRIBUTE]).toBe("number");
    expect(marker!["pk"]).toMatch(/#APPROVAL_PROOF#\d\d$/u);
    expect(await store.get(legacyApprovalProofMarkerKey(COMPANY, sessionProofKey()))).toBeUndefined();
    expect((await store.query({ pk: legacyApprovalProofMarkerKey(COMPANY, "x").pk })).items).toHaveLength(0);
  });

  it("markers of different requests spread over many shards (no hot key), and one proof always lands in the same shard", () => {
    const shards = new Set<string>();
    for (let index = 0; index < 400; index += 1) shards.add(approvalProofMarkerKey(COMPANY, approvalProofKey({ method: LOCAL_SESSION_METHOD, token: SESSION, requestId: `bind_${String(index)}` })).pk);
    expect(shards.size).toBeGreaterThan(APPROVAL_PROOF_SHARDS * 0.8);
    expect(shards.size).toBeLessThanOrEqual(APPROVAL_PROOF_SHARDS);
    expect(approvalProofMarkerKey(COMPANY, sessionProofKey())).toEqual(approvalProofMarkerKey(COMPANY, sessionProofKey()));
    expect(approvalProofMarkerKey("other-company", sessionProofKey()).pk).not.toBe(approvalProofMarkerKey(COMPANY, sessionProofKey()).pk);
  });

  it("a reader outside the gate gets both keys to ask: the sharded one and the old one, and whichever holds the marker answers", async () => {
    const { store, gate, attempt } = await world();
    const keys = approvalProofMarkerKeys(COMPANY, sessionProofKey());
    expect(keys).toEqual([approvalProofMarkerKey(COMPANY, sessionProofKey()), legacyApprovalProofMarkerKey(COMPANY, sessionProofKey())]);
    expect(keys[0].pk).not.toBe(keys[1].pk);
    expect(await Promise.all(keys.map((key) => store.get(key)))).toEqual([undefined, undefined]);
    expect(await gate.decide(attempt())).toMatchObject({ status: "decided" });
    expect((await Promise.all(keys.map((key) => store.get(key)))).map((found) => found !== undefined)).toEqual([true, false]);
  });

  it("a proof an older release used under the OLD key cannot be used again: the decision is refused and the task is untouched", async () => {
    const { store, gate, attempt, revision } = await world();
    const before = await revision();
    await store.put({ item: { ...legacyApprovalProofMarkerKey(COMPANY, sessionProofKey()), entityType: "APPROVAL_PROOF_USED", requestId: "an-older-request", [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(NOW.getTime() / 1000) + 1000 } });
    expect(await gate.decide(attempt())).toMatchObject({ status: "refused", reason: "proof_already_used" });
    expect(await revision()).toBe(before);
  });

  it("a one-decision comment spent under the OLD key is spent for every request", async () => {
    const { store, gate, attempt } = await world();
    const spent = approvalProofKey({ method: CODE_HOST_COMMENT_METHOD, token: COMMENT, requestId: "*" });
    await store.put({ item: { ...legacyApprovalProofMarkerKey(COMPANY, spent), entityType: "APPROVAL_PROOF_SPENT", requestId: "an-older-request" } });
    expect(await gate.decide(attempt({ credentials: [{ method: CODE_HOST_COMMENT_METHOD, token: COMMENT, claimedAccount: COLLABORATOR }] }))).toMatchObject({ status: "refused", reason: "proof_already_used" });
  });

  it("a proof used under the NEW key cannot be used again, and a second request id does not get past it", async () => {
    const { store, gate, attempt, revision } = await world();
    expect(await gate.decide(attempt())).toMatchObject({ status: "decided" });
    const after = await revision();
    expect(await gate.decide(attempt())).toMatchObject({ status: "refused" });
    expect(await revision()).toBe(after);
    // The marker is under the new key only; the other way round (an older release's key) is empty, so the refusal above came from the new key.
    expect(await store.get(legacyApprovalProofMarkerKey(COMPANY, sessionProofKey()))).toBeUndefined();
    expect(await store.get(approvalProofMarkerKey(COMPANY, sessionProofKey()))).toBeDefined();
  });

  it("a fresh proof works, and the decision an older release made under the old key is still replayed to its holder", async () => {
    const { store, gate, attempt } = await world();
    const request = attempt();
    expect(await gate.decide(request)).toMatchObject({ status: "decided" });
    // Move the marker to where the older release would have put it: the repeat is still recognised.
    const key = approvalProofMarkerKey(COMPANY, sessionProofKey());
    const marker = (await store.get(key))!;
    await store.delete({ key });
    await store.put({ item: { ...marker, ...legacyApprovalProofMarkerKey(COMPANY, sessionProofKey()) } });
    expect(await gate.decide(request)).toMatchObject({ status: "replayed" });
  });
});
