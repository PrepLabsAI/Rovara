import { randomUUID } from "node:crypto";
import { z } from "zod";

const ShaSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const RepoSlugSchema = z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u, "owner/name");
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
  sourceBindingRef: z.string().min(1).max(512), taskRef: z.string().min(1).max(512).optional(), enrolledAt: z.string().datetime(),
}).strict();

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
  schemaVersion: z.literal(1), status: z.literal("READY"), subject: PublicationSubjectSchema,
  candidateDigest: DigestSchema, contractDigest: DigestSchema, policyDigest: DigestSchema, planDigest: DigestSchema,
  roundId: z.string().min(1).max(512), evidenceSetDigest: DigestSchema, checkedAt: z.string().datetime(),
}).strict();
const PublicationUnknownSchema = z.object({
  schemaVersion: z.literal(1), status: z.literal("UNKNOWN"), subject: PublicationSubjectSchema.optional(),
  reasonCode: z.string().min(1).max(100), checkedAt: z.string().datetime(),
}).strict();
export const PublicationJoinResponseSchema = z.discriminatedUnion("status", [PublicationReadySchema, PublicationUnknownSchema]);
export type PublicationJoinResponse = z.infer<typeof PublicationJoinResponseSchema>;

export interface PublicationJoinRequest { taskRef: string; subject: PublicationSubject; sourceBindingRef: string }
export interface PublicationJoinTransport { load(request: PublicationJoinRequest): Promise<unknown> }
export type RegisteredPublicationResolution =
  | { kind: "ready"; response: z.infer<typeof PublicationReadySchema>; subject: PublicationSubject }
  | { kind: "hold"; reasonCode: string };

export async function resolveRegisteredPublication(input: {
  enrollment: RegisteredEnrollment; subject: PublicationSubject; taskRef: string | undefined;
  transport: PublicationJoinTransport | undefined; now: number; maxAgeMs?: number;
}): Promise<RegisteredPublicationResolution> {
  if (input.taskRef === undefined || input.taskRef.length === 0) return { kind: "hold", reasonCode: "task_binding_missing" };
  if (input.transport === undefined) return { kind: "hold", reasonCode: "native_join_unavailable" };
  let raw: unknown;
  try {
    raw = await input.transport.load({ taskRef: input.taskRef, subject: input.subject, sourceBindingRef: input.enrollment.sourceBindingRef });
  } catch {
    return { kind: "hold", reasonCode: "native_join_unavailable" };
  }
  const parsed = PublicationJoinResponseSchema.safeParse(raw);
  if (!parsed.success) return { kind: "hold", reasonCode: "server_response_invalid" };
  if (parsed.data.status === "UNKNOWN") return { kind: "hold", reasonCode: parsed.data.reasonCode };
  if (!sameSubject(parsed.data.subject, input.subject)) return { kind: "hold", reasonCode: "subject_mismatch" };
  const observedAt = Date.parse(parsed.data.checkedAt);
  const maxAgeMs = input.maxAgeMs ?? 60_000;
  if (!Number.isFinite(observedAt) || observedAt > input.now || input.now - observedAt > maxAgeMs) return { kind: "hold", reasonCode: "server_observation_stale" };
  return { kind: "ready", response: parsed.data, subject: input.subject };
}

function sameSubject(left: PublicationSubject, right: PublicationSubject): boolean {
  return left.projectName === right.projectName && left.projectRevision === right.projectRevision && left.repositoryId === right.repositoryId &&
    left.commitSha === right.commitSha && left.treeSha === right.treeSha && left.baseCommitSha === right.baseCommitSha;
}
