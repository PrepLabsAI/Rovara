// TE-C1: what a verification run's plan carries. With the switch off, or with no trusted row, the plan is today's plan byte for byte; with it on, the newest trusted commits of the task's base branch ride along as shas, and
// the run then needs a worker that lists the feature.
import { describe, expect, it } from "vitest";
import { BaselineRowSchema, TEST_ENV_BASELINE_FEATURE, projectPk, TestEnvTaskPlanSchema, TestEnvironmentBodySchema, testEnvDigest, type TestEnvironmentBody } from "@agentx/contracts";
import { COMPANY, createHarness, newRequestId } from "../support/task-flow-harness.js";
import { createTaskTestEnvironment, featuresForTestPlan } from "../../packages/broker/src/core/test-env/seam.js";
import { mintTrustedBaselineRun, recordBaselineRow } from "../../packages/broker/src/core/test-env/baseline-cache.js";
import { documentOf, type TestEnvDeps } from "../../packages/broker/src/core/test-env/deps.js";
import { testEnvLatestKey, testEnvRevisionKey } from "../../packages/broker/src/core/test-env/environment.js";

const PROJECT = "payments";
const HOUR = 3_600_000;
const sha = (n: number): string => n.toString(16).padStart(40, "0");
const cmd = (executable: string, args: string[] = []) => ({ cwd: "repo/demo", executable, args, timeoutSeconds: 600 });
const body = (): TestEnvironmentBody => TestEnvironmentBodySchema.parse({
  tier: "sandbox", repos: [{ repositoryId: "demo", setupCommands: [cmd("npm", ["ci"])], checks: [{ id: "unit", label: "Unit tests", command: cmd("npm", ["test"]), kind: "test" }] }],
  roundBudgetMin: 30, selection: { method: "full", alwaysRun: [], fullSuiteOn: [] }, nightly: { enabled: true, cronUtc: "0 6 * * *", branch: "main" },
  services: [], data: { seeds: [], generator: "faker_seeded", seed: 7 }, accounts: [], prodDeny: { accountIds: ["111122223333"], hosts: ["*.prod.example.com"], arnPrefixes: [] }, capture: { screenshots: "failed", video: false, traces: false },
});

async function world(env: NodeJS.ProcessEnv) {
  const harness = createHarness();
  await harness.registerProject();
  const deps: TestEnvDeps = { store: harness.store, now: () => harness.clock.now, env };
  harness.deps.testEnvironment = createTaskTestEnvironment(deps, { orgId: COMPANY });
  const environment = body();
  const digest = testEnvDigest(environment);
  await deps.store.put({ item: documentOf({ ...testEnvRevisionKey(COMPANY, PROJECT, 1), entityType: "TEST_ENV_REVISION", orgId: COMPANY, project: PROJECT, revision: 1, approvedAt: "2026-11-09T09:00:00.000Z", approvedBy: "owner", digest, requestId: "r1", lessSafe: [], environment }) });
  await deps.store.put({ item: documentOf({ ...testEnvLatestKey(COMPANY, PROJECT), entityType: "TEST_ENV_LATEST", orgId: COMPANY, project: PROJECT, revision: 1, digest }) });
  const started = await harness.flow.start(harness.owner, { requestId: newRequestId(), project: PROJECT, instructions: "Add a retry.", workflow: true, workflowPath: "QUICK" });
  const keep = (over: Record<string, unknown>) => recordBaselineRow(deps, mintTrustedBaselineRun({ orgId: COMPANY, project: PROJECT, row: BaselineRowSchema.parse({
    recordedAt: new Date(harness.clock.now - HOUR).toISOString(), envRevision: 1, branch: "main", headSha: sha(1), finishedAt: new Date(harness.clock.now - 2 * HOUR).toISOString(), writer: "nightly",
    tests: { total: 4, passed: 3, failed: 1, skipped: 0 }, failed: ["a.test.ts::x"], flaky: [], ...over }) }));
  const plan = (mode: "CHECKS" | "IMPLEMENT" = "CHECKS") => harness.deps.testEnvironment!.stepPlan({ project: PROJECT, taskId: started.task.taskId, mode, ...(mode === "CHECKS" ? { readiness: [cmd("npm", ["test"])] } : {}) });
  return { keep, plan, store: deps.store };
}

describe("baseline candidates in the task plan", () => {
  it("with the switch off, or no trusted row, the plan is today's plan byte for byte, and no feature is asked of the worker", async () => {
    const reference = await (await world({})).plan();
    expect(reference?.plan).toBeDefined();
    expect(JSON.stringify(reference?.plan)).not.toContain("baselineCandidates");
    const off = await world({});
    await off.keep({});
    expect(JSON.stringify((await off.plan())?.plan)).toBe(JSON.stringify(reference?.plan));
    expect((await off.plan())?.requires).toEqual(["task.testEnvironment.v1"]);
    const noRows = await world({ ROVARA_BASELINE_CACHE: "1" });
    expect(JSON.stringify((await noRows.plan())?.plan)).toBe(JSON.stringify(reference?.plan));
    expect((await noRows.plan())?.requires).toEqual(["task.testEnvironment.v1"]);
    const sameTimeNoSwitch = await world({ ROVARA_BASELINE_CACHE: "0" });
    await sameTimeNoSwitch.keep({});
    expect(JSON.stringify((await sameTimeNoSwitch.plan())?.plan)).toBe(JSON.stringify(reference?.plan));
  });

  it("with the switch on, the plan names the newest trusted commits of the base branch and revision, as shas, and asks the worker for the feature", async () => {
    const on = await world({ ROVARA_BASELINE_CACHE: "1" });
    for (let n = 1; n <= 7; n += 1) await on.keep({ headSha: sha(n), finishedAt: new Date(Date.UTC(2026, 10, 1, n)).toISOString(), recordedAt: new Date(Date.UTC(2026, 10, 1, n)).toISOString() });
    await on.keep({ headSha: sha(30), branch: "release" });
    await on.keep({ headSha: sha(31), envRevision: 2 });
    const rowsOf = async () => (await on.store.query({ pk: projectPk(COMPANY, PROJECT), sk: { op: "beginsWith", prefix: "TESTENV#BASELINE#" } })).items.map((item) => item.sk);
    const before = await rowsOf();
    const planned = await on.plan();
    // Building the plan for a task (a whole start and a plan) writes no baseline row.
    expect(await rowsOf()).toEqual(before);
    expect(before).toHaveLength(9);
    expect(planned?.plan.baselineCandidates).toEqual([sha(7), sha(6), sha(5), sha(4), sha(3)].map((value) => ({ sha: value })));
    expect(TestEnvTaskPlanSchema.safeParse(planned?.plan).success).toBe(true);
    expect([...planned!.requires].sort()).toEqual(["task.testEnvironment.v1", TEST_ENV_BASELINE_FEATURE].sort());
    // A coding run is never told: candidates are for the verification run.
    expect(await on.plan("IMPLEMENT")).toBeUndefined();
  });

  it("names the feature only for a plan that carries candidates", () => {
    const plan = { revision: 1, digest: "a".repeat(64), roundBudgetMin: 30, selection: { method: "full", alwaysRun: [], fullSuiteOn: [] }, checks: [{ id: "u", kind: "test" }] };
    expect(featuresForTestPlan(undefined, plan as never)).toEqual(["task.testEnvironment.v1"]);
    expect(featuresForTestPlan(undefined, { ...plan, baselineCandidates: [{ sha: sha(1) }] } as never).sort()).toEqual(["task.testEnvironment.v1", TEST_ENV_BASELINE_FEATURE].sort());
  });
});
