import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  E2EPolicySchema, E2ERoundSchema, E2ERunBindingSchema, E2EScenarioBundleSchema,
  ProjectSetupRunnerEnvironmentSchema, ProjectSetupRunnerToolchainSchema,
  canonicalJson, e2eScenarioBundleDigest, selectE2EExecutionPlan, verifyE2ESourceSnapshot,
  type E2ESourceSnapshot, type WorkerInvocation,
} from "@agentx/contracts";
import { executeWorkflowE2EApplicationChecks, type WorkflowE2EApplicationRuntime } from "./workflow-e2e-application-checks.js";
import { collectE2EActualCliRun, compileE2EScenarios, e2ePrivateTransferMaxBytes, e2eSnapshotSourceDigest, observeInstalledRuntimeManifestForHost, runE2EActualCli } from "@agentx/verifier";

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const MAX_CONCURRENT_E2E_GROUPS = 2;

type Admission = {
  schemaVersion: "workflow-e2e-admission/v1"; taskId: string; operationId: string; operationFence: number; workflowRevision: number;
  candidateDigest: string; sourceSnapshot: Omit<E2ESourceSnapshot, "sources"> & { sources: Array<{ path: string; sha256: string; kind: "blob"; bytesBase64: string }> };
  intent: unknown; policy: unknown; runtime: Record<string, unknown>; plan: unknown; bundle: unknown; selectionInput: Record<string, unknown>;
  portableApprovalBinding: unknown; round: unknown; groupAdmissions: Array<Record<string, unknown>>;
};

/** Executes only the exact immutable admission named by the server-created CHECKS invocation. */
export async function executeWorkflowE2EChecks(input: {
  invocation: Extract<WorkerInvocation, { kind: "task" }>;
  readAdmission: (offset: number) => Promise<{ totalBytes: number; chunkBase64: string; sha256: string }>;
  saveEvidence: (bytes: Uint8Array, sha256: string, maxBytes: number, groupRunId?: string) => Promise<{ key: string; sha256: string }>;
  sourceRoot: string; evidenceRoot: string; deadlineAt?: number; signal?: AbortSignal;
  /** Trusted local supervisor observation; it carries no evidence or qualification authority. */
  onOwnedContainerRunning?: (receipt: Readonly<{ containerId: string; requestId: string; sourceDigest: string; observedAt: string; inspectBytes: Uint8Array }>) => Promise<void>;
  /**
   * The Docker application runtime an application admission runs on, or how to build it once it is needed. Portable admissions never ask for it, so a worker
   * without one still runs portable rounds.
   */
  application?: WorkflowE2EApplicationRuntime | (() => WorkflowE2EApplicationRuntime);
  /** The local directory of the candidate repository with this id, for `git archive`; an application admission falls back to `sourceRoot`. */
  candidateRepositoryRoot?: (repositoryId: string) => string | undefined;
}): Promise<{ evidenceRef: { key: string; sha256: string }; candidateDigest: string; roundId: string; processStatus: "SUCCEEDED" | "FAILED" }> {
  const { invocation } = input;
  const reference = invocation.payload.workflowE2EAdmission;
  if (invocation.payload.workflowMode !== "CHECKS" || reference === undefined) throw new Error("native E2E checks require a broker-assigned CHECKS admission");
  const throwIfCancelled = () => {
    if (input.signal?.aborted) throw input.signal.reason instanceof Error ? input.signal.reason : new Error("native E2E checks were cancelled");
  };
  throwIfCancelled();
  const chunks: Buffer[] = [];
  let totalBytes = -1;
  let declaredDigest = "";
  for (let offset = 0; totalBytes < 0 || offset < totalBytes; offset += 64 * 1024) {
    throwIfCancelled();
    const piece = await input.readAdmission(offset);
    throwIfCancelled();
    if (totalBytes < 0) { totalBytes = piece.totalBytes; declaredDigest = piece.sha256; }
    const bytes = Buffer.from(piece.chunkBase64, "base64");
    if (piece.totalBytes !== totalBytes || piece.sha256 !== declaredDigest || bytes.byteLength === 0 || bytes.byteLength > 64 * 1024
      || bytes.toString("base64") !== piece.chunkBase64 || offset + bytes.byteLength > totalBytes) throw new Error("native E2E admission chunks are inconsistent");
    chunks.push(bytes);
  }
  const admissionBytes = Buffer.concat(chunks);
  if (admissionBytes.byteLength !== reference.admissionRef.byteLength || declaredDigest !== reference.admissionRef.sha256
    || sha(admissionBytes) !== reference.admissionRef.sha256) throw new Error("native E2E admission content address is invalid");
  const parsedAdmission = JSON.parse(admissionBytes.toString("utf8")) as Admission;
  // The admission's own schema version picks the path. An application admission never reaches the portable code below, and a portable one never reaches Docker.
  if ((parsedAdmission as { schemaVersion?: unknown } | null)?.schemaVersion === "workflow-e2e-application-admission/v1") {
    return executeWorkflowE2EApplicationChecks({ invocation, reference, admissionBytes,
      runtime: () => {
        const application = typeof input.application === "function" ? input.application() : input.application;
        if (application === undefined) throw new Error("native E2E application admission needs a configured Docker application runtime");
        return application;
      },
      candidateRepositoryRoot: input.candidateRepositoryRoot ?? (() => undefined), fallbackRepositoryRoot: input.sourceRoot,
      saveEvidence: input.saveEvidence, ...(input.deadlineAt === undefined ? {} : { deadlineAt: input.deadlineAt }),
      ...(input.signal === undefined ? {} : { signal: input.signal }), throwIfCancelled });
  }
  const admission = parsedAdmission;
  if (admission.schemaVersion !== "workflow-e2e-admission/v1" || admission.taskId !== reference.taskId
    || admission.operationId !== invocation.operationId || admission.operationFence !== invocation.fence
    || admission.workflowRevision !== reference.workflowRevision || admission.candidateDigest !== reference.candidateDigest
    || admission.round === null || typeof admission.round !== "object") throw new Error("native E2E admission does not match the signed CHECKS invocation");
  const snapshot: E2ESourceSnapshot = { ...admission.sourceSnapshot, sources: admission.sourceSnapshot.sources.map((source) => ({
    path: source.path, sha256: source.sha256, kind: source.kind, bytes: Buffer.from(source.bytesBase64, "base64"),
  })) };
  verifyE2ESourceSnapshot(snapshot, snapshot.candidate);
  if (snapshot.candidate.digest !== admission.candidateDigest) throw new Error("native E2E source snapshot differs from its admitted candidate");
  E2EPolicySchema.parse(admission.policy);
  const selectionInput = { ...admission.selectionInput, sourceSnapshot: snapshot };
  const plan = selectE2EExecutionPlan(selectionInput as never);
  const bundle = E2EScenarioBundleSchema.parse(admission.bundle);
  const round = E2ERoundSchema.parse(admission.round);
  const runtime = admission.runtime;
  const runnerEnvironment = ProjectSetupRunnerEnvironmentSchema.parse(runtime.runnerEnvironment);
  const runnerToolchain = ProjectSetupRunnerToolchainSchema.parse(runtime.runnerToolchain);
  const expectedManifestDigest = typeof runtime.manifestDigest === "string" ? runtime.manifestDigest : typeof runtime.runtimeManifestDigest === "string" ? runtime.runtimeManifestDigest : undefined;
  if (!expectedManifestDigest || !/^[a-f0-9]{64}$/.test(expectedManifestDigest)) throw new Error("native E2E admission has no exact installed runtime manifest digest");
  const installedManifest = await observeInstalledRuntimeManifestForHost(process.platform, process.arch);
  if (installedManifest.sha256 !== expectedManifestDigest) throw new Error("installed native E2E runtime manifest differs from the admitted verifier runtime");
  if (sha(canonicalJson(runnerToolchain)) !== runtime.runnerToolchainDigest || round.taskId !== admission.taskId
    || round.operationId !== invocation.operationId || round.operationFence !== invocation.fence
    || round.workflowRevision !== reference.workflowRevision
    || round.roundId !== reference.roundId || round.groupBindings.length !== plan.groups.length
    || plan.groups.length !== admission.groupAdmissions.length || plan.groups.length !== reference.groupRunIds.length) {
    throw new Error("native E2E round does not match the admitted CHECKS context");
  }
  if (canonicalJson(plan) !== canonicalJson(admission.plan) || bundle.planDigest !== admission.selectionInput.planDigest
    || bundle.bundleDigest !== e2eScenarioBundleDigest(bundle)) {
    throw new Error("native E2E plan or scenario bundle changed after admission");
  }
  const deadline = Date.parse(round.deadlineAt);
  if (!Number.isFinite(deadline) || deadline <= Date.now() || (input.deadlineAt !== undefined && deadline > input.deadlineAt)) throw new Error("native E2E round deadline is invalid or expired");
  const evidenceDirectory = join(resolve(input.evidenceRoot), `workflow-e2e-${round.roundId}`);
  await mkdir(evidenceDirectory, { recursive: false, mode: 0o700 });
  const controller = new AbortController();
  const abortFromOperation = () => controller.abort(input.signal?.reason);
  input.signal?.addEventListener("abort", abortFromOperation, { once: true });
  if (input.signal?.aborted) abortFromOperation();
  const runGroup = async (group: (typeof plan.groups)[number], index: number): Promise<Record<string, unknown>> => {
    try {
    const groupAdmission = admission.groupAdmissions[index];
    if (!groupAdmission || canonicalJson(groupAdmission.group) !== canonicalJson(group)) throw new Error("native E2E group order differs from immutable admission");
    const binding = E2ERunBindingSchema.parse(groupAdmission.binding);
    if (binding.runId !== reference.groupRunIds[index] || binding.taskId !== admission.taskId || binding.operationId !== invocation.operationId
      || binding.operationFence !== invocation.fence || binding.workflowRevision !== reference.workflowRevision
      || binding.roundId !== reference.roundId || binding.candidateDigest !== admission.candidateDigest
      || canonicalJson(round.groupBindings[index]) !== canonicalJson(binding)) throw new Error("native E2E group binding differs from the signed operation");
    const compiled = compileE2EScenarios(bundle, plan.effectiveTargets, group, { selectionInput: selectionInput as never, executionPlan: plan, group });
    if (compiled.expectedConfigDigest !== groupAdmission.expectedConfigDigest || compiled.inventory.digest !== groupAdmission.compiledInventoryDigest
      || compiled.selectionPacketPath !== groupAdmission.selectionPacketPath || canonicalJson(compiled.expectedCases) !== canonicalJson(groupAdmission.expectedCases)) {
      throw new Error("native E2E compiler output differs from the immutable group admission");
    }
    const selection = JSON.parse(compiled.files.get(groupAdmission.selectionPacketPath) ?? "null") as Parameters<typeof runE2EActualCli>[0]["selection"];
    const hostRequestIds = new Map([...compiled.hostRequestPayloads.keys()].map((caseId) => [caseId, randomUUID()]));
    const groupEvidenceDirectory = join(evidenceDirectory, group.groupId);
    await mkdir(groupEvidenceDirectory, { mode: 0o700 });
    const actual = await runE2EActualCli({ compiled, snapshot, selection, runnerToolchain, hostRequestIds,
      sourceRoot: await realpath(resolve(input.sourceRoot)), evidenceDirectory: groupEvidenceDirectory, deadlineAt: deadline, signal: controller.signal,
      ...(input.onOwnedContainerRunning === undefined ? {} : { onOwnedContainerRunning: input.onOwnedContainerRunning }), });
    const collection = collectE2EActualCliRun({ actual, compiled, selection,
      sourceDigest: e2eSnapshotSourceDigest(compiled, snapshot.sources.map(({ path, sha256: digest }) => ({ path, sha256: digest }))),
      binding, round, semanticApprovalDigests: new Map(bundle.scenarios.map((scenario) => [scenario.scenarioId,
        (admission.portableApprovalBinding as { semanticApproval?: { digest?: string } }).semanticApproval?.digest ?? "0".repeat(64)])),
      hostRequestIds, declaredMockComponentIds: actual.declaredMockComponentIds, environment: runnerEnvironment,
      usage: { discoveredResults: actual.selected + actual.filtered, maxAgentContextBytes: 0, maxLedgerBytes: 0, maxObservationBytes: 0, artifactBytes: 0, downloads: 0, events: 0, modelTokens: 0, maxModelCallsInStep: 0, maxActionStepsInStep: 0 },
      limits: { maxAgentContextBytes: 16_384, maxLedgerBytes: 8_192, maxObservationBytes: 262_144, maxEventsPerStep: 1_000, maxModelTokensPerCall: 64_000 },
    });
    const groupRun = { group, binding, selection, hostRequestIds: [...hostRequestIds], collection: collection.qualification ?? { status: "UNKNOWN", reason: collection.unavailableReason ?? "collection unavailable" },
      actual: { launchId: actual.launchId, runnerToolchain: actual.runnerToolchain, launchConfigDigest: actual.launchConfigDigest, fixedAssetDigests: actual.fixedAssetDigests,
        publicList: actual.publicList, selected: actual.selected, filtered: actual.filtered, rawReportBase64: Buffer.from(actual.rawReportBytes).toString("base64"),
        runStartCaptureBase64: Buffer.from(actual.runStartCaptureBytes).toString("base64"), assertionReceipts: actual.assertionReceipts,
        declaredMockComponentIds: actual.declaredMockComponentIds, candidateCaptures: actual.candidateCaptures, listProcess: actual.listProcess,
        runProcess: actual.runProcess, cleanupConfirmed: actual.cleanupConfirmed, cleanupServerListening: actual.cleanupServerListening } };
    const groupEvidence = Buffer.from(JSON.stringify({ schemaVersion: "workflow-e2e-group-evidence/v1", admissionSha256: reference.admissionRef.sha256,
      taskId: admission.taskId, operationId: admission.operationId, operationFence: admission.operationFence, workflowRevision: admission.workflowRevision,
      candidateDigest: admission.candidateDigest, round, groupRun }), "utf8");
    const groupLimit = e2ePrivateTransferMaxBytes(group.expectedCases.length, 1);
    if (groupEvidence.byteLength > groupLimit) throw new Error("native E2E group evidence exceeds its admitted group-derived ceiling");
    await input.saveEvidence(groupEvidence, sha(groupEvidence), groupLimit, binding.runId);
    return groupRun;
    } catch (error) {
      controller.abort(error);
      throw error;
    }
  };
  try {
    const groupRuns: Array<Record<string, unknown>> = [];
    for (let offset = 0; offset < plan.groups.length; offset += MAX_CONCURRENT_E2E_GROUPS) {
      throwIfCancelled();
      const batch = plan.groups.slice(offset, offset + MAX_CONCURRENT_E2E_GROUPS);
      const groupResults = await Promise.allSettled(batch.map((group, index) => runGroup(group, offset + index)));
      const failedGroup = groupResults.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failedGroup) throw failedGroup.reason;
      groupRuns.push(...groupResults.map((result) => (result as PromiseFulfilledResult<Record<string, unknown>>).value));
    }
    throwIfCancelled();
    const evidence = Buffer.from(JSON.stringify({ schemaVersion: "workflow-e2e-evidence/v1", admissionSha256: reference.admissionRef.sha256,
      taskId: admission.taskId, operationId: admission.operationId, operationFence: admission.operationFence, workflowRevision: admission.workflowRevision,
      candidateDigest: admission.candidateDigest, round, groupRuns }), "utf8");
    const byteLimit = e2ePrivateTransferMaxBytes(round.groupBindings.reduce((total, binding) => total + binding.expectedCases.length, 0), round.groupBindings.length);
    if (evidence.byteLength > byteLimit) throw new Error("native E2E evidence exceeds its stored group-derived ceiling");
    const evidenceRef = await input.saveEvidence(evidence, sha(evidence), byteLimit);
    const processStatus = groupRuns.every((run) => (run.actual as { runProcess?: { status?: number } }).runProcess?.status === 0) ? "SUCCEEDED" : "FAILED";
    return { evidenceRef, candidateDigest: admission.candidateDigest, roundId: round.roundId, processStatus };
  } catch (error) {
    controller.abort(error);
    throw error;
  } finally {
    input.signal?.removeEventListener("abort", abortFromOperation);
  }
}
