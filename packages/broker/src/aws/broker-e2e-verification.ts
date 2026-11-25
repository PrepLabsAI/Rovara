// E2E evidence verification, current-authority checks, baseline/replay/grounding settlement,
// and task E2E presentation loaders (extracted and decomposed from aws/broker.ts).
import { createHash } from "node:crypto";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { z } from "zod";
import {
  AgentXError,
  CandidateManifestSchema,
  E2EApplicationPlanIntentSchema,
  E2EApplicationSelectionRecordSchema,
  E2EPolicySchema,
  E2ERoundSchema,
  E2ERunBindingSchema,
  E2EScenarioBundleSchema,
  E2ESharedViewSchema,
  E2EWorkflowGroupEvidenceRefSchema,
  E2E_ANONYMOUS_ACCOUNT_PROFILE_ID,
  ProjectSetupRunnerEnvironmentSchema,
  ProjectSetupRunnerToolchainSchema,
  agentXError,
  buildE2ESharedView,
  canonicalJson,
  type createCandidateManifest,
  cutEvidenceReason,
  e2eAnonymousTargetId,
  e2eAnonymousVariantOf,
  e2ePlanHasCompleteRequiredCriteria,
  e2eScenarioBundleDigest,
  isE2EApplicationAdmissionSchemaVersion,
  verifyE2ESourceSnapshot,
  type DeveloperTaskView,
  type E2EApplicationExecutionAdmission,
  type E2EApplicationPlanIntent,
  type E2EApplicationSelectionRecord,
  type E2EPolicy,
  type E2ERegisteredRuntime,
  type E2ERuntimeAccountRef,
  type E2EScenarioResults,
  type E2ESetupProposal,
  type E2ESharedView,
  type E2ESourceSnapshot,
  type E2EWorkflowAdmissionRef,
  type OperationStatus,
  type PlanApprovalRef,
} from "@agentx/contracts";
import { selectE2EExecutionPlan } from "@agentx/contracts/e2e-execution-plan";
import {
  collectE2EActualCliRun,
  compileE2EScenarios,
  decodeE2EApplicationExecutionAdmission,
  e2ePrivateTransferMaxBytes,
  e2eSnapshotSourceDigest,
  parseE2EFirstPartyCapture,
  qualifyE2ECollection,
} from "@agentx/verifier";
import type { TaskRecord as CoreApplicationTaskRecord } from "../core/task-flow/records.js";
import { loadWorkflowDocument, readObjectText as readStoredText } from "../developer/plan-artifacts.js";
import type { DeveloperRecord } from "../developer/store.js";
import { taskKey, type DeveloperTaskRecord } from "../developer/task-records.js";
import {
  renderE2EMcpProjection,
  renderE2ENotifierSlackBlocks,
  renderE2EPageHtml,
  renderE2EScenarioRowsHtml,
  renderE2EScenarioSlackBlocks,
  renderE2ESlackBlocks,
} from "../e2e-presentation.js";
import type { E2EAccountRegistryEntry } from "../e2e/application-account-registry.js";
import { groundingPlanDigest } from "../e2e/application-admission.js";
import { applicationSelectionStillCurrent } from "../e2e/application-dispatch-check.js";
import type { DisplayArtifact } from "../e2e/application-display.js";
import { applicationEvidenceLimits, modelRouteForAdmission, verifyApplicationE2EEvidence } from "../e2e/application-evidence.js";
import {
  applicationIntentDigest,
  applicationIntentWithAccountRefs,
  applicationRoundIntent,
  type ApplicationAccountsInput,
  type ApplicationRefusalScope,
} from "../e2e/application-plan-approval.js";
import { deriveE2EFeatureExecutionAdmission } from "../e2e/feature-plan-intent.js";
import { portableFeatureIntentOf } from "../e2e/portable-feature-intent.js";
import { queryAllItems } from "./admin-reads.js";
import { getItem, operationKey, type OperationRecord } from "./cancellation.js";
import { readTaskLegacyProject, resolveCompany } from "./company-check.js";
import { grantKeyFor, namedCompany } from "./company-layout.js";
import { checkProjectAccess } from "./developer-routes.js";
import type { TransactItems } from "./developer-task-actions.js";
import {
  E2EFeatureVerifierRecordSchema,
  E2E_FEATURE_PROCESS_RESPONSE_SCOPE,
  admitE2EFeatureVerifier,
  e2eFeatureVerifierKey,
} from "./e2e-feature-verifier-catalog.js";
import { parseRuntimeBinding } from "./lambda.js";
import { projectKey, requireProject } from "./project-records.js";
import { projectSetupBindingDigest } from "./project-setup-runtime-catalog.js";
import {
  loadStoredScenarioResults,
  loadWorkflowE2EArtifact as loadStoredWorkflowE2EArtifact,
} from "./workflow-e2e-artifacts.js";
import {
  markWorkflowE2EBaselineUnavailable,
  readWorkflowE2EBaseline,
  readWorkflowE2EBaselineRecord,
  recordWorkflowE2EBaseline,
  verifyBaselineEvidence,
  type BaselineUnavailableReason,
  type SkippedAiScenarios,
} from "./workflow-e2e-baseline.js";
import { resolveWorkflowE2ECanonicalApproval, workflowE2ECurrentAuthorityMatches } from "./workflow-e2e-current-authority.js";
import {
  markWorkflowE2EGroundingUnavailable,
  readWorkflowE2EGroundingRecord,
  recordWorkflowE2EGrounding,
  verifyGroundingEvidence,
  type GroundingRecord,
  type GroundingUnavailableReason,
} from "./workflow-e2e-grounding.js";
import { readWorkflowE2ENotifierProjection } from "./workflow-e2e-notifier-projection.js";
import {
  markWorkflowE2EReplayUnavailable,
  readWorkflowE2EReplayRecord,
  recordWorkflowE2EReplay,
  verifyReplayEvidence,
  type ReplayUnavailableReason,
} from "./workflow-e2e-replay.js";
import {
  requireLatestProject,
  slackBindingKey,
  slackCallerRouteDependencies,
  storedCompanyOf,
  taskLegacyScope,
} from "./broker-primitives.js";
import {
  MAX_WORKFLOW_CANDIDATE_EXPORT_BYTES,
  type AuthorityMark,
  type AuthorityReject,
  type AwsBrokerDependencies,
  type WorkflowE2EProjection,
  type WorkflowE2EVerificationDiagnostic,
} from "./broker-types.js";

export const WORKFLOW_E2E_ADMISSION_MAX_BYTES = 24 * 1024 * 1024;
const APPLICATION_VERDICT_REASON_MAX_CHARS = 240;

/** What deriving a task's application selection against the approved setup and the runtime rows READY right now came to. */
export type ApplicationSelectionNow =
  | {
    ok: true;
    selection: E2EApplicationSelectionRecord;
    conditions: TransactItems;
    inputs: {
      policy: E2EPolicy;
      setup: { snapshot: E2ESourceSnapshot; setupProposal: E2ESetupProposal; setupApproval: PlanApprovalRef };
      rows: E2ERegisteredRuntime[];
      runtimeCatalogId: string;
      runtimeBinding: ReturnType<typeof parseRuntimeBinding>;
      accountEntries: E2EAccountRegistryEntry[];
    };
  }
  | { ok: false; kind: "unevaluable" | "refused"; reason: string; scope?: ApplicationRefusalScope };

export interface E2EVerificationHooks {
  ensureProjectCatalogPointer: (dependencies: AwsBrokerDependencies, projectName: string, task?: { companyId?: unknown }) => Promise<void>;
  catalogKeyFor: (projectName: string) => { pk: string; sk: string };
  evaluateWorkflowE2EApplicationSelectionNow: (
    dependencies: AwsBrokerDependencies,
    task: DeveloperTaskRecord,
    intent: E2EApplicationPlanIntent,
    artifact: { id: string; sha256: string },
    accounts: { mode: ApplicationAccountsInput["mode"]; pinned: readonly E2ERuntimeAccountRef[] },
  ) => Promise<ApplicationSelectionNow>;
}

export function workflowCandidateSourceExportSchema() {
  return z.object({
    schemaVersion: z.literal("workflow-candidate-source/v1"),
    candidate: CandidateManifestSchema,
    repositories: z.array(z.object({
      repositoryId: z.string().min(1).max(200),
      commitSha: z.string().regex(/^[a-f0-9]{40}$/),
      treeSha: z.string().regex(/^[a-f0-9]{40}$/),
      baseCommitSha: z.string().regex(/^[a-f0-9]{40}$/).optional(),
      treeComplete: z.literal(true),
      treePaths: z.array(z.string().min(1).max(1024)).max(100_000),
      sources: z.array(z.object({
        path: z.string().min(1).max(1024),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        bytesBase64: z.string().max(700_000),
        kind: z.literal("blob"),
      }).strict()).max(512),
    }).strict()).max(32),
  }).strict();
}

/** Reads the original creator from its authoritative, separately scoped sign-in table. */
export async function getWorkflowE2ECreatorIdentity(
  dependencies: AwsBrokerDependencies,
  developerId: string,
): Promise<Pick<DeveloperRecord, "revoked" | "slackUserId"> & { entityType?: unknown } | undefined> {
  const signInTableName = dependencies.developer?.signInTableName;
  if (signInTableName === undefined) return undefined;
  const response = await dependencies.documentClient.send(new GetCommand({
    TableName: signInTableName,
    Key: { pk: `DEVELOPER#${developerId}`, sk: "META" },
    ConsistentRead: true,
  })) as unknown as { Item?: Pick<DeveloperRecord, "revoked" | "slackUserId"> & { entityType?: unknown } };
  return response.Item?.entityType === "DEVELOPER" ? response.Item : undefined;
}

/** The newest IMPLEMENT operation that exported the given candidate's committed source. */
export async function candidateSourceOperation(
  dependencies: AwsBrokerDependencies,
  task: DeveloperTaskRecord,
  candidateDigest: string,
): Promise<OperationRecord | undefined> {
  return (await queryAllItems(dependencies, `WORKSPACE#${task.workspaceId}`, "OPERATION#"))
    .filter((item) => item.entityType === "OPERATION" && item.kind === "task" && item.workflowMode === "IMPLEMENT")
    .map((item) => item as unknown as OperationRecord)
    .filter((operation) => operation.candidateSourceRef?.candidateDigest === candidateDigest)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
}

export async function readStoredCandidateSourceExport(
  dependencies: AwsBrokerDependencies,
  reference: NonNullable<OperationRecord["candidateSourceRef"]>,
): Promise<z.infer<ReturnType<typeof workflowCandidateSourceExportSchema>> | undefined> {
  if (reference.byteLength <= 0 || reference.byteLength > MAX_WORKFLOW_CANDIDATE_EXPORT_BYTES || !/^[a-f0-9]{64}$/.test(reference.sha256)) return undefined;
  const text = await readStoredText(dependencies.s3, dependencies.artifactBucketName, reference.key, MAX_WORKFLOW_CANDIDATE_EXPORT_BYTES);
  if (text === undefined) return undefined;
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength !== reference.byteLength || createHash("sha256").update(bytes).digest("hex") !== reference.sha256) return undefined;
  const parsed = workflowCandidateSourceExportSchema().safeParse(JSON.parse(text) as unknown);
  return parsed.success ? parsed.data : undefined;
}

export async function loadWorkflowCandidateSourceExport(
  dependencies: AwsBrokerDependencies,
  operation: OperationRecord,
  expectedCandidate: ReturnType<typeof createCandidateManifest>,
): Promise<z.infer<ReturnType<typeof workflowCandidateSourceExportSchema>> | undefined> {
  const reference = operation.candidateSourceRef;
  if (!reference || reference.candidateDigest !== expectedCandidate.digest) return undefined;
  const parsed = await readStoredCandidateSourceExport(dependencies, reference);
  if (parsed === undefined || parsed.candidate.digest !== expectedCandidate.digest
    || canonicalJson(parsed.candidate) !== canonicalJson(expectedCandidate)) return undefined;
  return parsed;
}

// ---------------------------------------------------------------------------
// Portable & application E2E verification
// ---------------------------------------------------------------------------

function sha256Hex(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function terminalOperationMatchesReference(
  operation: OperationRecord,
  task: DeveloperTaskRecord,
  candidateDigest: string,
  reference: E2EWorkflowAdmissionRef,
  round: ReturnType<typeof E2ERoundSchema.parse>,
): boolean {
  if (operation.kind !== "task" || operation.workflowMode !== "CHECKS") return false;
  if (operation.status !== "SUCCEEDED" && operation.status !== "FAILED") return false;
  const evidence = operation.workflowE2EEvidenceRef;
  if (operation.workflowE2EAdmission === undefined || evidence === undefined) return false;
  if (canonicalJson(operation.workflowE2EAdmission) !== canonicalJson(reference)) return false;
  if (evidence.key !== `workflow-e2e-evidence/sha256/${evidence.sha256}.json`) return false;
  if (reference.taskId !== task.taskId || reference.candidateDigest !== candidateDigest) return false;
  if (reference.roundId !== round.roundId || reference.workflowRevision !== round.workflowRevision) return false;
  if (canonicalJson(reference.groupRunIds) !== canonicalJson(round.groupBindings.map((b) => b.runId))) return false;
  const opRuns = operation.workflowE2EGroupRunIds ?? [];
  return new Set(opRuns).size === reference.groupRunIds.length
    && canonicalJson([...opRuns].sort()) === canonicalJson([...reference.groupRunIds].sort());
}

function workflowE2ETerminalReceiptAt(
  operation: OperationRecord,
  task: DeveloperTaskRecord,
  candidateDigest: string,
  reference: E2EWorkflowAdmissionRef,
  round: ReturnType<typeof E2ERoundSchema.parse>,
  allowStaleProjection: boolean,
): { at: string; outcome: "PASS" | "FAILED" } | undefined {
  if (!terminalOperationMatchesReference(operation, task, candidateDigest, reference, round)) return undefined;
  const receiptTime = Date.parse(operation.updatedAt);
  if (!Number.isFinite(receiptTime) || new Date(receiptTime).toISOString() !== operation.updatedAt || receiptTime > Date.parse(round.deadlineAt)) {
    return undefined;
  }
  const evidenceSha = operation.workflowE2EEvidenceRef!.sha256;
  const workflowE2E = task.workflow?.e2e;
  if (operation.status === "SUCCEEDED" && !allowStaleProjection) {
    const qualified = workflowE2E?.qualifiedRound;
    const matches = workflowE2E !== undefined && qualified !== undefined && qualified.candidateDigest === candidateDigest
      && qualified.roundId === reference.roundId && canonicalJson(qualified.groupRunIds) === canonicalJson(reference.groupRunIds)
      && qualified.admissionSha256 === reference.admissionRef.sha256 && qualified.evidenceSha256 === evidenceSha
      && qualified.contractDigest === workflowE2E.contractDigest && qualified.policyDigest === workflowE2E.policyDigest
      && qualified.bundleDigest === workflowE2E.bundleDigest && qualified.executionPlanDigest === workflowE2E.executionPlanDigest
      && workflowE2E.currentRoundId === qualified.roundId && canonicalJson(workflowE2E.currentGroupRunIds) === canonicalJson(qualified.groupRunIds);
    return matches ? { at: operation.updatedAt, outcome: "PASS" } : undefined;
  }
  const failed = workflowE2E?.failedRound;
  const matches = allowStaleProjection && failed?.status === "FAILED" && failed.candidateDigest === candidateDigest
    && failed.roundId === reference.roundId && canonicalJson(failed.groupRunIds) === canonicalJson(reference.groupRunIds)
    && failed.admissionSha256 === reference.admissionRef.sha256 && failed.evidenceSha256 === evidenceSha;
  return matches ? { at: operation.updatedAt, outcome: "FAILED" } : undefined;
}

function parseAdmittedSourceSnapshot(sourceRecord: unknown): E2ESourceSnapshot | undefined {
  const rec = sourceRecord as Record<string, unknown> | undefined;
  if (!rec || !Array.isArray(rec.sources)) return undefined;
  const sources = rec.sources.map((raw) => {
    const row = raw as Record<string, unknown>;
    if (typeof row.path !== "string" || typeof row.sha256 !== "string" || row.kind !== "blob" || typeof row.bytesBase64 !== "string") {
      throw new Error("invalid source row");
    }
    const bytes = Buffer.from(row.bytesBase64, "base64");
    if (bytes.toString("base64") !== row.bytesBase64) throw new Error("invalid source encoding");
    return { path: row.path, sha256: row.sha256, kind: "blob" as const, bytes };
  });
  return { ...rec, sources } as unknown as E2ESourceSnapshot;
}

function indexAggregateGroupRuns(aggregateGroupRuns: unknown): Map<string, Record<string, unknown>> | { unavailable: string } {
  const aggregateByRun = new Map<string, Record<string, unknown>>();
  if (!Array.isArray(aggregateGroupRuns)) return aggregateByRun;
  for (const raw of aggregateGroupRuns) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { unavailable: "aggregate-group-result-shape" };
    const run = raw as Record<string, unknown>;
    const binding = run.binding as Record<string, unknown> | undefined;
    if (typeof binding?.runId !== "string" || aggregateByRun.has(binding.runId)) return { unavailable: "aggregate-group-result-identity" };
    aggregateByRun.set(binding.runId, run);
  }
  return aggregateByRun;
}

function validateGroupEvidenceRefList(
  groupEvidenceRefs: readonly unknown[],
  groupEvidenceRunIds: readonly string[],
  expectedRunIds: readonly string[],
): boolean {
  if (groupEvidenceRefs.length !== groupEvidenceRunIds.length) return false;
  if (canonicalJson(groupEvidenceRefs.map((raw) => E2EWorkflowGroupEvidenceRefSchema.parse(raw).groupRunId)) !== canonicalJson(groupEvidenceRunIds)) return false;
  if (new Set(groupEvidenceRunIds).size !== groupEvidenceRunIds.length) return false;
  return !groupEvidenceRunIds.some((runId) => !expectedRunIds.includes(runId));
}

function portableGroupEnvelopeMatches(input: {
  envelope: Record<string, unknown>;
  groupRun: Record<string, unknown>;
  reference: E2EWorkflowAdmissionRef;
  taskId: string;
  operation: OperationRecord;
  candidateDigest: string;
  round: ReturnType<typeof E2ERoundSchema.parse>;
  planGroup: unknown;
  index: number;
}): boolean {
  const { envelope, groupRun, reference, taskId, operation, candidateDigest, round, planGroup, index } = input;
  return envelope.schemaVersion === "workflow-e2e-group-evidence/v1"
    && envelope.admissionSha256 === reference.admissionRef.sha256
    && envelope.taskId === taskId && envelope.operationId === operation.id && envelope.operationFence === operation.fence
    && envelope.workflowRevision === reference.workflowRevision && envelope.candidateDigest === candidateDigest
    && canonicalJson(envelope.round) === canonicalJson(round)
    && canonicalJson(groupRun.binding) === canonicalJson(round.groupBindings[index])
    && canonicalJson(groupRun.group) === canonicalJson(planGroup);
}

async function loadAcceptedPortableGroupRuns(input: {
  dependencies: AwsBrokerDependencies;
  operation: OperationRecord;
  taskId: string;
  candidateDigest: string;
  reference: E2EWorkflowAdmissionRef;
  round: ReturnType<typeof E2ERoundSchema.parse>;
  planGroups: readonly unknown[];
  groupAdmissions: ReadonlyArray<Record<string, unknown>>;
  groupEvidenceRefs: readonly unknown[];
  hasAggregate: boolean;
  aggregateByRun: Map<string, Record<string, unknown>>;
}): Promise<Map<string, Record<string, unknown>> | { unavailable: string }> {
  const { dependencies, operation, taskId, candidateDigest, reference, round, planGroups, groupAdmissions, groupEvidenceRefs, hasAggregate, aggregateByRun } = input;
  const groupRunsById = new Map<string, Record<string, unknown>>();
  for (const raw of groupEvidenceRefs) {
    const parsedRef = E2EWorkflowGroupEvidenceRefSchema.safeParse(raw);
    if (!parsedRef.success) return { unavailable: "accepted-group-reference-schema" };
    const { groupRunId, evidenceRef: storedGroupRef } = parsedRef.data;
    const index = reference.groupRunIds.indexOf(groupRunId);
    if (index < 0 || groupRunsById.has(groupRunId) || storedGroupRef.key !== `workflow-e2e-group-evidence/sha256/${storedGroupRef.sha256}.json`) {
      return { unavailable: "accepted-group-reference-subject" };
    }
    const expectedCaseCount = groupAdmissions[index]?.expectedCases;
    if (!Array.isArray(expectedCaseCount)) return { unavailable: "admitted-group-case-count" };
    const groupText = await readStoredText(dependencies.s3, dependencies.artifactBucketName, storedGroupRef.key,
      Math.min(WORKFLOW_E2E_ADMISSION_MAX_BYTES, e2ePrivateTransferMaxBytes(expectedCaseCount.length, 1)));
    if (groupText === undefined || Buffer.byteLength(groupText) !== storedGroupRef.byteLength || sha256Hex(groupText) !== storedGroupRef.sha256) {
      return { unavailable: "accepted-group-evidence-integrity" };
    }
    const envelope = JSON.parse(groupText) as Record<string, unknown>;
    const groupRun = envelope.groupRun as Record<string, unknown> | undefined;
    if (!groupRun || !portableGroupEnvelopeMatches({ envelope, groupRun, reference, taskId, operation, candidateDigest, round, planGroup: planGroups[index], index })) {
      return { unavailable: "accepted-group-evidence-subject" };
    }
    const aggregateRun = aggregateByRun.get(groupRunId);
    if (hasAggregate && (aggregateRun === undefined || canonicalJson(aggregateRun) !== canonicalJson(groupRun))) {
      return { unavailable: "aggregate-group-evidence-mismatch" };
    }
    groupRunsById.set(groupRunId, groupRun);
  }
  return groupRunsById;
}

function parseHostRequestIds(rawEntries: unknown, expectedSize: number): Map<string, string> | { unavailable: string } {
  if (!Array.isArray(rawEntries)) return { unavailable: "compiled-selection-or-host-request-list" };
  const hostRequestIds = new Map<string, string>();
  for (const entry of rawEntries) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || typeof entry[1] !== "string" || hostRequestIds.has(entry[0])) {
      return { unavailable: "host-request-identity-list" };
    }
    hostRequestIds.set(entry[0], entry[1]);
  }
  return hostRequestIds.size === expectedSize ? hostRequestIds : { unavailable: "host-request-count" };
}

function parseActualCliCapture(rawActual: Record<string, unknown> | undefined, runnerToolchain: unknown): { actual: never; rawActual: Record<string, unknown> } | { unavailable: string } {
  if (!rawActual || typeof rawActual.launchId !== "string" || typeof rawActual.rawReportBase64 !== "string" || typeof rawActual.runStartCaptureBase64 !== "string"
    || canonicalJson(rawActual.runnerToolchain) !== canonicalJson(runnerToolchain) || !Array.isArray(rawActual.candidateCaptures)
    || !Array.isArray(rawActual.assertionReceipts) || typeof rawActual.cleanupConfirmed !== "boolean" || typeof rawActual.cleanupServerListening !== "boolean") {
    return { unavailable: "actual-run-capture-shape-or-toolchain" };
  }
  const rawReportBytes = Buffer.from(rawActual.rawReportBase64, "base64");
  const runStartCaptureBytes = Buffer.from(rawActual.runStartCaptureBase64, "base64");
  if (rawReportBytes.toString("base64") !== rawActual.rawReportBase64 || runStartCaptureBytes.toString("base64") !== rawActual.runStartCaptureBase64) {
    return { unavailable: "actual-run-capture-encoding" };
  }
  const actual = {
    ...rawActual,
    rawReportBytes: new Uint8Array(rawReportBytes),
    runStartCaptureBytes: new Uint8Array(runStartCaptureBytes),
    runStartCapture: parseE2EFirstPartyCapture(runStartCaptureBytes, rawActual.launchId),
    evidenceDirectory: "",
  } as never;
  return { actual, rawActual };
}

function processSucceeded(proc: Record<string, unknown> | undefined): boolean {
  return proc?.status === 0 && proc.signal === null && proc.aborted === false && proc.timedOut === false;
}

function collectSinglePortableGroupRun(input: {
  index: number;
  group: ReturnType<typeof selectE2EExecutionPlan>["groups"][number];
  admitted: Record<string, unknown> | undefined;
  run: Record<string, unknown> | undefined;
  bundle: ReturnType<typeof E2EScenarioBundleSchema.parse>;
  plan: ReturnType<typeof selectE2EExecutionPlan>;
  selectionInput: Record<string, unknown>;
  round: ReturnType<typeof E2ERoundSchema.parse>;
  reference: E2EWorkflowAdmissionRef;
  taskId: string;
  operation: OperationRecord;
  candidateDigest: string;
  snapshot: E2ESourceSnapshot;
  semanticApprovalDigests: Map<string, string>;
  runnerEnvironment: ReturnType<typeof ProjectSetupRunnerEnvironmentSchema.parse>;
  runnerToolchain: ReturnType<typeof ProjectSetupRunnerToolchainSchema.parse>;
  terminalReceipt: { at: string; outcome: "PASS" | "FAILED" } | undefined;
}): { status: "PASS" | "FAILED" | "UNKNOWN"; projectionResult?: unknown } | { unavailable: string } {
  const { index, group, admitted, run, bundle, plan, selectionInput, round, reference, taskId, operation, candidateDigest, snapshot, semanticApprovalDigests, runnerEnvironment, runnerToolchain, terminalReceipt } = input;
  if (!admitted || canonicalJson(admitted.group) !== canonicalJson(group)) return { unavailable: "admitted-group-identity" };
  const compiled = compileE2EScenarios(bundle, plan.effectiveTargets, group, { selectionInput, executionPlan: plan, group } as never);
  if (admitted.expectedConfigDigest !== compiled.expectedConfigDigest || admitted.compiledInventoryDigest !== compiled.inventory.digest
    || admitted.selectionPacketPath !== compiled.selectionPacketPath || canonicalJson(admitted.expectedCases) !== canonicalJson(compiled.expectedCases)) {
    return { unavailable: "compiled-group-expectations" };
  }
  const binding = E2ERunBindingSchema.parse(admitted.binding);
  if (binding.runId !== reference.groupRunIds[index] || binding.taskId !== taskId || binding.operationId !== operation.id
    || binding.operationFence !== operation.fence || binding.workflowRevision !== reference.workflowRevision || binding.candidateDigest !== candidateDigest
    || binding.roundId !== reference.roundId || canonicalJson(round.groupBindings[index]) !== canonicalJson(binding)) {
    return { unavailable: "group-run-binding" };
  }
  if (run === undefined) return { status: "UNKNOWN" };
  if (canonicalJson(run.group) !== canonicalJson(group) || canonicalJson(run.binding) !== canonicalJson(binding)) return { unavailable: "group-run-result-binding" };
  const selection = JSON.parse(compiled.files.get(compiled.selectionPacketPath) ?? "null") as unknown;
  if (canonicalJson(run.selection) !== canonicalJson(selection)) return { unavailable: "compiled-selection-or-host-request-list" };
  const hostRequestIds = parseHostRequestIds(run.hostRequestIds, compiled.hostRequestPayloads.size);
  if ("unavailable" in hostRequestIds) return hostRequestIds;
  const parsedActual = parseActualCliCapture(run.actual as Record<string, unknown> | undefined, runnerToolchain);
  if ("unavailable" in parsedActual) return parsedActual;
  const { actual, rawActual } = parsedActual;
  const result = collectE2EActualCliRun({
    actual, compiled, binding, round, selection: selection as never,
    sourceDigest: e2eSnapshotSourceDigest(compiled, snapshot.sources.map(({ path, sha256 }) => ({ path, sha256 }))),
    semanticApprovalDigests, hostRequestIds,
    declaredMockComponentIds: Array.isArray(rawActual.declaredMockComponentIds) ? rawActual.declaredMockComponentIds as string[] : [],
    environment: runnerEnvironment,
    usage: { discoveredResults: Number(rawActual.selected) + Number(rawActual.filtered), maxAgentContextBytes: 0, maxLedgerBytes: 0, maxObservationBytes: 0, artifactBytes: 0, downloads: 0, events: 0, modelTokens: 0, maxModelCallsInStep: 0, maxActionStepsInStep: 0 },
    limits: { maxAgentContextBytes: 16_384, maxLedgerBytes: 8_192, maxObservationBytes: 262_144, maxEventsPerStep: 1_000, maxModelTokensPerCall: 64_000 },
  });
  const qualification = terminalReceipt !== undefined && result.collection !== null && result.oracle !== null
    ? qualifyE2ECollection(result.oracle, { ...result.collection, receivedAt: terminalReceipt.at })
    : result.qualification;
  const okProcess = processSucceeded(rawActual.runProcess as Record<string, unknown> | undefined);
  const projectionResult = qualification?.result != null
    ? { ...qualification.result, producer: "broker-independent-e2e-verifier", qualification: "trusted", ...(okProcess ? {} : { status: "failed", reason: "host-process-failed" }) }
    : undefined;
  const status: "PASS" | "FAILED" | "UNKNOWN" = !okProcess
    ? "FAILED"
    : terminalReceipt?.outcome === "FAILED" && qualification?.status !== "FAILED"
      ? "UNKNOWN"
      : (qualification?.status ?? "UNKNOWN");
  return { status, ...(projectionResult === undefined ? {} : { projectionResult }) };
}

function portableAdmissionAndEvidenceIntegrityValid(
  admissionText: string | undefined,
  evidenceText: string | undefined,
  reference: E2EWorkflowAdmissionRef,
  evidenceRef: OperationRecord["workflowE2EEvidenceRef"],
): boolean {
  if (admissionText === undefined || sha256Hex(admissionText) !== reference.admissionRef.sha256 || Buffer.byteLength(admissionText) !== reference.admissionRef.byteLength) {
    return false;
  }
  if (evidenceRef === undefined) return true;
  return evidenceText !== undefined
    && evidenceRef.key === `workflow-e2e-evidence/sha256/${evidenceRef.sha256}.json`
    && sha256Hex(evidenceText) === evidenceRef.sha256
    && Buffer.byteLength(evidenceText) === evidenceRef.byteLength;
}

function portableSubjectBindingValid(
  admission: Record<string, unknown>,
  evidence: Record<string, unknown> | undefined,
  reference: E2EWorkflowAdmissionRef,
  taskId: string,
  operation: OperationRecord,
  candidateDigest: string,
): boolean {
  if (admission.schemaVersion !== "workflow-e2e-admission/v1") return false;
  if (evidence === undefined) return true;
  return evidence.schemaVersion === "workflow-e2e-evidence/v1"
    && evidence.admissionSha256 === reference.admissionRef.sha256
    && evidence.taskId === taskId && evidence.operationId === operation.id && evidence.operationFence === operation.fence
    && evidence.workflowRevision === reference.workflowRevision && evidence.candidateDigest === candidateDigest;
}

function portablePlanAndRoundValid(input: {
  admission: Record<string, unknown>;
  plan: ReturnType<typeof selectE2EExecutionPlan>;
  bundle: ReturnType<typeof E2EScenarioBundleSchema.parse>;
  round: ReturnType<typeof E2ERoundSchema.parse>;
  groupAdmissions: ReadonlyArray<Record<string, unknown>>;
  reference: E2EWorkflowAdmissionRef;
  taskId: string;
  operation: OperationRecord;
  candidateDigest: string;
}): boolean {
  const { admission, plan, bundle, round, groupAdmissions, reference, taskId, operation, candidateDigest } = input;
  return admission.taskId === taskId && admission.operationId === operation.id && admission.operationFence === operation.fence
    && admission.workflowRevision === reference.workflowRevision && admission.candidateDigest === candidateDigest
    && round.roundId === reference.roundId && round.taskId === taskId && round.operationId === operation.id && round.operationFence === operation.fence
    && round.workflowRevision === reference.workflowRevision && plan.groups.length > 0 && plan.groups.length === groupAdmissions.length
    && plan.groups.length === reference.groupRunIds.length
    && canonicalJson(plan) === canonicalJson(admission.plan) && bundle.bundleDigest === e2eScenarioBundleDigest(bundle);
}

async function verifyPortableWorkflowE2EEvidence(input: {
  dependencies: AwsBrokerDependencies;
  hooks: E2EVerificationHooks;
  operation: OperationRecord;
  task: DeveloperTaskRecord;
  candidate: ReturnType<typeof CandidateManifestSchema.parse>;
  reference: E2EWorkflowAdmissionRef;
  admissionText: string | undefined;
  staleProjection: boolean;
  projection?: WorkflowE2EProjection | undefined;
  diagnostic?: WorkflowE2EVerificationDiagnostic | undefined;
  unavailable: (reason: string) => "UNKNOWN";
}): Promise<"PASS" | "FAILED" | "UNKNOWN"> {
  const { dependencies, hooks, operation, task, candidate, reference, admissionText, staleProjection, projection, diagnostic, unavailable } = input;
  const evidenceRef = operation.workflowE2EEvidenceRef;
  const groupEvidenceRefs = operation.workflowE2EGroupEvidenceRefs ?? [];
  const groupEvidenceRunIds = operation.workflowE2EGroupRunIds ?? [];
  const evidenceText = evidenceRef === undefined ? undefined
    : await readStoredText(dependencies.s3, dependencies.artifactBucketName, evidenceRef.key, WORKFLOW_E2E_ADMISSION_MAX_BYTES);
  if (!portableAdmissionAndEvidenceIntegrityValid(admissionText, evidenceText, reference, evidenceRef)) return unavailable("admission-or-evidence-reference-integrity");
  const admission = JSON.parse(admissionText!) as Record<string, unknown>;
  const evidence = evidenceText === undefined ? undefined : JSON.parse(evidenceText) as Record<string, unknown>;
  if (!portableSubjectBindingValid(admission, evidence, reference, task.taskId, operation, candidate.digest)) return unavailable("admission-or-evidence-subject-binding");
  const snapshot = parseAdmittedSourceSnapshot(admission.sourceSnapshot);
  if (snapshot === undefined) return unavailable("admitted-source-snapshot-shape");
  verifyE2ESourceSnapshot(snapshot, candidate);
  E2EPolicySchema.parse(admission.policy);
  const selectionInput = { ...(admission.selectionInput as Record<string, unknown>), sourceSnapshot: snapshot };
  const plan = selectE2EExecutionPlan(selectionInput as never);
  const bundle = E2EScenarioBundleSchema.parse(admission.bundle);
  const round = E2ERoundSchema.parse(admission.round);
  const runtime = admission.runtime as Record<string, unknown>;
  const runnerEnvironment = ProjectSetupRunnerEnvironmentSchema.parse(runtime.runnerEnvironment);
  const runnerToolchain = ProjectSetupRunnerToolchainSchema.parse(runtime.runnerToolchain);
  const groupAdmissions = admission.groupAdmissions as Array<Record<string, unknown>>;
  if (!portablePlanAndRoundValid({ admission, plan, bundle, round, groupAdmissions, reference, taskId: task.taskId, operation, candidateDigest: candidate.digest })) {
    return unavailable("current-plan-round-or-group-binding");
  }
  const aggregateGroupRuns = evidence?.groupRuns;
  if (evidence !== undefined && (!Array.isArray(aggregateGroupRuns) || aggregateGroupRuns.length !== reference.groupRunIds.length)) return unavailable("aggregate-group-results-incomplete");
  if (!validateGroupEvidenceRefList(groupEvidenceRefs, groupEvidenceRunIds, reference.groupRunIds)) return unavailable("accepted-group-reference-list-invalid");
  if (evidence === undefined && groupEvidenceRefs.length === 0) return unavailable("group-results-not-yet-accepted");
  const aggregateByRun = indexAggregateGroupRuns(aggregateGroupRuns);
  if ("unavailable" in aggregateByRun) return unavailable(aggregateByRun.unavailable);
  const groupRunsById = await loadAcceptedPortableGroupRuns({
    dependencies, operation, taskId: task.taskId, candidateDigest: candidate.digest, reference, round,
    planGroups: plan.groups, groupAdmissions, groupEvidenceRefs, hasAggregate: evidence !== undefined, aggregateByRun,
  });
  if ("unavailable" in groupRunsById) return unavailable(groupRunsById.unavailable);
  if (evidence !== undefined && (groupEvidenceRefs.length !== reference.groupRunIds.length
    || canonicalJson([...groupRunsById.keys()].sort()) !== canonicalJson([...reference.groupRunIds].sort())
    || canonicalJson([...aggregateByRun.keys()].sort()) !== canonicalJson([...reference.groupRunIds].sort()))) {
    return unavailable("aggregate-does-not-cover-accepted-groups");
  }
  const semantic = (admission.portableApprovalBinding as { semanticApproval?: { digest?: unknown } } | undefined)?.semanticApproval?.digest;
  if (typeof semantic !== "string" || !/^[a-f0-9]{64}$/u.test(semantic)) return unavailable("semantic-approval-binding");
  const semanticApprovalDigests = new Map(bundle.scenarios.map((scenario) => [scenario.scenarioId, semantic]));
  const terminalReceipt = workflowE2ETerminalReceiptAt(operation, task, candidate.digest, reference, round, staleProjection);
  const projectionResults: unknown[] = [];
  const qualifications: Array<"PASS" | "FAILED" | "UNKNOWN"> = [];
  for (const [index, group] of plan.groups.entries()) {
    const collected = collectSinglePortableGroupRun({
      index, group, admitted: groupAdmissions[index], run: groupRunsById.get(reference.groupRunIds[index]!),
      bundle, plan, selectionInput, round, reference, taskId: task.taskId, operation, candidateDigest: candidate.digest,
      snapshot, semanticApprovalDigests, runnerEnvironment, runnerToolchain, terminalReceipt,
    });
    if ("unavailable" in collected) return unavailable(collected.unavailable);
    if (collected.projectionResult !== undefined) projectionResults.push(collected.projectionResult);
    qualifications.push(collected.status);
  }
  const currentAuthorityValid = await workflowE2ECurrentAuthorityIsValidWithHooks(dependencies, hooks, task, candidate, admission, snapshot, diagnostic);
  if (projection !== undefined) {
    projection.plan = plan;
    projection.round = round;
    if (currentAuthorityValid) projection.results.push(...projectionResults);
  }
  if (!currentAuthorityValid) return unavailable(diagnostic?.reason ?? "current-owner-policy-source-or-runtime-authority");
  if (!e2ePlanHasCompleteRequiredCriteria(plan)) return unavailable("required-criteria-unavailable");
  return qualifications.includes("FAILED") ? "FAILED" : qualifications.every((item) => item === "PASS") ? "PASS" : "UNKNOWN";
}

function nonCandidatePurposeReason(purpose: E2EWorkflowAdmissionRef["purpose"]): string | undefined {
  if (purpose === "baseline") return "baseline-admission-is-not-a-candidate-round";
  if (purpose === "replay") return "replay-admission-is-not-a-candidate-round";
  if (purpose === "grounding") return "grounding-admission-is-not-a-candidate-round";
  return undefined;
}

/** Independently recompiles and collects every group; worker-supplied verdict fields are ignored. */
export async function verifyWorkflowE2EEvidence(
  dependencies: AwsBrokerDependencies,
  hooks: E2EVerificationHooks,
  operation: OperationRecord,
  task: DeveloperTaskRecord,
  candidate: ReturnType<typeof CandidateManifestSchema.parse>,
  projection?: WorkflowE2EProjection,
  diagnostic?: WorkflowE2EVerificationDiagnostic,
  options?: { terminalStatus?: "SUCCEEDED" | "FAILED" },
): Promise<"PASS" | "FAILED" | "UNKNOWN"> {
  const unavailable = (reason: string): "UNKNOWN" => { if (diagnostic !== undefined) diagnostic.reason = reason; return "UNKNOWN"; };
  try {
    const workflow = task.workflow;
    if (workflow === undefined) return unavailable("workflow-missing");
    const reference = operation.workflowE2EAdmission;
    const nonCandidate = nonCandidatePurposeReason(reference?.purpose);
    if (nonCandidate !== undefined) return unavailable(nonCandidate);
    const staleProjection = projection?.allowStaleProjection === true;
    const referenceMatchesCurrent = staleProjection
      || (workflow.e2e?.currentRoundId === reference?.roundId && canonicalJson(workflow.e2e?.currentGroupRunIds) === canonicalJson(reference?.groupRunIds));
    if (!reference || reference.taskId !== task.taskId || reference.candidateDigest !== candidate.digest || !referenceMatchesCurrent) {
      return unavailable("current-admission-reference-mismatch");
    }
    const admissionText = await readStoredText(dependencies.s3, dependencies.artifactBucketName, reference.admissionRef.key, WORKFLOW_E2E_ADMISSION_MAX_BYTES);
    if (isE2EApplicationAdmissionSchemaVersion(storedAdmissionSchemaVersion(admissionText))) {
      if (diagnostic !== undefined) diagnostic.application = true;
      return await verifyApplicationWorkflowE2EEvidence({
        dependencies, hooks, operation, task, candidate, reference, admissionText: admissionText!, projection, diagnostic, unavailable,
        ...(options?.terminalStatus === undefined ? {} : { terminalStatus: options.terminalStatus }),
      });
    }
    if (workflow.e2e?.applicationSelection !== undefined) {
      if (diagnostic !== undefined) diagnostic.application = true;
      return unavailable("application-e2e-plan-needs-application-verification");
    }
    return await verifyPortableWorkflowE2EEvidence({
      dependencies, hooks, operation, task, candidate, reference, admissionText, staleProjection, projection, diagnostic, unavailable,
    });
  } catch {
    return unavailable("verification-exception");
  }
}

// ---------------------------------------------------------------------------
// Current-authority loaders & DynamoDB transaction fences
// ---------------------------------------------------------------------------

async function loadCurrentApprovedPlan(
  dependencies: AwsBrokerDependencies,
  task: DeveloperTaskRecord,
  candidate: ReturnType<typeof CandidateManifestSchema.parse>,
  mark: AuthorityMark,
  reject: AuthorityReject,
) {
  const workflow = task.workflow;
  const catalogId = dependencies.e2eFeatureRuntimeCatalogId;
  if (!workflow || workflow.e2e?.required !== true || workflow.candidate?.digest !== candidate.digest || !catalogId || task.closedAt !== undefined) {
    reject("current-task-or-approval-missing");
    return undefined;
  }
  const artifact = workflow.artifacts.filter((entry) => entry.type === "plan").at(-1);
  if (artifact === undefined || workflow.e2e.contractDigest !== artifact.sha256) {
    reject("current-canonical-plan-missing-or-stale");
    return undefined;
  }
  mark("canonical-artifact");
  const approved = await loadWorkflowDocument((key, maxBytes) => readStoredText(dependencies.s3, dependencies.artifactBucketName, key, maxBytes), artifact, {});
  if (approved?.format !== "structured") {
    reject("canonical-artifact-or-owner-decision-mismatch");
    return undefined;
  }
  const canonicalApproval = resolveWorkflowE2ECanonicalApproval({
    taskId: task.taskId,
    workflow: workflow as NonNullable<typeof workflow> & {
      artifacts: Array<{ id: string; type: string; sha256: string }>;
      decisions: Array<{ decision: string; actorId: string; artifactDigest?: string; workBreakdownDigest?: string; workflowRevision: number }>;
    },
    artifact,
    plan: approved.plan,
  });
  if (canonicalApproval === undefined) {
    reject("canonical-artifact-or-owner-decision-mismatch");
    return undefined;
  }
  return { workflow, e2e: workflow.e2e, catalogId, artifact, approved, canonicalApproval };
}

async function loadCurrentProjectAuthority(
  dependencies: AwsBrokerDependencies,
  hooks: E2EVerificationHooks,
  task: DeveloperTaskRecord,
  mark: AuthorityMark,
  reject: AuthorityReject,
) {
  mark("project-record");
  const project = await readTaskLegacyProject(await taskLegacyScope(dependencies, task), () => requireProject(dependencies, task.project, task.startingRevision));
  const latestProject = await readTaskLegacyProject(await taskLegacyScope(dependencies, task), () => requireLatestProject(dependencies, task.project));
  if (latestProject.setupApproval === undefined) { reject("current-project-setup-approval-unavailable"); return undefined; }
  mark("project-catalog-pointer");
  try {
    await hooks.ensureProjectCatalogPointer(dependencies, task.project, task);
  } catch (error) {
    if (error instanceof AgentXError && error.code === "CONFIG_INVALID") { reject(`config-invalid-project-catalog-pointer-unrepairable:${task.project}`); return undefined; }
    throw error;
  }
  const catalogKey = hooks.catalogKeyFor(task.project);
  const projectCatalog = await getItem<Record<string, unknown>>(dependencies, catalogKey);
  if (projectCatalog?.entityType !== "PROJECT_CATALOG" || projectCatalog.name !== task.project || projectCatalog.latestRevision !== latestProject.definition.revision) {
    reject("current-project-latest-revision-unavailable");
    return undefined;
  }
  const policy = E2EPolicySchema.parse(latestProject.definition.e2e);
  const pinnedPolicy = E2EPolicySchema.parse(project.definition.e2e);
  if (canonicalJson(policy) !== canonicalJson(pinnedPolicy)
    || canonicalJson(parseRuntimeBinding(latestProject.runtimeBinding)) !== canonicalJson(parseRuntimeBinding(project.runtimeBinding))) {
    reject("current-project-policy-or-runtime-changed");
    return undefined;
  }
  return { project, latestProject, setupApproval: latestProject.setupApproval, catalogKey, policy };
}

export async function creatorGrantKey(dependencies: AwsBrokerDependencies, task: DeveloperTaskRecord): Promise<{ pk: string; sk: string }> {
  const reader = dependencies.companies ?? dependencies.developer?.companies;
  const company = reader === undefined ? undefined : namedCompany(await resolveCompany(reader, task.developerId));
  return grantKeyFor(company, task.developerId, task.project);
}

async function loadCurrentCreatorAuthority(
  dependencies: AwsBrokerDependencies,
  task: DeveloperTaskRecord,
  admittedProof: unknown,
  mark: AuthorityMark,
  reject: AuthorityReject,
) {
  mark("creator-project-access");
  const creator = await getWorkflowE2ECreatorIdentity(dependencies, task.developerId);
  if (creator === undefined || creator.revoked || dependencies.developer === undefined) { reject("current-creator-identity-unavailable"); return undefined; }
  let creatorAccess: Awaited<ReturnType<typeof checkProjectAccess>>;
  try {
    creatorAccess = await checkProjectAccess(
      { ...slackCallerRouteDependencies(dependencies), documentClient: dependencies.documentClient, tableName: dependencies.tableName, developer: dependencies.developer, now: Date.now },
      { developerId: task.developerId, ...(creator.slackUserId === undefined ? {} : { slackUserId: creator.slackUserId }) },
      task.project,
    );
  } catch { reject("current-creator-project-access-unavailable"); return undefined; }
  const creatorMembershipKey = await creatorGrantKey(dependencies, task);
  const creatorMembership = await getItem<Record<string, unknown>>(dependencies, creatorMembershipKey);
  const creatorAuthority = await workflowE2ECreatorAuthorityProof(dependencies, task, creatorMembership, creatorAccess);
  if (creatorAuthority === undefined || canonicalJson(admittedProof) !== canonicalJson(creatorAuthority)) {
    reject("creator-membership-proof-changed-or-unavailable");
    return undefined;
  }
  return { creatorAuthority, creatorAccess, creatorMembershipKey, developer: dependencies.developer };
}

async function currentAuthorityFences(
  dependencies: AwsBrokerDependencies,
  task: DeveloperTaskRecord,
  input: {
    catalogKey: { pk: string; sk: string };
    latestProject: Awaited<ReturnType<typeof requireLatestProject>>;
    setupApproval: unknown;
    policy: E2EPolicy;
    creatorAuthority: NonNullable<Awaited<ReturnType<typeof workflowE2ECreatorAuthorityProof>>>;
    creatorAccess: Awaited<ReturnType<typeof checkProjectAccess>>;
    creatorMembershipKey: { pk: string; sk: string };
    developer: NonNullable<AwsBrokerDependencies["developer"]>;
  },
  reject: AuthorityReject,
): Promise<{ base: Array<Record<string, unknown>>; creator: Array<Record<string, unknown>> } | undefined> {
  const { latestProject, creatorAuthority, creatorAccess, developer } = input;
  const base: Array<Record<string, unknown>> = [
    { ConditionCheck: { TableName: dependencies.tableName, Key: input.catalogKey,
      ConditionExpression: "entityType = :entity AND #name = :name AND latestRevision = :revision",
      ExpressionAttributeNames: { "#name": "name" },
      ExpressionAttributeValues: { ":entity": "PROJECT_CATALOG", ":name": task.project, ":revision": latestProject.definition.revision } } },
    { ConditionCheck: { TableName: dependencies.tableName, Key: projectKey(task.project, latestProject.definition.revision),
      ConditionExpression: "entityType = :entity AND registeredBy = :registeredBy AND #definition.#e2e = :policy AND runtimeBinding = :binding AND setupApproval = :setupApproval",
      ExpressionAttributeNames: { "#definition": "definition", "#e2e": "e2e" },
      ExpressionAttributeValues: { ":entity": "PROJECT", ":registeredBy": latestProject.registeredBy, ":policy": input.policy,
        ":binding": latestProject.runtimeBinding, ":setupApproval": input.setupApproval } } },
    { ConditionCheck: { TableName: developer.signInTableName, Key: { pk: `DEVELOPER#${task.developerId}`, sk: "META" },
      ConditionExpression: "entityType = :entity AND revoked = :notRevoked",
      ExpressionAttributeValues: { ":entity": "DEVELOPER", ":notRevoked": false } } },
  ];
  const creator: Array<Record<string, unknown>> = [];
  if (creatorAuthority.kind === "direct-membership") {
    creator.push({ ConditionCheck: { TableName: dependencies.tableName, Key: input.creatorMembershipKey,
      ConditionExpression: "entityType = :entity AND ownerKey = :ownerKey AND projectName = :project AND #role = :role AND grantId = :grantId",
      ExpressionAttributeNames: { "#role": "role" },
      ExpressionAttributeValues: { ":entity": "MEMBERSHIP", ":ownerKey": task.developerId, ":project": task.project,
        ":role": creatorAuthority.role, ":grantId": creatorAuthority.grantId } } });
  }
  if (creatorAccess.access === "channel") {
    const teamId = developer.slackTeamId;
    if (teamId === undefined || creatorAccess.channelIds.length === 0) { reject("current-channel-access-proof-unavailable"); return undefined; }
    for (const channelId of creatorAccess.channelIds) {
      const bindingKey: { pk: string; sk: string } = slackBindingKey(teamId, channelId);
      const binding: Record<string, unknown> | undefined = await getItem<Record<string, unknown>>(dependencies, bindingKey);
      if (binding?.teamId !== teamId || binding.channelId !== channelId || binding.projectName !== task.project
        || typeof binding.updatedAt !== "string" || binding.updatedAt.length === 0) {
        reject("current-channel-binding-unavailable");
        return undefined;
      }
      creator.push({ ConditionCheck: { TableName: dependencies.tableName, Key: bindingKey,
        ConditionExpression: "teamId = :teamId AND channelId = :channelId AND projectName = :projectName AND updatedAt = :updatedAt",
        ExpressionAttributeValues: { ":teamId": teamId, ":channelId": channelId, ":projectName": task.project, ":updatedAt": binding.updatedAt } } });
    }
  }
  return { base, creator };
}

async function loadCandidateSourceSnapshot(
  dependencies: AwsBrokerDependencies,
  task: DeveloperTaskRecord,
  candidate: ReturnType<typeof CandidateManifestSchema.parse>,
  mark: AuthorityMark,
  reject: AuthorityReject,
): Promise<E2ESourceSnapshot | undefined> {
  mark("candidate-source-operation");
  const sourceOperation = await candidateSourceOperation(dependencies, task, candidate.digest);
  if (!sourceOperation) { reject("candidate-source-operation-missing"); return undefined; }
  mark("candidate-source-export");
  const sourceExport = await loadWorkflowCandidateSourceExport(dependencies, sourceOperation, candidate);
  if (!sourceExport || sourceExport.repositories.length !== 1) { reject("candidate-source-export-missing-or-ambiguous"); return undefined; }
  const repository = sourceExport.repositories[0]!;
  return {
    candidate, commitSha: repository.commitSha, treeSha: repository.treeSha, treeComplete: true, treePaths: repository.treePaths,
    sources: repository.sources.map((source) => ({ path: source.path, sha256: source.sha256, kind: "blob" as const, bytes: Buffer.from(source.bytesBase64, "base64") })),
  };
}

function diagnoseFeatureVerifierMismatch(
  featureRow: Record<string, unknown> | undefined,
  record: ReturnType<typeof E2EFeatureVerifierRecordSchema.parse>,
  catalogId: string,
  profileId: string,
  runtimeBinding: ReturnType<typeof parseRuntimeBinding>,
): string {
  const expectedKey = e2eFeatureVerifierKey(catalogId, profileId);
  if (featureRow?.pk !== expectedKey.pk || featureRow.sk !== expectedKey.sk) return "current-feature-runtime-storage-key-mismatch";
  if (record.state !== "READY") return "current-feature-runtime-not-ready";
  if (record.runtimeCatalogId !== catalogId || record.profileId !== profileId) return "current-feature-runtime-catalog-or-profile-mismatch";
  if (record.bindingDigest !== projectSetupBindingDigest(runtimeBinding) || canonicalJson(record.binding) !== canonicalJson(runtimeBinding)) return "current-feature-runtime-binding-mismatch";
  if (!record.supportedFeatureScopes.includes(E2E_FEATURE_PROCESS_RESPONSE_SCOPE)) return "current-feature-runtime-scope-mismatch";
  if (Date.parse(record.qualifiedAt) > Date.now() || Date.parse(record.expiresAt) <= Date.now()) return "current-feature-runtime-freshness-mismatch";
  return "current-feature-runtime-admission-mismatch";
}

function featureVerifierConditionCheck(
  tableName: string,
  key: { pk: string; sk: string },
  feature: ReturnType<typeof E2EFeatureVerifierRecordSchema.parse>,
): Record<string, unknown> {
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: key,
      ConditionExpression: "entityType = :entity AND #state = :ready AND runtimeCatalogId = :catalog AND catalogRevision = :catalogRevision AND profileId = :profile AND bindingDigest = :bindingDigest AND binding = :binding AND manifestDigest = :manifestDigest AND runnerEnvironmentDigest = :environmentDigest AND runnerEnvironment = :environment AND runnerToolchainDigest = :toolchainDigest AND runnerToolchain = :toolchain AND generation = :generation AND transportCorrelationId = :correlation AND supportedFeatureScopes = :scopes AND qualifiedAt = :qualifiedAt AND expiresAt = :expiresAt",
      ExpressionAttributeNames: { "#state": "state" },
      ExpressionAttributeValues: {
        ":entity": "E2E_FEATURE_VERIFIER", ":ready": "READY", ":catalog": feature.runtimeCatalogId,
        ":catalogRevision": feature.catalogRevision, ":profile": feature.profileId, ":bindingDigest": feature.bindingDigest, ":binding": feature.binding,
        ":manifestDigest": feature.manifestDigest, ":environmentDigest": feature.runnerEnvironmentDigest, ":environment": feature.runnerEnvironment,
        ":toolchainDigest": feature.runnerToolchainDigest, ":toolchain": feature.runnerToolchain, ":generation": feature.generation,
        ":correlation": feature.transportCorrelationId, ":scopes": feature.supportedFeatureScopes, ":qualifiedAt": feature.qualifiedAt, ":expiresAt": feature.expiresAt,
      },
    },
  };
}

function formatAuthorityException(stage: string, error: unknown): string {
  const detail = error instanceof Error ? error.message.replace(/[^A-Za-z0-9 _./:-]/gu, "?").slice(0, 120) : "unknown-error";
  return `current-authority-loader-exception:${stage}:${detail || "empty-error"}`;
}

export async function workflowE2ECurrentAuthorityIsValidWithHooks(
  dependencies: AwsBrokerDependencies,
  hooks: E2EVerificationHooks,
  task: DeveloperTaskRecord,
  candidate: ReturnType<typeof CandidateManifestSchema.parse>,
  admission: Record<string, unknown>,
  admittedSnapshot: E2ESourceSnapshot,
  diagnostic?: WorkflowE2EVerificationDiagnostic,
): Promise<boolean> {
  const reject = (reason: string): false => { if (diagnostic !== undefined) diagnostic.reason = reason; return false; };
  let stage = "workflow";
  const mark: AuthorityMark = (next) => { stage = next; };
  try {
    const plan = await loadCurrentApprovedPlan(dependencies, task, candidate, mark, reject);
    if (plan === undefined) return false;
    const { catalogId, artifact, approved, canonicalApproval } = plan;
    const portableIntent = portableFeatureIntentOf(approved.plan);
    if (!portableIntent.ok) return reject(portableIntent.reason);
    const projectAuthority = await loadCurrentProjectAuthority(dependencies, hooks, task, mark, reject);
    if (projectAuthority === undefined) return false;
    const { project, latestProject, setupApproval, catalogKey, policy } = projectAuthority;
    const creator = await loadCurrentCreatorAuthority(dependencies, task, admission.creatorAuthority, mark, reject);
    if (creator === undefined) return false;
    const snapshot = await loadCandidateSourceSnapshot(dependencies, task, candidate, mark, reject);
    if (snapshot === undefined) return false;
    stage = "current-feature-runtime";
    const key = e2eFeatureVerifierKey(catalogId, policy.defaultSandboxProfileId);
    const featureRow = await getItem<Record<string, unknown>>(dependencies, key);
    const runtimeBinding = parseRuntimeBinding(project.runtimeBinding);
    const parsedFeatureRow = featureRow === undefined || typeof featureRow.pk !== "string" || typeof featureRow.sk !== "string"
      ? undefined
      : E2EFeatureVerifierRecordSchema.safeParse(Object.fromEntries(Object.entries(featureRow).filter(([k]) => k !== "pk" && k !== "sk")));
    if (parsedFeatureRow === undefined || !parsedFeatureRow.success) return reject("current-feature-runtime-schema-invalid");
    if (!admitE2EFeatureVerifier(featureRow, { runtimeCatalogId: catalogId, profileId: policy.defaultSandboxProfileId, binding: runtimeBinding, scope: E2E_FEATURE_PROCESS_RESPONSE_SCOPE, now: Date.now() })) {
      return reject(diagnoseFeatureVerifierMismatch(featureRow, parsedFeatureRow.data, catalogId, policy.defaultSandboxProfileId, runtimeBinding));
    }
    const planDigest = sha256Hex(canonicalJson({
      domain: "workflow-feature-e2e-approved-plan/v1", taskId: task.taskId, artifactId: canonicalApproval.artifactId, artifactSha256: canonicalApproval.artifactDigest,
      graphDigest: canonicalApproval.graphDigest, graphRunId: canonicalApproval.runId, workflowRevision: canonicalApproval.workflowRevision, actorId: canonicalApproval.actorId,
    }));
    stage = "current-admission-derivation";
    const currentAdmission = deriveE2EFeatureExecutionAdmission({
      intent: portableIntent.intent, snapshot, artifactId: artifact.id, artifactSha256: artifact.sha256,
      planDigest, policy, runtimeCatalogId: catalogId, runtimeBinding, featureVerifier: featureRow, now: Date.now(),
    });
    const binding = admission.portableApprovalBinding as { semanticApproval?: { artifactId?: unknown; digest?: unknown }; planDigest?: unknown } | undefined;
    if (binding?.semanticApproval?.artifactId !== artifact.id || binding.semanticApproval.digest !== artifact.sha256 || binding.planDigest !== planDigest) {
      return reject("canonical-approval-binding-mismatch");
    }
    const authorityMatches = workflowE2ECurrentAuthorityMatches({
      admission: { candidateDigest: candidate.digest, intent: admission.intent, policy: admission.policy, runtime: admission.runtime,
        portableApprovalBinding: admission.portableApprovalBinding, creatorAuthority: admission.creatorAuthority, approval: canonicalApproval },
      current: { candidateDigest: candidate.digest, intent: portableIntent.intent, policy, runtime: currentAdmission.runtime,
        portableApprovalBinding: currentAdmission.portableApprovalBinding, creatorAuthority: creator.creatorAuthority, approval: canonicalApproval,
        approvedDecision: true, creatorHasProjectAccess: true, now: Date.now() },
    }) && canonicalJson(admission.plan) === canonicalJson(currentAdmission.plan)
      && canonicalJson(admission.bundle) === canonicalJson(currentAdmission.bundle)
      && sameE2ESourceSnapshot(admittedSnapshot, snapshot);
    if (!authorityMatches) return reject("current-admission-runtime-plan-or-source-mismatch");
    const fences = await currentAuthorityFences(dependencies, task, {
      catalogKey, latestProject, setupApproval, policy,
      creatorAuthority: creator.creatorAuthority, creatorAccess: creator.creatorAccess,
      creatorMembershipKey: creator.creatorMembershipKey, developer: creator.developer,
    }, reject);
    if (fences === undefined) return false;
    if (diagnostic !== undefined) {
      diagnostic.authorityChecks = [...fences.base, featureVerifierConditionCheck(dependencies.tableName, key, parsedFeatureRow.data), ...fences.creator];
    }
    return true;
  } catch (error) {
    return reject(formatAuthorityException(stage, error));
  }
}

function storedAdmissionSchemaVersion(admissionText: string | undefined): string | undefined {
  if (admissionText === undefined) return undefined;
  try {
    const parsed = JSON.parse(admissionText) as { schemaVersion?: unknown };
    return typeof parsed?.schemaVersion === "string" ? parsed.schemaVersion : undefined;
  } catch {
    return undefined;
  }
}

async function readApplicationGroupUploadReceipt(
  dependencies: AwsBrokerDependencies,
  operation: OperationRecord,
  reference: E2EWorkflowAdmissionRef,
  groupRunId: string,
  expectedSha256: string,
): Promise<string | undefined> {
  const upload = await getItem<Record<string, unknown>>(dependencies, { pk: `WORKSPACE#${operation.workspaceId}`, sk: `WORKFLOW_E2E_UPLOAD#${operation.id}#${groupRunId}` });
  const accepted = E2EWorkflowGroupEvidenceRefSchema.safeParse(upload?.groupEvidenceRef);
  const valid = upload?.entityType === "WORKFLOW_E2E_EVIDENCE_UPLOAD" && upload.status === "COMPLETE"
    && upload.operationId === operation.id && upload.groupRunId === groupRunId
    && upload.fence === operation.fence && upload.admissionSha256 === reference.admissionRef.sha256
    && accepted.success && accepted.data.evidenceRef.sha256 === expectedSha256 && typeof upload.receivedAt === "string";
  return valid ? (upload.receivedAt as string) : undefined;
}

export async function loadApplicationEvidenceInputs(
  dependencies: AwsBrokerDependencies,
  operation: OperationRecord,
  reference: E2EWorkflowAdmissionRef,
  admission: E2EApplicationExecutionAdmission,
): Promise<{ aggregate: unknown; groupEvidence: Map<string, unknown>; receivedAt: Map<string, string> } | { unavailable: string }> {
  const limits = applicationEvidenceLimits(admission);
  const evidenceRef = operation.workflowE2EEvidenceRef;
  const groupEvidenceRefs = operation.workflowE2EGroupEvidenceRefs ?? [];
  const groupEvidenceRunIds = operation.workflowE2EGroupRunIds ?? [];
  if (!validateGroupEvidenceRefList(groupEvidenceRefs, groupEvidenceRunIds, reference.groupRunIds)) {
    return { unavailable: "accepted-group-reference-list-invalid" };
  }
  if (evidenceRef === undefined && groupEvidenceRefs.length === 0) return { unavailable: "group-results-not-yet-accepted" };
  let aggregate: unknown;
  if (evidenceRef !== undefined) {
    const aggregateText = evidenceRef.key === `workflow-e2e-evidence/sha256/${evidenceRef.sha256}.json`
      ? await readStoredText(dependencies.s3, dependencies.artifactBucketName, evidenceRef.key, limits.aggregate) : undefined;
    if (aggregateText === undefined || sha256Hex(aggregateText) !== evidenceRef.sha256 || Buffer.byteLength(aggregateText) !== evidenceRef.byteLength) {
      return { unavailable: "admission-or-evidence-reference-integrity" };
    }
    aggregate = JSON.parse(aggregateText) as unknown;
  }
  const groupEvidence = new Map<string, unknown>();
  const receivedAt = new Map<string, string>();
  for (const raw of groupEvidenceRefs) {
    const parsedRef = E2EWorkflowGroupEvidenceRefSchema.safeParse(raw);
    if (!parsedRef.success) return { unavailable: "accepted-group-reference-schema" };
    const { groupRunId, evidenceRef: stored } = parsedRef.data;
    const limit = limits.byGroup.get(groupRunId);
    if (limit === undefined || groupEvidence.has(groupRunId) || stored.key !== `workflow-e2e-group-evidence/sha256/${stored.sha256}.json`) {
      return { unavailable: "accepted-group-reference-subject" };
    }
    const groupText = await readStoredText(dependencies.s3, dependencies.artifactBucketName, stored.key, limit);
    if (groupText === undefined || Buffer.byteLength(groupText) !== stored.byteLength || sha256Hex(groupText) !== stored.sha256) {
      return { unavailable: "accepted-group-evidence-integrity" };
    }
    groupEvidence.set(groupRunId, JSON.parse(groupText) as unknown);
    const receipt = await readApplicationGroupUploadReceipt(dependencies, operation, reference, groupRunId, stored.sha256);
    if (receipt !== undefined) receivedAt.set(groupRunId, receipt);
  }
  return { aggregate, groupEvidence, receivedAt };
}

function applyVerifiedApplicationProjection(
  projection: WorkflowE2EProjection | undefined,
  verified: ReturnType<typeof verifyApplicationE2EEvidence>,
  authorityValid: boolean,
): void {
  if (projection === undefined) return;
  if (verified.plan !== undefined) projection.plan = verified.plan;
  if (verified.round !== undefined) projection.round = verified.round;
  if (!authorityValid) return;
  projection.results.push(...verified.results);
  if (verified.display !== undefined) projection.display = verified.display;
}

async function verifyApplicationWorkflowE2EEvidence(input: {
  dependencies: AwsBrokerDependencies;
  hooks: E2EVerificationHooks;
  operation: OperationRecord;
  task: DeveloperTaskRecord;
  candidate: ReturnType<typeof CandidateManifestSchema.parse>;
  reference: E2EWorkflowAdmissionRef;
  admissionText: string;
  projection: WorkflowE2EProjection | undefined;
  diagnostic: WorkflowE2EVerificationDiagnostic | undefined;
  unavailable: (reason: string) => "UNKNOWN";
  terminalStatus?: "SUCCEEDED" | "FAILED";
}): Promise<"PASS" | "FAILED" | "UNKNOWN"> {
  const { dependencies, hooks, operation, task, candidate, reference, admissionText, projection, diagnostic, unavailable } = input;
  const admissionBytes = Buffer.from(admissionText, "utf8");
  if (sha256Hex(admissionBytes) !== reference.admissionRef.sha256 || admissionBytes.byteLength !== reference.admissionRef.byteLength) {
    return unavailable("admission-or-evidence-reference-integrity");
  }
  let admission: E2EApplicationExecutionAdmission;
  try { admission = decodeE2EApplicationExecutionAdmission(admissionBytes); } catch { return unavailable("application-admission-undecodable"); }
  const loaded = await loadApplicationEvidenceInputs(dependencies, operation, reference, admission);
  if ("unavailable" in loaded) return unavailable(loaded.unavailable);
  const terminalStatus = input.terminalStatus ?? (operation.status === "SUCCEEDED" || operation.status === "FAILED" ? operation.status : undefined);
  const route = await modelRouteForAdmission((key) => getItem<Record<string, unknown>>(dependencies, key), admission);
  if ("unavailable" in route) return unavailable(route.unavailable);
  const verified = verifyApplicationE2EEvidence({
    admissionBytes,
    subject: { taskId: task.taskId, operationId: operation.id, operationFence: operation.fence, workflowRevision: reference.workflowRevision,
      candidateDigest: candidate.digest, roundId: reference.roundId, groupRunIds: reference.groupRunIds, admissionSha256: reference.admissionRef.sha256 },
    aggregate: loaded.aggregate, groupEvidence: loaded.groupEvidence, receivedAt: loaded.receivedAt, terminalStatus,
    ...(route.definition === undefined ? {} : { modelRouteDefinition: route.definition }),
  });
  const authorityValid = await workflowE2EApplicationAuthorityIsValidWithHooks(dependencies, hooks, task, candidate, admission, diagnostic);
  applyVerifiedApplicationProjection(projection, verified, authorityValid);
  if (!authorityValid) return unavailable(diagnostic?.reason ?? "current-owner-policy-source-or-runtime-authority");
  if (verified.verdict !== "PASS" && diagnostic !== undefined) {
    diagnostic.reason = cutEvidenceReason(verified.reason.replace(/\p{Cc}+/gu, " ").replace(/\s+/gu, " ").trim(), APPLICATION_VERDICT_REASON_MAX_CHARS);
  }
  return verified.verdict;
}

// ---------------------------------------------------------------------------
// Baseline, replay, and grounding round settlement
// ---------------------------------------------------------------------------

async function readVerifiedApplicationAdmission(
  dependencies: AwsBrokerDependencies,
  reference: E2EWorkflowAdmissionRef,
): Promise<{ admissionBytes: Buffer; admission: E2EApplicationExecutionAdmission } | undefined> {
  const admissionText = await readStoredText(dependencies.s3, dependencies.artifactBucketName, reference.admissionRef.key, WORKFLOW_E2E_ADMISSION_MAX_BYTES);
  if (admissionText === undefined) return undefined;
  const admissionBytes = Buffer.from(admissionText, "utf8");
  if (sha256Hex(admissionBytes) !== reference.admissionRef.sha256 || admissionBytes.byteLength !== reference.admissionRef.byteLength) return undefined;
  try {
    return { admissionBytes, admission: decodeE2EApplicationExecutionAdmission(admissionBytes) };
  } catch {
    return undefined;
  }
}

export async function settleBaselineRound(dependencies: AwsBrokerDependencies, operation: OperationRecord, status: OperationStatus): Promise<void> {
  const reference = operation.workflowE2EAdmission;
  if (operation.kind !== "task" || reference?.purpose !== "baseline" || reference.baseCommitSha === undefined || reference.attempt === undefined) return;
  try {
    const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(reference.taskId));
    if (task === undefined || task.workspaceId !== operation.workspaceId) return;
    const record = await readWorkflowE2EBaselineRecord(dependencies, task);
    if (record === undefined || record.state !== "STARTED" || record.operationId !== operation.id) return;
    const unavailable = (reason: BaselineUnavailableReason) => markWorkflowE2EBaselineUnavailable(dependencies, task, reason, { from: ["STARTED"], operationId: operation.id });
    if (status !== "SUCCEEDED") { await unavailable(status === "CANCELLED" ? "stopped" : "run-failed"); return; }
    const verified = await verifyBaselineRound(dependencies, operation, reference, record.skippedAiScenarios);
    if (verified === undefined) { await unavailable("unverified"); return; }
    await recordWorkflowE2EBaseline(
      { documentClient: dependencies.documentClient, tableName: dependencies.tableName, s3: dependencies.s3, artifactBucketName: dependencies.artifactBucketName },
      task,
      { verified, expected: { operationId: operation.id, roundId: reference.roundId, admissionSha256: reference.admissionRef.sha256, baseCommitSha: reference.baseCommitSha, attempt: reference.attempt } },
    );
  } catch (error) {
    console.log(JSON.stringify({ component: "broker", event: "workflow.e2e_baseline_settle_failed", taskId: reference.taskId, operationId: operation.id, errorName: error instanceof Error ? error.name : "unknown" }));
  }
}

async function verifyBaselineRound(dependencies: AwsBrokerDependencies, operation: OperationRecord, reference: E2EWorkflowAdmissionRef, skippedAiScenarios?: SkippedAiScenarios) {
  const decoded = await readVerifiedApplicationAdmission(dependencies, reference);
  if (decoded === undefined) return undefined;
  const loaded = await loadApplicationEvidenceInputs(dependencies, operation, reference, decoded.admission);
  if ("unavailable" in loaded) return undefined;
  return verifyBaselineEvidence({
    admissionBytes: decoded.admissionBytes,
    subject: { taskId: reference.taskId, operationId: operation.id, operationFence: operation.fence, workflowRevision: reference.workflowRevision,
      candidateDigest: reference.candidateDigest, roundId: reference.roundId, groupRunIds: reference.groupRunIds, admissionSha256: reference.admissionRef.sha256 },
    aggregate: loaded.aggregate, groupEvidence: loaded.groupEvidence, receivedAt: loaded.receivedAt, terminalStatus: "SUCCEEDED",
    ...(skippedAiScenarios === undefined ? {} : { skippedAiScenarios }),
  });
}

export async function settleReplayRound(dependencies: AwsBrokerDependencies, operation: OperationRecord, status: OperationStatus): Promise<void> {
  const reference = operation.workflowE2EAdmission;
  if (operation.kind !== "task" || reference?.purpose !== "replay" || reference.sourceRoundId === undefined || reference.attempt === undefined) return;
  try {
    const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(reference.taskId));
    if (task === undefined || task.workspaceId !== operation.workspaceId) return;
    const round = { sourceRoundId: reference.sourceRoundId, attempt: reference.attempt };
    const record = await readWorkflowE2EReplayRecord(dependencies, task.taskId, round);
    if (record === undefined || record.state !== "STARTED" || record.operationId !== operation.id) return;
    const unavailable = (reason: ReplayUnavailableReason) => markWorkflowE2EReplayUnavailable(dependencies, task, round, reason, { from: ["STARTED"], operationId: operation.id });
    if (status !== "SUCCEEDED") { await unavailable(status === "CANCELLED" ? "stopped" : "run-failed"); return; }
    const verified = await verifyReplayRound(dependencies, operation, reference);
    if (verified === undefined) { await unavailable("unverified"); return; }
    await recordWorkflowE2EReplay(dependencies, task, { verified, expected: { ...round, operationId: operation.id, roundId: reference.roundId, admissionSha256: reference.admissionRef.sha256 } });
  } catch (error) {
    console.log(JSON.stringify({ component: "broker", event: "workflow.e2e_replay_settle_failed", taskId: reference.taskId, operationId: operation.id, errorName: error instanceof Error ? error.name : "unknown" }));
  }
}

async function verifyReplayRound(dependencies: AwsBrokerDependencies, operation: OperationRecord, reference: E2EWorkflowAdmissionRef) {
  const decoded = await readVerifiedApplicationAdmission(dependencies, reference);
  if (decoded === undefined || decoded.admission.replay === undefined) return undefined;
  const loaded = await loadApplicationEvidenceInputs(dependencies, operation, reference, decoded.admission);
  if ("unavailable" in loaded) return undefined;
  return verifyReplayEvidence({
    admissionBytes: decoded.admissionBytes,
    subject: { taskId: reference.taskId, operationId: operation.id, operationFence: operation.fence, workflowRevision: reference.workflowRevision,
      candidateDigest: reference.candidateDigest, roundId: reference.roundId, groupRunIds: reference.groupRunIds, admissionSha256: reference.admissionRef.sha256 },
    aggregate: loaded.aggregate, groupEvidence: loaded.groupEvidence, receivedAt: loaded.receivedAt, terminalStatus: "SUCCEEDED", replay: decoded.admission.replay,
  });
}

export async function settleGroundingRound(dependencies: AwsBrokerDependencies, operation: OperationRecord, status: OperationStatus): Promise<void> {
  const reference = operation.workflowE2EAdmission;
  if (operation.kind !== "task" || reference?.purpose !== "grounding" || reference.baseCommitSha === undefined || reference.attempt === undefined || reference.planArtifactSha256 === undefined) return;
  try {
    const task = await getItem<DeveloperTaskRecord>(dependencies, taskKey(reference.taskId));
    if (task === undefined || task.workspaceId !== operation.workspaceId) return;
    const ref = { taskId: task.taskId, planArtifactSha256: reference.planArtifactSha256, attempt: reference.attempt };
    const record = await readWorkflowE2EGroundingRecord(dependencies, ref);
    if (record === undefined || record.state !== "STARTED" || record.operationId !== operation.id) return;
    const unavailable = (reason: GroundingUnavailableReason) => markWorkflowE2EGroundingUnavailable(dependencies, ref, reason, { from: ["STARTED"], operationId: operation.id });
    if (status !== "SUCCEEDED") { await unavailable(status === "CANCELLED" ? "stopped" : "run-failed"); return; }
    const verified = await verifyGroundingRound(dependencies, operation, reference, record);
    if (verified === undefined) { await unavailable("unverified"); return; }
    await recordWorkflowE2EGrounding(
      { documentClient: dependencies.documentClient, tableName: dependencies.tableName, s3: dependencies.s3, artifactBucketName: dependencies.artifactBucketName },
      task,
      ref,
      { verified, expected: { operationId: operation.id, roundId: reference.roundId, admissionSha256: reference.admissionRef.sha256, baseCommitSha: reference.baseCommitSha } },
    );
  } catch (error) {
    console.log(JSON.stringify({ component: "broker", event: "workflow.e2e_grounding_settle_failed", taskId: reference.taskId, operationId: operation.id, errorName: error instanceof Error ? error.name : "unknown" }));
  }
}

async function verifyGroundingRound(dependencies: AwsBrokerDependencies, operation: OperationRecord, reference: E2EWorkflowAdmissionRef, record: GroundingRecord) {
  if (reference.baseCommitSha === undefined || reference.attempt === undefined) return undefined;
  const decoded = await readVerifiedApplicationAdmission(dependencies, reference);
  if (decoded === undefined) return undefined;
  const loaded = await loadApplicationEvidenceInputs(dependencies, operation, reference, decoded.admission);
  if ("unavailable" in loaded) return undefined;
  const planDigest = groundingPlanDigest({
    taskId: reference.taskId, artifactId: record.planArtifactId, artifactSha256: record.planArtifactSha256,
    workflowRevision: reference.workflowRevision, baseCommitSha: reference.baseCommitSha, attempt: reference.attempt,
  });
  return verifyGroundingEvidence({
    admissionBytes: decoded.admissionBytes,
    subject: { taskId: reference.taskId, operationId: operation.id, operationFence: operation.fence, workflowRevision: reference.workflowRevision,
      candidateDigest: reference.candidateDigest, roundId: reference.roundId, groupRunIds: reference.groupRunIds, admissionSha256: reference.admissionRef.sha256 },
    aggregate: loaded.aggregate, groupEvidence: loaded.groupEvidence, receivedAt: loaded.receivedAt, terminalStatus: "SUCCEEDED",
    grounding: { planDigest, baseCommitSha: reference.baseCommitSha },
  });
}

// ---------------------------------------------------------------------------
// Application E2E current-authority check
// ---------------------------------------------------------------------------

function changedRuntimeFields(now: E2ERegisteredRuntime, admitted: E2ERegisteredRuntime): string {
  const moved = (["generation", "expiresAt", "qualifiedAt"] as const).find((field) => now[field] !== admitted[field]);
  if (moved === undefined) return "another field of its record changed";
  return moved === "generation" ? `generation ${now.generation} now, ${admitted.generation} when admitted` : `${moved} now ${now[moved]}, ${admitted[moved]} when admitted`;
}

function applicationPolicyMatchesAdmitted(policy: E2EPolicy, admittedPolicy: E2EPolicy): boolean {
  const derivedVariant = (target: E2EPolicy["targets"][number]) => target.accountProfileId === E2E_ANONYMOUS_ACCOUNT_PROFILE_ID
    && policy.targets.some((base) => base.kind === target.kind && e2eAnonymousTargetId(base.targetId) === target.targetId && canonicalJson(e2eAnonymousVariantOf(base)) === canonicalJson(target));
  return canonicalJson(policy) === canonicalJson({ ...admittedPolicy, targets: admittedPolicy.targets.filter((target) => !derivedVariant(target)) });
}

function verifyAdmittedRuntimeRowsCurrent(
  admission: E2EApplicationExecutionAdmission,
  currentRows: readonly E2ERegisteredRuntime[],
  diagnostic: WorkflowE2EVerificationDiagnostic | undefined,
  reject: AuthorityReject,
): boolean {
  for (const { value: admitted } of admission.runtimeBindings) {
    const row = currentRows.find((item) => item.capabilities.kind === admitted.capabilities.kind && item.profileId === admitted.profileId);
    const label = `${admitted.capabilities.kind} runtime ${admitted.profileId}`;
    if (row === undefined) {
      if (diagnostic !== undefined) diagnostic.runtimeChange = "unusable";
      return reject(`the ${label} this round was admitted on is not ready now`);
    }
    if (canonicalJson(row) !== canonicalJson(admitted)) {
      if (diagnostic !== undefined) diagnostic.runtimeChange = "requalified";
      return reject(`the ${label} was requalified during the round (${changedRuntimeFields(row, admitted)})`);
    }
  }
  return true;
}

function validateApplicationPlanAndSelection(
  storedIntent: unknown,
  applicationSelection: unknown,
  admission: E2EApplicationExecutionAdmission,
  reject: AuthorityReject,
): { intent: E2EApplicationPlanIntent; recorded: E2EApplicationSelectionRecord } | undefined {
  if ((storedIntent as { schemaVersion?: unknown } | undefined)?.schemaVersion !== 2) { reject("application-admission-needs-application-plan"); return undefined; }
  const parsedIntent = E2EApplicationPlanIntentSchema.safeParse(storedIntent);
  if (!parsedIntent.success) { reject("approved-plan-intent-is-not-readable"); return undefined; }
  const recorded = E2EApplicationSelectionRecordSchema.safeParse(applicationSelection);
  if (!recorded.success) { reject("no-recorded-application-selection"); return undefined; }
  if (canonicalJson(applicationRoundIntent(applicationIntentWithAccountRefs(parsedIntent.data, recorded.data.accountRefs))) !== canonicalJson(admission.intent)) {
    reject("approved-plan-is-not-the-admitted-intent");
    return undefined;
  }
  return { intent: parsedIntent.data, recorded: recorded.data };
}

export async function workflowE2EApplicationAuthorityIsValidWithHooks(
  dependencies: AwsBrokerDependencies,
  hooks: E2EVerificationHooks,
  task: DeveloperTaskRecord,
  candidate: ReturnType<typeof CandidateManifestSchema.parse>,
  admission: E2EApplicationExecutionAdmission,
  diagnostic?: WorkflowE2EVerificationDiagnostic,
): Promise<boolean> {
  const reject = (reason: string): false => { if (diagnostic !== undefined) diagnostic.reason = reason; return false; };
  if (diagnostic !== undefined) diagnostic.authorityEvaluated = true;
  let stage = "workflow";
  const mark: AuthorityMark = (next) => { stage = next; };
  try {
    const plan = await loadCurrentApprovedPlan(dependencies, task, candidate, mark, reject);
    if (plan === undefined) return false;
    const planAndSelection = validateApplicationPlanAndSelection(plan.approved.plan.e2e, plan.e2e.applicationSelection, admission, reject);
    if (planAndSelection === undefined) return false;
    const { intent, recorded } = planAndSelection;
    const projectAuthority = await loadCurrentProjectAuthority(dependencies, hooks, task, mark, reject);
    if (projectAuthority === undefined) return false;
    const { latestProject, setupApproval, catalogKey, policy } = projectAuthority;
    if (!applicationPolicyMatchesAdmitted(policy, E2EPolicySchema.parse(admission.policy))) return reject("current-project-policy-or-runtime-changed");
    const creator = await loadCurrentCreatorAuthority(dependencies, task, admission.creatorAuthority, mark, reject);
    if (creator === undefined) return false;
    const snapshot = await loadCandidateSourceSnapshot(dependencies, task, candidate, mark, reject);
    if (snapshot === undefined) return false;
    const admittedSnapshot: E2ESourceSnapshot = {
      ...admission.sourceSnapshot,
      sources: admission.sourceSnapshot.sources.map((source) => ({ path: source.path, sha256: source.sha256, kind: "blob" as const, bytes: Buffer.from(source.bytesBase64, "base64") })),
    };
    if (!sameE2ESourceSnapshot(admittedSnapshot, snapshot) || admission.candidateCommitSha !== snapshot.commitSha || admission.candidateTreeSha !== snapshot.treeSha) {
      return reject("current-admission-runtime-plan-or-source-mismatch");
    }
    mark("current-runtime-rows");
    const current = await hooks.evaluateWorkflowE2EApplicationSelectionNow(dependencies, task, intent, plan.artifact, { mode: "current", pinned: recorded.accountRefs });
    if (!current.ok) {
      if (current.kind === "refused" && current.scope === "runtime" && diagnostic !== undefined) diagnostic.runtimeChange = "unusable";
      if (current.kind === "refused" && current.scope === "accounts" && diagnostic !== undefined) diagnostic.runtimeChange = "accounts";
      return reject(`${current.kind === "unevaluable" ? "application-selection-unavailable" : "application-selection-refused"}: ${current.reason}`);
    }
    if (!verifyAdmittedRuntimeRowsCurrent(admission, current.inputs.rows, diagnostic, reject)) return false;
    const unchanged = applicationSelectionStillCurrent(recorded, current.selection);
    if (!unchanged.ok) return reject(`application-selection-changed: ${unchanged.reason}`);
    if (canonicalJson(admission.selectionInput.approvedSemanticApproval) !== canonicalJson(recorded.semanticApproval)
      || canonicalJson(admission.selectionInput.setupApproval) !== canonicalJson(recorded.setupApproval)
      || applicationIntentDigest(intent) !== recorded.intentDigest
      || admission.intentDigest !== sha256Hex(canonicalJson(admission.intent))) return reject("canonical-approval-binding-mismatch");
    const fences = await currentAuthorityFences(dependencies, task, {
      catalogKey, latestProject, setupApproval, policy,
      creatorAuthority: creator.creatorAuthority, creatorAccess: creator.creatorAccess,
      creatorMembershipKey: creator.creatorMembershipKey, developer: creator.developer,
    }, reject);
    if (fences === undefined) return false;
    if (diagnostic !== undefined) diagnostic.authorityChecks = [...fences.base, ...(current.conditions as Array<Record<string, unknown>>), ...fences.creator];
    return true;
  } catch (error) {
    return reject(formatAuthorityException(stage, error));
  }
}

export async function workflowE2ECreatorAuthorityProof(
  dependencies: AwsBrokerDependencies,
  task: DeveloperTaskRecord,
  membership: Record<string, unknown> | undefined,
  access: Awaited<ReturnType<typeof checkProjectAccess>>,
): Promise<(
  | { kind: "direct-membership"; developerId: string; project: string; role: "developer" | "administrator"; grantId: string }
  | { kind: "channel-access"; developerId: string; project: string; teamId: string; channelIds: string[]; bindings: Array<{ channelId: string; updatedAt: string }> }
) | undefined> {
  if (membership?.entityType === "MEMBERSHIP" && membership.ownerKey === task.developerId && membership.projectName === task.project
    && (membership.role === "developer" || membership.role === "administrator") && typeof membership.grantId === "string"
    && /^[0-9a-f-]{36}$/iu.test(membership.grantId)) {
    return { kind: "direct-membership", developerId: task.developerId, project: task.project, role: membership.role, grantId: membership.grantId };
  }
  if (access.access !== "channel" || dependencies.developer?.slackTeamId === undefined || access.channelIds.length === 0) return undefined;
  const teamId = dependencies.developer.slackTeamId;
  const channelIds = [...new Set(access.channelIds)].sort();
  const bindings: Array<{ channelId: string; updatedAt: string }> = [];
  for (const channelId of channelIds) {
    const row = await getItem<Record<string, unknown>>(dependencies, slackBindingKey(teamId, channelId));
    if (row?.teamId !== teamId || row.channelId !== channelId || row.projectName !== task.project
      || typeof row.updatedAt !== "string" || row.updatedAt.length === 0) return undefined;
    bindings.push({ channelId, updatedAt: row.updatedAt });
  }
  return { kind: "channel-access", developerId: task.developerId, project: task.project, teamId, channelIds, bindings };
}

function sameE2ESourceSnapshot(left: E2ESourceSnapshot, right: E2ESourceSnapshot): boolean {
  if (canonicalJson(left.candidate) !== canonicalJson(right.candidate) || left.commitSha !== right.commitSha || left.treeSha !== right.treeSha
    || left.treeComplete !== right.treeComplete || canonicalJson(left.treePaths) !== canonicalJson(right.treePaths)
    || left.sources.length !== right.sources.length) return false;
  const rightByPath = new Map(right.sources.map((source) => [source.path, source]));
  return left.sources.every((source) => {
    const actual = rightByPath.get(source.path);
    return actual !== undefined && source.sha256 === actual.sha256 && source.kind === actual.kind
      && Buffer.from(source.bytes).equals(Buffer.from(actual.bytes));
  });
}

// ---------------------------------------------------------------------------
// Task E2E presentation & publication checks
// ---------------------------------------------------------------------------

async function coreApplicationTask(dependencies: AwsBrokerDependencies, task: DeveloperTaskRecord) {
  const core = dependencies.core;
  const companyId = storedCompanyOf(task);
  if (core === undefined || companyId === undefined) return undefined;
  const registry = await core.app.registry();
  if (await core.app.engineOfTask(registry.require("storage"), task.taskId, "flow") !== "core") return undefined;
  const flow = (await core.app.runtimeFor(companyId)).flow.deps;
  const stored = await flow.store.get({ pk: `DEVTASK#${task.taskId}`, sk: "META" }) as unknown as CoreApplicationTaskRecord | undefined;
  if (stored?.companyId !== companyId || stored.workflow === undefined || flow.applicationE2E === undefined) {
    throw agentXError("TASK_NOT_FOUND", "no task here that you can see");
  }
  return { task: { ...stored, workflow: stored.workflow }, seams: flow.applicationE2E };
}

function presentationWithResults(taskId: string, shared: E2ESharedView, results: E2EScenarioResults | undefined): { pageHtml: string; slackBlocks: unknown[] } {
  const artifactPath = (sha256: string) => `/review/${taskId}/task/api/e2e/artifacts/${sha256}`;
  const base = renderE2EPageHtml(shared);
  const candidates = results === undefined ? [] : [results, ...(results.baseline === undefined ? [] : [{ scenarios: results.scenarios }])];
  const section = candidates.map((candidate) => renderE2EScenarioRowsHtml(candidate, { artifactPath })).find((html) => base.length + html.length <= 65_536) ?? "";
  return { pageHtml: `${base}${section}`, slackBlocks: [...(results === undefined ? [] : renderE2EScenarioSlackBlocks(results)), ...renderE2ESlackBlocks(shared)].slice(0, 16) };
}

async function readPrivateS3Bytes(dependencies: AwsBrokerDependencies, key: string, maxBytes: number): Promise<Uint8Array | undefined> {
  try {
    const object = await dependencies.s3.send(new GetObjectCommand({ Bucket: dependencies.artifactBucketName, Key: key })) as { ContentLength?: number; Body?: { transformToByteArray(): Promise<Uint8Array> } };
    if (!Number.isSafeInteger(object.ContentLength) || object.ContentLength! > maxBytes) return undefined;
    const bytes = await object.Body?.transformToByteArray();
    return bytes !== undefined && bytes.byteLength === object.ContentLength && bytes.byteLength <= maxBytes ? bytes : undefined;
  } catch {
    return undefined;
  }
}

async function closedTaskWorkflowE2EPresentation(
  dependencies: AwsBrokerDependencies,
  task: DeveloperTaskRecord,
  progress: NonNullable<NonNullable<DeveloperTaskRecord["workflow"]>["e2e"]>,
  candidateDigest: string,
): Promise<{ presentation: NonNullable<DeveloperTaskView["e2ePresentation"]>; scenarioResults?: E2EScenarioResults; artifacts: readonly DisplayArtifact[] }> {
  const qualified = progress.qualifiedRound;
  const failed = progress.failedRound;
  const round = qualified ?? failed;
  const roundMatchesClosedTask = round !== undefined && round.candidateDigest === candidateDigest
    && round.roundId === progress.currentRoundId && round.groupRunIds.length === progress.currentGroupRunIds.length
    && round.groupRunIds.every((runId, index) => runId === progress.currentGroupRunIds[index]);
  const captured = roundMatchesClosedTask && round !== undefined && progress.displayRef !== undefined
    ? await readWorkflowE2ENotifierProjection({
      ref: progress.displayRef, ownerKey: task.ownerKey, workspaceId: task.workspaceId,
      current: { candidateDigest: round.candidateDigest, roundId: round.roundId, groupRunIds: [...round.groupRunIds], admissionSha256: round.admissionSha256, evidenceSha256: round.evidenceSha256 },
      readPrivateObject: (key, maxBytes) => readPrivateS3Bytes(dependencies, key, maxBytes),
    })
    : undefined;
  const current = E2ESharedViewSchema.parse({
    schemaVersion: 1,
    setup: { status: "unavailable", selectedTargetIds: [], executionPlanDigest: null, blockingInputIds: [], mockSubstitutableInputIds: [] },
    e2e: { status: "UNKNOWN", label: "Current eligibility unavailable: task closed.", executionPlanDigest: null,
      expectedGroups: 0, receivedGroups: 0, executedCases: 0, qualifiedCriteria: 0, requiredCriteria: 0,
      unavailableCriteria: 0, optionalUnavailableCriteria: 0, mockedComponentIds: [], observedMockedComponentIds: [],
      unexercisedBehaviors: [], policyPresence: "absent", workflowPhase: "closed", requiredUnexercisedCriteriaIds: [] },
    actions: [],
  });
  const historyStatusMatches = qualified !== undefined ? captured?.view.e2e.status === "PASS" : failed !== undefined && captured?.view.e2e.status === "FAILED";
  const history = captured !== undefined && Date.parse(captured.capturedAt) <= Date.parse(task.closedAt!) && historyStatusMatches ? captured : undefined;
  const historicalHtml = history === undefined ? ""
    : `<section aria-labelledby="e2e-historical-${history.roundId}"><h2 id="e2e-historical-${history.roundId}">Recorded historical E2E result</h2><p>Recorded ${history.view.e2e.status} at ${history.capturedAt}; this is not current eligibility.</p>${renderE2EPageHtml(history.view).replaceAll("e2e-summary", `e2e-historical-summary-${history.roundId}`)}</section>`;
  const scope = history === undefined
    ? "Current eligibility unavailable: task closed. No verified historical E2E display is available."
    : `Current eligibility unavailable: task closed. Recorded historical ${history.view.e2e.status} at ${history.capturedAt}, candidate ${history.candidateDigest}, round ${history.roundId}; groups ${history.view.e2e.receivedGroups}/${history.view.e2e.expectedGroups}, cases ${history.view.e2e.executedCases}, criteria ${history.view.e2e.qualifiedCriteria}/${history.view.e2e.requiredCriteria}; these counts are historical only.`;
  const currentHtml = `<section aria-labelledby="e2e-current-eligibility"><h2 id="e2e-current-eligibility">Current E2E eligibility</h2><p>Unavailable because the task is closed. No current run counts are available.</p></section>`;
  const currentSlack = { type: "section", text: { type: "mrkdwn", text: "*Current E2E eligibility: UNKNOWN*\nTask closed. No current run counts are available." } };
  const recordedRows = history?.scenarioResults;
  const recordedRowsHtml = recordedRows === undefined ? "" : renderE2EScenarioRowsHtml(recordedRows, { artifactPath: (sha256) => `/review/${task.taskId}/task/api/e2e/artifacts/${sha256}` });
  const closedPageHtml = `${currentHtml}${historicalHtml}`;
  return {
    presentation: {
      shared: current,
      slackBlocks: [currentSlack, ...(history === undefined ? [] : renderE2ENotifierSlackBlocks(history.view,
        { candidateDigest: history.candidateDigest, roundId: history.roundId, capturedAt: history.capturedAt, ...(recordedRows === undefined ? {} : { scenarioResults: recordedRows }) }))].slice(0, 16),
      pageHtml: (closedPageHtml.length + recordedRowsHtml.length <= 65_536 ? `${closedPageHtml}${recordedRowsHtml}` : closedPageHtml).slice(0, 65_536),
      mcp: { ...renderE2EMcpProjection(current), scope: `${renderE2EMcpProjection(current).scope} ${scope}`.slice(0, 2_000) },
    },
    ...(recordedRows === undefined ? {} : { scenarioResults: recordedRows }),
    artifacts: [],
  };
}

function extractSelectedTargetIds(plan: Record<string, unknown>): string[] | undefined {
  if (typeof plan.digest !== "string" || !Array.isArray(plan.effectiveTargets)) return undefined;
  const selectedTargetIds: string[] = [];
  for (const target of plan.effectiveTargets as unknown[]) {
    if (typeof target !== "object" || target === null || Array.isArray(target) || !("targetId" in target) || typeof target.targetId !== "string") return undefined;
    selectedTargetIds.push(target.targetId);
  }
  return selectedTargetIds;
}

function operationMatchesPresentationRound(
  operation: OperationRecord | undefined,
  taskId: string,
  presentationRoundId: string,
  candidateDigest: string,
  staleFailure: boolean,
  failedRound: NonNullable<NonNullable<DeveloperTaskRecord["workflow"]>["e2e"]>["failedRound"],
): operation is OperationRecord {
  const admission = operation?.workflowE2EAdmission;
  if (operation === undefined || operation.kind !== "task" || operation.workflowMode !== "CHECKS" || admission === undefined) return false;
  if (admission.taskId !== taskId || admission.roundId !== presentationRoundId || admission.candidateDigest !== candidateDigest) return false;
  if (operation.workflowE2EEvidenceRef === undefined && (operation.workflowE2EGroupEvidenceRefs?.length ?? 0) === 0) return false;
  if (!staleFailure) return true;
  return operation.workflowE2EEvidenceRef !== undefined && failedRound !== undefined
    && failedRound.admissionSha256 === admission.admissionRef.sha256
    && failedRound.evidenceSha256 === operation.workflowE2EEvidenceRef.sha256
    && canonicalJson(failedRound.groupRunIds) === canonicalJson(admission.groupRunIds);
}

export async function workflowE2EPresentationDetailed(
  dependencies: AwsBrokerDependencies,
  hooks: E2EVerificationHooks,
  task: DeveloperTaskRecord,
  operations: readonly unknown[],
  actor: "owner" | "viewer",
  ending?: { operationId: string; status: "SUCCEEDED" | "FAILED" },
): Promise<{ presentation: NonNullable<DeveloperTaskView["e2ePresentation"]>; scenarioResults?: E2EScenarioResults; artifacts: readonly DisplayArtifact[] } | undefined> {
  const workflow = task.workflow;
  const progress = workflow?.e2e;
  const candidateResult = CandidateManifestSchema.safeParse(workflow?.candidate);
  if (workflow === undefined || progress?.required !== true || candidateResult.success !== true || candidateResult.data.digest !== workflow.candidate?.digest) return undefined;
  if (task.closedAt !== undefined) return closedTaskWorkflowE2EPresentation(dependencies, task, progress, candidateResult.data.digest);
  const failedRound = progress.failedRound;
  const staleFailure = workflow.stage === "IMPLEMENT" && failedRound?.status === "FAILED" && failedRound.candidateDigest === candidateResult.data.digest;
  const presentationRoundId = staleFailure ? failedRound.roundId : progress.currentRoundId;
  if (presentationRoundId === undefined) return undefined;
  for (const raw of operations) {
    if (typeof raw !== "object" || raw === null || !("id" in raw) || typeof raw.id !== "string" || !("workflowMode" in raw) || raw.workflowMode !== "CHECKS") continue;
    const operation = await getItem<OperationRecord>(dependencies, operationKey(task.workspaceId, raw.id));
    if (!operationMatchesPresentationRound(operation, task.taskId, presentationRoundId, candidateResult.data.digest, staleFailure, failedRound)) continue;
    const projection: WorkflowE2EProjection & { allowStaleProjection: boolean } = { results: [], allowStaleProjection: staleFailure };
    await verifyWorkflowE2EEvidence(dependencies, hooks, operation, task, candidateResult.data, projection, undefined, ending?.operationId === operation.id ? { terminalStatus: ending.status } : undefined);
    if (projection.plan === undefined || projection.round === undefined) return undefined;
    const plan = projection.plan as Record<string, unknown>;
    const selectedTargetIds = extractSelectedTargetIds(plan);
    if (selectedTargetIds === undefined) return undefined;
    const shared = buildE2ESharedView({
      plan: projection.plan, currentRound: projection.round, results: staleFailure ? [] : projection.results,
      setup: { status: "unavailable", selectedTargetIds, executionPlanDigest: plan.digest as string, blockingInputIds: [], mockSubstitutableInputIds: [] },
      actor, control: { policyPresent: true, workflowPhase: "e2e", ownerActionProposals: [] },
    });
    const rows = staleFailure || projection.display === undefined || projection.display.scenarios.length === 0 ? undefined : projection.display;
    const baseline = rows === undefined ? undefined : await readWorkflowE2EBaseline(dependencies, task).catch(() => undefined);
    const scenarioResults: E2EScenarioResults | undefined = rows === undefined ? undefined : { scenarios: [...rows.scenarios], ...(baseline === undefined ? {} : { baseline }) };
    const shown = presentationWithResults(task.taskId, shared, scenarioResults);
    return {
      presentation: { shared, slackBlocks: shown.slackBlocks, pageHtml: shown.pageHtml, mcp: renderE2EMcpProjection(shared) },
      ...(scenarioResults === undefined ? {} : { scenarioResults }),
      artifacts: rows?.artifacts ?? [],
    };
  }
  return undefined;
}

export async function workflowE2EPresentation(
  dependencies: AwsBrokerDependencies,
  hooks: E2EVerificationHooks,
  task: DeveloperTaskRecord,
  operations: readonly unknown[],
  actor: "owner" | "viewer",
  ending?: { operationId: string; status: "SUCCEEDED" | "FAILED" },
): Promise<NonNullable<DeveloperTaskView["e2ePresentation"]> | undefined> {
  const core = await coreApplicationTask(dependencies, task);
  if (core !== undefined) return (await core.seams.results.read(core.task, actor))?.presentation;
  return (await workflowE2EPresentationDetailed(dependencies, hooks, task, operations, actor, ending))?.presentation;
}

export async function loadWorkflowE2EScenarioResultsWithHooks(
  dependencies: AwsBrokerDependencies,
  hooks: E2EVerificationHooks,
  task: DeveloperTaskRecord,
  operations: readonly unknown[],
  actor: "owner" | "viewer" = "viewer",
): Promise<E2EScenarioResults | undefined> {
  const core = await coreApplicationTask(dependencies, task);
  if (core !== undefined) return (await core.seams.results.read(core.task, actor))?.scenarioResults;
  if (task.closedAt !== undefined) return (await workflowE2EPresentationDetailed(dependencies, hooks, task, operations, actor))?.scenarioResults;
  const stored = await loadStoredScenarioResults({ s3: dependencies.s3, artifactBucketName: dependencies.artifactBucketName }, task);
  const baseline = await readWorkflowE2EBaseline(dependencies, task).catch(() => undefined);
  if (stored === undefined && baseline === undefined) return undefined;
  return { scenarios: stored?.scenarios ?? [], ...((baseline ?? stored?.baseline) === undefined ? {} : { baseline: (baseline ?? stored?.baseline)! }) };
}

export async function loadWorkflowE2EArtifact(
  dependencies: AwsBrokerDependencies,
  task: DeveloperTaskRecord,
  sha256: string,
): Promise<{ contentType: "image/jpeg"; bytes: Uint8Array } | undefined> {
  const core = await coreApplicationTask(dependencies, task);
  if (core !== undefined) return core.seams.results.artifact(core.task, sha256);
  const baseline = await readWorkflowE2EBaseline(dependencies, task).catch(() => undefined);
  return loadStoredWorkflowE2EArtifact({ s3: dependencies.s3, artifactBucketName: dependencies.artifactBucketName }, task, sha256, baseline === undefined ? {} : { baseline });
}

export async function workflowE2EPublicationChecks(
  dependencies: AwsBrokerDependencies,
  hooks: E2EVerificationHooks,
  task: DeveloperTaskRecord,
  operations: readonly unknown[],
): Promise<TransactItems | undefined> {
  if (task.workflow?.e2e?.required !== true) return [];
  const candidate = CandidateManifestSchema.safeParse(task.workflow.candidate);
  const roundId = task.workflow.e2e.currentRoundId;
  if (!candidate.success || roundId === undefined || task.closedAt !== undefined) return undefined;
  const candidates = operations.flatMap((raw) => (typeof raw === "object" && raw !== null && "id" in raw && typeof raw.id === "string" ? [raw.id] : []));
  const checks: OperationRecord[] = [];
  for (const id of candidates) {
    const operation = await getItem<OperationRecord>(dependencies, operationKey(task.workspaceId, id));
    if (operation?.entityType === "OPERATION" && operation.kind === "task" && operation.workflowMode === "CHECKS"
      && operation.workflowE2EAdmission?.taskId === task.taskId && operation.workflowE2EAdmission.roundId === roundId
      && operation.workflowE2EAdmission.candidateDigest === candidate.data.digest && operation.workflowE2EEvidenceRef !== undefined) {
      checks.push(operation);
    }
  }
  checks.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const operation = checks[0];
  if (operation === undefined) return undefined;
  const diagnostic: WorkflowE2EVerificationDiagnostic = {};
  if (await verifyWorkflowE2EEvidence(dependencies, hooks, operation, task, candidate.data, undefined, diagnostic) !== "PASS"
    || diagnostic.authorityChecks === undefined || diagnostic.authorityChecks.length === 0) return undefined;
  return diagnostic.authorityChecks;
}
