import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Ec2RuntimeBinding } from "../../packages/contracts/src/session.js";
import { SessionManager, sessionFromItem, type SessionManagerDependencies } from "../../packages/broker/src/aws/sessions.js";
import { createSessionStepsHandler } from "../../packages/broker/src/aws/session-steps.js";
import { sessionMachineId } from "../../packages/broker/src/aws/worker-machines/session-worker-machines.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { BINDING, COMPANY_A, createSessionMachinesWorld } from "../support/session-machines-world.js";

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
  // Catches a Lambda-local first-instance cache in either recordInstance branch.
  it.each([false])("one session-steps handler records each workspace/generation's own identity (typed launch: %s)", async (typed) => {
    const { sessions, workspaceId: workspaceA } = setup();
    const workspaceB = randomUUID();
    const unused = () => { throw new Error("recording must not use launch/probe dependencies"); };
    const handler = createSessionStepsHandler({
      sessions, workerSettings: unused, invokePublicKey: unused, bootScript: unused,
      controlPlaneUrl: "https://control.example.invalid", logGroupName: "/test/worker", ping: unused,
    });
    const launched = typed ? { instanceType: "m6g.large", machineFallback: null } : {};
    await sessions.ensureSession({ workspaceId: workspaceA, binding });
    await sessions.ensureSession({ workspaceId: workspaceB, binding });
    await handler({ action: "recordInstance", workspaceId: workspaceA, generation: 1, instanceId: "i-aaaaaaaaaaaaaaaaa", privateIp: "10.42.0.11", ...launched });
    await handler({ action: "recordInstance", workspaceId: workspaceB, generation: 1, instanceId: "i-bbbbbbbbbbbbbbbbb", privateIp: "10.42.0.12", ...launched });
    expect(await sessions.get(workspaceA)).toMatchObject({ workspaceId: workspaceA, generation: 1, instanceId: "i-aaaaaaaaaaaaaaaaa", privateIp: "10.42.0.11" });
    const recordedB = await sessions.get(workspaceB);
    expect(recordedB).toMatchObject({ workspaceId: workspaceB, generation: 1, instanceId: "i-bbbbbbbbbbbbbbbbb", privateIp: "10.42.0.12" });

    await sessions.markFailed(workspaceA, 1, "retry with a new generation");
    await sessions.ensureSession({ workspaceId: workspaceA, binding });
    await handler({ action: "recordInstance", workspaceId: workspaceA, generation: 2, instanceId: "i-ccccccccccccccccc", privateIp: "10.42.0.13", ...launched });
    expect(await sessions.get(workspaceA)).toMatchObject({ workspaceId: workspaceA, generation: 2, instanceId: "i-ccccccccccccccccc", privateIp: "10.42.0.13" });
    expect(await sessions.get(workspaceB)).toEqual(recordedB);
  });

  it.each([COMPANY_A])("provisions B independently after A is READY, including A's restart while B stays READY (%s)", async (companyOfB) => {
    const world = createSessionMachinesWorld();
    const workspaceA = world.workspace(COMPANY_A);
    const workspaceB = world.workspace(companyOfB);
    const ensure = (workspaceId: string) => world.sessions.ensureSession({ workspaceId, binding: BINDING });

    await ensure(workspaceA);
    await world.settle();
    const firstA = (await world.sessions.get(workspaceA))!;
    expect(firstA).toMatchObject({ workspaceId: workspaceA, state: "READY", generation: 1 });
    expect(world.instances.get(firstA.instanceId!)).toMatchObject({ workspaceId: workspaceA, generation: 1, running: true });

    expect(await ensure(workspaceB)).toEqual({ ready: false, generation: 1, state: "PROVISIONING" });
    expect(await world.sessions.get(workspaceB)).toMatchObject({ workspaceId: workspaceB, state: "PROVISIONING", generation: 1 });
    expect(world.executions.map(({ name }) => name)).toEqual([`ws-${workspaceA}-gen-1`, `ws-${workspaceB}-gen-1`]);
    await world.settle();
    const readyB = (await world.sessions.get(workspaceB))!;
    expect(readyB).toMatchObject({ workspaceId: workspaceB, state: "READY", generation: 1 });
    expect(world.instances.get(readyB.instanceId!)).toMatchObject({ workspaceId: workspaceB, generation: 1, running: true });
    expect(readyB.instanceId).not.toBe(firstA.instanceId);
    expect(readyB.privateIp).not.toBe(firstA.privateIp);
    expect(await ensure(workspaceB)).toEqual({ ready: true, generation: 1, privateIp: readyB.privateIp, instanceId: readyB.instanceId, subnetId: readyB.subnetId });

    await world.machinesFor(COMPANY_A).stop(sessionMachineId(workspaceA));
    expect(await world.sessions.get(workspaceA)).toMatchObject({ state: "STOPPED", generation: 1 });
    expect(await ensure(workspaceA)).toEqual({ ready: false, generation: 2, state: "PROVISIONING" });
    await world.settle();
    const restartedA = (await world.sessions.get(workspaceA))!;
    expect(restartedA).toMatchObject({ workspaceId: workspaceA, state: "READY", generation: 2 });
    expect(world.instances.get(restartedA.instanceId!)).toMatchObject({ workspaceId: workspaceA, generation: 2 });
    expect(new Set([firstA.instanceId, readyB.instanceId, restartedA.instanceId]).size).toBe(3);
    expect(new Set([firstA.privateIp, readyB.privateIp, restartedA.privateIp]).size).toBe(3);
    expect(world.executions.map(({ name }) => name)).toEqual([`ws-${workspaceA}-gen-1`, `ws-${workspaceB}-gen-1`, `ws-${workspaceA}-gen-2`]);
    expect(await world.sessions.get(workspaceB)).toEqual(readyB);
    expect(await ensure(workspaceA)).toEqual({ ready: true, generation: 2, privateIp: restartedA.privateIp, instanceId: restartedA.instanceId, subnetId: restartedA.subnetId });
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

});

describe("session manager: launched machine size (DEC 254zb)", () => {
  it("keeps the launched type and the fallback reason for the generation, and the next generation starts without the reason", async () => {
    const { db, sessions, workspaceId, session } = setup();
    await sessions.ensureSession({ workspaceId, binding });
    await sessions.markVolume(workspaceId, 1, "vol-0123456789abcdef0");
    await sessions.markInstance(workspaceId, 1, "i-0123456789abcdef0", "10.42.128.10", { instanceType: "m6g.large", machineFallback: "size-unavailable" });
    expect(session()).toMatchObject({ instanceType: "m6g.large", machineFallback: "size-unavailable" });
    expect(sessionFromItem(session()!)).toMatchObject({ instanceType: "m6g.large", machineFallback: "size-unavailable" });
    // A launch that reports no reason never clears one already recorded for this generation (an x86 choice the install cannot run is recorded before launch).
    await sessions.markInstance(workspaceId, 1, "i-0123456789abcdef1", "10.42.128.11", { instanceType: "m6g.xlarge" });
    expect(session()).toMatchObject({ instanceType: "m6g.xlarge", machineFallback: "size-unavailable" });
    db.set({ ...session()!, state: "FAILED", sessionState: "FAILED" });
    await sessions.ensureSession({ workspaceId, binding });
    expect(session()).toMatchObject({ state: "PROVISIONING", generation: 2 });
    expect(session()).not.toHaveProperty("machineFallback");
  });

});

describe("session manager: picking the machine size (DEC 254zb)", () => {
  function picked(pick: SessionManagerDependencies["pickMachine"]) {
    const db = new FakeDynamoDb();
    const startExecution = vi.fn<StartExecution>(startedExecution);
    const sessions = new SessionManager({
      documentClient: db, tableName: "state", executions: { provisionerArn: PROVISIONER, deleterArn: DELETER, start: startExecution },
      now: () => new Date("2026-09-27T12:00:00.000Z"), chooseSubnet: (subnets) => subnets[0]!, ...(pick === undefined ? {} : { pickMachine: pick }),
    });
    const workspaceId = randomUUID();
    const input = () => JSON.parse(startExecution.mock.calls.at(-1)![0].input) as Record<string, unknown>;
    return { db, sessions, workspaceId, input, session: () => db.get(`WORKSPACE#${workspaceId}`, "SESSION") };
  }

  it("hands the provisioner the picked machine, and nothing else of the pick", async () => {
    const pick = vi.fn(async () => ({ machine: { instanceType: "m6g.2xlarge", chip: "arm64" as const, extra: "x" } as never }));
    const w = picked(pick);
    await w.sessions.ensureSession({ workspaceId: w.workspaceId, binding });
    expect(pick).toHaveBeenCalledExactlyOnceWith(w.workspaceId);
    expect(w.input().machine).toEqual({ instanceType: "m6g.2xlarge", chip: "arm64" });
  });

  it("records an x86 choice the install cannot run on the generation, launches the default, and READY reports the reason", async () => {
    const w = picked(async () => ({ fallback: "x86-unavailable" as const }));
    await w.sessions.ensureSession({ workspaceId: w.workspaceId, binding });
    expect(w.input()).not.toHaveProperty("machine");
    expect(w.session()).toMatchObject({ state: "PROVISIONING", machineFallback: "x86-unavailable" });
    await w.sessions.markVolume(w.workspaceId, 1, "vol-0123456789abcdef0");
    await w.sessions.markInstance(w.workspaceId, 1, "i-0123456789abcdef0", "10.42.128.10", { instanceType: "m6g.large" });
    await w.sessions.markReady(w.workspaceId, 1);
    expect(await w.sessions.ensureSession({ workspaceId: w.workspaceId, binding })).toEqual({ ready: true, generation: 1, privateIp: "10.42.128.10", instanceId: "i-0123456789abcdef0", subnetId: expect.any(String) as unknown, machineFallback: "x86-unavailable" });
  });

  it("launches the default when the picker fails, never failing the provisioning", async () => {
    const w = picked(async () => { throw new Error("boom"); });
    await w.sessions.ensureSession({ workspaceId: w.workspaceId, binding });
    expect(w.input()).not.toHaveProperty("machine");
    expect(w.session()).toMatchObject({ state: "PROVISIONING" });
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

describe("session manager: the failure a parked operation ends with (REDACT-BLOCK-REASON)", () => {
  // Built at run time: no key-shaped literal is in this file.
  const secret = ["ghp_", "Ab12".repeat(9)].join("");

  it("stores the provisioner's error text redacted, before it is cut, as the operation's error", async () => {
    const { db, sessions, workspaceId } = setup();
    const { operationId, outboxId } = seedOperation(db, workspaceId);
    await sessions.ensureSession({ workspaceId, binding, waitingOutboxId: outboxId });
    expect(db.get(`OUTBOX#${outboxId}`, "OUTBOX")).toMatchObject({ status: "WAITING_FOR_SESSION" });
    await sessions.markFailed(workspaceId, 1, `boot script failed: git clone https://x-access-token:${secret}@github.com/org/repo (password Tr0ub4dor&3)`);
    const stored = (db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${operationId}`) as { error?: string }).error ?? "";
    expect(stored).toMatch(/^RUNTIME_UNAVAILABLE: workspace compute failed to start: boot script failed: git clone https:\/\/\[REDACTED\]@github\.com/u);
    expect(stored).not.toContain(secret);
    expect(stored).not.toContain("Tr0ub4dor");
  });

  it("keeps the words of a failure with nothing secret in it, and still cuts to 16 KiB after redacting", async () => {
    const { db, sessions, workspaceId } = setup();
    const { operationId, outboxId } = seedOperation(db, workspaceId);
    await sessions.ensureSession({ workspaceId, binding, waitingOutboxId: outboxId });
    await sessions.markFailed(workspaceId, 1, `could not attach the volume ${"x".repeat(20_000)}`);
    const stored = (db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${operationId}`) as { error?: string }).error ?? "";
    expect(stored.startsWith("RUNTIME_UNAVAILABLE: workspace compute failed to start: could not attach the volume xxx")).toBe(true);
    expect(stored).toHaveLength(16_384);
  });
});
