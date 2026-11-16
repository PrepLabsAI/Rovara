// TE-C6, the broker's half of the plan: with ROVARA_FLAKY_RERUN on, a run whose first commands are the environment's checks is told `flakyRerun: true` (and needs a worker that lists the feature); with it off the plan and its
// requirements are today's, byte for byte. The base's flaky set is read through ONE function.
import { describe, expect, it } from "vitest";
import { NightlyBaselineSchema, TASK_FLAKY_RERUN_FEATURE, TEST_ENV_PLAN_FEATURE, TestEnvTaskPlanSchema, TestEnvironmentBodySchema, WORKER_INVOCATION_FEATURES, projectPk, projectRevisionKey, testEnvDigest, type TestEnvironmentBody } from "@agentx/contracts";
import { COMPANY, createHarness, newRequestId } from "../support/task-flow-harness.js";
import { createTaskTestEnvironment, featuresForTestPlan } from "../../packages/broker/src/core/test-env/seam.js";
import { baseFlakyTests } from "../../packages/broker/src/core/test-env/base-flaky.js";
import { NIGHTLY_BASELINE_MAX_AGE_MS } from "../../packages/broker/src/core/test-env/nightly-usable.js";
import { flakyRerunEnabled } from "../../packages/broker/src/core/test-env/switch.js";
import { testEnvLatestKey, testEnvRevisionKey } from "../../packages/broker/src/core/test-env/environment.js";
import { documentOf, type TestEnvDeps } from "../../packages/broker/src/core/test-env/deps.js";
import { WORKER_IMPLEMENTED_FEATURES } from "../../packages/worker/src/implemented-features.js";

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
const ON = { ROVARA_FLAKY_RERUN: "1" } as NodeJS.ProcessEnv;

describe("the switch", () => {
  it("is off unless exactly 1", () => {
    expect(flakyRerunEnabled({})).toBe(false);
    for (const value of ["true", "", " 1", "1 ", "on", "0"]) expect(flakyRerunEnabled({ ROVARA_FLAKY_RERUN: value }), value).toBe(false);
    expect(flakyRerunEnabled(ON)).toBe(true);
  });
});

describe("the plan of a verification run", () => {
  it("with the switch off is today's plan: no flag, and only the plan feature is required", async () => {
    const { seam, taskId } = await world({});
    const checks = await seam.stepPlan({ project: PROJECT, taskId, mode: "CHECKS", readiness: READY });
    expect(checks?.plan).not.toHaveProperty("flakyRerun");
    expect(checks?.requires).toEqual([TEST_ENV_PLAN_FEATURE]);
    expect(await seam.stepPlan({ project: PROJECT, taskId, mode: "IMPLEMENT", readiness: READY })).toBeUndefined();
  });

  it("with the switch on, a run whose first commands are the environment's checks is told to rerun, and needs the feature", async () => {
    const { seam, taskId } = await world(ON);
    const checks = await seam.stepPlan({ project: PROJECT, taskId, mode: "CHECKS", readiness: READY });
    expect(checks?.plan.flakyRerun).toBe(true);
    expect(TestEnvTaskPlanSchema.safeParse(checks?.plan).success).toBe(true);
    expect(checks?.requires.sort()).toEqual([TASK_FLAKY_RERUN_FEATURE, TEST_ENV_PLAN_FEATURE].sort());
    expect(featuresForTestPlan(undefined, checks?.plan)).toContain(TASK_FLAKY_RERUN_FEATURE);
  });

  it("a coding run is told the plan (no dependencies) so its settle round can rerun, only with the switch on and its readiness matching the environment's checks", async () => {
    const { seam, taskId } = await world(ON);
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

  it("the flag is a literal true: false and any other value are refused, and a plan without it parses as it did", () => {
    const base = { revision: 1, digest: "a".repeat(64), roundBudgetMin: 30, selection: { method: "full", alwaysRun: [], fullSuiteOn: [] }, checks: [{ id: "unit", kind: "test", selectArgs: ["{tests}"] }] };
    expect(TestEnvTaskPlanSchema.safeParse(base).success).toBe(true);
    expect(TestEnvTaskPlanSchema.safeParse({ ...base, flakyRerun: true }).success).toBe(true);
    for (const value of [false, "true", 1, null]) expect(TestEnvTaskPlanSchema.safeParse({ ...base, flakyRerun: value }).success, String(value)).toBe(false);
  });
});

describe("the worker feature", () => {
  it("is listed by the contracts and implemented by this worker, so the broker can refuse an older one", () => {
    expect(WORKER_INVOCATION_FEATURES).toContain(TASK_FLAKY_RERUN_FEATURE);
    expect(WORKER_IMPLEMENTED_FEATURES).toContain(TASK_FLAKY_RERUN_FEATURE);
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

  it("is unknown (undefined, never an empty set that would read as 'nothing is flaky') for a stale baseline, another branch, or none", async () => {
    expect(await baseFlakyTests(await baseWorld({ ageMs: NIGHTLY_BASELINE_MAX_AGE_MS + 60_000 }), { orgId: ORG, project: PROJECT })).toBeUndefined();
    expect(await baseFlakyTests(await baseWorld({ branch: "release" }), { orgId: ORG, project: PROJECT })).toBeUndefined();
    expect(await baseFlakyTests(await baseWorld({ noBaseline: true }), { orgId: ORG, project: PROJECT })).toBeUndefined();
  });
});
