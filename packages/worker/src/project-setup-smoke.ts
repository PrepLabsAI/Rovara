import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  E2EScenarioBundleSchema, E2EPolicySchema,
  ProjectSetupRunnerEnvironmentSchema, ProjectSetupRunnerToolchainSchema,
  canonicalJson, e2eScenarioBundleDigest, selectE2EExecutionPlan,
  verifyE2ESourceSnapshot, E2ERunBindingSchema, E2ERoundSchema, type E2EPlanSelectionInput, type E2ESourceSnapshot,
} from "@agentx/contracts";
import { compileE2EScenarios, runE2EActualCli, collectE2EActualCliRun, e2eSnapshotSourceDigest } from "@agentx/verifier";
import type { WorkerInvocation } from "@agentx/contracts";

const sha = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

type SetupExecutionObject = {
  domain: "project-setup-source-interface/v1";
  schemaVersion: 1;
  setupExecutionId: string;
  subjectId: string;
  transportCorrelationId: string;
  candidateDigest: string;
  planDigest: string;
  policy: unknown;
  sourceSnapshot: Omit<E2ESourceSnapshot, "sources"> & { sources: Array<{ path: string; sha256: string; kind: "blob"; bytesBase64: string }> };
  selectionInput: Omit<E2EPlanSelectionInput, "sourceSnapshot">;
  scenarios: E2EPlanSelectionInput["scenarios"];
  discoveredApplications: Array<Record<string, unknown>>;
  discoveryMissingInputs: Array<Record<string, unknown>>;
  discoveredTargetIds: string[];
  semanticApproval: { artifactId: string; digest: string };
  setupRunContext: { roundId: string; deadlineAt: string; runnerEnvironment: unknown; runnerToolchain: unknown; runnerToolchainDigest: string; plan: unknown; bundle: unknown; round: unknown;
    groupAdmissions: Array<{ group: unknown; binding: unknown; expectedConfigDigest: string; compiledInventoryDigest: string; expectedCases: unknown; selectionPacketPath: string }> };
  evidenceByteLimit: number;
  unsupportedTargetIds: string[];
  notExecutedTargetIds: string[];
};

/** Rebuilds the runtime from the authenticated, content-addressed setup execution object. */
export async function executeProjectSetupSmoke(input: {
  invocation: Extract<WorkerInvocation, { kind: "project-setup-smoke" }>;
  loadExecution: (key: string) => Promise<Uint8Array>;
  sourceRoot: string;
  evidenceRoot: string;
  deadlineAt?: number;
  saveEvidence: (bytes: Uint8Array, sha256: string, admittedByteLimit: number) => Promise<{ key: string; sha256: string }>;
}): Promise<{ domain: string; setupExecutionId: string; operationId: string; candidateDigest: string; processStatus: "SUCCEEDED" | "FAILED"; qualification: "PASS" | "FAILED" | "UNKNOWN"; cleanupConfirmed: boolean; evidenceRef: { key: string; sha256: string } }> {
  const { invocation } = input;
  const bytes = await input.loadExecution(invocation.payload.executionRef.key);
  if (sha(bytes) !== invocation.payload.executionRef.sha256) throw new Error("project setup execution object digest mismatch");
  const execution = JSON.parse(Buffer.from(bytes).toString("utf8")) as SetupExecutionObject;
  if (execution.domain !== "project-setup-source-interface/v1" || execution.setupExecutionId !== invocation.payload.setupExecutionId
    || execution.subjectId !== invocation.payload.subjectId || execution.transportCorrelationId !== invocation.payload.transportCorrelationId
    || execution.setupExecutionId !== invocation.payload.setupExecutionId || execution.candidateDigest !== execution.sourceSnapshot.candidate.digest
    || execution.planDigest !== execution.selectionInput.planDigest) throw new Error("project setup execution object does not match the signed invocation or candidate");
  const snapshot: E2ESourceSnapshot = {
    ...execution.sourceSnapshot,
    sources: execution.sourceSnapshot.sources.map((source) => ({ path: source.path, sha256: source.sha256, kind: source.kind, bytes: Buffer.from(source.bytesBase64, "base64") })),
  };
  verifyE2ESourceSnapshot(snapshot, snapshot.candidate);
  const policy = E2EPolicySchema.parse(execution.policy);
  const selectionInput = { ...execution.selectionInput, sourceSnapshot: snapshot };
  if (canonicalJson(selectionInput.policy) !== canonicalJson(policy) || canonicalJson(selectionInput.scenarios) !== canonicalJson(execution.scenarios)) throw new Error("project setup selection context differs from its stored approved policy or scenarios");
  const plan = selectE2EExecutionPlan(selectionInput);
  const bundleBody = { schemaVersion: 1 as const, planDigest: execution.planDigest, templateVersion: "trusted-e2e/v1", scenarios: execution.scenarios, bundleDigest: "0".repeat(64) };
  const bundle = E2EScenarioBundleSchema.parse({ ...bundleBody, bundleDigest: e2eScenarioBundleDigest(bundleBody) });
  if (canonicalJson(plan) !== canonicalJson(execution.setupRunContext.plan)
    || canonicalJson(bundle) !== canonicalJson(execution.setupRunContext.bundle)
    || plan.groups.length !== execution.setupRunContext.groupAdmissions.length || plan.groups.length === 0) throw new Error("recompiled setup plan or scenario bundle differs from immutable admission");
  const runnerEnvironment = ProjectSetupRunnerEnvironmentSchema.parse(execution.setupRunContext.runnerEnvironment);
  const runnerToolchain = ProjectSetupRunnerToolchainSchema.parse(execution.setupRunContext.runnerToolchain);
  if (sha(canonicalJson(runnerToolchain)) !== execution.setupRunContext.runnerToolchainDigest) throw new Error("stored setup runner toolchain digest is invalid");
  const round = E2ERoundSchema.parse(execution.setupRunContext.round);
  if (round.groupBindings.length !== plan.groups.length || round.roundId !== execution.setupRunContext.roundId) throw new Error("stored setup round does not cover every compiled group");
  const evidenceRoot = resolve(input.evidenceRoot);
  const evidenceDirectory = join(evidenceRoot, `project-setup-${execution.setupExecutionId}`);
  await mkdir(evidenceDirectory, { mode: 0o700 });
  const controller = new AbortController();
  const deadlineAt = Date.parse(execution.setupRunContext.deadlineAt);
  if (!Number.isFinite(deadlineAt) || deadlineAt <= Date.now() || (input.deadlineAt !== undefined && deadlineAt > input.deadlineAt)) throw new Error("stored project setup deadline is invalid or expired");
  const semanticApprovalDigests = new Map(bundle.scenarios.map((scenario) => [scenario.scenarioId, execution.semanticApproval.digest]));
  const groupResults = [] as Array<Record<string, unknown>>;
  for (const [index, group] of plan.groups.entries()) {
    const admission = execution.setupRunContext.groupAdmissions[index];
    if (!admission || canonicalJson(admission.group) !== canonicalJson(group)) throw new Error("stored setup group order or identity changed");
    const binding = E2ERunBindingSchema.parse(admission.binding);
    if (sha(canonicalJson(runnerEnvironment)) !== binding.environmentDigest || binding.operationId !== invocation.operationId
      || binding.operationFence !== invocation.fence || binding.workflowRevision !== invocation.projectRevision
      || binding.candidateDigest !== execution.candidateDigest || binding.planDigest !== execution.planDigest
      || binding.groupId !== group.groupId || binding.roundId !== round.roundId
      || canonicalJson(round.groupBindings[index]) !== canonicalJson(binding) || round.deadlineAt !== execution.setupRunContext.deadlineAt) throw new Error("stored setup binding or round does not match the signed invocation");
    const compiled = compileE2EScenarios(bundle, plan.effectiveTargets, group, { selectionInput, executionPlan: plan, group });
    if (compiled.bundle.planDigest !== execution.planDigest || compiled.runtimeAdmission.expectedCandidate.digest !== execution.candidateDigest
      || compiled.expectedConfigDigest !== admission.expectedConfigDigest || compiled.inventory.digest !== admission.compiledInventoryDigest
      || compiled.selectionPacketPath !== admission.selectionPacketPath || canonicalJson(compiled.expectedCases) !== canonicalJson(admission.expectedCases)) throw new Error("project setup compiler context changed its approved group, candidate, or stored admission");
    const selection = JSON.parse(compiled.files.get(admission.selectionPacketPath) ?? "null") as Parameters<typeof runE2EActualCli>[0]["selection"];
    const hostRequestIds = new Map([...compiled.hostRequestPayloads.keys()].map((caseId) => [caseId, randomUUID()]));
    const groupEvidenceDirectory = join(evidenceDirectory, group.groupId);
    await mkdir(groupEvidenceDirectory, { mode: 0o700 });
    const actual = await runE2EActualCli({ compiled, snapshot, selection, runnerToolchain, hostRequestIds, sourceRoot: resolve(input.sourceRoot),
      evidenceDirectory: groupEvidenceDirectory, deadlineAt, signal: controller.signal });
    const collection = collectE2EActualCliRun({
      actual, compiled, selection, sourceDigest: e2eSnapshotSourceDigest(compiled, snapshot.sources.map(({ path, sha256: digest }) => ({ path, sha256: digest }))),
      binding, round, semanticApprovalDigests, hostRequestIds, declaredMockComponentIds: actual.declaredMockComponentIds,
      environment: runnerEnvironment,
      usage: { discoveredResults: actual.selected + actual.filtered, maxAgentContextBytes: 0, maxLedgerBytes: 0, maxObservationBytes: 0, artifactBytes: 0, downloads: 0, events: 0, modelTokens: 0, maxModelCallsInStep: 0, maxActionStepsInStep: 0 },
      limits: { maxAgentContextBytes: 16_384, maxLedgerBytes: 8_192, maxObservationBytes: 262_144, maxEventsPerStep: 1_000, maxModelTokensPerCall: 64_000 },
    });
    groupResults.push({ group, binding, selection, hostRequestIds: [...hostRequestIds], qualification: collection.qualification?.status ?? "UNKNOWN",
      collectionReason: collection.qualification?.reason ?? collection.unavailableReason, actual });
  }
  const qualification = groupResults.some((item) => item.qualification === "FAILED") ? "FAILED"
    : groupResults.length === plan.groups.length && groupResults.every((item) => item.qualification === "PASS") ? "PASS" : "UNKNOWN";
  const cleanupConfirmed = groupResults.every((item) => {
    const actual = item.actual as { cleanupConfirmed?: boolean; cleanupServerListening?: boolean };
    return actual.cleanupConfirmed === true && actual.cleanupServerListening === false;
  });
  const processStatus = groupResults.some((item) => (item.actual as { runProcess?: { status?: number } }).runProcess?.status !== 0) ? "FAILED" : "SUCCEEDED";
  const evidenceBytes = Buffer.from(JSON.stringify({
    schemaVersion: "project-setup-smoke-evidence/v1", setupExecutionId: execution.setupExecutionId, subjectId: execution.subjectId,
    transportCorrelationId: execution.transportCorrelationId, executionRefSha256: invocation.payload.executionRef.sha256,
    candidateDigest: execution.candidateDigest, planDigest: execution.planDigest,
    runnerToolchain, runnerToolchainDigest: execution.setupRunContext.runnerToolchainDigest,
    discoveredApplications: execution.discoveredApplications, discoveryMissingInputs: execution.discoveryMissingInputs,
    discoveredTargetIds: execution.discoveredTargetIds,
      round, unsupportedTargetIds: execution.unsupportedTargetIds, notExecutedTargetIds: execution.notExecutedTargetIds,
    semanticApprovalDigests: bundle.scenarios.map((scenario) => [scenario.scenarioId, execution.semanticApproval.digest]),
      environment: runnerEnvironment,
    usage: { discoveredResults: groupResults.reduce((total, item) => { const actual = item.actual as { selected: number; filtered: number }; return total + actual.selected + actual.filtered; }, 0),
      maxAgentContextBytes: 0, maxLedgerBytes: 0, maxObservationBytes: 0, artifactBytes: 0, downloads: 0, events: 0, modelTokens: 0, maxModelCallsInStep: 0, maxActionStepsInStep: 0 },
    limits: { maxAgentContextBytes: 16_384, maxLedgerBytes: 8_192, maxObservationBytes: 262_144, maxEventsPerStep: 1_000, maxModelTokensPerCall: 64_000 },
    groupRuns: groupResults.map(({ group, binding, selection, hostRequestIds, qualification: groupQualification, collectionReason, actual: actualValue }) => {
      const actual = actualValue as Awaited<ReturnType<typeof runE2EActualCli>>;
      return { group, binding, selection, hostRequestIds, collection: { status: groupQualification, reason: collectionReason },
        actual: { launchId: actual.launchId, runnerToolchain: actual.runnerToolchain, launchConfigDigest: actual.launchConfigDigest, fixedAssetDigests: actual.fixedAssetDigests,
          publicList: actual.publicList, selected: actual.selected, filtered: actual.filtered, rawReportBase64: Buffer.from(actual.rawReportBytes).toString("base64"),
          runStartCaptureBase64: Buffer.from(actual.runStartCaptureBytes).toString("base64"), assertionReceipts: actual.assertionReceipts,
          declaredMockComponentIds: actual.declaredMockComponentIds, candidateCaptures: actual.candidateCaptures, listProcess: actual.listProcess,
          runProcess: actual.runProcess, cleanupConfirmed: actual.cleanupConfirmed, cleanupServerListening: actual.cleanupServerListening } };
    }),
  }), "utf8");
  const evidenceRef = await input.saveEvidence(evidenceBytes, sha(evidenceBytes), execution.evidenceByteLimit);
  return { domain: "project-setup-source-interface/v1", setupExecutionId: execution.setupExecutionId, operationId: invocation.operationId,
    candidateDigest: execution.candidateDigest, processStatus,
    qualification: cleanupConfirmed ? qualification : "UNKNOWN", cleanupConfirmed,
    evidenceRef };
}
