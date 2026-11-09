// Test services, slice 1 T3 (contracts): the dependency fields are part of the environment's less-safe changes and approval risk, and the summary counts them. With no dependencies every result is what it was.
import { describe, expect, it } from "vitest";
import { TEST_ENV_DEPENDENCY_LESS_SAFE_FIELDS, TEST_ENV_LESS_SAFE_FIELDS, TestEnvironmentBodySchema, testEnvApprovalRisk, testEnvLessSafeChanges, testEnvSummaryOf, TestEnvSummarySchema } from "../../packages/contracts/src/index.js";

const cmd = (executable: string, args: string[] = []) => ({ cwd: "service", executable, args, timeoutSeconds: 600 });
const sha = (letter: string) => letter.repeat(64);
const dep = (over: Record<string, unknown> = {}) => ({
  id: "postgres", name: "Postgres", kind: "database", family: "postgres", found: [{ path: "docker-compose.yml", line: 4 }], usedBy: ["integration"],
  backing: { kind: "local", catalogId: "postgres@16", config: {} },
  connect: { env: [{ name: "DATABASE_URL", template: "postgres://{user}:{password}@{host}:{port}/{db}" }], hostAliases: ["postgres"] },
  seeds: [], reset: "fresh_per_round", ...over,
});
const body = (dependencies?: unknown[]) => TestEnvironmentBodySchema.parse({
  tier: "sandbox", repos: [{ repositoryId: "service", setupCommands: [], checks: [{ id: "unit", label: "Unit", command: cmd("pytest"), kind: "test" }] }], roundBudgetMin: 30,
  selection: { method: "full", alwaysRun: [], fullSuiteOn: [] }, nightly: { enabled: false, cronUtc: "0 6 * * *", branch: "main" }, services: [], data: { seeds: [], generator: "faker_seeded", seed: 1 }, accounts: [],
  prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] }, capture: { screenshots: "failed", video: false, traces: false }, ...(dependencies === undefined ? {} : { dependencies }),
});
const account = dep({ id: "payments", name: "Payments", kind: "http_api", family: "http:api.example-pay.com", backing: { kind: "test_account", accountId: "payments-test" }, connect: { env: [{ name: "PAY_URL", template: "https://{host}" }], hostAliases: [] }, reset: "fresh_per_round" });
const fake = (unmatched: "fail" | "schema_synth") => dep({ id: "scorer", name: "Scorer", kind: "http_api", family: "http:scorer.example.com", backing: { kind: "fake", fixtureSetRef: sha("a"), unmatched }, connect: { env: [], hostAliases: [] } });

describe("less-safe changes with dependencies", () => {
  it("lists the dependency fields among the environment's own", () => {
    for (const field of TEST_ENV_DEPENDENCY_LESS_SAFE_FIELDS) expect(TEST_ENV_LESS_SAFE_FIELDS).toContain(field);
    // `schema_synth` is one entry, not two.
    expect(TEST_ENV_LESS_SAFE_FIELDS.filter((field) => field === "schema_synth")).toHaveLength(1);
  });

  it("is nothing for real catalog software, and nothing at all for a body without dependencies (golden)", () => {
    expect(testEnvLessSafeChanges(undefined, body([dep()]))).toEqual([]);
    expect(testEnvLessSafeChanges(undefined, body())).toEqual([]);
    expect(testEnvLessSafeChanges(body(), body([dep()]))).toEqual([]);
  });

  it("turns on a test account, a project image, a substitute image, excluded tests or a made-up-answers fake", () => {
    expect(testEnvLessSafeChanges(undefined, body([account]))).toEqual(["test_account"]);
    expect(testEnvLessSafeChanges(undefined, body([dep({ backing: { kind: "project_image", imageId: "mine" } })]))).toEqual(["project_image"]);
    expect(testEnvLessSafeChanges(undefined, body([dep({ backing: { kind: "local", catalogId: "postgres@16", config: {}, substituteImage: { digest: sha("c"), catalogDigest: sha("d"), approvalRef: "approval-123456" } } })]))).toEqual(["substitute_image"]);
    expect(testEnvLessSafeChanges(undefined, body([dep({ backing: { kind: "none", reason: "declined", excludedTests: ["tests/db/**"] }, connect: { env: [], hostAliases: [] } })]))).toEqual(["none_excluded_tests"]);
    expect(testEnvLessSafeChanges(undefined, body([fake("schema_synth")]))).toEqual(["schema_synth"]);
    expect(testEnvLessSafeChanges(undefined, body([fake("fail")]))).toEqual([]);
  });

  it("is a change only when a use is new or moved, never when it stays or goes away", () => {
    expect(testEnvLessSafeChanges(body([account]), body([account]))).toEqual([]);
    expect(testEnvLessSafeChanges(body([account]), body())).toEqual([]);
    const moved = { ...account, backing: { kind: "test_account", accountId: "payments-other" } };
    expect(testEnvLessSafeChanges(body([account]), body([moved]))).toEqual(["test_account"]);
    expect(testEnvLessSafeChanges(body([dep()]), body([dep(), { ...account }]))).toEqual(["test_account"]);
  });

  it("sorts with the environment's own fields and does not repeat a field both lists name", () => {
    const withMock = TestEnvironmentBodySchema.parse({ ...body([account]), services: [{ name: "scorer", kind: "sagemaker_runtime", match: { endpointName: "scorer" }, mode: "mock", mock: { fixtureSetRef: sha("a"), schemaRef: sha("b"), unmatched: "schema_synth" } }] });
    const changes = testEnvLessSafeChanges(undefined, withMock);
    expect(changes).toEqual(["schema_synth", "test_account"]);
    expect(testEnvLessSafeChanges(undefined, TestEnvironmentBodySchema.parse({ ...withMock, dependencies: [fake("schema_synth")] }))).toEqual(["schema_synth"]);
  });
});

describe("approval risk with dependencies", () => {
  it("is medium for real software and for a body without any, high for anything less safe", () => {
    expect(testEnvApprovalRisk(body())).toBe("medium");
    expect(testEnvApprovalRisk(body([dep()]))).toBe("medium");
    expect(testEnvApprovalRisk(body([account]))).toBe("high");
    expect(testEnvApprovalRisk(body([dep({ backing: { kind: "project_image", imageId: "mine" } })]))).toBe("high");
    expect(testEnvApprovalRisk(body([dep({ backing: { kind: "none", reason: "declined", excludedTests: ["t"] }, connect: { env: [], hostAliases: [] } })]))).toBe("high");
    expect(testEnvApprovalRisk(body([dep({ backing: { kind: "local", catalogId: "postgres@16", config: {}, substituteImage: { digest: sha("c"), catalogDigest: sha("d"), approvalRef: "approval-123456" } } })]))).toBe("high");
  });
});

describe("the summary counts dependencies", () => {
  it("counts them and what is started, and says nothing when there are none", () => {
    expect(testEnvSummaryOf(body())).not.toHaveProperty("dependencies");
    const summary = testEnvSummaryOf(body([dep(), fake("fail")]));
    expect(summary.dependencies).toEqual({ count: 2, started: 2 });
    expect(TestEnvSummarySchema.safeParse(summary).success).toBe(true);
    expect(testEnvSummaryOf(body([dep(), account])).dependencies).toEqual({ count: 2, started: 2 });
    // A summary stored before the field existed still parses.
    const { dependencies: _none, ...old } = summary;
    void _none;
    expect(TestEnvSummarySchema.safeParse(old).success).toBe(true);
  });
});
