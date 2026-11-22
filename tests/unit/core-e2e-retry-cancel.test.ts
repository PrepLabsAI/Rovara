import { describe, expect, it } from "vitest";
import { change } from "@agentx/contracts";
import { createHarness, newRequestId } from "../support/task-flow-harness.js";
import { startChecksRerun } from "../../packages/broker/src/core/build-step/start.js";
import { cancelTask } from "../../packages/broker/src/core/task-flow/cancel.js";
import { toDocument } from "../../packages/broker/src/core/task-flow/records.js";
import { dispatchRowKey, taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { dispatchRowItem } from "../../packages/broker/src/core/task-flow/dispatch-rows.js";
import { workspaceKeys } from "../../packages/broker/src/core/task-flow/workspace-location.js";
import { readTask } from "../../packages/broker/src/core/task-flow/reads.js";
import type { ApplicationE2ESeams } from "../../packages/broker/src/core/e2e/application-seams.js";
import { blockedReview, seed, TASK_ID } from "../support/task-actions-world.js";

async function blocked() {
  const h = createHarness();
  await h.registerProject();
  const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Check the application", workflow: true, workflowPath: "QUICK" });
  const task = (await readTask(h.deps, started.task.taskId))!;
  const workflow = { ...task.workflow!, stage: "VERIFY" as const, state: "BLOCKED" as const,
    checkPolicy: { required: [], optional: [], proposed: [], selectedOptionalIds: [], noneReason: "Application scenarios only" },
    e2e: { required: true, contractDigest: "a".repeat(64), policyDigest: "b".repeat(64), bundleDigest: "c".repeat(64), executionPlanDigest: "d".repeat(64), currentGroupRunIds: [], resultRefs: [] } };
  await h.store.update({ key: taskKey(task.taskId), ops: [change.set("workflow", toDocument(workflow))] });
  const location = await workspaceKeys(h.deps, task.workspaceId);
  await h.store.update({ key: location.workspaceKey, ops: [change.set("status", "READY"), change.set("activeOperationId", null)] });
  return { ...h, task, workflow, location, ref: { taskId: task.taskId, workflowRevision: workflow.revision } };
}

describe("required application checks retry and Stop", () => {
  it("refuses a manual checks rerun from the coding stage before starting an operation", async () => {
    const { h, caller } = await seed({ workflow: blockedReview({ stage: "IMPLEMENT", state: "READY" }) });
    const before = (await readTask(h.deps, TASK_ID))!;
    const requestId = newRequestId();
    expect(await startChecksRerun(h.deps, { taskId: TASK_ID, workflowRevision: before.workflow!.revision }, {
      requestId, actorId: caller.principal.personId, manual: { requestId, instructions: "Recheck" },
    })).toBe("STALE");
    expect(await readTask(h.deps, TASK_ID)).toEqual(before);
  });

  it("refuses an ordinary CHECKS fallback when required admission is unavailable", async () => {
    const h = await blocked();
    expect(await startChecksRerun(h.deps, h.ref, { requestId: "retry-1", actorId: h.task.ownerKey })).toBe("STALE");
    expect((await h.store.get(h.location.workspaceKey))?.["activeOperationId"]).toBeNull();
    expect((await readTask(h.deps, h.task.taskId))?.workflow?.state).toBe("BLOCKED");
  });

  it("routes an application-only retry through the typed admission seam", async () => {
    const h = await blocked();
    await h.store.update({ key: taskKey(h.task.taskId), ops: [change.remove(["workflow", "checkPolicy"])] });
    let admitted = 0;
    const retry: ApplicationE2ESeams["rounds"]["retry"] = async (task, input) => {
      if (task.taskId !== h.task.taskId || input.actorId !== h.task.ownerKey || input.requestId !== "retry-1") throw new Error("wrong retry binding");
      admitted += 1;
      return "WAITING";
    };
    h.deps.applicationE2E = { rounds: { retry } } as ApplicationE2ESeams;
    expect(await startChecksRerun(h.deps, h.ref, { requestId: "retry-1", actorId: h.task.ownerKey })).toBe("WAITING");
    expect(admitted).toBe(1);
  });

  it("stops due application checks even before a worker holds the workspace", async () => {
    const h = await blocked();
    await h.store.update({ key: taskKey(h.task.taskId), ops: [change.set(["workflow", "state"], "WAITING")] });
    expect(await cancelTask(h.deps, h.task.taskId)).toMatchObject({ nothingRunning: false });
    const after = (await readTask(h.deps, h.task.taskId))!.workflow!;
    expect(after.state).toBe("BLOCKED");
    expect(after.revision).toBe(h.workflow.revision + 1);
    expect(after.e2e?.qualifiedRound).toBeUndefined();
  });

  it.each(["operation", "fence"] as const)("queued-check Stop writes nothing when the workspace %s changes before commit", async (race) => {
    const h = await blocked();
    await h.store.update({ key: taskKey(h.task.taskId), ops: [change.set(["workflow", "state"], "WAITING")] });
    await h.store.transact([dispatchRowItem(h.deps, h.task.taskId, h.workflow.revision, "CHECKS", new Date(h.clock.now).toISOString())]);
    const keys = [taskKey(h.task.taskId), dispatchRowKey(h.deps.companyId, h.task.taskId, h.workflow.revision)];
    const before = await h.store.getMany(keys);
    const workspace = (await h.store.get(h.location.workspaceKey))!;
    const successor = newRequestId();
    const transact = h.store.transact.bind(h.store);
    let commits = 0;
    h.store.transact = async (items) => {
      commits += 1;
      // A baseline can acquire the workspace without changing the workflow revision.
      await h.store.update({ key: h.location.workspaceKey, ops: race === "operation"
        ? [change.set("activeOperationId", successor), change.set("status", "BUSY")]
        : [change.set("fence", Number(workspace["fence"]) + 1)] });
      return transact(items);
    };
    expect(await cancelTask(h.deps, h.task.taskId)).toEqual({ nothingRunning: true });
    expect(commits).toBe(1);
    expect(await h.store.getMany(keys)).toEqual(before);
    expect(await h.store.get(h.location.workspaceKey)).toEqual({ ...workspace, ...(race === "operation"
      ? { activeOperationId: successor, status: "BUSY" } : { fence: Number(workspace["fence"]) + 1 }) });
  });
});

it("a named baseline cancel never stops a newer operation that acquired the worker after the stop request", async () => {
  const h = await blocked();
  const old = (await h.store.query({ pk: h.location.workspaceKey.pk, sk: { op: "beginsWith", prefix: "OPERATION#" } })).items[0]!;
  const oldId = old["id"];
  if (typeof oldId !== "string") throw new Error("the fixture has no operation id");
  const nextId = newRequestId();
  await h.store.put({ item: { ...old, sk: `OPERATION#${nextId}`, id: nextId, fence: Number(old["fence"]) + 1, status: "RUNNING" } });
  await h.store.update({ key: h.location.workspaceKey, ops: [change.set("status", "BUSY"), change.set("activeOperationId", old["id"]!), change.set("machine", { machineId: "baseline-machine", machineKey: "baseline" })] });
  const update = h.store.update.bind(h.store);
  const transact = h.store.transact.bind(h.store);
  h.deps.store.transact = async (items) => {
    const result = await transact(items);
    if (result.applied && items.some((item) => item.kind === "update" && item.key.sk === old.sk && item.ops.some((op) => op.op === "set" && op.path[0] === "status" && op.value === "CANCEL_REQUESTED"))) {
      await update({ key: h.location.workspaceKey, ops: [change.set("activeOperationId", nextId), change.set("fence", Number(old["fence"]) + 1)] });
    }
    return result;
  };
  let stopped = 0;
  h.deps.machines.stop = async () => { stopped += 1; };
  await cancelTask(h.deps, h.task.taskId, oldId);
  expect(stopped).toBe(0);
  expect((await h.store.get(h.location.workspaceKey))?.["activeOperationId"]).toBe(nextId);
  expect((await h.store.get(h.location.operationKey(nextId)))?.["status"]).toBe("RUNNING");
});

it("never automatically buys another required round without a failed-round record", async () => {
  const h = await blocked(); let retried = 0;
  h.deps.applicationE2E = { rounds: { retry: async () => { retried++; return "WAITING"; } } } as unknown as ApplicationE2ESeams;
  expect(await startChecksRerun(h.deps, h.ref, { requestId: "automatic-retry", actorId: h.task.ownerKey,
    automaticDecision: {} as NonNullable<Parameters<typeof startChecksRerun>[2]["automaticDecision"]> })).toBe("STALE");
  expect(retried).toBe(0);
});

it("cannot claim cancellation after a close wins between the task read and the transaction", async () => {
  const h = await blocked();
  const old = (await h.store.query({ pk: h.location.workspaceKey.pk, sk: { op: "beginsWith", prefix: "OPERATION#" } })).items[0]!;
  const oldId = old["id"];
  if (typeof oldId !== "string") throw new Error("the fixture has no operation id");
  await h.store.update({ key: h.location.operationKey(oldId), ops: [change.set("status", "RUNNING")] });
  await h.store.update({ key: h.location.workspaceKey, ops: [change.set("activeOperationId", old["id"]!)] });
  const transact = h.store.transact.bind(h.store);
  h.deps.store.transact = async (items) => {
    await h.store.update({ key: taskKey(h.task.taskId), ops: [change.set("closeOperationId", "accepted-close")] });
    return transact(items);
  };
  expect(await cancelTask(h.deps, h.task.taskId)).toEqual({ nothingRunning: true });
  expect(await h.store.get(h.location.operationKey(oldId))).toMatchObject({ status: "RUNNING" });
  expect(await h.store.get(h.location.workspaceKey)).toMatchObject({ activeOperationId: old["id"] });
});

it.each(["missing", "closed"] as const)("does not cancel an operation for a %s task", async state => {
  const h = await blocked();
  const old = (await h.store.query({ pk: h.location.workspaceKey.pk, sk: { op: "beginsWith", prefix: "OPERATION#" } })).items[0]!;
  const oldId = old["id"];
  if (typeof oldId !== "string") throw new Error("the fixture has no operation id");
  await h.store.update({ key: h.location.operationKey(oldId), ops: [change.set("status", "RUNNING")] });
  await h.store.update({ key: h.location.workspaceKey, ops: [change.set("activeOperationId", oldId)] });
  if (state === "missing") await h.store.delete({ key: taskKey(h.task.taskId) });
  else await h.store.update({ key: taskKey(h.task.taskId), ops: [change.set("closedAt", "2026-11-22T12:00:00Z")] });
  const before = await h.store.get(h.location.operationKey(oldId));
  expect(await cancelTask(h.deps, h.task.taskId)).toEqual({ nothingRunning: true });
  expect(await h.store.get(h.location.operationKey(oldId))).toEqual(before);
});

it("does not stop queued ordinary verification or a missing workspace", async () => {
  const h = await blocked();
  await h.store.update({ key: taskKey(h.task.taskId), ops: [change.set(["workflow", "state"], "WAITING"), change.remove(["workflow", "e2e"])] });
  const before = await h.store.get(taskKey(h.task.taskId));
  expect(await cancelTask(h.deps, h.task.taskId)).toEqual({ nothingRunning: true });
  expect(await h.store.get(taskKey(h.task.taskId))).toEqual(before);
  await h.store.delete({ key: h.location.workspaceKey });
  expect(await cancelTask(h.deps, h.task.taskId)).toEqual({ nothingRunning: true });
  expect(await h.store.get(taskKey(h.task.taskId))).toEqual(before);
});
