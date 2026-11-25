// Test services: the Prove of an environment with dependencies. The two new steps ("start dependencies", "dependency usage check") are derived by the broker from the usage record the candidate check
// reported; a check with no record proves nothing about them; an environment with dependencies is proved only when both passed; the record is kept, validated, on the candidate check; the plan for the check is pinned.
import { describe, expect, it } from "vitest";
import { TEST_ENV_REFUSALS, TestEnvironmentBodySchema, TestEnvProveReportSchema, testEnvDigest, testEnvIsProved, type TestServicesUsageRecord } from "@agentx/contracts";
import { TEST_ENV_REFUSAL_WORDS, proveReportFromSetupCheck } from "../../packages/broker/src/core/test-env/prove-from-setup-check.js";

const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);
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

});

describe("a check with no record", () => {
  it("proves nothing about the dependencies: it is refused, in fixed words", () => {
    expect(derive(body([postgres]), "none")).toEqual({ ok: false, refusal: "dependencies_not_checked" });
    expect(TEST_ENV_REFUSALS).toContain("dependencies_not_checked");
    expect(TEST_ENV_REFUSAL_WORDS.dependencies_not_checked).toMatch(/dependencies/u);
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
