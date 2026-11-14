// Test services, slice 1 T1 (contracts): the environment body, the draft, the task plan, the Prove steps and the usage record carry test-services dependencies.
// The golden digest below was computed on the base BEFORE the `dependencies` field existed: a body without it must keep it, byte for byte (design test-services.md 2.3, "no data migration").
import { describe, expect, it } from "vitest";
import {
  TEST_ENV_BASE_PROVE_STEPS,
  TEST_ENV_DEPENDENCY_PROVE_STEPS,
  TEST_ENV_PROVE_FAILURES,
  TEST_ENV_PROVE_STEPS,
  TEST_SERVICES_PLAN_FEATURE,
  TaskDependencyPlanSchema,
  TestEnvDependencyCandidateSchema,
  TestEnvDraftSchema,
  TestEnvTaskPlanSchema,
  TestEnvironmentBodySchema,
  TestEnvProveReportSchema,
  WORKER_INVOCATION_FEATURES,
  testEnvDigest,
} from "../../packages/contracts/src/index.js";

const cmd = (executable: string, args: string[] = [], cwd = "service") => ({ cwd, executable, args, timeoutSeconds: 600 });
const baseBody = (over: Record<string, unknown> = {}) => ({
  tier: "sandbox",
  repos: [{ repositoryId: "service", setupCommands: [cmd("pip", ["install", "-e", "."])], checks: [
    { id: "unit", label: "Unit tests", command: cmd("pytest", ["-q"]), kind: "test" },
    { id: "lint", label: "Lint", command: cmd("ruff", ["check"]), kind: "lint" },
  ] }],
  roundBudgetMin: 30,
  selection: { method: "full", alwaysRun: [], fullSuiteOn: [".github/**"] },
  nightly: { enabled: false, cronUtc: "0 6 * * *", branch: "main" },
  services: [], data: { seeds: [], generator: "faker_seeded", seed: 1 }, accounts: [],
  prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] },
  capture: { screenshots: "failed", video: false, traces: false },
  ...over,
});
const postgres = (over: Record<string, unknown> = {}) => ({
  id: "postgres", name: "Postgres", kind: "database", family: "postgres", found: [{ path: "docker-compose.yml", line: 4 }], usedBy: ["integration"],
  backing: { kind: "local", catalogId: "postgres@16", config: { database: "app", user: "app" } },
  connect: { env: [{ name: "DATABASE_URL", template: "postgres://{user}:{password}@{host}:{port}/{db}" }], hostAliases: ["postgres"] },
  seeds: [], reset: "fresh_per_round", ...over,
});

const GOLDEN_DIGEST = "73802a131459df3de70f5f0a10dc36e4dcfe6d4e28871f207df81a334c8a4077";
const sha = (letter: string) => letter.repeat(64);

describe("the environment body and its digest", () => {
  it("keeps today's digest when `dependencies` is absent (golden)", () => {
    expect(testEnvDigest(TestEnvironmentBodySchema.parse(baseBody()))).toBe(GOLDEN_DIGEST);
    // The parsed body has no `dependencies` key at all, so the canonical text is unchanged too.
    expect("dependencies" in TestEnvironmentBodySchema.parse(baseBody())).toBe(false);
    // An explicit `undefined` is dropped by the canonical text as well.
    expect(testEnvDigest(TestEnvironmentBodySchema.parse(baseBody({ dependencies: undefined })))).toBe(GOLDEN_DIGEST);
  });

  it("accepts up to 24 dependencies' worth of fields and binds the digest to them", () => {
    const withPostgres = TestEnvironmentBodySchema.parse(baseBody({ dependencies: [postgres()] }));
    expect(withPostgres.dependencies).toEqual([postgres()]);
    expect(testEnvDigest(withPostgres)).not.toBe(GOLDEN_DIGEST);
    // The same dependency in a different key order is the same digest (canonical text); a different one is not.
    const reordered = TestEnvironmentBodySchema.parse(baseBody({ dependencies: [{ reset: "fresh_per_round", seeds: [], connect: postgres().connect, backing: postgres().backing, usedBy: ["integration"], found: postgres().found, family: "postgres", kind: "database", name: "Postgres", id: "postgres" }] }));
    expect(testEnvDigest(reordered)).toBe(testEnvDigest(withPostgres));
    expect(testEnvDigest(TestEnvironmentBodySchema.parse(baseBody({ dependencies: [postgres({ reset: "between_checks" })] })))).not.toBe(testEnvDigest(withPostgres));
  });

  it("refuses a bad dependency list as the contract does", () => {
    const parses = (dependencies: unknown) => TestEnvironmentBodySchema.safeParse(baseBody({ dependencies })).success;
    expect(parses([postgres()])).toBe(true);
    expect(parses([])).toBe(true);
    expect(parses([postgres(), postgres()])).toBe(false); // an id once
    expect(parses([postgres(), postgres({ id: "pg2", name: "Postgres 2" })])).toBe(false); // the same variable and alias twice
    expect(parses([postgres({ extra: 1 })])).toBe(false);
    expect(parses([postgres({ backing: { kind: "local", catalogId: "postgres@16", config: { password: "x" } } })])).toBe(false);
    expect(parses(Array.from({ length: 25 }, (_unused, index) => postgres({ id: `pg${String(index)}` })))).toBe(false);
    expect(parses([postgres({ connect: { env: [{ name: "DATABASE_URL", template: "postgres://app:hunter2@{host}:{port}/{db}" }], hostAliases: ["postgres"] } })])).toBe(false);
  });

  it("keeps v1 services as they were beside dependencies", () => {
    expect(TestEnvironmentBodySchema.safeParse(baseBody({ dependencies: [postgres()], services: [] })).success).toBe(true);
  });
});

describe("the draft carries detector candidates", () => {
  const candidate = (over: Record<string, unknown> = {}) => ({ family: "postgres", kind: "database", evidence: [{ path: "docker-compose.yml", line: 4 }], strength: "declared", hints: { version: "16", envNames: ["DATABASE_URL"], ports: [5432] }, ...over });
  const draft = (over: Record<string, unknown> = {}) => ({ environment: baseBody(), valueSources: [], pendingServices: [], notes: [], questions: [], ...over });

  it("is today's draft when there are none", () => {
    const parsed = TestEnvDraftSchema.parse(draft());
    expect("dependencies" in parsed).toBe(false);
    expect(TestEnvDraftSchema.parse(draft({ dependencies: [candidate()] })).dependencies).toEqual([candidate()]);
  });

  it("refuses a draft whose environment lists dependencies: a worker reports candidates, never a backing", () => {
    const listed = [postgres()];
    const refused = TestEnvDraftSchema.safeParse(draft({ environment: baseBody({ dependencies: listed }) }));
    expect(refused.success).toBe(false);
    expect(refused.success ? [] : refused.error.issues.map((issue) => issue.path.join("."))).toContain("environment.dependencies");
    // Even beside valid candidates, and even a backing a person could approve.
    expect(TestEnvDraftSchema.safeParse(draft({ environment: baseBody({ dependencies: listed }), dependencies: [candidate()] })).success).toBe(false);
    // An empty list is nothing; the candidates are what a draft carries.
    expect(TestEnvDraftSchema.safeParse(draft({ environment: baseBody({ dependencies: [] }) })).success).toBe(true);
    expect(TestEnvDraftSchema.safeParse(draft({ dependencies: [candidate()] })).success).toBe(true);
  });

  it("is bounded and strict", () => {
    const ok = (dependencies: unknown) => TestEnvDraftSchema.safeParse(draft({ dependencies })).success;
    expect(ok(Array.from({ length: 64 }, () => candidate()))).toBe(true);
    expect(ok(Array.from({ length: 65 }, () => candidate()))).toBe(false);
    expect(ok([candidate({ evidence: [] })])).toBe(false);
    expect(ok([candidate({ evidence: Array.from({ length: 9 }, (_unused, index) => ({ path: "a.yml", line: index + 1 })) })])).toBe(false);
    expect(ok([candidate({ extra: 1 })])).toBe(false);
    expect(ok([candidate({ hints: { password: "x" } })])).toBe(false);
    expect(ok([candidate({ family: "http:127.1" })])).toBe(false);
    expect(ok([candidate({ strength: "guessed" })])).toBe(false);
    expect(ok([candidate({ hints: { refused: ["privileged", "docker_socket"], url: { scheme: "postgres", hostFamily: "local" }, resources: [{ kind: "table", name: "orders", keySchema: { partitionKey: { name: "id", type: "S" } } }] } })])).toBe(true);
    expect(ok([candidate({ hints: { url: { scheme: "postgres", hostFamily: "db.internal" } } })])).toBe(false);
    expect(ok([candidate({ hints: { envNames: ["lower_case"] } })])).toBe(false);
    expect(TestEnvDependencyCandidateSchema.safeParse(candidate()).success).toBe(true);
  });
});

describe("the task plan carries pinned dependencies", () => {
  const plan = (over: Record<string, unknown> = {}) => ({ revision: 1, digest: sha("a"), roundBudgetMin: 30, selection: { method: "full", alwaysRun: [], fullSuiteOn: [] }, checks: [{ id: "unit", kind: "test" }], ...over });
  const dependencyPlan = (over: Record<string, unknown> = {}) => ({
    id: "postgres", name: "Postgres", kind: "database", family: "postgres", backing: "local", catalogId: "postgres@16", repository: "svc/postgres", digest: sha("b"),
    config: { database: "app", user: "app" }, aliases: ["postgres"],
    connect: [{ name: "DATABASE_URL", template: "postgres://{user}:{password}@{host}:{port}/{db}" }], seeds: [{ command: { cwd: "service", executable: "psql", args: ["-f", "seed.sql"], timeoutSeconds: 60 } }], reset: "fresh_per_round", ...over,
  });
  const parses = (value: unknown) => TestEnvTaskPlanSchema.safeParse(value).success;

  it("is today's plan when there are none", () => {
    const parsed = TestEnvTaskPlanSchema.parse(plan());
    expect("dependencies" in parsed).toBe(false);
    expect(parses(plan({ dependencies: [] }))).toBe(false); // never sent empty: absent means none
  });

  it("round-trips a pinned Postgres and holds no secret", () => {
    const parsed = TestEnvTaskPlanSchema.parse(plan({ dependencies: [dependencyPlan()] }));
    expect(parsed.dependencies).toEqual([dependencyPlan()]);
    expect(JSON.stringify(parsed)).not.toMatch(/hunter2|secret|token/iu);
  });

  it("refuses what is not a pin or not safe", () => {
    const ok = (over: Record<string, unknown>) => TaskDependencyPlanSchema.safeParse(dependencyPlan(over)).success;
    expect(ok({})).toBe(true);
    expect(ok({ digest: undefined })).toBe(false); // an unpinned image is never started
    expect(ok({ digest: "sha256:" + sha("b") })).toBe(false);
    expect(ok({ backing: "emulated" })).toBe(false); // slice 1 starts real software only
    expect(ok({ catalogId: "local-aws@r1" })).toBe(false);
    expect(ok({ catalogId: "dns-helper@r1" })).toBe(false);
    expect(ok({ repository: "library/postgres" })).toBe(false);
    expect(ok({ repository: "svc/../x" })).toBe(false);
    expect(ok({ aliases: ["dns"] })).toBe(false);
    expect(ok({ aliases: ["a", "a"] })).toBe(false);
    expect(ok({ connect: [{ name: "AWS_ENDPOINT_URL", template: "http://{host}:{port}" }] })).toBe(false);
    expect(ok({ connect: [{ name: "PATH", template: "{host}" }] })).toBe(false);
    expect(ok({ connect: [{ name: "DATABASE_URL", template: "postgres://app:hunter2@{host}:{port}/{db}" }] })).toBe(false);
    expect(ok({ connect: [{ name: "A_URL", template: "{host}" }, { name: "A_URL", template: "{host}" }] })).toBe(false);
    expect(ok({ config: { password: "x" } })).toBe(false);
    expect(ok({ extra: 1 })).toBe(false);
    expect(ok({ seeds: Array.from({ length: 9 }, () => ({ fixturePath: "seed.sql" })) })).toBe(false);
  });

  it("refuses two dependencies that clash", () => {
    const second = dependencyPlan({ id: "cache", name: "Cache", kind: "cache", family: "redis", catalogId: "redis@7", repository: "svc/redis", aliases: ["redis"], connect: [{ name: "REDIS_URL", template: "redis://{host}:{port}" }] });
    expect(parses(plan({ dependencies: [dependencyPlan(), second] }))).toBe(true);
    expect(parses(plan({ dependencies: [dependencyPlan(), { ...second, id: "postgres" }] }))).toBe(false);
    expect(parses(plan({ dependencies: [dependencyPlan(), { ...second, aliases: ["postgres"] }] }))).toBe(false);
    expect(parses(plan({ dependencies: [dependencyPlan(), { ...second, connect: dependencyPlan().connect }] }))).toBe(false);
  });
});

describe("the feature string and the Prove steps", () => {
  it("names the feature and lists it as an invocation feature", () => {
    expect(TEST_SERVICES_PLAN_FEATURE).toBe("task.testServices.v1");
    expect(WORKER_INVOCATION_FEATURES).toContain(TEST_SERVICES_PLAN_FEATURE);
  });

  it("adds the two dependency steps after the seven that were there", () => {
    expect(TEST_ENV_BASE_PROVE_STEPS).toEqual(["setup", "build", "boot", "smoke", "full_suite", "mocks", "preprod_probe"]);
    expect(TEST_ENV_DEPENDENCY_PROVE_STEPS).toEqual(["dependencies", "dependency_usage"]);
    expect(TEST_ENV_PROVE_STEPS).toEqual(["setup", "build", "boot", "smoke", "full_suite", "mocks", "preprod_probe", "dependencies", "dependency_usage"]);
  });

  const report = (steps: unknown[]) => ({ schemaVersion: 1, proposalDigest: sha("a"), steps, services: [], finishedAt: "2026-11-03T10:00:00.000Z" });
  it("accepts a report with the new steps, and a report without them (today's)", () => {
    expect(TestEnvProveReportSchema.safeParse(report([{ step: "dependencies", status: "passed", durationMs: 12 }, { step: "dependency_usage", status: "passed", durationMs: 3 }])).success).toBe(true);
    expect(TestEnvProveReportSchema.safeParse(report([{ step: "setup", status: "passed", durationMs: 1 }])).success).toBe(true);
    expect(TestEnvProveReportSchema.safeParse(report(TEST_ENV_PROVE_STEPS.map((step) => ({ step, status: "skipped", durationMs: 0 })))).success).toBe(true);
    expect(TestEnvProveReportSchema.safeParse(report([{ step: "dependencies", status: "passed", durationMs: 1 }, { step: "dependencies", status: "passed", durationMs: 1 }])).success).toBe(false);
  });

  it("fails a dependency step in fixed words", () => {
    expect(TEST_ENV_PROVE_FAILURES).toContain("dependency_start_failed");
    expect(TEST_ENV_PROVE_FAILURES).toContain("dependency_unexpected_call");
    expect(TestEnvProveReportSchema.safeParse(report([{ step: "dependencies", status: "failed", durationMs: 5, failure: "dependency_start_failed" }])).success).toBe(true);
    expect(TestEnvProveReportSchema.safeParse(report([{ step: "dependency_usage", status: "failed", durationMs: 5, failure: "dependency_unexpected_call" }])).success).toBe(true);
    expect(TestEnvProveReportSchema.safeParse(report([{ step: "dependencies", status: "failed", durationMs: 5 }])).success).toBe(false);
  });
});
