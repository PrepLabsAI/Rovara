// Test services: a setup draft's dependency candidates become PROPOSED dependencies (through the backing chooser, real catalog software only), and the card lines say what backs each one plainly.
import { describe, expect, it } from "vitest";
import { TEST_ENV_DRAFT_RESULT_KEY, TestEnvironmentBodySchema, type OrgId, type TestEnvDraft, type TestEnvironmentBody } from "@agentx/contracts";
import { DEPENDENCIES_LEFT_OUT_NOTE, DEPENDENCIES_NO_CATALOG_NOTE, DEPENDENCIES_NOT_PROPOSED_NOTE } from "../../packages/broker/src/core/test-env/dependency-proposal.js";
import { dependencyCardLines } from "../../packages/broker/src/core/test-env/dependency-card-lines.js";
import { sanitizeTestEnvDraft, testEnvDraftEndItems } from "../../packages/broker/src/core/test-env/draft.js";
import { TEST_SERVICES_MIN_CATALOG_REVISION } from "../../packages/broker/src/core/test-env/dependency-plan.js";
import { pinnedCatalog, unpinnedCatalog, verifiedCatalog } from "../support/catalog-pinning.js";

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
    const off = sanitizeTestEnvDraft(draftOf([candidate("postgres")]), options("none", { ROVARA_TEST_ENVIRONMENT: "1" }))!;
    expect(off).toEqual(sanitizeTestEnvDraft(draftOf())!);
    expect(sanitizeTestEnvDraft(draftOf([candidate("postgres")]))).toEqual(sanitizeTestEnvDraft(draftOf()));
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
    expect(stored({ ROVARA_TEST_ENVIRONMENT: "1" })).toEqual(sanitizeTestEnvDraft(draftOf()));
    expect("dependencies" in stored({ ROVARA_TEST_ENVIRONMENT: "1" })!).toBe(false);
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
      candidate("postgres"), candidate("aws:sns"), candidate("http:api.example-pay.com", { kind: "http_api" }), candidate("redis", { hints: { fakedByTests: true } }),
    ]), options())!;
    expect(draft.environment.dependencies!.map((entry) => entry.id)).toEqual(["postgres"]);
    expect(draft.notes.filter((note) => note === DEPENDENCIES_NOT_PROPOSED_NOTE)).toHaveLength(1);
    expect(draft.notes.join(" ")).not.toMatch(/example-pay|sns/iu);
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

