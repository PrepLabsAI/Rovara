// TE-MR2b: the wire shapes of cross-repository test selection. Every coverage-map path and every test carries its repository; the plan field is asked for (a worker without the feature string is never sent it).
import { describe, expect, it } from "vitest";
import { RepositoryCoverageMapSchema, TEST_ENV_MULTI_REPO_FEATURE, TestEnvTaskPlanSchema, WORKER_INVOCATION_FEATURES } from "@agentx/contracts";
import { featuresForTestPlan } from "../../packages/broker/src/core/test-env/seam.js";
import { WORKER_IMPLEMENTED_FEATURES } from "../../packages/worker/src/implemented-features.js";

const BUILT = "2026-11-02T08:00:00.000Z";
const entry = (repositoryId: string, path: string, tests: Array<[string, string]> = [["service", "tests/test_a.py::test_a"]]) => ({ repositoryId, path, tests: tests.map(([repo, id]) => ({ repositoryId: repo, id })) });
const map = (entries = [entry("lib", "src/lib.py")]) => ({ builtAt: BUILT, entries });
const plan = (over: Record<string, unknown> = {}) => ({
  revision: 2, digest: "d".repeat(64), roundBudgetMin: 30, selection: { method: "coverage_map", alwaysRun: [], fullSuiteOn: [] },
  checks: [{ id: "unit", kind: "test", repositoryId: "service", selectArgs: ["{tests}"] }], repositoryCoverageMap: map(), ...over,
});

describe("the repository-qualified coverage map", () => {
  it("accepts a path with its repository and tests with theirs, strict", () => {
    expect(RepositoryCoverageMapSchema.safeParse(map()).success).toBe(true);
    expect(RepositoryCoverageMapSchema.safeParse({ ...map(), extra: 1 }).success).toBe(false);
    expect(RepositoryCoverageMapSchema.safeParse(map([{ ...entry("lib", "a.py"), extra: 1 } as never])).success).toBe(false);
  });
  it("refuses a path with no repository, a test with no repository, and hidden or odd characters in a repository id", () => {
    expect(RepositoryCoverageMapSchema.safeParse(map([{ path: "a.py", tests: [] } as never])).success).toBe(false);
    expect(RepositoryCoverageMapSchema.safeParse(map([{ repositoryId: "lib", path: "a.py", tests: [{ id: "t" }] } as never])).success).toBe(false);
    for (const bad of ["", "a b", "lib\n", "lib\u0001x", "x".repeat(201), "lib‮"]) expect(RepositoryCoverageMapSchema.safeParse(map([entry(bad, "a.py")])).success).toBe(false);
    expect(RepositoryCoverageMapSchema.safeParse(map([entry("lib", "a.py", [["bad id", "t"]])])).success).toBe(false);
  });
  it("refuses the same (repository, path) twice, so one path never has two answers", () => {
    expect(RepositoryCoverageMapSchema.safeParse(map([entry("lib", "a.py"), entry("lib", "a.py")])).success).toBe(false);
    expect(RepositoryCoverageMapSchema.safeParse(map([entry("lib", "a.py"), entry("service", "a.py")])).success).toBe(true);
  });
  it("is bounded: 20,000 paths, 5,000 tests a path, valid test ids, an RFC date", () => {
    expect(RepositoryCoverageMapSchema.safeParse(map(Array.from({ length: 20_001 }, (_, i) => entry("lib", `f${String(i)}.py`, [])))).success).toBe(false);
    expect(RepositoryCoverageMapSchema.safeParse(map([entry("lib", "a.py", Array.from({ length: 5_001 }, (_, i) => ["service", `t${String(i)}`] as [string, string]))])).success).toBe(false);
    expect(RepositoryCoverageMapSchema.safeParse({ ...map(), builtAt: "yesterday" }).success).toBe(false);
    expect(RepositoryCoverageMapSchema.safeParse(map([entry("lib", "x".repeat(501))])).success).toBe(false);
  });
});

describe("the task plan's cross-repository fields", () => {
  it("a plan without the new fields parses exactly as before, and the feature string is a worker invocation feature", () => {
    const { repositoryCoverageMap: _map, ...old } = plan();
    const oldCheck = { ...old, checks: [{ id: "unit", kind: "test", selectArgs: ["{tests}"] }] };
    const parsed = TestEnvTaskPlanSchema.parse(oldCheck);
    expect(Object.keys(parsed).sort()).toEqual(["checks", "digest", "revision", "roundBudgetMin", "selection"]);
    expect(WORKER_INVOCATION_FEATURES).toContain(TEST_ENV_MULTI_REPO_FEATURE);
  });
  it("a repository-qualified map needs a repository on every check, and never rides beside the repository-less map", () => {
    expect(TestEnvTaskPlanSchema.safeParse(plan()).success).toBe(true);
    expect(TestEnvTaskPlanSchema.safeParse(plan({ checks: [{ id: "unit", kind: "test", selectArgs: ["{tests}"] }] })).success).toBe(false);
    expect(TestEnvTaskPlanSchema.safeParse(plan({ coverageMap: { builtAt: BUILT, files: {} } })).success).toBe(false);
  });
  it("a check's repository is a valid repository id, on a plan with or without the map", () => {
    const { repositoryCoverageMap: _map, ...noMap } = plan();
    expect(TestEnvTaskPlanSchema.safeParse(noMap).success).toBe(true);
    expect(TestEnvTaskPlanSchema.safeParse(plan({ checks: [{ id: "unit", kind: "test", repositoryId: "bad id", selectArgs: ["{tests}"] }] })).success).toBe(false);
  });
  it("the inline map is at most 256 KiB, like the repository-less one", () => {
    const big = map(Array.from({ length: 2_000 }, (_, i) => entry("lib", `src/module_${String(i)}/${"x".repeat(100)}.py`, Array.from({ length: 5 }, (_, j) => ["service", `tests/test_${String(i)}.py::test_${String(j)}`] as [string, string]))));
    expect(JSON.stringify(big).length).toBeGreaterThan(256 * 1024);
    expect(TestEnvTaskPlanSchema.safeParse(plan({ repositoryCoverageMap: big })).success).toBe(false);
  });
});

describe("only a worker that reads the fields is sent them", () => {
  it("the plan needs the feature when it carries the map or a check's repository, and not otherwise", () => {
    const withMap = TestEnvTaskPlanSchema.parse(plan());
    expect([...featuresForTestPlan(undefined, withMap)].sort()).toEqual(["task.testEnvironment.v1", TEST_ENV_MULTI_REPO_FEATURE].sort());
    const { repositoryCoverageMap: _map, ...rest } = plan();
    expect([...featuresForTestPlan(undefined, TestEnvTaskPlanSchema.parse(rest))].sort()).toEqual(["task.testEnvironment.v1", TEST_ENV_MULTI_REPO_FEATURE].sort());
    const bare = TestEnvTaskPlanSchema.parse({ ...rest, checks: [{ id: "unit", kind: "test", selectArgs: ["{tests}"] }] });
    expect(featuresForTestPlan(undefined, bare)).toEqual(["task.testEnvironment.v1"]);
  });
  it("this worker lists it", () => { expect(WORKER_IMPLEMENTED_FEATURES).toContain(TEST_ENV_MULTI_REPO_FEATURE); });
});
