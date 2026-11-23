import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { SessionManager } from "../../packages/broker/src/aws/sessions.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { BINDING } from "../support/session-machines-world.js";

async function fixture() {
  const db = new FakeDynamoDb(), workspaceId = randomUUID();
  const sessions = new SessionManager({ documentClient: db, tableName: "State", executions: { provisionerArn: "arn:aws:states:us-east-1:111122223333:stateMachine:p", deleterArn: "arn:aws:states:us-east-1:111122223333:stateMachine:d", start: async () => "arn:aws:states:us-east-1:111122223333:execution:p:x" } });
  await sessions.ensureSession({ workspaceId, binding: BINDING });
  await sessions.markVolume(workspaceId, 1, "vol-0123456789abcdef0");
  await sessions.markInstance(workspaceId, 1, "i-0123456789abcdef0", "10.0.0.1"); await sessions.markReady(workspaceId, 1);
  const generation = { sessionGeneration: 1, instanceId: "i-0123456789abcdef0", volumeId: "vol-0123456789abcdef0", dataGeneration: randomUUID() };
  const inspection = randomUUID(), retained = { schemaVersion: 1 as const, operationId: inspection, fence: 2, generation, retained: { inspectionOperationId: inspection, inspectionFence: 2, retentionId: randomUUID(), contentDigest: "a".repeat(64), generation } };
  db.set({ pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${inspection}`, status: "SUCCEEDED", kind: "close", fence: 2, workspaceId, closePreflight: { schemaVersion: 1 } });
  db.set({ ...db.get(`WORKSPACE#${workspaceId}`, "SESSION")!, closeRetention: retained, workspaceDataIdentity: generation });
  db.set({ pk: `WORKSPACE#${workspaceId}`, sk: "META", entityType: "WORKSPACE", companyId: "org_aaaaaaaaaaaaaaaaaaaa", orgId: "org_aaaaaaaaaaaaaaaaaaaa", status: "READY", activeOperationId: inspection, fence: 2 });
  return { db, sessions, workspaceId, retained, seen: (await sessions.get(workspaceId))! };
}
it("the idle compute-only transition preserves the retention and volume and makes preview proof unavailable", async () => {
  const w = await fixture();
  expect(await w.sessions.claimStop(w.seen)).toBe(true);
  expect(await w.sessions.get(w.workspaceId)).toMatchObject({ state: "STOPPING", closeRetention: w.retained, volumeId: w.retained.generation.volumeId });
  await w.sessions.markStopped(w.workspaceId, 1);
  expect(await w.sessions.get(w.workspaceId)).toMatchObject({ state: "STOPPED", closeRetention: w.retained, volumeId: w.retained.generation.volumeId });
  await expect(w.sessions.deleteSession(w.workspaceId)).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
});
it("an acceptance arriving after the idle read prevents stopping the retained machine", async () => {
  const w = await fixture(), row = w.db.get(`WORKSPACE#${w.workspaceId}`, "SESSION")!;
  w.db.set({ ...row, closeRetention: { ...w.retained, acceptedOperationId: randomUUID() } });
  const before = await w.sessions.get(w.workspaceId);
  expect(await w.sessions.claimStop(w.seen)).toBe(false);
  expect(await w.sessions.get(w.workspaceId)).toEqual(before);
});
it("lost-worker reconciliation records held/unproven state without dropping retained data or following a replacement", async () => {
  const w = await fixture();
  expect(await w.sessions.recordPingFailure(w.seen)).toBe(1);
  const counted = (await w.sessions.get(w.workspaceId))!;
  expect(await w.sessions.markLost(counted)).toBe(true);
  expect(await w.sessions.get(w.workspaceId)).toMatchObject({ state: "STOPPED", closeRetention: w.retained });
  expect((await w.sessions.get(w.workspaceId))?.instanceId).toBeUndefined();
});

it("a resumed plain deleter refuses DELETING plus retention before any physical effects (L)", async () => {
  const w = await fixture();
  const row = w.db.get(`WORKSPACE#${w.workspaceId}`, "SESSION")!;
  w.db.set({ ...row, state: "DELETING" });
  const before = await w.sessions.get(w.workspaceId);
  await expect(w.sessions.validateDeletion(w.workspaceId)).rejects.toMatchObject({ code: "STALE_FENCE" });
  expect(await w.sessions.get(w.workspaceId)).toEqual(before);
  const plain: Record<string, unknown> = { ...row, state: "DELETING" }; delete plain["closeRetention"];
  w.db.set(plain);
  await expect(w.sessions.validateDeletion(w.workspaceId)).resolves.toBeUndefined();
});

// A retained session that was idle-stopped is woken exactly like a plain stopped one: the same volume, a new instance, a new generation. Retention changes only what a Close does, never whether work can resume.
async function stoppedRetained() {
  const w = await fixture();
  expect(await w.sessions.claimStop(w.seen)).toBe(true);
  await w.sessions.markStopped(w.workspaceId, 1);
  return w;
}
it("ensureSession wakes a retained STOPPED session on the SAME volume: provisioning starts, the volume and the retention record are untouched", async () => {
  const w = await stoppedRetained();
  const result = await w.sessions.ensureSession({ workspaceId: w.workspaceId, binding: BINDING });
  expect(result).toMatchObject({ ready: false, generation: 2, state: "PROVISIONING" });
  const session = (await w.sessions.get(w.workspaceId))!;
  expect(session).toMatchObject({ state: "PROVISIONING", generation: 2, volumeId: w.retained.generation.volumeId, closeRetention: w.retained });
  expect(session.instanceId).toBeUndefined();
});
it("the provisioner's own steps then complete on the retained session: the same volume gets a new instance and the session is READY again, the retention record still the old one", async () => {
  const w = await stoppedRetained();
  await w.sessions.ensureSession({ workspaceId: w.workspaceId, binding: BINDING });
  await w.sessions.markVolume(w.workspaceId, 2, w.retained.generation.volumeId);
  await w.sessions.markInstance(w.workspaceId, 2, "i-0fedcba9876543210", "10.0.0.2");
  await w.sessions.markReady(w.workspaceId, 2);
  const session = (await w.sessions.get(w.workspaceId))!;
  expect(session).toMatchObject({ state: "READY", generation: 2, instanceId: "i-0fedcba9876543210", volumeId: w.retained.generation.volumeId, closeRetention: w.retained });
});
it("a wake that fails to provision keeps the volume and the retention, and the next request starts the next generation", async () => {
  const w = await stoppedRetained();
  await w.sessions.ensureSession({ workspaceId: w.workspaceId, binding: BINDING });
  await w.sessions.markFailed(w.workspaceId, 2, "no capacity");
  expect(await w.sessions.get(w.workspaceId)).toMatchObject({ state: "FAILED", volumeId: w.retained.generation.volumeId, closeRetention: w.retained });
  expect(await w.sessions.ensureSession({ workspaceId: w.workspaceId, binding: BINDING })).toMatchObject({ ready: false, generation: 3, state: "PROVISIONING" });
  expect((await w.sessions.get(w.workspaceId))?.closeRetention).toEqual(w.retained);
});
it("work that arrives while a retained session is provisioning parks on it and is sent back when it is READY, as on a plain one", async () => {
  const w = await stoppedRetained();
  const parked = (id: string) => w.db.set({ pk: `OUTBOX#${id}`, sk: "OUTBOX", status: "QUEUED" });
  const [first, second] = [randomUUID(), randomUUID()];
  parked(first); parked(second);
  // The wake itself parks the request that caused it; a second one arrives while it provisions.
  await w.sessions.ensureSession({ workspaceId: w.workspaceId, binding: BINDING, waitingOutboxId: first });
  expect(await w.sessions.ensureSession({ workspaceId: w.workspaceId, binding: BINDING, waitingOutboxId: second })).toMatchObject({ ready: false, state: "PROVISIONING" });
  expect((await w.sessions.get(w.workspaceId))?.waitingOutboxIds).toEqual(expect.arrayContaining([first, second]));
  await w.sessions.markVolume(w.workspaceId, 2, w.retained.generation.volumeId);
  await w.sessions.markInstance(w.workspaceId, 2, "i-0fedcba9876543210", "10.0.0.2");
  expect((await w.sessions.markReady(w.workspaceId, 2)).requeued.sort()).toEqual([first, second].sort());
});
it("a request that parks on a retained session that is STOPPING (the reaper is ending its instance) waits for it, as on a plain one", async () => {
  const w = await fixture();
  expect(await w.sessions.claimStop(w.seen)).toBe(true);
  const waiting = randomUUID();
  w.db.set({ pk: `OUTBOX#${waiting}`, sk: "OUTBOX", status: "QUEUED" });
  expect(await w.sessions.ensureSession({ workspaceId: w.workspaceId, binding: BINDING, waitingOutboxId: waiting })).toMatchObject({ ready: false, state: "STOPPING" });
  expect((await w.sessions.get(w.workspaceId))?.waitingOutboxIds).toEqual([waiting]);
});
it("an ACCEPTED close, or a destroy, owns the session: it is never woken", async () => {
  for (const make of [
    (w: Awaited<ReturnType<typeof stoppedRetained>>) => ({ closeRetention: { ...w.retained, acceptedOperationId: randomUUID() } }),
    (w: Awaited<ReturnType<typeof stoppedRetained>>) => ({ closeDestroy: { schemaVersion: 1, acceptedOperationId: randomUUID(), retention: w.retained.retained, effectId: "terminate-1", machineIds: ["machine-1"] } }),
  ]) {
    const w = await stoppedRetained();
    const owned = make(w);
    const row = w.db.get(`WORKSPACE#${w.workspaceId}`, "SESSION")!;
    w.db.set({ ...row, ...owned });
    const before = await w.sessions.get(w.workspaceId);
    await expect(w.sessions.ensureSession({ workspaceId: w.workspaceId, binding: BINDING })).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
    expect(await w.sessions.get(w.workspaceId)).toEqual(before);
  }
});
it("a retention that names another volume than the session's is not woken (the guard checks the volume): nothing changes", async () => {
  const w = await stoppedRetained();
  const row = w.db.get(`WORKSPACE#${w.workspaceId}`, "SESSION")!;
  w.db.set({ ...row, volumeId: "vol-0aaaaaaaaaaaaaaaa" });
  const before = await w.sessions.get(w.workspaceId);
  await expect(w.sessions.ensureSession({ workspaceId: w.workspaceId, binding: BINDING })).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  expect(await w.sessions.get(w.workspaceId)).toEqual(before);
});
it("a provisioning step never touches a session an accepted close or a destroy owns: the write is refused and the session is as it was", async () => {
  for (const make of [
    (w: Awaited<ReturnType<typeof stoppedRetained>>) => ({ closeRetention: { ...w.retained, acceptedOperationId: randomUUID() } }),
    (w: Awaited<ReturnType<typeof stoppedRetained>>) => ({ closeDestroy: { schemaVersion: 1, acceptedOperationId: randomUUID(), retention: w.retained.retained, effectId: "terminate-1", machineIds: ["machine-1"] } }),
  ]) {
    const w = await stoppedRetained();
    await w.sessions.ensureSession({ workspaceId: w.workspaceId, binding: BINDING });
    w.db.set({ ...w.db.get(`WORKSPACE#${w.workspaceId}`, "SESSION")!, ...make(w) });
    const before = await w.sessions.get(w.workspaceId);
    await expect(w.sessions.markInstance(w.workspaceId, 2, "i-0fedcba9876543210", "10.0.0.2")).rejects.toBeDefined();
    expect(await w.sessions.get(w.workspaceId)).toEqual(before);
  }
});
