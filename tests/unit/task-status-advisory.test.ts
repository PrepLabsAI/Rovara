import { describe, expect, it } from "vitest";
import { OperationSchema, WorkspaceInstanceSchema, change } from "@agentx/contracts";
import { operationKey, taskPointerKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { readTask } from "../../packages/broker/src/core/task-flow/reads.js";
import { handleTaskRoute } from "../../packages/broker/src/core/task-flow/routes.js";
import { acceptStep } from "../../packages/broker/src/core/task-flow/stage-machine.js";
import { toDocument, type WorkspaceRecord } from "../../packages/broker/src/core/task-flow/records.js";
import { taskView } from "../../packages/broker/src/aws/developer-tasks.js";
import { currentOperation, type DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import { COMPANY, createHarness, newRequestId } from "../support/task-flow-harness.js";

describe("advisory task status through stored steps and reads", () => {
  it("serves WAITING / PLAN_REVIEW after a failed critique, then follows the next build", async () => {
    const h = createHarness();
    await h.registerProject();
    const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Fix the retry", workflow: true, workflowPath: "QUICK" });
    const id = started.task.taskId, wid = started.task.workspaceId;
    const task = (await readTask(h.deps, id))!;
    const workflow = { ...task.workflow!, stage: "PLAN_REVIEW" as const, state: "WAITING" as const };
    await h.store.put({ item: toDocument({ ...task, workflow }) });
    await h.store.update({ key: taskPointerKey(COMPANY, wid), ops: [change.remove("pendingPrompt")] });
    const ready = async () => {
      await h.store.update({ key: workspaceKey(COMPANY, wid), ops: [change.set("status", "READY"), change.set("activeOperationId", null)] });
      return (await h.store.get(workspaceKey(COMPANY, wid))) as unknown as WorkspaceRecord;
    };
    const plan = await acceptStep(h.deps, { task: { ...task, workflow }, workspace: await ready(), requestId: newRequestId(), prompt: "Plan", workflowMode: "PLAN" });
    expect(plan.result).toBe("STARTED");
    await h.store.update({ key: operationKey(COMPANY, wid, plan.operation!.id), ops: [change.set("status", "SUCCEEDED")] });
    h.clock.advance(1);
    const critique = await acceptStep(h.deps, { task: { ...task, workflow }, workspace: await ready(), requestId: newRequestId(), prompt: "Check the plan", workflowMode: "PLAN_CRITIQUE" });
    expect(critique.result).toBe("STARTED");
    expect(critique.operation).toMatchObject({ kind: "task", workflowMode: "PLAN_CRITIQUE" });
    await h.store.update({ key: operationKey(COMPANY, wid, critique.operation!.id), ops: [change.set("status", "FAILED"), change.set("error", "check failed")] });
    const waiting = await handleTaskRoute(h.flow, { method: "GET", path: `/v1/dev/tasks/${id}`, caller: h.owner });
    expect(waiting?.status).toBe(200);
    expect(waiting?.body).toMatchObject({ task: { status: "SUCCEEDED", workflow: { stage: "PLAN_REVIEW", state: "WAITING" } } });
    const view = await h.flow.get(h.owner, id);
    expect(view.operations).toContainEqual({ id: critique.operation!.id, kind: "task", status: "FAILED", workflowMode: "PLAN_CRITIQUE" });
    expect(view.failure).toBeUndefined();
    // The shared operation selector still includes advisory runs for close handling.
    expect(currentOperation([plan.operation!, critique.operation!])?.id).toBe(critique.operation!.id);
    h.clock.advance(1);
    const build = await acceptStep(h.deps, { task: { ...task, workflow }, workspace: await ready(), requestId: newRequestId(), prompt: "Build", workflowMode: "IMPLEMENT" });
    expect(build.result).toBe("STARTED");
    expect((await h.flow.get(h.owner, id)).status).toBe("RUNNING");
    await h.store.update({ key: operationKey(COMPANY, wid, build.operation!.id), ops: [change.set("status", "FAILED"), change.set("error", "build failed")] });
    expect(await h.flow.get(h.owner, id)).toMatchObject({ status: "FAILED", failure: { category: "task_failed", message: "build failed" } });
  });

  it("carries the advisory mode into the hosted task view's status facts", async () => {
    const { pageTask } = await import("../support/page-tasks.js");
    const fixture = pageTask();
    const task = fixture.db.get(`DEVTASK#${fixture.taskId}`, "META") as unknown as DeveloperTaskRecord;
    const now = "2026-11-22T10:00:00.000Z";
    const common = { workspaceId: task.workspaceId, kind: "task", requestId: newRequestId(), payloadHash: "a".repeat(64), createdAt: now, updatedAt: now };
    const plan = OperationSchema.parse({ ...common, id: newRequestId(), workflowMode: "PLAN", status: "SUCCEEDED", fence: 2 });
    const critique = OperationSchema.parse({ ...common, id: newRequestId(), workflowMode: "PLAN_CRITIQUE", status: "FAILED", fence: 3, error: "check failed" });
    const workspace = WorkspaceInstanceSchema.parse({ id: task.workspaceId, ownerKey: task.ownerKey, projectName: task.project, projectRevision: 1, deploymentMode: "ec2-ebs", rootPath: "/mnt/workspace", status: "READY", fence: 3, createdAt: now, updatedAt: now });
    const view = await taskView(fixture.deps, task, { events: 0, details: false, loaded: { workspace, operations: [plan, critique] } });
    expect(view.status).toBe("SUCCEEDED");
    expect(view.failure).toBeUndefined();
  });
});
