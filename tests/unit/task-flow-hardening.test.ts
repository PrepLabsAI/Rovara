// Lane L6a, round 1 of review: the races and refusals the reviewers named, each as a test that fails if the behaviour breaks.
import { describe, expect, it } from "vitest";
import { companyScoped, projectMetaKey, queryAll, type Admission, type AdmissionRequest, type TransactItem, type WorkerInvocation } from "@rovara-code/contracts";
import { acceptStep, readWorkspace } from "../../packages/core/src/core/task-flow/stage-machine.js";
import { chargeMarkerKey, developerCharge, operationKey, workspaceKey } from "../../packages/core/src/core/task-flow/keys.js";
import { readTask } from "../../packages/core/src/core/task-flow/reads.js";
import type { OperationRecord, WorkspaceRecord } from "../../packages/core/src/core/task-flow/records.js";
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
const workspaceOf = async (h: Harness, id: string) => (await h.store.get(workspaceKey(id))) as unknown as WorkspaceRecord;
const operationsOf = async (h: Harness, workspaceId: string) => (await queryAll(h.store, { pk: workspaceKey(workspaceId).pk, sk: { op: "beginsWith", prefix: "OPERATION#" } })) as unknown as OperationRecord[];

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

describe("two starts of one request at once", () => {
  it("each holds its own allowance, and only the one that did not commit gives its own back", async () => {
    const admission = recordingAdmission();
    const h = createHarness({ admission });
    await h.registerProject();
    const request = { requestId: newRequestId(), project: "payments", instructions: "race" };
    const [a, b] = await Promise.all([h.flow.start(h.owner, request), h.flow.start(h.owner, request)]);
    expect(a.task.taskId).toBe(b.task.taskId);
    const winner = `res:task.start:${a.task.taskId}:1`;
    expect(admission.released).not.toContain(winner);
    expect(admission.released).toHaveLength(1);
    expect((await readTask(h.deps, a.task.taskId))!.admissionReservationId).toBe(winner);
  });

  it("gives the task's allowance back when the task is closed, and the machine's with it", async () => {
    const admission = recordingAdmission();
    const h = createHarness({ admission, machines: { startingChecks: 0 } });
    await h.registerProject();
    const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "x" });
    await drain(h);
    await h.flow.close(h.owner, started.task.taskId);
    expect(admission.released).toEqual(expect.arrayContaining([`res:task.start:${started.task.taskId}:1`, `res:machine.start:${started.task.workspaceId}:1`]));
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

describe("the charge marker", () => {
  it("names the member counter it holds a slot on, so a host whose member counters share a partition can tell its members' markers apart", async () => {
    const h = createHarness();
    await h.registerProject();
    const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "one" });
    const charge = developerCharge({ companyId: COMPANY, developerId: "local-owner" });
    expect(await h.store.get(chargeMarkerKey(charge, started.task.taskId))).toMatchObject({ entityType: "DEVELOPER_LIMIT_TASK", taskId: started.task.taskId, memberSk: charge.member.sk });
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

  it("reads a worker that reports itself cancelled without being asked as a failure, which blocks the workflow", async () => {
    const { h, started, workspace, understand } = await understandRunning();
    await h.flow.recordResult({ workspaceId: workspace.id, operationId: understand.operationId, fence: 2, status: "CANCELLED" });
    const view = await h.flow.get(h.owner, started.task.taskId);
    expect(view.operations.at(-1)?.status).toBe("FAILED");
    expect(view.workflow).toMatchObject({ state: "BLOCKED" });
  });

  it("answers a repeat from what was recorded: a late success cannot undo a recorded failure", async () => {
    const { h, started, workspace, understand } = await understandRunning();
    await h.flow.recordResult({ workspaceId: workspace.id, operationId: understand.operationId, fence: 2, status: "FAILED", error: "boom" });
    const repeat = await h.flow.recordResult({
      workspaceId: workspace.id, operationId: understand.operationId, fence: 2, status: "SUCCEEDED",
      outcome: { kind: "understood", assessment: { kind: "ready", path: "QUICK", restatement: "x", assumptions: [] } },
    });
    expect(repeat.duplicate).toBe(true);
    const view = await h.flow.get(h.owner, started.task.taskId);
    expect(view.workflow).toMatchObject({ stage: "UNDERSTAND", state: "BLOCKED" });
    expect(view.operations.filter((operation) => operation.workflowMode === "PLAN")).toEqual([]);
  });

  it("refuses a result for an operation of another company", async () => {
    const { h, workspace, understand } = await understandRunning();
    await h.store.update({ key: operationKey(workspace.id, understand.operationId), ops: [{ op: "set", path: ["companyId"], value: "org_zzzzzzzzzzzzzzzzzzzz" }] });
    await expect(h.flow.recordResult({ workspaceId: workspace.id, operationId: understand.operationId, fence: 2, status: "SUCCEEDED" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("what the system may start on its own", () => {
  it("asks again before every step it starts, and blocks the workflow when the person is no longer allowed", async () => {
    const h = createHarness({ understandFirst: true, machines: { startingChecks: 0 } });
    await h.registerProject();
    const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "x", workflow: true });
    await drain(h);
    const workspace = await workspaceOf(h, started.task.workspaceId);
    const prepare = h.machines.delivered(workspace.machine!.machineId)[0] as WorkerInvocation;
    h.deps.access = { ...h.deps.access, checkStep: async () => ({ allowed: false, message: "this person can no longer run tasks here" }) };
    await h.flow.recordResult({ workspaceId: workspace.id, operationId: prepare.operationId, fence: 1, status: "SUCCEEDED" });
    const view = await h.flow.get(h.owner, started.task.taskId);
    expect(view.workflow).toMatchObject({ stage: "UNDERSTAND", state: "BLOCKED", blockReason: "this person can no longer run tasks here" });
    expect(view.operations.filter((operation) => operation.kind === "task")).toEqual([]);
  });

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
  it("closes a task that holds no slot marker (a task from an older form) without freeing a slot twice", async () => {
    const h = createHarness({ limits: { member: 2, organization: 5 } });
    await h.registerProject();
    const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "x" });
    const task = (await readTask(h.deps, started.task.taskId))!;
    await h.store.delete({ key: chargeMarkerKey(developerCharge({ companyId: COMPANY, developerId: "local-owner" }), task.taskId) });
    expect((await h.flow.close(h.owner, started.task.taskId)).status).toBe("CLOSED");
    // Closed, and the counter was not driven below what other tasks hold.
    expect((await h.store.get({ pk: "DEVELOPER_LIMIT#local-owner", sk: "MEMBER" }))?.count).toBe(1);
  });

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
    expect((await h.flow.get(h.owner, started.task.taskId)).workflow).toMatchObject({ state: "BLOCKED", blockReason: expect.stringContaining("prompt builder broke") as string });
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

  it("keeps no credential in any record the flow wrote", async () => {
    const h = createHarness({ machines: { startingChecks: 0 } });
    await h.registerProject();
    const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "x" });
    await drain(h);
    const workspace = await workspaceOf(h, started.task.workspaceId);
    const invocation = h.machines.delivered(workspace.machine!.machineId)[0] as WorkerInvocation & { payload: { repositoryGrant: string } };
    const secrets = [invocation.callbackCapability, invocation.payload.repositoryGrant];
    const documents = [
      ...(await operationsOf(h, workspace.id)), workspace, await readTask(h.deps, started.task.taskId),
      await h.store.get({ pk: companyScoped(COMPANY, `OUTBOX#${invocation.operationId}`), sk: "OUTBOX" }),
      await h.store.get({ pk: `WORKSPACE#${workspace.id}`, sk: "DEVELOPER_TASK" }),
    ];
    for (const document of documents) for (const secret of secrets) expect(JSON.stringify(document)).not.toContain(secret);
    expect(documents.filter((document) => document !== undefined)).toHaveLength(documents.length);
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
    await h.store.update({ key: operationKey(workspace.id, prepare!.id), ops: [{ op: "set", path: ["status"], value: "RUNNING" }] });
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
      await h.store.update({ key: operationKey(started.task.workspaceId, prepare!.id), ops: [{ op: "set", path: ["status"], value: "RUNNING" }] });
      return realHealth(machineId);
    };
    expect(await h.flow.dispatchOnce()).toMatchObject({ dropped: 1, delivered: 0, failed: 0 });
    expect((await operationsOf(h, started.task.workspaceId))[0]!.status).toBe("RUNNING");
    expect(h.grants).toEqual([]);
  });

  it("stops a machine that a dispatch recorded between the close's two reads", async () => {
    const h = createHarness({ machines: { startingChecks: 0 } });
    await h.registerProject();
    const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "x" });
    const realGet = h.store.get.bind(h.store);
    let armed = true;
    h.store.get = async (key) => {
      // The close has read the workspace (no machine yet) and now reads the operation: the dispatch runs in between, whole.
      if (armed && key.sk.startsWith("OPERATION#")) {
        armed = false;
        await h.flow.dispatchOnce();
      }
      return realGet(key);
    };
    await h.flow.close(h.owner, started.task.taskId);
    h.store.get = realGet;
    const workspace = await workspaceOf(h, started.task.workspaceId);
    expect(workspace.status).toBe("CLOSED");
    expect(workspace.machine).toBeDefined();
    expect((await h.machines.health(workspace.machine!.machineId)).state).toBe("terminated");
  });

  it("does not ack a message whose operation it could not end: the message comes back and the operation is ended then", async () => {
    const h = createHarness({ machines: { startingChecks: 0 } });
    await h.registerProject();
    const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "x" });
    // The workspace moved on (a newer fence), so the job is no longer wanted; but the store refuses every write for a while.
    await h.store.update({ key: workspaceKey(started.task.workspaceId), ops: [{ op: "set", path: ["fence"], value: 9 }] });
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
