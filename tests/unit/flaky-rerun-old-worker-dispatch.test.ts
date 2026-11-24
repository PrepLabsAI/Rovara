// DEC 254zzz448/461 (the failing-test rerun has no switch): the broker and the worker image ship together, and a worker that does not list `task.flakyRerun.v1` is never sent a plan it cannot read. Through the broker's own
// code: an approved environment, the CHECKS step the real seam builds from it (default environment: no variable at all), the step accepted into the task flow, and the dispatch to a worker. A worker whose health lacks the
// feature is refused the step with the fixed "too old" sentence and nothing is delivered (never silently run without the rerun).
import { describe, expect, it } from "vitest";
import { TASK_FLAKY_RERUN_FEATURE, TestEnvironmentBodySchema, WORKER_INVOCATION_FEATURES, testEnvDigest, type JsonValue, type TestEnvironmentBody } from "@agentx/contracts";
import { documentOf, type TestEnvDeps } from "../../packages/broker/src/core/test-env/deps.js";
import { testEnvLatestKey, testEnvRevisionKey } from "../../packages/broker/src/core/test-env/environment.js";
import { createTaskTestEnvironment } from "../../packages/broker/src/core/test-env/seam.js";
import { readTask, workspaceOperations } from "../../packages/broker/src/core/task-flow/reads.js";
import { acceptStep, readWorkspace } from "../../packages/broker/src/core/task-flow/stage-machine.js";
import { COMPANY, createHarness, newRequestId } from "../support/task-flow-harness.js";

const PROJECT = "payments";
const TOO_OLD = "this worker is too old to run this step; upgrade it";
const cmd = (executable: string, args: string[] = []) => ({ cwd: "repo/demo", executable, args, timeoutSeconds: 600 });
const READY = [cmd("npm", ["test"])];
const environmentBody = (): TestEnvironmentBody => TestEnvironmentBodySchema.parse({
  tier: "sandbox", repos: [{ repositoryId: "demo", setupCommands: [], checks: [{ id: "unit", label: "Unit tests", command: cmd("npm", ["test"]), kind: "test" }] }],
  roundBudgetMin: 30, selection: { method: "full", alwaysRun: [], fullSuiteOn: [] }, nightly: { enabled: false, cronUtc: "0 6 * * *", branch: "main" }, services: [],
  data: { seeds: [], generator: "faker_seeded", seed: 7 }, accounts: [], prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] }, capture: { screenshots: "failed", video: false, traces: false },
});
const OLD_WORKER = WORKER_INVOCATION_FEATURES.filter((feature) => feature !== TASK_FLAKY_RERUN_FEATURE);

async function checksStep(env: NodeJS.ProcessEnv, features: readonly string[]) {
  const h = createHarness({ understandFirst: false, machines: { startingChecks: 0, features: [...features] } });
  await h.registerProject();
  const deps: TestEnvDeps = { store: h.store, now: () => h.clock.now, env };
  const seam = createTaskTestEnvironment(deps, { orgId: COMPANY });
  h.deps.testEnvironment = seam;
  const environment = environmentBody();
  const digest = testEnvDigest(environment);
  await h.store.put({ item: documentOf({ ...testEnvRevisionKey(COMPANY, PROJECT, 1), entityType: "TEST_ENV_REVISION", orgId: COMPANY, project: PROJECT, revision: 1, approvedAt: "2026-11-09T09:00:00.000Z", approvedBy: "owner", digest, requestId: "r1", lessSafe: [], environment }) });
  await h.store.put({ item: documentOf({ ...testEnvLatestKey(COMPANY, PROJECT), entityType: "TEST_ENV_LATEST", orgId: COMPANY, project: PROJECT, revision: 1, digest }) });
  const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: PROJECT, instructions: "Add a retry.", workflow: true, workflowPath: "QUICK" });
  const task0 = (await readTask(h.deps, started.task.taskId))!;
  const answered = new Set<string>();
  for (let round = 0; round < 8; round += 1) {
    const current = (await readWorkspace(h.deps, task0.workspaceId))!;
    if (current.status === "READY" && current.activeOperationId === null) break;
    await h.flow.dispatchOnce({ maxMessages: 10 });
    h.clock.advance(70);
    const after = (await readWorkspace(h.deps, task0.workspaceId))!;
    const job = after.machine === undefined ? undefined : h.machines.delivered(after.machine.machineId).find((entry) => !answered.has(entry.operationId));
    if (job === undefined) continue;
    answered.add(job.operationId);
    await h.flow.recordResult({ workspaceId: after.id, operationId: job.operationId, fence: job.fence ?? after.fence, status: "SUCCEEDED" });
  }
  const stepPlan = await seam.stepPlan({ project: PROJECT, taskId: task0.taskId, mode: "CHECKS", readiness: READY });
  expect(stepPlan).toBeDefined();
  const task = (await readTask(h.deps, task0.taskId))!;
  const workspace = (await readWorkspace(h.deps, task.workspaceId))!;
  const accepted = await acceptStep(h.deps, {
    task, workspace, requestId: newRequestId(), prompt: "Run the task's selected checks again on the current code. Do not edit files.", workflowMode: "CHECKS",
    payload: JSON.parse(JSON.stringify({ readiness: READY, testEnvironment: stepPlan!.plan })) as Record<string, JsonValue>,
    requires: ["task.workflowMode", "task.readiness", ...stepPlan!.requires],
  });
  expect(accepted.result).toBe("STARTED");
  await h.flow.dispatchOnce({ maxMessages: 10 });
  const machine = (await readWorkspace(h.deps, task.workspaceId))!.machine!.machineId;
  const after = (await workspaceOperations(h.deps, task.workspaceId)).find((entry) => entry.id === accepted.operation!.id)!;
  return { stepPlan: stepPlan!, after, delivered: h.machines.delivered(machine).map((job) => job.operationId), operationId: accepted.operation!.id };
}

describe("the failing-test rerun is on by default and never reaches a worker that cannot read it", () => {
  it("default environment, a worker image that lacks the feature: the step ends with the fixed 'too old' sentence and nothing is delivered", async () => {
    const w = await checksStep({ ROVARA_TEST_ENVIRONMENT: "1" }, OLD_WORKER);
    expect(w.stepPlan.plan.flakyRerun).toBe(true);
    expect(w.stepPlan.requires).toContain(TASK_FLAKY_RERUN_FEATURE);
    expect(w.after).toMatchObject({ status: "FAILED", error: TOO_OLD });
    expect(w.delivered).not.toContain(w.operationId);
  });

  it("default environment, a worker image that lists the feature: the step is delivered with the rerun plan", async () => {
    const w = await checksStep({ ROVARA_TEST_ENVIRONMENT: "1" }, WORKER_INVOCATION_FEATURES);
    expect(w.after.status).not.toBe("FAILED");
    expect(w.delivered).toContain(w.operationId);
  });
});
