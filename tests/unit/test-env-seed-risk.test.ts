// a seed command DETECTED UNCHANGED from the repository's own script, run only on Rovara's sealed test database, is MEDIUM (one maintainer approves); anything else stays HIGH.
// The broker locks it from the repository itself (never the worker's word), stores its own checks with the proposal, and the approval reads them again from the store.
import { describe, expect, it } from "vitest";
import { TestEnvironmentBodySchema, projectPk, seedScriptLockOf, testEnvApprovalRisk, testEnvLessSafeChanges, type OrgId, type TestEnvironmentBody } from "@rovara-code/contracts";
import { TEST_ENVIRONMENT_KIND, proposalSeedTrust, proposeTestEnvironment, testEnvironmentSubjectId } from "../../packages/core/src/core/test-env/environment.js";
import { lockLookSeeds, seedCardLinesOf, seedRisksOf, seedTrustOf, treeReader, type SeedRepoSources } from "../../packages/core/src/core/test-env/seed-lock.js";
import { taskDependencyPlansOf } from "../../packages/core/src/core/test-env/dependency-plan.js";
import { TaskDependencyPlanSchema } from "@rovara-code/contracts";
import { pinnedCatalog, verifiedCatalog } from "../support/catalog-pinning.js";
import { BENCH_ORG, bench } from "../support/test-env-bench.js";

const ORG: OrgId = BENCH_ORG;
const PROJECT = "web";
const cmd = (executable: string, args: string[] = [], cwd = "repo/web") => ({ cwd, executable, args, timeoutSeconds: 900 });
const SEED = cmd("npm", ["run", "seed"]);
const dep = (over: Record<string, unknown> = {}) => ({
  id: "postgres", name: "Postgres", kind: "database", family: "postgres", found: [{ path: "docker-compose.yml", line: 4 }], usedBy: ["integration"],
  backing: { kind: "local", catalogId: "postgres@16", config: { database: "app", user: "app" } },
  connect: { env: [{ name: "DATABASE_URL", template: "postgres://{user}:{password}@{host}:{port}/{db}" }], hostAliases: ["postgres"] }, seeds: [{ command: SEED }], reset: "fresh_per_round", ...over,
});
const body = (dependencies: unknown[] = [dep()], over: Record<string, unknown> = {}): TestEnvironmentBody => TestEnvironmentBodySchema.parse({
  tier: "sandbox", repos: [{ repositoryId: "web", setupCommands: [], checks: [{ id: "unit", label: "Unit tests", command: cmd("npm", ["test"]), kind: "test" }] }], roundBudgetMin: 30,
  selection: { method: "full", alwaysRun: [], fullSuiteOn: [] }, nightly: { enabled: false, cronUtc: "0 6 * * *", branch: "main" }, services: [], data: { seeds: [], generator: "faker_seeded", seed: 1 }, accounts: [],
  prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] }, capture: { screenshots: "failed", video: false, traces: false }, dependencies, ...over,
});
const detected = [{ command: SEED, source: { path: "package.json", line: 4 } }];

/** The repository as the code host gives it: one tree listing and file reads at one commit (repository-relative paths). */
const FILES: Record<string, string> = { "package.json": JSON.stringify({ scripts: { seed: "node db/seed.js" } }), "db/seed.js": "const { Client } = require('pg');\n" };
function sources(files: Record<string, string> = FILES, options: { failRead?: boolean; failAll?: boolean } = {}): SeedRepoSources & { reads: string[] } {
  const reads: string[] = [];
  const entries = Object.keys(files).map((path) => ({ path, mode: "100644", type: "blob" }));
  const fn: SeedRepoSources = async () => {
    if (options.failAll === true) throw new Error("GitHub is down");
    return [{ path: "repo/web", branch: "main", commit: "c".repeat(40), readerAt: (directory: string) => treeReader(entries, directory, async (path) => { reads.push(path); if (options.failRead === true) throw new Error("HTTP 502"); return files[path]; }) }];
  };
  return Object.assign(fn, { reads });
}

const world = () => bench({ project: PROJECT, startMs: Date.UTC(2026, 10, 7, 10, 0, 0) });
type World = Awaited<ReturnType<typeof world>>;
async function proposeAndProve(h: World, environment: TestEnvironmentBody, seedChecks?: Parameters<typeof proposeTestEnvironment>[1]["seedChecks"]) {
  return h.proposeAndProve(environment, seedChecks === undefined ? {} : { seedChecks });
}
/** What the approval gate says the proposal is graded now, from the stored proposal (the broker's own checks are read again from the store). */
const riskOf = async (h: World, digest: string): Promise<string | undefined> => (await h.gate.requirement(ORG, TEST_ENVIRONMENT_KIND, testEnvironmentSubjectId(PROJECT, digest)))?.risk;
const scope = { orgId: ORG, project: PROJECT };

describe("a detected seed command, unchanged from the repository, on the sealed test database", () => {
  it("is locked by the broker from the repository and is MEDIUM: one maintainer approves with one press", async () => {
    const source = sources();
    const locked = await lockLookSeeds(body(), detected, source, scope);
    const seed = locked.body.dependencies![0]!.seeds[0]!;
    expect("command" in seed && seed.lock?.from).toEqual(["db/seed.js", "package.json"]);
    expect(source.reads).toEqual(["package.json", "db/seed.js"]);
    // M4: the check keeps the branch and the commit the broker hashed.
    expect(locked.checks).toEqual([expect.objectContaining({ verdict: "locked", dependencyId: "postgres", branch: "main", commit: "c".repeat(40) })]);
    const h = await world();
    const proposed = await proposeAndProve(h, locked.body, locked.checks);
    expect(proposed).toMatchObject({ risk: "medium", lessSafe: [] });
    // The approval reads the broker's checks again from the proposal item: it is graded medium there too, and one press of the owner's session approves it.
    expect(await riskOf(h, proposed.digest)).toBe("medium");
    expect(await h.approve(proposed.digest)).toMatchObject({ status: "decided", result: { revision: 1, lessSafe: [] } });
    // I3: the reason says who approves and what reach it has; it never claims the seed is isolated.
    const reason = seedRisksOf(locked.checks, locked.body)[0]!;
    expect(reason).toMatchObject({ dependencyId: "postgres", risk: "medium" });
    expect(reason.reason).toBe(`Medium: one maintainer can approve it. The seed runs the repository's own script, unchanged on main at ${"c".repeat(12)} (2 files). Rovara checks those files again before every run. It runs against Rovara's throwaway test database, with the same access as your setup commands (in the working phase it can reach the internet).`);
    expect(reason.reason).not.toMatch(/only on the test database|second person/u);
    // R2: with the most files a lock holds, who approves still survives the 400-character cut.
    const many = locked.checks.map((check) => (check.verdict === "locked" ? { ...check, from: Array.from({ length: 32 }, (_, at) => `seeds/${"x".repeat(200)}-${String(at)}.js`) } : check));
    expect(seedRisksOf(many, locked.body)[0]!.reason).toMatch(/^Medium: one maintainer can approve it\. .*\(32 files\)/u);
    expect(seedCardLinesOf([reason], locked.checks, locked.body)).toEqual(["Seed: the repository's own script, unchanged on main (db/seed.js, package.json).", "One maintainer approves; it has the same access as setup and is rechecked each run."]);
  });

  it("positive control: the same locked body stored WITHOUT the broker's checks (an edit) is HIGH and the one-press approval is refused", async () => {
    const locked = await lockLookSeeds(body(), detected, sources(), scope);
    const h = await world();
    const proposed = await proposeAndProve(h, locked.body);
    expect(proposed).toMatchObject({ risk: "high", lessSafe: ["dependency_seed"] });
    // High: a code host comment may not approve it, only a strong method may.
    expect(await riskOf(h, proposed.digest)).toBe("high");
    expect(await h.approve(proposed.digest, 0, { credentials: [{ method: "code-host-comment", token: "comment-1" }] })).toMatchObject({ status: "refused" });
    expect(seedRisksOf([], locked.body)[0]!.reason).toMatch(/^Seed is high risk: it was set or changed by a person/u);
  });
});

describe("everything else stays HIGH", () => {
  it("a seed whose source is the model (or a setup run) is HIGH whatever its text, and nothing is read", async () => {
    for (const source of ["model", "person", "recipe:shared-node@1"]) {
      const repo = sources();
      const locked = await lockLookSeeds(body(), [{ command: SEED, source }], repo, scope);
      expect(locked.checks).toEqual([expect.objectContaining({ verdict: "high", reason: "not_detected" })]);
      expect(repo.reads).toEqual([]);
      expect(testEnvApprovalRisk(locked.body, seedTrustOf(locked.checks, locked.body))).toBe("high");
    }
  });

  it("an edited command (not the one the detectors found) is HIGH", async () => {
    const edited = body([dep({ seeds: [{ command: cmd("npm", ["run", "seed:all"]) }] })]);
    const locked = await lockLookSeeds(edited, detected, sources({ ...FILES, "package.json": JSON.stringify({ scripts: { "seed:all": "node db/seed.js" } }) }), scope);
    expect(locked.checks).toEqual([expect.objectContaining({ verdict: "high", reason: "not_detected" })]);
    expect(testEnvLessSafeChanges(undefined, locked.body, seedTrustOf(locked.checks, locked.body))).toEqual(["dependency_seed"]);
  });

  it("a broker read failure is HIGH: the code host down, or a file read that fails", async () => {
    for (const repo of [sources(FILES, { failAll: true }), sources(FILES, { failRead: true }), undefined]) {
      const locked = await lockLookSeeds(body(), detected, repo, scope);
      expect(locked.checks[0]).toMatchObject({ verdict: "high" });
      expect(locked.body.dependencies![0]!.seeds[0]).toEqual({ command: SEED });
      expect(testEnvApprovalRisk(locked.body, seedTrustOf(locked.checks, locked.body))).toBe("high");
    }
  });

  it("a hash the worker (or anyone) wrote into the body is ignored: the broker drops it and hashes the repository itself", async () => {
    const forged = body([dep({ seeds: [{ command: SEED, lock: { version: 1, hash: "f".repeat(64), from: ["package.json"] } }] })]);
    const locked = await lockLookSeeds(forged, detected, sources(), scope);
    const own = await seedScriptLockOf(SEED, treeReader(Object.keys(FILES).map((path) => ({ path, mode: "100644", type: "blob" })), "", async (path) => FILES[path]));
    const seed = locked.body.dependencies![0]!.seeds[0]!;
    expect(own.ok && "command" in seed && seed.lock?.hash).toBe(own.ok ? own.lock.hash : "x");
    expect("command" in seed && seed.lock?.hash).not.toBe("f".repeat(64));
    // And a forged lock never matches a broker check: the honest checks do not verify the forged body.
    expect(testEnvApprovalRisk(forged, seedTrustOf(locked.checks, forged))).toBe("high");
  });

  it("a seed that could reach anything but the sealed test database is HIGH (a fake behind it, another tier), even with a broker check stored for it", async () => {
    const fakeWorking = body([dep({ workingBacking: { kind: "fake", fixtureSetRef: "a".repeat(64), unmatched: "fail" } })]);
    const locked = await lockLookSeeds(fakeWorking, detected, sources(), scope);
    expect(locked.checks).toEqual([expect.objectContaining({ verdict: "high", reason: "not_sealed" })]);
    // Defence in depth: a check that says `locked` does not lower a body whose target is not sealed (the contract judges the target again).
    const good = await lockLookSeeds(body(), detected, sources(), scope);
    const lockedSeed = good.body.dependencies![0]!.seeds[0]!;
    const unsealed = body([dep({ seeds: [lockedSeed], workingBacking: { kind: "fake", fixtureSetRef: "a".repeat(64), unmatched: "fail" } })]);
    expect(testEnvApprovalRisk(unsealed, seedTrustOf(good.checks, unsealed))).toBe("high");
    expect(testEnvLessSafeChanges(undefined, unsealed, seedTrustOf(good.checks, unsealed))).toEqual(["dependency_seed"]);
    expect(seedRisksOf(good.checks, unsealed)[0]!.risk).toBe("high");
  });

  it("a damaged check record on the proposal item verifies nothing", async () => {
    const locked = await lockLookSeeds(body(), detected, sources(), scope);
    const h = await world();
    const proposed = await proposeAndProve(h, locked.body, locked.checks);
    const key = { pk: projectPk(ORG, PROJECT), sk: `TESTENV#PROPOSAL#${proposed.digest}` };
    const item = (await h.store.get(key))!;
    await h.store.put({ item: { ...item, seedChecks: [{ verdict: "locked", dependencyId: "postgres" }] } });
    expect((await proposalSeedTrust(h.deps, ORG, PROJECT, proposed.digest, locked.body)).verifiedSeeds?.size ?? 0).toBe(0);
    expect(await riskOf(h, proposed.digest)).toBe("high");
  });

  it("M2: a seed in a repository that could not be read never falls through to the repository above it", async () => {
    const nested = body([dep({ seeds: [{ command: cmd("npm", ["run", "seed"], "repo/web/packages/db") }] })]);
    const entries = [{ path: "packages/db/package.json", mode: "100644", type: "blob" }, { path: "packages/db/db/seed.js", mode: "100644", type: "blob" }];
    const files: Record<string, string> = { "packages/db/package.json": FILES["package.json"]!, "packages/db/db/seed.js": FILES["db/seed.js"]! };
    const both: SeedRepoSources = async () => [
      { path: "repo/web", branch: "main", commit: "c".repeat(40), readerAt: (directory: string) => treeReader(entries, directory, async (path) => files[path]) },
      { path: "repo/web/packages/db", refusal: "no_reader" },
    ];
    const locked = await lockLookSeeds(nested, [{ command: cmd("npm", ["run", "seed"], "repo/web/packages/db"), source: { path: "package.json", line: 4 } }], both, scope);
    expect(locked.checks).toEqual([expect.objectContaining({ verdict: "high", reason: "no_reader" })]);
    const branch: SeedRepoSources = async () => [{ path: "repo/web", refusal: "not_default_branch" }];
    expect((await lockLookSeeds(body(), detected, branch, scope)).checks).toEqual([expect.objectContaining({ verdict: "high", reason: "not_default_branch" })]);
  });

  it("an identical body proposed again by an edit loses the broker's checks, and a setup run's mark keeps the one-press approval refused", async () => {
    const locked = await lockLookSeeds(body(), detected, sources(), scope);
    const h = await world();
    const first = await proposeAndProve(h, locked.body, locked.checks);
    expect(first.risk).toBe("medium");
    const again = await proposeAndProve(h, locked.body);
    expect(again).toMatchObject({ digest: first.digest, risk: "high", lessSafe: ["dependency_seed"] });
    const run = await world();
    const marked = await proposeTestEnvironment(run.deps, { orgId: ORG, project: PROJECT, proposedBy: "dev_a", body: locked.body, seedChecks: locked.checks, origin: "setup_run" });
    await run.prove(marked.digest, locked.body);
    // A setup run's mark makes the card high whatever its checks say: a comment may not approve it.
    expect(await riskOf(run, marked.digest)).toBe("high");
    expect(await run.approve(marked.digest, 0, { credentials: [{ method: "code-host-comment", token: "comment-1" }] })).toMatchObject({ status: "refused" });
  });

  it("the approved environment's dispatched plan still carries the lock", async () => {
    const locked = await lockLookSeeds(body(), detected, sources(), scope);
    const result = taskDependencyPlansOf({ body: locked.body, catalog: verifiedCatalog(pinnedCatalog()), edition: "public", approvedSeedFiles: [] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const plan = TaskDependencyPlanSchema.parse(result.dependencies.find((entry) => entry.id === "postgres"));
    const seed = locked.body.dependencies![0]!.seeds[0]!;
    expect(plan.seeds).toEqual([{ command: SEED, lock: "command" in seed ? seed.lock : undefined }]);
  });
});
