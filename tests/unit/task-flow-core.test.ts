// Lane L6a: the task flow end to end on the W0 fakes: a task is started, staged and dispatched to a fake worker machine, and every record is in the
// document store port. Nothing here names DynamoDB, SQS or EC2.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AGENTX_PROTOCOL_VERSION, WorkerInvocationSchema, type WorkerInvocation } from "@agentx/contracts";
import { CallbackCapabilities } from "../../packages/broker/src/callbacks.js";
import { dispatchPartition, operationKey, taskIndexKey, taskKey, taskPointerKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { queryAll } from "@agentx/contracts";
import type { OperationRecord, TaskRecord, WorkspaceRecord } from "../../packages/broker/src/core/task-flow/records.js";
import { COMPANY, SIGNING_KEY, createHarness, newRequestId, type Harness } from "../support/task-flow-harness.js";

const READY = { kind: "ready", path: "QUICK", restatement: "Add a health endpoint", assumptions: ["It returns 200"] } as const;

async function operationsOf(h: Harness, workspaceId: string): Promise<OperationRecord[]> {
  const items = await queryAll(h.store, { pk: workspaceKey(workspaceId).pk, sk: { op: "beginsWith", prefix: "OPERATION#" } });
  return items.map((item) => item as unknown as OperationRecord).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.fence - b.fence);
}

/** Runs the dispatch consumer until the queue is quiet, moving the clock past each retry delay. */
async function drain(h: Harness, rounds = 12): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    const report = await h.flow.dispatchOnce({ maxMessages: 10 });
    if (report.received === 0) return;
    h.clock.advance(70);
  }
}

function lastInvocation(h: Harness, machineId: string): WorkerInvocation {
  const delivered = h.machines.delivered(machineId);
  return delivered[delivered.length - 1]!;
}

describe("starting a task", () => {
  it("writes the task, its workspace, preparation, pointer and idempotency record in one transaction, and stages the preparation for dispatch", async () => {
    const h = createHarness({ audit: "recording" });
    await h.registerProject();
    const requestId = newRequestId();
    const { task, duplicate } = await h.flow.start(h.owner, { requestId, project: "payments", instructions: "Add a /health endpoint\nreturn 200", workflow: true, workflowPath: "QUICK" });
    expect(duplicate).toBe(false);
    expect(task).toMatchObject({ project: "payments", title: "Add a /health endpoint", status: "STARTING", workflow: { stage: "PLAN", state: "RUNNING", path: "QUICK" } });

    const record = (await h.store.get(taskKey(task.taskId))) as unknown as TaskRecord;
    expect(record).toMatchObject({ entityType: "DEVELOPER_TASK", companyId: COMPANY, developerId: "local-owner", provider: "local-owner", startingRevision: 1 });
    const workspace = (await h.store.get(workspaceKey(task.workspaceId))) as unknown as WorkspaceRecord;
    expect(workspace).toMatchObject({ status: "PREPARING", fence: 1, projectName: "payments", workspaceProject: (expect.stringContaining("payments") as string) });
    const pointer = await h.store.get(taskPointerKey(task.workspaceId));
    expect(pointer).toMatchObject({ pendingPrompt: "Add a /health endpoint\nreturn 200", pendingWorkflowMode: "PLAN" });
    expect(await h.store.get(taskIndexKey("local-owner", record.createdAt, task.taskId))).toMatchObject({ status: "STARTING" });

    const [prepare] = await operationsOf(h, task.workspaceId);
    expect(prepare).toMatchObject({ kind: "prepare", status: "ACCEPTED", fence: 1, id: workspace.activeOperationId });
    // The dispatch message went out with the start; it carries no secret, only the ids the dispatcher reads.
    const queue = await h.queues.queue("task-dispatch");
    const [message] = await queue.receive();
    expect(message?.body).toEqual({ v: 1, workspaceId: task.workspaceId, operationId: prepare!.id });
    expect(h.audit.map((event) => event.action)).toEqual(["task.started"]);
    expect(await h.store.get({ pk: `AUDIT#${COMPANY}`, sk: `EVENT#task.started:${task.taskId}` })).toBeDefined();
  });

  it("answers a repeat of the same request with the first task, and refuses the same id for another request", async () => {
    const h = createHarness();
    await h.registerProject();
    const request = { requestId: newRequestId(), project: "payments", instructions: "one thing" };
    const first = await h.flow.start(h.owner, request);
    const again = await h.flow.start(h.owner, request);
    expect(again.duplicate).toBe(true);
    expect(again.task.taskId).toBe(first.task.taskId);
    await expect(h.flow.start(h.owner, { ...request, instructions: "another thing" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    // One task, one charge.
    expect((await h.store.get({ pk: "DEVELOPER_LIMIT#local-owner", sk: "MEMBER" }))?.count).toBe(1);
  });

  it("starts one task when the same request arrives twice at once", async () => {
    const h = createHarness();
    await h.registerProject();
    const request = { requestId: newRequestId(), project: "payments", instructions: "race" };
    const results = await Promise.all([h.flow.start(h.owner, request), h.flow.start(h.owner, request)]);
    expect(results[0].task.taskId).toBe(results[1].task.taskId);
    expect((await h.store.get({ pk: "DEVELOPER_LIMIT#local-owner", sk: "MEMBER" }))?.count).toBe(1);
    expect((await h.flow.list(h.owner)).tasks).toHaveLength(1);
  });

  it("refuses a project that does not exist, a caller who is not the owner, and agents or sharing this deployment does not have, writing nothing", async () => {
    const h = createHarness({ audit: "recording" });
    await h.registerProject();
    await expect(h.flow.start(h.owner, { requestId: newRequestId(), project: "missing", instructions: "x" })).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    await expect(h.flow.start(h.guest, { requestId: newRequestId(), project: "payments", instructions: "x" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "x", shareToChannel: true })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "x", workflow: true })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect((await h.flow.list(h.owner)).tasks).toEqual([]);
    expect(await h.store.get({ pk: "DEVELOPER_LIMIT#local-owner", sk: "MEMBER" })).toBeUndefined();
    expect(h.audit.map((event) => event.action)).toEqual(["task.start_refused", "task.start_refused", "task.start_refused", "task.start_refused"]);
  });

  it("holds each person to the workspace limit and gives a slot back, once, when a task is closed", async () => {
    const h = createHarness({ limits: { member: 2, organization: 3 } });
    await h.registerProject();
    const a = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "a" });
    await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "b" });
    await expect(h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "c" })).rejects.toMatchObject({ code: "WORKSPACE_LIMIT", message: (expect.stringContaining("2 open workspaces per person") as string) });
    const closed = await h.flow.close(h.owner, a.task.taskId);
    expect(closed.status).toBe("CLOSED");
    expect((await h.flow.close(h.owner, a.task.taskId)).status).toBe("CLOSED");
    expect((await h.store.get({ pk: "DEVELOPER_LIMIT#local-owner", sk: "MEMBER" }))?.count).toBe(1);
    await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "c" });
  });

  it("keeps a person's tasks from another person: a task of someone else is not found", async () => {
    const h = createHarness();
    await h.registerProject();
    const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "mine" });
    await expect(h.flow.get(h.guest, started.task.taskId)).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    await expect(h.flow.close(h.guest, started.task.taskId)).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    expect((await h.flow.get(h.owner, started.task.taskId)).taskId).toBe(started.task.taskId);
  });
});

describe("a task through its stages, dispatched to a worker machine", () => {
  it("a workflow that understands first: prepare, Understand, Plan, and the plan waits for the owner", async () => {
    const h = createHarness({ understandFirst: true });
    await h.registerProject();
    const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Add a /health endpoint", workflow: true });
    expect(started.task.workflow).toMatchObject({ definitionVersion: "1.1.0", stage: "UNDERSTAND", state: "READY", revision: 1 });
    // The first step waits as a dispatch row on the company's partition, found through the due-time index.
    expect((await h.store.queryIndex({ index: "workflow-dispatch-due", partition: dispatchPartition(COMPANY) })).items).toHaveLength(1);

    // The machine is still starting: the message goes back with a delay, then is delivered.
    const first = await h.flow.dispatchOnce();
    expect(first).toMatchObject({ received: 1, retried: 1, delivered: 0 });
    h.clock.advance(70);
    expect(await h.flow.dispatchOnce()).toMatchObject({ received: 1, delivered: 1 });
    const workspace = (await h.store.get(workspaceKey(started.task.workspaceId))) as unknown as WorkspaceRecord;
    const machineId = workspace.machine!.machineId;
    const prepareInvocation = lastInvocation(h, machineId);
    expect(WorkerInvocationSchema.safeParse(prepareInvocation).success).toBe(true);
    expect(prepareInvocation).toMatchObject({ kind: "prepare", fence: 1, workspaceId: workspace.id });
    expect((prepareInvocation as { payload: { repositoryGrant: string } }).payload.repositoryGrant).toEqual(expect.any(String));
    // The capability the worker is given was issued at delivery, is signed with the broker's key, and allows exactly the three callbacks.
    const capabilities = new CallbackCapabilities(SIGNING_KEY);
    expect(capabilities.verify(prepareInvocation.callbackCapability, "result")).toMatchObject({ operationId: prepareInvocation.operationId, fence: 1 });
    expect(() => capabilities.verify(prepareInvocation.callbackCapability, "heartbeat")).toThrow();
    expect(h.grants).toHaveLength(1);

    // The worker reports the preparation done: the workspace is ready and Understand begins.
    h.machines.finish(machineId, prepareInvocation.operationId);
    await h.flow.recordResult({ workspaceId: workspace.id, operationId: prepareInvocation.operationId, fence: 1, status: "SUCCEEDED", outcome: { kind: "prepared" } });
    let view = await h.flow.get(h.owner, started.task.taskId);
    expect(view.workflow).toMatchObject({ stage: "UNDERSTAND", state: "RUNNING", revision: 2 });
    expect((await h.store.queryIndex({ index: "workflow-dispatch-due", partition: dispatchPartition(COMPANY) })).items).toHaveLength(0);

    await drain(h);
    const understand = lastInvocation(h, machineId);
    expect(understand).toMatchObject({ kind: "task", fence: 2, payload: { workflowMode: "UNDERSTAND" } });
    expect((understand as { payload: { prompt: string } }).payload.prompt).toContain("Add a /health endpoint");

    // Understand finds the request clear: planning starts on its own.
    h.machines.finish(machineId, understand.operationId);
    await h.flow.recordResult({ workspaceId: workspace.id, operationId: understand.operationId, fence: 2, status: "SUCCEEDED", outcome: { kind: "understood", assessment: READY } });
    view = await h.flow.get(h.owner, started.task.taskId);
    expect(view.workflow).toMatchObject({ stage: "PLAN", state: "RUNNING" });
    await drain(h);
    const plan = lastInvocation(h, machineId);
    expect(plan).toMatchObject({ kind: "task", fence: 3, payload: { workflowMode: "PLAN" } });
    expect((plan as { payload: { prompt: string } }).payload.prompt).toContain("Add a health endpoint");

    // The plan comes back: it waits for the owner's decision.
    h.machines.finish(machineId, plan.operationId);
    await h.flow.recordResult({
      workspaceId: workspace.id, operationId: plan.operationId, fence: 3, status: "SUCCEEDED",
      outcome: { kind: "planned", artifact: { id: "plan-1", type: "plan", version: 1, sha256: "a".repeat(64), producer: "agentx-worker-untrusted", objectKey: `tasks/${started.task.taskId}/plan-1.md`, createdAt: h.deps.now!().toISOString() } },
    });
    view = await h.flow.get(h.owner, started.task.taskId);
    expect(view.workflow).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
    expect(view.operations.map((operation) => `${operation.kind}:${operation.workflowMode ?? "-"}:${operation.status}`)).toEqual(["prepare:-:SUCCEEDED", "task:UNDERSTAND:SUCCEEDED", "task:PLAN:SUCCEEDED"]);
    // The workspace is free again and the task index reflects the run.
    expect(((await h.store.get(workspaceKey(workspace.id))) as unknown as WorkspaceRecord)).toMatchObject({ status: "READY", activeOperationId: null, fence: 3 });
  });

  it("a workflow with an explicit path plans straight after the preparation, with the first instructions as the prompt", async () => {
    const h = createHarness({ understandFirst: false });
    await h.registerProject();
    const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Rename the flag", workflow: true, workflowPath: "FULL" });
    expect(started.task.workflow).toMatchObject({ definitionVersion: "1.0.0", stage: "PLAN", state: "RUNNING", path: "FULL" });
    await drain(h);
    const workspace = (await h.store.get(workspaceKey(started.task.workspaceId))) as unknown as WorkspaceRecord;
    const machineId = workspace.machine!.machineId;
    const prepare = lastInvocation(h, machineId);
    h.machines.finish(machineId, prepare.operationId);
    await h.flow.recordResult({ workspaceId: workspace.id, operationId: prepare.operationId, fence: 1, status: "SUCCEEDED" });
    await drain(h);
    const plan = lastInvocation(h, machineId);
    expect(plan).toMatchObject({ kind: "task", payload: { prompt: "Rename the flag", workflowMode: "PLAN" } });
    // The first instructions are queued once: the pointer no longer holds them.
    expect(await h.store.get(taskPointerKey(workspace.id))).not.toHaveProperty("pendingPrompt");
  });

  it("a task with no workflow runs its instructions as one plain run", async () => {
    const h = createHarness();
    await h.registerProject();
    const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Just do it" });
    expect(started.task.workflow).toBeUndefined();
    await drain(h);
    const workspace = (await h.store.get(workspaceKey(started.task.workspaceId))) as unknown as WorkspaceRecord;
    const machineId = workspace.machine!.machineId;
    const prepare = lastInvocation(h, machineId);
    h.machines.finish(machineId, prepare.operationId);
    await h.flow.recordResult({ workspaceId: workspace.id, operationId: prepare.operationId, fence: 1, status: "SUCCEEDED" });
    await drain(h);
    const run = lastInvocation(h, machineId);
    expect(run).toMatchObject({ kind: "task", payload: { prompt: "Just do it" } });
    expect((run as { payload: Record<string, unknown> }).payload).not.toHaveProperty("workflowMode");
    h.machines.finish(machineId, run.operationId);
    await h.flow.recordResult({ workspaceId: workspace.id, operationId: run.operationId, fence: 2, status: "SUCCEEDED", outcome: { kind: "ended" } });
    expect((await h.flow.get(h.owner, started.task.taskId)).status).toBe("SUCCEEDED");
  });
});

describe("results and the sweep", () => {
  async function prepared(h: Harness, request: Record<string, unknown> = { workflow: true }) {
    await h.registerProject();
    const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Do the thing", ...request });
    await drain(h);
    const workspace = (await h.store.get(workspaceKey(started.task.workspaceId))) as unknown as WorkspaceRecord;
    return { started, workspace, machineId: workspace.machine!.machineId, prepare: lastInvocation(h, workspace.machine!.machineId) };
  }

  it("refuses a result carrying another fence, and treats a repeated result as a repeat", async () => {
    const h = createHarness({ understandFirst: true });
    const { workspace, prepare } = await prepared(h);
    await expect(h.flow.recordResult({ workspaceId: workspace.id, operationId: prepare.operationId, fence: 9, status: "SUCCEEDED" })).rejects.toMatchObject({ code: "STALE_FENCE" });
    expect(await h.flow.recordResult({ workspaceId: workspace.id, operationId: prepare.operationId, fence: 1, status: "SUCCEEDED" })).toEqual({ duplicate: false });
    expect(await h.flow.recordResult({ workspaceId: workspace.id, operationId: prepare.operationId, fence: 1, status: "SUCCEEDED" })).toEqual({ duplicate: true });
    // The repeat did not start Understand a second time.
    const operations = await operationsOf(h, workspace.id);
    expect(operations.filter((operation) => operation.workflowMode === "UNDERSTAND")).toHaveLength(1);
  });

  it("marks a failed preparation, and starts nothing on a workspace that failed to prepare", async () => {
    const h = createHarness({ understandFirst: true });
    const { started, workspace, prepare } = await prepared(h);
    await h.flow.recordResult({ workspaceId: workspace.id, operationId: prepare.operationId, fence: 1, status: "FAILED", error: "clone failed" });
    const view = await h.flow.get(h.owner, started.task.taskId);
    expect(view.status).toBe("FAILED");
    expect(((await h.store.get(workspaceKey(workspace.id))) as unknown as WorkspaceRecord).status).toBe("PREPARATION_FAILED");
    // The waiting Understand row is dropped as stale by the sweep: nothing is started.
    h.clock.advance(60);
    expect(await h.flow.sweepOnce()).toMatchObject({ stale: 1, started: 0 });
    expect(await operationsOf(h, workspace.id)).toHaveLength(1);
  });

  it("blocks the workflow when Understand fails, and ignores a result the workflow has moved past", async () => {
    const h = createHarness({ understandFirst: true });
    const { started, workspace, machineId, prepare } = await prepared(h);
    h.machines.finish(machineId, prepare.operationId);
    await h.flow.recordResult({ workspaceId: workspace.id, operationId: prepare.operationId, fence: 1, status: "SUCCEEDED" });
    await drain(h);
    const understand = lastInvocation(h, machineId);
    await h.flow.recordResult({ workspaceId: workspace.id, operationId: understand.operationId, fence: 2, status: "FAILED", error: "model unavailable" });
    const view = await h.flow.get(h.owner, started.task.taskId);
    expect(view.workflow).toMatchObject({ stage: "UNDERSTAND", state: "BLOCKED", blockReason: (expect.stringContaining("model unavailable") as string) });
  });

  it("blocks the workflow with a sentence when Understand's answer cannot be read", async () => {
    const h = createHarness({ understandFirst: true });
    const { started, workspace, machineId, prepare } = await prepared(h);
    await h.flow.recordResult({ workspaceId: workspace.id, operationId: prepare.operationId, fence: 1, status: "SUCCEEDED" });
    await drain(h);
    const understand = lastInvocation(h, machineId);
    await h.flow.recordResult({ workspaceId: workspace.id, operationId: understand.operationId, fence: 2, status: "SUCCEEDED", outcome: { kind: "understood", assessment: { kind: "nonsense" } } });
    expect((await h.flow.get(h.owner, started.task.taskId)).workflow).toMatchObject({ state: "BLOCKED", blockReason: (expect.stringContaining("could not read") as string) });
  });

  it("the sweep starts a step whose dispatch row was left behind, once", async () => {
    const h = createHarness({ understandFirst: true });
    const { workspace, prepare } = await prepared(h);
    // The worker's result commits but the process dies before the next move: only the dispatch row remains.
    const ended = await operationsOf(h, workspace.id);
    expect(ended).toHaveLength(1);
    await h.store.update({ key: operationKey(workspace.id, prepare.operationId), ops: [{ op: "set", path: ["status"], value: "SUCCEEDED" }] });
    await h.store.update({ key: workspaceKey(workspace.id), ops: [{ op: "set", path: ["status"], value: "READY" }, { op: "set", path: ["activeOperationId"], value: null }] });
    expect(await h.flow.sweepOnce()).toMatchObject({ started: 1 });
    expect(await h.flow.sweepOnce()).toMatchObject({ started: 0 });
    expect((await operationsOf(h, workspace.id)).filter((operation) => operation.workflowMode === "UNDERSTAND")).toHaveLength(1);
  });
});

describe("dispatching to a worker machine", () => {
  it("does not send a read-only step to a worker that cannot keep it read-only", async () => {
    const h = createHarness({ understandFirst: true, machines: { features: [] } });
    await h.registerProject();
    const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "x", workflow: true });
    await drain(h);
    const workspace = (await h.store.get(workspaceKey(started.task.workspaceId))) as unknown as WorkspaceRecord;
    const machineId = workspace.machine!.machineId;
    const prepare = lastInvocation(h, machineId);
    await h.flow.recordResult({ workspaceId: workspace.id, operationId: prepare.operationId, fence: 1, status: "SUCCEEDED" });
    await drain(h);
    // Understand was accepted but never delivered: the operation ends as failed and the workflow blocks.
    expect(h.machines.delivered(machineId).map((invocation) => invocation.kind)).toEqual(["prepare"]);
    const view = await h.flow.get(h.owner, started.task.taskId);
    expect(view.operations.find((operation) => operation.workflowMode === "UNDERSTAND")?.status).toBe("FAILED");
    expect(view.workflow).toMatchObject({ state: "BLOCKED" });
  });

  it("gives up on a machine that never becomes ready, and an admission refusal ends the operation with its sentence", async () => {
    const slow = createHarness({ machines: { startingChecks: 1_000 } });
    await slow.registerProject();
    const started = await slow.flow.start(slow.owner, { requestId: newRequestId(), project: "payments", instructions: "x" });
    await drain(slow, 30);
    expect((await slow.flow.get(slow.owner, started.task.taskId)).operations[0]).toMatchObject({ kind: "prepare", status: "FAILED" });

    const refusing = createHarness({
      admission: {
        async admit() { return { allowed: false, code: "machine_time_exceeded", message: "This month's machine time is used up." }; },
        async stage() { return { decision: { allowed: true }, items: [] }; },
        async settle() {}, async release() {},
      },
    });
    await refusing.registerProject();
    const refused = await refusing.flow.start(refusing.owner, { requestId: newRequestId(), project: "payments", instructions: "x" });
    await drain(refusing);
    const view = await refusing.flow.get(refusing.owner, refused.task.taskId);
    expect(view).toMatchObject({ status: "FAILED", failure: { message: expect.stringMatching(/^This month's machine time/) as string } });
    expect(refusing.machines.delivered("none")).toEqual([]);
  });

  it("delivers an invocation twice as one job (the fake worker and the queue are at-least-once)", async () => {
    const h = createHarness();
    await h.registerProject();
    const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "x" });
    await drain(h);
    const workspace = (await h.store.get(workspaceKey(started.task.workspaceId))) as unknown as WorkspaceRecord;
    const [prepare] = await operationsOf(h, workspace.id);
    // A second message for the same operation (a relay that handed it over twice): the machine already has the job.
    const queue = await h.queues.queue("task-dispatch");
    await queue.enqueue({ body: { v: 1, workspaceId: workspace.id, operationId: prepare!.id } });
    await h.flow.dispatchOnce();
    expect(h.machines.delivered(workspace.machine!.machineId)).toHaveLength(1);
  });

  it("sets aside a message that is not a dispatch message, and one whose operation does not exist", async () => {
    const h = createHarness();
    const queue = await h.queues.queue("task-dispatch");
    await queue.enqueue({ body: { hello: "world" } });
    await queue.enqueue({ body: { v: 1, workspaceId: randomUUID(), operationId: randomUUID() } });
    expect(await h.flow.dispatchOnce({ maxMessages: 10 })).toMatchObject({ received: 2, dropped: 2 });
    expect((await queue.listDeadLetters()).items.map((letter) => letter.reason).sort()).toEqual(["malformed", "operation_missing"]);
  });
});

describe("admission and audit are in the start's own transaction", () => {
  it("commits what admission stages with the task, keeps the reservation on the task, and takes no allowance for a start refused at the limit", async () => {
    const released: string[] = [];
    let staged = 0;
    const h = createHarness({
      admission: {
        async admit() { return { allowed: true }; },
        async stage(request) {
          staged += 1;
          return { decision: { allowed: true, reservationId: `r${staged}` }, items: [{ kind: "put", item: { pk: "BUDGET#hold", sk: `HOLD#${request.idempotencyKey}`, entityType: "HOLD" }, condition: { op: "notExists", path: ["pk"] } }] };
        },
        async settle() {}, async release(id) { released.push(id); },
      },
    });
    await h.registerProject();
    const request = { requestId: newRequestId(), project: "payments", instructions: "x" };
    const started = await h.flow.start(h.owner, request);
    expect(await h.store.get({ pk: "BUDGET#hold", sk: `HOLD#task.start:${started.task.taskId}:1` })).toBeDefined();
    expect(await h.store.get(taskKey(started.task.taskId))).toMatchObject({ admissionReservationId: "r1" });
    expect(released).toEqual([]);
    // A task refused at the workspace limit never reaches a transaction, so no allowance is taken for it.
    const h2 = createHarness({ limits: { member: 1, organization: 5 }, admission: h.deps.admission });
    await h2.registerProject();
    await h2.flow.start(h2.owner, { requestId: newRequestId(), project: "payments", instructions: "a" });
    const before = staged;
    await expect(h2.flow.start(h2.owner, { requestId: newRequestId(), project: "payments", instructions: "b" })).rejects.toMatchObject({ code: "WORKSPACE_LIMIT" });
    expect(staged).toBe(before);
    expect(started.duplicate).toBe(false);
  });

  it("maps a refused admission to its error and records the refusal without writing the task", async () => {
    const h = createHarness({
      audit: "recording",
      admission: {
        async admit() { return { allowed: true }; },
        async stage() { return { decision: { allowed: false, code: "budget_exhausted", message: "The monthly budget is used." }, items: [] }; },
        async settle() {}, async release() {},
      },
    });
    await h.registerProject();
    await expect(h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "x" })).rejects.toMatchObject({ code: "BUDGET_EXCEEDED", message: (expect.stringContaining("The monthly budget is used.") as string) });
    expect((await h.flow.list(h.owner)).tasks).toEqual([]);
    expect(h.audit.map((event) => event.action)).toEqual(["task.start_refused"]);
  });
});

describe("the task routes", () => {
  it("start, read, list and close a task through the route function, and describe an error without leaking anything else", async () => {
    const { handleTaskRoute } = await import("../../packages/broker/src/core/task-flow/routes.js");
    const h = createHarness();
    await h.registerProject();
    const body = JSON.stringify({ requestId: newRequestId(), project: "payments", instructions: "via the route" });
    const created = await handleTaskRoute(h.flow, { method: "POST", path: "/v1/dev/tasks", body, caller: h.owner });
    expect(created?.status).toBe(201);
    const taskId = (created?.body as { task: { taskId: string } }).task.taskId;
    expect((await handleTaskRoute(h.flow, { method: "POST", path: "/v1/dev/tasks", body, caller: h.owner }))?.status).toBe(200);
    expect((await handleTaskRoute(h.flow, { method: "GET", path: `/v1/dev/tasks/${taskId}`, caller: h.owner }))?.status).toBe(200);
    expect(await handleTaskRoute(h.flow, { method: "GET", path: `/v1/dev/tasks/${taskId}`, caller: h.guest })).toEqual({ status: 404, body: { error: { code: "TASK_NOT_FOUND", message: "no such task" } } });
    expect(((await handleTaskRoute(h.flow, { method: "GET", path: "/v1/dev/tasks", caller: h.owner }))?.body as { tasks: unknown[] }).tasks).toHaveLength(1);
    expect(((await handleTaskRoute(h.flow, { method: "POST", path: `/v1/dev/tasks/${taskId}/close`, caller: h.owner }))?.body as { task: { status: string } }).task.status).toBe("CLOSED");
    expect((await handleTaskRoute(h.flow, { method: "POST", path: "/v1/dev/tasks", body: "{not json", caller: h.owner }))?.status).toBe(400);
    expect(await handleTaskRoute(h.flow, { method: "GET", path: "/v1/other", caller: h.owner })).toBeUndefined();
    expect((await handleTaskRoute(h.flow, { method: "DELETE", path: "/v1/dev/tasks", caller: h.owner }))?.status).toBe(404);
  });
});

describe("the flow built from the plug-in registry", () => {
  it("takes the store, queue, machines and policy seams the registry holds, and refuses a project on a code host nobody registered", async () => {
    const { createAdapterRegistry } = await import("../../packages/broker/src/ports/adapter-registry.js");
    const { registerCodeDefaults } = await import("../../packages/broker/src/ports/policy-defaults.js");
    const { createTaskFlowFromRegistry, TASK_FLOW_INDEXES } = await import("../../packages/broker/src/core/task-flow/flow.js");
    const { MemoryDocumentStore } = await import("../../packages/broker/src/ports/memory-document-store.js");
    const { MemoryQueueService } = await import("../../packages/broker/src/ports/memory-queue.js");
    const { FakeWorkerMachines } = await import("../../packages/broker/src/ports/fake-worker-machines.js");
    const { FakeCodeHost } = await import("../../packages/broker/src/plugins/fake/code-host.js");
    const { FakeHostModel } = await import("../../packages/broker/src/plugins/fake/model.js");
    const { createStoreProjectSource } = await import("../../packages/broker/src/core/task-flow/project-source.js");
    const { RepositoryGrantService } = await import("../../packages/broker/src/repository-access.js");
    const h = createHarness();
    await h.registerProject();
    const registry = createAdapterRegistry();
    registerCodeDefaults(registry, { companyId: COMPANY, priceTable: { currency: "USD", models: {} } });
    const store = new MemoryDocumentStore({ indexes: TASK_FLOW_INDEXES });
    registry.register("storage", "memory", store);
    registry.register("queue", "memory", new MemoryQueueService());
    registry.register("worker-machines", "fake", new FakeWorkerMachines({ startingChecks: 0 }));
    await store.put({ item: (await h.store.get({ pk: `ORG#${COMPANY}#PROJECT#payments`, sk: "REV#000000000001" }))! });
    const grants = new RepositoryGrantService(Buffer.alloc(32, 5), async () => ({}));
    const flow = createTaskFlowFromRegistry(registry, { projects: createStoreProjectSource(store, COMPANY), repositoryGrants: grants, callbackSigningKey: SIGNING_KEY });
    const request = { requestId: newRequestId(), project: "payments", instructions: "x" };
    // No code host is registered: the project's repository has none to be reached through.
    await expect(flow.start(h.owner, request)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    const host = Object.assign(Object.create(new FakeCodeHost(new FakeHostModel({ url: "https://examplehost/example/demo.git", id: "1", fullName: "example/demo" }))) as object, { kind: "github" });
    registry.register("code-host", "github", host as never);
    const started = await flow.start(h.owner, request);
    expect(started.task.status).toBe("STARTING");
    expect(await flow.dispatchOnce()).toMatchObject({ delivered: 1 });
  });
});

describe("the flow refuses to be built wrongly", () => {
  it("needs the indexes it reads, and a signing key of 32 bytes", async () => {
    const { MemoryDocumentStore } = await import("../../packages/broker/src/ports/memory-document-store.js");
    const { createTaskFlow } = await import("../../packages/broker/src/core/task-flow/flow.js");
    const h = createHarness();
    expect(() => createTaskFlow({ ...h.deps, store: new MemoryDocumentStore() })).toThrow(/index/);
    expect(() => createTaskFlow({ ...h.deps, callbackSigningKey: "short" })).toThrow(/32 bytes/);
  });

  it("never invents a protocol: the invocation schema is the worker's own", () => {
    expect(AGENTX_PROTOCOL_VERSION).toBe(1);
  });
});
