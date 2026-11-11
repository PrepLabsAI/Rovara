// What makes the registry look at a project (push, poll, the nightly, a task) and what settles the end of a rebuild (the sweep): all inert with the switch off, none throws into its caller, and a build that
// ended without a result is ended with the backoff and its workspace retired.
import { describe, expect, it } from "vitest";
import { NIGHTLY_SOURCE } from "@agentx/contracts";
import { SAVED_ENV_FAILURE_BACKOFF_MS, SAVED_ENV_JOB_LEASE_MS, checkRebuild } from "../../packages/broker/src/core/test-env/saved-env.js";
import { startMarkerKey } from "../../packages/broker/src/core/test-env/saved-env-markers.js";
import { SAVED_ENV_BUILD_MAX_AGE_MS, retireBuildWorkspace, sweepSavedEnvBuilds } from "../../packages/broker/src/core/test-env/saved-env-sweep.js";
import { runSavedEnvPoll, savedEnvBeforeNightly, savedEnvPushQueue } from "../../packages/broker/src/core/test-env/saved-env-triggers.js";
import { operationKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { COMPANY, PROJECT, approve, environmentBody, savedWorld, textOf, type SavedWorld } from "../support/saved-env-harness.js";

const ids = { orgId: COMPANY, projectId: PROJECT };
const ON = { ROVARA_SAVED_ENVIRONMENTS: "1" };

async function started(w: SavedWorld) {
  await w.h.registerProject();
  await approve(w.test, environmentBody());
  await checkRebuild(w.deps, ids, "push");
  const job = (await w.deps.store.get(COMPANY, PROJECT))!.job!;
  const marker = (await w.h.store.get(startMarkerKey(job.jobId)))!;
  return { job, workspaceId: textOf(marker, "workspaceId"), operationId: textOf(marker, "operationId") };
}
const sweepDeps = (w: SavedWorld) => ({ store: w.h.store, saved: w.deps, machines: w.h.machines, log: () => undefined });

describe("the triggers", () => {
  it("a push is told to the registry, which queues a rebuild when one is due; with the switch off there is no trigger at all", async () => {
    const w = savedWorld();
    await w.h.registerProject();
    await approve(w.test, environmentBody());
    const push = savedEnvPushQueue(w.deps, ON)!;
    expect(await push({ orgId: COMPANY, project: PROJECT })).toMatchObject({ ok: true, queued: true });
    expect(savedEnvPushQueue(w.deps, { ROVARA_SAVED_ENVIRONMENTS: "0" })).toBeUndefined();
    expect(savedEnvPushQueue(undefined, ON)).toBeUndefined();
  });

  it("the poll checks every due project, and is off (reads nothing) with the switch off or no registry", async () => {
    const w = savedWorld();
    await w.h.registerProject();
    await approve(w.test, environmentBody());
    await checkRebuild(w.deps, ids, "task");
    w.h.clock.advance(31 * 60);
    expect(await runSavedEnvPoll(w.deps, ON)).toMatchObject({ ok: true });
    expect(await runSavedEnvPoll(w.deps, { ROVARA_SAVED_ENVIRONMENTS: "0" })).toBe("off");
    expect(await runSavedEnvPoll(undefined, ON)).toBe("off");
  });

  it("before the nightly the project's images are checked and the deleted projects are swept; a fire that is not a nightly fire only sweeps; nothing throws", async () => {
    const w = savedWorld();
    await w.h.registerProject();
    await approve(w.test, environmentBody());
    await savedEnvBeforeNightly(w.deps, { source: NIGHTLY_SOURCE, orgId: COMPANY, project: PROJECT, scheduledAt: "2026-11-09T02:00:00Z" }, ON);
    expect((await w.deps.store.get(COMPANY, PROJECT))?.job).toBeDefined();
    const fresh = savedWorld();
    await savedEnvBeforeNightly(fresh.deps, { not: "a fire" }, ON);
    expect(await fresh.deps.store.get(COMPANY, PROJECT)).toBeUndefined();
    const broken = { ...w.deps, store: { ...w.deps.store, get: async () => { throw new Error("down"); } } };
    await expect(savedEnvBeforeNightly(broken as never, { source: NIGHTLY_SOURCE, orgId: COMPANY, project: PROJECT, scheduledAt: "2026-11-09T02:00:00Z" }, ON, () => undefined)).resolves.toBeUndefined();
    await expect(savedEnvBeforeNightly(w.deps, {}, { ROVARA_SAVED_ENVIRONMENTS: "0" })).resolves.toBeUndefined();
  });
});

describe("the sweep that settles a rebuild's end", () => {
  it("leaves a live build alone and looks again later", async () => {
    const w = savedWorld();
    const { job, operationId, workspaceId } = await started(w);
    w.h.clock.advance(20 * 60);
    expect(await sweepSavedEnvBuilds(sweepDeps(w), 10, ON)).toEqual({ settled: 0, waiting: 1, failed: 0 });
    expect((await w.deps.store.get(COMPANY, PROJECT))?.job?.jobId).toBe(job.jobId);
    expect((await w.h.store.get(workspaceKey(workspaceId)))?.["status"]).toBe("PREPARING");
    expect((await w.h.store.get(operationKey(workspaceId, operationId)))?.["status"]).toBe("ACCEPTED");
  });

  it("ends a job whose operation ended without a result: the failure backoff, and the workspace is retired and its marker closed", async () => {
    const w = savedWorld();
    const { job, operationId, workspaceId } = await started(w);
    await w.h.store.update({ key: operationKey(workspaceId, operationId), ops: [{ op: "set", path: ["status"], value: "FAILED" }] });
    w.h.clock.advance(11 * 60);
    expect(await sweepSavedEnvBuilds(sweepDeps(w), 10, ON)).toEqual({ settled: 1, waiting: 0, failed: 0 });
    const row = (await w.deps.store.get(COMPANY, PROJECT))!;
    expect(row.job).toBeUndefined();
    expect(row).toMatchObject({ health: "needs_repair", lastFailure: "operation_failed" });
    expect((await w.h.store.get(workspaceKey(workspaceId)))).toMatchObject({ status: "CLOSED" });
    expect((await w.h.store.get(workspaceKey(workspaceId)))?.["activeOperationId"]).toBeUndefined();
    expect(typeof (await w.h.store.get(startMarkerKey(job.jobId)))?.["retiredAt"]).toBe("string");
    // the backoff holds: no rebuild at once
    expect(await checkRebuild(w.deps, ids, "push")).toMatchObject({ ok: true, queued: false, why: "backoff" });
    w.h.clock.advance(SAVED_ENV_FAILURE_BACKOFF_MS / 1000 + 1);
    // settled markers are not looked at again
    expect(await sweepSavedEnvBuilds(sweepDeps(w), 10, ON)).toEqual({ settled: 0, waiting: 0, failed: 0 });
  });

  it("ends a job whose lease ran out, and a build older than a day, whatever its operation says", async () => {
    const lease = savedWorld();
    const first = await started(lease);
    lease.h.clock.advance(SAVED_ENV_JOB_LEASE_MS / 1000 + 1);
    await sweepSavedEnvBuilds(sweepDeps(lease), 10, ON);
    expect((await lease.deps.store.get(COMPANY, PROJECT))).toMatchObject({ lastFailure: "lease_expired" });
    const old = savedWorld();
    const second = await started(old);
    // keep the lease alive past the day by moving it, so only the age ends the build
    const row = (await old.deps.store.get(COMPANY, PROJECT))!;
    await old.deps.store.commit({ ...row, version: row.version + 1, job: { ...row.job!, leaseUntil: new Date(old.h.clock.now + 3 * SAVED_ENV_BUILD_MAX_AGE_MS).toISOString() } }, row.version, { action: "activity", orgId: COMPANY, projectId: PROJECT, at: new Date(old.h.clock.now).toISOString() });
    old.h.clock.advance(SAVED_ENV_BUILD_MAX_AGE_MS / 1000 + 60);
    await sweepSavedEnvBuilds(sweepDeps(old), 10, ON);
    expect((await old.deps.store.get(COMPANY, PROJECT))?.job).toBeUndefined();
    expect((await old.h.store.get(workspaceKey(second.workspaceId)))).toMatchObject({ status: "CLOSED" });
    expect(first.job.jobId).not.toBe(second.job.jobId);
  });

  it("terminates the workspace's machine through the worker-machines port; a machine that cannot be terminated is looked at again", async () => {
    const w = savedWorld();
    const { operationId, workspaceId } = await started(w);
    await w.h.store.update({ key: workspaceKey(workspaceId), ops: [{ op: "set", path: ["machine"], value: { machineId: "m-1", machineKey: "k" } }] });
    await w.h.store.update({ key: operationKey(workspaceId, operationId), ops: [{ op: "set", path: ["status"], value: "FAILED" }] });
    const terminated: string[] = [];
    const down = { terminate: async (id: string) => { terminated.push(id); throw new Error("busy"); } };
    expect(await retireBuildWorkspace({ store: w.h.store, machines: down, log: () => undefined }, workspaceId, operationId, (await w.deps.store.get(COMPANY, PROJECT))!.job!.jobId, w.h.clock.now)).toBe("later");
    expect((await w.h.store.get(workspaceKey(workspaceId)))?.["status"]).toBe("PREPARING");
    const ok = { terminate: async (id: string) => { terminated.push(id); } };
    expect(await retireBuildWorkspace({ store: w.h.store, machines: ok, log: () => undefined }, workspaceId, operationId, (await w.deps.store.get(COMPANY, PROJECT))!.job!.jobId, w.h.clock.now)).toBe("retired");
    expect(terminated).toEqual(["m-1", "m-1"]);
  });

  it("never touches a workspace whose operation names another job (the marker is dropped)", async () => {
    const w = savedWorld();
    const { job, operationId, workspaceId } = await started(w);
    // another job's marker pointing at THIS job's workspace
    await w.h.store.update({ key: startMarkerKey(job.jobId), ops: [{ op: "set", path: ["workspaceId"], value: workspaceId }] });
    await w.h.store.update({ key: operationKey(workspaceId, operationId), ops: [{ op: "set", path: ["dispatch", "payload", "savedEnvBuild", "jobId"], value: "someone-elses-job" }, { op: "set", path: ["status"], value: "FAILED" }] });
    w.h.clock.advance(11 * 60);
    await sweepSavedEnvBuilds(sweepDeps(w), 10, ON);
    expect((await w.h.store.get(workspaceKey(workspaceId)))?.["status"]).toBe("PREPARING");
    expect(await w.h.store.get(startMarkerKey(job.jobId))).toBeUndefined();
  });

  it("is off with the switch off or no registry", async () => {
    const w = savedWorld();
    expect(await sweepSavedEnvBuilds(sweepDeps(w), 10, { ROVARA_SAVED_ENVIRONMENTS: "0" })).toBe("off");
    expect(await sweepSavedEnvBuilds({ ...sweepDeps(w), saved: undefined }, 10, ON)).toBe("off");
  });
});
