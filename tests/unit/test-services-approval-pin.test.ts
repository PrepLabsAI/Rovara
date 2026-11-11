// Test services: at approval, a `local` dependency whose catalog entry has no pinned digest gets the same fixed "not available yet" words as any backing cannot start.
import { describe, expect, it } from "vitest";
import { TestEnvironmentBodySchema, type OrgId } from "@agentx/contracts";
import { TEST_SERVICES_MIN_CATALOG_REVISION, isPrepulledEntry, taskDependencyPlansOf } from "../../packages/broker/src/core/test-env/dependency-plan.js";
import type { TestEnvDeps } from "../../packages/broker/src/core/test-env/deps.js";
import { proposeTestEnvironment } from "../../packages/broker/src/core/test-env/environment.js";
import { digestOfId, pinnedCatalog, unpinnedCatalog, verifiedCatalog } from "../support/catalog-pinning.js";
import { projectStore } from "../support/test-env-world.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const PROJECT = "service";
const ON = { ROVARA_TEST_ENVIRONMENT: "1", ROVARA_TEST_SERVICES: "1" };
const cmd = (executable: string, args: string[] = []) => ({ cwd: "service", executable, args, timeoutSeconds: 600 });
const postgres = {
  id: "postgres", name: "Postgres", kind: "database", family: "postgres", found: [{ path: "docker-compose.yml", line: 4 }], usedBy: ["integration"], backing: { kind: "local", catalogId: "postgres@16", config: {} },
  connect: { env: [{ name: "DATABASE_URL", template: "postgres://{user}:{password}@{host}:{port}/{db}" }], hostAliases: ["postgres"] }, seeds: [], reset: "fresh_per_round",
};
const body = () => TestEnvironmentBodySchema.parse({
  tier: "sandbox", repos: [{ repositoryId: "service", setupCommands: [], checks: [{ id: "unit", label: "Unit tests", command: cmd("pytest", ["-q"]), kind: "test" }] }], roundBudgetMin: 30,
  selection: { method: "full", alwaysRun: [], fullSuiteOn: [] }, nightly: { enabled: false, cronUtc: "0 6 * * *", branch: "main" }, services: [], data: { seeds: [], generator: "faker_seeded", seed: 1 }, accounts: [],
  prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] }, capture: { screenshots: "failed", video: false, traces: false }, dependencies: [postgres],
});
async function deps(serviceCatalog?: () => Promise<ReturnType<typeof verifiedCatalog>>): Promise<TestEnvDeps> {
  const store = await projectStore(ORG, PROJECT);
  return { store, now: () => Date.UTC(2026, 10, 3, 10, 0, 0), env: ON, ...(serviceCatalog === undefined ? {} : { serviceCatalog }) };
}
const propose = (d: TestEnvDeps) => proposeTestEnvironment(d, { orgId: ORG, project: PROJECT, proposedBy: "dev_a", body: body() });

const bodyFor = (catalogId: string) => TestEnvironmentBodySchema.parse({ ...body(), dependencies: [{ ...postgres, backing: { kind: "local", catalogId, config: {} } }] });

describe("a pinned entry and the worker's pre-pull list", () => {
  it("is startable at approval for every pinned local entry, not only the default: postgres@15, @16 and @17 are all pre-pulled", async () => {
    const source = async () => verifiedCatalog(pinnedCatalog());
    for (const catalogId of ["postgres@15", "postgres@16", "postgres@17"]) {
      await expect(proposeTestEnvironment(await deps(source), { orgId: ORG, project: PROJECT, proposedBy: "dev_a", body: bodyFor(catalogId) }), catalogId).resolves.toBeDefined();
    }
  });
  it("plans every pinned local entry, and a retired or not-yet-pinned one is refused with the fixed words", () => {
    const catalog = verifiedCatalog(pinnedCatalog());
    for (const catalogId of ["postgres@15", "postgres@16", "postgres@17"]) {
      expect(taskDependencyPlansOf({ body: bodyFor(catalogId), catalog, edition: "public", projectId: PROJECT }).ok, catalogId).toBe(true);
    }
    const retired = verifiedCatalog(pinnedCatalog((entries) => { entries.find((entry) => entry["id"] === "postgres@15")!["status"] = "retired"; }));
    const result = taskDependencyPlansOf({ body: bodyFor("postgres@15"), catalog: retired, edition: "public", projectId: PROJECT });
    expect(result.ok).toBe(false);
  });
  it("keeps refusing what the worker would not have pulled: an entry missing from the pre-pull list is 'not available yet' at approval and at plan time", async () => {
    // A catalog with more images than a worker pre-pulls has no list at all (the schema's cap), so nothing in it is pre-pulled, and no error escapes.
    const many = pinnedCatalog((entries) => {
      const template = entries.find((entry) => entry["id"] === "redis@7")!;
      for (let index = 0; index < 20; index += 1) {
        const copy = structuredClone(template);
        copy["id"] = `redis@9${String(index)}`;
        copy["version"] = `9${String(index)}`;
        const image = copy["image"] as { digest?: string };
        image.digest = digestOfId(copy["id"] as string);
        entries.push(copy);
      }
    });
    const catalog = verifiedCatalog(many);
    expect(isPrepulledEntry(catalog, "postgres@16")).toBe(false);
    await expect(proposeTestEnvironment(await deps(async () => catalog), { orgId: ORG, project: PROJECT, proposedBy: "dev_a", body: bodyFor("postgres@16") })).rejects.toThrow(/not available yet/u);
    const result = taskDependencyPlansOf({ body: bodyFor("postgres@16"), catalog, edition: "public", projectId: PROJECT });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_available_yet");
  });
});

describe("a local dependency without a pinned digest at approval", () => {
  it("is refused with the fixed 'not available yet' words when the catalog does not pin it", async () => {
    await expect(propose(await deps(async () => verifiedCatalog(unpinnedCatalog(TEST_SERVICES_MIN_CATALOG_REVISION))))).rejects.toThrow(/not available yet/u);
  });
  it("is proposed when the catalog pins it, and when no catalog is at hand (the task's plan then judges it)", async () => {
    await expect(propose(await deps(async () => verifiedCatalog(pinnedCatalog())))).resolves.toMatchObject({ digest: expect.stringMatching(/^[a-f0-9]{64}$/u) as string });
    await expect(propose(await deps())).resolves.toBeDefined();
    await expect(propose(await deps(async () => { throw new Error("unreadable"); }))).resolves.toBeDefined();
  });
});
