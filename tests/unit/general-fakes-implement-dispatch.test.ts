// General fakes slice 2 (DEC 234): the coding run's own verification may use Rovara-made fakes too. The broker sends `generalFakes` on an IMPLEMENT payload only while the project's setting is on AND the run
// carries checks to run, and only to a worker that lists the feature. Off, or no checks: the payload and the required features are byte-identical to a project without the setting.
import { describe, expect, it } from "vitest";
import { GENERAL_FAKES_FEATURE, WORKER_INVOCATION_FEATURES, WorkerInvocationSchema, type JsonValue, type ProjectDefinition, type WorkflowSnapshot } from "@agentx/contracts";
import { startImplementation } from "../../packages/broker/src/core/build-step/start.js";
import { readTask, workspaceOperations } from "../../packages/broker/src/core/task-flow/reads.js";
import { readWorkspace } from "../../packages/broker/src/core/task-flow/stage-machine.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { createHarness, definition, newRequestId } from "../support/task-flow-harness.js";

const CHECK = { id: "unit", label: "Unit", kind: "test", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 60 } };

async function world(setting: unknown, options: { checks?: boolean } = {}) {
  const h = createHarness({ understandFirst: false, machines: { startingChecks: 0, features: WORKER_INVOCATION_FEATURES } });
  await h.registerProject((setting === undefined ? definition : { ...definition, generalFakes: setting }) as ProjectDefinition);
  const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Change", workflow: true, workflowPath: "QUICK" });
  const answered = new Set<string>();
  for (let round = 0; round < 8; round++) {
    const current = (await readWorkspace(h.deps, started.task.workspaceId))!;
    if (current.status === "READY" && current.activeOperationId === null) break;
    await h.flow.dispatchOnce({ maxMessages: 10 }); h.clock.advance(70);
    const after = (await readWorkspace(h.deps, started.task.workspaceId))!;
    const job = after.machine === undefined ? undefined : h.machines.delivered(after.machine.machineId).find((entry) => !answered.has(entry.operationId));
    if (job === undefined) continue; answered.add(job.operationId);
    await h.flow.recordResult({ workspaceId: after.id, operationId: job.operationId, fence: job.fence ?? after.fence, status: "SUCCEEDED" });
  }
  const task = (await readTask(h.deps, started.task.taskId))!;
  // A fix round for a conflict: coding that needs no approved plan document, with the project's checks to run after it.
  const workflow = { ...task.workflow!, revision: task.workflow!.revision + 1, stage: "IMPLEMENT", state: "READY", fixSource: "conflict", fixProblems: ["a.txt"],
    checkPolicy: { required: options.checks === false ? [] : [CHECK], optional: [], selectedOptionalIds: [], proposed: [] },
  } as unknown as WorkflowSnapshot;
  await h.store.update({ key: taskKey(task.taskId), ops: [{ op: "set", path: ["workflow"], value: JSON.parse(JSON.stringify(workflow)) as JsonValue }] });
  h.deps.artifacts = { get: async () => undefined };
  expect(await startImplementation(h.deps, { taskId: task.taskId, workflowRevision: workflow.revision })).toBe("STARTED");
  const operation = (await workspaceOperations(h.deps, task.workspaceId)).find((entry) => entry.workflowMode === "IMPLEMENT" && entry.dispatch.payload !== undefined && JSON.stringify(entry.dispatch.payload).includes("workflowFix"))!;
  await h.flow.dispatchOnce({ maxMessages: 10 });
  const workspace = (await readWorkspace(h.deps, task.workspaceId))!;
  const job = h.machines.delivered(workspace.machine!.machineId).find((entry) => entry.operationId === operation.id);
  return { operation, job };
}

describe("general fakes on the IMPLEMENT payload", () => {
  it("sends the services and requires the feature while the setting is on and the run has checks", async () => {
    const { operation, job } = await world({ enabled: true, services: [{ variable: "PAYMENTS_API_URL", spec: "repo/demo/openapi.yaml" }] });
    expect(operation.dispatch.payload).toMatchObject({ readiness: [expect.anything()], generalFakes: { services: [{ variable: "PAYMENTS_API_URL", spec: "repo/demo/openapi.yaml" }] } });
    expect(operation.dispatch.requires).toContain(GENERAL_FAKES_FEATURE);
    expect(job).toMatchObject({ payload: { generalFakes: { services: [{ variable: "PAYMENTS_API_URL" }] } } });
  });

  it("the worker's payload schema takes the services on a checks or coding run and on no other mode", () => {
    const invocation = (workflowMode: string) => WorkerInvocationSchema.safeParse({ protocolVersion: 1, kind: "task", operationId: "00000000-0000-4000-8000-000000000001", workspaceId: "00000000-0000-4000-8000-000000000002", fence: 1, projectRevision: 1,
      callbackCapability: "c".repeat(64), payload: { workflowMode, conversationId: "00000000-0000-4000-8000-000000000003", prompt: "x", generalFakes: { services: [{ variable: "PAYMENTS_API_URL" }] } } }).success;
    expect(invocation("CHECKS")).toBe(true);
    expect(invocation("IMPLEMENT")).toBe(true);
    for (const mode of ["PLAN", "REVIEW", "SETUP_DRAFT"]) expect(invocation(mode), mode).toBe(false);
  });
});
