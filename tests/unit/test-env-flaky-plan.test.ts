// TE-C6, the broker's half of the plan: a run whose first commands are the environment's checks is told `flakyRerun: true` (and needs a worker that lists the feature); with it off the plan and its
// requirements are today's, byte for byte. The base's flaky set is read through ONE function.
import { describe, expect, it } from "vitest";
import { NightlyBaselineSchema, TASK_FLAKY_RERUN_FEATURE, TestEnvTaskPlanSchema, TestEnvironmentBodySchema, projectPk, projectRevisionKey, testEnvDigest, type TestEnvironmentBody } from "@agentx/contracts";
import { COMPANY, createHarness, newRequestId } from "../support/task-flow-harness.js";
import { createTaskTestEnvironment } from "../../packages/broker/src/core/test-env/seam.js";
import { baseFlakyTests } from "../../packages/broker/src/core/test-env/base-flaky.js";
import { testEnvLatestKey, testEnvRevisionKey } from "../../packages/broker/src/core/test-env/environment.js";
import { documentOf, type TestEnvDeps } from "../../packages/broker/src/core/test-env/deps.js";

const PROJECT = "payments";
const cmd = (executable: string, args: string[] = []) => ({ cwd: "repo/demo", executable, args, timeoutSeconds: 600 });
const body = (): TestEnvironmentBody => TestEnvironmentBodySchema.parse({
  tier: "sandbox",
  repos: [{ repositoryId: "demo", setupCommands: [cmd("npm", ["ci"])], checks: [{ id: "unit", label: "Unit tests", command: cmd("pytest", ["--junitxml=r.xml"]), kind: "test", selectArgs: ["{tests}"] }] }],
  roundBudgetMin: 30,
  selection: { method: "full", alwaysRun: [], fullSuiteOn: ["package-lock.json"] },
  nightly: { enabled: false, cronUtc: "0 6 * * *", branch: "main" },
  services: [], data: { seeds: [], generator: "faker_seeded", seed: 7 }, accounts: [],
  prodDeny: { accountIds: ["111122223333"], hosts: ["*.prod.example.com"], arnPrefixes: [] },
  capture: { screenshots: "failed", video: false, traces: false },
});

async function approve(deps: TestEnvDeps, environment: TestEnvironmentBody): Promise<void> {
  const digest = testEnvDigest(environment);
  await deps.store.put({ item: documentOf({ ...testEnvRevisionKey(COMPANY, PROJECT, 1), entityType: "TEST_ENV_REVISION", orgId: COMPANY, project: PROJECT, revision: 1, approvedAt: "2026-11-09T09:00:00.000Z", approvedBy: "owner", digest, requestId: "r1", lessSafe: [], environment }) });
  await deps.store.put({ item: documentOf({ ...testEnvLatestKey(COMPANY, PROJECT), entityType: "TEST_ENV_LATEST", orgId: COMPANY, project: PROJECT, revision: 1, digest }) });
}

async function world(env: NodeJS.ProcessEnv) {
  const harness = createHarness();
  await harness.registerProject();
  const deps: TestEnvDeps = { store: harness.store, now: () => harness.clock.now, env };
  harness.deps.testEnvironment = createTaskTestEnvironment(deps, { orgId: COMPANY });
  await approve(deps, body());
  const started = await harness.flow.start(harness.owner, { requestId: newRequestId(), project: PROJECT, instructions: "Add a retry.", workflow: true, workflowPath: "QUICK" });
  return { seam: createTaskTestEnvironment(deps, { orgId: COMPANY }), taskId: started.task.taskId };
}

const READY = [cmd("pytest", ["--junitxml=r.xml"])];

describe("the plan of a verification run", () => {

  it("a coding run is told the plan (no dependencies) so its settle round can rerun, only with its readiness matching the environment's checks", async () => {
    const { seam, taskId } = await world({});
    const coding = await seam.stepPlan({ project: PROJECT, taskId, mode: "IMPLEMENT", readiness: READY });
    expect(coding?.plan.flakyRerun).toBe(true);
    expect(coding?.plan).not.toHaveProperty("dependencies");
    expect(coding?.requires).toContain(TASK_FLAKY_RERUN_FEATURE);
    // Without the readiness, or with commands that are not the environment's checks, a coding run gets no plan, as it never did without dependencies.
    expect(await seam.stepPlan({ project: PROJECT, taskId, mode: "IMPLEMENT" })).toBeUndefined();
    expect(await seam.stepPlan({ project: PROJECT, taskId, mode: "IMPLEMENT", readiness: [cmd("pytest", ["other"])] })).toBeUndefined();
    // And a verification run whose commands are not the environment's checks is told nothing at all.
    expect(await seam.stepPlan({ project: PROJECT, taskId, mode: "CHECKS", readiness: [cmd("pytest", ["other"])] })).toBeUndefined();
  });

  it("the rerun is always planned for a run whose first commands are the environment's checks (no switch, DEC 254zzz461)", async () => {
    const { seam, taskId } = await world({});
    const checks = await seam.stepPlan({ project: PROJECT, taskId, mode: "CHECKS", readiness: READY });
    expect(checks?.plan.flakyRerun).toBe(true);
    expect(checks?.requires).toContain(TASK_FLAKY_RERUN_FEATURE);
  });

  it("the flag is a literal true: false and any other value are refused, and a plan without it parses as it did", () => {
    const base = { revision: 1, digest: "a".repeat(64), roundBudgetMin: 30, selection: { method: "full", alwaysRun: [], fullSuiteOn: [] }, checks: [{ id: "unit", kind: "test", selectArgs: ["{tests}"] }] };
    expect(TestEnvTaskPlanSchema.safeParse(base).success).toBe(true);
    expect(TestEnvTaskPlanSchema.safeParse({ ...base, flakyRerun: true }).success).toBe(true);
    for (const value of [false, "true", 1, null]) expect(TestEnvTaskPlanSchema.safeParse({ ...base, flakyRerun: value }).success, String(value)).toBe(false);
  });
});

// ---- the base's flaky set

const ORG = COMPANY;
const NOW = Date.UTC(2026, 10, 13, 12, 0, 0);
const DAY = 86_400_000;
async function baseWorld(over: { ageMs?: number; flaky?: string[]; branch?: string; noBaseline?: boolean } = {}) {
  const harness = createHarness();
  const deps: TestEnvDeps = { store: harness.store, now: () => NOW };
  await deps.store.put({ item: documentOf({ ...projectRevisionKey(ORG, PROJECT, 1), entityType: "PROJECT", definition: { name: PROJECT, revision: 1, repositories: [{ name: "r0", url: "https://github.com/acme/web.git", path: "repo/r0", defaultBranch: "main" }] } }) });
  if (over.noBaseline !== true) {
    const finished = new Date(NOW - (over.ageMs ?? DAY)).toISOString();
    const baseline = NightlyBaselineSchema.parse({
      recordedAt: finished, envRevision: 1, branch: over.branch ?? "main", headSha: "a".repeat(40), finishedAt: finished,
      tests: { total: 10, passed: 10, failed: 0, skipped: 0 }, failed: [], flaky: over.flaky ?? ["tests/test_cart.py::test_total"],
    });
    await deps.store.put({ item: documentOf({ pk: projectPk(ORG, PROJECT), sk: "TESTENV#BASELINE#LATEST", entityType: "TEST_ENV_BASELINE_LATEST", orgId: ORG, project: PROJECT, baseline }) });
  }
  return deps;
}

describe("baseFlakyTests (today the last usable nightly baseline's flaky set; TE-C1's lookup replaces this one call)", () => {
  it("is the flaky set of a usable baseline", async () => {
    expect(await baseFlakyTests(await baseWorld(), { orgId: ORG, project: PROJECT })).toEqual(["tests/test_cart.py::test_total"]);
  });

});
