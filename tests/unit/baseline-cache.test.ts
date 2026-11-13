// TE-C1: the baseline cached per base commit (engine). One row per trusted run, written only by the nightly's own record; looked up by (environment revision, branch, commit) exactly or through the ancestry the worker
// verified; never used across companies, environment revisions or branches; an unreadable, truncated or future-dated row excuses nothing.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BaselineRowSchema, INDEX_EXPIRY_ATTRIBUTE, projectPk, type BaselineRow } from "@agentx/contracts";
import {
  BASELINE_RETENTION_MS, baselineCandidatesOf, baselineFor, baselineRowKey, knownFailingOf, mintTrustedBaselineRun, recordBaselineRow, type TrustedBaselineRun,
} from "../../packages/broker/src/core/test-env/baseline-cache.js";
import { baselineCacheEnabled } from "../../packages/broker/src/core/test-env/switch.js";
import { handleNightlyFire, recordNightlyResult } from "../../packages/broker/src/core/test-env/nightly.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { COMPANY_A_ID, COMPANY_B_ID, SHARED_RAW_IDS } from "../../packages/testing/src/isolation/two-company.js";
import { HEAD1, ORG, PROJECT, T0, nightlyWorld, result, rows } from "../support/nightly-world.js";

const NOW = T0;
const HOUR = 3_600_000;
const sha = (n: number): string => n.toString(16).padStart(40, "0");
const row = (over: Partial<BaselineRow> = {}): BaselineRow => BaselineRowSchema.parse({
  recordedAt: new Date(NOW - 2 * HOUR).toISOString(), envRevision: 1, branch: "main", headSha: sha(1), finishedAt: new Date(NOW - 3 * HOUR).toISOString(), writer: "nightly",
  tests: { total: 10, passed: 7, failed: 2, skipped: 1 }, failed: ["a.py::x", "a.py::y"], flaky: ["b.py::z"], ...over,
});
/** The store with some of its methods replaced; the others are the store's own (bound, because the memory store keeps private fields). */
const wrapped = <T extends object>(store: T, replaced: Record<string, unknown>): T => new Proxy(store, { get: (target, name) => { if (typeof name === "string" && Object.hasOwn(replaced, name)) return replaced[name]; const value: unknown = Reflect.get(target, name, target); return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value; } });
const world = () => { const store = new MemoryDocumentStore(); return { store, deps: { store, now: () => NOW } }; };
const keep = async (deps: { store: MemoryDocumentStore; now(): number }, value: BaselineRow, orgId: string = ORG, project: string = PROJECT) => recordBaselineRow(deps, mintTrustedBaselineRun({ orgId: orgId, project, row: value }));
const find = (deps: { store: MemoryDocumentStore; now(): number }, over: Record<string, unknown> = {}) => baselineFor(deps, { orgId: ORG, project: PROJECT, envRevision: 1, branch: "main", ancestry: [], ...over });

describe("the key, the row and the switch", () => {
  it("a row lives on the project's partition at a key that holds the environment revision and the commit, and expires in 90 days", async () => {
    const { store, deps } = world();
    await keep(deps, row());
    const key = { pk: projectPk(ORG, PROJECT), sk: `TESTENV#BASELINE#SHA#00000001#${sha(1)}` };
    expect(baselineRowKey(ORG as never, PROJECT, 1, sha(1))).toEqual(key);
    const stored = (await store.get(key)) as Record<string, unknown>;
    expect(stored).toMatchObject({ entityType: "TEST_ENV_BASELINE_SHA", orgId: ORG, project: PROJECT });
    expect(BaselineRowSchema.parse(stored["baseline"])).toEqual(row());
    expect(stored[INDEX_EXPIRY_ATTRIBUTE]).toBe(Math.floor((NOW + BASELINE_RETENTION_MS) / 1000));
    expect(BASELINE_RETENTION_MS).toBe(90 * 24 * HOUR);
    // No person is named anywhere in the row: nothing to erase for a person (the writer is a fixed word).
    expect(JSON.stringify(stored)).not.toMatch(/person|developer|actor|email|user/iu);
  });

  it("the switch is on only for exactly 1", () => {
    expect(baselineCacheEnabled({})).toBe(false);
    for (const value of ["", "0", "true", " 1", "yes"]) expect(baselineCacheEnabled({ ROVARA_BASELINE_CACHE: value })).toBe(false);
    expect(baselineCacheEnabled({ ROVARA_BASELINE_CACHE: "1" })).toBe(true);
  });
});

describe("only a trusted run writes a row", () => {
  it("a forged object that has the minted run's shape is refused at run time, and writes nothing", async () => {
    const { store, deps } = world();
    const real = mintTrustedBaselineRun({ orgId: ORG, project: PROJECT, row: row() });
    const forged = { ...real };
    await expect(recordBaselineRow(deps, forged)).rejects.toThrow(/trusted/u);
    await expect(recordBaselineRow(deps, { orgId: ORG, project: PROJECT, row: row() } as never)).rejects.toThrow(/trusted/u);
    await expect(recordBaselineRow(deps, Object.create(real) as TrustedBaselineRun)).rejects.toThrow(/trusted/u);
    expect(await store.query({ pk: projectPk(ORG as never, PROJECT), sk: { op: "beginsWith", prefix: "TESTENV#BASELINE#SHA#" } }).then((page) => page.items)).toEqual([]);
    await recordBaselineRow(deps, real);
    expect((await store.query({ pk: projectPk(ORG as never, PROJECT), sk: { op: "beginsWith", prefix: "TESTENV#BASELINE#SHA#" } })).items).toHaveLength(1);
  });

  it("a row that does not parse is never written, and the minting function has exactly one production caller: the nightly's record", () => {
    expect(() => mintTrustedBaselineRun({ orgId: ORG, project: PROJECT, row: { ...row(), headSha: "main" } })).toThrow();
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const found = spawnSync("git", ["grep", "--untracked", "-lw", "-e", "mintTrustedBaselineRun", "--", "packages", "scripts", "infra"], { encoding: "utf8", cwd: root });
    expect(found.stdout.split("\n").filter((file) => file !== "").sort()).toEqual(["packages/broker/src/core/test-env/baseline-cache.ts", "packages/broker/src/core/test-env/nightly.ts"]);
    // The worker's evidence path, the task flow and the evidence keeper never write a baseline row.
    for (const file of ["packages/broker/src/core/proof/evidence-keep.ts", "packages/broker/src/local/app/evidence.ts", "packages/worker/src/verification/evidence-raw.ts", "packages/broker/src/core/test-env/task-plan.ts"]) {
      expect(readFileSync(`${root}/${file}`, "utf8")).not.toMatch(/recordBaselineRow|TESTENV#BASELINE#SHA/u);
    }
  });
});

describe("the nightly's record leaves the row, behind the switch", () => {
  const record = async (env: NodeJS.ProcessEnv | undefined) => {
    const h = await nightlyWorld();
    const fire = await handleNightlyFire(h.deps, h.due());
    if (fire.outcome !== "started") throw new Error("not started");
    const data = result(fire.slotId);
    await recordNightlyResult({ ...h.deps, ...(env === undefined ? {} : { env }) }, h.mapStore, { orgId: ORG, project: PROJECT, result: data.result, coverageMap: data.coverageMap });
    return h;
  };

  it("with the switch on, one row for the run's commit and revision, the nightly as writer; with it off, exactly the rows of today", async () => {
    const on = await record({ ROVARA_BASELINE_CACHE: "1" });
    expect(await rows(on.store, "TESTENV#BASELINE#")).toEqual([expect.stringMatching(/^TESTENV#BASELINE#2/u), `TESTENV#BASELINE#LATEST`, `TESTENV#BASELINE#SHA#00000001#${HEAD1}`]);
    const stored = (await on.store.get({ pk: projectPk(ORG, PROJECT), sk: `TESTENV#BASELINE#SHA#00000001#${HEAD1}` })) as Record<string, unknown>;
    expect(BaselineRowSchema.parse(stored["baseline"])).toMatchObject({ writer: "nightly", headSha: HEAD1, branch: "main", envRevision: 1, failed: ["tests/test_x.py::bad1", "tests/test_x.py::bad2"], flaky: ["tests/test_y.py::flaky1"] });
    for (const env of [undefined, {}, { ROVARA_BASELINE_CACHE: "0" }]) {
      const off = await record(env);
      expect(await rows(off.store, "TESTENV#BASELINE#")).toEqual([expect.stringMatching(/^TESTENV#BASELINE#2/u), `TESTENV#BASELINE#LATEST`]);
    }
  });

  it("a refused result writes no row (a stale slot, an environment that changed)", async () => {
    const h = await nightlyWorld();
    const fire = await handleNightlyFire(h.deps, h.due());
    if (fire.outcome !== "started") throw new Error("not started");
    const env = { ROVARA_BASELINE_CACHE: "1" };
    await expect(recordNightlyResult({ ...h.deps, env }, h.mapStore, { orgId: ORG, project: PROJECT, result: result("f".repeat(64)).result })).rejects.toThrow();
    await expect(recordNightlyResult({ ...h.deps, env }, h.mapStore, { orgId: ORG, project: PROJECT, result: result(fire.slotId, { envRevision: 2 }).result, coverageMap: result(fire.slotId).coverageMap })).rejects.toThrow();
    expect(await rows(h.store, "TESTENV#BASELINE#SHA#")).toEqual([]);
  });

  it("a row the store cannot hold does not fail the night's own record, and a fault that may pass is thrown so the worker's retry records it again", async () => {
    const h = await nightlyWorld();
    const fire = await handleNightlyFire(h.deps, h.due());
    if (fire.outcome !== "started") throw new Error("not started");
    const env = { ROVARA_BASELINE_CACHE: "1" };
    const failing = (inner: typeof h.store, error: Error): typeof h.deps.store => wrapped(inner, { put: (request: { item: { sk: string } }) => (request.item.sk.startsWith("TESTENV#BASELINE#SHA#") ? Promise.reject(error) : inner.put(request as never)) });
    const data = result(fire.slotId);
    const permanent = Object.assign(new Error("too big"), { name: "DocumentStoreError", retryable: false });
    await expect(recordNightlyResult({ ...h.deps, store: failing(h.store, permanent), env }, h.mapStore, { orgId: ORG, project: PROJECT, result: data.result, coverageMap: data.coverageMap })).resolves.toMatchObject({ recorded: true });
    const again = await nightlyWorld();
    const second = await handleNightlyFire(again.deps, again.due());
    if (second.outcome !== "started") throw new Error("not started");
    const data2 = result(second.slotId);
    const transient = Object.assign(new Error("busy"), { name: "DocumentStoreError", retryable: true });
    await expect(recordNightlyResult({ ...again.deps, store: failing(again.store, transient), env }, again.mapStore, { orgId: ORG, project: PROJECT, result: data2.result, coverageMap: data2.coverageMap })).rejects.toThrow(/busy/u);
    // The run is still claimed, so the retry records it again.
    expect(await rows(again.store, "TESTENV#NIGHTLY#ACTIVE")).toEqual(["TESTENV#NIGHTLY#ACTIVE"]);
  });
});

describe("the lookup", () => {
  it("an exact row for (revision, branch, commit) is a match with no commits back", async () => {
    const { deps } = world();
    await keep(deps, row());
    const found = await find(deps, { baseCommit: sha(1) });
    expect(found).toMatchObject({ commitsBack: 0, partial: false, row: { headSha: sha(1), writer: "nightly" } });
    expect(knownFailingOf(found!.row)).toEqual(["a.py::x", "a.py::y"]);
  });

  it("an ancestor the worker verified is a partial match at 1 and at 50 commits back, and at 51 it is a miss", async () => {
    const { deps } = world();
    await keep(deps, row({ headSha: sha(7) }));
    for (const commitsBack of [1, 2, 49, 50]) expect(await find(deps, { ancestry: [{ sha: sha(7), commitsBack }] })).toMatchObject({ commitsBack, partial: true });
    for (const commitsBack of [51, 52, 1_000, -1, 1.5, Number.NaN]) expect(await find(deps, { ancestry: [{ sha: sha(7), commitsBack }] })).toBeUndefined();
  });

  it("the nearest verified ancestor wins, whatever order the list came in; one with no row is skipped", async () => {
    const { deps } = world();
    await keep(deps, row({ headSha: sha(7) }));
    await keep(deps, row({ headSha: sha(8) }));
    expect(await find(deps, { ancestry: [{ sha: sha(7), commitsBack: 9 }, { sha: sha(8), commitsBack: 4 }] })).toMatchObject({ commitsBack: 4, row: { headSha: sha(8) } });
    expect(await find(deps, { ancestry: [{ sha: sha(9), commitsBack: 1 }, { sha: sha(7), commitsBack: 2 }] })).toMatchObject({ commitsBack: 2, row: { headSha: sha(7) } });
  });

  it("with no commit and no ancestry there is no baseline, whatever rows exist (never 'the latest')", async () => {
    const { deps } = world();
    await keep(deps, row({ headSha: sha(7) }));
    await keep(deps, row({ headSha: sha(8) }));
    expect(await find(deps)).toBeUndefined();
    expect(await find(deps, { ancestry: [] })).toBeUndefined();
    expect(await find(deps, { baseCommit: "main", ancestry: [{ sha: "main", commitsBack: 0 }] })).toBeUndefined();
  });

  it("a row of another environment revision or another branch is never used", async () => {
    const { deps } = world();
    await keep(deps, row({ envRevision: 2, headSha: sha(3) }));
    await keep(deps, row({ branch: "release", headSha: sha(4) }));
    expect(await find(deps, { baseCommit: sha(3) })).toBeUndefined();
    expect(await find(deps, { ancestry: [{ sha: sha(3), commitsBack: 1 }] })).toBeUndefined();
    expect(await find(deps, { baseCommit: sha(4) })).toBeUndefined();
    expect(await find(deps, { envRevision: 2, baseCommit: sha(3) })).toMatchObject({ commitsBack: 0 });
    expect(await find(deps, { branch: "release", baseCommit: sha(4) })).toMatchObject({ commitsBack: 0 });
  });

  it("two environment revisions that ran at the same commit each keep their own row (the revision is in the key)", async () => {
    const { store, deps } = world();
    await keep(deps, row({ envRevision: 1, headSha: sha(6), failed: ["rev1::x"], tests: { total: 3, passed: 2, failed: 1, skipped: 0 }, flaky: [] }));
    await keep(deps, row({ envRevision: 2, headSha: sha(6), failed: ["rev2::y"], tests: { total: 3, passed: 2, failed: 1, skipped: 0 }, flaky: [] }));
    expect(knownFailingOf((await find(deps, { envRevision: 1, baseCommit: sha(6) }))!.row)).toEqual(["rev1::x"]);
    expect(knownFailingOf((await find(deps, { envRevision: 2, baseCommit: sha(6) }))!.row)).toEqual(["rev2::y"]);
    expect((await store.query({ pk: projectPk(ORG as never, PROJECT), sk: { op: "beginsWith", prefix: "TESTENV#BASELINE#SHA#" } })).items).toHaveLength(2);
  });

  it("a baseline of another company is never used, with the same project name and the same commit", async () => {
    const { deps } = world();
    await keep(deps, row({ headSha: sha(5), failed: ["only.a::x"], tests: { total: 3, passed: 2, failed: 1, skipped: 0 }, flaky: [] }), COMPANY_A_ID, SHARED_RAW_IDS.project);
    await keep(deps, row({ headSha: sha(5), failed: ["only.b::y"], tests: { total: 3, passed: 2, failed: 1, skipped: 0 }, flaky: [] }), COMPANY_B_ID, SHARED_RAW_IDS.project);
    const as = (orgId: string) => baselineFor(deps, { orgId: orgId, project: SHARED_RAW_IDS.project, envRevision: 1, branch: "main", baseCommit: sha(5), ancestry: [] });
    expect(knownFailingOf((await as(COMPANY_A_ID))!.row)).toEqual(["only.a::x"]);
    expect(knownFailingOf((await as(COMPANY_B_ID))!.row)).toEqual(["only.b::y"]);
    expect(await as(`org_${"c".repeat(20)}`)).toBeUndefined();
    // The candidates of a company never name another company's commits.
    const candidates = (orgId: string) => baselineCandidatesOf(deps, { orgId: orgId, project: SHARED_RAW_IDS.project, envRevision: 1, branch: "main" });
    expect(await candidates(COMPANY_A_ID)).toEqual([sha(5)]);
    expect(await candidates(`org_${"c".repeat(20)}`)).toEqual([]);
    // A row copied under another company's key (a damaged or hostile store) says whose it is, and is not used.
    const copy = (await deps.store.get(baselineRowKey(COMPANY_A_ID, SHARED_RAW_IDS.project, 1, sha(5))))!;
    await deps.store.put({ item: { ...copy, ...baselineRowKey(`org_${"d".repeat(20)}` as never, SHARED_RAW_IDS.project, 1, sha(5)) } });
    expect(await as(`org_${"d".repeat(20)}`)).toBeUndefined();
  });

  it("a company's close deletes the whole partition: no baseline row survives it", async () => {
    const { store, deps } = world();
    await keep(deps, row({ headSha: sha(1) }));
    await keep(deps, row({ headSha: sha(2) }));
    const page = await store.query({ pk: projectPk(ORG, PROJECT), sk: { op: "beginsWith", prefix: "" } });
    for (const item of page.items) await store.delete({ key: { pk: item.pk, sk: item.sk } });
    expect(await find(deps, { baseCommit: sha(1) })).toBeUndefined();
    expect(await baselineCandidatesOf(deps, { orgId: ORG, project: PROJECT, envRevision: 1, branch: "main" })).toEqual([]);
  });

  it("an unreadable, truncated, future-dated, expired or mislabelled row excuses nothing", async () => {
    const { store, deps } = world();
    const put = (sk: string, item: Record<string, unknown>) => store.put({ item: { pk: projectPk(ORG, PROJECT), sk, entityType: "TEST_ENV_BASELINE_SHA", orgId: ORG, project: PROJECT, ...item } });
    const at = (n: number) => `TESTENV#BASELINE#SHA#00000001#${sha(n)}`;
    await put(at(1), { baseline: "garbage" });
    await put(at(2), { baseline: { ...row({ headSha: sha(2) }), failed: ["a.py::x"], tests: { total: 10, passed: 7, failed: 2, skipped: 1 } } });
    await put(at(3), { baseline: row({ headSha: sha(3), finishedAt: new Date(NOW + 3 * HOUR).toISOString() }) });
    await put(at(4), { baseline: row({ headSha: sha(4) }), [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(NOW / 1000) - 1 });
    await put(at(5), { baseline: row({ headSha: sha(6) }) });
    await put(at(6), { baseline: row({ headSha: sha(6), envRevision: 2 }) });
    await put(at(7), { baseline: { ...row({ headSha: sha(7) }), extra: true } });
    for (const n of [1, 2, 3, 4, 5, 6, 7]) expect(await find(deps, { baseCommit: sha(n) })).toBeUndefined();
    expect(await baselineCandidatesOf(deps, { orgId: ORG, project: PROJECT, envRevision: 1, branch: "main" })).toEqual([]);
    // A store that cannot be read is a miss, never "no failures".
    const broken = { now: () => NOW, store: wrapped(store, { get: () => Promise.reject(new Error("down")), query: () => Promise.reject(new Error("down")) }) };
    expect(await find(broken, { baseCommit: sha(1) })).toBeUndefined();
    expect(await baselineCandidatesOf(broken, { orgId: ORG, project: PROJECT, envRevision: 1, branch: "main" })).toEqual([]);
    // A set that is not whole excuses nothing, even if the row is otherwise fine; a clean row at the same key is used.
    await keep(deps, row({ headSha: sha(2) }));
    expect(await find(deps, { baseCommit: sha(2) })).toBeDefined();
  });

  it("a stored row older than the nightly's own 7 days is still the run at that commit: age is said, never hidden", async () => {
    const { deps } = world();
    await keep(deps, row({ finishedAt: new Date(NOW - 20 * 24 * HOUR).toISOString(), recordedAt: new Date(NOW - 20 * 24 * HOUR).toISOString() }));
    expect(await find(deps, { baseCommit: sha(1) })).toMatchObject({ commitsBack: 0, ageHours: 480 });
  });
});

describe("the candidates a task plan offers", () => {
  it("find the newest rows among more than a page of them, whatever order their commits sort in", async () => {
    const { store, deps } = world();
    // 130 rows; the newest five have the commits that sort LAST, so a single page of the first 100 rows by key would pick older ones.
    for (let n = 1; n <= 130; n += 1) await keep(deps, row({ headSha: sha(1000 - n), finishedAt: new Date(NOW - (n <= 5 ? n : 100 + n) * HOUR).toISOString(), recordedAt: new Date(NOW - HOUR).toISOString() }));
    expect((await store.query({ pk: projectPk(ORG as never, PROJECT), sk: { op: "beginsWith", prefix: "TESTENV#BASELINE#SHA#" }, limit: 100 })).cursor).toBeDefined();
    expect(await baselineCandidatesOf(deps, { orgId: ORG, project: PROJECT, envRevision: 1, branch: "main" })).toEqual([999, 998, 997, 996, 995].map((n) => sha(n)));
  });

  it("a row at the stated list limits (500 failing and 500 flaky tests, 200 characters each) is stored and found", async () => {
    const { deps } = world();
    // (At 500 characters each the two lists exceed the document store's 400 KiB limit, as they already do for the nightly's own history row: the record then logs and the night's own rows stand.)
    const id = (n: number) => `${"t".repeat(196)}${String(n).padStart(4, "0")}`;
    const big = row({ headSha: sha(40), tests: { total: 1_200, passed: 200, failed: 500, skipped: 500 }, failed: Array.from({ length: 500 }, (_, n) => id(n)), flaky: Array.from({ length: 500 }, (_, n) => id(1_000 + n)) });
    await keep(deps, big);
    const found = await find(deps, { baseCommit: sha(40) });
    expect(found?.row.failed).toHaveLength(500);
    expect(found?.row.flaky).toHaveLength(500);
    expect(knownFailingOf(found!.row)).toHaveLength(500);
  });

  it("are the newest five usable rows of the revision and branch, newest first, shas only", async () => {
    const { deps } = world();
    for (let n = 1; n <= 7; n += 1) await keep(deps, row({ headSha: sha(n), finishedAt: new Date(NOW - (10 - n) * HOUR).toISOString() }));
    await keep(deps, row({ headSha: sha(20), envRevision: 2 }));
    await keep(deps, row({ headSha: sha(21), branch: "release" }));
    const found = await baselineCandidatesOf(deps, { orgId: ORG, project: PROJECT, envRevision: 1, branch: "main" });
    expect(found).toEqual([sha(7), sha(6), sha(5), sha(4), sha(3)]);
    expect(await baselineCandidatesOf(deps, { orgId: ORG, project: PROJECT, envRevision: 3, branch: "main" })).toEqual([]);
  });
});
