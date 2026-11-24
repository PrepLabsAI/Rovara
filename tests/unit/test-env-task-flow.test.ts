// The approved test environment in the task flow: a starting task pins the revision it started with, a coding or verification run is told the plan of that revision, and an environment the flow cannot carry
// out is recorded as not applied (with its reason), never half-used.
import { describe, expect, it } from "vitest";
import { TASK_FLAKY_RERUN_FEATURE, TestEnvironmentBodySchema, testEnvDigest, type TestEnvironmentBody } from "@agentx/contracts";
import { COMPANY, createHarness, newRequestId } from "../support/task-flow-harness.js";
import { createTaskTestEnvironment, featuresForTestPlan } from "../../packages/broker/src/core/test-env/seam.js";
import { testEnvLatestKey, testEnvRevisionKey } from "../../packages/broker/src/core/test-env/environment.js";
import { documentOf, type TestEnvDeps } from "../../packages/broker/src/core/test-env/deps.js";

const PROJECT = "payments";
const cmd = (executable: string, args: string[] = []) => ({ cwd: "repo/demo", executable, args, timeoutSeconds: 600 });
const body = (over: Record<string, unknown> = {}): TestEnvironmentBody => TestEnvironmentBodySchema.parse({
  tier: "sandbox",
  repos: [{ repositoryId: "demo", setupCommands: [cmd("npm", ["ci"])], checks: [{ id: "unit", label: "Unit tests", command: cmd("npm", ["test"]), kind: "test" }] }],
  roundBudgetMin: 30,
  selection: { method: "full", alwaysRun: [], fullSuiteOn: ["package-lock.json"] },
  nightly: { enabled: false, cronUtc: "0 6 * * *", branch: "main" },
  services: [], data: { seeds: [], generator: "faker_seeded", seed: 7 }, accounts: [],
  prodDeny: { accountIds: ["111122223333"], hosts: ["*.prod.example.com"], arnPrefixes: [] },
  capture: { screenshots: "failed", video: false, traces: false },
  ...over,
});

/** Writes an approved revision the way the approval gate does (the same rows), so these tests do not depend on the gate. */
async function approve(deps: TestEnvDeps, environment: TestEnvironmentBody, revision: number): Promise<string> {
  const digest = testEnvDigest(environment);
  await deps.store.put({ item: documentOf({ ...testEnvRevisionKey(COMPANY, PROJECT, revision), entityType: "TEST_ENV_REVISION", orgId: COMPANY, project: PROJECT, revision, approvedAt: "2026-11-09T09:00:00.000Z", approvedBy: "owner", digest, requestId: `r${String(revision)}`, lessSafe: [], environment }) });
  await deps.store.put({ item: documentOf({ ...testEnvLatestKey(COMPANY, PROJECT), entityType: "TEST_ENV_LATEST", orgId: COMPANY, project: PROJECT, revision, digest }) });
  return digest;
}

async function world(env: NodeJS.ProcessEnv = {}) {
  const harness = createHarness();
  await harness.registerProject();
  const deps: TestEnvDeps = { store: harness.store, now: () => harness.clock.now, env };
  harness.deps.testEnvironment = createTaskTestEnvironment(deps, { orgId: COMPANY });
  const start = async () => harness.flow.start(harness.owner, { requestId: newRequestId(), project: PROJECT, instructions: "Add a retry.", workflow: true, workflowPath: "QUICK" });
  return { harness, deps, start };
}

describe("the plan a run is told", () => {
  it("a verification run whose first commands are the environment's checks gets the checks, the selection and the budget; any other run gets none", async () => {
    const { deps, start } = await world();
    const environment = body();
    await approve(deps, environment, 1);
    const started = await start();
    const seam = createTaskTestEnvironment(deps, { orgId: COMPANY });
    const readiness = [cmd("npm", ["test"])];
    const checks = await seam.stepPlan({ project: PROJECT, taskId: started.task.taskId, mode: "CHECKS", readiness });
    expect(checks?.plan).toMatchObject({ revision: 1, digest: testEnvDigest(environment), roundBudgetMin: 30, checks: [{ id: "unit", kind: "test" }], selection: { method: "full" } });
    // The failing-test rerun is on by default (DEC 254zzz448): the run also needs its worker feature.
    expect(checks?.requires).toEqual(["task.testEnvironment.v1", TASK_FLAKY_RERUN_FEATURE]);
    // The run's first commands are not the environment's checks (the task's policy was edited since): the run goes out as it would without an environment.
    expect(await seam.stepPlan({ project: PROJECT, taskId: started.task.taskId, mode: "CHECKS", readiness: [cmd("npm", ["run", "other"])] })).toBeUndefined();
    expect(await seam.stepPlan({ project: PROJECT, taskId: started.task.taskId, mode: "CHECKS" })).toBeUndefined();
    // A coding run is told the plan only when the environment has dependencies, and test services are off here.
    expect(await seam.stepPlan({ project: PROJECT, taskId: started.task.taskId, mode: "IMPLEMENT" })).toBeUndefined();
  });

  it("names the worker features a plan needs, so a worker that lacks one is refused the run and never sent it without", () => {
    expect(featuresForTestPlan(undefined)).toEqual([]);
    const plan = { revision: 1, digest: "a".repeat(64), roundBudgetMin: 30, selection: { method: "full", alwaysRun: [], fullSuiteOn: [] }, checks: [{ id: "u", kind: "test", coveragePath: "coverage/lcov.info" }] } as never;
    expect(featuresForTestPlan(undefined, plan).sort()).toEqual(["task.testEnvCoveragePath.v1", "task.testEnvironment.v1"]);
    const dependency = { backing: "emulated", seeds: [{ command: { cwd: "x", executable: "y", args: [], timeoutSeconds: 5 }, lock: { entries: [] } }] } as never;
    expect(featuresForTestPlan([dependency]).sort()).toEqual(["task.testServices.aws.v1", "task.testServices.seedLock.v1", "task.testServices.v1"]);
  });
});

