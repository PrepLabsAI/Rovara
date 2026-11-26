import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson, when, type TransactItem, type WorkflowSnapshot } from "@agentx/contracts";
import { assertCurrentPublicationFence, currentPublicationFence, publicationFenceBinding, publicationTaskCheck, createApplicationPublicationFence } from "../../packages/broker/src/core/e2e/publication-fence.js";
import type { ApplicationTask, ApplicationE2ESeams } from "../../packages/broker/src/core/e2e/application-seams.js";
import type { E2EAuthority } from "../../packages/broker/src/core/e2e/authority.js";
import { encodeE2EApplicationExecutionAdmission } from "../../packages/verifier/src/application-scenarios.js";
import { createDocumentObjectStorage } from "../../packages/broker/src/core/proof/evidence-blob-store.js";
import { toDocument, type OperationRecord } from "../../packages/broker/src/core/task-flow/records.js";
import { workspacePartition, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { aggregateEvidenceEnvelope, createApplicationEvidenceFixture, groupEvidenceEnvelope } from "../support/e2e-application-evidence-fixture.js";
import { readTask } from "../../packages/broker/src/core/task-flow/reads.js";
import { host, ORG } from "../support/service-host.js";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const authorityKey = { pk: "AUTHORITY#live", sk: "META" };
const items: TransactItem[] = [{ kind: "check", key: authorityKey, condition: when.eq("revision", 1) }];

async function round() {
  const w = await host();
  const baseTask = (await readTask(w.h.deps, w.state.facts.taskId))!;
  const fixture = await createApplicationEvidenceFixture({ probe: "api-status-mismatch-v1", observed: { kind: "http-status", status: 503 }, taskId: baseTask.taskId });
  const { admission } = fixture;
  const store = new MemoryDocumentStore();
  const objects = createDocumentObjectStorage(store, { companyId: ORG });
  const put = async (prefix: string, bytes: Uint8Array) => {
    const digest = sha(bytes); const ref = { key: `${prefix}/sha256/${digest}.json`, sha256: digest, byteLength: bytes.byteLength };
    await objects.put(ref.key, bytes, { contentType: "application/json", metadata: {}, retention: "task-document" }); return ref;
  };
  const admissionRef = await put("workflow-e2e-admissions", Buffer.from(encodeE2EApplicationExecutionAdmission(admission)));
  const groupRef = await put("workflow-e2e-group-evidence", Buffer.from(canonicalJson(groupEvidenceEnvelope({ admission, admissionSha256: admissionRef.sha256, groupRun: fixture.groupRun }))));
  const evidenceRef = await put("workflow-e2e-evidence", Buffer.from(canonicalJson(aggregateEvidenceEnvelope({ admission, admissionSha256: admissionRef.sha256, groupRuns: [fixture.groupRun] }))));
  const workspaceId = "publication-round";
  const pk = workspacePartition(ORG, workspaceId);
  await store.put({ item: { ...workspaceKey(ORG, workspaceId), entityType: "WORKSPACE", companyId: ORG } });
  const reference = { schemaVersion: 1 as const, taskId: admission.taskId, workflowRevision: admission.workflowRevision, candidateDigest: admission.candidateDigest, roundId: admission.round.roundId, groupRunIds: [fixture.runId], admissionRef };
  const operation: OperationRecord = { pk, sk: `OPERATION#${admission.operationId}`, entityType: "OPERATION", companyId: ORG, orgId: ORG, eventSequence: 0, dispatch: { kind: "task", projectRevision: 1, payload: {} }, requestId: "11111111-1111-4111-8111-111111111111", payloadHash: "f".repeat(64), id: admission.operationId, workspaceId, fence: admission.operationFence, kind: "task", workflowMode: "CHECKS", status: "SUCCEEDED", createdAt: admission.round.admittedAt, updatedAt: new Date().toISOString(), workflowE2EAdmission: reference, workflowE2EEvidenceRef: evidenceRef, workflowE2EGroupRunIds: [fixture.runId], workflowE2EGroupEvidenceRefs: [{ groupRunId: fixture.runId, evidenceRef: groupRef }] };
  await store.put({ item: toDocument(operation) });
  await store.put({ item: { pk, sk: `WORKFLOW_E2E_UPLOAD#${operation.id}#${fixture.runId}`, entityType: "WORKFLOW_E2E_EVIDENCE_UPLOAD", status: "COMPLETE", operationId: operation.id, groupRunId: fixture.runId, fence: operation.fence, admissionSha256: admissionRef.sha256, groupEvidenceRef: { groupRunId: fixture.runId, evidenceRef: groupRef }, receivedAt: new Date().toISOString() } });
  await store.put({ item: { ...authorityKey, revision: 1 } });
  const source = admission.sourceSnapshot;
  const artifact: WorkflowSnapshot["artifacts"][number] = { id: "approved-plan", type: "plan", version: 1, producer: "planner", objectKey: "plan.json", sha256: "a".repeat(64), createdAt: admission.round.admittedAt };
  const workflow: WorkflowSnapshot = { ...baseTask.workflow!, stage: "PULL_REQUEST", state: "READY", candidate: source.candidate, artifacts: [artifact], decisions: [{ requestId: "11111111-1111-4111-8111-111111111111", workflowRevision: 1, actorId: "owner", actorRole: "TASK_OWNER", decision: "APPROVE", reason: "Approved", artifactDigest: artifact.sha256, at: artifact.createdAt }], e2e: { required: true, contractDigest: artifact.sha256, policyDigest: "b".repeat(64), bundleDigest: "c".repeat(64), executionPlanDigest: "d".repeat(64), currentRoundId: reference.roundId, currentGroupRunIds: reference.groupRunIds, resultRefs: [], qualifiedRound: { candidateDigest: admission.candidateDigest, contractDigest: artifact.sha256, policyDigest: "b".repeat(64), bundleDigest: "c".repeat(64), executionPlanDigest: "d".repeat(64), roundId: reference.roundId, groupRunIds: reference.groupRunIds, admissionSha256: admissionRef.sha256, evidenceSha256: evidenceRef.sha256 } } };
  const task: ApplicationTask = { ...baseTask, companyId: ORG, taskId: baseTask.taskId, workspaceId, workflow };
  const authority: E2EAuthority = { portable: async () => false, application: async (_input, diagnostic) => { if (diagnostic !== undefined) diagnostic.authorityChecks = items; return true; } };
  const deps = { companyId: ORG, store, e2e: { state: { store }, objects, authority, readTask: async () => task } };
  const publication: ApplicationE2ESeams["publication"] = createApplicationPublicationFence(deps);
  return { deps, task, operation, objects, store, publication, fixture };
}

describe("publication re-verifies current immutable E2E evidence", () => {
  it("returns COMMITTED_HEAD and transaction conditions for genuine passing stored evidence", async () => {
    const r = await round(); const result = await r.publication(r.task);
    expect(result?.mode).toBe("COMMITTED_HEAD"); expect(result?.items).toContainEqual(items[0]);
    expect((await r.store.transact(result!.items)).applied).toBe(true);
    await r.store.put({ item: { ...authorityKey, revision: 2 } });
    expect((await r.store.transact(result!.items)).applied).toBe(false);
  });
  for (const missing of ["verification", "operation", "evidence", "qualified", "approval", "authority", "conditions", "candidate", "round", "baseline"] as const) it(`refuses ${missing} despite a cached qualification`, async () => {
    const r = await round();
    if (missing === "verification") delete (r.deps as { e2e?: unknown }).e2e;
    if (missing === "operation") await r.store.delete({ key: r.operation });
    if (missing === "evidence") await r.objects.delete(r.operation.workflowE2EEvidenceRef!.key);
    if (missing === "qualified") delete r.task.workflow.e2e!.qualifiedRound;
    if (missing === "approval") r.task.workflow.decisions = [];
    if (missing === "authority") r.deps.e2e.authority.application = async () => false;
    if (missing === "conditions") r.deps.e2e.authority.application = async () => true;
    if (missing === "candidate") r.task.workflow.candidate = { ...r.task.workflow.candidate!, digest: "f".repeat(64) };
    if (missing === "round") r.task.workflow.e2e!.currentRoundId = "11111111-1111-4111-8111-111111111111";
    if (missing === "baseline") await r.store.put({ item: toDocument({ ...r.operation, workflowE2EAdmission: { ...r.operation.workflowE2EAdmission!, purpose: "baseline" } }) });
    expect(await r.publication(r.task)).toBeUndefined();
  });
  it("returns CHECKED_TREE for a task with no required E2E obligation", async () => {
    const r = await round(); delete r.task.workflow.e2e;
    expect(await r.publication(r.task)).toEqual({ mode: "CHECKED_TREE", items: [] });
  });
});

function publicationPorts(publication: ApplicationE2ESeams["publication"]): ApplicationE2ESeams {
  const unused = async (): Promise<never> => { throw new Error("unexpected application port"); };
  const store = new MemoryDocumentStore();
  return { publication, planning: { context: unused, approve: unused }, results: { read: unused, project: unused, artifact: unused, notice: unused },
    rounds: { selection: unused, runRow: unused, retry: unused, records: { task: unused, baseline: unused },
      verification: { state: { store }, objects: createDocumentObjectStorage(store, { companyId: ORG }), authority: { application: unused, portable: unused }, readTask: unused } } };
}

// A publication's live authority and exact task must survive until its recording write.
describe("publication binding and recording fences", () => {
  for (const invalid of ["closed", "company"] as const) it(`refuses ${invalid} before consulting publication authority`, async () => {
    const r = await round();
    if (invalid === "closed") r.task.closedAt = new Date().toISOString();
    else r.task.companyId = "another-company";
    let reads = 0;
    const applicationE2E = publicationPorts(async () => { reads++; return { mode: "COMMITTED_HEAD", items }; });
    expect(await r.publication(r.task)).toBeUndefined();
    expect(await currentPublicationFence({ companyId: ORG, applicationE2E }, r.task)).toBeUndefined();
    expect(reads).toBe(0);
  });
  it("keeps ordinary checked-tree publication independent of an application verifier", async () => {
    const r = await round(); delete r.task.workflow.e2e;
    const deps = { companyId: ORG, applicationE2E: publicationPorts(async () => { throw new Error("ordinary publication must not read application authority"); }) };
    expect(await currentPublicationFence(deps, r.task)).toEqual({ mode: "CHECKED_TREE", items: [] });
    const binding = publicationFenceBinding(r.task, { mode: "CHECKED_TREE", items: [] }, "absent");
    expect(binding).toEqual({ publicationMode: "CHECKED_TREE" });
    expect(await assertCurrentPublicationFence(deps, r.task, binding, "absent")).toEqual([]);
    for (const stale of [{ expectedCommitSha: "a".repeat(40) }, { admittedE2EAuthorityDigest: "b".repeat(64) }]) {
      await expect(assertCurrentPublicationFence(deps, r.task, { ...binding, ...stale }, "absent")).rejects.toMatchObject({ code: "STALE_FENCE" });
    }
  });
  it("binds the exact committed head and rejects missing repositories and changed publication inputs", async () => {
    const r = await round();
    const fence = { mode: "COMMITTED_HEAD" as const, items };
    const deps = { companyId: ORG, applicationE2E: publicationPorts(async () => fence) };
    const repositoryId = r.task.workflow.candidate!.repositories[0]!.repositoryId;
    const binding = publicationFenceBinding(r.task, fence, repositoryId);
    expect(binding.expectedCommitSha).toBe(r.task.workflow.candidate!.repositories[0]!.commitSha);
    expect(binding.admittedE2EAuthorityDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(() => publicationFenceBinding(r.task, fence, "missing")).toThrow(/candidate is missing/u);
    expect(await assertCurrentPublicationFence(deps, r.task, binding, repositoryId, binding.expectedCommitSha)).toEqual(items);
    for (const stale of [{ publicationMode: "CHECKED_TREE" as const }, { expectedCommitSha: "e".repeat(40) }, { admittedE2EAuthorityDigest: "e".repeat(64) }]) {
      await expect(assertCurrentPublicationFence(deps, r.task, { ...binding, ...stale }, repositoryId)).rejects.toMatchObject({ code: "STALE_FENCE" });
    }
    await expect(assertCurrentPublicationFence(deps, r.task, binding, repositoryId, "e".repeat(40))).rejects.toMatchObject({ code: "STALE_FENCE" });
    await expect(assertCurrentPublicationFence({ companyId: ORG }, r.task, binding, repositoryId)).rejects.toMatchObject({ code: "STALE_FENCE" });
    await expect(assertCurrentPublicationFence(deps, r.task, {}, repositoryId)).rejects.toMatchObject({ code: "STALE_FENCE" });
  });
  for (const field of ["closedAt", "companyId", "workflow"] as const) it(`holds ${field} in the recording transaction`, async () => {
    const r = await round(); const check = publicationTaskCheck(r.task);
    await r.store.put({ item: toDocument(r.task) });
    expect(await r.store.transact([check])).toEqual({ applied: true });
    const changed = field === "workflow" ? { ...r.task, workflow: { ...r.task.workflow, revision: r.task.workflow.revision + 1 } }
      : { ...r.task, [field]: field === "closedAt" ? new Date().toISOString() : "another-company" };
    await r.store.put({ item: toDocument(changed) });
    const marker = { pk: "PUBLICATION", sk: "recorded" };
    expect(await r.store.transact([check, { kind: "put", item: marker }])).toMatchObject({ applied: false });
    expect(await r.store.get(marker)).toBeUndefined();
  });
  for (const field of ["status", "fence", "workflowE2EAdmission", "workflowE2EEvidenceRef"] as const) it(`holds qualified operation ${field} beside the publication write`, async () => {
    const r = await round(); const fence = await r.publication(r.task);
    expect(fence?.mode).toBe("COMMITTED_HEAD");
    const changed = { ...r.operation, [field]: field === "status" ? "FAILED" : field === "fence" ? r.operation.fence + 1 : undefined };
    await r.store.put({ item: toDocument(changed) });
    expect(await r.store.transact(fence!.items)).toMatchObject({ applied: false });
  });
});
