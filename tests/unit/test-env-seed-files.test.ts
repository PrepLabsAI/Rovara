// A seed FILE is approved as the content the proposal's check loaded: the approval binds its hash, and a file the check did not load (or loaded with other content) is not approved.
 
import { describe, expect, it } from "vitest";
import { TestEnvironmentBodySchema, type TestEnvironmentBody } from "@agentx/contracts";
import { SEED_FILE_UNCHECKED, boundSeedFilesOf, readApprovedSeedFiles } from "../../packages/broker/src/core/test-env/environment.js";
import { BENCH_ORG, bench } from "../support/test-env-bench.js";

const PROJECT = "service";
const HASH = "a".repeat(64);
const cmd = (executable: string, args: string[] = []) => ({ cwd: "service", executable, args, timeoutSeconds: 600 });
const dependency = (seeds: unknown[]) => ({
  id: "postgres", name: "Postgres", kind: "database", family: "postgres", found: [{ path: "docker-compose.yml", line: 4 }], usedBy: ["integration"],
  backing: { kind: "local", catalogId: "postgres@16", config: { database: "app", user: "app" } },
  connect: { env: [{ name: "DATABASE_URL", template: "postgres://{user}:{password}@{host}:{port}/{db}" }], hostAliases: ["postgres"] }, seeds, reset: "fresh_per_round",
});
const body = (seeds: unknown[]): TestEnvironmentBody => TestEnvironmentBodySchema.parse({
  tier: "sandbox", repos: [{ repositoryId: "service", setupCommands: [], checks: [{ id: "unit", label: "Unit tests", command: cmd("pytest", ["-q"]), kind: "test" }] }], roundBudgetMin: 30,
  selection: { method: "full", alwaysRun: [], fullSuiteOn: [] }, nightly: { enabled: false, cronUtc: "0 6 * * *", branch: "main" }, services: [], data: { seeds: [], generator: "faker_seeded", seed: 1 }, accounts: [],
  prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] }, capture: { screenshots: "failed", video: false, traces: false }, dependencies: [dependency(seeds)],
});
const withFile = () => body([{ fixturePath: "db/fixture.sql" }]);

describe("the seed files an approval binds", () => {
  it("binds only the body's own file seeds, each to a well-formed hash, and answers undefined when one has none", () => {
    expect(boundSeedFilesOf(withFile(), [{ id: "postgres", path: "db/fixture.sql", sha256: HASH }])).toEqual([{ id: "postgres", path: "db/fixture.sql", sha256: HASH }]);
    // A hash for a file the body does not seed is dropped.
    expect(boundSeedFilesOf(withFile(), [{ id: "postgres", path: "db/fixture.sql", sha256: HASH }, { id: "postgres", path: "other.sql", sha256: HASH }])).toHaveLength(1);
    for (const hashes of [undefined, [], [{ id: "postgres", path: "other.sql", sha256: HASH }], [{ id: "other", path: "db/fixture.sql", sha256: HASH }], [{ id: "postgres", path: "db/fixture.sql", sha256: "not-a-hash" }]]) {
      expect(boundSeedFilesOf(withFile(), hashes), JSON.stringify(hashes)).toBeUndefined();
    }
    // A body with no file seed needs none.
    expect(boundSeedFilesOf(body([{ command: cmd("npm", ["run", "seed"]) }]), undefined)).toEqual([]);
  });

  it("an approval without the hashes of the files the check loaded is refused in fixed words, and nothing is approved", async () => {
    const h = await bench({ project: PROJECT });
    const proposed = await h.proposeAndProve(withFile());
    expect(await h.approve(proposed.digest)).toMatchObject({ status: "refused", reason: "invalid", detail: SEED_FILE_UNCHECKED });
    expect(await h.approve(proposed.digest, 0, { details: { seedFileHashes: [{ id: "postgres", path: "elsewhere.sql", sha256: HASH }] } })).toMatchObject({ status: "refused", detail: SEED_FILE_UNCHECKED });
    expect(await readApprovedSeedFiles(h.deps, BENCH_ORG, PROJECT, 1)).toEqual([]);
  });

  it("an approval with the hashes stores them with the revision, and a later read returns exactly those", async () => {
    const h = await bench({ project: PROJECT });
    const proposed = await h.proposeAndProve(withFile());
    expect(await h.approve(proposed.digest, 0, { details: { seedFileHashes: [{ id: "postgres", path: "db/fixture.sql", sha256: HASH }] } })).toMatchObject({ status: "decided", result: { revision: 1 } });
    expect(await readApprovedSeedFiles(h.deps, BENCH_ORG, PROJECT, 1)).toEqual([{ id: "postgres", path: "db/fixture.sql", sha256: HASH }]);
    expect(await readApprovedSeedFiles(h.deps, BENCH_ORG, PROJECT, 2)).toEqual([]);
  });
});
