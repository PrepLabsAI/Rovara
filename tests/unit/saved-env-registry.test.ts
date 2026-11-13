// The registry of a project's saved environment images: when a rebuild is queued, what a build result must satisfy before it is recorded, who may hold the job's lease, what a task may use, keep N and
// the age ceiling, archive and delete. Everything is off with the switch off.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PrepareSavedEnvSchema, SavedEnvPanelSchema, savedEnvRepositoryName, type RegistryImage, type SavedEnvManifest } from "../../packages/contracts/src/index.js";
import {
  ARCHIVE_POLICY, SAVED_ENV_FAILURE_BACKOFF_MS, SAVED_ENV_JOB_LEASE_MS, authorizeLease, checkRebuild, imageForTask, leaseForDispatch, lightSetup, markStale, mintPushForJob, savedEnvForPrepare, savedEnvPullLogin, sweepDeleted, SAVED_ENV_TASK_CHECK_MS, SAVED_ENV_RESET_COOLDOWN_MS, onProjectRegistered, onProjectArchived, onProjectDeleted, rebuildReason, recordBuild, reportFailure, requestReset, walk,
  type SavedEnvState,
} from "../../packages/core/src/core/test-env/saved-env.js";
import { panelView, resetFromPanel, savedEnvPanel } from "../../packages/core/src/core/test-env/saved-env-panel.js";
import { installSavedEnv, savedEnvPrepareOf } from "../../packages/core/src/core/test-env/saved-env-prepare.js";
import { APPROVED, COMMIT, DAY, KEY, T0, dig, imageOf, iso, manifestOf, savedEnvWorld, type WorldOptions } from "../support/saved-env-world.js";

const ids = { orgId: "org-1", projectId: "proj-1" };
const world = (over: WorldOptions = {}) => savedEnvWorld(over);
type World = ReturnType<typeof world>;
const repository = world().repository;
const seed = (w: World, state: Partial<SavedEnvState>): void => w.seed(state);

describe("when a rebuild is due", () => {
  const image = imageOf(dig(1));
  const base = { now: T0, image, approved: APPROVED, currentKey: KEY, resetRequested: false };

  it("no approved environment decides nothing; no image, a stale one, another revision, another key, an old image and a reset each have their word", () => {
    expect(rebuildReason({ ...base, approved: undefined, image: undefined })).toBeUndefined();
    expect(rebuildReason({ ...base, image: undefined })).toBe("no_image");
    expect(rebuildReason({ ...base, image: { ...image, status: "stale" } })).toBe("stale");
    expect(rebuildReason({ ...base, approved: { ...APPROVED, revision: 5 } })).toBe("key_changed");
    expect(rebuildReason({ ...base, currentKey: "d".repeat(64) })).toBe("key_changed");
    expect(rebuildReason({ ...base, now: T0 + 7 * DAY + 1 })).toBe("max_age");
    expect(rebuildReason({ ...base, resetRequested: true })).toBe("reset");
    expect(rebuildReason(base)).toBeUndefined();
    expect(rebuildReason({ ...base, now: T0 + 7 * DAY })).toBeUndefined();
  });

  it("a key that cannot be worked out decides nothing about the key", () => {
    expect(rebuildReason({ ...base, currentKey: undefined })).toBeUndefined();
  });

  it("an idle repository (no push and no task for 7 days) is saved light: no image is built", () => {
    expect(lightSetup({ lastPushAt: iso(T0 - 8 * DAY) }, T0)).toBe(true);
    expect(lightSetup({ lastPushAt: iso(T0 - 8 * DAY), lastTaskAt: iso(T0 - DAY) }, T0)).toBe(false);
    expect(lightSetup({}, T0)).toBe(false);
    expect(lightSetup({ lastPushAt: iso(T0 - 4 * DAY) }, T0, 3)).toBe(true);
  });
});

describe("queueing a rebuild", () => {
  it("is off with the switch off: nothing is read or written", async () => {
    const w = world({ enabled: false });
    expect(await checkRebuild(w.deps, ids, "push")).toEqual({ ok: false, reason: "disabled" });
    expect(await requestReset(w.deps, ids, "person-1")).toEqual({ ok: false, reason: "disabled" });
    expect(await authorizeLease(w.deps, ids, { jobId: "x", leaseToken: "y" })).toEqual({ ok: false, reason: "disabled" });
    expect(await walk(w.deps, ids)).toEqual({ ok: false, reason: "disabled" });
    expect(await markStale(w.deps, ids, { digest: dig(1), step: "pull" })).toEqual({ ok: false });
    expect(await savedEnvPullLogin(w.deps, ids, dig(1))).toEqual({ ok: false, reason: "disabled" });
    expect(await sweepDeleted(w.deps)).toEqual({ ok: false, reason: "disabled" });
    expect(w.store.rows.size).toBe(0);
    expect(w.calls.reached).toBe(0);
  });

  it("a delete or an archive is MARKED even with the switch off (nothing is built for the project when it is turned on later), and the registry is not touched", async () => {
    const w = world({ enabled: false });
    expect(await onProjectDeleted(w.deps, { orgId: "org-1", projectId: "gone" })).toEqual({ ok: false, reason: "disabled" });
    expect(w.store.rows.get("org-1#gone")).toMatchObject({ deleted: true, images: [] });
    expect(await onProjectArchived(w.deps, { orgId: "org-1", projectId: "kept" }, true)).toEqual({ ok: true });
    expect(w.store.rows.get("org-1#kept")).toMatchObject({ archived: true });
    expect(w.calls.reached).toBe(0);
    expect(w.calls.repoDeleted).toBe(0);
  });

  it("an archive that met another write is retried", async () => {
    const w = world(); seed(w, { images: [imageOf(dig(1))] });
    w.store.failNextCommit();
    expect(await onProjectArchived(w.deps, ids, true)).toEqual({ ok: true });
    expect(w.store.rows.get("org-1#proj-1")!.archived).toBe(true);
  });

  it("a project with an approved environment and no image gets a job with a lease; a second check while it runs changes nothing", async () => {
    const w = world();
    const first = await checkRebuild(w.deps, ids, "push");
    expect(first).toMatchObject({ ok: true, queued: true, job: { reason: "no_image", approved: APPROVED } });
    const row = w.store.rows.get("org-1#proj-1")!;
    expect(row.job).toMatchObject({ reason: "no_image", approved: APPROVED });
    expect(row.job!.leaseUntil).toBe(iso(T0 + SAVED_ENV_JOB_LEASE_MS));
    expect(row.job!.leaseToken.length).toBeGreaterThanOrEqual(32);
    expect(await checkRebuild(w.deps, ids, "nightly")).toEqual({ ok: true, queued: false, why: "in_flight" });
    expect(w.store.log.filter((entry) => entry.action === "rebuild_queued")).toHaveLength(1);
  });

  it("an expired lease is taken over by the next check", async () => {
    const w = world();
    await checkRebuild(w.deps, ids, "push");
    const first = w.store.rows.get("org-1#proj-1")!.job!;
    w.clock.now += SAVED_ENV_JOB_LEASE_MS + 1;
    expect(await checkRebuild(w.deps, ids, "poll")).toMatchObject({ ok: true, queued: true });
    expect(w.store.rows.get("org-1#proj-1")!.job!.jobId).not.toBe(first.jobId);
    expect((await authorizeLease(w.deps, ids, { jobId: first.jobId, leaseToken: first.leaseToken })).ok).toBe(false);
  });

  it("no approved environment, an archived project, and a project that turned the feature off queue nothing", async () => {
    expect(await checkRebuild(world({ approved: undefined }).deps, ids, "push")).toEqual({ ok: true, queued: false, why: "no_approved" });
    const archived = world(); seed(archived, { archived: true });
    expect(await checkRebuild(archived.deps, ids, "push")).toEqual({ ok: true, queued: false, why: "archived" });
    const off = world(); seed(off, { enabled: false });
    expect(await checkRebuild(off.deps, ids, "push")).toEqual({ ok: true, queued: false, why: "off_for_project" });
  });

  it("a fresh image with the same key queues nothing; a changed key, an age past 7 days and a stale mark each queue", async () => {
    const quiet = world(); seed(quiet, { images: [imageOf(dig(1))], health: "healthy" });
    expect(await checkRebuild(quiet.deps, ids, "push")).toEqual({ ok: true, queued: false, why: "no_change" });
    const changed = world({ key: "d".repeat(64) }); seed(changed, { images: [imageOf(dig(1))] });
    expect(await checkRebuild(changed.deps, ids, "push")).toMatchObject({ queued: true, job: { reason: "key_changed" } });
    const old = world({ now: T0 + 8 * DAY }); seed(old, { images: [imageOf(dig(1))], lastPushAt: iso(T0 + 8 * DAY - 1000) });
    expect(await checkRebuild(old.deps, ids, "nightly")).toMatchObject({ queued: true, job: { reason: "max_age" } });
    const stale = world(); seed(stale, { images: [imageOf(dig(1), { status: "stale" })] });
    expect(await checkRebuild(stale.deps, ids, "poll")).toMatchObject({ queued: true, job: { reason: "stale" } });
  });

  it("an idle repository is not rebuilt by the nightly or the poll, but a push or a Reset does", async () => {
    const w = world({ now: T0 }); seed(w, { images: [], lastPushAt: iso(T0 - 9 * DAY) });
    expect(await checkRebuild(w.deps, ids, "nightly")).toEqual({ ok: true, queued: false, why: "idle" });
    expect(await checkRebuild(w.deps, ids, "poll")).toEqual({ ok: true, queued: false, why: "idle" });
    expect(await requestReset(w.deps, ids, "person-1")).toMatchObject({ queued: true, job: { reason: "reset" } });
    const pushed = world(); seed(pushed, { images: [], lastPushAt: iso(T0 - 9 * DAY) });
    expect(await checkRebuild(pushed.deps, ids, "push")).toMatchObject({ queued: true });
  });

  it("Reset queues a rebuild even when the image is fresh and after a failure's backoff", async () => {
    const w = world(); seed(w, { images: [imageOf(dig(1))], health: "needs_repair", lastFailureAt: iso(T0 - 1000) });
    expect(await checkRebuild(w.deps, ids, "poll")).toEqual({ ok: true, queued: false, why: "backoff" });
    expect(await requestReset(w.deps, ids, "person-1")).toMatchObject({ queued: true, job: { reason: "reset" } });
    const later = world({ now: T0 + SAVED_ENV_FAILURE_BACKOFF_MS + 1 }); seed(later, { images: [imageOf(dig(1), { status: "stale" })], lastFailureAt: iso(T0) });
    expect(await checkRebuild(later.deps, ids, "poll")).toMatchObject({ queued: true });
  });

  it("a write that met another write is reported, not applied twice", async () => {
    const w = world();
    w.store.failNextCommit();
    expect(await checkRebuild(w.deps, ids, "push")).toEqual({ ok: false, reason: "stale_write" });
  });
});

describe("the job's lease is the only way to the push login and the result", () => {
  it("a lease is honoured for the right job id and token only", async () => {
    const w = world();
    await checkRebuild(w.deps, ids, "push");
    const job = w.store.rows.get("org-1#proj-1")!.job!;
    expect((await authorizeLease(w.deps, ids, { jobId: job.jobId, leaseToken: job.leaseToken })).ok).toBe(true);
    expect(await authorizeLease(w.deps, ids, { jobId: job.jobId, leaseToken: "x".repeat(job.leaseToken.length) })).toEqual({ ok: false, reason: "bad_lease" });
    expect(await authorizeLease(w.deps, ids, { jobId: "other", leaseToken: job.leaseToken })).toEqual({ ok: false, reason: "bad_lease" });
    expect(await authorizeLease(w.deps, ids, { jobId: job.jobId, leaseToken: "" })).toEqual({ ok: false, reason: "bad_lease" });
    expect(await authorizeLease(w.deps, { orgId: "org-2", projectId: "proj-1" }, { jobId: job.jobId, leaseToken: job.leaseToken })).toEqual({ ok: false, reason: "no_job" });
    w.clock.now += SAVED_ENV_JOB_LEASE_MS + 1;
    expect(await authorizeLease(w.deps, ids, { jobId: job.jobId, leaseToken: job.leaseToken })).toEqual({ ok: false, reason: "expired" });
  });
});

describe("recording a build", () => {
  const resultOf = (over: { digest?: string; manifest?: Partial<SavedEnvManifest>; ok?: boolean } = {}) => {
    const digest = over.digest ?? dig(2);
    return { ok: true, repository, tag: "k0123456789abcdef-20261102120000-01234567", imageDigest: digest, manifest: manifestOf({ imageDigest: digest, ...over.manifest }) };
  };
  async function queued(over: Parameters<typeof world>[0] = {}) {
    const w = world(over);
    await checkRebuild(w.deps, ids, "push");
    const job = w.store.rows.get("org-1#proj-1")!.job!;
    return { w, lease: { jobId: job.jobId, leaseToken: job.leaseToken } };
  }

  it("records an image that came from the lease, is the approved revision, is the code host's default branch heads and sits in the template's repository; starts a scan", async () => {
    const { w, lease } = await queued();
    const recorded = await recordBuild(w.deps, ids, { ...lease, result: resultOf() });
    expect(recorded).toMatchObject({ ok: true, image: { digest: dig(2), status: "ready" } });
    const row = w.store.rows.get("org-1#proj-1")!;
    expect(row.images.map((image) => image.digest)).toEqual([dig(2)]);
    expect(row.job).toBeUndefined();
    expect(row.health).toBe("healthy");
    expect(w.calls.scans).toEqual([dig(2)]);
    expect(w.calls.repositories).toContain(repository);
  });

  it("refuses a result from anyone without the lease", async () => {
    const { w, lease } = await queued();
    expect(await recordBuild(w.deps, ids, { jobId: lease.jobId, leaseToken: "z".repeat(48), result: resultOf() })).toEqual({ ok: false, reason: "bad_lease" });
    expect(w.store.rows.get("org-1#proj-1")!.images).toEqual([]);
  });

  it("records against the commits the JOB was given, not the heads at record time: a repository that moved while the build ran still records", async () => {
    const { w, lease } = await queued();
    // the branch moves on after the job was queued
    w.deps.defaultHeads = async () => new Map([["svc", "e".repeat(40)]]);
    expect((await recordBuild(w.deps, ids, { ...lease, result: resultOf() })).ok).toBe(true);
    expect(w.store.rows.get("org-1#proj-1")!.job).toBeUndefined();
  });

  it("refuses a manifest whose commits are not exactly the job's: another commit, a missing repository, an extra one; and a job is not queued without heads", async () => {
    const cases: Array<[string, Partial<SavedEnvManifest>]> = [
      ["other commit", { commits: [{ repositoryId: "svc", sha: "e".repeat(40) }] }],
      ["extra", { commits: [{ repositoryId: "svc", sha: COMMIT }, { repositoryId: "other", sha: COMMIT }] }],
      ["renamed", { commits: [{ repositoryId: "other", sha: COMMIT }] }],
    ];
    for (const [name, manifest] of cases) {
      const { w, lease } = await queued();
      const refused = await recordBuild(w.deps, ids, { ...lease, result: resultOf({ manifest }) });
      expect(refused, name).toEqual({ ok: false, reason: "wrong_commits" });
      expect(w.store.rows.get("org-1#proj-1")!.images, name).toEqual([]);
    }
    for (const heads of [undefined, new Map<string, string>()]) {
      const w = world({ heads });
      expect(await checkRebuild(w.deps, ids, "push")).toEqual({ ok: true, queued: false, why: "no_heads" });
      expect(w.store.rows.get("org-1#proj-1")?.job).toBeUndefined();
    }
  });

  it("refuses a result for another repository or a manifest key the job did not expect", async () => {
    const other = savedEnvRepositoryName({ env: "test", orgId: "org-2", projectId: "proj-1" });
    const a = await queued();
    expect(await recordBuild(a.w.deps, ids, { ...a.lease, result: { ...resultOf(), repository: other } })).toEqual({ ok: false, reason: "wrong_repository" });
    const b = await queued();
    expect(await recordBuild(b.w.deps, ids, { ...b.lease, result: resultOf({ manifest: { environmentKey: "d".repeat(64) } }) })).toEqual({ ok: false, reason: "wrong_manifest" });
  });

  it("a refused result deletes the digest that was pushed and audits it; a recorded one deletes nothing", async () => {
    const { w, lease } = await queued();
    await recordBuild(w.deps, ids, { ...lease, result: resultOf({ manifest: { commits: [{ repositoryId: "svc", sha: "e".repeat(40) }] } }) });
    expect(w.calls.deleted).toEqual([[dig(2)]]);
    expect(w.store.log.some((entry) => entry.action === "images_deleted" && entry.digest === dig(2) && entry.reason === "refused_build")).toBe(true);
    expect(w.store.log.some((entry) => entry.action === "build_refused" && entry.digest === dig(2))).toBe(true);
    const ok = await queued();
    await recordBuild(ok.w.deps, ids, { ...ok.lease, result: resultOf() });
    expect(ok.w.calls.deleted).toEqual([]);
  });

  it("a write that met another write is retried while the lease is still the job's, and gives up when the lease is gone", async () => {
    const { w, lease } = await queued();
    w.store.failNextCommit();
    expect((await recordBuild(w.deps, ids, { ...lease, result: resultOf() })).ok).toBe(true);
    expect(w.store.rows.get("org-1#proj-1")!.images.map((image) => image.digest)).toEqual([dig(2)]);
    const gone = await queued();
    const real = gone.w.store.commit.bind(gone.w.store);
    let calls = 0;
    gone.w.store.commit = async (next, expected, entry) => { calls += 1; if (calls === 1) { gone.w.store.rows.set("org-1#proj-1", { ...gone.w.store.rows.get("org-1#proj-1")!, version: 99, job: undefined }); return false; } return real(next, expected, entry); };
    expect(await recordBuild(gone.w.deps, ids, { ...gone.lease, result: resultOf() })).toEqual({ ok: false, reason: "stale_write" });
  });

  it("refuses when the project's approved environment moved since the job was queued, or the manifest is for another revision or another digest", async () => {
    const { w, lease } = await queued();
    const moved = { ...w, deps: { ...w.deps, approved: async () => ({ revision: 5, digest: "9".repeat(64) }) } };
    expect(await recordBuild(moved.deps, ids, { ...lease, result: resultOf() })).toEqual({ ok: false, reason: "not_approved" });
    const second = await queued();
    expect(await recordBuild(second.w.deps, ids, { ...second.lease, result: resultOf({ manifest: { testEnvRevision: 3 } }) })).toEqual({ ok: false, reason: "wrong_manifest" });
    const third = await queued();
    expect(await recordBuild(third.w.deps, ids, { ...third.lease, result: { ...resultOf(), imageDigest: dig(7) } })).toEqual({ ok: false, reason: "wrong_manifest" });
  });

  it("refuses when the repository in the registry is not the one the template made (squatting), and records nothing", async () => {
    const { w, lease } = await queued({ state: "unusable" });
    expect(await recordBuild(w.deps, ids, { ...lease, result: resultOf() })).toEqual({ ok: false, reason: "repository_mismatch" });
    expect(w.store.rows.get("org-1#proj-1")!.images).toEqual([]);
    expect(w.store.rows.get("org-1#proj-1")!.health).toBe("needs_repair");
    const absent = await queued({ state: "absent" });
    expect(await recordBuild(absent.w.deps, ids, { ...absent.lease, result: resultOf() })).toEqual({ ok: false, reason: "repository_mismatch" });
  });

  it("a failed build is recorded as needing repair with its fixed word, and the lease is released", async () => {
    const { w, lease } = await queued();
    expect(await recordBuild(w.deps, ids, { ...lease, result: { ok: false, reason: "secrets_found" } })).toEqual({ ok: false, reason: "build_failed" });
    const row = w.store.rows.get("org-1#proj-1")!;
    expect(row).toMatchObject({ health: "needs_repair", lastFailure: "secrets_found" });
    expect(row.job).toBeUndefined();
    const again = await queued();
    expect((await reportFailure(again.w.deps, ids, { ...again.lease, reason: "push_failed; DROP" })).ok).toBe(true);
    expect(again.w.store.rows.get("org-1#proj-1")!.lastFailure).toBe("push_failed");
  });

  it("garbage in place of a result is refused", async () => {
    const { w, lease } = await queued();
    expect(await recordBuild(w.deps, ids, { ...lease, result: { ok: true, imageDigest: "latest" } })).toEqual({ ok: false, reason: "bad_result" });
  });

  it("the row keeps at most N images even when the registry cannot be walked", async () => {
    const { w, lease } = await queued({ keep: 2, registry: { list: async () => { throw new Error("denied"); } } });
    seed(w, { ...w.store.rows.get("org-1#proj-1")!, images: [imageOf(dig(3)), imageOf(dig(1))] });
    const recorded = await recordBuild(w.deps, ids, { ...lease, result: resultOf({ digest: dig(4) }) });
    expect(recorded.ok).toBe(true);
    expect(w.store.rows.get("org-1#proj-1")!.images.map((image) => image.digest)).toEqual([dig(4), dig(3)]);
  });

  it("keeps the newest N images: a fourth build drops the oldest from the row and the registry", async () => {
    const images: RegistryImage[] = [1, 2, 3].map((n) => ({ digest: dig(n), tags: ["t"], pushedAt: iso(T0 - (4 - n) * 3_600_000) }));
    const { w, lease } = await queued({ images: [...images, { digest: dig(4), tags: ["t"], pushedAt: iso(T0) }] });
    seed(w, { ...w.store.rows.get("org-1#proj-1")!, images: images.map((i) => imageOf(i.digest)).reverse() });
    // the seeded row keeps the job
    const recorded = await recordBuild(w.deps, ids, { ...lease, result: resultOf({ digest: dig(4) }) });
    expect(recorded.ok).toBe(true);
    expect(w.store.rows.get("org-1#proj-1")!.images.map((image) => image.digest)).toEqual([dig(4), dig(3), dig(2)]);
    expect(w.calls.deleted).toEqual([[dig(1)]]);
  });
});

describe("the manage walk: the row decides what stays", () => {
  const recent = { recordedAt: iso(T0 - 3 * DAY) };

  it("keeps exactly the images the row names; deletes every other digest past the grace, those past the 30 day ceiling and untagged ones older than a day; drops what the registry no longer holds", async () => {
    const listed: RegistryImage[] = [
      { digest: dig(1), tags: ["a"], pushedAt: iso(T0 - 1 * 3_600_000) },
      { digest: dig(2), tags: ["a"], pushedAt: iso(T0 - 2 * DAY) },
      { digest: dig(3), tags: ["a"], pushedAt: iso(T0 - 31 * DAY) },
      { digest: dig(4), tags: [], pushedAt: iso(T0 - 2 * DAY) },
      { digest: dig(5), tags: ["a"], pushedAt: iso(T0 - 3 * DAY) },
      { digest: dig(6), tags: ["a"], pushedAt: iso(T0 - 4 * DAY) },
    ];
    const w = world({ images: listed, keep: 3 });
    seed(w, { images: [imageOf(dig(1), recent), imageOf(dig(2), recent), imageOf(dig(3), recent), imageOf(dig(9), recent)], health: "healthy" });
    expect(await walk(w.deps, ids)).toEqual({ ok: true, deleted: 4 });
    expect(w.calls.deleted[0]!.sort()).toEqual([dig(3), dig(4), dig(5), dig(6)].sort());
    expect(w.store.rows.get("org-1#proj-1")!.images.map((image) => image.digest)).toEqual([dig(1), dig(2)]);
    expect(w.store.log.some((entry) => entry.action === "images_deleted" && entry.count === 4 && entry.reason === "walk")).toBe(true);
  });

  it("an unrecorded digest never evicts a recorded one: with keep 2 and three newer unrecorded digests, the two recorded images stay and the unrecorded ones go after the grace", async () => {
    const listed: RegistryImage[] = [
      { digest: dig(7), tags: ["a"], pushedAt: iso(T0 - 1 * 3_600_000) },
      { digest: dig(8), tags: ["a"], pushedAt: iso(T0 - 2 * 3_600_000) },
      { digest: dig(1), tags: ["a"], pushedAt: iso(T0 - 2 * DAY) },
      { digest: dig(2), tags: ["a"], pushedAt: iso(T0 - 3 * DAY) },
    ];
    const w = world({ images: listed, keep: 2 });
    seed(w, { images: [imageOf(dig(1), recent), imageOf(dig(2), recent)], health: "healthy" });
    await walk(w.deps, ids);
    expect(w.calls.deleted[0]!.sort()).toEqual([dig(7), dig(8)].sort());
    expect(w.store.rows.get("org-1#proj-1")!.images.map((image) => image.digest)).toEqual([dig(1), dig(2)]);
  });

  it("a digest pushed minutes ago and not yet recorded is left alone", async () => {
    const w = world({ images: [{ digest: dig(7), tags: ["a"], pushedAt: iso(T0 - 60_000) }, { digest: dig(1), tags: ["a"], pushedAt: iso(T0 - DAY) }], keep: 3 });
    seed(w, { images: [imageOf(dig(1), recent)] });
    expect(await walk(w.deps, ids)).toEqual({ ok: true, deleted: 0 });
    expect(w.calls.deleted).toEqual([]);
  });

  it("the ceiling deletes the newest image too when it is that old, and the project reads as needing repair", async () => {
    const w = world({ images: [{ digest: dig(1), tags: ["a"], pushedAt: iso(T0 - 40 * DAY) }] });
    seed(w, { images: [imageOf(dig(1), { recordedAt: iso(T0 - 40 * DAY) })], health: "healthy" });
    expect(await walk(w.deps, ids)).toEqual({ ok: true, deleted: 1 });
    expect(w.store.rows.get("org-1#proj-1")).toMatchObject({ images: [], health: "needs_repair" });
  });

  it("an image recorded minutes ago stays even if the registry's list does not show it yet; one recorded long ago does not", async () => {
    const w = world({ images: [] });
    seed(w, { images: [imageOf(dig(1), { recordedAt: iso(T0 - 60_000) }), imageOf(dig(2), { recordedAt: iso(T0 - DAY) })], health: "healthy" });
    expect(await walk(w.deps, ids)).toEqual({ ok: true, deleted: 0 });
    expect(w.store.rows.get("org-1#proj-1")!.images.map((image) => image.digest)).toEqual([dig(1)]);
  });

  it("a registry that cannot be listed changes nothing", async () => {
    const w = world({ registry: { list: async () => { throw new Error("denied"); } } });
    seed(w, { images: [imageOf(dig(1))] });
    expect(await walk(w.deps, ids)).toEqual({ ok: false, reason: "unavailable" });
    expect(w.store.rows.get("org-1#proj-1")!.images).toHaveLength(1);
  });

  it("walks with a manage session of the broker's own, naming this project's repository only", async () => {
    const w = world();
    seed(w, { images: [] });
    await walk(w.deps, ids);
    expect([...new Set(w.calls.repositories)]).toEqual([repository]);
    expect(w.logins).toEqual([]);
  });
});

describe("stale marks and what a task may use", () => {
  it("a fallback marks THAT image stale and queues a rebuild; a report about an image no longer known changes nothing", async () => {
    const w = world(); seed(w, { images: [imageOf(dig(1))], health: "healthy" });
    expect((await markStale(w.deps, ids, { digest: dig(1), step: "pull" })).ok).toBe(true);
    const row = w.store.rows.get("org-1#proj-1")!;
    expect(row.images[0]).toMatchObject({ status: "stale", staleStep: "pull" });
    expect(row.job).toMatchObject({ reason: "stale" });
    const other = world(); seed(other, { images: [imageOf(dig(1))] });
    await markStale(other.deps, ids, { digest: dig(8), step: "pull" });
    expect(other.store.rows.get("org-1#proj-1")!.images[0]!.status).toBe("ready");
  });

  it("a task may use the newest ready image built for its own approved environment (revision AND digest), in a live project, not a stale one or one far past the max age", () => {
    const state: SavedEnvState = { orgId: "org-1", projectId: "proj-1", version: 1, enabled: true, images: [imageOf(dig(1))], health: "healthy" };
    expect(imageForTask(state, APPROVED, T0)).toEqual({ digest: dig(1), environmentKey: KEY, testEnvRevision: 4 });
    expect(imageForTask(state, { ...APPROVED, revision: 5 }, T0)).toBeUndefined();
    expect(imageForTask(state, { ...APPROVED, digest: "b".repeat(64) }, T0)).toBeUndefined();
    expect(imageForTask({ ...state, images: [imageOf(dig(1), { approved: { ...APPROVED, digest: "c".repeat(64) } })] }, APPROVED, T0)).toBeUndefined();
    expect(imageForTask({ ...state, images: [imageOf(dig(1), { status: "stale" })] }, APPROVED, T0)).toBeUndefined();
    expect(imageForTask(state, APPROVED, T0 + 9 * DAY)).toBeUndefined();
    expect(imageForTask({ ...state, enabled: false }, APPROVED, T0)).toBeUndefined();
    expect(imageForTask({ ...state, deleted: true }, APPROVED, T0)).toBeUndefined();
    expect(imageForTask({ ...state, archived: true }, APPROVED, T0)).toBeUndefined();
    expect(imageForTask({ ...state, images: [] }, APPROVED, T0)).toBeUndefined();
    expect(imageForTask(undefined, APPROVED, T0)).toBeUndefined();
  });
});

describe("archive and delete", () => {
  it("an archived project keeps its images, queues no rebuild and the reason is recorded", async () => {
    expect(ARCHIVE_POLICY).toContain("keeps its saved images");
    const w = world(); seed(w, { images: [imageOf(dig(1), { status: "stale" })], job: { jobId: "j", leaseToken: "t", reason: "stale", approved: APPROVED, commits: { svc: COMMIT }, expectedKey: KEY, createdAt: iso(T0), leaseUntil: iso(T0 + 1000) } });
    expect((await onProjectArchived(w.deps, ids, true)).ok).toBe(true);
    const row = w.store.rows.get("org-1#proj-1")!;
    expect(row.images).toHaveLength(1);
    expect(row.job).toBeUndefined();
    expect(await checkRebuild(w.deps, ids, "push")).toEqual({ ok: true, queued: false, why: "archived" });
    expect(w.calls.deleted).toEqual([]);
    await onProjectArchived(w.deps, ids, false);
    expect(w.store.rows.get("org-1#proj-1")!.archived).toBe(false);
  });

  it("archiving a project with no row yet writes archived all the same, so no build starts for it", async () => {
    const w = world();
    expect((await onProjectArchived(w.deps, ids, true)).ok).toBe(true);
    expect(w.store.rows.get("org-1#proj-1")).toMatchObject({ archived: true, images: [] });
    expect(await checkRebuild(w.deps, ids, "push")).toEqual({ ok: true, queued: false, why: "archived" });
  });

  it("a deleted project is marked deleted FIRST (no job, no login, no record can follow), then loses its repository with its images, with a manage session on that repository only", async () => {
    const listed: RegistryImage[] = [{ digest: dig(1), tags: ["a"], pushedAt: iso(T0) }, { digest: dig(2), tags: [], pushedAt: iso(T0) }];
    const order: string[] = [];
    const w = world({ images: listed, registry: { deleteRepository: async () => { order.push(`repository deleted; row deleted=${String(w.store.rows.get("org-1#proj-1")?.deleted)}`); return "deleted" as const; } } });
    seed(w, { images: [imageOf(dig(1))], health: "healthy", job: { jobId: "j", leaseToken: "t", reason: "stale", approved: APPROVED, commits: { svc: COMMIT }, expectedKey: KEY, createdAt: iso(T0), leaseUntil: iso(T0 + SAVED_ENV_JOB_LEASE_MS) } });
    expect(await onProjectDeleted(w.deps, ids)).toEqual({ ok: true, deleted: 2 });
    expect(order).toEqual(["repository deleted; row deleted=true"]);
    expect(w.calls.deleted).toEqual([]);
    expect([...new Set(w.calls.repositories)]).toEqual([repository]);
    expect(w.store.rows.get("org-1#proj-1")).toMatchObject({ images: [], deleted: true });
    expect(w.store.rows.get("org-1#proj-1")!.job).toBeUndefined();
    expect(await checkRebuild(w.deps, ids, "push")).toEqual({ ok: true, queued: false, why: "archived" });
    expect(w.store.log.some((entry) => entry.action === "project_deleted")).toBe(true);
    expect(w.store.log.some((entry) => entry.action === "images_deleted" && entry.count === 2)).toBe(true);
  });

  it("a repository that does not exist counts as done; a project with no row is marked deleted and audited too", async () => {
    const w = world({ registry: { list: async () => "absent" } });
    expect(await onProjectDeleted(w.deps, ids)).toEqual({ ok: true, deleted: 0 });
    expect(w.store.rows.get("org-1#proj-1")).toMatchObject({ deleted: true });
    expect(w.store.log.filter((entry) => entry.action === "project_deleted")).toHaveLength(1);
  });

  it("a write that met another write is retried, and a row that cannot be marked deleted stops before the registry is touched", async () => {
    const w = world({ images: [] });
    w.store.failNextCommit();
    expect((await onProjectDeleted(w.deps, ids)).ok).toBe(true);
    const stuck = world({ images: [] });
    stuck.store.commit = async () => false;
    expect(await onProjectDeleted(stuck.deps, ids)).toEqual({ ok: false, reason: "stale_write" });
    expect(stuck.calls.reached).toBe(0);
  });

  it("a registry that cannot be reached leaves the row DELETED (nothing can be built for it) and says so, so the caller retries the registry part", async () => {
    const w = world({ registry: { deleteRepository: async () => { throw new Error("denied"); } }, images: [{ digest: dig(1), tags: ["a"], pushedAt: iso(T0) }] });
    seed(w, { images: [imageOf(dig(1))] });
    expect(await onProjectDeleted(w.deps, ids)).toEqual({ ok: false, reason: "unavailable" });
    expect(w.store.rows.get("org-1#proj-1")!.deleted).toBe(true);
  });
});

describe("the push login belongs to the job's lease (mintPushForJob) and the token goes to the dispatcher once", () => {
  it("mints for the JOB'S approved pin with a valid lease, and refuses a bad, expired or missing lease", async () => {
    const w = world();
    await checkRebuild(w.deps, ids, "push");
    const job = w.store.rows.get("org-1#proj-1")!.job!;
    const minted = await mintPushForJob(w.deps, ids, { jobId: job.jobId, leaseToken: job.leaseToken });
    expect(minted.ok).toBe(true);
    expect(w.logins.map((login) => login.access)).toEqual(["push"]);
    expect(w.logins[0]!.repository).toBe(repository);
    expect(await mintPushForJob(w.deps, ids, { jobId: job.jobId, leaseToken: "x".repeat(job.leaseToken.length) })).toEqual({ ok: false, reason: "bad_lease" });
    expect(await mintPushForJob(w.deps, { orgId: "org-2", projectId: "proj-1" }, { jobId: job.jobId, leaseToken: job.leaseToken })).toEqual({ ok: false, reason: "no_job" });
    w.clock.now += SAVED_ENV_JOB_LEASE_MS + 1;
    expect(await mintPushForJob(w.deps, ids, { jobId: job.jobId, leaseToken: job.leaseToken })).toEqual({ ok: false, reason: "expired" });
  });

  it("a deleted, archived or turned-off project's lease is refused (inactive), and every refusal is audited", async () => {
    for (const change of [{ deleted: true }, { archived: true }, { enabled: false }] as const) {
      const w = world();
      await checkRebuild(w.deps, ids, "push");
      const row = w.store.rows.get("org-1#proj-1")!;
      w.store.rows.set("org-1#proj-1", { ...row, ...change });
      expect(await mintPushForJob(w.deps, ids, { jobId: row.job!.jobId, leaseToken: row.job!.leaseToken })).toEqual({ ok: false, reason: "inactive" });
      expect(w.store.log.some((entry) => entry.action === "lease_refused" && entry.reason === "inactive")).toBe(true);
      expect(w.calls.reached).toBe(0);
    }
  });

  it("checkRebuild never returns the lease token; the dispatcher takes it once, and a second take gets nothing", async () => {
    const w = world();
    const queued = await checkRebuild(w.deps, ids, "push");
    expect(JSON.stringify(queued)).not.toContain(w.store.rows.get("org-1#proj-1")!.job!.leaseToken);
    const first = await leaseForDispatch(w.deps, ids);
    expect(first).toMatchObject({ ok: true, job: { reason: "no_image", commits: { svc: COMMIT } } });
    if (first.ok) expect(first.job.leaseToken).toBe(w.store.rows.get("org-1#proj-1")!.job!.leaseToken);
    expect(await leaseForDispatch(w.deps, ids)).toEqual({ ok: false, reason: "nothing_to_dispatch" });
    expect(await leaseForDispatch(world().deps, ids)).toEqual({ ok: false, reason: "nothing_to_dispatch" });
  });

  it("only saved-env.ts uses the raw mintPushSession (routes call mintPushForJob)", () => {
    const root = join(import.meta.dirname, "..", "..", "packages", "core", "src");
    const users: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts") && /\bmintPushSession\b/u.test(readFileSync(full, "utf8"))) users.push(full.slice(root.length + 1));
      }
    };
    walk(root);
    expect(users.sort()).toEqual(["core/test-env/saved-env-session.ts", "core/test-env/saved-env.ts"]);
  });
});

describe("audit", () => {
  it("a scan start, a Reset (with who asked) and a failed lease are audited", async () => {
    const w = world();
    await requestReset(w.deps, ids, "person-7");
    expect(w.store.log.find((entry) => entry.action === "reset_requested")).toMatchObject({ actor: "person-7" });
    const job = w.store.rows.get("org-1#proj-1")!.job!;
    await authorizeLease(w.deps, ids, { jobId: job.jobId, leaseToken: "z".repeat(48) });
    expect(w.store.log.some((entry) => entry.action === "lease_refused" && entry.reason === "bad_lease")).toBe(true);
    const done = world();
    await checkRebuild(done.deps, ids, "push");
    const lease = done.store.rows.get("org-1#proj-1")!.job!;
    await recordBuild(done.deps, ids, { jobId: lease.jobId, leaseToken: lease.leaseToken, result: { ok: true, repository, tag: "k0123456789abcdef-20261102120000-01234567", imageDigest: dig(2), manifest: manifestOf({ imageDigest: dig(2) }) } });
    expect(done.store.log.some((entry) => entry.action === "scan_started" && entry.digest === dig(2))).toBe(true);
  });
});

describe("tenancy", () => {
  it("one org's project row is never read for another's, and the repository named in a session is that project's", async () => {
    const w = world();
    seed(w, { images: [imageOf(dig(1))] });
    expect(await w.deps.store.get("org-2", "proj-1")).toBeUndefined();
    expect(imageForTask(await w.deps.store.get("org-2", "proj-1"), APPROVED, T0)).toBeUndefined();
    await walk(w.deps, { orgId: "org-2", projectId: "proj-1" });
    expect(w.calls.reached).toBe(0);
  });
});

describe("what a preparation is told", () => {
  it("an image for the task's own approved environment gives a schema-valid savedEnv with a pull login for that one repository; the task counts as activity", async () => {
    const w = world(); seed(w, { images: [imageOf(dig(1))], health: "healthy" });
    const told = await savedEnvForPrepare(w.deps, ids, APPROVED);
    expect(PrepareSavedEnvSchema.safeParse(told.savedEnv).success).toBe(true);
    expect(told.savedEnv).toEqual({ repository, digest: dig(1), testEnvRevision: 4, environmentKey: KEY, taskTestEnvRevision: 4 });
    // a REFERENCE only: no login is minted for an invocation that is stored (the worker asks at pull time)
    expect(JSON.stringify(told)).not.toMatch(/password|username|auth/u);
    expect(w.calls.reached).toBe(0);
    expect(w.store.rows.get("org-1#proj-1")!.lastTaskAt).toBe(iso(T0));
  });

  it("a task's check (activity, a possible rebuild) is made at most once per ten minutes: a retried preparation does not repeat it", async () => {
    const w = world(); seed(w, { images: [imageOf(dig(1))], health: "healthy" });
    let keyReads = 0;
    w.deps.currentKey = async () => { keyReads += 1; return KEY; };
    await savedEnvForPrepare(w.deps, ids, APPROVED);
    await savedEnvForPrepare(w.deps, ids, APPROVED);
    await savedEnvForPrepare(w.deps, ids, APPROVED);
    expect(keyReads).toBe(1);
    w.clock.now += SAVED_ENV_TASK_CHECK_MS + 1;
    await savedEnvForPrepare(w.deps, ids, APPROVED);
    expect(keyReads).toBe(2);
  });

  it("nothing (the task sets up fresh) when the switch is off, there is no image, the image is stale, built for another approved environment, or the project is archived", async () => {
    const off = world({ enabled: false }); seed(off, { images: [imageOf(dig(1))] });
    expect(await savedEnvForPrepare(off.deps, ids, APPROVED)).toEqual({});
    expect(off.calls.reached).toBe(0);
    const none = world();
    expect(await savedEnvForPrepare(none.deps, ids, APPROVED)).toEqual({});
    const stale = world(); seed(stale, { images: [imageOf(dig(1), { status: "stale" })] });
    expect(await savedEnvForPrepare(stale.deps, ids, APPROVED)).toEqual({});
    const other = world(); seed(other, { images: [imageOf(dig(1))] });
    expect(await savedEnvForPrepare(other.deps, ids, { revision: 5, digest: "9".repeat(64) })).toEqual({});
    const archived = world(); seed(archived, { images: [imageOf(dig(1))], archived: true });
    expect(await savedEnvForPrepare(archived.deps, ids, APPROVED)).toEqual({});
  });

  it("nothing when anything throws; never an error", async () => {
    const broken = world(); seed(broken, { images: [imageOf(dig(1))] });
    broken.deps.store.get = async () => { throw new Error("table unavailable"); };
    expect(await savedEnvForPrepare(broken.deps, ids, APPROVED)).toEqual({});
  });
});

describe("the pull login: minted at pull time for the image the operation was told to pull", () => {
  it("gives a one-repository, pull-role login for a ready image of the row, and mints nothing else", async () => {
    const w = world(); seed(w, { images: [imageOf(dig(1))], health: "healthy" });
    const login = await savedEnvPullLogin(w.deps, ids, dig(1));
    expect(login.ok).toBe(true);
    expect(login.ok && login.auth).toMatchObject({ repository, username: "rovara-local" });
    expect(w.logins.map((login) => login.access)).toEqual(["pull"]);
    expect(w.logins[0]!.repository).toBe(repository);
  });

  it("an older image that is still in the row and ready can be pulled by the operation that was told to; one the row does not name, or a stale one, cannot", async () => {
    const w = world(); seed(w, { images: [imageOf(dig(2)), imageOf(dig(1))] });
    expect((await savedEnvPullLogin(w.deps, ids, dig(1))).ok).toBe(true);
    expect(await savedEnvPullLogin(w.deps, ids, dig(7))).toEqual({ ok: false, reason: "no_image" });
    const stale = world(); seed(stale, { images: [imageOf(dig(1), { status: "stale" })] });
    expect(await savedEnvPullLogin(stale.deps, ids, dig(1))).toEqual({ ok: false, reason: "no_image" });
    expect(stale.calls.reached).toBe(0);
  });

  it("no login for an archived, deleted or turned-off project, or an image far past the max age", async () => {
    for (const over of [{ archived: true }, { deleted: true }, { enabled: false }] as Array<Partial<SavedEnvState>>) {
      const w = world(); seed(w, { images: [imageOf(dig(1))], ...over });
      expect(await savedEnvPullLogin(w.deps, ids, dig(1))).toEqual({ ok: false, reason: "no_image" });
      expect(w.calls.reached).toBe(0);
    }
    const old = world(); seed(old, { images: [imageOf(dig(1), { recordedAt: iso(T0 - 9 * 86_400_000) })] });
    expect(await savedEnvPullLogin(old.deps, ids, dig(1))).toEqual({ ok: false, reason: "no_image" });
  });

  it("no login when the repository is not the template's (squatting) or the project's approved environment moved since the image was built", async () => {
    const squat = world({ state: "unusable" }); seed(squat, { images: [imageOf(dig(1))] });
    expect(await savedEnvPullLogin(squat.deps, ids, dig(1))).toEqual({ ok: false, reason: "unavailable" });
    const moved = world({ approved: { revision: 5, digest: "9".repeat(64) } }); seed(moved, { images: [imageOf(dig(1))] });
    expect(await savedEnvPullLogin(moved.deps, ids, dig(1))).toEqual({ ok: false, reason: "unavailable" });
  });
});

const lateResult = (digest: string) => ({ ok: true, repository, tag: "k0123456789abcdef-20261102120000-01234567", imageDigest: digest, manifest: manifestOf({ imageDigest: digest }) });

describe("rules on the row, the walk and the lease", () => {
  it("a job is never queued without a key (no_key), a Reset included; the Reset stays asked for", async () => {
    const w = world({ key: undefined });
    expect(await checkRebuild(w.deps, ids, "push")).toMatchObject({ ok: true, queued: false, why: "no_key" });
    expect(await requestReset(w.deps, ids, "person-1")).toMatchObject({ ok: true, queued: false, why: "no_key" });
    expect(w.store.rows.get("org-1#proj-1")!.job).toBeUndefined();
    expect(w.store.rows.get("org-1#proj-1")!.resetRequested).toBe(true);
  });

  it("the walk keeps unnamed digests while a job's lease is live (a build may have pushed but not reported), and deletes them once the lease has lapsed", async () => {
    const pushed = { digest: dig(5), tags: ["t"], pushedAt: iso(T0 - 3_600_000) };
    const w = world({ images: [pushed] }); seed(w, { images: [], job: { jobId: "j", leaseToken: "l", reason: "no_image", approved: APPROVED, commits: { svc: COMMIT }, expectedKey: KEY, createdAt: iso(T0 - 3_600_000), leaseUntil: iso(T0 + 3_600_000), dispatchedAt: iso(T0 - 3_000_000) } });
    await walk(w.deps, ids);
    expect(w.calls.deleted).toEqual([]);
    w.clock.now = T0 + 4 * 3_600_000;
    await walk(w.deps, ids);
    expect(w.calls.deleted).toEqual([[dig(5)]]);
  });

  it("a result that arrives after the project was deleted runs the repository deletion again; it never leaves the pushed image", async () => {
    const w = world({ images: [{ digest: dig(5), tags: ["t"], pushedAt: iso(T0) }] });
    await onProjectDeleted(w.deps, ids);
    const before = w.calls.repoDeleted;
    const late = await recordBuild(w.deps, ids, { jobId: "j", leaseToken: "l", result: lateResult(dig(5)) });
    expect(late).toMatchObject({ ok: false, reason: "no_job" });
    expect(w.calls.repoDeleted).toBe(before + 1);
  });

  it("a result with a bad lease deletes nothing (the caller proved nothing)", async () => {
    const w = world({ images: [{ digest: dig(5), tags: ["t"], pushedAt: iso(T0) }] }); seed(w, { images: [imageOf(dig(1))], job: { jobId: "j", leaseToken: "l", reason: "no_image", approved: APPROVED, commits: { svc: COMMIT }, expectedKey: KEY, createdAt: iso(T0), leaseUntil: iso(T0 + 3_600_000) } });
    await recordBuild(w.deps, ids, { jobId: "j", leaseToken: "wrong", result: lateResult(dig(1)) });
    await recordBuild(w.deps, { orgId: "org-1", projectId: "nobody" }, { jobId: "j", leaseToken: "l", result: lateResult(dig(1)) });
    expect(w.calls.deleted).toEqual([]);
    expect(w.calls.repoDeleted).toBe(0);
  });

  it("a valid lease on a project turned off deletes the pushed digest", async () => {
    const w = world(); seed(w, { enabled: false, images: [], job: { jobId: "j", leaseToken: "l", reason: "no_image", approved: APPROVED, commits: { svc: COMMIT }, expectedKey: KEY, createdAt: iso(T0), leaseUntil: iso(T0 + 3_600_000) } });
    const late = await recordBuild(w.deps, ids, { jobId: "j", leaseToken: "l", result: lateResult(dig(5)) });
    expect(late).toMatchObject({ ok: false, reason: "inactive" });
    expect(w.calls.deleted).toEqual([[dig(5)]]);
  });

  it("the nightly sweep runs the registry deletion for a deleted project until a deletion finished AFTER the delete plus a job's lease, and then leaves it alone", async () => {
    const w = world();
    // deleted now, deletion done now: not final yet (a build in flight could still push)
    await onProjectDeleted(w.deps, ids);
    const row = () => w.store.rows.get("org-1#proj-1")!;
    expect(row().registryPurgedAt).toBe(iso(T0));
    expect(await sweepDeleted(w.deps)).toEqual({ ok: true, swept: 1, failed: 0 });
    // a sweep a lease later is final
    w.clock.now = T0 + SAVED_ENV_JOB_LEASE_MS + 1;
    expect(await sweepDeleted(w.deps)).toEqual({ ok: true, swept: 1, failed: 0 });
    expect(Date.parse(row().registryPurgedAt!)).toBeGreaterThanOrEqual(Date.parse(row().deletedAt!) + SAVED_ENV_JOB_LEASE_MS);
    const repeated = w.calls.repoDeleted;
    expect(await sweepDeleted(w.deps)).toEqual({ ok: true, swept: 0, failed: 0 });
    expect(w.calls.repoDeleted).toBe(repeated);
  });

  it("a deleted project whose registry could not be reached is swept until it can, however old", async () => {
    const down = world({ registry: { async list() { throw new Error("ecr down"); } } });
    expect(await onProjectDeleted(down.deps, ids)).toEqual({ ok: false, reason: "unavailable" });
    expect(down.store.rows.get("org-1#proj-1")!.registryPurgedAt).toBeUndefined();
    down.clock.now = T0 + 90 * 86_400_000;
    expect(await sweepDeleted(down.deps)).toEqual({ ok: true, swept: 0, failed: 1 });
    const up = world(); seed(up, { deleted: true, deletedAt: iso(T0 - 90 * 86_400_000) });
    expect(await sweepDeleted(up.deps)).toEqual({ ok: true, swept: 1, failed: 0 });
    expect(up.store.rows.get("org-1#proj-1")!.registryPurgedAt).toBe(iso(T0));
  });

  it("the nightly walk of a deleted project deletes its repository whole, and records it", async () => {
    const w = world({ images: [{ digest: dig(5), tags: ["t"], pushedAt: iso(T0) }] }); seed(w, { deleted: true, deletedAt: iso(T0 - 1000) });
    expect(await walk(w.deps, ids)).toEqual({ ok: true, deleted: 1 });
    expect(w.calls.repoDeleted).toBe(1);
    expect(w.calls.deleted).toEqual([]);
    expect(w.store.rows.get("org-1#proj-1")!.registryPurgedAt).toBe(iso(T0));
  });

  it("a project registered again under a deleted name starts over; a live project's row is not touched", async () => {
    const w = world(); seed(w, { deleted: true, deletedAt: iso(T0 - 1000), registryPurgedAt: iso(T0 - 500), images: [], archived: true, resetRequested: true, lastResetAt: iso(T0 - 5000) });
    expect(await onProjectRegistered(w.deps, ids)).toEqual({ ok: true });
    const row = w.store.rows.get("org-1#proj-1")!;
    expect(row).toMatchObject({ enabled: true, images: [], health: "never_proved" });
    expect(row.deleted).toBeUndefined();
    expect(row.archived).toBeUndefined();
    expect(row.resetRequested).toBeUndefined();
    expect(row.lastResetAt).toBeUndefined();
    expect(row.registryPurgedAt).toBeUndefined();
    expect(await checkRebuild(w.deps, ids, "push")).toMatchObject({ ok: true, queued: true });
    expect(w.store.log.some((entry) => entry.action === "project_registered")).toBe(true);
    const live = world(); seed(live, { images: [imageOf(dig(1))] });
    const before = structuredClone(live.store.rows.get("org-1#proj-1"));
    expect(await onProjectRegistered(live.deps, ids)).toEqual({ ok: true });
    expect(live.store.rows.get("org-1#proj-1")).toEqual(before);
    // with the switch off the mark is cleared all the same
    const off = world({ enabled: false }); seed(off, { deleted: true });
    await onProjectRegistered(off.deps, ids);
    expect(off.store.rows.get("org-1#proj-1")!.deleted).toBeUndefined();
  });
  it("a registration retried after a lost write clears the mark", async () => {
    const w = world(); seed(w, { deleted: true });
    w.store.failNextCommit();
    expect(await onProjectRegistered(w.deps, ids)).toEqual({ ok: true });
    expect(w.store.rows.get("org-1#proj-1")!.deleted).toBeUndefined();
  });
});

describe("the stored invocation holds no credential", () => {
  const PASSWORD = "p".repeat(30);
  const COMPANY = "org_aaaaaaaaaaaaaaaaaaaa";
  const hooksOf = (w: World, env: string) => installSavedEnv(w.deps, { ROVARA_SAVED_ENVIRONMENTS: env });

  it("a preparation with the task's pin is told the image by reference, and holds no password, username or login anywhere", async () => {
    const w = world(); seed(w, { images: [imageOf(dig(1))], health: "healthy" });
    const prepared = await savedEnvPrepareOf(hooksOf(w, "1"), { name: "proj-1" }, { orgId: "org-1", testEnvPin: APPROVED });
    const text = JSON.stringify(prepared);
    expect(prepared.savedEnv).toMatchObject({ repository, digest: dig(1), taskTestEnvRevision: APPROVED.revision });
    expect(PrepareSavedEnvSchema.safeParse(prepared.savedEnv).success).toBe(true);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toMatch(/"(password|username|auth|authorizationToken)"/u);
    expect(w.logins).toEqual([]);
    void COMPANY;
  });

  it("no pin (a thread workspace, a registration), a setup draft, a read-only run, no company or the switch off: nothing is sent", async () => {
    for (const [env, options] of [["1", {}], ["1", { testEnvPin: APPROVED, setupDraft: true }], ["1", { testEnvPin: APPROVED, readOnly: true }], ["1", { testEnvPin: APPROVED, orgId: undefined }], ["0", { testEnvPin: APPROVED }]] as const) {
      const w = world(); seed(w, { images: [imageOf(dig(1))], health: "healthy" });
      const hooks = hooksOf(w, env);
      expect(await savedEnvPrepareOf(hooks, { name: "proj-1" }, { orgId: "org-1", ...options })).toEqual({});
      if (env === "0") expect(hooks).toBeUndefined();
    }
    expect(await savedEnvPrepareOf(undefined, { name: "proj-1" }, { orgId: "org-1", testEnvPin: APPROVED })).toEqual({});
  });

  it("a registry a worker cannot pull from names no image (the task sets up fresh), and a failing registry hook never fails the preparation", async () => {
    const w = world({ capabilities: { workerPull: false } }); seed(w, { images: [imageOf(dig(1))], health: "healthy" });
    expect(await savedEnvPrepareOf(hooksOf(w, "1"), { name: "proj-1" }, { orgId: "org-1", testEnvPin: APPROVED })).toEqual({});
    const hooks = { savedEnvPrepare: async () => { throw new Error("down"); } };
    expect(await savedEnvPrepareOf(hooks, { name: "proj-1" }, { orgId: "org-1", testEnvPin: APPROVED })).toEqual({});
  });

  it("the pull login hook gives a login for a ready image of the row and nothing for any other digest", async () => {
    const w = world(); seed(w, { images: [imageOf(dig(1))], health: "healthy" });
    const hooks = hooksOf(w, "1")!;
    expect(await hooks.savedEnvLogin({ orgId: "org-1", projectName: "proj-1", digest: dig(1) })).toMatchObject({ repository });
    expect(await hooks.savedEnvLogin({ orgId: "org-1", projectName: "proj-1", digest: dig(9) })).toBeUndefined();
  });
});

describe("the Environment panel", () => {
  it("shows health, the saved copy's age and the reason of the last rebuild, as fixed words and numbers only", () => {
    const state = { orgId: "org-1", projectId: "proj-1", version: 1, enabled: true, images: [imageOf(dig(1), { recordedAt: iso(T0 - 3 * 86_400_000 - 1000) })], health: "healthy" as const, lastRebuildReason: "key_changed" as const };
    const view = panelView(state, T0, "maintainer");
    expect(SavedEnvPanelSchema.safeParse(view).success).toBe(true);
    expect(view).toEqual({ health: "healthy", image: { builtAt: iso(T0 - 3 * 86_400_000 - 1000), ageDays: 3, status: "ready" }, lastRebuildReason: "key_changed", canReset: true, enabled: true, canChangeSetting: true });
    expect(JSON.stringify(view)).not.toContain(dig(1));
    expect(JSON.stringify(view)).not.toContain(repository);
    expect(panelView(undefined, T0, "maintainer")).toEqual({ health: "never_proved", canReset: true, enabled: true, canChangeSetting: true });
  });

  it("says a queued job is waiting, a dispatched one is running, and an expired lease is neither", () => {
    const job = { jobId: "j", leaseToken: "l", reason: "stale" as const, approved: APPROVED, commits: { svc: COMMIT }, expectedKey: KEY, createdAt: iso(T0), leaseUntil: iso(T0 + 3_600_000) };
    const base = { orgId: "org-1", projectId: "proj-1", version: 1, enabled: true, images: [], health: "needs_repair" as const };
    expect(panelView({ ...base, job }, T0, "viewer").rebuild).toEqual({ state: "queued", reason: "stale" });
    expect(panelView({ ...base, job: { ...job, dispatchedAt: iso(T0) } }, T0, "viewer").rebuild).toEqual({ state: "running", reason: "stale" });
    expect(panelView({ ...base, job: { ...job, leaseUntil: iso(T0 - 1) } }, T0, "viewer").rebuild).toBeUndefined();
    expect(panelView({ ...base, resetRequested: true }, T0, "viewer").rebuild).toEqual({ state: "queued", reason: "reset" });
  });

  it("carries the last failure as a fixed word only", () => {
    const base = { orgId: "org-1", projectId: "proj-1", version: 1, enabled: true, images: [], health: "needs_repair" as const };
    expect(panelView({ ...base, lastFailure: "secrets_found", lastFailureAt: iso(T0) }, T0, "viewer").lastFailure).toEqual({ at: iso(T0), reason: "secrets_found" });
    // anything outside the fixed words is "failed": a builder's or a person's text never reaches the page
    for (const text of ["Boom: <b>x</b> 123", "disk full at /srv/build", "", "secrets_found_extra"]) expect(panelView({ ...base, lastFailure: text, lastFailureAt: iso(T0) }, T0, "viewer").lastFailure?.reason, text).toBe("failed");
    expect(panelView({ ...base, lastFailure: "wrong_commits", lastFailureAt: iso(T0) }, T0, "viewer").lastFailure?.reason).toBe("wrong_commits");
  });

  it("only a maintainer of a live project can reset", () => {
    const state = { orgId: "org-1", projectId: "proj-1", version: 1, enabled: true, images: [], health: "never_proved" as const };
    expect(panelView(state, T0, "maintainer").canReset).toBe(true);
    expect(panelView(state, T0, "contributor").canReset).toBe(false);
    expect(panelView(state, T0, "viewer").canReset).toBe(false);
    expect(panelView({ ...state, archived: true }, T0, "maintainer").canReset).toBe(false);
  });

  it("says whether the project's setting is on, and offers its control to a maintainer only (SV-1l)", () => {
    const state = { orgId: "org-1", projectId: "proj-1", version: 1, enabled: true, images: [], health: "healthy" as const };
    expect(panelView(state, T0, "viewer").enabled).toBe(true);
    expect(panelView({ ...state, enabled: false }, T0, "viewer").enabled).toBe(false);
    // no row yet: on, as the setting route reads it
    expect(panelView(undefined, T0, "viewer").enabled).toBe(true);
    expect(panelView(state, T0, "maintainer").canChangeSetting).toBe(true);
    expect(panelView(state, T0, "contributor").canChangeSetting).toBe(false);
    expect(panelView(state, T0, "viewer").canChangeSetting).toBe(false);
    expect(SavedEnvPanelSchema.safeParse(panelView({ ...state, enabled: false }, T0, "contributor")).success).toBe(true);
  });

  it("the panel does not exist with the switch off", async () => {
    expect(await savedEnvPanel(world({ enabled: false }).deps, ids, { projectRole: "maintainer" })).toEqual({ ok: false, reason: "disabled" });
    expect((await savedEnvPanel(world().deps, ids, { projectRole: "viewer" })).ok).toBe(true);
  });

  it("a maintainer's Reset queues a rebuild and the answer is the new panel; the person is in the audit entry", async () => {
    const w = world(); seed(w, { images: [imageOf(dig(1))], health: "healthy" });
    const done = await resetFromPanel(w.deps, ids, { actorId: "person-1", projectRole: "maintainer", requestId: "request-0001" });
    expect(done).toMatchObject({ ok: true, status: "queued", panel: { rebuild: { state: "queued", reason: "reset" }, lastRebuildReason: "reset", canReset: true } });
    expect(w.store.log.some((entry) => entry.action === "reset_requested" && entry.actor === "person-1")).toBe(true);
  });

  it("a contributor or viewer cannot reset: nothing is written or audited", async () => {
    for (const projectRole of ["contributor", "viewer"] as const) {
      const w = world(); seed(w, { images: [imageOf(dig(1))], health: "healthy" });
      const before = structuredClone(w.store.rows.get("org-1#proj-1"));
      expect(await resetFromPanel(w.deps, ids, { actorId: "person-1", projectRole, requestId: "request-0001" })).toEqual({ ok: false, reason: "not_maintainer" });
      expect(w.store.rows.get("org-1#proj-1")).toEqual(before);
      expect(w.store.log).toEqual([]);
    }
    expect(await resetFromPanel(world({ enabled: false }).deps, ids, { actorId: "person-1", projectRole: "maintainer", requestId: "request-0001" })).toEqual({ ok: false, reason: "disabled" });
  });

  it("a Reset with nothing to build from says so", async () => {
    const w = world({ approved: undefined }); seed(w, { images: [] });
    expect(await resetFromPanel(w.deps, ids, { actorId: "person-1", projectRole: "maintainer", requestId: "request-0001" })).toMatchObject({ ok: true, status: "nothing_to_do" });
  });
});

describe("stale marking", () => {
  it("a step that says nothing about the image (login, expired) or one this version does not know leaves it ready and queues nothing", async () => {
    for (const step of ["login", "expired", "from_the_future", ""]) {
      const w = world(); seed(w, { images: [imageOf(dig(1))], health: "healthy" });
      const before = structuredClone(w.store.rows.get("org-1#proj-1"));
      expect(await markStale(w.deps, ids, { digest: dig(1), step }), step).toEqual({ ok: true });
      expect(w.store.rows.get("org-1#proj-1"), step).toEqual(before);
      expect(w.store.log, step).toEqual([]);
    }
  });

  it("a step about the image marks it stale and queues the rebuild", async () => {
    for (const step of ["pull", "inspect", "manifest", "links"]) {
      const w = world(); seed(w, { images: [imageOf(dig(1))], health: "healthy" });
      expect(await markStale(w.deps, ids, { digest: dig(1), step })).toEqual({ ok: true });
      const row = w.store.rows.get("org-1#proj-1")!;
      expect(row.images[0]).toMatchObject({ status: "stale", staleStep: step });
      expect(row.job?.reason).toBe("stale");
    }
  });
});

describe("Reset is bounded", () => {
  it("writes nothing while a job is live or a Reset is already waiting (in_flight)", async () => {
    const live = world(); seed(live, { images: [imageOf(dig(1))], job: { jobId: "j", leaseToken: "l", reason: "stale", approved: APPROVED, commits: { svc: COMMIT }, expectedKey: KEY, createdAt: iso(T0), leaseUntil: iso(T0 + 3_600_000) } });
    const before = structuredClone(live.store.rows.get("org-1#proj-1"));
    expect(await requestReset(live.deps, ids, "person-1", "request-0001")).toEqual({ ok: true, queued: false, why: "in_flight" });
    expect(live.store.rows.get("org-1#proj-1")).toEqual(before);
    expect(live.store.log).toEqual([]);
    const waiting = world({ key: undefined }); seed(waiting, { resetRequested: true });
    expect(await requestReset(waiting.deps, ids, "person-1")).toEqual({ ok: true, queued: false, why: "in_flight" });
    // a job whose lease ran out is not in flight
    const lapsed = world(); seed(lapsed, { images: [imageOf(dig(1))], job: { jobId: "j", leaseToken: "l", reason: "stale", approved: APPROVED, commits: { svc: COMMIT }, expectedKey: KEY, createdAt: iso(T0 - 7_200_000), leaseUntil: iso(T0 - 1) } });
    expect(await requestReset(lapsed.deps, ids, "person-1")).toMatchObject({ queued: true });
  });

  it("a second Reset within 15 minutes writes nothing (cooldown), and one after it is taken", async () => {
    const w = world(); seed(w, { images: [imageOf(dig(1))] });
    expect(await requestReset(w.deps, ids, "person-1", "request-0001")).toMatchObject({ queued: true });
    // the job finishes: a Reset again is judged by the cooldown alone
    const done = structuredClone(w.store.rows.get("org-1#proj-1")!);
    w.store.rows.set("org-1#proj-1", { ...done, job: undefined, version: done.version });
    w.clock.now = T0 + SAVED_ENV_RESET_COOLDOWN_MS - 1;
    const before = structuredClone(w.store.rows.get("org-1#proj-1"));
    expect(await requestReset(w.deps, ids, "person-1", "request-0002")).toEqual({ ok: true, queued: false, why: "cooldown" });
    expect(w.store.rows.get("org-1#proj-1")).toEqual(before);
    w.clock.now = T0 + SAVED_ENV_RESET_COOLDOWN_MS;
    expect(await requestReset(w.deps, ids, "person-1", "request-0003")).toMatchObject({ queued: true });
  });

  it("is never remembered on an archived or deleted row", async () => {
    for (const mark of [{ archived: true }, { deleted: true }] as Array<Partial<SavedEnvState>>) {
      const w = world(); seed(w, { images: [imageOf(dig(1))], ...mark });
      const before = structuredClone(w.store.rows.get("org-1#proj-1"));
      expect(await requestReset(w.deps, ids, "person-1", "request-0001")).toEqual({ ok: true, queued: false, why: "archived" });
      expect(w.store.rows.get("org-1#proj-1")).toEqual(before);
      expect(w.store.log).toEqual([]);
    }
  });

  it("the same press sent again (same request id) is one press and writes nothing", async () => {
    const w = world(); seed(w, { images: [imageOf(dig(1))] });
    expect(await requestReset(w.deps, ids, "person-1", "request-0001")).toMatchObject({ queued: true });
    const row = structuredClone(w.store.rows.get("org-1#proj-1"));
    expect(await requestReset(w.deps, ids, "person-1", "request-0001")).toEqual({ ok: true, queued: false, why: "duplicate" });
    expect(w.store.rows.get("org-1#proj-1")).toEqual(row);
    expect(w.store.log.filter((entry) => entry.action === "reset_requested")).toHaveLength(1);
  });

  it("the panel answers queued for the first press and for its replay, in_flight and cooldown as such, and nothing_to_do for an archived project", async () => {
    const w = world(); seed(w, { images: [imageOf(dig(1))] });
    const press = (requestId: string) => resetFromPanel(w.deps, ids, { actorId: "person-1", projectRole: "maintainer", requestId });
    expect(await press("request-0001")).toMatchObject({ ok: true, status: "queued" });
    expect(await press("request-0001")).toMatchObject({ ok: true, status: "queued" });
    expect(await press("request-0002")).toMatchObject({ ok: true, status: "in_flight" });
    const cool = world(); seed(cool, { images: [imageOf(dig(1))], lastResetAt: iso(T0 - 1000) });
    expect(await resetFromPanel(cool.deps, ids, { actorId: "person-1", projectRole: "maintainer", requestId: "request-0009" })).toMatchObject({ ok: true, status: "cooldown" });
    const archived = world(); seed(archived, { archived: true });
    expect(await resetFromPanel(archived.deps, ids, { actorId: "person-1", projectRole: "maintainer", requestId: "request-0009" })).toMatchObject({ ok: true, status: "nothing_to_do", panel: { canReset: false } });
  });
});

describe("what the image registry can do for a worker decides what is queued and named", () => {
  it("a registry the worker cannot push to queues no rebuild: the row is untouched and the registry is not reached", async () => {
    const w = world({ capabilities: { workerPush: false } });
    expect(await checkRebuild(w.deps, ids, "push")).toEqual({ ok: true, queued: false, why: "registry_cannot_build" });
    expect(w.row()?.job).toBeUndefined();
    expect(w.row()?.lastRebuildReason).toBeUndefined();
    expect(w.calls.reached).toBe(0);
    // a reset does not get round it either
    expect(await requestReset(w.deps, ids, "person-1")).toMatchObject({ ok: true, queued: false });
    expect(w.row()?.job).toBeUndefined();
  });

  it("a job that was queued while the registry could push is never given a push login once it cannot (the lease alone is not enough)", async () => {
    const w = world();
    const queued = await checkRebuild(w.deps, ids, "push");
    expect(queued).toMatchObject({ ok: true, queued: true });
    const given = await leaseForDispatch(w.deps, ids);
    expect(given.ok).toBe(true);
    if (!given.ok) return;
    w.registry.capabilities.workerPush = false;
    expect(await mintPushForJob(w.deps, ids, { jobId: given.job.jobId, leaseToken: given.job.leaseToken })).toEqual({ ok: false, reason: "unavailable" });
    expect(w.logins).toEqual([]);
  });

  it("a registry the worker cannot pull from names no image to a task and gives no pull login", async () => {
    const w = world({ capabilities: { workerPull: false } });
    seed(w, { images: [imageOf(dig(1))], health: "healthy" });
    expect(await savedEnvForPrepare(w.deps, ids, APPROVED)).toEqual({});
    expect(await savedEnvPullLogin(w.deps, ids, dig(1))).toEqual({ ok: false, reason: "unavailable" });
    expect(w.logins).toEqual([]);
  });

  it("starts no scan when the registry has none, and a failing scan does not undo a recorded image", async () => {
    for (const w of [world({ capabilities: { scan: false } }), world({ registry: { startScan: async () => { throw new Error("scan down"); } } })]) {
      const queued = await checkRebuild(w.deps, ids, "push");
      expect(queued).toMatchObject({ ok: true, queued: true });
      const lease = await leaseForDispatch(w.deps, ids);
      if (!lease.ok) throw new Error("no lease");
      const result = { ok: true, repository: w.repository, tag: "k-1", imageDigest: dig(2), manifest: manifestOf({ imageDigest: dig(2) }) };
      const recorded = await recordBuild(w.deps, ids, { jobId: lease.job.jobId, leaseToken: lease.job.leaseToken, result });
      expect(recorded.ok).toBe(true);
      expect(w.calls.scans).toEqual([]);
      expect(w.row()?.images.map((image) => image.digest)).toEqual([dig(2)]);
    }
  });

  it("a login the registry gives for ANOTHER repository, or that outlives what was asked, is never handed on", async () => {
    const other = world().registry;
    const wrongRepository = world({ registry: { login: async (call) => other.login({ ...call, repository: savedEnvRepositoryName({ env: "test", orgId: "org-9", projectId: "elsewhere" }) }) } });
    const queued = await checkRebuild(wrongRepository.deps, ids, "push");
    expect(queued).toMatchObject({ ok: true, queued: true });
    const lease = await leaseForDispatch(wrongRepository.deps, ids);
    if (!lease.ok) throw new Error("no lease");
    expect(await mintPushForJob(wrongRepository.deps, ids, { jobId: lease.job.jobId, leaseToken: lease.job.leaseToken })).toEqual({ ok: false, reason: "unavailable" });
    const tooLong = world({ registry: { login: async (call) => { const login = await other.login({ ...call, maxSeconds: call.maxSeconds * 4 }); return { ...login, auth: { ...login.auth, repository: call.repository } }; } } });
    const again = await checkRebuild(tooLong.deps, ids, "push");
    expect(again).toMatchObject({ ok: true, queued: true });
    const second = await leaseForDispatch(tooLong.deps, ids);
    if (!second.ok) throw new Error("no lease");
    expect(await mintPushForJob(tooLong.deps, ids, { jobId: second.job.jobId, leaseToken: second.job.leaseToken })).toEqual({ ok: false, reason: "unavailable" });
  });
});
