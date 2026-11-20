import { IMPLICIT_COMPANY_ID as T1_COMPANY } from "@agentx/contracts";
// Lane L6a: the task flow end to end on the W0 fakes: a task is started, staged and dispatched to a fake worker machine, and every record is in the
// document store port. Nothing here names DynamoDB, SQS or EC2.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AGENTX_PROTOCOL_VERSION, type WorkerInvocation } from "@agentx/contracts";
import { CallbackCapabilities } from "../../packages/broker/src/callbacks.js";
import { operationKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { queryAll } from "@agentx/contracts";
import type { OperationRecord, WorkspaceRecord } from "../../packages/broker/src/core/task-flow/records.js";
import { COMPANY, SIGNING_KEY, createHarness, newRequestId, type Harness } from "../support/task-flow-harness.js";

async function operationsOf(h: Harness, workspaceId: string): Promise<OperationRecord[]> {
  const items = await queryAll(h.store, { pk: workspaceKey(T1_COMPANY, workspaceId).pk, sk: { op: "beginsWith", prefix: "OPERATION#" } });
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

});

describe("results and the sweep", () => {
  async function prepared(h: Harness, request: Record<string, unknown> = { workflow: true }) {
    await h.registerProject();
    const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Do the thing", ...request });
    await drain(h);
    const workspace = (await h.store.get(workspaceKey(T1_COMPANY, started.task.workspaceId))) as unknown as WorkspaceRecord;
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
    expect(((await h.store.get(workspaceKey(T1_COMPANY, workspace.id))) as unknown as WorkspaceRecord).status).toBe("PREPARATION_FAILED");
    // The waiting Understand row is dropped as stale by the sweep: nothing is started.
    h.clock.advance(60);
    expect(await h.flow.sweepOnce()).toMatchObject({ stale: 1, started: 0 });
    expect(await operationsOf(h, workspace.id)).toHaveLength(1);
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

});

describe("dispatching to a worker machine", () => {

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
    const workspace = (await h.store.get(workspaceKey(T1_COMPANY, started.task.workspaceId))) as unknown as WorkspaceRecord;
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

it("issues saved-image callback actions only to a preparation that carries an image", async () => {
  const { PREPARE_SAVED_ENV_FEATURE, savedEnvRepositoryName } = await import("@agentx/contracts");
  for (const withImage of [false, true]) {
    const h = createHarness({ machines: { features: ["task.workflowMode", "task.structuredPlans", PREPARE_SAVED_ENV_FEATURE] } });
    await h.registerProject();
    const { task } = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "prepare" });
    const [operation] = await operationsOf(h, task.workspaceId);
    if (withImage) {
      const row = (await h.store.get(operationKey(COMPANY, task.workspaceId, operation!.id)))!;
      const dispatch = row["dispatch"] as { payload: Record<string, never> };
      await h.store.put({ item: { ...row, dispatch: { ...dispatch, payload: { ...dispatch.payload, savedEnv: { repository: savedEnvRepositoryName({ env: "test", orgId: COMPANY, projectId: "payments" }), digest: `sha256:${"a".repeat(64)}`, environmentKey: "b".repeat(64), testEnvRevision: 1, taskTestEnvRevision: 1 } } } } });
    }
    await drain(h);
    const workspace = (await h.store.get(workspaceKey(COMPANY, task.workspaceId))) as unknown as WorkspaceRecord;
    const delivered = lastInvocation(h, workspace.machine!.machineId);
    expect(delivered).toBeDefined();
    const capabilities = new CallbackCapabilities(SIGNING_KEY);
    for (const action of ["saved-env-login", "saved-env-fallback"] as const) {
      if (withImage) expect(capabilities.verify(delivered.callbackCapability, action).operationId).toBe(delivered.operationId);
      else expect(() => capabilities.verify(delivered.callbackCapability, action)).toThrow();
    }
  }
});
