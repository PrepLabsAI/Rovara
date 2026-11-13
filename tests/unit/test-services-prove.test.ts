// Test services: the Prove of an environment with dependencies. The two new steps ("start dependencies", "dependency usage check") are derived by the broker from the usage record the candidate check
// reported; a check with no record proves nothing about them; an environment with dependencies is proved only when both passed; the record is kept, validated, on the candidate check; the plan for the check is pinned.
import { describe, expect, it } from "vitest";
import { INDEX_EXPIRY_ATTRIBUTE, TEST_ENV_REFUSALS, projectRevisionKey, TestEnvironmentBodySchema, TestEnvProveReportSchema, testEnvDigest, testEnvIsProved, type OrgId, type TestServicesUsageRecord } from "@rovara-code/contracts";
import { candidateDependencyPlan } from "../../packages/core/src/core/test-env/candidate-plan.js";
import { CANDIDATE_CHECK_ENTITY, candidateCheckKey, readCandidateCheck, recordCandidateUsage } from "../../packages/core/src/core/test-env/candidate-check.js";
import { BACKING_PLACES } from "../../packages/core/src/core/test-env/backing-choice.js";
import { DEPENDENCY_PLAN_REFUSAL_WORDS } from "../../packages/core/src/core/test-env/dependency-plan.js";
import { TEST_ENV_REFUSAL_WORDS, dependencyStepsOf, proveReportFromSetupCheck } from "../../packages/core/src/core/test-env/prove-from-setup-check.js";
import { pinnedCatalog, verifiedCatalog } from "../support/catalog-pinning.js";
import { MemoryDocumentStore } from "../../packages/core/src/ports/memory-document-store.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const fresh = (): MemoryDocumentStore => new MemoryDocumentStore();
const PROJECT = "service";
const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);
const ON = { ROVARA_TEST_ENVIRONMENT: "1", ROVARA_TEST_SERVICES: "1" };
const cmd = (executable: string, args: string[] = [], cwd = "service") => ({ cwd, executable, args, timeoutSeconds: 600 });
const postgres = {
  id: "postgres", name: "Postgres", kind: "database", family: "postgres", found: [{ path: "docker-compose.yml", line: 4 }], usedBy: ["integration"], backing: { kind: "local", catalogId: "postgres@16", config: {} },
  connect: { env: [{ name: "DATABASE_URL", template: "postgres://{user}:{password}@{host}:{port}/{db}" }], hostAliases: ["postgres"] }, seeds: [], reset: "fresh_per_round",
};
const body = (dependencies?: unknown[]) => TestEnvironmentBodySchema.parse({
  tier: "sandbox", repos: [{ repositoryId: "service", setupCommands: [], checks: [{ id: "unit", label: "Unit tests", command: cmd("pytest", ["-q"]), kind: "test" }] }], roundBudgetMin: 30,
  selection: { method: "full", alwaysRun: [], fullSuiteOn: [] }, nightly: { enabled: false, cronUtc: "0 6 * * *", branch: "main" }, services: [], data: { seeds: [], generator: "faker_seeded", seed: 1 }, accounts: [],
  prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] }, capture: { screenshots: "failed", video: false, traces: false }, ...(dependencies === undefined ? {} : { dependencies }),
});
const usage = (over: Partial<TestServicesUsageRecord> = {}): TestServicesUsageRecord => ({ schemaVersion: 1, dependencies: [{ id: "postgres", started: true, healthy: true, startMs: 840, resetCount: 1 }], unknownCalls: { domains: [], otherCount: 0 }, ...over });
const ready = { status: "ready" as const, checkedRevision: 4, checkedAt: new Date(NOW - 3_600_000).toISOString() };
const definition = { revision: 4, setup: [], readiness: [cmd("pytest", ["-q"])] };
const derive = (environment = body([postgres]), record: TestServicesUsageRecord | "none" = usage()) => proveReportFromSetupCheck({ environment, definition, setup: ready, nowMs: NOW, usage: record === "none" ? undefined : record });
const stepsOf = (result: ReturnType<typeof derive>) => (result.ok ? Object.fromEntries(result.report.steps.map((step) => [step.step, step.status])) : undefined);

describe("the two dependency steps", () => {
  it("pass when every dependency started healthy and no unknown name was called", () => {
    const result = derive();
    expect(stepsOf(result)).toEqual({ setup: "skipped", build: "skipped", smoke: "skipped", full_suite: "passed", dependencies: "passed", dependency_usage: "passed" });
    if (!result.ok) throw new Error("not derived");
    expect(result.report.steps.find((step) => step.step === "dependencies")?.durationMs).toBe(840);
    expect(TestEnvProveReportSchema.safeParse(result.report).success).toBe(true);
    expect(testEnvIsProved(result.report, result.report.proposalDigest, body([postgres]))).toBe(true);
  });

  it("fail, in fixed words, when a dependency did not start or was not healthy", () => {
    for (const record of [
      usage({ dependencies: [{ id: "postgres", started: false, healthy: false, startMs: 0, resetCount: 0, failure: "pull_failed" }] }),
      usage({ dependencies: [{ id: "postgres", started: true, healthy: false, startMs: 30_000, resetCount: 0, failure: "not_healthy" }] }),
      usage({ dependencies: [{ id: "postgres", started: true, healthy: true, startMs: 5, resetCount: 0, failure: "seed_failed" }] }),
      usage({ dependencies: [] }),
    ]) {
      const result = derive(body([postgres]), record);
      expect(stepsOf(result)).toMatchObject({ dependencies: "failed", dependency_usage: "passed" });
      if (!result.ok) throw new Error("not derived");
      expect(result.report.steps.find((step) => step.step === "dependencies")?.failure).toBe("dependency_start_failed");
      expect(testEnvIsProved(result.report, result.report.proposalDigest, body([postgres]))).toBe(false);
    }
  });

  it("fail when a test called a name no dependency answers", () => {
    const result = derive(body([postgres]), usage({ unknownCalls: { domains: [{ domain: "example-pay.com", count: 1 }], otherCount: 0 } }));
    expect(stepsOf(result)).toMatchObject({ dependencies: "passed", dependency_usage: "failed" });
    if (!result.ok) throw new Error("not derived");
    expect(result.report.steps.find((step) => step.step === "dependency_usage")?.failure).toBe("dependency_unexpected_call");
    // Hidden names count too.
    expect(stepsOf(derive(body([postgres]), usage({ unknownCalls: { domains: [], otherCount: 3 } })))).toMatchObject({ dependency_usage: "failed" });
  });

  it("are asked for only when the environment has dependencies", () => {
    expect(dependencyStepsOf(body(), undefined)).toEqual([]);
    expect(dependencyStepsOf(body([]), usage())).toEqual([]);
    expect(dependencyStepsOf(body([postgres]), undefined)).toBe("not_checked");
    const plain = derive(body(), usage());
    expect(stepsOf(plain)).toEqual({ setup: "skipped", build: "skipped", smoke: "skipped", full_suite: "passed" });
  });
});

describe("a check with no record", () => {
  it("proves nothing about the dependencies: it is refused, in fixed words", () => {
    expect(derive(body([postgres]), "none")).toEqual({ ok: false, refusal: "dependencies_not_checked" });
    expect(TEST_ENV_REFUSALS).toContain("dependencies_not_checked");
    expect(TEST_ENV_REFUSAL_WORDS.dependencies_not_checked).toMatch(/dependencies/u);
  });

  it("v1 services are still refused whatever the record says", () => {
    const withService = TestEnvironmentBodySchema.parse({ ...body([postgres]), services: [{ name: "scorer", kind: "sagemaker_runtime", match: { endpointName: "scorer" }, mode: "mock", mock: { fixtureSetRef: "a".repeat(64), schemaRef: "b".repeat(64), unmatched: "fail" } }] });
    expect(derive(withService, usage())).toEqual({ ok: false, refusal: "services_need_prove" });
  });
});

describe("proved means the dependency steps passed", () => {
  const report = (steps: Array<{ step: string; status: string }>, environment = body([postgres])) => TestEnvProveReportSchema.parse({ schemaVersion: 1, proposalDigest: testEnvDigest(environment), steps: steps.map((entry) => ({ ...entry, durationMs: 0, ...(entry.status === "failed" ? { failure: "infrastructure" } : {}) })), services: [], finishedAt: new Date(NOW).toISOString() });
  it("an environment with dependencies is not proved by a report that lacks, skips or fails them", () => {
    const environment = body([postgres]);
    const base = [{ step: "setup", status: "passed" }, { step: "full_suite", status: "passed" }];
    expect(testEnvIsProved(report(base), testEnvDigest(environment), environment)).toBe(false);
    expect(testEnvIsProved(report([...base, { step: "dependencies", status: "passed" }]), testEnvDigest(environment), environment)).toBe(false);
    expect(testEnvIsProved(report([...base, { step: "dependencies", status: "skipped" }, { step: "dependency_usage", status: "passed" }]), testEnvDigest(environment), environment)).toBe(false);
    expect(testEnvIsProved(report([...base, { step: "dependencies", status: "passed" }, { step: "dependency_usage", status: "failed" }]), testEnvDigest(environment), environment)).toBe(false);
    expect(testEnvIsProved(report([...base, { step: "dependencies", status: "passed" }, { step: "dependency_usage", status: "passed" }]), testEnvDigest(environment), environment)).toBe(true);
  });
  it("is what it was for an environment without dependencies", () => {
    const environment = body();
    expect(testEnvIsProved(report([{ step: "full_suite", status: "passed" }], environment), testEnvDigest(environment), environment)).toBe(true);
    expect(testEnvIsProved(report([{ step: "full_suite", status: "passed" }], environment), testEnvDigest(environment), {})).toBe(true);
  });
});

describe("the candidate check keeps the record", () => {
  const DIGEST = "d".repeat(64);
  const seed = (db: MemoryDocumentStore, extra: Record<string, unknown> = {}) => db.put({ item: {
    ...candidateCheckKey(ORG, PROJECT, DIGEST, 4), entityType: CANDIDATE_CHECK_ENTITY, orgId: ORG, project: PROJECT, workspaceId: "ws-1", revision: 4, startedAt: "2026-11-03T10:00:00.000Z", startedBy: "dev_a",
    digest: DIGEST, setup: [], readiness: [cmd("pytest", ["-q"])], [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(NOW / 1000) + 86_400, ...extra,
  } });
  const deps = (db: MemoryDocumentStore) => ({ store: db, now: () => NOW });

  it("stores a valid record once, and reads it back with the check", async () => {
    const db = fresh();
    await seed(db);
    expect(await recordCandidateUsage(deps(db), { orgId: ORG, project: PROJECT, digest: DIGEST, revision: 4, usage: usage() })).toBe(true);
    expect((await readCandidateCheck(deps(db), ORG, PROJECT, DIGEST, 4))?.usage).toEqual(usage());
    // The first report stands.
    expect(await recordCandidateUsage(deps(db), { orgId: ORG, project: PROJECT, digest: DIGEST, revision: 4, usage: usage({ unknownCalls: { domains: [], otherCount: 9 } }) })).toBe(false);
    expect((await readCandidateCheck(deps(db), ORG, PROJECT, DIGEST, 4))?.usage).toEqual(usage());
  });

  it("keeps nothing that does not parse, and nothing for a check that is not there", async () => {
    const db = fresh();
    await seed(db);
    for (const bad of [{ ...usage(), extra: 1 }, { ...usage(), dependencies: [{ id: "postgres", started: false, healthy: true, startMs: 0, resetCount: 0 }] }, "text", undefined]) {
      expect(await recordCandidateUsage(deps(db), { orgId: ORG, project: PROJECT, digest: DIGEST, revision: 4, usage: bad })).toBe(false);
    }
    expect((await readCandidateCheck(deps(db), ORG, PROJECT, DIGEST, 4))?.usage).toBeUndefined();
    expect(await recordCandidateUsage(deps(fresh()), { orgId: ORG, project: PROJECT, digest: DIGEST, revision: 4, usage: usage() })).toBe(false);
  });
});

describe("the plan a candidate check carries", () => {
  const catalogSource = async () => verifiedCatalog(pinnedCatalog());
  const project = async (devcontainer: boolean) => {
    const db = fresh();
    await db.put({ item: { ...projectRevisionKey(ORG, PROJECT, 1), entityType: "PROJECT", registeredBy: "seed", registeredAt: "2026-10-01T00:00:00.000Z", runtimeBinding: {}, definition: { name: PROJECT, revision: 1, repositories: [{ name: "web", url: "https://github.com/acme/web.git", path: "repo/web", defaultBranch: "main", credentialRef: "github-app" }], setup: [], readiness: [], orchestratorInstructions: "x", ...(devcontainer ? { devcontainer: { repository: "web" } } : {}) } } });
    return { store: db };
  };
  const scope = { orgId: ORG, project: PROJECT };

  it("is pinned from the signed catalog for a proposal with dependencies, and nothing (and no read) for one without", async () => {
    const plan = await candidateDependencyPlan({ ...(await project(false)), serviceCatalog: catalogSource }, body([postgres]), scope, ON);
    expect(plan?.map((entry) => [entry.id, entry.catalogId])).toEqual([["postgres", "postgres@16"]]);
    const unread = { store: { get: async () => { throw new Error("must not be called"); } } as never };
    expect(await candidateDependencyPlan(unread, body(), scope, ON)).toBeUndefined();
  });

  it("refuses the check, in fixed words, with tx off, with no catalog, or for a project with a dev container", async () => {
    await expect(candidateDependencyPlan({ ...(await project(false)), serviceCatalog: catalogSource }, body([postgres]), scope, { ROVARA_TEST_ENVIRONMENT: "1" })).rejects.toThrow(DEPENDENCY_PLAN_REFUSAL_WORDS.not_available_yet);
    await expect(candidateDependencyPlan(await project(false), body([postgres]), scope, ON)).rejects.toThrow(DEPENDENCY_PLAN_REFUSAL_WORDS.no_catalog);
    await expect(candidateDependencyPlan({ ...(await project(true)), serviceCatalog: catalogSource }, body([postgres]), scope, ON)).rejects.toThrow(/dev container/u);
  });
});

describe("Prove's final run is a sealed place", () => {
  it("is a place the chooser knows", () => {
    expect(BACKING_PLACES).toContain("prove_final");
  });
});
