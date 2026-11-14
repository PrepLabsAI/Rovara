// Lane S1 (convergence plan D4): the used-proof markers are spread over shards instead of one hot partition per company, and a proof used under the OLD key (an older release, one partition) is still a used proof.
// This is the single-use rule of every approval, so each direction has a test, and the checks are written to fail if the old-key read is removed.
/* eslint-disable @typescript-eslint/no-unsafe-assignment -- vitest's expect.* matchers are typed any */
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  IMPLICIT_COMPANY_ID, INDEX_EXPIRY_ATTRIBUTE, approvalProofKey, createWorkflowSnapshot, submitWorkflowArtifact, when,
  type ExternalAccountRef, type WorkflowSnapshot,
} from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { CODE_HOST_COMMENT_METHOD, LOCAL_SESSION_METHOD, createLocalOwnerApprovers, createNoopAuditSink, localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
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
  it("a new marker is written in one of the shard partitions AND under the old key (expand step), both carrying the expiry and the same facts an older release reads", async () => {
    const { store, gate, attempt } = await world();
    expect(await gate.decide(attempt())).toMatchObject({ status: "decided" });
    const marker = await store.get(approvalProofMarkerKey(COMPANY, sessionProofKey()));
    expect(marker).toMatchObject({ entityType: "APPROVAL_PROOF_USED", method: LOCAL_SESSION_METHOD });
    expect(typeof marker![INDEX_EXPIRY_ATTRIBUTE]).toBe("number");
    expect(marker!["pk"]).toMatch(/#APPROVAL_PROOF#\d\d$/u);
    // An older release replays a decision by reading the old key and comparing `requestId`: the old-key marker must be what it always wrote.
    const old = await store.get(legacyApprovalProofMarkerKey(COMPANY, sessionProofKey()));
    expect(old).toMatchObject({ entityType: "APPROVAL_PROOF_USED", method: LOCAL_SESSION_METHOD, requestId: expect.any(String) });
    expect(old!["requestId"]).toBe(marker!["requestId"]);
    expect(old![INDEX_EXPIRY_ATTRIBUTE]).toBe(marker![INDEX_EXPIRY_ATTRIBUTE]);
    expect(old!["pk"]).toMatch(/#APPROVAL_PROOF$/u);
  });

  it("an older release's own single-use put (old key, only if absent) is refused after a decision made here, so old and new code block each other", async () => {
    const { store, gate, attempt } = await world();
    expect(await gate.decide(attempt())).toMatchObject({ status: "decided" });
    const older = await store.put({ item: { ...legacyApprovalProofMarkerKey(COMPANY, sessionProofKey()), entityType: "APPROVAL_PROOF_USED" }, condition: when.absent() });
    expect(older.applied).toBe(false);
  });

  it("the shard function is a storage format: fixed proof keys land in exactly these partitions, with 32 shards", () => {
    expect(APPROVAL_PROOF_SHARDS).toBe(32);
    const golden: Array<[string, string]> = [["golden-proof-key-0001", "00"], ["golden-proof-key-0004", "17"], ["golden-proof-key-0008", "11"], ["golden-proof-key-0010", "13"]];
    for (const [proofKey, shard] of golden) expect(approvalProofMarkerKey(COMPANY, proofKey)).toEqual({ pk: `ORG#${COMPANY}#APPROVAL_PROOF#${shard}`, sk: proofKey });
    // The vectors themselves: the first byte of the key's SHA-256, modulo 32.
    for (const [proofKey, shard] of golden) expect(createHash("sha256").update(proofKey, "utf8").digest()[0]! % 32).toBe(Number(shard));
  });

  it("a decision whose own change loses (an extra step fails) is not reported as a used proof, and leaves no marker under either key", async () => {
    const { store, gate, attempt, revision, subjectOver } = await world();
    const blocker = { pk: "BLOCKER", sk: "ROW" };
    await store.put({ item: { ...blocker, entityType: "BLOCKER" } });
    const gate2 = subjectOver((applied) => ({ ...applied, extra: [{ kind: "check", key: blocker, condition: when.absent() }] }));
    const before = await revision();
    const result = await gate2.decide(attempt());
    expect(result).toMatchObject({ status: "refused" });
    expect((result as { reason: string }).reason).not.toBe("proof_already_used");
    expect(await revision()).toBe(before);
    for (const key of approvalProofMarkerKeys(COMPANY, sessionProofKey())) expect(await store.get(key)).toBeUndefined();
    expect(gate).toBeDefined();
  });

  it("the session secret is in no marker of any partition, new or old", async () => {
    const { store, gate, attempt } = await world();
    expect(await gate.decide(attempt())).toMatchObject({ status: "decided" });
    const partitions = [legacyApprovalProofMarkerKey(COMPANY, "x").pk, ...Array.from({ length: APPROVAL_PROOF_SHARDS }, (_, index) => approvalProofMarkerKey(COMPANY, "x").pk.replace(/#\d\d$/u, `#${String(index).padStart(2, "0")}`))];
    const found = (await Promise.all(partitions.map(async (pk) => (await store.query({ pk })).items))).flat();
    expect(found).toHaveLength(2);
    expect(JSON.stringify(found)).not.toContain(SESSION);
  });

  it("markers of different requests spread over many shards (no hot key), and one proof always lands in the same shard", () => {
    const shards = new Set<string>();
    for (let index = 0; index < 400; index += 1) shards.add(approvalProofMarkerKey(COMPANY, approvalProofKey({ method: LOCAL_SESSION_METHOD, token: SESSION, requestId: `bind_${String(index)}` })).pk);
    expect(shards.size).toBeGreaterThan(APPROVAL_PROOF_SHARDS * 0.8);
    expect(shards.size).toBeLessThanOrEqual(APPROVAL_PROOF_SHARDS);
    expect(approvalProofMarkerKey(COMPANY, sessionProofKey())).toEqual(approvalProofMarkerKey(COMPANY, sessionProofKey()));
    expect(approvalProofMarkerKey("other-company", sessionProofKey()).pk).not.toBe(approvalProofMarkerKey(COMPANY, sessionProofKey()).pk);
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
    // Take the old-key marker away: the refusal then comes from the new key alone.
    await store.delete({ key: legacyApprovalProofMarkerKey(COMPANY, sessionProofKey()) });
    expect(await gate.decide(attempt())).toMatchObject({ status: "refused" });
    expect(await revision()).toBe(after);
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
