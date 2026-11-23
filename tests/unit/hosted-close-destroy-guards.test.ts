import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { change, workspaceSessionKey, type WorkerInvocation, type WorkspaceSession } from "@agentx/contracts";
import { createDispatcherCloseInspection } from "../../packages/broker/src/aws/worker-machines/close-retention.js";
import { sessionMachineId } from "../../packages/broker/src/aws/worker-machines/session-worker-machines.js";
import { closeRecoveryHarness } from "../support/close-recovery-harness.js";

async function fixture() {
  const w = await closeRecoveryHarness({ money: true, flushed: true });
  const machineId = sessionMachineId(w.task.workspaceId), generation = { sessionGeneration: 1, instanceId: "i-0123456789abcdef0", volumeId: "vol-0123456789abcdef0", dataGeneration: randomUUID() };
  const retention = { inspectionOperationId: w.inspected.sk.slice(10), inspectionFence: Number((await w.h.store.get(w.wk))!.fence), retentionId: randomUUID(), contentDigest: "a".repeat(64), generation };
  await w.h.store.update({ key: w.inspected, ops: [change.set("result.closeInspection.retentionId", retention.retentionId), change.set("result.closeInspection.retentionProof", { schemaVersion: 1, generation })] });
  await w.h.store.update({ key: w.wk, ops: [change.set("machine", { machineId, machineKey: w.task.workspaceId })] });
  await w.h.store.update({ key: w.runKey, ops: [change.set("machineId", machineId)] });
  w.h.deps.closeInspection!.destroyRetained = async () => false;
  const preview = await w.h.flow.previewClose(w.h.owner, w.task.taskId, "close");
  expect(preview.preview).not.toBeNull();
  await w.h.flow.close(w.h.owner, w.task.taskId, { requestId: randomUUID(), expectedPreviewDigest: preview.preview!.digest });
  const operation = (await w.accepted())!, accepted = operation.closeAcceptance!;
  expect(accepted.phase).toBe("accounted");
  const session: WorkspaceSession = { workspaceId: w.task.workspaceId, state: "READY", generation: 1, instanceId: generation.instanceId, volumeId: generation.volumeId, privateIp: "10.0.0.1", subnetId: "subnet-0123456789abcdef0", availabilityZone: "us-east-1a", launchedAt: new Date().toISOString(), readyAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(), workspaceDataIdentity: generation, closeRetention: { schemaVersion: 1, operationId: retention.inspectionOperationId, fence: retention.inspectionFence, generation, retained: retention, acceptedOperationId: operation.id } };
  const sessionKey = workspaceSessionKey(w.task.workspaceId);
  await w.h.store.put({ item: { ...sessionKey, ...session } as never });
  const deleteRetainedSession = vi.fn(async () => true);
  const deliver = vi.spyOn(w.h.machines, "deliver").mockImplementation(async (_machine: string, command: WorkerInvocation) => {
    const payload = command.payload as { effectId: string; machineIds: string[] };
    return { duplicate: false, answer: { schemaVersion: 1, action: "destroy", status: "destroy_authorized", workspaceId: command.workspaceId, operationId: command.operationId, fence: command.fence, retention, effectId: payload.effectId, machineIds: payload.machineIds } };
  });
  const sessions = { get: vi.fn<() => Promise<WorkspaceSession | undefined>>(async () => session), deleteRetainedSession };
  const provider = createDispatcherCloseInspection({ companyId: w.h.deps.companyId, store: w.h.store, machines: w.h.machines, sessions });
  const input = { workspaceId: w.task.workspaceId, operationId: retention.inspectionOperationId, fence: retention.inspectionFence, retentionId: String(retention.retentionId), contentDigest: retention.contentDigest, retentionProof: { schemaVersion: 1 as const, generation }, effectId: accepted.effectIds.terminate, machineIds: [machineId] };
  return { ...w, session, sessions, sessionKey, operation, accepted, provider, deliver, deleteRetainedSession, input };
}

it("the exact accounted close records one immutable authorization before requesting physical deletion", async () => {
  const w = await fixture();
  expect(await w.provider.destroyRetained!(w.input)).toBe(true);
  expect(w.deliver).toHaveBeenCalledOnce(); expect(w.deleteRetainedSession).toHaveBeenCalledOnce();
  expect((await w.h.store.get(w.sessionKey))?.state).toBe("DELETING");
  expect((await w.h.store.get(w.operation))?.closeDestroyAuthorization).toMatchObject({ effectId: w.input.effectId, acceptedOperationId: w.operation.id });
});
it.each(["selector", "missing SESSION", "machines", "effect", "acceptance phase", "account receipt", "accepted operation", "state", "generation", "proof"] as const)("refuses changed %s before worker or deletion effects", async field => {
  const w = await fixture();
  if (field === "selector") w.input.retentionId = "invalid";
  if (field === "missing SESSION") w.sessions.get.mockResolvedValue(undefined);
  if (field === "machines") w.input.machineIds.push("unaccounted-machine");
  if (field === "effect") w.input.effectId = "different";
  if (field === "acceptance phase") await w.h.store.update({ key: w.operation, ops: [change.set("closeAcceptance.phase", "claimed")] });
  if (field === "account receipt") await w.h.store.update({ key: w.operation, ops: [change.remove("closeAcceptance.receipts.account")] });
  if (field === "accepted operation") delete w.session.closeRetention!.acceptedOperationId;
  if (field === "state") w.session.state = "STOPPED";
  if (field === "generation") w.session.generation++;
  if (field === "proof") w.session.closeRetention!.retained = { ...w.session.closeRetention!.retained!, contentDigest: "b".repeat(64) };
  const writes = vi.spyOn(w.h.store, "transact"), reads = vi.spyOn(w.h.store, "get");
  expect(await w.provider.destroyRetained!(w.input)).toBe(false);
  if (field === "selector" || field === "missing SESSION" || field === "accepted operation") expect(reads.mock.calls.filter(([key]) => key.sk.startsWith("OPERATION#"))).toEqual([]);
  expect(w.deliver).not.toHaveBeenCalled(); expect(w.deleteRetainedSession).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
});
it.each(["retention", "effect", "machines"] as const)("refuses a destroy acknowledgment with changed %s before persisting authorization", async field => {
  const w = await fixture(), original = w.deliver.getMockImplementation()!;
  w.deliver.mockImplementation(async (...args) => {
    const result = await original(...args), answer = { ...result.answer };
    if (field === "retention") answer.retention = { ...w.session.closeRetention!.retained!, contentDigest: "b".repeat(64) };
    if (field === "effect") answer.effectId = "different";
    if (field === "machines") answer.machineIds = ["different"];
    return { ...result, answer };
  });
  const writes = vi.spyOn(w.h.store, "transact");
  expect(await w.provider.destroyRetained!(w.input)).toBe(false);
  expect(w.deleteRetainedSession).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
});
it.each([
  ["workspace company", "workspace", "companyId", "org_bbbbbbbbbbbbbbbbbbbb"],
  ["workspace state", "workspace", "status", "READY"],
  ["workspace fence", "workspace", "fence", 999],
  ["workspace holder", "workspace", "activeOperationId", "other"],
  ["task company", "task", "companyId", "org_bbbbbbbbbbbbbbbbbbbb"],
  ["task close", "task", "closeOperationId", "other"],
  ["task closed", "task", "closedAt", "2026-11-22T00:00:00.000Z"],
  ["session generation", "session", "generation", 99],
  ["session instance", "session", "instanceId", "i-11111111111111111"],
  ["session volume", "session", "volumeId", "vol-11111111111111111"],
  ["session state", "session", "state", "STOPPED"],
  ["session destroy", "session", "closeDestroy", {}],
  ["session data identity", "session", "workspaceDataIdentity", {}],
  ["session retention", "session", "closeRetention", {}],
  ["acceptance", "operation", "closeAcceptance.phase", "flushed"],
] as const)("atomically refuses a racing %s before authorization or deletion", async (_name, kind, path, value) => {
  const w = await fixture(), transact = w.h.store.transact.bind(w.h.store);
  let raced = false;
  w.h.store.transact = async items => {
    if (!raced) {
      raced = true;
      const key = kind === "workspace" ? w.wk : kind === "task" ? w.tk : kind === "session" ? w.sessionKey : w.operation;
      await w.h.store.update({ key, ops: [change.set(path, value)] });
    }
    return transact(items);
  };
  expect(await w.provider.destroyRetained!(w.input)).toBe(false);
  expect(w.deleteRetainedSession).not.toHaveBeenCalled();
  expect((await w.h.store.get(w.operation))?.closeDestroyAuthorization).toBeUndefined();
});
