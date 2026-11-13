// The verification of a finished browser and API round on the document store and object storage: the evidence is read back from where the broker stored it, held to its content address,
// recollected by the broker alone, and judged against the install's current authority. A round whose authority cannot be shown is UNKNOWN, never a pass.
// Runs on the pinned Node (22.23.2), like every suite built on the application evidence fixture, which signs the toolchain version into the evidence: run it with `vt`, not under another patch version.
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, type DocumentStore, type E2EWorkflowAdmissionRef } from "@rovara-code/contracts";
import type { OperationRecord } from "../../packages/core/src/core/task-flow/records.js";
import { MemoryDocumentStore } from "../../packages/core/src/ports/memory-document-store.js";
import { createDocumentObjectStorage } from "../../packages/core/src/core/proof/evidence-blob-store.js";
import { failClosedAuthority, type E2EAuthority } from "../../packages/core/src/core/e2e/authority.js";
import { loadApplicationEvidenceInputs, settleBaselineRound, verifyWorkflowE2EEvidence, type E2EVerificationDiagnostic } from "../../packages/core/src/core/e2e/verification.js";
import { markWorkflowE2EBaselineUnavailable, readWorkflowE2EBaselineRecord, requestWorkflowE2EBaselineRound } from "../../packages/core/src/core/e2e/baseline.js";
import { encodeE2EApplicationExecutionAdmission } from "../../packages/verifier/src/application-scenarios.js";
import { aggregateEvidenceEnvelope, createApplicationEvidenceFixture, groupEvidenceEnvelope, type ApplicationEvidenceFixture } from "../support/e2e-application-evidence-fixture.js";
import { disposeRealCandidates } from "../support/e2e-application-candidate.js";

const COMPANY = "org_00000000000000000000";
const WORKSPACE = "ws-verify-1";
const PASSING = { probe: "api-status-mismatch-v1", observed: { kind: "http-status", status: 503 } } as const;
const FAILING = { probe: "api-status-mismatch-v1", observed: { kind: "http-status", status: 200 } } as const;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const textOf = (value: unknown) => Buffer.from(canonicalJson(value), "utf8");

afterEach(() => disposeRealCandidates());

type Authority = E2EAuthority;
const allowing: Authority = {
  portable: async () => false,
  async application(_input, diagnostic) {
    if (diagnostic !== undefined) { diagnostic.authorityEvaluated = true; diagnostic.authorityChecks = [{ kind: "check", key: { pk: "A", sk: "B" }, condition: { op: "exists", path: ["pk"] } }]; }
    return true;
  },
};

async function roundOf(options: Parameters<typeof createApplicationEvidenceFixture>[0], tweak: { dropReceipt?: boolean; groupBytes?: (bytes: Buffer) => Buffer; skipAggregate?: boolean } = {}) {
  const fixture: ApplicationEvidenceFixture = await createApplicationEvidenceFixture(options);
  const { admission } = fixture;
  const admissionBytes = Buffer.from(encodeE2EApplicationExecutionAdmission(admission), "utf8");
  const admissionSha256 = sha(admissionBytes);
  const runIds = admission.groups.map((group) => group.outerBinding.runId);
  const store: DocumentStore = new MemoryDocumentStore();
  const objects = createDocumentObjectStorage(store, { companyId: COMPANY });
  const groupBytes = textOf(groupEvidenceEnvelope({ admission, admissionSha256, groupRun: fixture.groupRun }));
  const storedGroupBytes = tweak.groupBytes === undefined ? groupBytes : tweak.groupBytes(groupBytes);
  const aggregateBytes = textOf(aggregateEvidenceEnvelope({ admission, admissionSha256, groupRuns: [fixture.groupRun] }));
  const meta = { contentType: "application/json", metadata: {}, retention: "task-document" };
  const admissionRef = { key: `workflow-e2e-admissions/sha256/${admissionSha256}.json`, sha256: admissionSha256, byteLength: admissionBytes.byteLength };
  const groupRef = { key: `workflow-e2e-group-evidence/sha256/${sha(groupBytes)}.json`, sha256: sha(groupBytes), byteLength: groupBytes.byteLength };
  const aggregateRef = { key: `workflow-e2e-evidence/sha256/${sha(aggregateBytes)}.json`, sha256: sha(aggregateBytes), byteLength: aggregateBytes.byteLength };
  await objects.put(admissionRef.key, admissionBytes, meta);
  await objects.put(groupRef.key, storedGroupBytes, meta);
  await objects.put(aggregateRef.key, aggregateBytes, meta);
  const reference: E2EWorkflowAdmissionRef = { schemaVersion: 1, taskId: admission.taskId, workflowRevision: admission.workflowRevision, candidateDigest: admission.candidateDigest, roundId: admission.round.roundId,
    groupRunIds: runIds, admissionRef };
  const operation = { id: admission.operationId, workspaceId: WORKSPACE, fence: admission.operationFence, kind: "task", workflowMode: "CHECKS", status: "SUCCEEDED", updatedAt: "2026-11-10T10:00:00.000Z",
    workflowE2EAdmission: reference,
    ...(tweak.skipAggregate === true ? {} : { workflowE2EEvidenceRef: aggregateRef }),
    workflowE2EGroupEvidenceRefs: [{ groupRunId: fixture.runId, evidenceRef: groupRef }], workflowE2EGroupRunIds: [fixture.runId] } as unknown as OperationRecord;
  if (tweak.dropReceipt !== true) {
    await store.put({ item: { pk: `WORKSPACE#${WORKSPACE}`, sk: `WORKFLOW_E2E_UPLOAD#${admission.operationId}#${fixture.runId}`, entityType: "WORKFLOW_E2E_EVIDENCE_UPLOAD", status: "COMPLETE", operationId: admission.operationId,
      groupRunId: fixture.runId, fence: admission.operationFence, admissionSha256, groupEvidenceRef: { groupRunId: fixture.runId, evidenceRef: groupRef },
      receivedAt: ((fixture.groupRun.actual as { collection: { receivedAt: string } }).collection.receivedAt) } });
  }
  const task = { taskId: admission.taskId, workspaceId: WORKSPACE, workflow: { e2e: { required: true, currentRoundId: admission.round.roundId, currentGroupRunIds: runIds } } } as never;
  const candidate = { digest: admission.candidateDigest } as never;
  const deps = (authority: Authority) => ({ state: { store }, objects, authority, readTask: async () => task });
  return { fixture, operation, reference, task, candidate, deps, store, objects, admission, admissionRef };
}

describe("verifying a round from its stored evidence", () => {
  it("passes a round the broker re-collects as passing, with the authority's rows as the conditions to commit with", async () => {
    const round = await roundOf(PASSING);
    const diagnostic: E2EVerificationDiagnostic = {};
    const verdict = await verifyWorkflowE2EEvidence(round.deps(allowing), round.operation, round.task, round.candidate, undefined, diagnostic, { terminalStatus: "SUCCEEDED" });
    expect(diagnostic.reason).toBeUndefined();
    expect(verdict).toBe("PASS");
    expect(diagnostic.application).toBe(true);
    expect(diagnostic.authorityChecks).toHaveLength(1);
  });

  it("fails a round whose evidence shows the approved assertion broken", async () => {
    const round = await roundOf(FAILING);
    expect(await verifyWorkflowE2EEvidence(round.deps(allowing), round.operation, round.task, round.candidate, undefined, {}, { terminalStatus: "FAILED" })).toBe("FAILED");
  });

  it("is UNKNOWN when the install has no authority to offer, even for genuine passing evidence", async () => {
    const round = await roundOf(PASSING);
    const diagnostic: E2EVerificationDiagnostic = {};
    expect(await verifyWorkflowE2EEvidence(round.deps(failClosedAuthority), round.operation, round.task, round.candidate, undefined, diagnostic, { terminalStatus: "SUCCEEDED" })).toBe("UNKNOWN");
    expect(diagnostic.reason).toBe("no-current-authority-source");
    expect(diagnostic.authorityChecks).toBeUndefined();
  });

  it("is UNKNOWN when the stored group evidence is not the bytes its content address names", async () => {
    const round = await roundOf(PASSING, { groupBytes: (bytes) => Buffer.from(`${bytes.subarray(0, bytes.byteLength - 1).toString("utf8")} `, "utf8") });
    const diagnostic: E2EVerificationDiagnostic = {};
    expect(await verifyWorkflowE2EEvidence(round.deps(allowing), round.operation, round.task, round.candidate, undefined, diagnostic, { terminalStatus: "SUCCEEDED" })).toBe("UNKNOWN");
    expect(diagnostic.reason).toBe("accepted-group-evidence-integrity");
  });

  it("gives a group no receipt time when its upload row is not the completed upload of exactly that evidence, and the group is then not a pass", async () => {
    const round = await roundOf(PASSING, { dropReceipt: true });
    const loaded = await loadApplicationEvidenceInputs(round.deps(allowing), round.operation, round.reference, round.fixture.admission);
    expect("unavailable" in loaded).toBe(false);
    if (!("unavailable" in loaded)) expect(loaded.receivedAt.size).toBe(0);
    expect(await verifyWorkflowE2EEvidence(round.deps(allowing), round.operation, round.task, round.candidate, undefined, {}, { terminalStatus: "SUCCEEDED" })).not.toBe("PASS");
  });

  it("refuses to judge a round that is not the task's current one", async () => {
    const round = await roundOf(PASSING);
    const stale = { ...(round.task as object), workflow: { e2e: { required: true, currentRoundId: "another-round", currentGroupRunIds: [round.fixture.runId] } } } as never;
    const diagnostic: E2EVerificationDiagnostic = {};
    expect(await verifyWorkflowE2EEvidence(round.deps(allowing), round.operation, stale, round.candidate, undefined, diagnostic, { terminalStatus: "SUCCEEDED" })).toBe("UNKNOWN");
    expect(diagnostic.reason).toBe("current-admission-reference-mismatch");
  });

  it("never reads a baseline round as the candidate's", async () => {
    const round = await roundOf(PASSING);
    const baseline = { ...round.operation, workflowE2EAdmission: { ...round.reference, purpose: "baseline" } } as unknown as OperationRecord;
    const diagnostic: E2EVerificationDiagnostic = {};
    expect(await verifyWorkflowE2EEvidence(round.deps(allowing), baseline, round.task, round.candidate, undefined, diagnostic)).toBe("UNKNOWN");
    expect(diagnostic.reason).toBe("baseline-admission-is-not-a-candidate-round");
  });
});

describe("settling a baseline round", () => {
  const task = { taskId: "task-b1", ownerKey: "developer:maya", workspaceId: WORKSPACE, workflow: { e2e: { required: true, contractDigest: "a".repeat(64), applicationSelection: {} } } } as never;
  const seed = async () => {
    const store = new MemoryDocumentStore();
    const state = { store, now: () => new Date("2026-11-10T10:00:00.000Z") };
    await requestWorkflowE2EBaselineRound(state, task, { enabled: true });
    const objects = createDocumentObjectStorage(store, { companyId: COMPANY });
    const deps = { state, objects, authority: failClosedAuthority, readTask: async () => task };
    return { store, state, deps };
  };
  const operation = (status: string) => ({ id: "op-b1", workspaceId: WORKSPACE, fence: 1, kind: "task", workflowMode: "CHECKS", status,
    workflowE2EAdmission: { schemaVersion: 1, taskId: "task-b1", workflowRevision: 1, candidateDigest: "c".repeat(64), roundId: "r1", groupRunIds: [], purpose: "baseline", baseCommitSha: "b".repeat(40), attempt: 1,
      admissionRef: { key: `workflow-e2e-admissions/sha256/${"d".repeat(64)}.json`, sha256: "d".repeat(64), byteLength: 10 } } }) as never;

  it("leaves a record that is not started by this operation alone, and marks a started one stopped when the operation was cancelled", async () => {
    const { deps, state } = await seed();
    await settleBaselineRound(deps, operation("CANCELLED"), "CANCELLED");
    expect((await readWorkflowE2EBaselineRecord(state, task))?.state).toBe("REQUESTED");
    const started = { baseCommitSha: "b".repeat(40), operationId: "op-b1", roundId: "r1", admissionSha256: "d".repeat(64), startedAt: "2026-11-10T10:00:00.000Z", deadlineAt: "2026-11-10T10:30:00.000Z" };
    const { baselineStartItem } = await import("../../packages/core/src/core/e2e/baseline.js");
    expect((await state.store.transact([baselineStartItem(task, started)])).applied).toBe(true);
    await settleBaselineRound(deps, operation("CANCELLED"), "CANCELLED");
    expect(await readWorkflowE2EBaselineRecord(state, task)).toMatchObject({ state: "UNAVAILABLE", reason: "stopped" });
  });

  it("marks a started record whose operation failed as one that could not run, and never replaces a result", async () => {
    const { deps, state } = await seed();
    const started = { baseCommitSha: "b".repeat(40), operationId: "op-b1", roundId: "r1", admissionSha256: "d".repeat(64), startedAt: "2026-11-10T10:00:00.000Z", deadlineAt: "2026-11-10T10:30:00.000Z" };
    const { baselineStartItem } = await import("../../packages/core/src/core/e2e/baseline.js");
    await state.store.transact([baselineStartItem(task, started)]);
    await settleBaselineRound(deps, operation("FAILED"), "FAILED");
    expect(await readWorkflowE2EBaselineRecord(state, task)).toMatchObject({ state: "UNAVAILABLE", reason: "run-failed" });
    expect(await markWorkflowE2EBaselineUnavailable(state, task, "stopped", { from: ["STARTED"], operationId: "op-b1" })).toBe(false);
  });
});
