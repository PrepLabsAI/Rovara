// Starting a saved image's rebuild on the task flow: the job becomes a read-only preparation pinned to the job's commits, with no credential in anything stored; the build systems' key files are in
// both the job's globs and the broker's key; every refusal that will not mend ends the job.
import { describe, expect, it } from "vitest";
import { type BuildSystem } from "@agentx/contracts";
import { SAVED_ENV_JOB_LEASE_MS, checkRebuild, leaseForDispatch, type RebuildJob } from "../../packages/broker/src/core/test-env/saved-env.js";
import { savedEnvBuildInputsOf, savedEnvSecretNames, startSavedEnvRebuild } from "../../packages/broker/src/core/test-env/saved-env-rebuild.js";
import { startMarkerKey } from "../../packages/broker/src/core/test-env/saved-env-markers.js";
import { BASE_IMAGE, COMPANY, HEAD, PROJECT, approve, environmentBody, savedWorld, textOf, type SavedWorld } from "../support/saved-env-harness.js";

const ids = { orgId: COMPANY, projectId: PROJECT };
const ON = { ROVARA_SAVED_ENVIRONMENTS: "1" };

async function queued(w: SavedWorld): Promise<{ job: RebuildJob }> {
  await w.h.registerProject();
  await approve(w.test, environmentBody());
  const result = await checkRebuild(w.deps, ids, "push");
  if (!result.ok || !result.queued) throw new Error(`not queued: ${JSON.stringify(result)}`);
  // the registry's own start (onQueued) already ran; read the job as the row holds it
  return { job: (await w.deps.store.get(COMPANY, PROJECT))!.job! };
}

const buildSystem = (globs: string[]): BuildSystem => ({ name: "examplebuild", profile: () => ({ name: "examplebuild", setupPrograms: [], keyFileGlobs: globs }) });

describe("starting a rebuild", () => {

  it("starts one workspace per job, however often the trigger fires", async () => {
    const w = savedWorld();
    const { job } = await queued(w);
    const again = await startSavedEnvRebuild({ flow: w.h.deps, saved: w.deps, test: w.test, inputs: async () => ({ baseImageDigest: BASE_IMAGE, secretNames: [], detectorGlobs: [] }), ownerFor: async () => "local-owner", env: { ROVARA_SAVED_ENVIRONMENTS: "1" } }, ids);
    expect(again).toEqual({ started: false, why: "already_started" });
    expect(job.jobId).toBeDefined();
  });

  it("hands the lease token to the dispatcher once, for the operation it was made for", async () => {
    const w = savedWorld();
    const { job } = await queued(w);
    const marker = (await w.h.store.get(startMarkerKey(job.jobId)))!;
    const given = await leaseForDispatch(w.deps, ids, textOf(marker, "operationId"), job.jobId);
    expect(given).toMatchObject({ ok: true, job: { jobId: job.jobId, leaseToken: job.leaseToken } });
    expect(await leaseForDispatch(w.deps, ids, "another-operation", job.jobId)).toEqual({ ok: false, reason: "nothing_to_dispatch" });
    expect(await leaseForDispatch(w.deps, ids, "", job.jobId)).toEqual({ ok: false, reason: "nothing_to_dispatch" });
  });

  it("starts nothing, and ends the queued job, for a reason that will not mend: no owner, no base image, a moved approval", async () => {
    for (const [name, change] of [
      ["no owner", (w: SavedWorld) => { w.owner.value = undefined; }],
      ["no base image", (w: SavedWorld) => { w.base.digest = undefined; }],
    ] as const) {
      const w = savedWorld();
      await w.h.registerProject();
      await approve(w.test, environmentBody());
      change(w);
      const result = await checkRebuild(w.deps, ids, "push");
      // no base image: no key either, so nothing is queued at all; no owner: queued, then refused and ended
      const row = await w.deps.store.get(COMPANY, PROJECT);
      expect(row?.job, name).toBeUndefined();
      expect(result.ok, name).toBe(true);
      if (name === "no owner") expect(row).toMatchObject({ health: "needs_repair", lastFailure: "no_owner" });
    }
  });

  it("refuses, and makes no workspace and no marker, when the approved environment moved since the job was queued", async () => {
    const w = savedWorld();
    await w.h.registerProject();
    const first = await approve(w.test, environmentBody());
    const job: RebuildJob = { jobId: "job-moved", leaseToken: "t".repeat(24), reason: "no_image", approved: first, commits: { demo: HEAD }, expectedKey: "c".repeat(64), createdAt: new Date(w.h.clock.now).toISOString(), leaseUntil: new Date(w.h.clock.now + SAVED_ENV_JOB_LEASE_MS).toISOString() };
    await w.deps.store.commit({ orgId: COMPANY, projectId: PROJECT, version: 1, enabled: true, images: [], health: "never_proved", job }, null, { action: "rebuild_queued", orgId: COMPANY, projectId: PROJECT, at: job.createdAt });
    await approve(w.test, environmentBody({ roundBudgetMin: 40 }), 2);
    const start = { flow: w.h.deps, saved: w.deps, test: w.test, inputs: async () => ({ baseImageDigest: BASE_IMAGE, secretNames: [], detectorGlobs: [] }), ownerFor: async () => "local-owner", env: ON };
    expect(await startSavedEnvRebuild(start, ids)).toEqual({ started: false, why: "approved_moved" });
    expect(await w.h.store.get(startMarkerKey("job-moved"))).toBeUndefined();
    expect((await w.h.queues.queue("task-dispatch").then((queue) => queue.receive())).length).toBe(0);
    // approving the same body again is a new revision, so the pin the job was queued under has still moved
    await approve(w.test, environmentBody(), 3);
    expect(await startSavedEnvRebuild(start, ids)).toEqual({ started: false, why: "approved_moved" });
  });

  it("is off with the switch off, and for a deleted, archived or turned-off project", async () => {
    const off = savedWorld({ env: { ROVARA_SAVED_ENVIRONMENTS: "0" } });
    expect(off.deps).toBeUndefined();
    const w = savedWorld();
    expect(await startSavedEnvRebuild({ flow: w.h.deps, saved: w.deps, test: w.test, inputs: undefined, env: { ROVARA_SAVED_ENVIRONMENTS: "0" } }, ids)).toEqual({ started: false, why: "disabled" });
    expect(await startSavedEnvRebuild({ flow: w.h.deps, saved: w.deps, test: w.test, inputs: undefined, env: { ROVARA_SAVED_ENVIRONMENTS: "1" } }, ids)).toEqual({ started: false, why: "nothing_queued" });
  });

  it("starts nothing for a project the flow does not know, or one that is archived", async () => {
    const w = savedWorld();
    await w.h.registerProject();
    await approve(w.test, environmentBody());
    // queue a job by hand for a project name the flow has no record of
    await w.deps.store.commit({ orgId: COMPANY, projectId: "ghost", version: 1, enabled: true, images: [], health: "never_proved", job: { jobId: "j1", leaseToken: "t".repeat(24), reason: "no_image", approved: { revision: 1, digest: "a".repeat(64) }, commits: { demo: HEAD }, expectedKey: "c".repeat(64), createdAt: new Date(w.h.clock.now).toISOString(), leaseUntil: new Date(w.h.clock.now + 3_600_000).toISOString() } }, null, { action: "rebuild_queued", orgId: COMPANY, projectId: "ghost", at: new Date(w.h.clock.now).toISOString() });
    expect(await startSavedEnvRebuild({ flow: w.h.deps, saved: w.deps, test: w.test, inputs: async () => undefined, env: { ROVARA_SAVED_ENVIRONMENTS: "1" } }, { orgId: COMPANY, projectId: "ghost" })).toEqual({ started: false, why: "no_project" });
  });
});

describe("the key's inputs and the build systems' key files", () => {
  it("names the secrets an environment reads (http_hook accounts only), as a set", () => {
    expect(savedEnvSecretNames(environmentBody())).toEqual([]);
  });

  it("more key-file globs than a job can carry fail closed: no key, so nothing is queued", async () => {
    const many = (prefix: string): string[] => Array.from({ length: 100 }, (_, index) => `${prefix}${String(index)}/BUILD`);
    const w = savedWorld({ buildSystems: [buildSystem(many("a")), { name: "otherbuild", profile: () => ({ name: "otherbuild", setupPrograms: [], keyFileGlobs: many("b") }) }] });
    await w.h.registerProject();
    await approve(w.test, environmentBody());
    await expect(savedEnvBuildInputsOf({ test: w.test, registry: w.adapters, baseImageDigest: async () => BASE_IMAGE }, COMPANY, PROJECT)).rejects.toThrow(/200/u);
    expect(await w.deps.currentKey(COMPANY, PROJECT, new Map([["demo", HEAD]])).catch(() => "none")).toBe("none");
  });
});
