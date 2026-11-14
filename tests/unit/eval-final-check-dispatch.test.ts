import { describe, expect, it } from "vitest";
import { WORKER_INVOCATION_FEATURES, type JsonValue, type WorkflowSnapshot } from "@agentx/contracts";
import { startChecksRerun } from "../../packages/broker/src/core/build-step/start.js";
import { readTask, workspaceOperations } from "../../packages/broker/src/core/task-flow/reads.js";
import { readWorkspace } from "../../packages/broker/src/core/task-flow/stage-machine.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { createHarness, newRequestId } from "../support/task-flow-harness.js";
import { evalRequestForChecks } from "../../packages/broker/src/core/proof/eval-round-reader.js";

async function world(feature: boolean, hint = true) {
  const h = createHarness({ understandFirst: false, machines: { startingChecks: 0, features: WORKER_INVOCATION_FEATURES.filter(f => feature || f !== "task.evalRound.v1") } });
  await h.registerProject();
  const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Eval change", workflow: true, workflowPath: "QUICK" });
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
    flow: { ...task.workflow?.flow, tier: { kind: "small", reasons: hint ? [{ code: "eval_hint" }] : [] } },
    checkPolicy: { required: [{ id: "unit", label: "Unit", kind: "test", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 60 } }], optional: [], selectedOptionalIds: [], proposed: [] },
  } as unknown as WorkflowSnapshot;
  await h.store.update({ key: taskKey(task.taskId), ops: [{ op: "set", path: ["workflow"], value: JSON.parse(JSON.stringify(workflow)) as JsonValue }] });
  h.deps.artifacts = { get: async () => undefined };
  const logs: unknown[] = []; h.deps.log = entry => { logs.push(entry); };
  return { h, task, workflow, logs };
}
describe("eval CHECKS dispatch", () => {
  it("bounds paginated metadata including empty pages with a cursor", async () => {
    const w = await world(true); let queries = 0;
    w.h.deps.store.query = async () => { if (++queries > 102) throw new Error("private-cursor"); return { items: [], cursor: "private-cursor" }; };
    expect(await evalRequestForChecks(w.h.deps, w.task, w.workflow)).toBeUndefined(); expect(queries).toBeLessThanOrEqual(100);
  });
  it("does not reset spend when an earlier requested attempt has no saved artifact", async () => {
    const w = await world(true);
    w.h.deps.store.query = async () => ({ items: [{ pk: "workspace", sk: "operation", id: "op-1", kind: "task", status: "SUCCEEDED", createdAt: "2026-11-14T00:00:00Z", dispatch: { payload: { evalRequest: { aiChange: true } } } }] });
    expect(await evalRequestForChecks(w.h.deps, w.task, w.workflow)).toBeUndefined();
  });
  it.each([true, false])("runs the real checks dispatcher with eval feature %s", async feature => {
    const w = await world(feature);
    expect(await startChecksRerun(w.h.deps, { taskId: w.task.taskId, workflowRevision: w.workflow.revision }, { requestId: newRequestId(), actorId: "owner" })).toBe("STARTED");
    const operation = (await workspaceOperations(w.h.deps, w.task.workspaceId)).find(op => op.workflowMode === "CHECKS")!;
    expect(operation.dispatch.payload).toHaveProperty("evalRequest");
    await w.h.flow.dispatchOnce({ maxMessages: 10 });
    const workspace = (await readWorkspace(w.h.deps, w.task.workspaceId))!;
    const job = w.h.machines.delivered(workspace.machine!.machineId).find(entry => entry.operationId === operation.id);
    expect(job).toBeDefined();
    if (feature) expect(job).toMatchObject({ payload: { evalRequest: { aiChange: true, reason: "eval_hint", evalPass: 1, callsAlreadyUsed: 0, costAlreadyUsedMicros: 0 } } });
    else { expect(job).not.toHaveProperty("payload.evalRequest"); expect(JSON.stringify(w.logs)).toContain("eval_request_dropped_unsupported_worker"); }
  });
  it("leaves ordinary checks payloads untouched when the tier has no eval hint", async () => {
    const w = await world(true, false);
    expect(await startChecksRerun(w.h.deps, { taskId: w.task.taskId, workflowRevision: w.workflow.revision }, { requestId: newRequestId(), actorId: "owner" })).toBe("STARTED");
    const operation = (await workspaceOperations(w.h.deps, w.task.workspaceId)).find(op => op.workflowMode === "CHECKS")!;
    expect(operation.dispatch.payload).not.toHaveProperty("evalRequest");
  });
});
