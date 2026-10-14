import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createHash } from "node:crypto";
import { canonicalJson, DeveloperTaskResponseSchema, type DeveloperTaskView } from "@agentx/contracts";

const ShaSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const RepoSlugSchema = z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u, "owner/name");
const TaskRefSchema = z.string().uuid();
const SourceBindingRefSchema = z.string().regex(/^cli-source:v1:[a-f0-9]{64}$/u);
export const StandaloneEnrollmentSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal("standalone-local"), enrollmentId: z.string().uuid(),
  namespace: z.string().min(1).max(512), hostId: z.string().min(1).max(255), uid: z.number().int().nonnegative(),
  account: z.string().min(1).max(100), project: RepoSlugSchema, repositoryId: z.number().int().positive(),
  checkoutPath: z.string().min(1).max(2_000), commonGitDir: z.string().min(1).max(2_000).optional(), enrolledAt: z.string().datetime(),
}).strict();

export const RegisteredEnrollmentSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal("registered"), enrollmentId: z.string().uuid(),
  namespace: z.string().min(1).max(512), hostId: z.string().min(1).max(255), uid: z.number().int().nonnegative(),
  account: z.string().min(1).max(100), project: z.string().min(1).max(100), projectRevision: z.number().int().positive(),
  repository: RepoSlugSchema, repositoryId: z.number().int().positive(), checkoutPath: z.string().min(1).max(2_000), commonGitDir: z.string().min(1).max(2_000).optional(),
  sourceBindingRef: SourceBindingRefSchema, taskRef: TaskRefSchema.optional(), nativeEvidence: z.lazy(() => NativeTaskEvidenceReceiptSchema).optional(), enrolledAt: z.string().datetime(),
}).strict();

const NativeTaskEvidenceReviewSchema = z.object({ role: z.enum(["CRITIC", "SECURITY"]), operationId: z.string().uuid(), provider: z.string().min(1).max(120), version: z.string().min(1).max(120), recordedAt: z.string().datetime() }).strict();
export const NativeTaskEvidenceReceiptSchema = z.object({
  schemaVersion: z.literal(1), taskRef: TaskRefSchema, subject: z.lazy(() => PublicationSubjectSchema),
  candidateDigest: z.string().regex(/^[a-f0-9]{64}$/u), contractDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  policyDigest: z.string().regex(/^[a-f0-9]{64}$/u), planDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  roundId: z.string().uuid(), evidenceSetDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  workflowRevision: z.number().int().positive(), verification: z.object({ producer: z.literal("agentx-worker-checks"), environmentId: z.string().min(1).max(160), recordedAt: z.string().datetime(), checkIds: z.array(z.string().min(1).max(120)).min(1).max(100) }).strict(),
  reviews: z.array(NativeTaskEvidenceReviewSchema).length(2), approvalDigest: z.string().regex(/^[a-f0-9]{64}$/u), graphDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  importedAt: z.string().datetime(), proofDigest: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict().superRefine((receipt, context) => {
  const semantic: Record<string, unknown> = { ...receipt };
  const proofDigest = receipt.proofDigest;
  delete semantic.importedAt;
  delete semantic.proofDigest;
  const expected = createHash("sha256").update(canonicalJson(semantic)).digest("hex");
  if (expected !== proofDigest) context.addIssue({ code: "custom", path: ["proofDigest"], message: "native evidence receipt digest does not match its bound fields" });
});
export type NativeTaskEvidenceReceipt = z.infer<typeof NativeTaskEvidenceReceiptSchema>;

const RegisteredPendingSourceSchema = z.object({
  name: z.string().min(1).max(100), repository: RepoSlugSchema.optional(), repositoryUrl: z.string().url(),
}).strict();
export const RegisteredPendingEnrollmentSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal("registered-pending"), enrollmentId: z.string().uuid(),
  namespace: z.string().min(1).max(512), hostId: z.string().min(1).max(255), uid: z.number().int().nonnegative(),
  registeredBy: z.string().min(1).max(512), project: z.string().min(1).max(100), projectRevision: z.number().int().positive(),
  sources: z.array(RegisteredPendingSourceSchema).min(1).max(32), enrolledAt: z.string().datetime(),
}).strict();

export const LoopEnrollmentSchema = z.discriminatedUnion("kind", [StandaloneEnrollmentSchema, RegisteredEnrollmentSchema, RegisteredPendingEnrollmentSchema]);
export type LoopEnrollment = z.infer<typeof LoopEnrollmentSchema>;
export type StandaloneEnrollment = z.infer<typeof StandaloneEnrollmentSchema>;
export type RegisteredEnrollment = z.infer<typeof RegisteredEnrollmentSchema>;
export type RegisteredPendingEnrollment = z.infer<typeof RegisteredPendingEnrollmentSchema>;

export interface PublicationObservation {
  hostId: string;
  uid: number;
  account: string;
  repo: string;
  repositoryId: number;
  checkoutPath: string;
  commonGitDir?: string;
}

export type EnrollmentResolution =
  | { kind: "unmanaged-local"; enrollmentId: string; namespace: string; repositoryId: number }
  | { kind: "registered"; enrollment: RegisteredEnrollment; project: string; projectRevision: number; repositoryId: number }
  | { kind: "hold"; reasonCode: "provenance_unknown" | "identity_changed" | "enrollment_conflict" | "native_enrollment_pending" | "registered_target_join_unavailable" | "destination_binding_unknown" };

/** An explicit CLI enrollment receipt is scoped to one actual host, account, project and GitHub repository ID. */
export function createStandaloneEnrollment(input: Omit<StandaloneEnrollment, "schemaVersion" | "kind" | "enrollmentId" | "namespace" | "enrolledAt"> & { now: Date }): StandaloneEnrollment {
  return StandaloneEnrollmentSchema.parse({
    schemaVersion: 1, kind: "standalone-local", enrollmentId: randomUUID(),
    namespace: `local:${input.hostId}:${input.uid}:${input.account}:${input.repositoryId}`,
    hostId: input.hostId, uid: input.uid, account: input.account, project: input.project,
    repositoryId: input.repositoryId, checkoutPath: input.checkoutPath, ...(input.commonGitDir === undefined ? {} : { commonGitDir: input.commonGitDir }), enrolledAt: input.now.toISOString(),
  });
}

/** Native bindings are minted only by the successful native registration hook. */
export function createRegisteredEnrollment(input: Omit<RegisteredEnrollment, "schemaVersion" | "kind" | "enrollmentId" | "enrolledAt"> & { now: Date }): RegisteredEnrollment {
  const { now, ...record } = input;
  return RegisteredEnrollmentSchema.parse({
    schemaVersion: 1, kind: "registered", enrollmentId: randomUUID(), ...record,
    enrolledAt: now.toISOString(),
  });
}

export function createRegisteredPendingEnrollment(input: Omit<RegisteredPendingEnrollment, "schemaVersion" | "kind" | "enrollmentId" | "enrolledAt"> & { now: Date }): RegisteredPendingEnrollment {
  const { now, ...record } = input;
  return RegisteredPendingEnrollmentSchema.parse({ schemaVersion: 1, kind: "registered-pending", enrollmentId: randomUUID(), ...record, enrolledAt: now.toISOString() });
}

/** Missing state is unknown. A registered receipt remains authoritative across local config and remote changes. */
export function resolveLoopEnrollment(records: readonly LoopEnrollment[], observed: PublicationObservation): EnrollmentResolution {
  const matchesSource = (record: LoopEnrollment) => {
    if (record.kind === "registered-pending") return record.sources.some((source) => source.repository?.toLowerCase() === observed.repo.toLowerCase());
    return record.repositoryId === observed.repositoryId ||
      (record.kind === "standalone-local" ? record.project : record.repository).toLowerCase() === observed.repo.toLowerCase() ||
      record.checkoutPath === observed.checkoutPath || (record.commonGitDir !== undefined && record.commonGitDir === observed.commonGitDir);
  };
  const relevant = records.filter((record) => matchesSource(record));
  if (relevant.length === 0) return { kind: "hold", reasonCode: "provenance_unknown" };
  if (relevant.some((record) => record.kind === "registered-pending")) return { kind: "hold", reasonCode: "native_enrollment_pending" };
  const registered = relevant.filter((record): record is RegisteredEnrollment => record.kind === "registered");
  if (registered.length > 0) {
    if (registered.some((record) => record.repositoryId !== observed.repositoryId || record.repository.toLowerCase() !== observed.repo.toLowerCase())) {
      return { kind: "hold", reasonCode: "identity_changed" };
    }
    // Keep successful revisions as history, but require one stable environment/project/repository scope.
    const scopes = new Set(registered.map((record) => `${record.namespace}\0${record.project}\0${record.repositoryId}\0${record.repository.toLowerCase()}`));
    if (scopes.size !== 1) return { kind: "hold", reasonCode: "enrollment_conflict" };
    const latest = [...registered].sort((left, right) => right.projectRevision - left.projectRevision || right.enrolledAt.localeCompare(left.enrolledAt))[0]!;
    if (latest.hostId !== observed.hostId || latest.uid !== observed.uid || latest.account.toLowerCase() !== observed.account.toLowerCase() || latest.checkoutPath !== observed.checkoutPath ||
        (latest.commonGitDir !== undefined && latest.commonGitDir !== observed.commonGitDir)) {
      return { kind: "hold", reasonCode: "identity_changed" };
    }
    return { kind: "registered", enrollment: latest, project: latest.project, projectRevision: latest.projectRevision, repositoryId: latest.repositoryId };
  }
  if (relevant.length !== 1) return { kind: "hold", reasonCode: "enrollment_conflict" };
  const local = relevant[0]!;
  if (local.kind !== "standalone-local" || local.repositoryId !== observed.repositoryId || local.project.toLowerCase() !== observed.repo.toLowerCase() ||
      local.hostId !== observed.hostId || local.uid !== observed.uid || local.account.toLowerCase() !== observed.account.toLowerCase() || local.checkoutPath !== observed.checkoutPath ||
      (local.commonGitDir !== undefined && local.commonGitDir !== observed.commonGitDir)) {
    return { kind: "hold", reasonCode: "identity_changed" };
  }
  return { kind: "unmanaged-local", enrollmentId: local.enrollmentId, namespace: local.namespace, repositoryId: local.repositoryId };
}

/** Resolve source and changed target independently before allowing a local-only lane. */
export function resolvePublicationScopes(input: {
  records: readonly LoopEnrollment[]; source: PublicationObservation; target: PublicationObservation;
  destinationRepo: string; destination?: PublicationObservation; upstreamRepo?: string;
}): EnrollmentResolution {
  const source = resolveLoopEnrollment(input.records, input.source);
  if (source.kind === "hold") return source;
  const target = resolveLoopEnrollment(input.records, input.target);
  if (target.kind === "hold") return target;
  const destinationMapped = input.destinationRepo.toLowerCase() === input.target.repo.toLowerCase() ||
    (input.upstreamRepo !== undefined && input.destinationRepo.toLowerCase() === input.upstreamRepo.toLowerCase());
  if (!destinationMapped) return { kind: "hold", reasonCode: "identity_changed" };
  const destinationIsTarget = input.destinationRepo.toLowerCase() === input.target.repo.toLowerCase();
  if (!destinationIsTarget) {
    if (input.destination === undefined || input.destination.repo.toLowerCase() !== input.destinationRepo.toLowerCase()) {
      return { kind: "hold", reasonCode: "destination_binding_unknown" };
    }
    const destination = resolveLoopEnrollment(input.records, input.destination);
    if (destination.kind === "hold") return destination;
    if (destination.kind === "registered") return { kind: "hold", reasonCode: "registered_target_join_unavailable" };
  }
  if (source.kind === "registered" || target.kind === "registered") {
    if (source.kind !== "registered" || target.kind !== "registered" || source.repositoryId !== target.repositoryId ||
        input.source.repo.toLowerCase() !== input.target.repo.toLowerCase() || input.destinationRepo.toLowerCase() !== input.target.repo.toLowerCase()) {
      return { kind: "hold", reasonCode: "registered_target_join_unavailable" };
    }
    return source;
  }
  return { kind: "unmanaged-local", enrollmentId: source.enrollmentId, namespace: source.namespace, repositoryId: source.repositoryId };
}

export const PublicationSubjectSchema = z.object({
  projectName: z.string().min(1).max(100), projectRevision: z.number().int().positive(), repositoryId: z.number().int().positive(),
  commitSha: ShaSchema, treeSha: ShaSchema, baseCommitSha: ShaSchema,
}).strict();
export type PublicationSubject = z.infer<typeof PublicationSubjectSchema>;

const PublicationReadySchema = z.object({
  schemaVersion: z.literal(1), status: z.literal("READY"), requestId: z.string().min(1).max(200).optional(), subject: PublicationSubjectSchema,
  candidateDigest: DigestSchema, contractDigest: DigestSchema, policyDigest: DigestSchema, planDigest: DigestSchema,
  roundId: z.string().min(1).max(512), evidenceSetDigest: DigestSchema, checkedAt: z.string().datetime(),
}).strict();
const PublicationUnknownSchema = z.object({
  schemaVersion: z.literal(1), status: z.literal("UNKNOWN"), requestId: z.string().min(1).max(200).optional(), subject: PublicationSubjectSchema.optional(),
  reasonCode: z.string().min(1).max(100), checkedAt: z.string().datetime(),
}).strict();
export const PublicationJoinResponseSchema = z.discriminatedUnion("status", [PublicationReadySchema, PublicationUnknownSchema]);
export type PublicationJoinResponse = z.infer<typeof PublicationJoinResponseSchema>;

export const PublicationJoinRequestSchema = z.object({ taskRef: TaskRefSchema, subject: PublicationSubjectSchema, sourceBindingRef: SourceBindingRefSchema }).strict();
export type PublicationJoinRequest = z.infer<typeof PublicationJoinRequestSchema>;
export interface PublicationJoinTransport {
  load(request: PublicationJoinRequest, expectedAuthorityNamespace: string): Promise<unknown>;
  loadTask?(taskRef: string, expectedAuthorityNamespace: string, projectName: string): Promise<unknown>;
}
export type RegisteredPublicationResolution =
  | { kind: "ready"; response: z.infer<typeof PublicationReadySchema>; subject: PublicationSubject }
  | { kind: "hold"; reasonCode: string };

export async function resolveRegisteredPublication(input: {
  enrollment: RegisteredEnrollment; subject: PublicationSubject; taskRef: string | undefined;
  transport: PublicationJoinTransport | undefined; now: () => number; maxAgeMs?: number;
}): Promise<RegisteredPublicationResolution> {
  if (input.taskRef === undefined || input.taskRef.length === 0) return { kind: "hold", reasonCode: "task_binding_missing" };
  if (!TaskRefSchema.safeParse(input.taskRef).success) return { kind: "hold", reasonCode: "task_binding_invalid" };
  if (!RegisteredEnrollmentSchema.safeParse(input.enrollment).success) return { kind: "hold", reasonCode: "source_binding_invalid" };
  if (input.transport === undefined) return { kind: "hold", reasonCode: "native_join_unavailable" };
  let raw: unknown;
  try {
    raw = await input.transport.load({ taskRef: input.taskRef, subject: input.subject, sourceBindingRef: input.enrollment.sourceBindingRef }, input.enrollment.namespace);
  } catch {
    return { kind: "hold", reasonCode: "native_join_unavailable" };
  }
  const parsed = PublicationJoinResponseSchema.safeParse(raw);
  if (!parsed.success) return { kind: "hold", reasonCode: "server_response_invalid" };
  if (parsed.data.status === "UNKNOWN") return { kind: "hold", reasonCode: parsed.data.reasonCode };
  if (!sameSubject(parsed.data.subject, input.subject)) return { kind: "hold", reasonCode: "subject_mismatch" };
  const observedAt = Date.parse(parsed.data.checkedAt);
  const maxAgeMs = input.maxAgeMs ?? 60_000;
  const receivedAt = input.now();
  if (!Number.isFinite(receivedAt) || !Number.isFinite(observedAt) || observedAt > receivedAt || receivedAt - observedAt > maxAgeMs) return { kind: "hold", reasonCode: "server_observation_stale" };
  return { kind: "ready", response: parsed.data, subject: input.subject };
}

function sameSubject(left: PublicationSubject, right: PublicationSubject): boolean {
  return left.projectName === right.projectName && left.projectRevision === right.projectRevision && left.repositoryId === right.repositoryId &&
    left.commitSha === right.commitSha && left.treeSha === right.treeSha && left.baseCommitSha === right.baseCommitSha;
}

/** Validate native workflow evidence from the authenticated task read against the fresh join and this host's Git observation. */
export function importNativeTaskEvidence(input: {
  rawTask: unknown; taskRef: string; subject: PublicationSubject; candidateRepo: string;
  join: Extract<PublicationJoinResponse, { status: "READY" }>; now: Date; maxEvidenceAgeMs?: number; maxJoinAgeMs?: number;
}): NativeTaskEvidenceReceipt {
  const response = DeveloperTaskResponseSchema.parse(input.rawTask);
  const task: DeveloperTaskView = response.task;
  const workflow = task.workflow;
  const hold = (reason: string): never => { throw new Error(`native task evidence ${reason}`); };
  const checkedAt = Date.parse(input.join.checkedAt);
  const receivedAt = input.now.getTime();
  if (!Number.isFinite(checkedAt) || !Number.isFinite(receivedAt) || checkedAt > receivedAt || receivedAt - checkedAt > (input.maxJoinAgeMs ?? 60_000)) return hold("join_observation_stale");
  if (task.taskId !== input.taskRef || workflow === undefined || workflow.taskId !== task.taskId) return hold("task_identity_mismatch");
  if (workflow.state !== "READY" || !["REVIEW", "PULL_REQUEST", "WAIT_FOR_MERGE"].includes(workflow.stage)) return hold("workflow_not_currently_publishable");
  const manifest = workflow.candidate;
  if (manifest === undefined || manifest.digest !== input.join.candidateDigest) return hold("candidate_digest_mismatch");
  const expectedRepo = input.candidateRepo.split("/").at(-1)?.toLowerCase();
  const repositories = manifest.repositories.filter((entry) => entry.repositoryId.toLowerCase() === expectedRepo);
  if (manifest.repositories.length !== 1 || repositories.length !== 1) return hold("candidate_repository_mismatch");
  const repository = repositories[0]!;
  if (repository.commitSha !== input.subject.commitSha || repository.treeSha !== input.subject.treeSha || repository.baseCommitSha !== input.subject.baseCommitSha ||
      input.join.subject.projectName !== input.subject.projectName || input.join.subject.projectRevision !== input.subject.projectRevision ||
      input.join.subject.repositoryId !== input.subject.repositoryId || input.join.subject.commitSha !== input.subject.commitSha ||
      input.join.subject.treeSha !== input.subject.treeSha || input.join.subject.baseCommitSha !== input.subject.baseCommitSha) return hold("candidate_subject_mismatch");

  const progress = workflow.e2e;
  const qualified = progress?.qualifiedRound;
  if (progress?.required !== true || qualified === undefined || workflow.verification?.candidateDigest !== manifest.digest ||
      workflow.e2e?.currentRoundId !== qualified.roundId || workflow.e2e.currentGroupRunIds.length !== qualified.groupRunIds.length ||
      workflow.e2e.currentGroupRunIds.some((id, index) => id !== qualified.groupRunIds[index]) ||
      qualified.candidateDigest !== input.join.candidateDigest || progress.contractDigest !== input.join.contractDigest ||
      progress.policyDigest !== input.join.policyDigest || progress.executionPlanDigest !== input.join.planDigest ||
      qualified.contractDigest !== input.join.contractDigest || qualified.policyDigest !== input.join.policyDigest ||
      qualified.executionPlanDigest !== input.join.planDigest || qualified.roundId !== input.join.roundId) return hold("e2e_round_binding_mismatch");
  const expectedEvidenceSetDigest = createHash("sha256").update(canonicalJson({
    domain: "agentx-e2e-publication-context/v1", taskId: task.taskId, candidateDigest: input.join.candidateDigest,
    roundId: qualified.roundId, admissionSha256: qualified.admissionSha256, evidenceSha256: qualified.evidenceSha256,
    groupRunIds: qualified.groupRunIds,
  })).digest("hex");
  if (expectedEvidenceSetDigest !== input.join.evidenceSetDigest) return hold("evidence_set_mismatch");

  const policy = workflow.checkPolicy;
  const verification = workflow.verification;
  if (policy === undefined || verification === undefined || verification.producer !== "agentx-worker-checks" || verification.reviewOnly === true) return hold("checks_missing_or_untrusted");
  const expectedChecks = [
    ...policy.required.map((check) => check.id),
    ...policy.selectedOptionalIds,
    ...(policy.selectedProposedIds ?? policy.proposed.map((check) => check.id)),
  ].sort();
  const actualChecks = verification.results.map((result) => result.checkId).sort();
  if (expectedChecks.length === 0 || new Set(actualChecks).size !== actualChecks.length || JSON.stringify(expectedChecks) !== JSON.stringify(actualChecks) ||
      verification.results.some((result) => result.status !== "PASS")) return hold("checks_incomplete_or_failed");

  const reviews = workflow.reviews ?? [];
  if (reviews.length !== 2 || (["CRITIC", "SECURITY"] as const).some((role) => {
    const found = reviews.filter((review) => review.role === role);
    return found.length !== 1 || found[0]!.candidateDigest !== manifest.digest || found[0]!.status !== "PASS" || found[0]!.readOnly !== true;
  })) return hold("reviews_missing_or_untrusted");
  const nowMs = input.now.getTime();
  const maxAge = input.maxEvidenceAgeMs ?? 24 * 60 * 60 * 1_000;
  const evidenceTimes = [verification.recordedAt, ...reviews.map((review) => review.recordedAt)].map(Date.parse);
  if (!Number.isFinite(nowMs) || evidenceTimes.some((at) => !Number.isFinite(at) || at > nowMs || nowMs - at > maxAge)) return hold("evidence_time_invalid");

  const plan = workflow.artifacts.filter((artifact) => artifact.type === "plan").sort((a, b) => b.version - a.version)[0];
  if (plan === undefined || plan.sha256 !== input.join.contractDigest) return hold("approved_plan_missing_or_changed");
  const approvals = workflow.decisions.filter((decision) => decision.actorId === workflow.ownerId && decision.actorRole === "TASK_OWNER" &&
    decision.decision === "APPROVE" && decision.artifactDigest === plan.sha256).sort((a, b) => b.workflowRevision - a.workflowRevision || b.at.localeCompare(a.at));
  if (approvals.length === 0) return hold("owner_approval_missing");
  const approval = approvals[0]!;
  const graph = workflow.workflowDependenciesApproval;
  if (workflow.path === "FULL" && (graph === undefined || graph.artifactDigest !== plan.sha256 || graph.workflowRevision !== approval.workflowRevision || graph.actorId !== approval.actorId || graph.graphDigest !== approval.workBreakdownDigest)) {
    return hold("approved_graph_missing_or_changed");
  }
  if (graph !== undefined && (graph.artifactDigest !== plan.sha256 || graph.workflowRevision !== approval.workflowRevision || graph.actorId !== approval.actorId || graph.graphDigest !== approval.workBreakdownDigest)) return hold("approved_graph_mismatch");

  const approvalDigest = createHash("sha256").update(canonicalJson({
    artifactDigest: plan.sha256, workflowRevision: approval.workflowRevision, actorId: approval.actorId,
    actorRole: approval.actorRole, decision: approval.decision, at: approval.at,
    ...(approval.workBreakdownDigest === undefined ? {} : { workBreakdownDigest: approval.workBreakdownDigest }),
    ...(graph === undefined ? {} : { graphDigest: graph.graphDigest, graphRunId: graph.runId }),
  })).digest("hex");
  const verificationReceipt = { producer: verification.producer as "agentx-worker-checks", environmentId: verification.environmentId,
    recordedAt: verification.recordedAt, checkIds: actualChecks };
  const reviewReceipts = reviews.map((review) => ({ role: review.role, operationId: review.operationId, provider: review.provider,
    version: review.version, recordedAt: review.recordedAt })).sort((a, b) => a.role.localeCompare(b.role));
  const semantic = { schemaVersion: 1 as const, taskRef: task.taskId, subject: input.subject, candidateDigest: manifest.digest,
    contractDigest: input.join.contractDigest, policyDigest: input.join.policyDigest, planDigest: input.join.planDigest,
    roundId: input.join.roundId, evidenceSetDigest: input.join.evidenceSetDigest, workflowRevision: workflow.revision,
    verification: verificationReceipt, reviews: reviewReceipts, approvalDigest,
    ...(graph === undefined ? {} : { graphDigest: graph.graphDigest }) };
  const proofDigest = createHash("sha256").update(canonicalJson(semantic)).digest("hex");
  return NativeTaskEvidenceReceiptSchema.parse({ ...semantic, importedAt: input.now.toISOString(), proofDigest });
}

export function sameNativeTaskEvidenceReceipt(left: NativeTaskEvidenceReceipt | undefined, right: NativeTaskEvidenceReceipt): boolean {
  if (left === undefined || !NativeTaskEvidenceReceiptSchema.safeParse(left).success) return false;
  const leftSemantic: Record<string, unknown> = { ...left };
  const rightSemantic: Record<string, unknown> = { ...right };
  delete leftSemantic.importedAt;
  delete rightSemantic.importedAt;
  return canonicalJson(leftSemantic) === canonicalJson(rightSemantic);
}
