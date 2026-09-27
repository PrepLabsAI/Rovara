import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Ec2RuntimeBinding } from "../../packages/contracts/src/session.js";
import { SessionManager, sessionFromItem } from "../../packages/broker/src/aws/sessions.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const PROVISIONER = "arn:aws:states:us-east-1:111122223333:stateMachine:provisioner";
const DELETER = "arn:aws:states:us-east-1:111122223333:stateMachine:deleter";
const binding: Ec2RuntimeBinding = {
  deploymentMode: "ec2-ebs",
  launchTemplateId: "lt-0123456789abcdef0",
  subnets: [
    { availabilityZone: "us-east-1a", subnetId: "subnet-0aaaaaaaaaaaaaaaa" },
    { availabilityZone: "us-east-1b", subnetId: "subnet-0bbbbbbbbbbbbbbbb" },
  ],
  volumeSizeGiB: 20,
  volumeType: "gp3",
};

type StartExecution = (input: { stateMachineArn: string; name: string; input: string }) => Promise<string>;
const startedExecution: StartExecution = async ({ stateMachineArn, name }) => `${stateMachineArn.replace(":stateMachine:", ":execution:")}:${name}`;

function setup(options: { startExecution?: StartExecution } = {}) {
  const db = new FakeDynamoDb();
  const startExecution = vi.fn<StartExecution>(options.startExecution ?? startedExecution);
  const sessions = new SessionManager({
    documentClient: db,
    tableName: "state",
    executions: { provisionerArn: PROVISIONER, deleterArn: DELETER, start: startExecution },
    now: () => new Date("2026-09-27T12:00:00.000Z"),
    chooseSubnet: (subnets) => subnets[0]!,
  });
  const workspaceId = randomUUID();
  const session = () => db.get(`WORKSPACE#${workspaceId}`, "SESSION");
  return { db, sessions, startExecution, workspaceId, session };
}

/** A prepare operation the dispatcher has taken, with its outbox record. */
function seedOperation(db: FakeDynamoDb, workspaceId: string, status = "QUEUED") {
  const operationId = randomUUID();
  const outboxId = randomUUID();
  db.set({ pk: `WORKSPACE#${workspaceId}`, sk: "META", entityType: "WORKSPACE", status: "PREPARING", activeOperationId: operationId, fence: 1 });
  db.set({ pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${operationId}`, status: "DISPATCHING", fence: 1 });
  db.set({
    pk: `OUTBOX#${outboxId}`, sk: "OUTBOX", id: outboxId, entityType: "OUTBOX", status, operationId, workspaceId, deploymentMode: "ec2-ebs",
    invocation: { protocolVersion: 1, kind: "prepare", operationId, workspaceId, fence: 1, projectRevision: 1, callbackCapability: "c".repeat(64), payload: {} },
  });
  return { operationId, outboxId };
}

async function provisionToReady(sessions: SessionManager, workspaceId: string) {
  await sessions.ensureSession({ workspaceId, binding });
  await sessions.markVolume(workspaceId, 1, "vol-0123456789abcdef0");
  await sessions.markInstance(workspaceId, 1, "i-0123456789abcdef0", "10.42.128.10");
  return sessions.markReady(workspaceId, 1);
}

describe("session manager: first provisioning", () => {
  it("starts generation 1 in the chosen zone, parks the dispatched record and indexes the state", async () => {
    const { db, sessions, startExecution, workspaceId, session } = setup();
    const { outboxId } = seedOperation(db, workspaceId);
    const result = await sessions.ensureSession({ workspaceId, binding, waitingOutboxId: outboxId });
    expect(result).toEqual({ ready: false, generation: 1, state: "PROVISIONING" });
    expect(startExecution).toHaveBeenCalledOnce();
    const [call] = startExecution.mock.calls[0]!;
    expect(call.stateMachineArn).toBe(PROVISIONER);
    expect(call.name).toBe(`ws-${workspaceId}-gen-1`);
    expect(JSON.parse(call.input)).toEqual({
      workspaceId, generation: 1, availabilityZone: "us-east-1a", subnetId: "subnet-0aaaaaaaaaaaaaaaa",
      launchTemplateId: binding.launchTemplateId, volumeId: null, volumeSizeGiB: 20, volumeType: "gp3",
    });
    expect(session()).toMatchObject({ state: "PROVISIONING", sessionState: "PROVISIONING", generation: 1 });
    expect(session()!.executionArn).toBe(`arn:aws:states:us-east-1:111122223333:execution:provisioner:ws-${workspaceId}-gen-1`);
    expect(sessionFromItem(session()!).waitingOutboxIds).toEqual([outboxId]);
    expect(db.get(`OUTBOX#${outboxId}`, "OUTBOX")).toMatchObject({ status: "WAITING_FOR_SESSION" });
  });

  it("parks later work on the running provisioning without starting another", async () => {
    const { db, sessions, startExecution, workspaceId } = setup();
    const first = seedOperation(db, workspaceId);
    await sessions.ensureSession({ workspaceId, binding, waitingOutboxId: first.outboxId });
    const second = seedOperation(db, workspaceId, "PENDING");
    expect(await sessions.ensureSession({ workspaceId, binding, waitingOutboxId: second.outboxId })).toMatchObject({ ready: false, state: "PROVISIONING" });
    expect(startExecution).toHaveBeenCalledOnce();
    expect((await sessions.get(workspaceId))!.waitingOutboxIds).toEqual([first.outboxId, second.outboxId].sort());
  });

  it("starts the provisioning again when the first start failed before it was recorded", async () => {
    const { sessions, startExecution, workspaceId, session } = setup();
    startExecution.mockRejectedValueOnce(new Error("throttled"));
    await expect(sessions.ensureSession({ workspaceId, binding })).rejects.toThrow("throttled");
    expect(session()).toMatchObject({ state: "PROVISIONING", generation: 1 });
    expect(session()).not.toHaveProperty("executionArn");
    await sessions.ensureSession({ workspaceId, binding });
    expect(startExecution).toHaveBeenCalledTimes(2);
    expect(startExecution.mock.calls[1]![0].name).toBe(`ws-${workspaceId}-gen-1`);
    expect(session()).toHaveProperty("executionArn");
  });

  it("treats an execution that already exists under the generation's name as started", async () => {
    const { sessions, workspaceId, session } = setup({
      startExecution: async () => { const error = new Error("exists"); error.name = "ExecutionAlreadyExists"; throw error; },
    });
    await sessions.ensureSession({ workspaceId, binding });
    expect(session()!.executionArn).toBe(`arn:aws:states:us-east-1:111122223333:execution:provisioner:ws-${workspaceId}-gen-1`);
  });

  it("does not park a record that was already delivered", async () => {
    const { db, sessions, workspaceId } = setup();
    const { outboxId } = seedOperation(db, workspaceId, "DELIVERED");
    await sessions.ensureSession({ workspaceId, binding, waitingOutboxId: outboxId });
    expect((await sessions.get(workspaceId))!.waitingOutboxIds).toBeUndefined();
    expect(db.get(`OUTBOX#${outboxId}`, "OUTBOX")).toMatchObject({ status: "DELIVERED" });
  });
});

describe("session manager: ready", () => {
  it("becomes READY with its worker's address and sends parked work back to PENDING", async () => {
    const { db, sessions, workspaceId, session } = setup();
    const { outboxId } = seedOperation(db, workspaceId);
    await sessions.ensureSession({ workspaceId, binding, waitingOutboxId: outboxId });
    await sessions.markVolume(workspaceId, 1, "vol-0123456789abcdef0");
    await sessions.markInstance(workspaceId, 1, "i-0123456789abcdef0", "10.42.128.10");
    expect(await sessions.markReady(workspaceId, 1)).toEqual({ requeued: [outboxId] });
    expect(session()).toMatchObject({ state: "READY", sessionState: "READY", privateIp: "10.42.128.10", readyAt: "2026-09-27T12:00:00.000Z" });
    expect(session()).not.toHaveProperty("waitingOutboxIds");
    expect(db.get(`OUTBOX#${outboxId}`, "OUTBOX")).toMatchObject({ status: "PENDING" });
    // Called again by a retried state: no error, nothing more to send.
    expect(await sessions.markReady(workspaceId, 1)).toEqual({ requeued: [] });
  });

  it("returns the worker's address and generation, and touches the session's activity", async () => {
    const { sessions, workspaceId, session } = setup();
    await provisionToReady(sessions, workspaceId);
    expect(await sessions.ensureSession({ workspaceId, binding })).toEqual({ ready: true, generation: 1, privateIp: "10.42.128.10" });
    expect(session()!.lastActivityAt).toBe("2026-09-27T12:00:00.000Z");
  });

  it("refuses to mark ready a generation that is not provisioning, or one without its instance", async () => {
    const { sessions, workspaceId } = setup();
    await sessions.ensureSession({ workspaceId, binding });
    await expect(sessions.markReady(workspaceId, 1)).rejects.toThrow(/STALE_FENCE/);
    await sessions.markVolume(workspaceId, 1, "vol-0123456789abcdef0");
    await sessions.markInstance(workspaceId, 1, "i-0123456789abcdef0", "10.42.128.10");
    await expect(sessions.markReady(workspaceId, 2)).rejects.toThrow(/STALE_FENCE/);
    await expect(sessions.markVolume(workspaceId, 1, "vol-0fffffffffffffff0")).rejects.toThrow();
  });
});

describe("session manager: failure and resume", () => {
  it("fails parked operations, keeps the volume, and starts the next generation in the volume's zone", async () => {
    const { db, sessions, startExecution, workspaceId, session } = setup();
    const { outboxId, operationId } = seedOperation(db, workspaceId);
    await sessions.ensureSession({ workspaceId, binding: { ...binding, subnets: [...binding.subnets].reverse() }, waitingOutboxId: outboxId });
    await sessions.markVolume(workspaceId, 1, "vol-0123456789abcdef0");
    await sessions.markInstance(workspaceId, 1, "i-0123456789abcdef0", "10.42.144.10");
    expect(await sessions.markFailed(workspaceId, 1, "worker did not answer /ping within 10 minutes")).toEqual({ failed: [outboxId] });
    expect(session()).toMatchObject({ state: "FAILED", volumeId: "vol-0123456789abcdef0", availabilityZone: "us-east-1b" });
    expect(session()).not.toHaveProperty("instanceId");
    const operation = db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${operationId}`)!;
    expect(operation.status).toBe("FAILED");
    expect(operation.error).toBe("RUNTIME_UNAVAILABLE: workspace compute failed to start: worker did not answer /ping within 10 minutes");
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "PREPARATION_FAILED" });
    expect(db.get(`OUTBOX#${outboxId}`, "OUTBOX")).toMatchObject({ status: "FAILED" });

    expect(await sessions.ensureSession({ workspaceId, binding })).toEqual({ ready: false, generation: 2, state: "PROVISIONING" });
    expect(JSON.parse(startExecution.mock.calls[1]![0].input)).toMatchObject({
      generation: 2, availabilityZone: "us-east-1b", subnetId: "subnet-0bbbbbbbbbbbbbbbb", volumeId: "vol-0123456789abcdef0",
    });
  });

  it("resumes a STOPPED session on its volume, and refuses a binding with no subnet in that zone", async () => {
    const { db, sessions, workspaceId } = setup();
    db.set({
      pk: `WORKSPACE#${workspaceId}`, sk: "SESSION", entityType: "SESSION", workspaceId, state: "STOPPED", sessionState: "STOPPED", generation: 3,
      volumeId: "vol-0123456789abcdef0", availabilityZone: "us-east-1b", subnetId: "subnet-0bbbbbbbbbbbbbbbb",
    });
    await expect(sessions.ensureSession({ workspaceId, binding: { ...binding, subnets: [binding.subnets[0]!] } })).rejects.toThrow(/no subnet in us-east-1b/);
    expect(await sessions.ensureSession({ workspaceId, binding })).toMatchObject({ generation: 4, state: "PROVISIONING" });
  });
});

describe("session manager: deletion", () => {
  it("deletes a READY session's instance and volume, then records DELETED and leaves the index", async () => {
    const { sessions, startExecution, workspaceId, session } = setup();
    await provisionToReady(sessions, workspaceId);
    expect(await sessions.deleteSession(workspaceId)).toEqual({ state: "DELETING" });
    const call = startExecution.mock.calls.at(-1)![0];
    expect(call).toMatchObject({ stateMachineArn: DELETER, name: `ws-${workspaceId}-delete` });
    expect(JSON.parse(call.input)).toEqual({ workspaceId, instanceId: "i-0123456789abcdef0", volumeId: "vol-0123456789abcdef0" });
    expect(await sessions.deleteSession(workspaceId)).toEqual({ state: "DELETING" });
    await sessions.markDeleted(workspaceId);
    expect(session()).toMatchObject({ state: "DELETED" });
    for (const field of ["sessionState", "instanceId", "privateIp"]) expect(session()).not.toHaveProperty(field);
    await sessions.markDeleted(workspaceId);
    await expect(sessions.ensureSession({ workspaceId, binding })).rejects.toThrow(/WORKSPACE_NOT_READY/);
  });

  it("has nothing to delete for a workspace that never provisioned, and refuses while compute is starting", async () => {
    const { sessions, workspaceId } = setup();
    expect(await sessions.deleteSession(workspaceId)).toEqual({ state: "DELETED" });
    await sessions.ensureSession({ workspaceId, binding });
    await expect(sessions.deleteSession(workspaceId)).rejects.toThrow(/WORKSPACE_BUSY/);
  });
});
