// The broker's registry of a project's saved environment images.
//
// What it keeps, per project (one row, compare-and-set on `version`): the images it knows (newest first; each with its manifest, digest and whether it is `ready` or `stale`), the rebuild JOB that is queued
// or running (with the lease token that is the only thing allowed to ask for the push login), whether a Reset was asked, whether the project is archived, and the last time anything happened. Everything is
// behind the install's saved-environments switch: with it off every function answers `disabled` and touches nothing.
//
// When a rebuild is queued (`checkRebuild`), and why (a fixed word):
//   no_image      the project has an approved environment and no usable image;
//   key_changed   the environment key of the default branch is not the image's (lockfiles, build files, toolchain files, secret names, the base image, the approved revision);
//   max_age       the image is older than 7 days;
//   stale         a task fell back from the image or a build failed to verify;
//   reset         a maintainer pressed Reset.
// Never when: the project is archived (images are kept, nothing is rebuilt), the repository is idle (see `lightSetup`: no push and no task for `lightAfterIdleDays`, so no image is built and its setup runs when
// a task first needs it), a job is already queued or running (an expired lease is taken over), or there is no approved environment.
// The triggers are the default branch's push events, the nightly, and a periodic poll until the push route is wired; all of them call `checkRebuild`.
//
// A job is queued WITH the commits it is for: the default branch heads at that moment (and the environment key of those commits). The worker builds exactly those commits, so a repository that moves while the
// build runs still records, and a later key change queues the next rebuild.
// What a build result must satisfy before it is recorded (`recordBuild`), each its own fixed refusal:
//   - it comes from the job's lease (job id + lease token, compared in constant time): the push login and the result both belong to the rebuild job's lease only. `mintPushForJob` is the only way to a
//     push login: it checks the lease, that the project is live (not deleted, archived or turned off), and mints for the job's approved pin;
//   - the job's approved pin is still the project's newest approved revision and digest;
//   - the result is for THIS project's repository, and the manifest's commits are exactly the commits the job was given; its revision and (when the job knew it) environment key are the job's;
//   - the repository in the registry is the one the creation template made (`verifyRepository`: the registry's own check that nobody else made it first, with other settings), checked AFTER the push and before the digest is recorded.
// A refused result deletes the pushed digest. Then it keeps the newest `keep` images, deletes every registry digest the row does not name (once past a short grace) and any past the 30 day ceiling, with a
// registry call of the broker's own, and starts a scan of the new image where the registry has one. A registry's own count rule is only a backstop (`keep` plus a margin): the walk decides what stays.
//
// Delete: a deleted project loses all its images and its repository. An ARCHIVED project keeps them (an unarchive should not need a rebuild) until the 30 day ceiling deletes them; it queues no rebuild.
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  SAVED_ENV_IMAGE_CEILING_DAYS,
  savedEnvRepositoryName,
  SAVED_ENV_KEEP_DEFAULT,
  SAVED_ENV_KEEP_MAX,
  SAVED_ENV_KEEP_MIN,
  SAVED_ENV_LIGHT_AFTER_IDLE_DAYS_DEFAULT,
  SAVED_ENV_MAX_AGE_DAYS,
  SAVED_ENV_USE_STEPS,
  savedEnvStepMarksStale,
  PrepareSavedEnvSchema,
  SavedEnvBuildResultSchema,
  type PrepareSavedEnv,
  type RegistryImage,
  type SavedEnvBuildResult,
  type SavedEnvRegistryAuth,
  type SavedEnvManifest,
} from "@agentx/contracts";
import { mintPullSession, mintPushSession, repositoryOf, verifyRepository, type SavedEnvSessionConfig, type SavedEnvSessionPorts } from "./saved-env-session.js";

const DAY_MS = 86_400_000;
/** A recorded image the registry does not list yet is kept this long. */
const RECORD_GRACE_MS = 10 * 60_000;
/** A job that has not finished in this long is abandoned; the next check takes the project over. */
export const SAVED_ENV_JOB_LEASE_MS = 3 * 3_600_000;
/** After a failed build the project waits this long before the next automatic rebuild (a reset ignores it). */
export const SAVED_ENV_FAILURE_BACKOFF_MS = 30 * 60_000;
/** How often the periodic poll looks at a project. */
export const SAVED_ENV_POLL_MS = 30 * 60_000;
/** A project whose polls keep failing is looked at less and less often, never less often than this. */
export const SAVED_ENV_POLL_BACKOFF_MAX_MS = 6 * 3_600_000;

export const REBUILD_REASONS = ["no_image", "key_changed", "max_age", "stale", "reset"] as const;
export type RebuildReason = (typeof REBUILD_REASONS)[number];

export interface ApprovedPin { revision: number; digest: string }

export interface SavedEnvImageRecord {
  /** The approved environment (revision and digest) the image was built for: a task pinned to another one never uses it. */
  approved: ApprovedPin;
  digest: string;
  tag: string;
  manifest: SavedEnvManifest;
  recordedAt: string;
  status: "ready" | "stale";
  /** The step a task fell back at, when `stale`. */
  staleStep?: string;
  scanStartedAt?: string;
}

export interface RebuildJob {
  jobId: string;
  /** The secret that authorises the push login and the result for THIS job. Never sent to a task. */
  leaseToken: string;
  reason: RebuildReason;
  approved: ApprovedPin;
  /** The default branch head of each repository (by repository name) the build is FOR, taken when the job was queued. */
  commits: Record<string, string>;
  /** The environment key of those commits. A job is never queued without one (`no_key`), so a result is always held to it. */
  expectedKey: string;
  createdAt: string;
  leaseUntil: string;
  /** Set when the dispatcher took the lease token. */
  dispatchedAt?: string | undefined;
  /** The operation the token was handed to. The same operation can have it again (a delivery that is retried), no other. */
  dispatchedOperationId?: string | undefined;
}

export type SavedEnvHealth = "never_proved" | "healthy" | "needs_repair";

export interface SavedEnvState {
  orgId: string;
  projectId: string;
  /** Compare-and-set counter of the row. */
  version: number;
  /** The project's `savedEnv.enabled` setting. */
  enabled: boolean;
  /** Newest first. */
  images: SavedEnvImageRecord[];
  job?: RebuildJob | undefined;
  resetRequested?: boolean | undefined;
  archived?: boolean | undefined;
  deleted?: boolean | undefined;
  /** When the project was deleted (the nightly sweep re-runs the registry deletion for a few days after, for a push that was in flight). */
  deletedAt?: string | undefined;
  /** When the registry deletion last finished for a deleted project. A purge finished before `deletedAt` plus a job lease may have been undone by a push that was in flight, so the nightly sweep does it again. */
  registryPurgedAt?: string | undefined;
  /** When a Reset was last asked, and the request it came with (a press sent twice is one press). */
  lastResetAt?: string | undefined;
  lastResetRequestId?: string | undefined;
  lastPushAt?: string | undefined;
  lastTaskAt?: string | undefined;
  lastRebuildReason?: RebuildReason | undefined;
  lastFailureAt?: string | undefined;
  lastFailure?: string | undefined;
  /** When the periodic poll next looks at this project (`runPoll`). Set whenever the row is written, so every row with a live project is polled at least this often. */
  nextPollAt?: string | undefined;
  /** How many polls in a row failed for this project (the next time backs off with it; a poll that works clears it). */
  pollFailures?: number | undefined;
  health: SavedEnvHealth;
}

/** What the audit ledger gets: ids, digests and fixed words only. */
export interface SavedEnvAuditEntry {
  action: "activity" | "lease_refused" | "scan_started" | "rebuild_queued" | "build_recorded" | "build_refused" | "build_failed" | "marked_stale" | "reset_requested" | "images_deleted" | "project_archived" | "project_deleted" | "project_registered" | "ceiling_walk" | "setting_changed";
  orgId: string;
  projectId: string;
  at: string;
  reason?: string;
  digest?: string;
  count?: number;
  /** The project's `savedEnv.enabled` after a `setting_changed`. */
  enabled?: boolean;
  /** Who asked (a person's id for a Reset). */
  actor?: string;
}

export interface SavedEnvStore {
  get(orgId: string, projectId: string): Promise<SavedEnvState | undefined>;
  /** Writes `next` and the audit entry together or neither, only while the stored version is `expectedVersion` (null: no row yet). False when the row changed meanwhile. */
  commit(next: SavedEnvState, expectedVersion: number | null, audit: SavedEnvAuditEntry): Promise<boolean>;
  /** An audit entry that is not tied to a change of the row (a refused lease, a routine deletion, a scan start). */
  audit(entry: SavedEnvAuditEntry): Promise<void>;
  /** The deleted projects whose registry deletion is not final: no `registryPurgedAt`, or one earlier than `deletedAt` plus `leaseMs` (for `sweepDeleted`). */
  deletedNeedingPurge(leaseMs: number): Promise<Array<{ orgId: string; projectId: string }>>;
  /** At most `limit` live, enabled projects whose `nextPollAt` has passed (for `runPoll`), oldest first. */
  pollDue(limit: number): Promise<Array<{ orgId: string; projectId: string }>>;
}

export interface SavedEnvDeps {
  store: SavedEnvStore;
  /** The install's switch and the image registry (`session.ports.registry`, the `image-registry` port) with the two reads a login is held to. */
  session: { config: SavedEnvSessionConfig; ports: SavedEnvSessionPorts };
  /** The project's newest approved test environment, or undefined (bind to `readApprovedTestEnvironment`). */
  approved(orgId: string, projectId: string): Promise<ApprovedPin | undefined>;
  /** The environment key of the project's default branches at `heads` ( the heads are read once, by `checkRebuild`, so the key and the job are for the SAME commits), or undefined when it cannot be worked out (then no decision is made). */
  currentKey(orgId: string, projectId: string, heads: ReadonlyMap<string, string> | undefined): Promise<string | undefined>;
  /** The head commit of each repository's default branch, by repository name, or undefined when the code host cannot answer. Read when a job is queued, not when it is recorded. */
  defaultHeads(orgId: string, projectId: string): Promise<ReadonlyMap<string, string> | undefined>;
  /** `savedEnv.keep` of the company (1 to 10). */
  keep(orgId: string): Promise<number>;
  /** `savedEnv.lightAfterIdleDays`. */
  lightAfterIdleDays?(orgId: string, projectId: string): Promise<number>;
  now(): number;
  random?(): string;
  /**
   * Called after a rebuild job was queued (by any trigger: a push, a task, the nightly, the poll, a Reset, a stale mark), to start it. Best effort: a throw is swallowed (the job's lease runs out and the next
   * check takes the project over). Absent: the job waits for whoever starts it.
   */
  onQueued?(ids: { orgId: string; projectId: string }, job: Pick<RebuildJob, "jobId" | "reason" | "approved" | "commits">): Promise<void>;
}

/** What the writes of the registry need: the store, the clock and whether the install's switch is on. The dispatcher's lease (which has no sessions or registry) is made from this alone. */
export type SavedEnvStoreDeps = Pick<SavedEnvDeps, "store" | "now"> & { session: { config: { enabled: boolean } } };
type Disabled = { ok: false; reason: "disabled" };
const disabled = (deps: SavedEnvStoreDeps): Disabled | undefined => (deps.session.config.enabled ? undefined : { ok: false, reason: "disabled" });
const iso = (ms: number): string => new Date(ms).toISOString();
const keepOf = (value: number): number => Math.min(SAVED_ENV_KEEP_MAX, Math.max(SAVED_ENV_KEEP_MIN, Number.isInteger(value) ? value : SAVED_ENV_KEEP_DEFAULT));
const token = (deps: SavedEnvDeps): string => (deps.random ?? (() => randomBytes(24).toString("hex")))();

function sameToken(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

const blank = (orgId: string, projectId: string): SavedEnvState => ({ orgId, projectId, version: 0, enabled: true, images: [], health: "never_proved" });
const audit = (deps: SavedEnvStoreDeps, state: Pick<SavedEnvState, "orgId" | "projectId">, action: SavedEnvAuditEntry["action"], extra: Partial<SavedEnvAuditEntry> = {}): SavedEnvAuditEntry => ({ action, orgId: state.orgId, projectId: state.projectId, at: iso(deps.now()), ...extra });

/** Commits `next` over `prior` (null: first write). Returns the committed state, or undefined when the row changed meanwhile. */
async function commit(deps: SavedEnvStoreDeps, prior: SavedEnvState | undefined, next: SavedEnvState, entry: SavedEnvAuditEntry): Promise<SavedEnvState | undefined> {
  const written = { ...next, version: (prior?.version ?? 0) + 1 };
  return (await deps.store.commit(written, prior === undefined ? null : prior.version, entry)) ? written : undefined;
}

// ---- when to rebuild

export interface RebuildInput {
  now: number;
  image: SavedEnvImageRecord | undefined;
  approved: ApprovedPin | undefined;
  currentKey: string | undefined;
  resetRequested: boolean;
}

/**
 * Why the project needs a rebuild, or undefined. Pure. The newest image counts only while it is `ready`. A key that cannot be worked out (undefined) decides nothing about the key; a missing approved environment
 * decides everything: no rebuild.
 */
export function rebuildReason(input: RebuildInput): RebuildReason | undefined {
  if (input.approved === undefined) return undefined;
  if (input.resetRequested) return "reset";
  const image = input.image;
  if (image === undefined) return "no_image";
  if (image.status === "stale") return "stale";
  if (image.manifest.testEnvRevision !== input.approved.revision) return "key_changed";
  if (input.currentKey !== undefined && image.manifest.environmentKey !== input.currentKey) return "key_changed";
  if (input.now - Date.parse(image.recordedAt) > SAVED_ENV_MAX_AGE_DAYS * DAY_MS) return "max_age";
  return undefined;
}

/** Whether the repository has been idle long enough to be saved as a clone only: no image is built, and its setup runs when a task first needs it. */
export function lightSetup(state: Pick<SavedEnvState, "lastPushAt" | "lastTaskAt">, nowMs: number, idleDays: number = SAVED_ENV_LIGHT_AFTER_IDLE_DAYS_DEFAULT): boolean {
  const latest = Math.max(Date.parse(state.lastPushAt ?? "") || 0, Date.parse(state.lastTaskAt ?? "") || 0);
  return latest > 0 && nowMs - latest > idleDays * DAY_MS;
}

export type CheckResult =
  | { ok: true; queued: false; why: "no_change" | "in_flight" | "archived" | "idle" | "no_approved" | "backoff" | "off_for_project" | "no_heads" | "no_key" | "cooldown" | "duplicate" | "registry_cannot_build" }
  | { ok: true; queued: true; job: Pick<RebuildJob, "jobId" | "reason" | "approved" | "commits"> }
  | { ok: false; reason: "disabled" | "stale_write" };

/**
 * Called on a default branch push, before each nightly, and by the poll. Records the activity (`push`, `task`) and, if a rebuild is due and none is in flight, queues one FOR the default branch heads read now.
 * Idempotent: a second call while a job is queued or running changes nothing but the activity time. The result never carries the job's lease token: only `leaseForDispatch` hands that out, to the dispatcher.
 */
export async function checkRebuild(deps: SavedEnvDeps, ids: { orgId: string; projectId: string }, trigger: "push" | "nightly" | "poll" | "task"): Promise<CheckResult> {
  const off = disabled(deps);
  if (off !== undefined) return off;
  const prior = await deps.store.get(ids.orgId, ids.projectId);
  const base = prior ?? blank(ids.orgId, ids.projectId);
  const now = deps.now();
  const touched: SavedEnvState = { ...base, ...(trigger === "push" ? { lastPushAt: iso(now) } : {}), ...(trigger === "task" ? { lastTaskAt: iso(now) } : {}), nextPollAt: iso(now + SAVED_ENV_POLL_MS), pollFailures: undefined };
  const stay = async (why: Extract<CheckResult, { queued: false; ok: true }>["why"]): Promise<CheckResult> => {
    // Activity is recorded even when nothing is queued (the idle test reads it); a lost race is not an error here.
    if (trigger === "push" || trigger === "task") await commit(deps, prior, touched, audit(deps, base, "activity", { reason: trigger })).catch(() => undefined);
    return { ok: true, queued: false, why };
  };
  if (base.deleted === true || base.archived === true) return stay("archived");
  if (!base.enabled) return stay("off_for_project");
  // A registry the worker cannot push to builds nothing: no job is queued (a job nobody can run would only wait out its lease and then count as a failure).
  if (!deps.session.ports.registry.capabilities.workerPush) return stay("registry_cannot_build");
  const approved = await deps.approved(ids.orgId, ids.projectId);
  if (approved === undefined) return stay("no_approved");
  if (base.job !== undefined && Date.parse(base.job.leaseUntil) > now) return stay("in_flight");
  const idleDays = (await deps.lightAfterIdleDays?.(ids.orgId, ids.projectId)) ?? SAVED_ENV_LIGHT_AFTER_IDLE_DAYS_DEFAULT;
  if (base.resetRequested !== true && base.images.length === 0 && lightSetup(base, now, idleDays) && trigger !== "push" && trigger !== "task") return stay("idle");
  if (base.resetRequested !== true && base.lastFailureAt !== undefined && now - Date.parse(base.lastFailureAt) < SAVED_ENV_FAILURE_BACKOFF_MS) return stay("backoff");
  // The heads are read first and the key is worked out AT them, so the key and the job are for the same commits whatever moves meanwhile.
  const heads = await deps.defaultHeads(ids.orgId, ids.projectId).catch(() => undefined);
  const currentKey = await deps.currentKey(ids.orgId, ids.projectId, heads).catch(() => undefined);
  const reason = rebuildReason({ now, image: base.images[0], approved, currentKey, resetRequested: base.resetRequested === true });
  if (reason === undefined) return stay("no_change");
  // Without the key of the code the build is for, a result could not be held to it: nothing is queued (a reset too), and the next check tries again.
  if (currentKey === undefined) return stay("no_key");
  if (lightSetup(base, now, idleDays) && reason !== "reset" && trigger !== "push") return stay("idle");
  // The commits the build is FOR. Without them there is nothing to hold the result against.
  if (heads === undefined || heads.size === 0) return stay("no_heads");
  const job: RebuildJob = {
    jobId: token(deps).slice(0, 24), leaseToken: token(deps), reason, approved, commits: Object.fromEntries(heads), expectedKey: currentKey,
    createdAt: iso(now), leaseUntil: iso(now + SAVED_ENV_JOB_LEASE_MS),
  };
  const written = await commit(deps, prior, { ...touched, job, resetRequested: false, lastRebuildReason: reason }, audit(deps, base, "rebuild_queued", { reason }));
  if (written === undefined) return { ok: false, reason: "stale_write" };
  const queued = { jobId: job.jobId, reason, approved, commits: job.commits };
  // Whatever trigger queued it, the job is started the same way. A start that throws leaves the job to run out its lease; nothing here fails because of it.
  await deps.onQueued?.(ids, queued).catch(() => undefined);
  return { ok: true, queued: true, job: queued };
}

/**
 * A queued job that could not be started for a reason that will not mend itself (no approver, no build inputs, a moved approval): it is ended now with a fixed word, so the project does not wait out a whole lease
 * for a job nobody is building, and the failure backoff applies. Only the job that is the project's current one, and only while nobody was given its lease.
 */
export async function abandonQueuedJob(deps: SavedEnvStoreDeps, ids: { orgId: string; projectId: string }, jobId: string, reason: string): Promise<{ ok: boolean }> {
  if (disabled(deps) !== undefined) return { ok: false };
  const state = await deps.store.get(ids.orgId, ids.projectId);
  const job = state?.job;
  if (state === undefined || job === undefined || job.jobId !== jobId || job.dispatchedAt !== undefined) return { ok: false };
  const word = reason.replace(/[^a-z_]/gu, "").slice(0, 40);
  const written = await commit(deps, state, { ...state, job: undefined, health: "needs_repair", lastFailureAt: iso(deps.now()), lastFailure: word }, audit(deps, state, "build_failed", { reason: word }));
  return { ok: written !== undefined };
}

/**
 * The periodic poll: every project whose time has come is checked as `poll` does (which queues a rebuild when one is due, and so starts it through `onQueued`). A project's next time is set by every write of its row;
 * one that stays quiet has its time moved on here. At most `limit` projects a pass; a project that fails has its time moved on with a growing backoff (it is not looked at again at once, so a project that keeps failing cannot take the whole pass).
 */
export async function runPoll(deps: SavedEnvDeps, limit: number): Promise<{ ok: true; checked: number; failed: number } | { ok: false; reason: "disabled" | "unavailable" }> {
  const off = disabled(deps);
  if (off !== undefined) return off;
  let due: Array<{ orgId: string; projectId: string }>;
  try { due = await deps.store.pollDue(limit); } catch { return { ok: false, reason: "unavailable" }; }
  let checked = 0;
  let failed = 0;
  for (const ids of due) {
    try {
      const result = await checkRebuild(deps, ids, "poll");
      if (!result.ok) { failed += 1; await moveNextPoll(deps, ids, true); continue; }
      // A quiet project (nothing queued, so nothing written) has its time moved on; a queued one already got a new time with the job.
      if (!result.queued) await moveNextPoll(deps, ids, false);
      checked += 1;
    } catch {
      failed += 1;
      await moveNextPoll(deps, ids, true).catch(() => undefined);
    }
  }
  return { ok: true, checked, failed };
}

async function moveNextPoll(deps: SavedEnvStoreDeps, ids: { orgId: string; projectId: string }, failed: boolean): Promise<void> {
  for (let attempt = 0; attempt < COMMIT_RETRIES; attempt += 1) {
    const state = await deps.store.get(ids.orgId, ids.projectId);
    if (state === undefined) return;
    const failures = failed ? (state.pollFailures ?? 0) + 1 : undefined;
    const gap = failures === undefined ? SAVED_ENV_POLL_MS : Math.min(SAVED_ENV_POLL_BACKOFF_MAX_MS, SAVED_ENV_POLL_MS * 2 ** Math.min(failures, 10));
    if ((await commit(deps, state, { ...state, nextPollAt: iso(deps.now() + gap), pollFailures: failures }, audit(deps, state, "activity", { reason: "poll" })).catch(() => undefined)) !== undefined) return;
  }
}

/** A second Reset within this long of the last one writes nothing: a rebuild builds and pushes a whole image. */
export const SAVED_ENV_RESET_COOLDOWN_MS = 15 * 60_000;

/**
 * A maintainer pressed Reset: a rebuild is queued now (a fresh backoff does not apply). The caller has checked the maintainer's right and names who asked. Nothing is written when
 *   - the project is archived or deleted (a Reset is never remembered on such a row: it would build the moment the project is unarchived or its name reused);
 *   - this very press (`requestId`) was already seen;
 *   - a job is live or a Reset is already waiting (`in_flight`);
 *   - a Reset was asked in the last 15 minutes (`cooldown`).
 */
export async function requestReset(deps: SavedEnvDeps, ids: { orgId: string; projectId: string }, actor: string, requestId?: string): Promise<CheckResult> {
  const off = disabled(deps);
  if (off !== undefined) return off;
  const prior = await deps.store.get(ids.orgId, ids.projectId);
  const now = deps.now();
  if (prior?.deleted === true || prior?.archived === true) return { ok: true, queued: false, why: "archived" };
  if (requestId !== undefined && prior?.lastResetRequestId === requestId) return { ok: true, queued: false, why: "duplicate" };
  if (prior?.resetRequested === true || (prior?.job !== undefined && Date.parse(prior.job.leaseUntil) > now)) return { ok: true, queued: false, why: "in_flight" };
  if (prior?.lastResetAt !== undefined && now - Date.parse(prior.lastResetAt) < SAVED_ENV_RESET_COOLDOWN_MS) return { ok: true, queued: false, why: "cooldown" };
  const written = await commit(deps, prior, { ...(prior ?? blank(ids.orgId, ids.projectId)), resetRequested: true, lastResetAt: iso(now), ...(requestId === undefined ? {} : { lastResetRequestId: requestId }) }, audit(deps, ids, "reset_requested", { actor: actor.slice(0, 200) }));
  if (written === undefined) return { ok: false, reason: "stale_write" };
  return checkRebuild(deps, ids, "poll");
}

/**
 * A maintainer turned the project's saved images on or off (the project's `savedEnv.enabled`; the install's saved-environments switch is above it and off by default). The caller has checked the maintainer's right and names who
 * asked. Turning it off ends any lease (`authorizeLease` refuses an inactive project) and queues nothing; turning it on queues nothing by itself (the next push, task or poll does). A change to the value it
 * already has writes nothing. Nothing is written when the install's switch is off.
 */
export async function setProjectEnabled(deps: SavedEnvDeps, ids: { orgId: string; projectId: string }, enabled: boolean, actor: string): Promise<{ ok: true; changed: boolean } | { ok: false; reason: "disabled" | "stale_write" }> {
  const off = disabled(deps);
  if (off !== undefined) return off;
  const prior = await deps.store.get(ids.orgId, ids.projectId);
  if ((prior?.enabled ?? true) === enabled) return { ok: true, changed: false };
  const written = await commit(deps, prior, { ...(prior ?? blank(ids.orgId, ids.projectId)), enabled }, audit(deps, ids, "setting_changed", { enabled, actor }));
  return written === undefined ? { ok: false, reason: "stale_write" } : { ok: true, changed: true };
}

// ---- the job's lease

export type LeaseResult = { ok: true; job: RebuildJob; state: SavedEnvState } | { ok: false; reason: "disabled" | "no_job" | "bad_lease" | "expired" | "inactive" };

/**
 * Whether `jobId` and `leaseToken` are the lease of the project's current rebuild job, and the project is live (not deleted, archived or turned off). The push login route and the result route both call this
 * FIRST: no other caller (a task, the setup agent, a person) holds a lease. A refused lease is audited with its fixed reason.
 */
export async function authorizeLease(deps: SavedEnvDeps, ids: { orgId: string; projectId: string }, lease: { jobId: string; leaseToken: string }): Promise<LeaseResult> {
  const off = disabled(deps);
  if (off !== undefined) return off;
  const refused = async (reason: Exclude<LeaseResult, { ok: true }>["reason"]): Promise<LeaseResult> => {
    await deps.store.audit(audit(deps, ids, "lease_refused", { reason })).catch(() => undefined);
    return { ok: false, reason };
  };
  const state = await deps.store.get(ids.orgId, ids.projectId);
  const job = state?.job;
  if (state === undefined || job === undefined) return refused("no_job");
  if (!sameToken(job.jobId, lease.jobId) || !sameToken(job.leaseToken, lease.leaseToken)) return refused("bad_lease");
  if (Date.parse(job.leaseUntil) <= deps.now()) return refused("expired");
  if (state.deleted === true || state.archived === true || !state.enabled) return refused("inactive");
  return { ok: true, job, state };
}

/**
 * The dispatcher takes the queued job's lease token to hand it to the worker that will build. Nobody else sees a token: not `checkRebuild`'s result, not a task, not the setup agent. The token goes to ONE
 * operation (`operationId`, kept with `dispatchedAt`): the same operation asking again (a delivery that is retried after the token was taken) is given the same token, any other operation or a caller
 * that names none gets nothing.
 */
export async function leaseForDispatch(deps: SavedEnvStoreDeps, ids: { orgId: string; projectId: string }, operationId?: string): Promise<{ ok: true; job: Pick<RebuildJob, "jobId" | "leaseToken" | "reason" | "approved" | "commits" | "leaseUntil"> } | { ok: false; reason: "disabled" | "nothing_to_dispatch" | "stale_write" }> {
  const off = disabled(deps);
  if (off !== undefined) return off;
  const state = await deps.store.get(ids.orgId, ids.projectId);
  const job = state?.job;
  if (state === undefined || job === undefined || Date.parse(job.leaseUntil) <= deps.now() || state.deleted === true || state.archived === true || !state.enabled) return { ok: false, reason: "nothing_to_dispatch" };
  const given = { ok: true as const, job: { jobId: job.jobId, leaseToken: job.leaseToken, reason: job.reason, approved: job.approved, commits: job.commits, leaseUntil: job.leaseUntil } };
  if (job.dispatchedAt !== undefined) return operationId !== undefined && job.dispatchedOperationId === operationId ? given : { ok: false, reason: "nothing_to_dispatch" };
  const written = await commit(deps, state, { ...state, job: { ...job, dispatchedAt: iso(deps.now()), ...(operationId === undefined ? {} : { dispatchedOperationId: operationId }) } }, audit(deps, state, "rebuild_queued", { reason: "dispatched" }));
  if (written === undefined) return { ok: false, reason: "stale_write" };
  return given;
}

/**
 * The operation made for a job ended without the job being recorded (its preparation failed, its delivery could not be done, the worker was lost, the lease ran out): the job is ended now, with a fixed word and the
 * failure backoff, so the project does not wait out the lease for a build nobody is running. A job that was RECORDED, or replaced by another, is not the project's current one and nothing changes.
 * One case is not a failure: the repository moved between the queue and the clone (the worker refuses a head other than the pinned one, and an arbitrary reachable commit is never accepted instead). The default branch
 * heads are read again; if they are not the job's, the job is ended without a failure and a rebuild for the heads now is queued.
 */
export async function endBuildJob(deps: SavedEnvDeps, ids: { orgId: string; projectId: string }, jobId: string, cause: "operation_failed" | "worker_lost" | "lease_expired"): Promise<{ ended: boolean; requeued: boolean }> {
  if (disabled(deps) !== undefined) return { ended: false, requeued: false };
  for (let attempt = 0; attempt < COMMIT_RETRIES; attempt += 1) {
    const state = await deps.store.get(ids.orgId, ids.projectId);
    const job = state?.job;
    if (state === undefined || job === undefined || job.jobId !== jobId) return { ended: false, requeued: false };
    const heads = await deps.defaultHeads(ids.orgId, ids.projectId).catch(() => undefined);
    const moved = heads !== undefined && heads.size > 0 && !(heads.size === Object.keys(job.commits).length && [...heads].every(([name, sha]) => job.commits[name] === sha));
    const next: SavedEnvState = moved ? { ...state, job: undefined } : { ...state, job: undefined, health: "needs_repair", lastFailureAt: iso(deps.now()), lastFailure: cause };
    const written = await commit(deps, state, next, audit(deps, state, "build_failed", { reason: moved ? "head_moved" : cause }));
    if (written === undefined) continue;
    if (!moved) return { ended: true, requeued: false };
    const again = await checkRebuild(deps, ids, "poll").catch(() => undefined);
    return { ended: true, requeued: again?.ok === true && again.queued };
  }
  return { ended: false, requeued: false };
}

/**
 * The only way to a push login: the lease is checked, the project must be live, and the login is minted for the JOB'S approved pin (never one the caller names). The raw `mintPushSession` is not for routes.
 */
export async function mintPushForJob(deps: SavedEnvDeps, ids: { orgId: string; projectId: string }, lease: { jobId: string; leaseToken: string }): Promise<Awaited<ReturnType<typeof mintPushSession>> | { ok: false; reason: Exclude<LeaseResult, { ok: true }>["reason"] }> {
  const leased = await authorizeLease(deps, ids, lease);
  if (!leased.ok) return leased;
  return mintPushSession(deps.session.config, deps.session.ports, { ...ids, approved: leased.job.approved });
}

// ---- recording a build

export type RecordRefusal = "disabled" | "no_job" | "bad_lease" | "expired" | "inactive" | "build_failed" | "not_approved" | "wrong_commits" | "wrong_manifest" | "wrong_repository" | "repository_mismatch" | "stale_write" | "bad_result";
export type RecordResult = { ok: true; image: SavedEnvImageRecord; deleted: number } | { ok: false; reason: RecordRefusal };

const COMMIT_RETRIES = 3;

export async function recordBuild(deps: SavedEnvDeps, ids: { orgId: string; projectId: string }, input: { jobId: string; leaseToken: string; result: unknown }): Promise<RecordResult> {
  let leased = await authorizeLease(deps, ids, input);
  const parsed = SavedEnvBuildResultSchema.safeParse(input.result);
  if (!leased.ok) {
    // A result that arrives after the project was deleted (a push that was in flight re-created the repository), or while the project is turned off, must not leave its image behind: the repository is deleted
    // again (a deleted row), or the pushed digest is (the lease was valid). A refused lease of any other kind deletes nothing: the caller proved nothing.
    if (leased.reason === "no_job" || leased.reason === "inactive") await cleanLateResult(deps, ids, parsed.success && parsed.data.ok ? parsed.data.imageDigest : undefined, leased.reason);
    return leased;
  }
  if (!parsed.success) return { ok: false, reason: "bad_result" };
  const result: SavedEnvBuildResult = parsed.data;

  /** Commits `change` over the freshest row while this lease is still the job (a write that met another write is retried, not lost). */
  const commitWhileLeased = async (change: (state: SavedEnvState) => SavedEnvState, entry: (state: SavedEnvState) => SavedEnvAuditEntry): Promise<SavedEnvState | undefined> => {
    for (let attempt = 0; attempt < COMMIT_RETRIES; attempt += 1) {
      if (!leased.ok) return undefined;
      const written = await commit(deps, leased.state, change(leased.state), entry(leased.state));
      if (written !== undefined) return written;
      leased = await authorizeLease(deps, ids, input);
    }
    return undefined;
  };

  if (!result.ok) {
    await commitWhileLeased((state) => ({ ...state, job: undefined, health: "needs_repair", lastFailureAt: iso(deps.now()), lastFailure: result.reason }), (state) => audit(deps, state, "build_failed", { reason: result.reason }));
    return { ok: false, reason: "build_failed" };
  }
  const job = leased.job;
  const refuse = async (reason: RecordRefusal): Promise<RecordResult> => {
    // What was pushed is not kept: the digest is deleted from the registry (best effort; the walk deletes any digest the row does not name).
    await deleteDigest(deps, ids, result.imageDigest);
    await commitWhileLeased((state) => ({ ...state, job: undefined, lastFailureAt: iso(deps.now()), lastFailure: reason, health: "needs_repair" }), (state) => audit(deps, state, "build_refused", { reason, digest: result.imageDigest }));
    return { ok: false, reason };
  };
  // this project's repository, and the environment the job was queued for is still the newest approved one
  if (result.repository !== savedEnvRepositoryName({ env: deps.session.config.env, orgId: ids.orgId, projectId: ids.projectId })) return refuse("wrong_repository");
  const approved = await deps.approved(ids.orgId, ids.projectId);
  if (approved === undefined || approved.revision !== job.approved.revision || approved.digest !== job.approved.digest) return refuse("not_approved");
  // the manifest says what the job asked for: its revision, its key (when the job knew it), and EXACTLY the commits the job was given
  if (result.manifest.testEnvRevision !== job.approved.revision || result.manifest.imageDigest !== result.imageDigest) return refuse("wrong_manifest");
  if (result.manifest.environmentKey !== job.expectedKey) return refuse("wrong_manifest");
  const wanted = Object.entries(job.commits);
  if (result.manifest.commits.length !== wanted.length || result.manifest.commits.some((entry) => job.commits[entry.repositoryId] !== entry.sha)) return refuse("wrong_commits");
  // the repository in the registry is the one the creation template made (checked now, after the push)
  const verified = await verifyRepository(deps.session.config, deps.session.ports, ids);
  if (!verified.ok || verified.state !== "matches") return refuse("repository_mismatch");

  const image: SavedEnvImageRecord = { approved: job.approved, digest: result.imageDigest, tag: result.tag, manifest: result.manifest, recordedAt: iso(deps.now()), status: "ready" };
  const keep = keepOf(await deps.keep(ids.orgId).catch(() => SAVED_ENV_KEEP_DEFAULT));
  const written = await commitWhileLeased(
    (state) => ({ ...state, images: [image, ...state.images.filter((known) => known.digest !== image.digest)].slice(0, keep), job: undefined, health: "healthy", lastFailure: undefined, lastFailureAt: undefined }),
    (state) => audit(deps, state, "build_recorded", { digest: image.digest, reason: job.reason }),
  );
  if (written === undefined) return { ok: false, reason: "stale_write" };
  // best effort from here: the image is recorded; a failed scan or walk is retried by the next walk
  const scanned = await startScan(deps, ids, image.digest);
  const walked = await walk(deps, ids);
  return { ok: true, image: scanned ? { ...image, scanStartedAt: iso(deps.now()) } : image, deleted: walked.ok ? walked.deleted : 0 };
}

/** A result for a project that no longer takes one. Deleted row: the repository goes again (it removes whatever was pushed). A valid lease on a project turned off: the pushed digest goes. */
async function cleanLateResult(deps: SavedEnvDeps, ids: { orgId: string; projectId: string }, digest: string | undefined, reason: "no_job" | "inactive"): Promise<void> {
  try {
    const state = await deps.store.get(ids.orgId, ids.projectId);
    if (state?.deleted === true) await purgeRegistry(deps, ids, "late_result");
    else if (reason === "inactive" && digest !== undefined) await deleteDigest(deps, ids, digest);
  } catch { /* the nightly sweep and the walk are the backstop */ }
}

/** The registry call's address: the company and the project's repository, or undefined when the switch is off or an id is not text. */
function callOf(deps: SavedEnvDeps, ids: { orgId: string; projectId: string }): { companyId: string; repository: string } | undefined {
  if (!deps.session.config.enabled) return undefined;
  const repository = repositoryOf(deps.session.config, ids.orgId, ids.projectId);
  return repository === undefined ? undefined : { companyId: ids.orgId, repository };
}

async function deleteDigest(deps: SavedEnvDeps, ids: { orgId: string; projectId: string }, digest: string): Promise<void> {
  const call = callOf(deps, ids);
  if (call === undefined) return;
  try { await deps.session.ports.registry.deleteImages({ ...call, digests: [digest] }); } catch { return; }
  await deps.store.audit(audit(deps, ids, "images_deleted", { digest, count: 1, reason: "refused_build" })).catch(() => undefined);
}

async function startScan(deps: SavedEnvDeps, ids: { orgId: string; projectId: string }, digest: string): Promise<boolean> {
  const call = callOf(deps, ids);
  const registry = deps.session.ports.registry;
  if (call === undefined || !registry.capabilities.scan || registry.startScan === undefined) return false;
  try { await registry.startScan({ ...call, digest }); } catch { return false; }
  await deps.store.audit(audit(deps, ids, "scan_started", { digest })).catch(() => undefined);
  return true;
}

// ---- failure, staleness

/** A build that could not finish (the worker reports a fixed word). The project's health says "needs repair"; the next automatic try waits out the backoff. */
export async function reportFailure(deps: SavedEnvDeps, ids: { orgId: string; projectId: string }, input: { jobId: string; leaseToken: string; reason: string }): Promise<{ ok: boolean }> {
  const leased = await authorizeLease(deps, ids, input);
  if (!leased.ok) return { ok: false };
  const reason = input.reason.replace(/[^a-z_]/gu, "").slice(0, 40);
  const written = await commit(deps, leased.state, { ...leased.state, job: undefined, health: "needs_repair", lastFailureAt: iso(deps.now()), lastFailure: reason }, audit(deps, leased.state, "build_failed", { reason }));
  return { ok: written !== undefined };
}

/**
 * A task fell back from the image at `step`: the image is marked stale and a rebuild is queued. A task is never blocked: this only makes the next one better. The digest names which
 * image the task used, so a report about an older one does not stale the newest.
 */
export async function markStale(deps: SavedEnvDeps, ids: { orgId: string; projectId: string }, input: { digest: string; step: string }): Promise<{ ok: boolean }> {
  if (disabled(deps) !== undefined) return { ok: false };
  // Only a step that says something about the IMAGE marks it: no login, an out-of-date login and a step this version does not know change nothing.
  const step = SAVED_ENV_USE_STEPS.find((known) => known === input.step);
  if (step === undefined || !savedEnvStepMarksStale(step)) return { ok: true };
  const state = await deps.store.get(ids.orgId, ids.projectId);
  if (state === undefined) return { ok: false };
  const at = state.images.findIndex((image) => image.digest === input.digest);
  if (at < 0) return { ok: true };
  const images = state.images.map((image, index) => (index === at ? { ...image, status: "stale" as const, staleStep: input.step.replace(/[^a-z_]/gu, "").slice(0, 20) } : image));
  const written = await commit(deps, state, { ...state, images }, audit(deps, state, "marked_stale", { digest: input.digest, reason: input.step }));
  if (written === undefined) return { ok: false };
  await checkRebuild(deps, ids, "poll");
  return { ok: true };
}

// ---- what a task may use

export type TaskImage = { digest: string; environmentKey: string; testEnvRevision: number };

/**
 * The image a task pinned to `taskPin` may use: the newest image that is `ready`, built for that very approved environment (revision AND digest), not older than the max age, of a project that is live (not
 * archived, deleted or turned off). The caller puts its digest in the prepare payload and mints the pull login. Undefined: the task sets up fresh, as before.
 */
export function imageForTask(state: SavedEnvState | undefined, taskPin: ApprovedPin, nowMs: number): TaskImage | undefined {
  if (state === undefined || !state.enabled || state.deleted === true || state.archived === true) return undefined;
  const image = state.images[0];
  if (image === undefined || image.status !== "ready") return undefined;
  if (image.manifest.testEnvRevision !== taskPin.revision || image.approved.revision !== taskPin.revision || image.approved.digest !== taskPin.digest) return undefined;
  if (nowMs - Date.parse(image.recordedAt) > (SAVED_ENV_MAX_AGE_DAYS + 1) * DAY_MS) return undefined;
  return { digest: image.digest, environmentKey: image.manifest.environmentKey, testEnvRevision: image.manifest.testEnvRevision };
}

/** A task's preparation records the task as activity (and may queue a rebuild) at most this often: a retried or re-dispatched preparation does not repeat the check. */
export const SAVED_ENV_TASK_CHECK_MS = 10 * 60_000;

/**
 * What a preparation is told about the project's saved environment: the image a task pinned to `taskPin` may use (`imageForTask`) as a REFERENCE (repository, digest, revision, key, the pinned revision).
 * It carries no login: the invocation is stored, so the worker asks for the login at pull time (`savedEnvPullLogin`). Nothing (an empty object) when the switch is off, there is no usable image, or anything
 * fails: the task sets up fresh, as before. Records the task as activity (the idle test) and may queue a rebuild, at most once per `SAVED_ENV_TASK_CHECK_MS`; a failure of either never blocks the preparation.
 */
export async function savedEnvForPrepare(deps: SavedEnvDeps, ids: { orgId: string; projectId: string }, taskPin: ApprovedPin): Promise<{ savedEnv?: PrepareSavedEnv }> {
  if (disabled(deps) !== undefined) return {};
  // A registry a worker cannot pull from names no image: the task sets up fresh, as before.
  if (!deps.session.ports.registry.capabilities.workerPull) return {};
  try {
    let state = await deps.store.get(ids.orgId, ids.projectId);
    const last = Date.parse(state?.lastTaskAt ?? "");
    if (!(last > 0 && deps.now() - last < SAVED_ENV_TASK_CHECK_MS)) {
      await checkRebuild(deps, ids, "task").catch(() => undefined);
      state = await deps.store.get(ids.orgId, ids.projectId);
    }
    const image = imageForTask(state, taskPin, deps.now());
    if (image === undefined) return {};
    const parsed = PrepareSavedEnvSchema.safeParse({
      repository: savedEnvRepositoryName({ env: deps.session.config.env, orgId: ids.orgId, projectId: ids.projectId }),
      digest: image.digest, testEnvRevision: image.testEnvRevision, environmentKey: image.environmentKey, taskTestEnvRevision: taskPin.revision,
    });
    return parsed.success ? { savedEnv: parsed.data } : {};
  } catch {
    return {};
  }
}

export type PullLoginResult = { ok: true; auth: SavedEnvRegistryAuth } | { ok: false; reason: "disabled" | "no_image" | "unavailable" };

/**
 * The pull login for the image a running preparation was told to pull (review M1: the login is minted at pull time, never stored in an invocation). The digest is the one the BROKER recorded with the
 * operation, never one the worker names. It must still be an image of the row, `ready`, not past the max age, of a project that is live; the login is minted for that image's approved pin, which `mintPullSession`
 * holds against the project's newest approved environment. One repository, short lived.
 */
export async function savedEnvPullLogin(deps: SavedEnvDeps, ids: { orgId: string; projectId: string }, digest: string): Promise<PullLoginResult> {
  const off = disabled(deps);
  if (off !== undefined) return off;
  const state = await deps.store.get(ids.orgId, ids.projectId);
  if (state === undefined || !state.enabled || state.deleted === true || state.archived === true) return { ok: false, reason: "no_image" };
  const image = state.images.find((known) => known.digest === digest);
  if (image === undefined || image.status !== "ready" || deps.now() - Date.parse(image.recordedAt) > (SAVED_ENV_MAX_AGE_DAYS + 1) * DAY_MS) return { ok: false, reason: "no_image" };
  const login = await mintPullSession(deps.session.config, deps.session.ports, { ...ids, approved: image.approved });
  return login.ok ? { ok: true, auth: login.auth } : { ok: false, reason: "unavailable" };
}

// ---- the manage walk, archive and delete

export type WalkResult = { ok: true; deleted: number } | { ok: false; reason: "disabled" | "unavailable" | "stale_write" };

/**
 * Brings the registry in line with the row. The row decides: the images it names (the newest `keep`) stay; every other digest in the registry is deleted once it is older than the grace period (a digest just
 * pushed, not yet recorded, is left alone); an image pushed more than 30 days ago (`SAVED_ENV_IMAGE_CEILING_DAYS`, which a registry's lifecycle cannot express) is deleted even when the row names it; untagged images
 * older than a day go. A recorded image the registry no longer holds is dropped from the row. Uses the broker's own registry call. A registry's own count rule (`keep` plus a margin) is a backstop.
 */
export async function walk(deps: SavedEnvDeps, ids: { orgId: string; projectId: string }): Promise<WalkResult> {
  const off = disabled(deps);
  if (off !== undefined) return off;
  const state = await deps.store.get(ids.orgId, ids.projectId);
  if (state === undefined) return { ok: true, deleted: 0 };
  // A deleted project's registry is deleted whole (a push that was in flight at the delete may have re-created the repository); the nightly walk includes deleted rows for this.
  if (state.deleted === true) {
    const purged = await purgeRegistry(deps, ids, "deleted_walk");
    return purged.ok ? { ok: true, deleted: purged.deleted } : { ok: false, reason: "unavailable" };
  }
  const call = callOf(deps, ids);
  if (call === undefined) return { ok: false, reason: "unavailable" };
  const registry = deps.session.ports.registry;
  let listed: RegistryImage[];
  try {
    const found = await registry.list(call);
    listed = found === "absent" ? [] : found;
  } catch { return { ok: false, reason: "unavailable" }; }
  const now = deps.now();
  const keep = keepOf(await deps.keep(ids.orgId).catch(() => SAVED_ENV_KEEP_DEFAULT));
  const named = new Set(state.images.slice(0, keep).map((image) => image.digest));
  // While a job's lease is live, a build may have pushed a digest it has not reported yet (it can take longer than the grace period): unnamed digests stay. The age ceiling and the untagged rule still apply.
  const building = state.job !== undefined && Date.parse(state.job.leaseUntil) > now;
  const doomed = new Set<string>();
  for (const image of listed) {
    const age = now - Date.parse(image.pushedAt);
    if (age > SAVED_ENV_IMAGE_CEILING_DAYS * DAY_MS) doomed.add(image.digest);
    else if (image.tags.length === 0 && age > DAY_MS) doomed.add(image.digest);
    else if (!building && !named.has(image.digest) && age > RECORD_GRACE_MS) doomed.add(image.digest);
  }
  if (doomed.size > 0) {
    try { await registry.deleteImages({ ...call, digests: [...doomed] }); } catch { return { ok: false, reason: "unavailable" }; }
    await deps.store.audit(audit(deps, ids, "images_deleted", { count: doomed.size, reason: "walk" })).catch(() => undefined);
  }
  const alive = new Set(listed.map((image) => image.digest).filter((digest) => !doomed.has(digest)));
  // An image recorded in the last few minutes stays even if the registry's list does not show it yet (listing is not instantly consistent): dropping it would queue a rebuild of what was just built.
  const images = state.images.slice(0, keep).filter((image) => alive.has(image.digest) || (!doomed.has(image.digest) && now - Date.parse(image.recordedAt) < RECORD_GRACE_MS));
  if (images.length === state.images.length) return { ok: true, deleted: doomed.size };
  const written = await commit(deps, state, { ...state, images, health: images.length === 0 && state.health === "healthy" ? "needs_repair" : state.health }, audit(deps, state, "ceiling_walk", { count: doomed.size }));
  return written === undefined ? { ok: false, reason: "stale_write" } : { ok: true, deleted: doomed.size };
}

/** Why an archived project keeps its images (recorded here so the decision is read in one place). */
export const ARCHIVE_POLICY = "An archived project keeps its saved images until the age ceiling deletes them, so an unarchive needs no rebuild; it queues no rebuild and mints no login. Only a delete removes them at once." as const;

export async function onProjectArchived(deps: SavedEnvDeps, ids: { orgId: string; projectId: string }, archived: boolean): Promise<{ ok: boolean }> {
  // The mark is written whatever the saved-environments switch says: a project archived while the switch is off must not get a build when it is turned on. A write that met another write is retried.
  for (let attempt = 0; attempt < COMMIT_RETRIES; attempt += 1) {
    // A project with no row yet is archived all the same (a later build must not start for it).
    const state = await deps.store.get(ids.orgId, ids.projectId);
    const base = state ?? blank(ids.orgId, ids.projectId);
    const written = await commit(deps, state, { ...base, archived, ...(archived ? { job: undefined } : {}) }, audit(deps, base, "project_archived", { reason: archived ? "archived" : "unarchived" }));
    if (written !== undefined) return { ok: true };
  }
  return { ok: false };
}

/**
 * A project was deleted. FIRST the row is committed as deleted with no job (retrying a write that met another write), so no build, login or record can follow; THEN the repository is deleted with its images using
 * the broker's own registry call. A repository that does not exist counts as done. If the registry cannot be reached the row stays deleted and the caller retries the registry part. Audited, with or without a row.
 */
export async function onProjectDeleted(deps: SavedEnvDeps, ids: { orgId: string; projectId: string }): Promise<{ ok: true; deleted: number } | { ok: false; reason: "disabled" | "unavailable" | "stale_write" }> {
  // The mark is written whatever the saved-environments switch says (a project deleted while the switch is off must never get a build or a login later); only the registry part needs the switch.
  let committed = false;
  for (let attempt = 0; attempt < COMMIT_RETRIES && !committed; attempt += 1) {
    const state = await deps.store.get(ids.orgId, ids.projectId);
    const base = state ?? blank(ids.orgId, ids.projectId);
    committed = (await commit(deps, state, { ...base, images: [], job: undefined, resetRequested: false, deleted: true, deletedAt: iso(deps.now()), health: "never_proved" }, audit(deps, base, "project_deleted"))) !== undefined;
  }
  if (!committed) return { ok: false, reason: "stale_write" };
  return purgeRegistry(deps, ids, "project_deleted");
}

/** Deletes the project's repository with its images (the broker's own registry call). A repository that does not exist counts as done. Answers `disabled` when the switch is off: nothing is touched. */
async function purgeRegistry(deps: SavedEnvDeps, ids: { orgId: string; projectId: string }, reason: string): Promise<{ ok: true; deleted: number } | { ok: false; reason: "disabled" | "unavailable" }> {
  const off = disabled(deps);
  if (off !== undefined) return off;
  const call = callOf(deps, ids);
  if (call === undefined) return { ok: false, reason: "unavailable" };
  const registry = deps.session.ports.registry;
  let count = 0;
  try {
    const found = await registry.list(call);
    if (found !== "absent") {
      count = found.length;
      await registry.deleteRepository(call);
    }
  } catch { return { ok: false, reason: "unavailable" }; }
  if (count > 0) await deps.store.audit(audit(deps, ids, "images_deleted", { count, reason })).catch(() => undefined);
  await markPurged(deps, ids);
  return { ok: true, deleted: count };
}

/** Records that the registry deletion finished now. Best effort: a row that cannot be written is simply swept again. */
async function markPurged(deps: SavedEnvDeps, ids: { orgId: string; projectId: string }): Promise<void> {
  for (let attempt = 0; attempt < COMMIT_RETRIES; attempt += 1) {
    const state = await deps.store.get(ids.orgId, ids.projectId).catch(() => undefined);
    if (state === undefined || state.deleted !== true) return;
    if ((await commit(deps, state, { ...state, registryPurgedAt: iso(deps.now()) }, audit(deps, state, "images_deleted", { reason: "purged" })).catch(() => undefined)) !== undefined) return;
  }
}

/**
 * Nightly: the registry deletion is run again for every deleted project whose deletion is not final. A deletion is final once it finished AFTER `deletedAt` plus a job's lease: a build that was in flight at the
 * delete cannot push after that. Best effort per project.
 */
export async function sweepDeleted(deps: SavedEnvDeps): Promise<{ ok: true; swept: number; failed: number } | { ok: false; reason: "disabled" | "unavailable" }> {
  const off = disabled(deps);
  if (off !== undefined) return off;
  let rows: Array<{ orgId: string; projectId: string }>;
  try { rows = await deps.store.deletedNeedingPurge(SAVED_ENV_JOB_LEASE_MS); } catch { return { ok: false, reason: "unavailable" }; }
  let swept = 0;
  let failed = 0;
  for (const row of rows) {
    const done = await purgeRegistry(deps, row, "deleted_sweep").catch(() => ({ ok: false as const }));
    if (done.ok) swept += 1; else failed += 1;
  }
  return { ok: true, swept, failed };
}

/**
 * A project is registered under a name whose row says deleted (a name can be reused after a delete): the mark is cleared and the row starts over (no images, no job, nothing remembered of the old project). An
 * old repository that was not deleted yet holds only digests the new row does not name, so the walk deletes them. The mark is written whatever the saved-environments switch says. A project with no deleted row changes nothing.
 */
export async function onProjectRegistered(deps: SavedEnvDeps, ids: { orgId: string; projectId: string }): Promise<{ ok: boolean }> {
  for (let attempt = 0; attempt < COMMIT_RETRIES; attempt += 1) {
    const state = await deps.store.get(ids.orgId, ids.projectId);
    if (state?.deleted !== true) return { ok: true };
    if ((await commit(deps, state, blank(ids.orgId, ids.projectId), audit(deps, state, "project_registered"))) !== undefined) return { ok: true };
  }
  return { ok: false };
}
