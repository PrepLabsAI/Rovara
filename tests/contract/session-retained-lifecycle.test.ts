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
