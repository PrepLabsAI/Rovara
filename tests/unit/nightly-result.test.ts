// Recording a night: the baseline, the already-failing and flaky sets, the coverage map bound to its digest, the classification beside the baseline, and the rows of nights that did not finish.
import { describe, expect, it } from "vitest";
import {
  CoverageMapSchema, DocumentStoreError, NIGHTLY_STEP_WORDS, NightlyBaselineSchema, NightlyResultSchema, StoredNightlyHealthSchema, agentXError, orgProjectCatalogKey, projectPk, projectRevisionKey,
  type DocumentStore,
} from "@agentx/contracts";
import { NIGHTLY_ENVIRONMENT_CAUSES, NIGHTLY_HEALTH_STEPS, NIGHTLY_UNCLEAR_CAUSES } from "../../packages/broker/src/core/test-env/nightly-health.js";
import { alreadyFailingTests, coverageMapDigest, handleNightlyFire, lastNightlyFailures, mapAgeDays, nightlyHealthOf, readCoverageMap, readLatestNightlyHealth, readNightlyBaseline, recordNightlyResult, splitFailures, type MapStore } from "../../packages/broker/src/core/test-env/nightly.js";
import { nightFailedItem, readLatestNight, readNightRows } from "../../packages/broker/src/core/test-env/night-status.js";
import { createObjectMapStore } from "../../packages/broker/src/core/test-env/nightly-wiring.js";
import { createDocumentObjectStorage } from "../../packages/broker/src/core/proof/evidence-blob-store.js";
import { nightlyMapKey, nightlyMapsOfProject } from "../../packages/broker/src/core/test-env/map-keys.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { HEAD1, HEAD2, ORG, PROJECT, T0, map, nightlyWorld, result, rows } from "../support/nightly-world.js";

const PK = projectPk(ORG, PROJECT);
type World = Awaited<ReturnType<typeof nightlyWorld>>;

async function started(h: World): Promise<string> {
  const fire = await handleNightlyFire(h.deps, h.due());
  if (fire.outcome !== "started") throw new Error("not started");
  return fire.slotId;
}

describe("recording a result, and what it feeds", () => {
  it("stores the baseline, the already-failing set, the flaky set and the coverage map, bound to their digest", async () => {
    const h = await nightlyWorld();
    const data = result(await started(h));
    expect(await recordNightlyResult(h.deps, h.mapStore, { orgId: ORG, project: PROJECT, result: data.result, coverageMap: data.coverageMap })).toEqual({ recorded: true, flakyCount: 1, failingCount: 2 });
    const baseline = NightlyBaselineSchema.parse(await readNightlyBaseline(h.deps, ORG, PROJECT));
    expect(baseline).toMatchObject({ envRevision: 1, headSha: HEAD1, flaky: ["tests/test_y.py::flaky1"], coverageMapRef: coverageMapDigest(data.coverageMap) });
    expect(await alreadyFailingTests(h.deps, ORG, PROJECT)).toEqual(["tests/test_x.py::bad1", "tests/test_x.py::bad2"]);
    expect(await lastNightlyFailures(h.deps, ORG, PROJECT)).toEqual(["tests/test_x.py::bad1", "tests/test_x.py::bad2"]);
    expect(CoverageMapSchema.safeParse(await readCoverageMap(h.deps, h.mapStore, ORG, PROJECT)).success).toBe(true);
    expect(mapAgeDays(baseline, T0 + 8 * 86_400_000)).toBe(8);
    expect(mapAgeDays(undefined, T0)).toBeUndefined();
    // A flake is not a known failure.
    expect(await alreadyFailingTests(h.deps, ORG, PROJECT)).not.toContain("tests/test_y.py::flaky1");
    // The run's lock is released and a dated history row is kept.
    expect(await rows(h.store, "TESTENV#NIGHTLY#ACTIVE")).toEqual([]);
    expect((await rows(h.store, "TESTENV#BASELINE#2")).length).toBe(1);
  });

  it("a tampered stored map reads as no map", async () => {
    const h = await nightlyWorld();
    const data = result(await started(h));
    await recordNightlyResult(h.deps, h.mapStore, { orgId: ORG, project: PROJECT, result: data.result, coverageMap: data.coverageMap });
    h.maps.set(coverageMapDigest(data.coverageMap), { ...data.coverageMap, files: { "src/match.py": [] } });
    expect(await readCoverageMap(h.deps, h.mapStore, ORG, PROJECT)).toBeUndefined();
  });

  it("refuses a result for a slot nobody is waiting for, one recorded twice, an unreadable one, and a map that is not the one named", async () => {
    const h = await nightlyWorld();
    const data = result(await started(h));
    const record = (over: { result?: unknown; coverageMap?: unknown }) => recordNightlyResult(h.deps, h.mapStore, { orgId: ORG, project: PROJECT, result: over.result ?? data.result, coverageMap: "coverageMap" in over ? over.coverageMap : data.coverageMap });
    await expect(record({ result: result("f".repeat(64)).result })).rejects.toThrow(/no nightly run is waiting/u);
    await expect(record({ result: { nonsense: 1 } })).rejects.toThrow(/could not be read/u);
    await expect(record({ coverageMap: { ...data.coverageMap, files: { "src/other.py": ["t"] } } })).rejects.toThrow(/does not match/u);
    await expect(record({ coverageMap: undefined })).rejects.toThrow(/did not send/u);
    expect(await readNightlyBaseline(h.deps, ORG, PROJECT)).toBeUndefined();
    await record({});
    await expect(record({})).rejects.toThrow(/no nightly run is waiting/u);
  });

  it("refuses a result from before an environment change", async () => {
    const h = await nightlyWorld();
    const data = result(await started(h), { envRevision: 2 });
    await expect(recordNightlyResult(h.deps, h.mapStore, { orgId: ORG, project: PROJECT, result: data.result, coverageMap: data.coverageMap })).rejects.toThrow(/environment changed/u);
    // And the run is still waiting: a refused result frees nothing.
    expect(await rows(h.store, "TESTENV#NIGHTLY#ACTIVE")).toEqual(["TESTENV#NIGHTLY#ACTIVE"]);
  });

  it("keeps the last good map when a run records none, and excuses no failure when the baseline is damaged", async () => {
    const h = await nightlyWorld();
    const one = result(await started(h));
    await recordNightlyResult(h.deps, h.mapStore, { orgId: ORG, project: PROJECT, result: one.result, coverageMap: one.coverageMap });
    h.clock.now += 24 * 3_600_000;
    h.heads.value = HEAD2;
    const second = await handleNightlyFire(h.deps, h.due(new Date(h.clock.now - 1_000).toISOString()));
    if (second.outcome !== "started") throw new Error("not started");
    const noMap = result(second.slotId, { headSha: HEAD2, coverageMapRef: undefined, failed: [], tests: { total: 10, passed: 9, failed: 0, skipped: 1 }, finishedAt: new Date(h.clock.now).toISOString(), startedAt: new Date(h.clock.now - 60_000).toISOString() });
    await recordNightlyResult(h.deps, h.mapStore, { orgId: ORG, project: PROJECT, result: noMap.result });
    const baseline = await readNightlyBaseline(h.deps, ORG, PROJECT);
    expect(baseline?.coverageMapRef).toBe(coverageMapDigest(one.coverageMap));
    expect(baseline?.coverageMapBuiltAt).toBe(one.coverageMap.builtAt);
    expect(await alreadyFailingTests(h.deps, ORG, PROJECT)).toEqual([]);
    await h.store.put({ item: { pk: PK, sk: "TESTENV#BASELINE#LATEST", baseline: "garbage" } });
    expect(await alreadyFailingTests(h.deps, ORG, PROJECT)).toEqual([]);
    await expect(readNightlyBaseline(h.deps, ORG, PROJECT)).rejects.toThrow(/could not be read/u);
  });

  it("validates a result's own arithmetic and splits first-run failures into failing and flaky", async () => {
    expect(splitFailures(["a", "b", "c", "a"], ["b", "x"])).toEqual({ failed: ["b"], flaky: ["a", "c"] });
    const store = new MemoryDocumentStore();
    const bad = (over: Record<string, unknown>) => recordNightlyResult({ store, now: () => T0 }, {} as MapStore, { orgId: ORG, project: PROJECT, result: result("a".repeat(64), over).result });
    await expect(bad({ tests: { total: 9, passed: 7, failed: 2, skipped: 1 } })).rejects.toThrow(/could not be read/u);
    await expect(bad({ flaky: ["tests/test_x.py::bad1"] })).rejects.toThrow(/could not be read/u);
    await expect(bad({ finishedAt: new Date(T0 - 41 * 60_000).toISOString() })).rejects.toThrow(/could not be read/u);
  });

  it("refuses a result dated more than five minutes ahead of the broker's clock, before anything is read or claimed", async () => {
    for (const over of [{ finishedAt: new Date(T0 + 6 * 60_000).toISOString() }, { startedAt: new Date(T0 + 6 * 60_000).toISOString(), finishedAt: new Date(T0 + 7 * 60_000).toISOString() }, { finishedAt: "2099-01-01T00:00:00.000Z" }]) {
      const h = await nightlyWorld();
      const data = result(await started(h), over);
      await expect(recordNightlyResult(h.deps, h.mapStore, { orgId: ORG, project: PROJECT, result: data.result, coverageMap: data.coverageMap })).rejects.toThrow(/dated in the future/u);
      expect(await rows(h.store, "TESTENV#NIGHTLY#ACTIVE")).toEqual(["TESTENV#NIGHTLY#ACTIVE"]);
      expect(await readNightlyBaseline(h.deps, ORG, PROJECT)).toBeUndefined();
    }
    const near = await nightlyWorld();
    const data = result(await started(near), { finishedAt: new Date(T0 + 4 * 60_000).toISOString() });
    expect(await recordNightlyResult(near.deps, near.mapStore, { orgId: ORG, project: PROJECT, result: data.result, coverageMap: data.coverageMap })).toMatchObject({ recorded: true });
  });
});

describe("step words on the nightly result", () => {
  const okCheck = { runsTests: true, started: true, timedOut: false, reportApproved: true, reportWritten: true, testsCollected: 10 };
  const steps = (over: Record<string, string> = {}) => NIGHTLY_STEP_WORDS.map((step) => ({ step, status: over[step] ?? "passed" }));
  // The result fixture is 10 tests: 7 passed, 2 failed, 1 skipped.
  const health = (over: Record<string, unknown> = {}) => ({ steps: steps(), checks: [okCheck], tests: { total: 10, passed: 7, failures: 2, errors: 0, skipped: 1 }, ...over });
  const latest = async (h: World) => (await h.store.get({ pk: PK, sk: "TESTENV#BASELINE#LATEST" })) as Record<string, unknown>;
  async function recorded(over: Record<string, unknown>, listener?: Parameters<typeof recordNightlyResult>[3]) {
    const h = await nightlyWorld();
    const data = result(await started(h), over);
    const call = () => recordNightlyResult(h.deps, h.mapStore, { orgId: ORG, project: PROJECT, result: data.result, coverageMap: data.coverageMap }, listener);
    return { h, data, call };
  }

  it("an older result, with no step words, parses and is stored with no health anywhere", async () => {
    const { h, data, call } = await recorded({});
    expect(NightlyResultSchema.parse(data.result)).not.toHaveProperty("health");
    await call();
    expect(await latest(h)).not.toHaveProperty("health");
    expect(await readLatestNightlyHealth(h.deps, ORG, PROJECT)).toMatchObject({ health: undefined, baseline: { headSha: HEAD1 } });
    expect(nightlyHealthOf(NightlyResultSchema.parse(data.result))).toBeUndefined();
  });

  it("keeps the broker's classification of the steps beside the baseline, and the baseline itself is unchanged", async () => {
    const { h, call } = await recorded({ health: health({ steps: steps({ setup: "failed", full_suite: "skipped" }) }) });
    await call();
    expect((await latest(h))["health"]).toEqual({ class: "environment", cause: "setup_failed", ranFrom: "fresh" });
    expect(NightlyBaselineSchema.safeParse((await latest(h))["baseline"]).success).toBe(true);
    expect(await readLatestNightlyHealth(h.deps, ORG, PROJECT)).toMatchObject({ health: { class: "environment", cause: "setup_failed" }, baseline: { tests: { failed: 2 } } });
  });

  it("a report whose counts are not the result's own counts reads as unclear, never as passed", async () => {
    const { h, call } = await recorded({ health: health({ tests: { total: 10, passed: 10, failures: 0, errors: 0, skipped: 0 } }) });
    await call();
    expect(await readLatestNightlyHealth(h.deps, ORG, PROJECT)).toMatchObject({ health: { class: "unclear", cause: "steps_disagree" } });
  });

  it("a stale write is retried the same way; any other listener failure never fails the record", async () => {
    const stale = await recorded({ health: health() }, () => Promise.reject(agentXError("CHANGE_STALE", "the project health changed while it was being updated")));
    await expect(stale.call()).rejects.toThrow(/changed while/u);
    expect(await rows(stale.h.store, "TESTENV#NIGHTLY#ACTIVE")).toHaveLength(1);
    // A store that is invalid is not a fault a repeat may cure.
    for (const failure of [new Error("boom"), agentXError("RUNTIME_UNAVAILABLE", "the project health could not be read"), agentXError("CONFIG_INVALID", "bad"), new DocumentStoreError("invalid_request", "a bug")]) {
      const { h, call } = await recorded({ health: health() }, () => Promise.reject(failure));
      expect(await call()).toMatchObject({ recorded: true });
      expect(await rows(h.store, "TESTENV#NIGHTLY#ACTIVE")).toHaveLength(0);
      expect(await latest(h)).toMatchObject({ health: { class: "tests" } });
    }
  });

  it("a stored classification that does not read back is unclear, never absent and never passed", async () => {
    const { h, call } = await recorded({ health: health() });
    await call();
    await h.store.put({ item: { ...(await latest(h)), health: { class: "passed", cause: "Bad Cause!", ranFrom: "fresh" } } as never });
    expect(await readLatestNightlyHealth(h.deps, ORG, PROJECT)).toMatchObject({ health: { class: "unclear", cause: "unreadable" } });
  });

  it("the contract's step words are the classifier's, and every cause the classifier can give is storable", () => {
    expect([...NIGHTLY_STEP_WORDS]).toEqual([...NIGHTLY_HEALTH_STEPS]);
    for (const cause of [...NIGHTLY_ENVIRONMENT_CAUSES, ...NIGHTLY_UNCLEAR_CAUSES]) expect(StoredNightlyHealthSchema.safeParse({ class: "unclear", cause, ranFrom: "fresh" }).success, cause).toBe(true);
  });
});

describe("nights that did not finish, and nights that cannot run", () => {
  const failedAt = async (store: DocumentStore, input: { slotId: string; reason: "branch_moved" | "wall_clock" | "worker_refused" | "infra"; at: number }) => {
    const item = nightFailedItem({ orgId: ORG, project: PROJECT, slotId: input.slotId, reason: input.reason, nowIso: new Date(input.at).toISOString() });
    await store.transact([item]);
  };

  it("a row is cleared once a later night is recorded: an infrastructure failure followed by a good night reads nothing, and one after it shows again", async () => {
    const h = await nightlyWorld();
    await failedAt(h.store, { slotId: "a".repeat(64), reason: "infra", at: T0 - 3_600_000 });
    expect(await readLatestNight(h.deps, ORG, PROJECT)).toMatchObject({ reason: "infra" });
    const slot = await started(h);
    const data = result(slot);
    await recordNightlyResult(h.deps, h.mapStore, { orgId: ORG, project: PROJECT, result: data.result, coverageMap: data.coverageMap });
    expect(await readLatestNight(h.deps, ORG, PROJECT)).toBeUndefined();
    h.clock.now += 3_600_000;
    await failedAt(h.store, { slotId: "b".repeat(64), reason: "infra", at: h.clock.now });
    expect(await readLatestNight(h.deps, ORG, PROJECT)).toMatchObject({ reason: "infra" });
  });

  it("the other reasons a night cannot run leave a note; an ordinary skip leaves none", async () => {
    const h = await nightlyWorld();
    const runs = { ...h.deps.runs, defaultBranchOf: async () => "develop" };
    await handleNightlyFire({ ...h.deps, runs }, h.due());
    expect(await readLatestNight(h.deps, ORG, PROJECT)).toMatchObject({ status: "unavailable", reason: "branch_not_default", words: "Nightly not available: the nightly branch is not the repository's default branch." });
    const w = await nightlyWorld();
    h.heads.value = undefined;
    await handleNightlyFire(w.deps, w.due(new Date(T0 - 1_000).toISOString()));
    expect(await readNightRows(w.deps, ORG, PROJECT)).toEqual([]);
  });
});

describe("the coverage map store over object storage", () => {
  it("keeps a map under its digest, per company and project, and reads it back; the same map twice is one object", async () => {
    const store = new MemoryDocumentStore();
    const objects = createDocumentObjectStorage(store, { companyId: ORG });
    const maps = createObjectMapStore(objects);
    const coverage = map();
    const digest = await maps.put(ORG, PROJECT, coverage);
    expect(digest).toBe(coverageMapDigest(coverage));
    expect(await maps.put(ORG, PROJECT, coverage)).toBe(digest);
    expect(await maps.get(ORG, PROJECT, digest)).toEqual(coverage);
    expect(await maps.get(ORG, "other-project", digest)).toBeUndefined();
    expect(await maps.get("org_bbbbbbbbbbbbbbbbbbbb", PROJECT, digest)).toBeUndefined();
    expect(nightlyMapKey(ORG, PROJECT, digest).startsWith(nightlyMapsOfProject(ORG, PROJECT))).toBe(true);
    expect(await maps.get(ORG, PROJECT, "f".repeat(64))).toBeUndefined();
  });
});

// DEC 254zzz495 (N3): a night in which no test ran is healthy for a project whose approved setup has no test command, but only while the night's own approved environment has no test-kind check. Proved THROUGH recordNightlyResult
// (the exemption is `!hasTestCheck(environment) && projectHasNoAutomatedTests`), not only through `hasTestCheck`: dropping the environment half would hide a real "the test step collected nothing".
describe("the no-automated-tests exemption, through recordNightlyResult", () => {
  const FACT = { at: "2026-11-24T10:00:00.000Z", looked: ["tests_folder"] };
  const steps = NIGHTLY_STEP_WORDS.map((step) => ({ step, status: "passed" }));
  const smokeOnly = { repos: [{ repositoryId: "svc", setupCommands: [], checks: [{ id: "smoke", label: "Smoke", command: { cwd: "service", executable: "make", args: ["smoke"], timeoutSeconds: 600 }, kind: "smoke" }] }] };
  // A night in which no test ran: nothing collected, nothing skipped; one check, which runs tests (the environment names a test check) or does not (it names none).
  const emptyNight = (runsTests: boolean) => ({
    tests: { total: 0, passed: 0, failed: 0, skipped: 0 }, failed: [], flaky: [],
    health: { steps, checks: [{ runsTests, started: true, timedOut: false, reportApproved: false, reportWritten: false, testsCollected: 0 }], tests: { total: 0, passed: 0, failures: 0, errors: 0, skipped: 0 } },
  });
  async function nightOf(environmentExtra: Record<string, unknown>, runsTests: boolean, withFact: boolean) {
    const h = await nightlyWorld({}, environmentExtra);
    const definition = { name: PROJECT, revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.", repositories: [{ name: "svc", url: "https://github.com/example/svc.git", path: "service", defaultBranch: "main", credentialRef: "host-app" }] };
    await h.store.put({ item: { ...projectRevisionKey(ORG, PROJECT, 1), entityType: "PROJECT", definition, ...(withFact ? { noAutomatedTests: FACT } : {}) } });
    await h.store.put({ item: { ...orgProjectCatalogKey(ORG, PROJECT), entityType: "PROJECT_CATALOG", latestRevision: 1 } });
    const data = result(await started(h), emptyNight(runsTests));
    await recordNightlyResult(h.deps, h.mapStore, { orgId: ORG, project: PROJECT, result: data.result, coverageMap: data.coverageMap });
    return (await readLatestNightlyHealth(h.deps, ORG, PROJECT))?.health;
  }

  it("an environment with no test-kind check and a project with the fact: the empty night is healthy", async () => {
    expect(await nightOf(smokeOnly, false, true)).toMatchObject({ class: "passed" });
  });
  it("the same night without the fact is not (the fact is read from the project's live revision row)", async () => {
    expect(await nightOf(smokeOnly, false, false)).toMatchObject({ class: "environment", cause: "no_tests_collected" });
  });
  it("an environment WITH a test-kind check and a project with the fact: a test step that collected nothing is still the environment's fault", async () => {
    expect(await nightOf({}, true, true)).toMatchObject({ class: "environment", cause: "no_tests_collected" });
  });
});
