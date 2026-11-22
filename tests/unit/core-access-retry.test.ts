import { expect, it } from "vitest";
import { change, companyScoped, OUTBOX_PENDING_INDEX } from "@agentx/contracts";
import { createHarness, newRequestId } from "../support/task-flow-harness.js";
import { workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { accessRetryRoute } from "../../packages/broker/src/aws/core-access-retry.js";

it("the existing retry route resumes access before ordinary blocked-step handling", async () => {
  const h = createHarness();
  await h.registerProject();
  const { task } = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Rename a setting", workflow: true, workflowPath: "FULL" });
  const workspace = (await h.store.get(workspaceKey(h.deps.companyId, task.workspaceId)))!;
  const operationId = workspace["activeOperationId"] as string;
  const taskKey = { pk: `DEVTASK#${task.taskId}`, sk: "META" };
  const record = (await h.store.get(taskKey))!;
  const workflow = record["workflow"] as { revision: number; stage: string; state: string };
  const outboxKey = { pk: companyScoped(h.deps.companyId, `OUTBOX#${operationId}`), sk: "OUTBOX" };
  await h.store.update({ key: outboxKey, ops: [change.set("status", "WAITING_FOR_TASK_ACCESS"), change.remove(OUTBOX_PENDING_INDEX.partitionAttribute), change.remove(OUTBOX_PENDING_INDEX.sortAttribute!)] });
  const pause = { entityType: "TASK_ACCESS_PAUSE", schemaVersion: 1, taskId: task.taskId, workspaceId: task.workspaceId, operationId, outboxId: operationId, peopleRevision: 3, workflowRevision: workflow.revision, workflowStage: workflow.stage, workflowState: workflow.state };
  await h.store.put({ item: { pk: `OUTBOX#${operationId}`, sk: "TASK_ACCESS_PAUSE", ...pause } });
  await h.store.put({ item: { pk: taskKey.pk, sk: `TASK_ACCESS_PAUSE#${operationId}`, ...pause } });
  await h.store.put({ item: { pk: taskKey.pk, sk: "PEOPLE", revision: 3 } });
  const calls: string[] = [];
  const route = accessRetryRoute({ async route(request) { calls.push(request.path); return { statusCode: request.method === "GET" ? 200 : 400, headers: {}, body: "{}" }; } }, { caller: async () => ({ principal: h.owner.principal }), flowFor: async () => h.deps });
  const result = await route({ method: "POST", path: `/v1/dev/tasks/${task.taskId}/workflow/retry`, headers: {}, body: JSON.stringify({ requestId: newRequestId(), instructions: "Retry", expectedRevision: workflow.revision }) }, { developerId: h.owner.principal.personId, sessionId: "s", name: "Owner" });
  expect(result?.statusCode).toBe(200);
  expect(await h.store.get(outboxKey)).toMatchObject({ status: "PENDING", id: operationId });
  expect(calls).toEqual([`/v1/dev/tasks/${task.taskId}`]);
});
