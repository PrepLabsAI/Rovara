import { IMPLICIT_COMPANY_ID as T1_COMPANY } from "@agentx/contracts";
// Lane L6a, round 1 of review: the races and refusals the reviewers named, each as a test that fails if the behaviour breaks.
import { describe, expect, it } from "vitest";
import { projectMetaKey, queryAll, type Admission, type AdmissionRequest, type TransactItem, type WorkerInvocation } from "@agentx/contracts";
import { acceptStep, readWorkspace } from "../../packages/broker/src/core/task-flow/stage-machine.js";
import { operationKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { readTask } from "../../packages/broker/src/core/task-flow/reads.js";
import type { OperationRecord, WorkspaceRecord } from "../../packages/broker/src/core/task-flow/records.js";
import { COMPANY, createHarness, newRequestId, type Harness } from "../support/task-flow-harness.js";

/** An admission that records every key it is asked about and every reservation given back. */
function recordingAdmission(options: { onStage?: (request: AdmissionRequest) => Promise<void> } = {}): Admission & { asked: string[]; released: string[] } {
  const asked: string[] = [];
  const released: string[] = [];
  return {
    asked, released,
    async admit(request) { asked.push(request.idempotencyKey); return { allowed: true, reservationId: `res:${request.idempotencyKey}` }; },
    async stage(request) {
      asked.push(request.idempotencyKey);
      await options.onStage?.(request);
      return { decision: { allowed: true, reservationId: `res:${request.idempotencyKey}` }, items: [] as readonly TransactItem[] };
    },
    async settle() {},
    async release(id) { released.push(id); },
  };
}

async function drain(h: Harness, rounds = 12): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    if ((await h.flow.dispatchOnce({ maxMessages: 10 })).received === 0) return;
    h.clock.advance(70);
  }
}
const workspaceOf = async (h: Harness, id: string) => (await h.store.get(workspaceKey(T1_COMPANY, id))) as unknown as WorkspaceRecord;
const operationsOf = async (h: Harness, workspaceId: string) => (await queryAll(h.store, { pk: workspaceKey(T1_COMPANY, workspaceId).pk, sk: { op: "beginsWith", prefix: "OPERATION#" } })) as unknown as OperationRecord[];

describe("a close that races a dispatch", () => {
  it("sends nothing to the worker, issues no credential, and stops the machine it could not be told about", async () => {
    const admission = recordingAdmission();
    const h = createHarness({ admission, machines: { startingChecks: 0 } });
    await h.registerProject();
    const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "x" });
    // The task is closed after the dispatcher read the workspace and before its machine exists: the close sees no machine to stop.
    const realStart = h.machines.start.bind(h.machines);
    let startedId: string | undefined;
    h.machines.start = async (spec) => {
      await h.flow.close(h.owner, started.task.taskId);
      const handle = await realStart(spec);
      startedId = handle.machineId;
      return handle;
    };
    const report = await h.flow.dispatchOnce();
    expect(report).toMatchObject({ delivered: 0, dropped: 1 });
    expect(h.grants).toEqual([]);
    const workspace = await workspaceOf(h, started.task.workspaceId);
    expect(workspace.status).toBe("CLOSED");
    expect(workspace.machine).toBeUndefined();
    // The machine that was started for the closed workspace is stopped, and its allowance went back.
    expect(startedId).toBeDefined();
    expect((await h.machines.health(startedId!)).state).toBe("terminated");
    expect(h.machines.delivered(startedId!)).toEqual([]);
    expect(admission.released).toContain("res:machine.start:" + workspace.id + ":1");
    expect((await operationsOf(h, workspace.id))[0]!.status).toBe("INTERRUPTED");
    expect((await h.queues.queue("task-dispatch").then((queue) => queue.receive()))).toEqual([]);
  });
});

describe("the workspace limit under a race", () => {
  it("refuses the start whose slot another start took between the read and the commit, and takes no allowance for it", async () => {
    const holder: { h?: Harness } = {};
    let injected = false;
    const admission = recordingAdmission({
      onStage: async () => {
        if (injected) return;
        injected = true;
        await holder.h!.flow.start(holder.h!.owner, { requestId: newRequestId(), project: "payments", instructions: "took the slot" });
      },
    });
    const h = createHarness({ admission, limits: { member: 1, organization: 5 } });
    holder.h = h;
    await h.registerProject();
    await expect(h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "late" })).rejects.toMatchObject({ code: "WORKSPACE_LIMIT" });
    expect((await h.flow.list(h.owner)).tasks).toHaveLength(1);
    // Exactly its own reservation (the first one asked about) went back; the start that took the slot keeps its allowance.
    expect(admission.released).toEqual([`res:${admission.asked[0]!}`]);
  });
});

describe("results", () => {
  async function understandRunning() {
    const h = createHarness({ understandFirst: true, machines: { startingChecks: 0 } });
    await h.registerProject();
    const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "x", workflow: true });
    await drain(h);
    const workspace = await workspaceOf(h, started.task.workspaceId);
    const prepare = h.machines.delivered(workspace.machine!.machineId)[0] as WorkerInvocation;
    await h.flow.recordResult({ workspaceId: workspace.id, operationId: prepare.operationId, fence: 1, status: "SUCCEEDED" });
    await drain(h);
    const understand = h.machines.delivered(workspace.machine!.machineId).at(-1) as WorkerInvocation;
    return { h, started, workspace, understand };
  }

  it("refuses a result for an operation of another company", async () => {
    const { h, workspace, understand } = await understandRunning();
    await h.store.update({ key: operationKey(T1_COMPANY, workspace.id, understand.operationId), ops: [{ op: "set", path: ["companyId"], value: "org_zzzzzzzzzzzzzzzzzzzz" }] });
    await expect(h.flow.recordResult({ workspaceId: workspace.id, operationId: understand.operationId, fence: 2, status: "SUCCEEDED" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("what the system may start on its own", () => {

  it("puts the items the access adapter asks for into the step's own transaction", async () => {
    const h = createHarness({ understandFirst: true, machines: { startingChecks: 0 } });
    await h.registerProject();
    const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "x", workflow: true });
    await drain(h);
    const workspace = await workspaceOf(h, started.task.workspaceId);
    const prepare = h.machines.delivered(workspace.machine!.machineId)[0] as WorkerInvocation;
    // A fence that no longer holds refuses the step and writes nothing.
    h.deps.access = { ...h.deps.access, checkStep: async () => ({ allowed: true, items: [{ kind: "check", key: { pk: "PEOPLE#fence", sk: "REV" }, condition: { op: "exists", path: ["pk"] } }] }) };
    await h.flow.recordResult({ workspaceId: workspace.id, operationId: prepare.operationId, fence: 1, status: "SUCCEEDED" });
    expect((await h.flow.get(h.owner, started.task.taskId)).operations.filter((operation) => operation.kind === "task")).toEqual([]);
    await h.store.put({ item: { pk: "PEOPLE#fence", sk: "REV" } });
    expect(await h.flow.sweepOnce()).toMatchObject({ started: 1 });
  });

  it("takes no ordinary write-capable run on a workflow task's workspace", async () => {
    const h = createHarness({ understandFirst: false, machines: { startingChecks: 0 } });
    await h.registerProject();
    const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "x", workflow: true, workflowPath: "QUICK" });
    const task = (await readTask(h.deps, started.task.taskId))!;
    const workspace = (await readWorkspace(h.deps, task.workspaceId))!;
    await expect(acceptStep(h.deps, { task, workspace: { ...workspace, status: "READY", activeOperationId: null }, requestId: newRequestId(), prompt: "write code" })).rejects.toMatchObject({ code: "TASK_BUSY" });
  });
});

describe("projects and companies", () => {
  it("refuses new work on an archived project", async () => {
    const h = createHarness();
    await h.registerProject();
    await h.store.put({ item: { ...projectMetaKey(COMPANY, "payments"), entityType: "PROJECT_META", status: "archived" } });
    await expect(h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "x" })).rejects.toMatchObject({ code: "PROJECT_ARCHIVED" });
    expect((await h.flow.list(h.owner)).tasks).toEqual([]);
  });

  it("shows nothing to a principal of another company, even one with the owner role", async () => {
    const h = createHarness();
    await h.registerProject();
    const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "x" });
    const stranger = { principal: { ...h.owner.principal, companyId: "org_zzzzzzzzzzzzzzzzzzzz" } };
    await expect(h.flow.get(stranger, started.task.taskId)).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    await expect(h.flow.close(stranger, started.task.taskId)).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    expect(await h.flow.list(stranger)).toEqual({ tasks: [] });
  });
});

describe("closing", () => {

  it("stops the machine and gives back the allowances even when the machine will not terminate", async () => {
    const admission = recordingAdmission();
    const h = createHarness({ admission, machines: { startingChecks: 0 } });
    await h.registerProject();
    const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "x" });
    await drain(h);
    h.machines.terminate = async () => { throw new Error("backend down"); };
    await h.flow.close(h.owner, started.task.taskId);
    expect(admission.released).toContain(`res:task.start:${started.task.taskId}:1`);
  });
});

describe("the dispatch rows", () => {
  it("backs a failing row off, and after eight failures blocks the workflow and drops the row", async () => {
    const h = createHarness({ understandFirst: true, machines: { startingChecks: 0 } });
    await h.registerProject();
    const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "x", workflow: true });
    await drain(h);
    const workspace = await workspaceOf(h, started.task.workspaceId);
    h.deps.prompts = { understand: () => { throw new Error("prompt builder broke"); }, plan: () => "p" };
    // The preparation ends with the row failing: the row stays and is retried by the sweep, each time later.
    const prepare = h.machines.delivered(workspace.machine!.machineId)[0] as WorkerInvocation;
    await expect(h.flow.recordResult({ workspaceId: workspace.id, operationId: prepare.operationId, fence: 1, status: "SUCCEEDED" })).rejects.toThrow(/prompt builder broke/);
    let blocked = 0;
    for (let attempt = 0; attempt < 10 && blocked === 0; attempt += 1) {
      h.clock.advance(20 * 60);
      blocked += (await h.flow.sweepOnce()).blocked;
    }
    expect(blocked).toBe(1);
    // F2-B (arch ruling): the person reads fixed plain words, never the raw cause ("prompt builder broke" stays in the dispatch row and the log).
    const workflow = (await h.flow.get(h.owner, started.task.taskId)).workflow;
    expect(workflow).toMatchObject({ state: "BLOCKED", blockReason: "Rovara could not start the step that reads the request. Press Retry." });
    expect(JSON.stringify(workflow)).not.toContain("prompt builder broke");
  });

  it("gives up on a row whose workspace never becomes free", async () => {
    const h = createHarness({ understandFirst: true });
    await h.registerProject();
    const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "x", workflow: true });
    expect(await h.flow.sweepOnce()).toMatchObject({ waiting: 1 });
    h.clock.advance(2 * 3_600);
    expect(await h.flow.sweepOnce()).toMatchObject({ blocked: 1 });
    expect((await h.flow.get(h.owner, started.task.taskId)).workflow).toMatchObject({ state: "BLOCKED" });
  });
});

describe("the outbox and the stored records", () => {
  it("recovers a dispatch message whose relay failed at the start", async () => {
    const h = createHarness({ machines: { startingChecks: 0 } });
    await h.registerProject();
    const relay = h.deps.outbox.relay.bind(h.deps.outbox);
    h.deps.outbox = { ...h.deps.outbox, stage: h.deps.outbox.stage.bind(h.deps.outbox), relay: async () => { throw new Error("queue down"); } };
    const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "x" });
    expect(await h.flow.dispatchOnce()).toMatchObject({ received: 0 });
    h.deps.outbox = { ...h.deps.outbox, relay };
    expect(await h.flow.relayOnce()).toMatchObject({ delivered: 1 });
    expect(await h.flow.dispatchOnce()).toMatchObject({ delivered: 1 });
    expect(started.task.status).toBe("STARTING");
  });

});

describe("a machine the adapter replaced", () => {
  it("is admitted on its own, as a new machine, and the old one's allowance goes back", async () => {
    const admission = recordingAdmission();
    const h = createHarness({ admission, machines: { startingChecks: 2 } });
    await h.registerProject();
    const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "x" });
    await h.flow.dispatchOnce();
    const first = (await workspaceOf(h, started.task.workspaceId)).machine!.machineId;
    await h.machines.terminate(first);
    h.clock.advance(70);
    await drain(h);
    const workspace = await workspaceOf(h, started.task.workspaceId);
    expect(workspace.machine!.machineId).not.toBe(first);
    expect(workspace.machineGeneration).toBe(2);
    expect(admission.asked.filter((key) => key.startsWith("machine.start:"))).toEqual(expect.arrayContaining([`machine.start:${workspace.id}:1`, `machine.start:${workspace.id}:2`]));
    expect(admission.released).toContain(`res:machine.start:${workspace.id}:1`);
    expect(h.machines.delivered(workspace.machine!.machineId)[0]).toMatchObject({ kind: "prepare" });
  });

  it("is stopped again at once when admission refuses it", async () => {
    let calls = 0;
    const admission: Admission = {
      async admit() {
        calls += 1;
        return calls === 1 ? { allowed: true } : { allowed: false, code: "machine_time_exceeded", message: "No machine time left." };
      },
      async stage() { return { decision: { allowed: true }, items: [] }; },
      async settle() {}, async release() {},
    };
    const h = createHarness({ admission, machines: { startingChecks: 2 } });
    await h.registerProject();
    const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "x" });
    await h.flow.dispatchOnce();
    const first = (await workspaceOf(h, started.task.workspaceId)).machine!.machineId;
    await h.machines.terminate(first);
    h.clock.advance(70);
    await h.flow.dispatchOnce();
    const view = await h.flow.get(h.owner, started.task.taskId);
    expect(view.operations[0]).toMatchObject({ status: "FAILED" });
    expect(view.failure?.message).toContain("No machine time left.");
    expect(h.grants).toEqual([]);
  });
});

describe("redelivery and close, once more", () => {
  it("treats a redelivered message for a job the worker already runs as a repeat, and leaves the job alone", async () => {
    const h = createHarness({ machines: { startingChecks: 0 } });
    await h.registerProject();
    const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "x" });
    await h.flow.dispatchOnce();
    const workspace = await workspaceOf(h, started.task.workspaceId);
    const [prepare] = await operationsOf(h, workspace.id);
    await h.store.update({ key: operationKey(T1_COMPANY, workspace.id, prepare!.id), ops: [{ op: "set", path: ["status"], value: "RUNNING" }] });
    const queue = await h.queues.queue("task-dispatch");
    await queue.enqueue({ body: { v: 1, workspaceId: workspace.id, operationId: prepare!.id } });
    expect(await h.flow.dispatchOnce()).toMatchObject({ dropped: 1, failed: 0 });
    expect((await operationsOf(h, workspace.id))[0]!.status).toBe("RUNNING");
    expect((await workspaceOf(h, workspace.id)).status).toBe("PREPARING");
  });

  it("does not end a job the worker reported running between the dispatcher's read and its claim", async () => {
    const h = createHarness({ machines: { startingChecks: 0 } });
    await h.registerProject();
    const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "x" });
    const realHealth = h.machines.health.bind(h.machines);
    h.machines.health = async (machineId) => {
      const [prepare] = await operationsOf(h, started.task.workspaceId);
      await h.store.update({ key: operationKey(T1_COMPANY, started.task.workspaceId, prepare!.id), ops: [{ op: "set", path: ["status"], value: "RUNNING" }] });
      return realHealth(machineId);
    };
    expect(await h.flow.dispatchOnce()).toMatchObject({ dropped: 1, delivered: 0, failed: 0 });
    expect((await operationsOf(h, started.task.workspaceId))[0]!.status).toBe("RUNNING");
    expect(h.grants).toEqual([]);
  });

  it("does not ack a message whose operation it could not end: the message comes back and the operation is ended then", async () => {
    const h = createHarness({ machines: { startingChecks: 0 } });
    await h.registerProject();
    const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "x" });
    // The workspace moved on (a newer fence), so the job is no longer wanted; but the store refuses every write for a while.
    await h.store.update({ key: workspaceKey(T1_COMPANY, started.task.workspaceId), ops: [{ op: "set", path: ["fence"], value: 9 }] });
    const realTransact = h.store.transact.bind(h.store);
    h.store.transact = async () => ({ applied: false, reason: "condition_failed", failed: [0] });
    expect(await h.flow.dispatchOnce()).toMatchObject({ retried: 1, failed: 0 });
    expect((await operationsOf(h, started.task.workspaceId))[0]!.status).toBe("ACCEPTED");
    h.store.transact = realTransact;
    h.clock.advance(70);
    // With the store back, the next delivery ends it (the fence on the result is the operation's own).
    expect(await h.flow.dispatchOnce()).toMatchObject({ failed: 1 });
    expect((await operationsOf(h, started.task.workspaceId))[0]!.status).toBe("INTERRUPTED");
  });
});
