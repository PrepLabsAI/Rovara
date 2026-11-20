// L4-EVP: a CHECKS run that asks for the eval is sent the project's confirmed prompt locations (read at the task's starting revision), only to a worker that lists the feature; two projects never see each other's.
import { describe, expect, it } from "vitest";
import { EVAL_PROMPT_LOCATIONS_FEATURE, WORKER_INVOCATION_FEATURES, type JsonValue, type ProjectDefinition, type PromptLocation, type WorkflowSnapshot } from "@agentx/contracts";
import { startChecksRerun } from "../../packages/broker/src/core/build-step/start.js";
import { readTask, workspaceOperations } from "../../packages/broker/src/core/task-flow/reads.js";
import { readWorkspace } from "../../packages/broker/src/core/task-flow/stage-machine.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { createHarness, definition, newRequestId } from "../support/task-flow-harness.js";

const PAYMENTS: PromptLocation[] = [{ repo: "demo", path: "payments/agent.py", kind: "variable", symbol: "SYSTEM_PROMPT" }];
const project = (name: string, promptLocations?: PromptLocation[]): ProjectDefinition => ({ ...definition, name, ...(promptLocations === undefined ? {} : { promptLocations }) });

async function world(options: { feature?: boolean; hint?: boolean; projects?: Array<[string, PromptLocation[] | undefined]>; run?: string } = {}) {
  const feature = options.feature ?? true;
  const h = createHarness({ understandFirst: false, machines: { startingChecks: 0, features: WORKER_INVOCATION_FEATURES.filter(f => feature || f !== EVAL_PROMPT_LOCATIONS_FEATURE) } });
  for (const [name, locations] of options.projects ?? [["payments", PAYMENTS]]) await h.registerProject(project(name, locations));
  const name = options.run ?? "payments";
  const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: name, instructions: "Eval change", workflow: true, workflowPath: "QUICK" });
  const answered = new Set<string>();
  for (let round = 0; round < 8; round++) {
    const current = (await readWorkspace(h.deps, started.task.workspaceId))!;
    if (current.status === "READY" && current.activeOperationId === null) break;
    await h.flow.dispatchOnce({ maxMessages: 10 }); h.clock.advance(70);
    const after = (await readWorkspace(h.deps, started.task.workspaceId))!;
    const job = after.machine === undefined ? undefined : h.machines.delivered(after.machine.machineId).find(entry => !answered.has(entry.operationId));
    if (job === undefined) continue; answered.add(job.operationId);
    await h.flow.recordResult({ workspaceId: after.id, operationId: job.operationId, fence: job.fence ?? after.fence, status: "SUCCEEDED" });
  }
  const task = (await readTask(h.deps, started.task.taskId))!;
  const workflow = { ...task.workflow!, revision: task.workflow!.revision + 1, stage: "VERIFY", state: "BLOCKED", blockReason: "candidate checks failed or have unknown results",
    flow: { ...task.workflow?.flow, tier: { kind: "small", reasons: (options.hint ?? true) ? [{ code: "eval_hint" }] : [] } },
    checkPolicy: { required: [{ id: "unit", label: "Unit", kind: "test", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 60 } }], optional: [], selectedOptionalIds: [], proposed: [] },
  } as unknown as WorkflowSnapshot;
  await h.store.update({ key: taskKey(task.taskId), ops: [{ op: "set", path: ["workflow"], value: JSON.parse(JSON.stringify(workflow)) as JsonValue }] });
  h.deps.artifacts = { get: async () => undefined };
  const logs: unknown[] = []; h.deps.log = entry => { logs.push(entry); };
  expect(await startChecksRerun(h.deps, { taskId: task.taskId, workflowRevision: workflow.revision }, { requestId: newRequestId(), actorId: "owner" })).toBe("STARTED");
  const operation = (await workspaceOperations(h.deps, task.workspaceId)).find(op => op.workflowMode === "CHECKS")!;
  await h.flow.dispatchOnce({ maxMessages: 10 });
  const workspace = (await readWorkspace(h.deps, task.workspaceId))!;
  const job = h.machines.delivered(workspace.machine!.machineId).find(entry => entry.operationId === operation.id) as { payload?: Record<string, unknown> } | undefined;
  return { operation, job, logs };
}

describe("evalPromptLocations on the CHECKS payload", () => {
  it("drops them for an older worker (logged), and the eval request still goes", async () => {
    const { operation, job, logs } = await world({ feature: false });
    expect(operation.dispatch.payload).toHaveProperty("evalPromptLocations");
    expect(job?.payload).toHaveProperty("evalRequest");
    expect(job?.payload).not.toHaveProperty("evalPromptLocations");
    expect(JSON.stringify(logs)).toContain("eval_prompt_locations_dropped_unsupported_worker");
  });
});
