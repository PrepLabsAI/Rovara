// Saved project images (SV wiring): the lease goes to ONE operation (and the same operation can have it again), and a job whose build ended without a result is ended too, so the project does not wait out a lease for a
// build nobody is running; a repository that moved since the queue is a requeue for the heads now, never a failure and never an arbitrary reachable commit.
import { describe, expect, it } from "vitest";
import { checkRebuild, endBuildJob, leaseForDispatch, SAVED_ENV_FAILURE_BACKOFF_MS } from "../../packages/core/src/core/test-env/saved-env.js";
import { COMMIT, savedEnvWorld } from "../support/saved-env-world.js";

async function queued(over: Parameters<typeof savedEnvWorld>[0] = {}) {
  const w = savedEnvWorld(over);
  const checked = await checkRebuild(w.deps, w.ids, "poll");
  if (!checked.ok || !checked.queued) throw new Error("not queued");
  return { w, jobId: checked.job.jobId };
}

describe("the lease is the operation's", () => {
  it("is given to the operation that takes it, again to the same operation (a delivery retried after the token was taken), and to no other", async () => {
    const { w, jobId } = await queued();
    const first = await leaseForDispatch(w.deps, w.ids, "op-a");
    expect(first).toMatchObject({ ok: true, job: { jobId } });
    expect(w.row()?.job).toMatchObject({ dispatchedOperationId: "op-a" });
    const again = await leaseForDispatch(w.deps, w.ids, "op-a");
    expect(again).toEqual(first);
    expect(await leaseForDispatch(w.deps, w.ids, "op-b")).toEqual({ ok: false, reason: "nothing_to_dispatch" });
    expect(await leaseForDispatch(w.deps, w.ids)).toEqual({ ok: false, reason: "nothing_to_dispatch" });
  });

  it("is not given again once the lease ran out, the project was turned off or deleted, even to the same operation", async () => {
    const { w } = await queued();
    await leaseForDispatch(w.deps, w.ids, "op-a");
    w.store.rows.set(`${w.ids.orgId}#${w.ids.projectId}`, { ...w.row()!, enabled: false });
    expect(await leaseForDispatch(w.deps, w.ids, "op-a")).toEqual({ ok: false, reason: "nothing_to_dispatch" });
    w.store.rows.set(`${w.ids.orgId}#${w.ids.projectId}`, { ...w.row()!, enabled: true });
    w.clock.now += 4 * 3_600_000;
    expect(await leaseForDispatch(w.deps, w.ids, "op-a")).toEqual({ ok: false, reason: "nothing_to_dispatch" });
  });
});

describe("a build that ended without a result", () => {
  it("ends the project's current job with a fixed word and the failure backoff", async () => {
    for (const cause of ["operation_failed", "worker_lost", "lease_expired"] as const) {
      const { w, jobId } = await queued();
      expect(await endBuildJob(w.deps, w.ids, jobId, cause)).toEqual({ ended: true, requeued: false });
      expect(w.row()).toMatchObject({ health: "needs_repair", lastFailure: cause });
      expect(w.row()?.job).toBeUndefined();
      expect(w.store.log.at(-1)).toMatchObject({ action: "build_failed", reason: cause });
      // the backoff holds a new automatic job back
      expect(await checkRebuild(w.deps, w.ids, "poll")).toMatchObject({ ok: true, queued: false, why: "backoff" });
      w.clock.now += SAVED_ENV_FAILURE_BACKOFF_MS + 1;
      expect(await checkRebuild(w.deps, w.ids, "poll")).toMatchObject({ ok: true, queued: true });
    }
  });

  it("changes nothing for a job that is not the current one (recorded, replaced or never there) or when the switch is off", async () => {
    const { w, jobId } = await queued();
    expect(await endBuildJob(w.deps, w.ids, "another-job", "operation_failed")).toEqual({ ended: false, requeued: false });
    expect(w.row()?.job?.jobId).toBe(jobId);
    const empty = savedEnvWorld();
    empty.seed({});
    expect(await endBuildJob(empty.deps, empty.ids, jobId, "operation_failed")).toEqual({ ended: false, requeued: false });
    const off = savedEnvWorld({ enabled: false });
    off.seed({ job: { ...w.row()!.job! } });
    expect(await endBuildJob(off.deps, off.ids, jobId, "operation_failed")).toEqual({ ended: false, requeued: false });
    expect(off.row()?.job).toBeDefined();
  });

  it("requeues for the heads now when the repository moved since the queue, with no failure, and never accepts another commit for the old job", async () => {
    const { w, jobId } = await queued();
    const moved = "e".repeat(40);
    w.state.heads = new Map([["svc", moved]]);
    expect(await endBuildJob(w.deps, w.ids, jobId, "operation_failed")).toEqual({ ended: true, requeued: true });
    const row = w.row()!;
    expect(row.job).toMatchObject({ commits: { svc: moved } });
    expect(row.job?.jobId).not.toBe(jobId);
    expect(row.lastFailure).toBeUndefined();
    expect(row.health).toBe("never_proved");
    expect(w.store.log.at(-2)).toMatchObject({ action: "build_failed", reason: "head_moved" });
  });

  it("is a failure when the heads are the job's or cannot be read, and a repository added since is a move", async () => {
    const same = await queued();
    expect(await endBuildJob(same.w.deps, same.w.ids, same.jobId, "operation_failed")).toEqual({ ended: true, requeued: false });
    expect(same.w.row()?.lastFailure).toBe("operation_failed");
    const unreadable = await queued();
    unreadable.w.state.heads = undefined;
    expect(await endBuildJob(unreadable.w.deps, unreadable.w.ids, unreadable.jobId, "worker_lost")).toEqual({ ended: true, requeued: false });
    expect(unreadable.w.row()?.lastFailure).toBe("worker_lost");
    const empty = await queued();
    empty.w.state.heads = new Map();
    expect(await endBuildJob(empty.w.deps, empty.w.ids, empty.jobId, "operation_failed")).toEqual({ ended: true, requeued: false });
    expect(empty.w.row()?.lastFailure).toBe("operation_failed");
    const wider = await queued();
    wider.w.state.heads = new Map([["svc", COMMIT], ["other", "a".repeat(40)]]);
    expect(await endBuildJob(wider.w.deps, wider.w.ids, wider.jobId, "operation_failed")).toEqual({ ended: true, requeued: true });
  });

  it("ends a job the writes lost a race for once more, and gives up quietly after its tries", async () => {
    const { w, jobId } = await queued();
    w.store.failNextCommit();
    expect(await endBuildJob(w.deps, w.ids, jobId, "operation_failed")).toEqual({ ended: true, requeued: false });
    const stuck = await queued();
    const original = stuck.w.store.commit.bind(stuck.w.store);
    stuck.w.store.commit = async () => false;
    expect(await endBuildJob(stuck.w.deps, stuck.w.ids, stuck.jobId, "operation_failed")).toEqual({ ended: false, requeued: false });
    stuck.w.store.commit = original;
  });
});
