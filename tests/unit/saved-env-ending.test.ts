// Saved project images (SV wiring): the lease goes to ONE operation (and the same operation can have it again), and a job whose build ended without a result is ended too, so the project does not wait out a lease for a
// build nobody is running; a repository that moved since the queue is a requeue for the heads now, never a failure and never an arbitrary reachable commit.
import { describe, expect, it } from "vitest";
import { checkRebuild, endBuildJob, leaseForDispatch } from "../../packages/broker/src/core/test-env/saved-env.js";
import { savedEnvWorld } from "../support/saved-env-world.js";

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

});

describe("a build that ended without a result", () => {

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
