// General fakes slice 1 (DEC 234): the broker sends `generalFakes` on a CHECKS payload only while the task's project revision has the setting on, and only to a worker that lists the feature. Without the
// setting (absent, off, or damaged) the payload and the required features are byte-identical to before.
import { describe, expect, it } from "vitest";
import { GENERAL_FAKES_FEATURE, WORKER_INVOCATION_FEATURES, type JsonValue, type ProjectDefinition, type WorkflowSnapshot } from "@agentx/contracts";
import { startChecksRerun } from "../../packages/broker/src/core/build-step/start.js";
import { readTask, workspaceOperations } from "../../packages/broker/src/core/task-flow/reads.js";
import { readWorkspace } from "../../packages/broker/src/core/task-flow/stage-machine.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { createHarness, definition, newRequestId } from "../support/task-flow-harness.js";

async function world(setting: unknown, feature = true) {
  const h = createHarness({ understandFirst: false, machines: { startingChecks: 0, features: WORKER_INVOCATION_FEATURES.filter((entry) => feature || entry !== GENERAL_FAKES_FEATURE) } });
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
  const workflow = { ...task.workflow!, revision: task.workflow!.revision + 1, stage: "VERIFY", state: "BLOCKED", blockReason: "candidate checks failed or have unknown results",
    checkPolicy: { required: [{ id: "unit", label: "Unit", kind: "test", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 60 } }], optional: [], selectedOptionalIds: [], proposed: [] },
  } as unknown as WorkflowSnapshot;
  await h.store.update({ key: taskKey(task.taskId), ops: [{ op: "set", path: ["workflow"], value: JSON.parse(JSON.stringify(workflow)) as JsonValue }] });
  h.deps.artifacts = { get: async () => undefined };
  expect(await startChecksRerun(h.deps, { taskId: task.taskId, workflowRevision: workflow.revision }, { requestId: newRequestId(), actorId: "owner" })).toBe("STARTED");
  const operation = (await workspaceOperations(h.deps, task.workspaceId)).find((entry) => entry.workflowMode === "CHECKS")!;
  await h.flow.dispatchOnce({ maxMessages: 10 });
  const workspace = (await readWorkspace(h.deps, task.workspaceId))!;
  const job = h.machines.delivered(workspace.machine!.machineId).find((entry) => entry.operationId === operation.id);
  return { operation, job };
}

describe("general fakes on the CHECKS payload", () => {

  it("is never delivered to a worker that does not list the feature", async () => {
    const { job } = await world({ enabled: true, services: [{ variable: "PAYMENTS_API_URL" }] }, false);
    expect(job === undefined || !JSON.stringify(job).includes("generalFakes")).toBe(true);
  });
});
