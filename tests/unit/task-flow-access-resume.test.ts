import { expect, it } from "vitest";
import { change, companyScoped, OUTBOX_PENDING_INDEX, when } from "@agentx/contracts";
import { createHarness, newRequestId } from "../support/task-flow-harness.js";
import { workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { resumeAccessPausedDispatch } from "../../packages/broker/src/core/task-flow/access-resume.js";

it("resumes the parked operation only on an explicit exact owner retry, preserving its identity and auditing once", async () => {
  const { h, task, workflow, operationId, outboxKey, taskKey } = await paused();
  const request = { requestId: newRequestId(), instructions: "Retry", expectedRevision: workflow.revision };
  expect(await h.flow.relayOnce()).toMatchObject({ delivered: 0 });
  await expect(resumeAccessPausedDispatch(h.deps, h.guest, task.taskId, request)).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
  expect(await resumeAccessPausedDispatch(h.deps, h.owner, task.taskId, request)).toBe(true);
  expect(await h.store.get(outboxKey)).toMatchObject({ status: "PENDING", id: operationId, body: { operationId }, outboxState: `PENDING#${h.deps.companyId}` });
  expect(await resumeAccessPausedDispatch(h.deps, h.owner, task.taskId, request)).toBe(true);
  await expect(resumeAccessPausedDispatch(h.deps, h.owner, task.taskId, { ...request, instructions: "Different" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  expect((await h.store.query({ pk: taskKey.pk, sk: { op: "beginsWith", prefix: "TASK_ACCESS_RETRY#" } })).items).toHaveLength(1);
});

async function paused() {
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
  return { h, task, workflow, operationId, outboxKey, taskKey };
}

it("refuses a stale workflow revision without requeueing the parked operation", async () => {
  const { h, task, workflow, outboxKey } = await paused();
  await expect(resumeAccessPausedDispatch(h.deps, h.owner, task.taskId, { requestId: newRequestId(), instructions: "Retry", expectedRevision: workflow.revision + 1 })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  expect(await h.store.get(outboxKey)).toMatchObject({ status: "WAITING_FOR_TASK_ACCESS" });
});

it("keeps the pause when ownership changes between proof and resume commit", async () => {
  const { h, task, workflow, outboxKey, taskKey } = await paused();
  const transact = h.store.transact.bind(h.store);
  h.store.transact = async (items) => {
    if (items.some((item) => item.kind === "put" && item.item["entityType"] === "TASK_ACCESS_RETRY")) await h.store.update({ key: { pk: taskKey.pk, sk: "PEOPLE" }, ops: [change.set("revision", 4)] });
    return transact(items);
  };
  await expect(resumeAccessPausedDispatch(h.deps, h.owner, task.taskId, { requestId: newRequestId(), instructions: "Retry", expectedRevision: workflow.revision })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  expect(await h.store.get(outboxKey)).toMatchObject({ status: "WAITING_FOR_TASK_ACCESS" });
});

// M12: the proof's PEOPLE revision must survive the resume's later PEOPLE read.
it.each([{ name: "unchanged", removed: false }, { name: "revoked before the resume read", removed: true }])("fences the owner's $name proof", async ({ removed }) => {
  const { h, task, workflow, operationId, outboxKey, taskKey } = await paused();
  const peopleKey = { pk: taskKey.pk, sk: "PEOPLE" };
  h.deps.access = {
    ...h.deps.access,
    async ownerActing(_principal, identity) {
      const people = (await h.store.get(peopleKey))!;
      // Hosted ownerActing has already proved revision 3. A removal now makes
      // resumeOne read revision 4; its own fence alone would accept that revision.
      if (removed) await h.store.update({ key: peopleKey, ops: [change.set("revision", 4)] });
      return { actorId: identity.ownerKey, items: [{ kind: "check", key: peopleKey, condition: when.eq("revision", people["revision"]!) }] };
    },
  };
  const request = { requestId: newRequestId(), instructions: "Retry", expectedRevision: workflow.revision };
  if (removed) {
    await expect(resumeAccessPausedDispatch(h.deps, h.owner, task.taskId, request)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(await h.store.get(outboxKey)).toMatchObject({ status: "WAITING_FOR_TASK_ACCESS" });
    expect(await h.store.get({ pk: taskKey.pk, sk: `TASK_ACCESS_PAUSE#${operationId}` })).toBeDefined();
    expect(await h.store.get({ pk: taskKey.pk, sk: `TASK_ACCESS_RETRY#${request.requestId}` })).toBeUndefined();
  } else {
    expect(await resumeAccessPausedDispatch(h.deps, h.owner, task.taskId, request)).toBe(true);
    expect(await h.store.get(outboxKey)).toMatchObject({ status: "PENDING" });
  }
});
