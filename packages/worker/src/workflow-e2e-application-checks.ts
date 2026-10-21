import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { E2E_APPLICATION_AGGREGATE_EVIDENCE_MAX_BYTES, E2E_APPLICATION_GROUP_EVIDENCE_MAX_BYTES, E2E_HARD_LIMITS, canonicalJson, type E2EApplicationBuildSourceManifest, type E2EApplicationExecutionAdmission, type E2ERunBinding, type E2ERunInput, type E2EWorkflowAdmissionRef,
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

/** The room kept in the aggregate for its own envelope (the round and the framing), which is not any group's. */
const AGGREGATE_ENVELOPE_RESERVE_BYTES = 1024 * 1024;
const EVIDENCE_TOO_LARGE = "evidence too large";

/**
 * How much of a round's aggregate ceiling the groups' evidence has left (Ruling BV). Every group's evidence is uploaded, and the aggregate holds each group's run again, so
 * together they must stay within the ceiling: a group whose evidence would not fit is the one made UNKNOWN, with a small run in its place.
 */
export function createEvidenceBudget(limit: number): { reserve(bytes: number): boolean; remaining(): number } {
  let remaining = limit;
  return { reserve(bytes) { if (bytes > remaining) return false; remaining -= bytes; return true; }, remaining: () => remaining };
}

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
/** How much of each shard's raw report, and of how many shards, a group that never reached a qualification keeps (the head, base64). The executor already redacted it. */
const SHARD_REPORT_DIAGNOSTIC_BYTES = 64 * 1024;
const SHARD_REPORT_DIAGNOSTIC_SHARDS = 8;
/**
 * Said inside the diagnostics themselves: the logs and raw reports are the application's own output (its page text, network URLs and log lines), kept as the application wrote it.
 * Only account credentials are redacted from them. They are for operators; nothing shows them to the task owner or in Slack, and they must stay that way for real customer code.
 */
export const DIAGNOSTICS_NOTICE = "operator-only: the application's own output (log lines, page text, URLs) kept as written, with account credentials redacted";

/**
 * What a run that was read back but not qualified (the collector threw, or answered unavailable) keeps of each shard's raw report, so the reason it was refused can be
 * read from the evidence instead of reproduced. Bounded per shard and in the number of shards; a shape that is not a run's readback keeps nothing.
 */
export function shardReportDiagnostics(actualRun: unknown): Array<{ shardId: string; byteLength: number; truncated: boolean; rawReportBase64: string }> {
  const shards = typeof actualRun === "object" && actualRun !== null ? (actualRun as { shards?: unknown }).shards : undefined;
  if (!Array.isArray(shards)) return [];
  const kept: Array<{ shardId: string; byteLength: number; truncated: boolean; rawReportBase64: string }> = [];
  for (const shard of shards.slice(0, SHARD_REPORT_DIAGNOSTIC_SHARDS) as unknown[]) {
    const { shardId, rawReportBytes } = (shard ?? {}) as { shardId?: unknown; rawReportBytes?: unknown };
    if (typeof shardId !== "string" || !(rawReportBytes instanceof Uint8Array)) continue;
    const head = rawReportBytes.subarray(0, SHARD_REPORT_DIAGNOSTIC_BYTES);
    kept.push({ shardId, byteLength: rawReportBytes.byteLength, truncated: rawReportBytes.byteLength > head.byteLength, rawReportBase64: Buffer.from(head).toString("base64") });
  }
  return kept;
}

/** How much of the executor's own log a group keeps, from its start. */
const EXECUTOR_LOG_HEAD_BYTES = 64 * 1024;

/** The first `maxBytes` of `bytes` as text, cut before a partial multi-byte sequence so no replacement character appears. */
function utf8Head(bytes: Uint8Array, maxBytes: number): string {
  let end = Math.min(bytes.byteLength, maxBytes);
  if (end < bytes.byteLength) while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return Buffer.from(bytes.subarray(0, end)).toString("utf8");
}

type CaptureArtifactEntry = { caseId: string; kind: "screenshot" | "trace"; sha256: string; bytes: number; omitted?: "budget" | "credential-match" };
/**
 * Raw output of a run, kept whatever its verdict and for operators only (the application's own output, with account credentials redacted). The shard report and the
 * observations are verdict inputs for a group that was qualified, so they stay in its collection and this only says where; for a group that was not, the report is in
 * `diagnostics.shardReports` and the observations are copied here. The executor's log head and the screenshots and traces of failed cases are here for every group.
 * Nothing reads this to decide a verdict.
 */
export type OperatorEvidence = {
  notice: string;
  rawReportIn: "collection" | "diagnostics.shardReports" | null;
  observationsIn: "collection" | "operatorEvidence.observations" | null;
  observations: Array<{ artifactId: string; sha256: string; byteLength: number; mediaType: string; contentBase64: string | null }>;
  executorLogHead: string | null;
  captures: { artifacts: CaptureArtifactEntry[]; files: Array<{ name: string; sha256: string; bytes: number; base64: string }> } | null;
};

/** The operator evidence of a run that was read back; null when it holds nothing to keep. */
export function operatorEvidence(actualRun: unknown, qualified: boolean): OperatorEvidence | null {
  if (typeof actualRun !== "object" || actualRun === null) return null;
  const run = actualRun as { supervisorReadback?: { evidence?: unknown }; executorEvidence?: { executorLogHead?: unknown; captures?: unknown } };
  const observations: OperatorEvidence["observations"] = [];
  const items = !qualified && Array.isArray(run.supervisorReadback?.evidence) ? run.supervisorReadback.evidence as unknown[] : [];
  for (const item of items) {
    const { ref, bytes } = (item ?? {}) as { ref?: { artifactId?: unknown; sha256?: unknown; byteLength?: unknown; mediaType?: unknown }; bytes?: unknown };
    if (typeof ref?.artifactId !== "string" || typeof ref.sha256 !== "string" || typeof ref.byteLength !== "number" || typeof ref.mediaType !== "string" || !(bytes instanceof Uint8Array)) continue;
    observations.push({ artifactId: ref.artifactId, sha256: ref.sha256, byteLength: ref.byteLength, mediaType: ref.mediaType, contentBase64: Buffer.from(bytes).toString("base64") });
  }
  const head = run.executorEvidence?.executorLogHead;
  const executorLogHead = head instanceof Uint8Array && head.byteLength > 0 ? utf8Head(head, EXECUTOR_LOG_HEAD_BYTES) : null;
  const rawCaptures = run.executorEvidence?.captures as { artifacts?: unknown; files?: unknown } | null | undefined;
  const captures: OperatorEvidence["captures"] = rawCaptures && Array.isArray(rawCaptures.artifacts) && Array.isArray(rawCaptures.files) ? {
    artifacts: (rawCaptures.artifacts as CaptureArtifactEntry[]).map((entry) => ({ ...entry })),
    files: (rawCaptures.files as Array<{ name: string; sha256: string; bytes: Uint8Array }>).filter((file) => file.bytes instanceof Uint8Array)
      .map((file) => ({ name: file.name, sha256: file.sha256, bytes: file.bytes.byteLength, base64: Buffer.from(file.bytes).toString("base64") })) } : null;
  if (executorLogHead === null && captures === null && observations.length === 0) return null;
  return { notice: DIAGNOSTICS_NOTICE, rawReportIn: qualified ? "collection" : shardReportDiagnostics(actualRun).length > 0 ? "diagnostics.shardReports" : null,
    observationsIn: qualified ? "collection" : observations.length > 0 ? "operatorEvidence.observations" : null, observations, executorLogHead, captures };
}

/**
 * The operator evidence from whole to nothing, each step dropping more and keeping what matters most for longest: the traces go first, then the screenshots (each
 * dropped capture stays listed, as `budget`), then the copied observations' bytes, then all of it. The verdict inputs are never in this list, so a group that has to
 * shed operator evidence to fit keeps every verdict input.
 */
export function operatorEvidenceVariants(whole: OperatorEvidence | null): Array<OperatorEvidence | null> {
  if (whole === null) return [null];
  const dropped = (keep: (name: string) => boolean): OperatorEvidence => ({ ...whole, captures: whole.captures === null ? null : {
    artifacts: whole.captures.artifacts.map((entry) => {
      const stored = whole.captures!.files.some((file) => file.sha256 === entry.sha256 && keep(file.name));
      return entry.omitted !== undefined || stored ? entry : { ...entry, omitted: "budget" as const };
    }),
    files: whole.captures.files.filter((file) => keep(file.name)) } });
  const withoutObservationBytes: OperatorEvidence = { ...dropped(() => false), observations: whole.observations.map((item) => ({ ...item, contentBase64: null })) };
  return [whole, dropped((name) => !name.endsWith("-trace.zip")), dropped(() => false), withoutObservationBytes, null];
}

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
    const aggregateLimit = Math.min(E2E_APPLICATION_AGGREGATE_EVIDENCE_MAX_BYTES, validated.applicationSuites.reduce((total, suite) => total + groupLimit(suite), 0));
    const budget = createEvidenceBudget(Math.max(0, aggregateLimit - AGGREGATE_ENVELOPE_RESERVE_BYTES));
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
        const shardReports = run.actualRun === null ? [] : shardReportDiagnostics(run.actualRun);
        return { notice: DIAGNOSTICS_NOTICE, appLogTail: tail(logs.appLogTail), buildLogTail: tail(logs.buildLogTail), executorLogTail: tail(logs.executorLogTail), ...(shardReports.length === 0 ? {} : { shardReports }) };
      })();
      const wholeOperator = run.actualRun === null ? null : operatorEvidence(run.actualRun, qualification !== null);
      const groupRun: Record<string, unknown> = { kind: "application", group: validated.executionPlan.groups.find((item) => item.groupId === compiled.group.groupId), binding,
        collection: qualification ?? { status: "UNKNOWN", reason: unavailableReason }, unavailableReason,
        lifecycle: { cleanup: run.lifecycle.cleanup, process: run.lifecycle.process },
        actual: qualification === null ? null : { collection: collected, collectionInputs }, diagnostics, operatorEvidence: wholeOperator };
      const envelope = (value: Record<string, unknown>) => Buffer.from(JSON.stringify({ schemaVersion: "workflow-e2e-group-evidence/v1", admissionSha256: reference.admissionRef.sha256,
        taskId: admission.taskId, operationId: admission.operationId, operationFence: admission.operationFence, workflowRevision: admission.workflowRevision,
        candidateDigest: admission.candidateDigest, round, groupRun: value }), "utf8");
      const limit = groupLimit(compiled);
      const succeeded = qualification !== null && run.lifecycle.process.exitCode === 0;
      // Operator evidence (captures, copied observations, the executor log head) is what gives way when evidence is tight, in the order of operatorEvidenceVariants; the verdict
      // inputs never do. The first form that the broker would take and the aggregate has room for is the one uploaded.
      let uploaded: { groupRun: Record<string, unknown>; evidence: Buffer; succeeded: boolean } | null = null;
      for (const variant of operatorEvidenceVariants(wholeOperator)) {
        const candidate = { ...groupRun, operatorEvidence: variant };
        const evidence = envelope(candidate);
        if (evidence.byteLength <= limit && evidence.byteLength <= budget.remaining()) { budget.reserve(evidence.byteLength); uploaded = { groupRun: candidate, evidence, succeeded }; break; }
      }
      // Evidence the broker would refuse even without operator evidence (over the group ceiling, or more than the aggregate has room for) is never sent: this group is UNKNOWN, for a reason that names the cause.
      if (uploaded === null) {
        console.log(JSON.stringify({ component: "worker", event: "workflow.e2e_evidence_too_large", groupRunId: binding.runId, evidenceBytes: envelope({ ...groupRun, operatorEvidence: null }).byteLength,
          limitBytes: limit, aggregateRemainingBytes: budget.remaining() }));
        const reduced: Record<string, unknown> = { ...groupRun, collection: { status: "UNKNOWN", reason: EVIDENCE_TOO_LARGE }, unavailableReason: EVIDENCE_TOO_LARGE, actual: null, diagnostics: null, operatorEvidence: null };
        uploaded = { groupRun: reduced, evidence: envelope(reduced), succeeded: false };
        budget.reserve(Math.min(uploaded.evidence.byteLength, budget.remaining()));
      }
      await input.saveEvidence(uploaded.evidence, sha(uploaded.evidence), limit, binding.runId);
      return { groupRun: uploaded.groupRun, succeeded: uploaded.succeeded };
    };
    const groups = await runWithConcurrency(validated.applicationSuites.length, MAX_CONCURRENT_APPLICATION_GROUPS, runGroup, (error) => controller.abort(error));
    input.throwIfCancelled();
    const groupRuns = groups.map((item) => item.groupRun);
    const evidence = Buffer.from(JSON.stringify({ schemaVersion: "workflow-e2e-evidence/v1", admissionSha256: reference.admissionRef.sha256,
      taskId: admission.taskId, operationId: admission.operationId, operationFence: admission.operationFence, workflowRevision: admission.workflowRevision,
      candidateDigest: admission.candidateDigest, round, payload: { kind: "application", groupRuns } }), "utf8");
    const byteLimit = aggregateLimit;
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
