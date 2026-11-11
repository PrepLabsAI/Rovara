// The verification of the browser and API checks (E2E): what a finished round's stored evidence proves, decided by the broker alone. Cloud's `workflow-e2e-verification.ts` (the part that
// judges evidence and settles the baseline, replay and grounding rounds) on the document store and object storage. Everything a round is compared with is the broker's own: the stored
// admission, the operation's reference and fence, the content-addressed evidence it accepted, and the receipt time it recorded for each group's upload. Whether the owner and the code
// are still the ones the round was admitted under is the `E2EAuthority` seam's answer; Code's default fails closed, so no round passes where nothing can say.
import { createHash } from "node:crypto";
import {
  E2EPolicySchema, E2EScenarioBundleSchema, e2eScenarioBundleDigest, e2ePlanHasCompleteRequiredCriteria, E2ERunBindingSchema, E2ERoundSchema, selectE2EExecutionPlan,
  verifyE2ESourceSnapshot, canonicalJson, E2EWorkflowGroupEvidenceRefSchema, isE2EApplicationAdmissionSchemaVersion, ProjectSetupRunnerEnvironmentSchema, ProjectSetupRunnerToolchainSchema,
  cutEvidenceReason,
  type ObjectStorage, type OperationStatus, type E2ESourceSnapshot, type E2EWorkflowAdmissionRef, type E2EApplicationExecutionAdmission,
} from "@agentx/contracts";
import { compileE2EScenarios, collectE2EActualCliRun, qualifyE2ECollection, e2eSnapshotSourceDigest, parseE2EFirstPartyCapture, e2ePrivateTransferMaxBytes, decodeE2EApplicationExecutionAdmission } from "@agentx/verifier";
import { groundingPlanDigest } from "../../e2e/application-admission.js";
import { applicationEvidenceLimits, modelRouteForAdmission, verifyApplicationE2EEvidence, type ApplicationEvidenceVerification } from "../../e2e/application-evidence.js";
import type { OperationRecord, TaskRecord } from "../task-flow/records.js";
import type { E2EAuthority, E2EVerificationDeps, E2EVerificationDiagnostic, VerifiedCandidate } from "./authority.js";
import { WORKFLOW_E2E_ADMISSION_MAX_BYTES } from "./artifacts.js";
import { markWorkflowE2EBaselineUnavailable, readWorkflowE2EBaselineRecord, recordWorkflowE2EBaseline, verifyBaselineEvidence, type BaselineUnavailableReason, type SkippedAiScenarios } from "./baseline.js";
import { markWorkflowE2EReplayUnavailable, readWorkflowE2EReplayRecord, recordWorkflowE2EReplay, verifyReplayEvidence, type ReplayUnavailableReason } from "./replay.js";
import { markWorkflowE2EGroundingUnavailable, readWorkflowE2EGroundingRecord, recordWorkflowE2EGrounding, verifyGroundingEvidence, type GroundingRecord, type GroundingUnavailableReason } from "./grounding.js";

type DeveloperTaskRecord = TaskRecord;
type CandidateManifest = VerifiedCandidate;

/** The text of a stored object, or undefined when it is not there or is bigger than `maxBytes`. */
async function readText(objects: ObjectStorage, key: string, maxBytes: number): Promise<string | undefined> {
  const bytes = await objects.get(key, maxBytes);
  return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
}
export type { E2EAuthority, E2EVerificationDeps, E2EVerificationDiagnostic };

/** What a verification hands the presentation: the authenticated plan and round, the broker's own re-collected results, and (for a browser and API round) the display rows derived from them. */
export type WorkflowE2EProjection = { plan?: unknown; round?: unknown; results: unknown[]; allowStaleProjection?: boolean; display?: NonNullable<ApplicationEvidenceVerification["display"]> };

/**
 * A terminal CHECKS operation's broker timestamp may anchor a later re-collection only when
 * the task still carries the exact canonical outcome written from that operation's immutable
 * admission and evidence. This never supplies a receipt for an active or first-time result.
 */
function workflowE2ETerminalReceiptAt(
  operation: OperationRecord,
  task: DeveloperTaskRecord,
  candidateDigest: string,
  reference: E2EWorkflowAdmissionRef,
  round: ReturnType<typeof E2ERoundSchema.parse>,
  allowStaleProjection: boolean,
): { at: string; outcome: "PASS" | "FAILED" } | undefined {
  if (operation.kind !== "task" || operation.workflowMode !== "CHECKS"
    || operation.status !== "SUCCEEDED" && operation.status !== "FAILED"
    || operation.workflowE2EAdmission === undefined || canonicalJson(operation.workflowE2EAdmission) !== canonicalJson(reference)
    || operation.workflowE2EEvidenceRef === undefined || operation.workflowE2EEvidenceRef.key !== `workflow-e2e-evidence/sha256/${operation.workflowE2EEvidenceRef.sha256}.json`
    || reference.taskId !== task.taskId || reference.candidateDigest !== candidateDigest || reference.roundId !== round.roundId
    || reference.workflowRevision !== round.workflowRevision || canonicalJson(reference.groupRunIds) !== canonicalJson(round.groupBindings.map((binding) => binding.runId))
    || new Set(operation.workflowE2EGroupRunIds ?? []).size !== reference.groupRunIds.length
    || canonicalJson([...(operation.workflowE2EGroupRunIds ?? [])].sort()) !== canonicalJson([...reference.groupRunIds].sort())) return undefined;
  const receiptTime = Date.parse(operation.updatedAt);
  if (!Number.isFinite(receiptTime) || new Date(receiptTime).toISOString() !== operation.updatedAt
    || receiptTime > Date.parse(round.deadlineAt)) return undefined;

  const workflowE2E = task.workflow?.e2e;
  if (operation.status === "SUCCEEDED" && !allowStaleProjection) {
    const qualified = workflowE2E?.qualifiedRound;
    if (!qualified || qualified.candidateDigest !== candidateDigest
      || qualified.roundId !== reference.roundId || canonicalJson(qualified.groupRunIds) !== canonicalJson(reference.groupRunIds)
      || qualified.admissionSha256 !== reference.admissionRef.sha256 || qualified.evidenceSha256 !== operation.workflowE2EEvidenceRef.sha256
      || qualified.contractDigest !== workflowE2E.contractDigest || qualified.policyDigest !== workflowE2E.policyDigest
      || qualified.bundleDigest !== workflowE2E.bundleDigest || qualified.executionPlanDigest !== workflowE2E.executionPlanDigest
      || workflowE2E.currentRoundId !== qualified.roundId || canonicalJson(workflowE2E.currentGroupRunIds) !== canonicalJson(qualified.groupRunIds)) return undefined;
    return { at: operation.updatedAt, outcome: "PASS" };
  }
  const failed = workflowE2E?.failedRound;
  if (!allowStaleProjection || failed?.status !== "FAILED" || failed.candidateDigest !== candidateDigest
    || failed.roundId !== reference.roundId || canonicalJson(failed.groupRunIds) !== canonicalJson(reference.groupRunIds)
    || failed.admissionSha256 !== reference.admissionRef.sha256 || failed.evidenceSha256 !== operation.workflowE2EEvidenceRef.sha256) return undefined;
  return { at: operation.updatedAt, outcome: "FAILED" };
}

/** Independently recompiles and collects every group; worker-supplied verdict fields are ignored. */

export async function verifyWorkflowE2EEvidence(
  deps: E2EVerificationDeps, operation: OperationRecord, task: DeveloperTaskRecord, candidate: CandidateManifest,
  projection?: WorkflowE2EProjection,
  diagnostic?: E2EVerificationDiagnostic,
  /** How the CHECKS operation is ending, when its stored record has not been written yet (the result callback verifies before it writes the terminal state). */
  options?: { terminalStatus?: "SUCCEEDED" | "FAILED" },
): Promise<"PASS" | "FAILED" | "UNKNOWN"> {
  const unavailable = (reason: string): "UNKNOWN" => { if (diagnostic !== undefined) diagnostic.reason = reason; return "UNKNOWN"; };
  try {
    const workflow = task.workflow;
    if (workflow === undefined) return unavailable("workflow-missing");
    const reference = operation.workflowE2EAdmission;
    // This is the candidate's verification. A baseline round (the unchanged code, for information only) is never a candidate round, whatever the workflow's current
    // round says: its own completion path verifies it (verifyBaselineEvidence), and nothing here can turn it into a verdict on the candidate.
    if (reference?.purpose === "baseline") return unavailable("baseline-admission-is-not-a-candidate-round");
    if (reference?.purpose === "replay") return unavailable("replay-admission-is-not-a-candidate-round");
    if (reference?.purpose === "grounding") return unavailable("grounding-admission-is-not-a-candidate-round");
    const evidenceRef = operation.workflowE2EEvidenceRef;
    const groupEvidenceRefs = operation.workflowE2EGroupEvidenceRefs ?? [];
    const groupEvidenceRunIds = operation.workflowE2EGroupRunIds ?? [];
    const staleProjection = projection?.allowStaleProjection === true;
    if (!reference || reference.taskId !== task.taskId || reference.candidateDigest !== candidate.digest
      || (!staleProjection && (workflow.e2e?.currentRoundId !== reference.roundId
        || canonicalJson(workflow.e2e.currentGroupRunIds) !== canonicalJson(reference.groupRunIds)))) return unavailable("current-admission-reference-mismatch");
    const admissionText = await readText(deps.objects, reference.admissionRef.key, WORKFLOW_E2E_ADMISSION_MAX_BYTES);
    // The admission names its own kind. An application admission is verified by the application verifier and never reaches the portable code below; a task whose approved
    // plan is an application plan has no portable verification at all whatever admission and evidence are recorded for it.
    if (isE2EApplicationAdmissionSchemaVersion(storedAdmissionSchemaVersion(admissionText))) {
      if (diagnostic !== undefined) diagnostic.application = true;
      return await verifyApplicationWorkflowE2EEvidence({ deps, operation, task, candidate, reference, admissionText: admissionText!, projection, diagnostic, unavailable,
        ...(options?.terminalStatus === undefined ? {} : { terminalStatus: options.terminalStatus }) });
    }
    if (workflow.e2e?.applicationSelection !== undefined) {
      if (diagnostic !== undefined) diagnostic.application = true;
      return unavailable("application-e2e-plan-needs-application-verification");
    }
    const evidenceText = evidenceRef === undefined ? undefined
      : await readText(deps.objects, evidenceRef.key, WORKFLOW_E2E_ADMISSION_MAX_BYTES);
    if (admissionText === undefined || createHash("sha256").update(admissionText).digest("hex") !== reference.admissionRef.sha256
      || Buffer.byteLength(admissionText) !== reference.admissionRef.byteLength
      || evidenceRef !== undefined && (evidenceText === undefined || evidenceRef.key !== `workflow-e2e-evidence/sha256/${evidenceRef.sha256}.json`
        || createHash("sha256").update(evidenceText).digest("hex") !== evidenceRef.sha256 || Buffer.byteLength(evidenceText) !== evidenceRef.byteLength)) {
      return unavailable("admission-or-evidence-reference-integrity");
    }
    const admission = JSON.parse(admissionText) as Record<string, unknown>;
    const evidence = evidenceText === undefined ? undefined : JSON.parse(evidenceText) as Record<string, unknown>;
    if (admission.schemaVersion !== "workflow-e2e-admission/v1" || evidence !== undefined && (evidence.schemaVersion !== "workflow-e2e-evidence/v1"
      || evidence.admissionSha256 !== reference.admissionRef.sha256 || evidence.taskId !== task.taskId || evidence.operationId !== operation.id
      || evidence.operationFence !== operation.fence || evidence.workflowRevision !== reference.workflowRevision || evidence.candidateDigest !== candidate.digest)) {
      return unavailable("admission-or-evidence-subject-binding");
    }
    const sourceRecord = admission.sourceSnapshot as Record<string, unknown>;
    if (!sourceRecord || !Array.isArray(sourceRecord.sources)) return unavailable("admitted-source-snapshot-shape");
    const snapshot = { ...sourceRecord, sources: sourceRecord.sources.map((raw) => {
      const row = raw as Record<string, unknown>;
      if (typeof row.path !== "string" || typeof row.sha256 !== "string" || row.kind !== "blob" || typeof row.bytesBase64 !== "string") throw new Error("invalid source row");
      const bytes = Buffer.from(row.bytesBase64, "base64");
      if (bytes.toString("base64") !== row.bytesBase64) throw new Error("invalid source encoding");
      return { path: row.path, sha256: row.sha256, kind: "blob" as const, bytes };
    }) } as unknown as E2ESourceSnapshot;
    verifyE2ESourceSnapshot(snapshot, candidate);
    E2EPolicySchema.parse(admission.policy);
    const selectionInput = { ...(admission.selectionInput as Record<string, unknown>), sourceSnapshot: snapshot };
    const plan = selectE2EExecutionPlan(selectionInput as never);
    const bundle = E2EScenarioBundleSchema.parse(admission.bundle);
    const round = E2ERoundSchema.parse(admission.round);
    const projectionResults: unknown[] = [];
    const runtime = admission.runtime as Record<string, unknown>;
    const runnerEnvironment = ProjectSetupRunnerEnvironmentSchema.parse(runtime.runnerEnvironment);
    const runnerToolchain = ProjectSetupRunnerToolchainSchema.parse(runtime.runnerToolchain);
    const groupAdmissions = admission.groupAdmissions as Array<Record<string, unknown>>;
    const aggregateGroupRuns = evidence?.groupRuns;
    if (admission.taskId !== task.taskId || admission.operationId !== operation.id || admission.operationFence !== operation.fence
      || admission.workflowRevision !== reference.workflowRevision || admission.candidateDigest !== candidate.digest
      || round.roundId !== reference.roundId || round.taskId !== task.taskId || round.operationId !== operation.id || round.operationFence !== operation.fence
      || round.workflowRevision !== reference.workflowRevision || plan.groups.length === 0 || plan.groups.length !== groupAdmissions.length
      || plan.groups.length !== reference.groupRunIds.length
      || canonicalJson(plan) !== canonicalJson(admission.plan) || bundle.bundleDigest !== e2eScenarioBundleDigest(bundle)) return unavailable("current-plan-round-or-group-binding");
    if (evidence !== undefined && (!Array.isArray(aggregateGroupRuns) || aggregateGroupRuns.length !== reference.groupRunIds.length)) return unavailable("aggregate-group-results-incomplete");
    if (groupEvidenceRefs.length !== groupEvidenceRunIds.length
      || canonicalJson(groupEvidenceRefs.map((raw) => E2EWorkflowGroupEvidenceRefSchema.parse(raw).groupRunId)) !== canonicalJson(groupEvidenceRunIds)
      || new Set(groupEvidenceRunIds).size !== groupEvidenceRunIds.length
      || groupEvidenceRunIds.some((runId) => !reference.groupRunIds.includes(runId))) return unavailable("accepted-group-reference-list-invalid");
    if (evidence === undefined && groupEvidenceRefs.length === 0) return unavailable("group-results-not-yet-accepted");
    const aggregateByRun = new Map<string, Record<string, unknown>>();
    if (Array.isArray(aggregateGroupRuns)) {
      for (const raw of aggregateGroupRuns) {
        if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return unavailable("aggregate-group-result-shape");
        const run = raw as Record<string, unknown>;
        const binding = run.binding as Record<string, unknown> | undefined;
        if (typeof binding?.runId !== "string" || aggregateByRun.has(binding.runId)) return unavailable("aggregate-group-result-identity");
        aggregateByRun.set(binding.runId, run);
      }
    }
    const groupRunsById = new Map<string, Record<string, unknown>>();
    for (const raw of groupEvidenceRefs) {
      const parsedRef = E2EWorkflowGroupEvidenceRefSchema.safeParse(raw);
      if (!parsedRef.success) return unavailable("accepted-group-reference-schema");
      const { groupRunId, evidenceRef: storedGroupRef } = parsedRef.data;
      const index = reference.groupRunIds.indexOf(groupRunId);
      if (index < 0 || groupRunsById.has(groupRunId) || storedGroupRef.key !== `workflow-e2e-group-evidence/sha256/${storedGroupRef.sha256}.json`) {
        return unavailable("accepted-group-reference-subject");
      }
      const expectedCaseCount = groupAdmissions[index]?.expectedCases;
      if (!Array.isArray(expectedCaseCount)) return unavailable("admitted-group-case-count");
      const groupText = await readText(deps.objects, storedGroupRef.key,
        Math.min(WORKFLOW_E2E_ADMISSION_MAX_BYTES, e2ePrivateTransferMaxBytes(expectedCaseCount.length, 1)));
      if (groupText === undefined || Buffer.byteLength(groupText) !== storedGroupRef.byteLength
        || createHash("sha256").update(groupText).digest("hex") !== storedGroupRef.sha256) return unavailable("accepted-group-evidence-integrity");
      const envelope = JSON.parse(groupText) as Record<string, unknown>;
      const groupRun = envelope.groupRun as Record<string, unknown> | undefined;
      if (!groupRun || envelope.schemaVersion !== "workflow-e2e-group-evidence/v1" || envelope.admissionSha256 !== reference.admissionRef.sha256
        || envelope.taskId !== task.taskId || envelope.operationId !== operation.id || envelope.operationFence !== operation.fence
        || envelope.workflowRevision !== reference.workflowRevision || envelope.candidateDigest !== candidate.digest
        || canonicalJson(envelope.round) !== canonicalJson(round) || canonicalJson(groupRun.binding) !== canonicalJson(round.groupBindings[index])
        || canonicalJson(groupRun.group) !== canonicalJson(plan.groups[index])) return unavailable("accepted-group-evidence-subject");
      const aggregateRun = aggregateByRun.get(groupRunId);
      if (evidence !== undefined && (aggregateRun === undefined || canonicalJson(aggregateRun) !== canonicalJson(groupRun))) return unavailable("aggregate-group-evidence-mismatch");
      groupRunsById.set(groupRunId, groupRun);
    }
    if (evidence !== undefined && (groupEvidenceRefs.length !== reference.groupRunIds.length
      || canonicalJson([...groupRunsById.keys()].sort()) !== canonicalJson([...reference.groupRunIds].sort())
      || canonicalJson([...aggregateByRun.keys()].sort()) !== canonicalJson([...reference.groupRunIds].sort()))) return unavailable("aggregate-does-not-cover-accepted-groups");
    const semantic = (admission.portableApprovalBinding as { semanticApproval?: { digest?: unknown } } | undefined)?.semanticApproval?.digest;
    if (typeof semantic !== "string" || !/^[a-f0-9]{64}$/u.test(semantic)) return unavailable("semantic-approval-binding");
    const semanticApprovalDigests = new Map(bundle.scenarios.map((scenario) => [scenario.scenarioId, semantic]));
    const terminalReceipt = workflowE2ETerminalReceiptAt(operation, task, candidate.digest, reference, round, staleProjection);
    const qualifications: Array<"PASS" | "FAILED" | "UNKNOWN"> = [];
    for (const [index, group] of plan.groups.entries()) {
      const admitted = groupAdmissions[index]; const run = groupRunsById.get(reference.groupRunIds[index]!);
      if (!admitted || canonicalJson(admitted.group) !== canonicalJson(group)) return unavailable("admitted-group-identity");
      const compiled = compileE2EScenarios(bundle, plan.effectiveTargets, group, { selectionInput, executionPlan: plan, group } as never);
      if (admitted.expectedConfigDigest !== compiled.expectedConfigDigest || admitted.compiledInventoryDigest !== compiled.inventory.digest
        || admitted.selectionPacketPath !== compiled.selectionPacketPath || canonicalJson(admitted.expectedCases) !== canonicalJson(compiled.expectedCases)) return unavailable("compiled-group-expectations");
      const binding = E2ERunBindingSchema.parse(admitted.binding);
      if (binding.runId !== reference.groupRunIds[index] || binding.taskId !== task.taskId || binding.operationId !== operation.id
        || binding.operationFence !== operation.fence || binding.workflowRevision !== reference.workflowRevision || binding.candidateDigest !== candidate.digest
        || binding.roundId !== reference.roundId || canonicalJson(round.groupBindings[index]) !== canonicalJson(binding)) return unavailable("group-run-binding");
      if (run === undefined) { qualifications.push("UNKNOWN"); continue; }
      if (canonicalJson(run.group) !== canonicalJson(group) || canonicalJson(run.binding) !== canonicalJson(binding)) return unavailable("group-run-result-binding");
      const selection = JSON.parse(compiled.files.get(compiled.selectionPacketPath) ?? "null") as unknown;
      if (canonicalJson(run.selection) !== canonicalJson(selection) || !Array.isArray(run.hostRequestIds)) return unavailable("compiled-selection-or-host-request-list");
      const hostRequestIds = new Map<string, string>();
      for (const entry of run.hostRequestIds) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || typeof entry[1] !== "string" || hostRequestIds.has(entry[0])) return unavailable("host-request-identity-list");
        hostRequestIds.set(entry[0], entry[1]);
      }
      if (hostRequestIds.size !== compiled.hostRequestPayloads.size) return unavailable("host-request-count");
      const rawActual = run.actual as Record<string, unknown>;
      if (!rawActual || typeof rawActual.launchId !== "string" || typeof rawActual.rawReportBase64 !== "string" || typeof rawActual.runStartCaptureBase64 !== "string"
        || canonicalJson(rawActual.runnerToolchain) !== canonicalJson(runnerToolchain) || !Array.isArray(rawActual.candidateCaptures)
        || !Array.isArray(rawActual.assertionReceipts) || typeof rawActual.cleanupConfirmed !== "boolean" || typeof rawActual.cleanupServerListening !== "boolean") return unavailable("actual-run-capture-shape-or-toolchain");
      const rawReportBytes = Buffer.from(rawActual.rawReportBase64, "base64");
      const runStartCaptureBytes = Buffer.from(rawActual.runStartCaptureBase64, "base64");
      if (rawReportBytes.toString("base64") !== rawActual.rawReportBase64 || runStartCaptureBytes.toString("base64") !== rawActual.runStartCaptureBase64) return unavailable("actual-run-capture-encoding");
      const actual = { ...rawActual, rawReportBytes: new Uint8Array(rawReportBytes), runStartCaptureBytes: new Uint8Array(runStartCaptureBytes),
        runStartCapture: parseE2EFirstPartyCapture(runStartCaptureBytes, rawActual.launchId), evidenceDirectory: "" } as never;
      const result = collectE2EActualCliRun({ actual, compiled, binding, round, selection: selection as never,
        sourceDigest: e2eSnapshotSourceDigest(compiled, snapshot.sources.map(({ path, sha256 }) => ({ path, sha256 }))),
        semanticApprovalDigests, hostRequestIds,
        declaredMockComponentIds: Array.isArray(rawActual.declaredMockComponentIds) ? rawActual.declaredMockComponentIds as string[] : [],
        environment: runnerEnvironment,
        usage: { discoveredResults: Number(rawActual.selected) + Number(rawActual.filtered), maxAgentContextBytes: 0, maxLedgerBytes: 0, maxObservationBytes: 0, artifactBytes: 0, downloads: 0, events: 0, modelTokens: 0, maxModelCallsInStep: 0, maxActionStepsInStep: 0 },
        limits: { maxAgentContextBytes: 16_384, maxLedgerBytes: 8_192, maxObservationBytes: 262_144, maxEventsPerStep: 1_000, maxModelTokensPerCall: 64_000 } });
      const qualification = terminalReceipt !== undefined && result.collection !== null && result.oracle !== null
        ? qualifyE2ECollection(result.oracle, { ...result.collection, receivedAt: terminalReceipt.at })
        : result.qualification;
      const process = rawActual.runProcess as Record<string, unknown> | undefined;
      if (qualification?.result !== null && qualification?.result !== undefined) {
        // This is a broker-side projection of the independently re-collected result. The raw
        // collector labels its structural output exploratory; only this verified path promotes
        // the projection after matching the stored admission, source, round, capture and receipts.
        projectionResults.push({ ...qualification.result, producer: "broker-independent-e2e-verifier", qualification: "trusted",
          ...(process?.status === 0 && process.signal === null && process.aborted === false && process.timedOut === false ? {} : { status: "failed", reason: "host-process-failed" }) });
      }
      if (process?.status !== 0 || process.signal !== null || process.aborted !== false || process.timedOut !== false) qualifications.push("FAILED");
      else if (terminalReceipt?.outcome === "FAILED" && qualification?.status !== "FAILED") qualifications.push("UNKNOWN");
      else qualifications.push(qualification?.status ?? "UNKNOWN");
    }
    // Re-collect every supported admitted group for an honest scoped projection even when a
    // required criterion has no executable source-interface case. That criterion still holds
    // aggregate readiness: incomplete required coverage can never become PASS.
    const currentAuthorityValid = await deps.authority.portable({ task, candidate, admission, snapshot }, diagnostic);
    if (projection !== undefined) {
      projection.plan = plan;
      projection.round = round;
      if (currentAuthorityValid) projection.results.push(...projectionResults);
    }
    if (!currentAuthorityValid) return unavailable(diagnostic?.reason ?? "current-owner-policy-source-or-runtime-authority");
    if (!e2ePlanHasCompleteRequiredCriteria(plan)) return unavailable("required-criteria-unavailable");
    return qualifications.includes("FAILED") ? "FAILED" : qualifications.every((item) => item === "PASS") ? "PASS" : "UNKNOWN";
  } catch { return unavailable("verification-exception"); }
}

function storedAdmissionSchemaVersion(admissionText: string | undefined): string | undefined {
  if (admissionText === undefined) return undefined;
  try {
    const parsed = JSON.parse(admissionText) as { schemaVersion?: unknown };
    return typeof parsed?.schemaVersion === "string" ? parsed.schemaVersion : undefined;
  } catch { return undefined; }
}

const APPLICATION_VERDICT_REASON_MAX_CHARS = 240;

/**
 * The evidence an application round's operation has accepted, read back and held to the content addresses the broker recorded: the aggregate (when it was accepted), each accepted
 * group's evidence, and the broker's own receipt time of each group (when its upload started). The candidate's verification and the baseline's both start from this, so what a
 */
export async function loadApplicationEvidenceInputs(deps: E2EVerificationDeps, operation: OperationRecord, reference: E2EWorkflowAdmissionRef, admission: E2EApplicationExecutionAdmission):
  Promise<{ aggregate: unknown; groupEvidence: Map<string, unknown>; receivedAt: Map<string, string> } | { unavailable: string }> {
  const unavailableInputs = (reason: string) => ({ unavailable: reason });
  const limits = applicationEvidenceLimits(admission);
  const evidenceRef = operation.workflowE2EEvidenceRef;
  const groupEvidenceRefs = operation.workflowE2EGroupEvidenceRefs ?? [];
  const groupEvidenceRunIds = operation.workflowE2EGroupRunIds ?? [];
  if (groupEvidenceRefs.length !== groupEvidenceRunIds.length
    || canonicalJson(groupEvidenceRefs.map((raw) => E2EWorkflowGroupEvidenceRefSchema.parse(raw).groupRunId)) !== canonicalJson(groupEvidenceRunIds)
    || new Set(groupEvidenceRunIds).size !== groupEvidenceRunIds.length
    || groupEvidenceRunIds.some((runId) => !reference.groupRunIds.includes(runId))) return unavailableInputs("accepted-group-reference-list-invalid");
  if (evidenceRef === undefined && groupEvidenceRefs.length === 0) return unavailableInputs("group-results-not-yet-accepted");
  let aggregate: unknown;
  if (evidenceRef !== undefined) {
    const aggregateText = evidenceRef.key === `workflow-e2e-evidence/sha256/${evidenceRef.sha256}.json`
      ? await readText(deps.objects, evidenceRef.key, limits.aggregate) : undefined;
    if (aggregateText === undefined || createHash("sha256").update(aggregateText).digest("hex") !== evidenceRef.sha256 || Buffer.byteLength(aggregateText) !== evidenceRef.byteLength) {
      return unavailableInputs("admission-or-evidence-reference-integrity");
    }
    aggregate = JSON.parse(aggregateText) as unknown;
  }
  const groupEvidence = new Map<string, unknown>();
  const receivedAt = new Map<string, string>();
  for (const raw of groupEvidenceRefs) {
    const parsedRef = E2EWorkflowGroupEvidenceRefSchema.safeParse(raw);
    if (!parsedRef.success) return unavailableInputs("accepted-group-reference-schema");
    const { groupRunId, evidenceRef: stored } = parsedRef.data;
    const limit = limits.byGroup.get(groupRunId);
    if (limit === undefined || groupEvidence.has(groupRunId) || stored.key !== `workflow-e2e-group-evidence/sha256/${stored.sha256}.json`) return unavailableInputs("accepted-group-reference-subject");
    const groupText = await readText(deps.objects, stored.key, limit);
    if (groupText === undefined || Buffer.byteLength(groupText) !== stored.byteLength || createHash("sha256").update(groupText).digest("hex") !== stored.sha256) {
      return unavailableInputs("accepted-group-evidence-integrity");
    }
    groupEvidence.set(groupRunId, JSON.parse(groupText) as unknown);
    // The broker's own receipt of this group's evidence: the start of the upload that was accepted, recorded once with its row. A row that is not exactly this
    // operation's completed upload of exactly this content gives no receipt, and the group is then UNKNOWN.
    const upload = await deps.state.store.get({ pk: `WORKSPACE#${operation.workspaceId}`, sk: `WORKFLOW_E2E_UPLOAD#${operation.id}#${groupRunId}` });
    const accepted = E2EWorkflowGroupEvidenceRefSchema.safeParse(upload?.groupEvidenceRef);
    if (upload?.entityType === "WORKFLOW_E2E_EVIDENCE_UPLOAD" && upload.status === "COMPLETE" && upload.operationId === operation.id && upload.groupRunId === groupRunId
      && upload.fence === operation.fence && upload.admissionSha256 === reference.admissionRef.sha256 && accepted.success && accepted.data.evidenceRef.sha256 === stored.sha256
      && typeof upload.receivedAt === "string") receivedAt.set(groupRunId, upload.receivedAt);
  }
  return { aggregate, groupEvidence, receivedAt };
}

/**
 * Independently decides what the stored evidence of an application round proves, for the result callback, the task presentation and publication alike. Everything the
 * verifier compares the worker's evidence with is the broker's: the stored admission, the operation's own reference and fence, the content-addressed evidence it accepted
 * itself, and the receipt time it recorded when each group's upload started. The verdict is then held to the current authority (creator, project, source, runtime rows),
 * so a round whose owner, source or runtime moved is UNKNOWN, as a portable round is.
 */
async function verifyApplicationWorkflowE2EEvidence(input: {
  deps: E2EVerificationDeps; operation: OperationRecord; task: DeveloperTaskRecord; candidate: CandidateManifest;
  reference: E2EWorkflowAdmissionRef; admissionText: string; projection: WorkflowE2EProjection | undefined;
  diagnostic: E2EVerificationDiagnostic | undefined; unavailable: (reason: string) => "UNKNOWN"; terminalStatus?: "SUCCEEDED" | "FAILED";
}): Promise<"PASS" | "FAILED" | "UNKNOWN"> {
  const { deps, operation, task, candidate, reference, admissionText, projection, diagnostic, unavailable } = input;
  const admissionBytes = Buffer.from(admissionText, "utf8");
  if (createHash("sha256").update(admissionBytes).digest("hex") !== reference.admissionRef.sha256 || admissionBytes.byteLength !== reference.admissionRef.byteLength) {
    return unavailable("admission-or-evidence-reference-integrity");
  }
  let admission: E2EApplicationExecutionAdmission;
  try { admission = decodeE2EApplicationExecutionAdmission(admissionBytes); } catch { return unavailable("application-admission-undecodable"); }
  const loaded = await loadApplicationEvidenceInputs(deps, operation, reference, admission);
  if ("unavailable" in loaded) return unavailable(loaded.unavailable);
  const { aggregate, groupEvidence, receivedAt } = loaded;
  const terminalStatus = input.terminalStatus ?? (operation.status === "SUCCEEDED" || operation.status === "FAILED" ? operation.status : undefined);
  // A round with an AI navigation step is judged against the model route registry's own definition of the revision it was admitted under, never a definition the
  // worker uploads; one GetItem, only for a round that has such a step. A registry that cannot be asked leaves the round unverifiable, not judged.
  const route = await modelRouteForAdmission((key) => deps.state.store.get(key), admission);
  if ("unavailable" in route) return unavailable(route.unavailable);
  const modelRouteDefinition = route.definition;
  const verified = verifyApplicationE2EEvidence({ admissionBytes, subject: { taskId: task.taskId, operationId: operation.id, operationFence: operation.fence, workflowRevision: reference.workflowRevision,
    candidateDigest: candidate.digest, roundId: reference.roundId, groupRunIds: reference.groupRunIds, admissionSha256: reference.admissionRef.sha256 },
  aggregate, groupEvidence, receivedAt, terminalStatus, ...(modelRouteDefinition === undefined ? {} : { modelRouteDefinition }) });
  const authorityValid = await deps.authority.application({ task, candidate, admission }, diagnostic);
  if (projection !== undefined) {
    if (verified.plan !== undefined) projection.plan = verified.plan;
    if (verified.round !== undefined) projection.round = verified.round;
    if (authorityValid) {
      projection.results.push(...verified.results);
      if (verified.display !== undefined) projection.display = verified.display;
    }
  }
  if (!authorityValid) return unavailable(diagnostic?.reason ?? "current-owner-policy-source-or-runtime-authority");
  if (verified.verdict !== "PASS" && diagnostic !== undefined) {
    diagnostic.reason = cutEvidenceReason(verified.reason.replace(/\p{Cc}+/gu, " ").replace(/\s+/gu, " ").trim(), APPLICATION_VERDICT_REASON_MAX_CHARS);
  }
  return verified.verdict;
}

/**
 * The baseline round's own completion. When its operation ends, this settles the baseline's record, and does nothing else: no workflow transition, no
 * `qualifiedRound` or `failedRound`, no send-back, no publication. An operation that did not succeed leaves the record saying the unchanged code could not be checked; one that
 * succeeded is verified exactly as a candidate's evidence is read (`loadApplicationEvidenceInputs`, then the verifier for the purpose it was signed with), and only that
 * verification's rows are recorded, conditionally, on the plan, base commit, attempt, operation and round the record started. It never throws: whatever goes wrong here, the baseline
 * is a record that stays STARTED and is shown as not run once its time is up.
 */
export async function settleBaselineRound(deps: E2EVerificationDeps, operation: OperationRecord, status: OperationStatus): Promise<void> {
  const reference = operation.workflowE2EAdmission;
  if (operation.kind !== "task" || reference?.purpose !== "baseline" || reference.baseCommitSha === undefined || reference.attempt === undefined) return;
  try {
    const task = await deps.readTask(reference.taskId);
    if (task === undefined || task.workspaceId !== operation.workspaceId) return;
    const record = await readWorkflowE2EBaselineRecord(deps.state, task);
    if (record === undefined || record.state !== "STARTED" || record.operationId !== operation.id) return;
    const unavailable = (reason: BaselineUnavailableReason) => markWorkflowE2EBaselineUnavailable(deps.state, task, reason, { from: ["STARTED"], operationId: operation.id });
    // A baseline cancelled while its record still says it is running was stopped by someone (the system marks the record before it cancels a round that ran out of time).
    if (status !== "SUCCEEDED") { await unavailable(status === "CANCELLED" ? "stopped" : "run-failed"); return; }
    const verified = await verifyBaselineRound(deps, operation, reference, record.skippedAiScenarios);
    if (verified === undefined) { await unavailable("unverified"); return; }
    await recordWorkflowE2EBaseline({ ...deps.state, objects: deps.objects }, task,
      { verified, expected: { operationId: operation.id, roundId: reference.roundId, admissionSha256: reference.admissionRef.sha256, baseCommitSha: reference.baseCommitSha, attempt: reference.attempt } });
  } catch (error) {
    console.log(JSON.stringify({ component: "broker", event: "workflow.e2e_baseline_settle_failed", taskId: reference.taskId, operationId: operation.id, errorName: error instanceof Error ? error.name : "unknown" }));
  }
}

/** The broker's own verification of a finished baseline round's evidence, or undefined when the admission or the evidence cannot be read or verify to no rows. */
async function verifyBaselineRound(deps: E2EVerificationDeps, operation: OperationRecord, reference: E2EWorkflowAdmissionRef, skippedAiScenarios?: SkippedAiScenarios) {
  const admissionText = await readText(deps.objects, reference.admissionRef.key, WORKFLOW_E2E_ADMISSION_MAX_BYTES);
  if (admissionText === undefined) return undefined;
  const admissionBytes = Buffer.from(admissionText, "utf8");
  if (createHash("sha256").update(admissionBytes).digest("hex") !== reference.admissionRef.sha256 || admissionBytes.byteLength !== reference.admissionRef.byteLength) return undefined;
  let admission: E2EApplicationExecutionAdmission;
  try { admission = decodeE2EApplicationExecutionAdmission(admissionBytes); } catch { return undefined; }
  const loaded = await loadApplicationEvidenceInputs(deps, operation, reference, admission);
  if ("unavailable" in loaded) return undefined;
  return verifyBaselineEvidence({ admissionBytes, subject: { taskId: reference.taskId, operationId: operation.id, operationFence: operation.fence, workflowRevision: reference.workflowRevision,
    candidateDigest: reference.candidateDigest, roundId: reference.roundId, groupRunIds: reference.groupRunIds, admissionSha256: reference.admissionRef.sha256 },
  aggregate: loaded.aggregate, groupEvidence: loaded.groupEvidence, receivedAt: loaded.receivedAt, terminalStatus: "SUCCEEDED", ...(skippedAiScenarios === undefined ? {} : { skippedAiScenarios }) });
}

/**
 * The audit replay's own completion. When its operation ends, this settles the replay's record, and does nothing else: no workflow transition, no `qualifiedRound` or
 * `failedRound`, no send-back, no publication, no task page. An operation that did not succeed leaves the record saying the replay could not be run; one that succeeded is verified exactly
 * as a candidate's evidence is read (`loadApplicationEvidenceInputs`, then the verifier for the purpose it was signed with), and only that verification is recorded, conditionally, on the
 * source round, attempt, operation, round and admission the record started. It never throws: whatever goes wrong here, the replay is a record that stays STARTED and is read as not run
 * once its time is up.
 */
export async function settleReplayRound(deps: E2EVerificationDeps, operation: OperationRecord, status: OperationStatus): Promise<void> {
  const reference = operation.workflowE2EAdmission;
  if (operation.kind !== "task" || reference?.purpose !== "replay" || reference.sourceRoundId === undefined || reference.attempt === undefined) return;
  try {
    const task = await deps.readTask(reference.taskId);
    if (task === undefined || task.workspaceId !== operation.workspaceId) return;
    const round = { sourceRoundId: reference.sourceRoundId, attempt: reference.attempt };
    const record = await readWorkflowE2EReplayRecord(deps.state, task.taskId, round);
    if (record === undefined || record.state !== "STARTED" || record.operationId !== operation.id) return;
    const unavailable = (reason: ReplayUnavailableReason) => markWorkflowE2EReplayUnavailable(deps.state, task.taskId ? task : task, round, reason, { from: ["STARTED"], operationId: operation.id });
    if (status !== "SUCCEEDED") { await unavailable(status === "CANCELLED" ? "stopped" : "run-failed"); return; }
    const verified = await verifyReplayRound(deps, operation, reference);
    if (verified === undefined) { await unavailable("unverified"); return; }
    await recordWorkflowE2EReplay(deps.state, task, { verified, expected: { ...round, operationId: operation.id, roundId: reference.roundId, admissionSha256: reference.admissionRef.sha256 } });
  } catch (error) {
    console.log(JSON.stringify({ component: "broker", event: "workflow.e2e_replay_settle_failed", taskId: reference.taskId, operationId: operation.id, errorName: error instanceof Error ? error.name : "unknown" }));
  }
}

/** The broker's own verification of a finished replay round's evidence, or undefined when the admission or the evidence cannot be read or verify to nothing. */
async function verifyReplayRound(deps: E2EVerificationDeps, operation: OperationRecord, reference: E2EWorkflowAdmissionRef) {
  const admissionText = await readText(deps.objects, reference.admissionRef.key, WORKFLOW_E2E_ADMISSION_MAX_BYTES);
  if (admissionText === undefined) return undefined;
  const admissionBytes = Buffer.from(admissionText, "utf8");
  if (createHash("sha256").update(admissionBytes).digest("hex") !== reference.admissionRef.sha256 || admissionBytes.byteLength !== reference.admissionRef.byteLength) return undefined;
  let admission: E2EApplicationExecutionAdmission;
  try { admission = decodeE2EApplicationExecutionAdmission(admissionBytes); } catch { return undefined; }
  if (admission.replay === undefined) return undefined;
  const loaded = await loadApplicationEvidenceInputs(deps, operation, reference, admission);
  if ("unavailable" in loaded) return undefined;
  return verifyReplayEvidence({ admissionBytes, subject: { taskId: reference.taskId, operationId: operation.id, operationFence: operation.fence, workflowRevision: reference.workflowRevision,
    candidateDigest: reference.candidateDigest, roundId: reference.roundId, groupRunIds: reference.groupRunIds, admissionSha256: reference.admissionRef.sha256 },
  aggregate: loaded.aggregate, groupEvidence: loaded.groupEvidence, receivedAt: loaded.receivedAt, terminalStatus: "SUCCEEDED", replay: admission.replay });
}

/**
 * The grounding round's own completion. When its operation ends, this settles the grounding record, and does nothing else: no workflow transition, no `qualifiedRound` or `failedRound`,
 * no send-back, no publication, no model spend. An operation that did not succeed leaves the record saying the plan could not be checked on the current app (a fixed reason); one that
 * succeeded is verified exactly as a candidate's evidence is read (`loadApplicationEvidenceInputs`, then the verifier for the purpose it was signed with, bound to the plan digest and base
 * commit recomputed from the record), and only that verification is recorded, conditionally, on the plan artifact, base commit, attempt, operation, round and admission the record started.
 * It never throws: whatever goes wrong here, the record stays STARTED and is read as not run once its time is up. Whoever holds the plan's card back reads the record afterwards.
 */
export async function settleGroundingRound(deps: E2EVerificationDeps, operation: OperationRecord, status: OperationStatus): Promise<void> {
  const reference = operation.workflowE2EAdmission;
  if (operation.kind !== "task" || reference?.purpose !== "grounding" || reference.baseCommitSha === undefined || reference.attempt === undefined || reference.planArtifactSha256 === undefined) return;
  try {
    const task = await deps.readTask(reference.taskId);
    if (task === undefined || task.workspaceId !== operation.workspaceId) return;
    const ref = { taskId: task.taskId, planArtifactSha256: reference.planArtifactSha256, attempt: reference.attempt };
    const record = await readWorkflowE2EGroundingRecord(deps.state, ref);
    if (record === undefined || record.state !== "STARTED" || record.operationId !== operation.id) return;
    const unavailable = (reason: GroundingUnavailableReason) => markWorkflowE2EGroundingUnavailable(deps.state, ref, reason, { from: ["STARTED"], operationId: operation.id });
    if (status !== "SUCCEEDED") { await unavailable(status === "CANCELLED" ? "stopped" : "run-failed"); return; }
    const verified = await verifyGroundingRound(deps, operation, reference, record);
    if (verified === undefined) { await unavailable("unverified"); return; }
    await recordWorkflowE2EGrounding({ ...deps.state, objects: deps.objects }, task, ref,
      { verified, expected: { operationId: operation.id, roundId: reference.roundId, admissionSha256: reference.admissionRef.sha256, baseCommitSha: reference.baseCommitSha } });
  } catch (error) {
    console.log(JSON.stringify({ component: "broker", event: "workflow.e2e_grounding_settle_failed", taskId: reference.taskId, operationId: operation.id, errorName: error instanceof Error ? error.name : "unknown" }));
  }
}

/** The broker's own verification of a finished grounding round's evidence, or undefined when the admission or the evidence cannot be read or verify to no rows. */
async function verifyGroundingRound(deps: E2EVerificationDeps, operation: OperationRecord, reference: E2EWorkflowAdmissionRef, record: GroundingRecord) {
  const admissionText = await readText(deps.objects, reference.admissionRef.key, WORKFLOW_E2E_ADMISSION_MAX_BYTES);
  if (admissionText === undefined || reference.baseCommitSha === undefined || reference.attempt === undefined) return undefined;
  const admissionBytes = Buffer.from(admissionText, "utf8");
  if (createHash("sha256").update(admissionBytes).digest("hex") !== reference.admissionRef.sha256 || admissionBytes.byteLength !== reference.admissionRef.byteLength) return undefined;
  let admission: E2EApplicationExecutionAdmission;
  try { admission = decodeE2EApplicationExecutionAdmission(admissionBytes); } catch { return undefined; }
  const loaded = await loadApplicationEvidenceInputs(deps, operation, reference, admission);
  if ("unavailable" in loaded) return undefined;
  const planDigest = groundingPlanDigest({ taskId: reference.taskId, artifactId: record.planArtifactId, artifactSha256: record.planArtifactSha256, workflowRevision: reference.workflowRevision,
    baseCommitSha: reference.baseCommitSha, attempt: reference.attempt });
  return verifyGroundingEvidence({ admissionBytes, subject: { taskId: reference.taskId, operationId: operation.id, operationFence: operation.fence, workflowRevision: reference.workflowRevision,
    candidateDigest: reference.candidateDigest, roundId: reference.roundId, groupRunIds: reference.groupRunIds, admissionSha256: reference.admissionRef.sha256 },
  aggregate: loaded.aggregate, groupEvidence: loaded.groupEvidence, receivedAt: loaded.receivedAt, terminalStatus: "SUCCEEDED", grounding: { planDigest, baseCommitSha: reference.baseCommitSha } });
}


/** A round that is not the candidate's: the unchanged code (baseline), an audit replay, or the check of a plan against the current app (grounding). None of them can pass or fail a candidate. */
export const isNonCandidateRound = (reference: { purpose?: "baseline" | "replay" | "grounding" | undefined } | undefined): boolean =>
  reference?.purpose === "baseline" || reference?.purpose === "grounding" || reference?.purpose === "replay";

/** Settles the record of a baseline, replay or grounding round whose operation ended; any other operation is not this function's. Never throws. */
export async function settleNonCandidateRound(deps: E2EVerificationDeps, operation: OperationRecord, status: OperationStatus): Promise<boolean> {
  const purpose = operation.workflowE2EAdmission?.purpose;
  if (purpose === "baseline") await settleBaselineRound(deps, operation, status);
  else if (purpose === "replay") await settleReplayRound(deps, operation, status);
  else if (purpose === "grounding") await settleGroundingRound(deps, operation, status);
  else return false;
  return true;
}
