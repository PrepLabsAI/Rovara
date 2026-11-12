// The dispatch guard for a wide AWS plan, end to end through the broker's own code: an environment approved with services beyond s3, sqs and dynamodb, the CHECKS step the real seam builds from it, the step accepted
// into the task flow, and the dispatch to a worker. A worker whose health lacks `task.testServices.aws.allServices.v1` is refused the step with the fixed "too old" sentence and nothing is delivered; a feature-complete
// worker is sent it.
import { describe, expect, it } from "vitest";
import {
  TEST_SERVICES_AWS_ALL_SERVICES_FEATURE, TestEnvironmentBodySchema, WORKER_INVOCATION_FEATURES, testEnvDigest, type JsonValue, type TestEnvironmentBody,
} from "@agentx/contracts";
import { documentOf, type TestEnvDeps } from "../../packages/broker/src/core/test-env/deps.js";
import { testEnvLatestKey, testEnvRevisionKey } from "../../packages/broker/src/core/test-env/environment.js";
import { createTaskTestEnvironment } from "../../packages/broker/src/core/test-env/seam.js";
import { readTask, workspaceOperations } from "../../packages/broker/src/core/task-flow/reads.js";
import { acceptStep, readWorkspace } from "../../packages/broker/src/core/task-flow/stage-machine.js";
import { COMPANY, createHarness, newRequestId } from "../support/task-flow-harness.js";
import { pinnedCatalog, verifiedCatalog } from "../support/catalog-pinning.js";

const PROJECT = "payments";
const ON = { ROVARA_TEST_ENVIRONMENT: "1", ROVARA_TEST_SERVICES: "1" };
const cmd = (executable: string, args: string[] = []) => ({ cwd: "repo/demo", executable, args, timeoutSeconds: 600 });
const aws = (service: string, over: Record<string, unknown> = {}) => ({
  id: `aws-${service}`, name: service, kind: service === "sqs" ? "queue" : "cloud_api", family: `aws:${service}`, found: [{ path: "template.yaml", line: 4 }], usedBy: ["integration"],
  backing: { kind: "emulated", catalogId: "local-aws@r1", awsServices: [service], region: "us-east-1" }, connect: { env: [], hostAliases: [] }, seeds: [], reset: "fresh_per_round", ...over,
});
const body = (dependencies: unknown[]): TestEnvironmentBody => TestEnvironmentBodySchema.parse({
  tier: "sandbox", repos: [{ repositoryId: "demo", setupCommands: [], checks: [{ id: "unit", label: "Unit tests", command: cmd("npm", ["test"]), kind: "test" }] }],
  roundBudgetMin: 30, selection: { method: "full", alwaysRun: [], fullSuiteOn: [] }, nightly: { enabled: false, cronUtc: "0 6 * * *", branch: "main" }, services: [],
  data: { seeds: [], generator: "faker_seeded", seed: 7 }, accounts: [], prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] }, capture: { screenshots: "failed", video: false, traces: false }, dependencies,
});
const TOO_OLD = "this worker is too old to run this step; upgrade it";

/** A task whose workspace is ready, pinned to an approved environment with these dependencies, on a worker that lists `features`. */
async function world(dependencies: unknown[], features: readonly string[]) {
  const h = createHarness({ understandFirst: false, machines: { startingChecks: 0, features: [...features] } });
  await h.registerProject();
  const deps: TestEnvDeps = { store: h.store, now: () => h.clock.now, env: ON, serviceCatalog: async () => verifiedCatalog(pinnedCatalog()) };
  const seam = createTaskTestEnvironment(deps, { orgId: COMPANY });
  h.deps.testEnvironment = seam;
  // The environment is approved (the same rows the approval gate writes), then a task starts and pins it.
  const environment = body(dependencies);
  const digest = testEnvDigest(environment);
  await h.store.put({ item: documentOf({ ...testEnvRevisionKey(COMPANY, PROJECT, 1), entityType: "TEST_ENV_REVISION", orgId: COMPANY, project: PROJECT, revision: 1, approvedAt: "2026-11-09T09:00:00.000Z", approvedBy: "owner", digest, requestId: "r1", lessSafe: [], environment }) });
  await h.store.put({ item: documentOf({ ...testEnvLatestKey(COMPANY, PROJECT), entityType: "TEST_ENV_LATEST", orgId: COMPANY, project: PROJECT, revision: 1, digest }) });
  const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: PROJECT, instructions: "Add a retry.", workflow: true, workflowPath: "QUICK" });
  const task = (await readTask(h.deps, started.task.taskId))!;
  // The workspace is made ready the way the flow does: each job it is given is handed to the worker and answered.
  const answered = new Set<string>();
  for (let round = 0; round < 8; round += 1) {
    const current = (await readWorkspace(h.deps, task.workspaceId))!;
    if (current.status === "READY" && current.activeOperationId === null) break;
    await h.flow.dispatchOnce({ maxMessages: 10 });
    h.clock.advance(70);
    const after = (await readWorkspace(h.deps, task.workspaceId))!;
    const job = after.machine === undefined ? undefined : h.machines.delivered(after.machine.machineId).find((entry) => !answered.has(entry.operationId));
    if (job === undefined) continue;
    answered.add(job.operationId);
    await h.flow.recordResult({ workspaceId: after.id, operationId: job.operationId, fence: job.fence ?? after.fence, status: "SUCCEEDED" });
  }
  return { h, task, answered, seam };
}

/** The CHECKS step the way `startChecksRerun` builds it: the seam's plan and the features it needs, accepted into the flow. */
async function acceptChecks(w: Awaited<ReturnType<typeof world>>) {
  const stepPlan = await w.seam.stepPlan({ project: PROJECT, taskId: w.task.taskId, mode: "CHECKS", readiness: [cmd("npm", ["test"])] });
  expect(stepPlan).toBeDefined();
  const task = (await readTask(w.h.deps, w.task.taskId))!;
  const workspace = (await readWorkspace(w.h.deps, task.workspaceId))!;
  const accepted = await acceptStep(w.h.deps, {
    task, workspace, requestId: newRequestId(), prompt: "Run the task's selected checks again on the current code. Do not edit files.", workflowMode: "CHECKS",
    payload: JSON.parse(JSON.stringify({ readiness: [cmd("npm", ["test"])], testEnvironment: stepPlan!.plan })) as Record<string, JsonValue>,
    requires: ["task.workflowMode", "task.readiness", ...stepPlan!.requires],
  });
  expect(accepted.result).toBe("STARTED");
  return { stepPlan: stepPlan!, operation: accepted.operation!, workspaceId: task.workspaceId };
}

const WIDE = [aws("sns", { connect: { env: [], hostAliases: ["aws"] } }), aws("secrets-manager"), aws("kinesis")];
const NARROW = [aws("s3", { connect: { env: [], hostAliases: ["aws"] } }), aws("sqs"), aws("dynamodb")];
const OLD_WORKER = WORKER_INVOCATION_FEATURES.filter((feature) => feature !== TEST_SERVICES_AWS_ALL_SERVICES_FEATURE);

describe("a wide plan at the dispatch guard", () => {
  it("builds the step with the all-services feature among what it requires", async () => {
    const w = await world(WIDE, WORKER_INVOCATION_FEATURES);
    const { stepPlan, operation } = await acceptChecks(w);
    expect(stepPlan.plan.dependencies!.map((plan) => plan.aws!.services)).toEqual([["sns"], ["secrets-manager"], ["kinesis"]]);
    expect(stepPlan.requires).toContain(TEST_SERVICES_AWS_ALL_SERVICES_FEATURE);
    expect(operation.dispatch.requires).toContain(TEST_SERVICES_AWS_ALL_SERVICES_FEATURE);
  });

  it("is refused, with the fixed sentence and nothing delivered, by a worker whose health lacks the feature", async () => {
    const w = await world(WIDE, OLD_WORKER);
    const { operation, workspaceId } = await acceptChecks(w);
    await w.h.flow.dispatchOnce({ maxMessages: 10 });
    const machine = (await readWorkspace(w.h.deps, workspaceId))!.machine!.machineId;
    const after = (await workspaceOperations(w.h.deps, workspaceId)).find((entry) => entry.id === operation.id)!;
    expect(after).toMatchObject({ status: "FAILED", error: TOO_OLD });
    expect(w.h.machines.delivered(machine).map((job) => job.operationId)).not.toContain(operation.id);
  });

  it("is accepted and delivered, with the plan, by a feature-complete worker", async () => {
    const w = await world(WIDE, WORKER_INVOCATION_FEATURES);
    const { operation, workspaceId } = await acceptChecks(w);
    await w.h.flow.dispatchOnce({ maxMessages: 10 });
    const workspace = (await readWorkspace(w.h.deps, workspaceId))!;
    const job = w.h.machines.delivered(workspace.machine!.machineId).find((entry) => entry.operationId === operation.id);
    expect(job).toBeDefined();
    expect(job).toMatchObject({ payload: { workflowMode: "CHECKS", testEnvironment: { dependencies: [{ aws: { services: ["sns"] } }, { aws: { services: ["secrets-manager"] } }, { aws: { services: ["kinesis"] } }] } } });
    const after = (await workspaceOperations(w.h.deps, workspaceId)).find((entry) => entry.id === operation.id)!;
    expect(after.status).not.toBe("FAILED");
  });

  it("a plan of the three that were always seeded still goes to a worker without the feature", async () => {
    const w = await world(NARROW, OLD_WORKER);
    const { stepPlan, operation, workspaceId } = await acceptChecks(w);
    expect(stepPlan.requires).not.toContain(TEST_SERVICES_AWS_ALL_SERVICES_FEATURE);
    await w.h.flow.dispatchOnce({ maxMessages: 10 });
    const workspace = (await readWorkspace(w.h.deps, workspaceId))!;
    expect(w.h.machines.delivered(workspace.machine!.machineId).some((entry) => entry.operationId === operation.id)).toBe(true);
  });
});
