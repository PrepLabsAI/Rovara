// The approved test environment in the task flow: a starting task pins the revision it started with, a coding or verification run is told the plan of that revision, and an environment the flow cannot carry
// out is recorded as not applied (with its reason), never half-used.
import { describe, expect, it } from "vitest";
import { TestEnvironmentBodySchema, projectPk, testEnvDigest, type TestEnvironmentBody } from "@rovara-code/contracts";
import { COMPANY, createHarness, newRequestId } from "../support/task-flow-harness.js";
import { createTaskTestEnvironment, featuresForTestPlan } from "../../packages/core/src/core/test-env/seam.js";
import { readTestEnvPin, testEnvironmentForStart } from "../../packages/core/src/core/test-env/usable.js";
import { readApprovedTestEnvironment, testEnvLatestKey, testEnvRevisionKey } from "../../packages/core/src/core/test-env/environment.js";
import { documentOf, type TestEnvDeps } from "../../packages/core/src/core/test-env/deps.js";

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

describe("a task pins the approved environment it starts with", () => {
  it("writes the pin with the task's own start, and a later approval changes the next task, not this one", async () => {
    const { deps, start } = await world();
    const first = await approve(deps, body(), 1);
    const one = await start();
    expect(await readTestEnvPin(deps, COMPANY, PROJECT, one.task.taskId)).toEqual({ revision: 1, digest: first });
    const second = await approve(deps, body({ roundBudgetMin: 45 }), 2);
    expect(await readTestEnvPin(deps, COMPANY, PROJECT, one.task.taskId)).toEqual({ revision: 1, digest: first });
    const two = await start();
    expect(await readTestEnvPin(deps, COMPANY, PROJECT, two.task.taskId)).toEqual({ revision: 2, digest: second });
  });

  it("pins nothing when the project has no approved environment, and when the switch is off", async () => {
    const none = await world();
    expect(await readTestEnvPin(none.deps, COMPANY, PROJECT, (await none.start()).task.taskId)).toBeUndefined();
    const off = await world({ ROVARA_TEST_ENVIRONMENT: "0" });
    await approve(off.deps, body(), 1);
    expect(await readTestEnvPin(off.deps, COMPANY, PROJECT, (await off.start()).task.taskId)).toBeUndefined();
  });

  it("records an environment the flow cannot carry out as not applied, with the reason, and the task still starts", async () => {
    const { deps, start } = await world();
    const withService = body({ services: [{ name: "scorer", kind: "sagemaker_runtime", match: { endpointName: "scorer" }, mode: "mock", mock: { fixtureSetRef: "a".repeat(64), schemaRef: "b".repeat(64), unmatched: "fail" } }] });
    await approve(deps, withService, 1);
    const started = await start();
    expect(await readTestEnvPin(deps, COMPANY, PROJECT, started.task.taskId)).toEqual({ revision: 1, digest: testEnvDigest(withService), unused: "services_not_connected" });
    expect(await createTaskTestEnvironment(deps, { orgId: COMPANY }).stepPlan({ project: PROJECT, taskId: started.task.taskId, mode: "IMPLEMENT" })).toBeUndefined();
  });

  it("an approved row that names production (it cannot even be read back) is never used", async () => {
    const { deps } = await world();
    // Not parsed: the schema itself refuses a production target, and a row written by an older build or another path may still hold one.
    const prod = { ...body(), tier: "shared", shared: { baseUrl: "https://api.prod.example.com", leaseScope: "env", dataNamespace: "task_prefix" } } as unknown as TestEnvironmentBody;
    await deps.store.put({ item: documentOf({ ...testEnvRevisionKey(COMPANY, PROJECT, 1), entityType: "TEST_ENV_REVISION", orgId: COMPANY, project: PROJECT, revision: 1, approvedAt: "2026-11-09T09:00:00.000Z", approvedBy: "o", digest: "c".repeat(64), requestId: "r1", lessSafe: [], environment: prod }) });
    await deps.store.put({ item: documentOf({ ...testEnvLatestKey(COMPANY, PROJECT), entityType: "TEST_ENV_LATEST", orgId: COMPANY, project: PROJECT, revision: 1, digest: "c".repeat(64) }) });
    const found = await testEnvironmentForStart(deps, { orgId: COMPANY, project: PROJECT, taskId: "t1" });
    expect(found.used).toBeUndefined();
  });
});

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
    expect(checks?.requires).toEqual(["task.testEnvironment.v1"]);
    // The run's first commands are not the environment's checks (the task's policy was edited since): the run goes out as it would without an environment.
    expect(await seam.stepPlan({ project: PROJECT, taskId: started.task.taskId, mode: "CHECKS", readiness: [cmd("npm", ["run", "other"])] })).toBeUndefined();
    expect(await seam.stepPlan({ project: PROJECT, taskId: started.task.taskId, mode: "CHECKS" })).toBeUndefined();
    // A coding run is told the plan only when the environment has dependencies, and test services are off here.
    expect(await seam.stepPlan({ project: PROJECT, taskId: started.task.taskId, mode: "IMPLEMENT" })).toBeUndefined();
  });

  it("a task with no pin (an environment approved after it started is not read) gets no plan", async () => {
    const { deps, start } = await world();
    const started = await start();
    await approve(deps, body(), 1);
    expect(await createTaskTestEnvironment(deps, { orgId: COMPANY }).stepPlan({ project: PROJECT, taskId: started.task.taskId, mode: "CHECKS", readiness: [cmd("npm", ["test"])] })).toBeUndefined();
  });

  it("names the worker features a plan needs, so a worker that lacks one is refused the run and never sent it without", () => {
    expect(featuresForTestPlan(undefined)).toEqual([]);
    const plan = { revision: 1, digest: "a".repeat(64), roundBudgetMin: 30, selection: { method: "full", alwaysRun: [], fullSuiteOn: [] }, checks: [{ id: "u", kind: "test", coveragePath: "coverage/lcov.info" }] } as never;
    expect(featuresForTestPlan(undefined, plan).sort()).toEqual(["task.testEnvCoveragePath.v1", "task.testEnvironment.v1"]);
    const dependency = { backing: "emulated", seeds: [{ command: { cwd: "x", executable: "y", args: [], timeoutSeconds: 5 }, lock: { entries: [] } }] } as never;
    expect(featuresForTestPlan([dependency]).sort()).toEqual(["task.testServices.aws.v1", "task.testServices.seedLock.v1", "task.testServices.v1"]);
  });
});

describe("a pin is read, not trusted", () => {
  const pinRow = (taskId: string, fields: Record<string, unknown>) => documentOf({ pk: projectPk(COMPANY, PROJECT), sk: `TESTENV#PIN#${taskId}`, entityType: "TEST_ENV_PIN", orgId: COMPANY, project: PROJECT, taskId, ...fields });

  it("a row that names another task, project or company, or a revision that is not a number, is no pin", async () => {
    const { deps } = await world();
    const digest = await approve(deps, body(), 1);
    await deps.store.put({ item: pinRow("t2", { taskId: "t1", revision: 1, digest }) });
    expect(await readTestEnvPin(deps, COMPANY, PROJECT, "t2")).toBeUndefined();
    await deps.store.put({ item: pinRow("t3", { orgId: "org_00000000000000000001", revision: 1, digest }) });
    expect(await readTestEnvPin(deps, COMPANY, PROJECT, "t3")).toBeUndefined();
    await deps.store.put({ item: pinRow("t4", { revision: "1", digest }) });
    expect(await readTestEnvPin(deps, COMPANY, PROJECT, "t4")).toBeUndefined();
    await deps.store.put({ item: pinRow("t5", { revision: 1, digest }) });
    expect(await readTestEnvPin(deps, COMPANY, PROJECT, "t5")).toEqual({ revision: 1, digest });
  });

  it("a pin whose digest is not the environment's own digest gives no plan: it names an environment the rules would not read back", async () => {
    const { deps } = await world();
    await approve(deps, body(), 1);
    await deps.store.put({ item: pinRow("t6", { revision: 1, digest: "e".repeat(64) }) });
    expect(await createTaskTestEnvironment(deps, { orgId: COMPANY }).stepPlan({ project: PROJECT, taskId: "t6", mode: "CHECKS", readiness: [cmd("npm", ["test"])] })).toBeUndefined();
  });
});

describe("an approved environment survives a damaged store row without being read as none", () => {
  it("a revision row that does not read back throws, so a task is never started on a guess", async () => {
    const { deps } = await world();
    await approve(deps, body(), 1);
    await deps.store.put({ item: documentOf({ ...testEnvRevisionKey(COMPANY, PROJECT, 1), entityType: "TEST_ENV_REVISION", orgId: COMPANY, project: PROJECT, revision: 1, approvedAt: "x", digest: "f".repeat(64), environment: { nonsense: true } }) });
    await expect(readApprovedTestEnvironment(deps, COMPANY, PROJECT)).rejects.toThrow(/could not be read/);
    expect(await testEnvironmentForStart(deps, { orgId: COMPANY, project: PROJECT, taskId: "t1" })).toEqual({});
  });
});

