import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { CLOSE_RETENTION_FEATURE, change, workspaceSessionKey, type WorkspaceSession, type CloseRetention } from "@agentx/contracts";
import { createDispatcherCloseInspection } from "../../packages/broker/src/aws/worker-machines/close-retention.js";
import { operationKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { createHarness } from "../support/task-flow-harness.js";

async function fixture() {
  const h = createHarness(); await h.registerProject();
  const { task } = await h.flow.start(h.owner, { requestId: randomUUID(), project: "payments", instructions: "preparation guards" });
  const wk = workspaceKey(h.deps.companyId, task.workspaceId), workspace = (await h.store.get(wk))!;
  const operationId = workspace.activeOperationId;
  if (typeof operationId !== "string") throw new Error("fixture has no workspace holder");
  const fence = Number(workspace.fence), op = operationKey(h.deps.companyId, task.workspaceId, operationId);
  await h.store.update({ key: op, ops: [change.set("kind", "close"), change.set("status", "RUNNING"), change.set("closePreflight", { schemaVersion: 1 })] });
  const generation = { sessionGeneration: 1, instanceId: "i-0123456789abcdef0", volumeId: "vol-0123456789abcdef0", dataGeneration: randomUUID() };
  const session: WorkspaceSession = { workspaceId: task.workspaceId, state: "READY", generation: 1, instanceId: generation.instanceId, volumeId: generation.volumeId, privateIp: "10.0.0.1", subnetId: "subnet-0123456789abcdef0", availabilityZone: "us-east-1a", launchedAt: new Date().toISOString(), readyAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(), workerFeatures: [CLOSE_RETENTION_FEATURE] };
  const sk = workspaceSessionKey(task.workspaceId); await h.store.put({ item: { ...sk, ...session } as never });
  const health = vi.spyOn(h.machines, "health").mockResolvedValue({ state: "ready", activeOperations: 0, checkedAt: "2026-11-22T00:00:00.000Z", features: [CLOSE_RETENTION_FEATURE], workspaceDataIdentity: generation });
  const deliver = vi.spyOn(h.machines, "deliver").mockImplementation(async (_machine, command) => ({ duplicate: false, answer: {
    schemaVersion: 1, workspaceId: command.workspaceId, operationId: command.operationId, fence: command.fence, action: "retain", status: "retained",
    retention: { inspectionOperationId: command.operationId, inspectionFence: command.fence, retentionId: randomUUID(), contentDigest: "a".repeat(64), generation },
    inspection: { safeToClose: true, repositories: [], contentDigest: "a".repeat(64) },
  } }));
  const provider = createDispatcherCloseInspection({ companyId: h.deps.companyId, store: h.store, machines: h.machines, sessions: { get: async () => session } });
  return { h, task, wk, op, sk, session, generation, health, deliver, provider, input: { workspaceId: task.workspaceId, operationId, fence } };
}
it("claims the exact preparation before retaining and persists the completed proof", async () => {
  const w = await fixture();
  expect(await w.provider.inspectWorkspaceForClose(w.input)).toMatchObject({ retentionProof: { schemaVersion: 1, generation: w.generation } });
  expect((await w.h.store.get(w.sk))?.closeRetention).toMatchObject({ operationId: w.input.operationId, generation: w.generation, retained: { generation: w.generation } });
  expect(w.deliver).toHaveBeenCalledOnce();
});
it.each(["session", "preflight", "feature", "identity", "generation", "owner"] as const)("refuses invalid %s before preparation or worker effects", async field => {
  const w = await fixture();
  if (field === "session") w.session.state = "STOPPED";
  if (field === "preflight") await w.h.store.update({ key: w.op, ops: [change.remove("closePreflight")] });
  if (field === "feature") w.health.mockResolvedValue({ state: "ready", activeOperations: 0, checkedAt: "2026-11-22T00:00:00.000Z", features: [], workspaceDataIdentity: w.generation });
  if (field === "identity") w.health.mockResolvedValue({ state: "ready", activeOperations: 0, checkedAt: "2026-11-22T00:00:00.000Z", features: [CLOSE_RETENTION_FEATURE] });
  if (field === "generation") w.session.generation++;
  if (field === "owner") w.session.closeRetention = { schemaVersion: 1, operationId: randomUUID(), fence: 99, generation: w.generation };
  const writes = vi.spyOn(w.h.store, "transact");
  await expect(w.provider.inspectWorkspaceForClose(w.input)).rejects.toThrow();
  expect(writes).not.toHaveBeenCalled(); expect(w.deliver).not.toHaveBeenCalled();
});
it.each([
  ["workspace company", "workspace", "companyId", "org_bbbbbbbbbbbbbbbbbbbb"],
  ["workspace fence", "workspace", "fence", 999],
  ["workspace holder", "workspace", "activeOperationId", "other"],
  ["legacy claim", "workspace", "legacyCloseClaim", "other"],
  ["operation company", "operation", "companyId", "org_bbbbbbbbbbbbbbbbbbbb"],
  ["operation status", "operation", "status", "SUCCEEDED"],
  ["preflight identity", "operation", "closePreflight", { schemaVersion: 1, target: {} }],
  ["session state", "session", "state", "STOPPED"],
  ["session generation", "session", "generation", 99],
  ["session instance", "session", "instanceId", "i-11111111111111111"],
  ["session volume", "session", "volumeId", "vol-11111111111111111"],
  ["session owner", "session", "closeRetention", {}],
  ["session destroy", "session", "closeDestroy", {}],
] as const)("atomically refuses a racing %s before sending retain", async (_name, kind, path, value) => {
  const w = await fixture(), transact = w.h.store.transact.bind(w.h.store); let raced = false;
  w.h.store.transact = async items => {
    if (!raced) { raced = true; await w.h.store.update({ key: kind === "workspace" ? w.wk : kind === "operation" ? w.op : w.sk, ops: [change.set(path, value)] }); }
    return transact(items);
  };
  await expect(w.provider.inspectWorkspaceForClose(w.input)).rejects.toThrow();
  expect(w.deliver).not.toHaveBeenCalled();
  expect((await w.h.store.get(w.sk))?.closeRetention ?? {}).not.toHaveProperty("retained");
});
it.each([
  ["state", "state", "STOPPED"], ["session generation", "generation", 99],
  ["instance", "instanceId", "i-11111111111111111"], ["volume", "volumeId", "vol-11111111111111111"],
  ["operation", "closeRetention.operationId", "other"], ["generation", "closeRetention.generation", {}],
  ["acceptance", "closeRetention.acceptedOperationId", "other"],
] as const)("withholds proof when %s races the completed retention save", async (_name, path, value) => {
  const w = await fixture(), transact = w.h.store.transact.bind(w.h.store); let calls = 0;
  w.h.store.transact = async items => {
    if (++calls === 2) await w.h.store.update({ key: w.sk, ops: [change.set(path, value)] });
    return transact(items);
  };
  await expect(w.provider.inspectWorkspaceForClose(w.input)).rejects.toThrow();
  expect(w.deliver).toHaveBeenCalledOnce();
  expect((await w.h.store.get(w.sk))?.closeRetention ?? {}).not.toHaveProperty("retained");
});

it("checks READY and actual worker capability before claiming support", async () => {
  const w = await fixture();
  expect(await w.provider.ready!(w.task.workspaceId)).toBe(true);
  expect(await w.provider.ready!(w.task.workspaceId, true)).toBe(true);
  w.session.state = "STOPPED"; w.health.mockClear();
  expect(await w.provider.ready!(w.task.workspaceId)).toBe(false);
  expect(await w.provider.ready!(w.task.workspaceId, true)).toBe(false); expect(w.health).not.toHaveBeenCalled();
  w.session.state = "READY"; w.session.workerFeatures = [];
  expect(await w.provider.ready!(w.task.workspaceId)).toBe(false);
  w.health.mockResolvedValue({ state: "ready", activeOperations: 0, checkedAt: "2026-11-22T00:00:00.000Z", features: [] });
  expect(await w.provider.ready!(w.task.workspaceId, true)).toBe(false);
});
it.each(["state", "identity", "generation", "instance", "volume"] as const)("runtime discovery with invalid %s does not change SESSION", async field => {
  const w = await fixture(), health = (await w.h.machines.health("unused"));
  if (field === "state") w.session.state = "STOPPED";
  if (field === "identity") delete health.workspaceDataIdentity;
  if (field === "generation") w.session.generation++;
  if (field === "instance") w.session.instanceId = "i-11111111111111111";
  if (field === "volume") w.session.volumeId = "vol-11111111111111111";
  const writes = vi.spyOn(w.h.store, "transact"), before = await w.h.store.get(w.sk);
  await w.provider.noteRuntime!(w.task.workspaceId, health);
  expect(writes).not.toHaveBeenCalled(); expect(await w.h.store.get(w.sk)).toEqual(before);
});
it("runtime discovery records exact live identity and features while the SESSION is still unchanged", async () => {
  const w = await fixture();
  await w.provider.noteRuntime!(w.task.workspaceId, await w.h.machines.health("unused"));
  expect(await w.h.store.get(w.sk)).toMatchObject({ workspaceDataIdentity: w.generation, workerFeatures: [CLOSE_RETENTION_FEATURE] });
});

it("a retained worker reply for another data generation is never published", async () => {
  const w = await fixture(), original = w.deliver.getMockImplementation()!;
  w.deliver.mockImplementation(async (...args) => {
    const result = await original(...args), retention = result.answer!.retention as CloseRetention;
    return { ...result, answer: { ...result.answer, retention: { ...retention, generation: { ...retention.generation, dataGeneration: randomUUID() } } } };
  });
  await expect(w.provider.inspectWorkspaceForClose(w.input)).rejects.toThrow("retention not completed");
  expect((await w.h.store.get(w.sk))?.closeRetention ?? {}).not.toHaveProperty("retained");
});
