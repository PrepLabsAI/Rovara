import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { E2E_APPLICATION_AGGREGATE_EVIDENCE_MAX_BYTES, E2E_APPLICATION_GROUP_EVIDENCE_MAX_BYTES, E2E_HARD_LIMITS, E2E_RUNTIME_ENVIRONMENT_DRIFTED_CODE, canonicalJson, type E2ECollection, type E2EModelDayBudgetRequest, type E2EApplicationBuildSourceManifest, type E2EApplicationExecutionAdmission, type E2ERunBinding, type E2ERunInput, type E2EWorkflowAdmissionRef,
  type WorkerInvocation } from "@agentx/contracts";
import { resolveE2EAgentRouteForAdmission, type E2EInvoke } from "@agentx/model-runtime";
import { E2E_AGENT_UNKNOWN_CODES, collectE2EApplicationRun, decodeE2EApplicationExecutionAdmission, e2eApplicationGroupAgentSteps, e2eApplicationGroupUsesModel, e2eApplicationPrivateTransferMaxBytes, runIsolatedE2EApplication,
  e2eCompiledRuntime, validateE2EApplicationExecutionAdmission, type DockerApplicationHost, type DockerApplicationModelChannel, type E2ECompiledApplicationSuite } from "@agentx/verifier";
import { createE2EModelDayBudgetClient } from "./e2e-model-day-budget-client.js";
import { createE2EModelEvidenceCollector, openE2EModelChannelSession, type E2EModelChannelSession } from "./e2e-model-channel-session.js";
import { runWithConcurrency } from "./bounded-concurrency.js";
import { runnerEnvironmentDrifted, type RunnerHostEnvironment } from "./e2e-runtime-environment.js";
import { admittedRepositoryOf, assertBuildSourceBelongsToCandidate, createProcessCandidateGit, stageCandidateSource, type CandidateGit } from "./e2e-candidate-source.js";

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const MAX_CONCURRENT_APPLICATION_GROUPS = 2;
/** What a group that never reached a trustworthy result keeps of the host's redacted logs, per log. */
const DIAGNOSTIC_TAIL_BYTES = 16 * 1024;
const RUN_SEED_PROFILE_DIGEST = sha("rovara-docker-run-seed/v1");
/** The lifecycle of a group that was never started: nothing was allocated, so there is nothing to clean up, and nothing ran. */
const SKIPPED_LIFECYCLE: Pick<E2ECollection, "cleanup" | "process"> = Object.freeze({ cleanup: "confirmed" as const, process: Object.freeze({ exitCode: null, timedOut: false, aborted: false }) });

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
  createHost(input: { admission: E2EApplicationExecutionAdmission; groupId: string; candidateSourceDir: string;
    /** Present only for a group that has an `agent` step: the worker's model channel for that group (Task 4.3a). */
    modelChannel?: DockerApplicationModelChannel }): DockerApplicationHost;
  /** Default: the `git` and `tar` on this machine. */
  git?: CandidateGit;
  /** Default: the application collector. */
  collect?: typeof collectE2EApplicationRun;
  /**
   * This host's operating system (platform and kernel release) and architecture (HARDEN-C I-4). When set, a group whose admitted runtime was qualified on another one is refused at its
   * start as `runtime-environment-drifted`, before any host, container or model channel is made. The production runtime always sets it; a runtime without it (a test double) skips the check.
   */
  hostEnvironment?: () => RunnerHostEnvironment;
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

type CaptureArtifactEntry = { caseId: string; kind: "screenshot"; sha256: string; bytes: number; omitted?: "budget" | "credential-match" };
/**
 * Raw output of a run, kept whatever its verdict and for operators only (the application's own output, with account credentials redacted). The shard report and the
 * observations are verdict inputs for a group that was qualified, so they stay in its collection and this only says where; for a group that was not, the report is in
 * `diagnostics.shardReports` and the observations are copied here. The executor's log head and the screenshots of failed cases are here for every group.
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
 * The most one group's evidence may take: its own ceiling's part of what the aggregate has beyond the room kept for its envelope, in proportion to the ceilings of all the
 * admitted groups (Ruling CM). The ceilings come from the admission, so every group's share is known before any group runs; the shares together are at most that room
 * (each is rounded down), so they can never pass the aggregate; and each is at most its own ceiling, so a group next to a small one keeps nearly its whole ceiling for
 * its verdict inputs, as a first-come budget would have given it.
 */
export function groupEvidenceShare(input: { groupLimit: number; groupLimits: readonly number[]; aggregateLimit: number }): number {
  const total = input.groupLimits.reduce((sum, limit) => sum + limit, 0);
  if (total <= 0) return 0;
  return Math.max(0, Math.min(input.groupLimit, Math.floor(input.groupLimit * (input.aggregateLimit - AGGREGATE_ENVELOPE_RESERVE_BYTES) / total)));
}

/** One group's evidence as the fit sees it: the share it must stay within, its whole operator evidence, and how to serialize its group evidence with a given operator evidence. */
export type GroupEvidenceCandidate = {
  limit: number;
  whole: OperatorEvidence | null;
  build(operator: OperatorEvidence | null): Buffer;
};
export type GroupEvidenceAllocation = { operator: OperatorEvidence | null; evidence: Buffer };

const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

/**
 * Fits one group's evidence into its share. The verdict inputs (the group evidence with no operator evidence) are never shed: if they alone do not fit, the result is null
 * and that group, and only that group, is UNKNOWN "evidence too large". Otherwise operator evidence is shed until it fits, one piece at a time, the largest first: first the
 * capture files (each stays listed as `budget`), then the bytes of the copied observations, then the executor log head, then all of it.
 *
 * The group evidence is serialized once with no operator evidence and once with all of it; what each shed step saves is worked out from the lengths of the pieces (base64
 * text has no escapes, so its length is its size in JSON), and the answer is serialized once more to confirm it. If that check disagrees, shedding goes on, so the
 * result is always one that was measured.
 */
export function fitGroupEvidence(group: GroupEvidenceCandidate): GroupEvidenceAllocation | null {
  const plain = group.build(null);
  if (plain.byteLength > group.limit) return null;
  const whole = group.whole;
  if (whole === null) return { operator: null, evidence: plain };
  const full = group.build(whole);
  if (full.byteLength <= group.limit) return { operator: whole, evidence: full };
  const files = [...(whole.captures?.files ?? [])].sort((a, b) => (b.bytes - a.bytes) || b.name.localeCompare(a.name));
  const observations = whole.observations.map((item, index) => ({ item, index })).sort((a, b) => (b.item.byteLength - a.item.byteLength) || (b.index - a.index));
  const shape = (droppedFiles: number, droppedObservations: number, logKept: boolean): OperatorEvidence => {
    const gone = new Set(files.slice(0, droppedFiles).map((file) => file.name));
    const goneObservations = new Set(observations.slice(0, droppedObservations).map((entry) => entry.index));
    const captures = whole.captures === null ? null : {
      artifacts: whole.captures.artifacts.map((entry) => {
        const stored = whole.captures!.files.some((file) => file.sha256 === entry.sha256 && !gone.has(file.name));
        return entry.omitted !== undefined || stored ? entry : { ...entry, omitted: "budget" as const };
      }),
      files: whole.captures.files.filter((file) => !gone.has(file.name)) };
    return { ...whole, captures, executorLogHead: logKept ? whole.executorLogHead : null,
      observations: whole.observations.map((item, index) => (goneObservations.has(index) ? { ...item, contentBase64: null } : item)) };
  };
  // The size after each step, from the size before it: [files dropped, observations dropped, log kept] -> predicted bytes.
  const steps: Array<{ state: [number, number, boolean]; size: number }> = [];
  let size = full.byteLength;
  let remainingFiles = files.length;
  const listed = whole.captures?.artifacts ?? [];
  files.forEach((file, index) => {
    // The file leaves its array (with one comma, unless it is the last one left), and its capture entry gains `"omitted":"budget"` unless it already has a reason.
    size -= jsonBytes({ ...file, base64: "" }) + file.base64.length + (remainingFiles > 1 ? 1 : 0);
    remainingFiles -= 1;
    const entry = listed.find((candidate) => candidate.sha256 === file.sha256);
    if (entry !== undefined && entry.omitted === undefined) size += jsonBytes({ ...entry, omitted: "budget" }) - jsonBytes(entry);
    steps.push({ state: [index + 1, 0, true], size });
  });
  if (files.length === 0) steps.push({ state: [0, 0, true], size });
  observations.forEach(({ item }, index) => {
    // The base64 text becomes `null`: its length and its two quotes go, four characters come.
    if (item.contentBase64 !== null) size -= item.contentBase64.length + 2 - 4;
    steps.push({ state: [files.length, index + 1, true], size });
  });
  if (whole.executorLogHead !== null) size -= jsonBytes(whole.executorLogHead) - 4;
  steps.push({ state: [files.length, observations.length, false], size });
  for (const { state, size: predicted } of steps) {
    if (predicted > group.limit) continue;
    const operator = shape(...state);
    const evidence = group.build(operator);
    if (evidence.byteLength <= group.limit) return { operator, evidence };
  }
  return { operator: null, evidence: plain };
}

/**
 * What a group's model channel needs beyond the admission (M1.4 Task 4.3a). `budget` is the broker callback for the project's day budget; the rest are seams for tests and for
 * the CI harness: the worker's own wiring sets `budget` alone, so a production worker reads its settings from its process environment, serves a standard policy, and has no scripted
 * model.
 */
export type WorkflowE2EModelChannelDependencies = Readonly<{
  budget(body: E2EModelDayBudgetRequest, signal: AbortSignal): Promise<unknown>;
  environment?: NodeJS.ProcessEnv;
  policyScope?: "standard" | "qualification";
  /** The scripted model double, for CI and qualification; a scripted route has no other provider. */
  invoke?: E2EInvoke;
  assertSharedConfig?: () => void;
  socketOwner?: { uid: number; gid: number };
  /**
   * Told, when a group's channel closes, how many calls it served (counts only; never a prompt or an answer), and the run's value key (Ruling DB-6): the HMAC key the executor's
   * action ledger was written under. The key is a verdict input for the checks that read that ledger (Task 4.4a): it goes to private evidence with the receipts, is not logged and is
   * not in any file the executor writes.
   */
  onClosed?(summary: { groupRunId: string; receipts: number; outcomes: Record<string, number>; valueKey: string }): void;
}>;

/** Whether a group has an agent step, from its compiled suite: the one question that decides whether it gets a model channel. */
const groupUsesModel = (compiled: E2ECompiledApplicationSuite) => e2eApplicationGroupUsesModel(compiled);

/** The lifecycle input for one group, derived from what the admission already approved and nothing else. */
function applicationRunInput(compiled: E2ECompiledApplicationSuite, binding: E2ERunBinding): E2ERunInput {
  const context = compiled.runtimeAdmissionContext;
  const targetIds = new Set(compiled.group.targetIds);
  const kinds = new Set(context.executionPlan.effectiveTargets.filter((target) => targetIds.has(target.targetId)).map((target) => target.kind));
  const kind = kinds.size === 1 ? [...kinds][0] : undefined;
  if ((kind !== "web" && kind !== "api") || kind !== compiled.runtimeKind) throw new Error("application group must run exactly one web or API target kind");
  const runtime = e2eCompiledRuntime(compiled);
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
  /** Task 4.3a: the model channel's dependencies. Without them a group that has an agent step is UNKNOWN (the day budget cannot be charged), and nothing starts for it. */
  modelChannel?: WorkflowE2EModelChannelDependencies;
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
  // M1.3 Task 3.7b: a baseline round (the approved scenarios on the unchanged code) is a kind of its own. The operation's signed reference and the admission it names must agree on
  // that kind, on the base commit and on the attempt, so a baseline is never run as a candidate round and a candidate round is never run as a baseline.
  const signedBaseline = admission.baseline;
  if ((reference.purpose === "baseline") !== (signedBaseline !== undefined) || (signedBaseline !== undefined
    && (signedBaseline.baseCommitSha !== reference.baseCommitSha || signedBaseline.attempt !== reference.attempt || signedBaseline.baseCommitSha !== admission.candidateCommitSha))) {
    throw new Error("native E2E baseline admission does not match the purpose, base commit and attempt of the signed CHECKS reference");
  }
  // M1.4 Task 4.6b: an audit replay (the same candidate run again with no model) is likewise a kind of its own: the signed reference and the admission must agree on that kind, on the
  // round it replays and on the attempt, so a replay is never run as a candidate's round and a candidate's is never run as a replay.
  const signedReplay = admission.replay;
  if ((reference.purpose === "replay") !== (signedReplay !== undefined) || (signedReplay !== undefined
    && (signedReplay.sourceRoundId !== reference.sourceRoundId || signedReplay.attempt !== reference.attempt))) {
    throw new Error("native E2E replay admission does not match the purpose, source round and attempt of the signed CHECKS reference");
  }
  const validated = validateE2EApplicationExecutionAdmission(admission);
  // The portable child groups of a mixed plan are not executed here; running them would be a second authority, so they are refused rather than skipped.
  if (admission.portableProjection !== null || admission.groups.some((group) => group.protocol !== "trusted-e2e-application/v1")
    || validated.applicationSuites.length !== admission.groups.length || validated.applicationSuites.length === 0) {
    throw new Error("native E2E application admission carries groups this worker does not execute");
  }
  // Task 4.3a (Ruling DB-5): the reference's `agentSteps` flag is what the dispatcher used to pick this worker, so it is not trusted alone. It must be exactly "some group of the
  // admission has an agent step", and a baseline round (which never runs those) never carries it. An audit replay (Task 4.6b) runs its agent steps with no model, so no group of it uses
  // one and its reference never carries the flag either.
  const anyGroupUsesModel = validated.applicationSuites.some(groupUsesModel);
  if ((reference.agentSteps === true) !== anyGroupUsesModel) throw new Error("native E2E reference agentSteps flag does not match the admission it names");
  if (reference.purpose === "baseline" && (reference.agentSteps === true || anyGroupUsesModel)) throw new Error("native E2E baseline round carries AI navigation steps");
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
    /**
     * The model channel of one group: the check of its route against this worker's settings, and the port the host opens just before it starts the executor. The port builds the
     * session from the group's own agent steps, the run's own credentials and a day budget that charges through the broker, and keeps its receipts for the group.
     */
    const modelChannelFor = (compiled: E2ECompiledApplicationSuite, groupRunId: string):
      { ok: true; port: DockerApplicationModelChannel } | { ok: false; code: string } => {
      const route = admission.modelRoute;
      const dependencies = input.modelChannel;
      if (route === null || dependencies === undefined) return { ok: false, code: "agent-route-not-approved" };
      const resolved = resolveE2EAgentRouteForAdmission(route, { ...(dependencies.environment === undefined ? {} : { environment: dependencies.environment }), policyScope: dependencies.policyScope ?? "standard" });
      if (!resolved.ok) return { ok: false, code: resolved.code };
      const allowedSteps = e2eApplicationGroupAgentSteps(compiled);
      return { ok: true, port: { async open(open) {
        const evidence = createE2EModelEvidenceCollector();
        const session: E2EModelChannelSession = await openE2EModelChannelSession({ runId: groupRunId, modelRoute: route, policyScope: dependencies.policyScope ?? "standard", socketPath: open.socketPath,
          allowedSteps, credentialSet: { ...open.credentialSet, cookieValues: [] }, deadlineAt: open.deadlineAt, signal: open.signal, evidence,
          dayBudget: createE2EModelDayBudgetClient({ post: dependencies.budget, groupRunId }),
          ...(dependencies.environment === undefined ? {} : { environment: dependencies.environment }), ...(dependencies.invoke === undefined ? {} : { invoke: dependencies.invoke }),
          ...(dependencies.assertSharedConfig === undefined ? {} : { assertSharedConfig: dependencies.assertSharedConfig }), ...(dependencies.socketOwner === undefined ? {} : { socketOwner: dependencies.socketOwner }) });
        return { async close() {
          const summary = await session.close();
          const transcripts = evidence.transcripts();
          const outcomes: Record<string, number> = {};
          for (const receipt of summary.receipts) outcomes[receipt.outcome] = (outcomes[receipt.outcome] ?? 0) + 1;
          // Counts only, so the line can carry no prompt, answer or credential.
          console.log(JSON.stringify({ component: "worker", event: "workflow.e2e_model_channel_closed", groupRunId, receipts: summary.receipts.length, outcomes,
            droppedRequests: summary.droppedRequests, unscopedRequests: summary.unscopedRequests, overrun: summary.overrun, evidenceErrors: summary.evidenceErrors }));
          dependencies.onClosed?.({ groupRunId, receipts: summary.receipts.length, outcomes, valueKey: open.valueKey });
          // What the host reads into the group's evidence (Task 4.4a): the receipts and the channel's own tally, the transcripts (for their digests only), the run's key and the route served.
          return { ...summary, transcripts, valueKey: open.valueKey, definition: session.definition };
        } };
      } } };
    };
    const groupLimit = (suite: E2ECompiledApplicationSuite) => Math.min(E2E_APPLICATION_GROUP_EVIDENCE_MAX_BYTES, e2eApplicationPrivateTransferMaxBytes(suite.expectedCases.length, suite.shards.length));
    const aggregateLimit = Math.min(E2E_APPLICATION_AGGREGATE_EVIDENCE_MAX_BYTES, validated.applicationSuites.reduce((total, suite) => total + groupLimit(suite), 0));
    const runGroup = async (index: number): Promise<{ groupRun: Record<string, unknown>; succeeded: boolean }> => {
      const compiled = validated.applicationSuites[index]!;
      const groupAdmission = admission.groups.find((item) => item.outerBinding.groupId === compiled.group.groupId);
      if (!groupAdmission) throw new Error("native E2E application group is not in its immutable admission");
      const binding = groupAdmission.outerBinding;
      // A group with an agent step gets a model channel, decided by the group alone (Ruling DB-1). Its route is re-derived from this worker's own settings first: when it is not the
      // route the admission pins, the group is UNKNOWN with the reason the owner is told to act on, and no host, socket or container is ever made for it.
      const usesModel = groupUsesModel(compiled);
      // The runner changed since the runtime was qualified (a new kernel after a restart): the broker would read this group as UNKNOWN whatever it did, so it does not run (HARDEN-C I-4).
      const drifted = runtime.hostEnvironment !== undefined && runnerEnvironmentDrifted(runtime.hostEnvironment, e2eCompiledRuntime(compiled)?.runnerEnvironment);
      if (drifted) console.log(JSON.stringify({ component: "worker", event: "workflow.e2e_runtime_environment_drifted", groupRunId: binding.runId, code: E2E_RUNTIME_ENVIRONMENT_DRIFTED_CODE }));
      const channel = usesModel && !drifted ? modelChannelFor(compiled, binding.runId) : undefined;
      let host: DockerApplicationHost | undefined;
      let run: { lifecycle: Pick<E2ECollection, "cleanup" | "process">; actualRun: Awaited<ReturnType<typeof runIsolatedE2EApplication>>["actualRun"]; unavailableReason: string | null };
      if (drifted) {
        run = { lifecycle: SKIPPED_LIFECYCLE, actualRun: null, unavailableReason: E2E_RUNTIME_ENVIRONMENT_DRIFTED_CODE };
      } else if (channel !== undefined && !channel.ok) {
        run = { lifecycle: SKIPPED_LIFECYCLE, actualRun: null, unavailableReason: channel.code };
      } else {
        host = runtime.createHost({ admission, groupId: compiled.group.groupId, candidateSourceDir: stagedSource, ...(channel === undefined ? {} : { modelChannel: channel.port }) });
        run = await runIsolatedE2EApplication({ input: applicationRunInput(compiled, binding), compiled, ports: host, signal: controller.signal });
      }
      throwIfStopped();
      let reason = run.unavailableReason;
      let qualification: ReturnType<typeof collect>["qualification"] = null;
      let collected: ReturnType<typeof collect>["collection"] = null;
      let collectionInputs: Awaited<ReturnType<DockerApplicationHost["readCollectionInputs"]>> | null = null;
      if (run.actualRun !== null && reason === null) {
        try {
          collectionInputs = await host!.readCollectionInputs(controller.signal);
          const result = collect({ actual: run.actualRun, compiled, binding, round, ...collectionInputs, roundScope: input.modelChannel?.policyScope ?? "standard" });
          if (result.qualification !== null && result.collection !== null) { qualification = result.qualification; collected = result.collection; }
          else reason = result.unavailableReason ?? "application collection unavailable";
        } catch (error) {
          throwIfStopped();
          reason = error instanceof Error ? error.message : "application collection unavailable";
        }
      } else reason ??= "application run produced no readback";
      throwIfStopped();
      // What the checks made of the group's AI navigation, as codes only (a code names no prompt, answer, page text or path): which case outcomes were the table's fixed ones. This is an
      // early signal for the operator; the broker's own re-collection decides.
      if (usesModel && qualification !== null) {
        const codes = (qualification.result?.cases ?? []).map((item) => item.reason).filter((code): code is string => (E2E_AGENT_UNKNOWN_CODES as readonly string[]).includes(code));
        // Every code a case matched, in precedence order (the case's reason above is the first), one list per case that matched any; filtered to the fixed set so nothing else can be logged.
        const known = (code: string): code is (typeof E2E_AGENT_UNKNOWN_CODES)[number] => (E2E_AGENT_UNKNOWN_CODES as readonly string[]).includes(code);
        const matched = (qualification.agentCodes ?? []).map((row) => row.codes.filter(known)).filter((row) => row.length > 0);
        console.log(JSON.stringify({ component: "worker", event: "workflow.e2e_agent_verdict", groupRunId: binding.runId, status: qualification.status, codes, matched }));
      }
      // The verdict input is only ever what the collector itself qualified; a run that did not get that far is UNKNOWN, whatever its process said.
      const unavailableReason = qualification === null ? reason ?? "application collection unavailable" : qualification.status === "UNKNOWN" ? qualification.reason : null;
      const diagnostics = qualification !== null ? null : (() => {
        const logs = host === undefined ? { appLogTail: "", buildLogTail: "", executorLogTail: "" } : host.readDiagnostics(binding.runId);
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
      // Each group's evidence is uploaded the moment the group finishes: the broker times a group's post-close harvest to the start of that upload (30 s), so waiting for a slower
      // group would lose the verdict of this one. To keep one group's captures from taking another group's room without waiting to see every group, each group is held to a
      // fixed share of the aggregate known up front (groupEvidenceShare). Within its share a group sheds only operator evidence, in the order of fitGroupEvidence: captures (one
      // file at a time, largest first), then the copied observations' bytes, then the executor log head and the rest of it. Never a verdict input. The raw report and observations
      // of a qualified group are in its collection (a verdict input); for any other group the report is in diagnostics.shardReports and the observations are in operatorEvidence.
      // Only a group whose verdict inputs alone do not fit its share loses all of it, and becomes UNKNOWN "evidence too large" with actual, diagnostics and operatorEvidence null.
      const limit = groupLimit(compiled);
      const share = groupEvidenceShare({ groupLimit: limit, groupLimits: validated.applicationSuites.map(groupLimit), aggregateLimit });
      const fitted = fitGroupEvidence({ limit: share, whole: wholeOperator, build: (operator) => envelope({ ...groupRun, operatorEvidence: operator }) });
      let uploaded: { groupRun: Record<string, unknown>; evidence: Buffer; succeeded: boolean };
      if (fitted !== null) uploaded = { groupRun: { ...groupRun, operatorEvidence: fitted.operator }, evidence: fitted.evidence, succeeded: qualification !== null && run.lifecycle.process.exitCode === 0 };
      else {
        // Verdict inputs the broker would refuse, or that do not fit this group's share of the aggregate, are never sent: this group is UNKNOWN, for a reason that names the cause.
        console.log(JSON.stringify({ component: "worker", event: "workflow.e2e_evidence_too_large", groupRunId: binding.runId,
          evidenceBytes: envelope({ ...groupRun, operatorEvidence: null }).byteLength, limitBytes: limit, shareBytes: share }));
        const reduced: Record<string, unknown> = { ...groupRun, collection: { status: "UNKNOWN", reason: EVIDENCE_TOO_LARGE }, unavailableReason: EVIDENCE_TOO_LARGE, actual: null, diagnostics: null, operatorEvidence: null };
        uploaded = { groupRun: reduced, evidence: envelope(reduced), succeeded: false };
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
