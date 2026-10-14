import { randomUUID } from "node:crypto";
import { z } from "zod";

const ShaSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const RepoSlugSchema = z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u, "owner/name");
export const StandaloneEnrollmentSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal("standalone-local"), enrollmentId: z.string().uuid(),
  namespace: z.string().min(1).max(512), hostId: z.string().min(1).max(255), uid: z.number().int().nonnegative(),
  account: z.string().min(1).max(100), project: RepoSlugSchema, repositoryId: z.number().int().positive(),
  checkoutPath: z.string().min(1).max(2_000), enrolledAt: z.string().datetime(),
}).strict();

export const RegisteredEnrollmentSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal("registered"), enrollmentId: z.string().uuid(),
  namespace: z.string().min(1).max(512), hostId: z.string().min(1).max(255), uid: z.number().int().nonnegative(),
  account: z.string().min(1).max(100), project: z.string().min(1).max(100), projectRevision: z.number().int().positive(),
  repository: RepoSlugSchema, repositoryId: z.number().int().positive(), checkoutPath: z.string().min(1).max(2_000),
  sourceBindingRef: z.string().min(1).max(512), taskRef: z.string().min(1).max(512).optional(), enrolledAt: z.string().datetime(),
}).strict();

export const LoopEnrollmentSchema = z.discriminatedUnion("kind", [StandaloneEnrollmentSchema, RegisteredEnrollmentSchema]);
export type LoopEnrollment = z.infer<typeof LoopEnrollmentSchema>;
export type StandaloneEnrollment = z.infer<typeof StandaloneEnrollmentSchema>;
export type RegisteredEnrollment = z.infer<typeof RegisteredEnrollmentSchema>;

export interface PublicationObservation {
  hostId: string;
  uid: number;
  account: string;
  repo: string;
  repositoryId: number;
  checkoutPath: string;
}

export type EnrollmentResolution =
  | { kind: "unmanaged-local"; enrollmentId: string; namespace: string; repositoryId: number }
  | { kind: "registered"; enrollment: RegisteredEnrollment; project: string; projectRevision: number; repositoryId: number }
  | { kind: "hold"; reasonCode: "provenance_unknown" | "identity_changed" | "enrollment_conflict" };

/** An explicit CLI enrollment receipt is scoped to one actual host, account, project and GitHub repository ID. */
export function createStandaloneEnrollment(input: Omit<StandaloneEnrollment, "schemaVersion" | "kind" | "enrollmentId" | "namespace" | "enrolledAt"> & { now: Date }): StandaloneEnrollment {
  return StandaloneEnrollmentSchema.parse({
    schemaVersion: 1, kind: "standalone-local", enrollmentId: randomUUID(),
    namespace: `local:${input.hostId}:${input.uid}:${input.account}:${input.repositoryId}`,
    hostId: input.hostId, uid: input.uid, account: input.account, project: input.project,
    repositoryId: input.repositoryId, checkoutPath: input.checkoutPath, enrolledAt: input.now.toISOString(),
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

/** Missing state is unknown. A registered receipt remains authoritative across local config and remote changes. */
export function resolveLoopEnrollment(records: readonly LoopEnrollment[], observed: PublicationObservation): EnrollmentResolution {
  const matchesSource = (record: LoopEnrollment) => record.repositoryId === observed.repositoryId ||
    (record.kind === "standalone-local" ? record.project : record.repository).toLowerCase() === observed.repo.toLowerCase();
  const relevant = records.filter((record) => matchesSource(record));
  if (relevant.length === 0) return { kind: "hold", reasonCode: "provenance_unknown" };
  const registered = relevant.filter((record): record is RegisteredEnrollment => record.kind === "registered");
  if (registered.length > 0) {
    if (registered.some((record) => record.repositoryId !== observed.repositoryId || record.repository.toLowerCase() !== observed.repo.toLowerCase())) {
      return { kind: "hold", reasonCode: "identity_changed" };
    }
    // Keep successful revisions as history, but require one stable environment/project/repository scope.
    const scopes = new Set(registered.map((record) => `${record.namespace}\0${record.project}\0${record.repositoryId}\0${record.repository.toLowerCase()}`));
    if (scopes.size !== 1) return { kind: "hold", reasonCode: "enrollment_conflict" };
    const latest = [...registered].sort((left, right) => right.projectRevision - left.projectRevision || right.enrolledAt.localeCompare(left.enrolledAt))[0]!;
    if (latest.hostId !== observed.hostId || latest.uid !== observed.uid || latest.account.toLowerCase() !== observed.account.toLowerCase() || latest.checkoutPath !== observed.checkoutPath) {
      return { kind: "hold", reasonCode: "identity_changed" };
    }
    return { kind: "registered", enrollment: latest, project: latest.project, projectRevision: latest.projectRevision, repositoryId: latest.repositoryId };
  }
  if (relevant.length !== 1) return { kind: "hold", reasonCode: "enrollment_conflict" };
  const local = relevant[0]!;
  if (local.kind !== "standalone-local" || local.repositoryId !== observed.repositoryId || local.project.toLowerCase() !== observed.repo.toLowerCase() ||
      local.hostId !== observed.hostId || local.uid !== observed.uid || local.account.toLowerCase() !== observed.account.toLowerCase() || local.checkoutPath !== observed.checkoutPath) {
    return { kind: "hold", reasonCode: "identity_changed" };
  }
  return { kind: "unmanaged-local", enrollmentId: local.enrollmentId, namespace: local.namespace, repositoryId: local.repositoryId };
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
