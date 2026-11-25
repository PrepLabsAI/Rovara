// Test services: a setup draft's dependency candidates become PROPOSED dependencies (through the backing chooser, real catalog software only), and the card lines say what backs each one plainly.
import { describe, expect, it } from "vitest";
import { TestEnvironmentBodySchema, type TestEnvironmentBody } from "@agentx/contracts";
import { DEPENDENCIES_LEFT_OUT_NOTE, DEPENDENCIES_NO_CATALOG_NOTE, DEPENDENCIES_NOT_PROPOSED_NOTE } from "../../packages/broker/src/core/test-env/dependency-proposal.js";
import { sanitizeTestEnvDraft } from "../../packages/broker/src/core/test-env/draft.js";
import { TEST_SERVICES_MIN_CATALOG_REVISION } from "../../packages/broker/src/core/test-env/dependency-plan.js";
import { pinnedCatalog, unpinnedCatalog, verifiedCatalog } from "../support/catalog-pinning.js";

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

  it("proposes only what the catalog has PINNED: an unpinned catalog proposes nothing", () => {
    const draft = sanitizeTestEnvDraft(draftOf([candidate("postgres")]), options(verifiedCatalog(unpinnedCatalog(TEST_SERVICES_MIN_CATALOG_REVISION))))!;
    expect(draft.environment.dependencies).toBeUndefined();
    expect(draft.notes).toContain(DEPENDENCIES_NOT_PROPOSED_NOTE);
  });

  it("proposes nothing when the candidates cannot be proposed together", () => {
    // mysql and postgres both set DATABASE_URL: two dependencies that set the same variable are not a list the contract accepts.
    const draft = sanitizeTestEnvDraft(draftOf([candidate("postgres"), candidate("mysql", { hints: { version: "8" } })]), options())!;
    expect(draft.environment.dependencies).toBeUndefined();
    expect(draft.notes).toContain(DEPENDENCIES_LEFT_OUT_NOTE);
  });

});


