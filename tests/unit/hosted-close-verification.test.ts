import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createDispatcherCloseInspection, withCloseVerification } from "../../packages/broker/src/aws/worker-machines/close-retention.js";
import { createHarness } from "../support/task-flow-harness.js";

const retention = () => ({ inspectionOperationId: randomUUID(), inspectionFence: 1, retentionId: randomUUID(), contentDigest: "a".repeat(64), generation: { sessionGeneration: 1, instanceId: "i-0123456789abcdef0", volumeId: "vol-0123456789abcdef0", dataGeneration: randomUUID() } });
it("strict verification rejects mixed SQS/unknown fields before either routing branch runs", async () => {
  const queue = vi.fn(async () => ({})), verify = vi.fn(async () => true), route = withCloseVerification(queue, verify);
  const query = { kind: "close-retention.verify", schemaVersion: 1, companyId: "org_aaaaaaaaaaaaaaaaaaaa", workspaceId: randomUUID(), retention: retention(), queryId: randomUUID() };
  for (const patch of [{ Records: [] }, { schemaVersion: 2 }, { retention: { ...query.retention, hostPath: "/tmp" } }, { companyId: "other" }]) {
    await expect(route({ ...query, ...patch })).rejects.toThrow();
  }
  expect(queue).not.toHaveBeenCalled(); expect(verify).not.toHaveBeenCalled();
  await expect(route(query)).resolves.toEqual({ schemaVersion: 1, queryId: query.queryId, verified: true });
  expect(queue).not.toHaveBeenCalled();
});
it("missing or foreign workspace proof returns false before session/worker access with zero mutations", async () => {
  const h = createHarness();
  const session = vi.fn(async () => undefined), deliver = vi.spyOn(h.machines, "deliver"), health = vi.spyOn(h.machines, "health");
  const provider = createDispatcherCloseInspection({ companyId: h.deps.companyId, store: h.store, machines: h.machines, sessions: { get: session } });
  const row = retention(), query = { kind: "close-retention.verify", schemaVersion: 1, companyId: h.deps.companyId, workspaceId: randomUUID(), retention: row, queryId: randomUUID() };
  const route = withCloseVerification(async () => { throw new Error("SQS must not run"); }, event => provider.retained({ workspaceId: event.workspaceId, operationId: row.inspectionOperationId, fence: row.inspectionFence, retentionId: row.retentionId, contentDigest: row.contentDigest, retentionProof: { schemaVersion: 1, generation: row.generation } }));
  const writes = [vi.spyOn(h.store, "transact"), vi.spyOn(h.store, "put"), vi.spyOn(h.store, "update"), vi.spyOn(h.store, "delete")];
  await expect(route(query)).resolves.toMatchObject({ verified: false });
  for (const effect of [...writes, session, deliver, health]) expect(effect).not.toHaveBeenCalled();
});
