import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { E2E_APPLICATION_GROUP_EVIDENCE_MAX_BYTES, E2E_HARD_LIMITS, canonicalJson, type E2EApplicationBuildSourceManifest, type E2EApplicationExecutionAdmission, type E2ERunBinding, type E2ERunInput, type E2EWorkflowAdmissionRef,
  type WorkerInvocation } from "@agentx/contracts";
import { collectE2EApplicationRun, decodeE2EApplicationExecutionAdmission, e2eApplicationPrivateTransferMaxBytes, runIsolatedE2EApplication,
  validateE2EApplicationExecutionAdmission, type DockerApplicationHost, type E2ECompiledApplicationSuite } from "@agentx/verifier";
import { runWithConcurrency } from "./bounded-concurrency.js";
import { admittedRepositoryOf, assertBuildSourceBelongsToCandidate, createProcessCandidateGit, stageCandidateSource, type CandidateGit } from "./e2e-candidate-source.js";

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const MAX_CONCURRENT_APPLICATION_GROUPS = 2;
/** What a group that never reached a trustworthy result keeps of the host's redacted logs, per log. */
const DIAGNOSTIC_TAIL_BYTES = 16 * 1024;
const RUN_SEED_PROFILE_DIGEST = sha("rovara-docker-run-seed/v1");

/** What running an application admission needs: a staging directory the Docker host shares, the Docker host itself, and how the candidate commit is read. */
export type WorkflowE2EApplicationRuntime = Readonly<{
  /** A directory on the Docker host at the same path inside the worker; the candidate is staged under it and each run gets its own workspace beside it. */
  runRoot: string;
  /** Builds the one Docker application host a group runs on (one run per host). It must use the supplied admission, group and staged source as they are. */
  createHost(input: { admission: E2EApplicationExecutionAdmission; groupId: string; candidateSourceDir: string }): DockerApplicationHost;
  /** Default: the `git` and `tar` on this machine. */
  git?: CandidateGit;
  /** Default: the application collector. */
  collect?: typeof collectE2EApplicationRun;
}>;

/** The last `maxBytes` bytes of `text`, starting on a character boundary so no sequence is split into replacement characters. */
export function utf8Tail(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= maxBytes) return text;
  let start = bytes.byteLength - maxBytes;
  while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString("utf8");
}
const tail = (text: string) => utf8Tail(text, DIAGNOSTIC_TAIL_BYTES);

/** The lifecycle input for one group, derived from what the admission already approved and nothing else. */
function applicationRunInput(compiled: E2ECompiledApplicationSuite, binding: E2ERunBinding): E2ERunInput {
  const context = compiled.runtimeAdmissionContext;
  const targetIds = new Set(compiled.group.targetIds);
  const kinds = new Set(context.executionPlan.effectiveTargets.filter((target) => targetIds.has(target.targetId)).map((target) => target.kind));
  const kind = kinds.size === 1 ? [...kinds][0] : undefined;
  if (kind !== "web" && kind !== "api") throw new Error("application group must run exactly one web or API target kind");
  const runtime = compiled.runtimeBindings.get(compiled.group.runtimeProfileId);
  if (!runtime) throw new Error("application group has no registered runtime binding");
  const applicationIds = [...new Set(context.selectionInput.intent.applicationRuntimeRefs.filter((ref) => targetIds.has(ref.targetId)).map((ref) => ref.applicationId))].sort();
  const applications = applicationIds.map((applicationId) => {
    const application = compiled.applicationBindings.get(applicationId);
    const approved = application?.approval.applications.find((item) => item.applicationId === applicationId);
    if (!application || !approved) throw new Error("application runtime profile lacks an exact approved build and recipe binding");
    return { applicationId, appBuildManifestDigest: application.build.manifestDigest, appRecipe: approved.recipe };
  });
  return { binding,
    // The compiled shard files are the lifecycle's suite handle; the executor recompiles the group from the admission inside its own container.
    suite: { bundle: compiled.bundle, files: compiled.shards[0]!.files, expectedCases: [...compiled.expectedCases] },
    profile: { profileId: runtime.profileId, kind, runtimeManifestDigest: runtime.manifestDigest, applications, networkPolicyDigest: runtime.capabilities.networkPolicyDigest,
      seedDigest: RUN_SEED_PROFILE_DIGEST, limits: context.selectionInput.policy.limits, capture: context.selectionInput.policy.capture },
    modelPermit: null };
}

/**
 * Executes the exact application admission the server-created CHECKS invocation names: every runnable group on the Docker application host (one host per
 * group, at most two at once) built from the candidate commit, never widening the admission and never falling back to the portable path.
 */
export async function executeWorkflowE2EApplicationChecks(input: {
  invocation: Extract<WorkerInvocation, { kind: "task" }>; reference: E2EWorkflowAdmissionRef; admissionBytes: Buffer;
  runtime: () => WorkflowE2EApplicationRuntime;
  candidateRepositoryRoot: (repositoryId: string) => string | undefined;
  saveEvidence: (bytes: Uint8Array, sha256: string, maxBytes: number, groupRunId?: string) => Promise<{ key: string; sha256: string }>;
  deadlineAt?: number; signal?: AbortSignal; throwIfCancelled: () => void;
}): Promise<{ evidenceRef: { key: string; sha256: string }; candidateDigest: string; roundId: string; processStatus: "SUCCEEDED" | "FAILED" }> {
  const { invocation, reference } = input;
  const admission = decodeE2EApplicationExecutionAdmission(input.admissionBytes);
  const runIds = admission.groups.map((group) => group.outerBinding.runId);
  if (admission.taskId !== reference.taskId || admission.operationId !== invocation.operationId || admission.operationFence !== invocation.fence
    || admission.workflowRevision !== reference.workflowRevision || admission.candidateDigest !== reference.candidateDigest
    || admission.round.roundId !== reference.roundId || admission.round.groupBindings.length !== admission.groups.length
    || canonicalJson([...runIds].sort()) !== canonicalJson([...reference.groupRunIds].sort()) || new Set(runIds).size !== runIds.length) {
    throw new Error("native E2E application admission does not match the signed CHECKS invocation");
  }
  const validated = validateE2EApplicationExecutionAdmission(admission);
  // The portable child groups of a mixed plan are not executed here; running them would be a second authority, so they are refused rather than skipped.
  if (admission.portableProjection !== null || admission.groups.some((group) => group.protocol !== "trusted-e2e-application/v1")
    || validated.applicationSuites.length !== admission.groups.length || validated.applicationSuites.length === 0) {
    throw new Error("native E2E application admission carries groups this worker does not execute");
  }
  const round = admission.round;
  const deadline = Date.parse(round.deadlineAt);
  if (!Number.isFinite(deadline) || deadline <= Date.now() || (input.deadlineAt !== undefined && deadline > input.deadlineAt)) throw new Error("native E2E round deadline is invalid or expired");
  // The round schema bounds the run from its admittedAt; this bounds it from now, so no admission can keep a run alive past the hard limit (and the stale-run sweep age).
  if (deadline - Date.now() > E2E_HARD_LIMITS.runTimeoutMs) throw new Error("native E2E round deadline is further away than the hard run limit");
  const runtime = input.runtime();
  input.throwIfCancelled();

  const controller = new AbortController();
  const abortFromOperation = () => controller.abort(input.signal?.reason);
  input.signal?.addEventListener("abort", abortFromOperation, { once: true });
  if (input.signal?.aborted) abortFromOperation();
  /** Cancellation by the operation, or the stop one group's failure puts on the others. */
  const throwIfStopped = () => {
    input.throwIfCancelled();
    if (controller.signal.aborted) throw controller.signal.reason instanceof Error ? controller.signal.reason : new Error("native E2E application checks were stopped");
  };
  const stagedSource = join(resolve(runtime.runRoot), `candidate-${round.roundId}`);
  try {
    const admitted = { repositoryId: admittedRepositoryOf(admission.sourceSnapshot.candidate, admission.candidateCommitSha, admission.candidateTreeSha),
      commitSha: admission.candidateCommitSha, treeSha: admission.candidateTreeSha };
    const repositoryRoot = input.candidateRepositoryRoot(admitted.repositoryId);
    if (repositoryRoot === undefined) throw new Error("native E2E application candidate repository is not on this worker");
    const manifests = new Map<string, E2EApplicationBuildSourceManifest>();
    for (const suite of validated.applicationSuites) for (const application of suite.applicationBindings.values()) manifests.set(application.buildSource.manifest.manifestDigest, application.buildSource.manifest);
    assertBuildSourceBelongsToCandidate([...manifests.values()], admitted);
    await mkdir(resolve(runtime.runRoot), { recursive: true, mode: 0o700 });
    await stageCandidateSource({ git: runtime.git ?? createProcessCandidateGit(resolve(runtime.runRoot)), repositoryRoot,
      commitSha: admission.candidateCommitSha, treeSha: admission.candidateTreeSha, destination: stagedSource, manifests: [...manifests.values()], signal: controller.signal });
    input.throwIfCancelled();

    const collect = runtime.collect ?? collectE2EApplicationRun;
    const groupLimit = (suite: E2ECompiledApplicationSuite) => Math.min(E2E_APPLICATION_GROUP_EVIDENCE_MAX_BYTES, e2eApplicationPrivateTransferMaxBytes(suite.expectedCases.length, suite.shards.length));
    const runGroup = async (index: number): Promise<{ groupRun: Record<string, unknown>; succeeded: boolean }> => {
      const compiled = validated.applicationSuites[index]!;
      const groupAdmission = admission.groups.find((item) => item.outerBinding.groupId === compiled.group.groupId);
      if (!groupAdmission) throw new Error("native E2E application group is not in its immutable admission");
      const binding = groupAdmission.outerBinding;
      const host = runtime.createHost({ admission, groupId: compiled.group.groupId, candidateSourceDir: stagedSource });
      const run = await runIsolatedE2EApplication({ input: applicationRunInput(compiled, binding), compiled, ports: host, signal: controller.signal });
      throwIfStopped();
      let reason = run.unavailableReason;
      let qualification: ReturnType<typeof collect>["qualification"] = null;
      let collected: ReturnType<typeof collect>["collection"] = null;
      let collectionInputs: Awaited<ReturnType<DockerApplicationHost["readCollectionInputs"]>> | null = null;
      if (run.actualRun !== null && reason === null) {
        try {
          collectionInputs = await host.readCollectionInputs(controller.signal);
          const result = collect({ actual: run.actualRun, compiled, binding, round, ...collectionInputs });
          if (result.qualification !== null && result.collection !== null) { qualification = result.qualification; collected = result.collection; }
          else reason = result.unavailableReason ?? "application collection unavailable";
        } catch (error) {
          throwIfStopped();
          reason = error instanceof Error ? error.message : "application collection unavailable";
        }
      } else reason ??= "application run produced no readback";
      throwIfStopped();
      // The verdict input is only ever what the collector itself qualified; a run that did not get that far is UNKNOWN, whatever its process said.
      const unavailableReason = qualification === null ? reason ?? "application collection unavailable" : qualification.status === "UNKNOWN" ? qualification.reason : null;
      const diagnostics = qualification !== null ? null : (() => {
        const logs = host.readDiagnostics(binding.runId);
        return { appLogTail: tail(logs.appLogTail), buildLogTail: tail(logs.buildLogTail), executorLogTail: tail(logs.executorLogTail) };
      })();
      const groupRun: Record<string, unknown> = { kind: "application", group: validated.executionPlan.groups.find((item) => item.groupId === compiled.group.groupId), binding,
        collection: qualification ?? { status: "UNKNOWN", reason: unavailableReason }, unavailableReason,
        lifecycle: { cleanup: run.lifecycle.cleanup, process: run.lifecycle.process },
        actual: qualification === null ? null : { collection: collected, collectionInputs }, diagnostics };
      const groupEvidence = Buffer.from(JSON.stringify({ schemaVersion: "workflow-e2e-group-evidence/v1", admissionSha256: reference.admissionRef.sha256,
        taskId: admission.taskId, operationId: admission.operationId, operationFence: admission.operationFence, workflowRevision: admission.workflowRevision,
        candidateDigest: admission.candidateDigest, round, groupRun }), "utf8");
      const limit = groupLimit(compiled);
      if (groupEvidence.byteLength > limit) throw new Error("native E2E application group evidence exceeds its group-derived ceiling");
      await input.saveEvidence(groupEvidence, sha(groupEvidence), limit, binding.runId);
      return { groupRun, succeeded: qualification !== null && run.lifecycle.process.exitCode === 0 };
    };
    const groups = await runWithConcurrency(validated.applicationSuites.length, MAX_CONCURRENT_APPLICATION_GROUPS, runGroup, (error) => controller.abort(error));
    input.throwIfCancelled();
    const groupRuns = groups.map((item) => item.groupRun);
    const evidence = Buffer.from(JSON.stringify({ schemaVersion: "workflow-e2e-evidence/v1", admissionSha256: reference.admissionRef.sha256,
      taskId: admission.taskId, operationId: admission.operationId, operationFence: admission.operationFence, workflowRevision: admission.workflowRevision,
      candidateDigest: admission.candidateDigest, round, payload: { kind: "application", groupRuns } }), "utf8");
    const byteLimit = validated.applicationSuites.reduce((total, suite) => total + groupLimit(suite), 0);
    if (evidence.byteLength > byteLimit) throw new Error("native E2E application evidence exceeds its stored group-derived ceiling");
    const evidenceRef = await input.saveEvidence(evidence, sha(evidence), byteLimit);
    return { evidenceRef, candidateDigest: admission.candidateDigest, roundId: round.roundId, processStatus: groups.every((item) => item.succeeded) ? "SUCCEEDED" : "FAILED" };
  } catch (error) {
    controller.abort(error);
    throw error;
  } finally {
    input.signal?.removeEventListener("abort", abortFromOperation);
    await rm(stagedSource, { recursive: true, force: true });
  }
}
