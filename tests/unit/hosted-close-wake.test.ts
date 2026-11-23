// CLOSE-RETENTION: the dispatcher's wake of a stopped machine, and the session-item reading of what a check needs. Every machine and session here is a fake port, NOT machine proof: that a real stopped instance
// starts on its kept volume and is inspected is proven only by the Linux grid and the real calls after install. What is pinned: a wake only ever STARTS (never stops, terminates or deletes), it starts only a
// session that is stopped, stopping or already starting, and a session that is not there or is being deleted is never started again.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CLOSE_RETENTION_FEATURE, change, workspaceSessionKey, type MachineHealth, type WorkerMachines, type WorkspaceSession } from "@agentx/contracts";
import { closeAvailability, createBrokerCloseInspection, createDispatcherCloseInspection } from "../../packages/broker/src/aws/worker-machines/close-retention.js";
import { readWorkspace } from "../../packages/broker/src/core/task-flow/stage-machine.js";
import { sessionMachineId } from "../../packages/broker/src/aws/worker-machines/session-worker-machines.js";
import { createHarness } from "../support/task-flow-harness.js";

async function fixture(session: Partial<WorkspaceSession> | undefined, startState: "ready" | "provisioning" = "provisioning", retentionHolds = true) {
  const h = createHarness(); await h.registerProject();
  const { task } = await h.flow.start(h.owner, { requestId: randomUUID(), project: "payments", instructions: "wake me" });
  const workspaceId = task.workspaceId;
  // A retention record names the preflight that holds the workspace (a live record) unless the test says a step has since taken the workspace.
  const held = await readWorkspace({ store: h.store, companyId: h.deps.companyId }, workspaceId);
  const record = (session as { closeRetention?: object } | undefined)?.closeRetention;
  const withHold = session === undefined || record === undefined || !retentionHolds ? session : { ...session, closeRetention: { ...record, operationId: held!.activeOperationId, fence: held!.fence } };
  const raw = withHold === undefined ? undefined : { workspaceId, generation: 2, ...withHold };
  const full = raw as unknown as WorkspaceSession | undefined;
  if (raw !== undefined) await h.store.put({ item: { ...workspaceSessionKey(workspaceId), entityType: "WORKSPACE_SESSION", ...(JSON.parse(JSON.stringify(raw)) as Record<string, never>) } });
  const health: MachineHealth = { state: "ready", activeOperations: 0, features: [CLOSE_RETENTION_FEATURE], checkedAt: "2026-11-23T00:00:00.000Z", workspaceDataIdentity: { sessionGeneration: 2, instanceId: "i-00000001", volumeId: "vol-00000001", dataGeneration: randomUUID() } };
  const machines = { start: vi.fn(async () => ({ machineId: sessionMachineId(workspaceId), machineKey: workspaceId, state: startState })), stop: vi.fn(), terminate: vi.fn(), health: vi.fn(async () => health), deliver: vi.fn() };
  const deleteSession = vi.fn();
  const provider = createDispatcherCloseInspection({ store: h.store, companyId: h.deps.companyId, machines: machines as unknown as WorkerMachines, sessions: { get: async () => (full === undefined ? undefined : (await h.store.get(workspaceSessionKey(workspaceId))) as unknown as WorkspaceSession | undefined), deleteSession } as never });
  return { h, workspaceId, machines, provider, deleteSession };
}

describe("the dispatcher's wake of a stopped machine", () => {
  for (const state of ["STOPPED", "STOPPING", "PROVISIONING"] as const) {
    it(`a ${state} session is started once, by its own machine key, and answers 'waking'; nothing is stopped, terminated or deleted`, async () => {
      const f = await fixture({ state });
      expect(await f.provider.wake!(f.workspaceId)).toBe("waking");
      expect(f.machines.start).toHaveBeenCalledTimes(1);
      expect(f.machines.start).toHaveBeenCalledWith(expect.objectContaining({ machineKey: f.workspaceId, companyId: f.h.deps.companyId, labels: { workspaceId: f.workspaceId } }));
      for (const effect of [f.machines.stop, f.machines.terminate, f.deleteSession]) expect(effect).not.toHaveBeenCalled();
    });
  }
  it("a start that is already ready answers 'ready'", async () => {
    const f = await fixture({ state: "STOPPED" }, "ready");
    expect(await f.provider.wake!(f.workspaceId)).toBe("ready");
  });
  it("a READY session is not started again: its runtime is noted (the worker's features reach the session item) and it answers 'ready'", async () => {
    const f = await fixture({ state: "READY", instanceId: "i-00000001", volumeId: "vol-00000001" });
    expect(await f.provider.wake!(f.workspaceId)).toBe("ready");
    expect(f.machines.start).not.toHaveBeenCalled();
    expect(f.machines.health).toHaveBeenCalledWith(sessionMachineId(f.workspaceId));
    expect((await f.h.store.get(workspaceSessionKey(f.workspaceId)))?.["workerFeatures"]).toEqual([CLOSE_RETENTION_FEATURE]);
  });
  for (const state of ["DELETING", "DELETED", "FAILED", "NONE"] as const) {
    it(`a ${state} session is 'gone': nothing is started (a start would build a fresh empty volume or race a deleter)`, async () => {
      const f = await fixture({ state });
      expect(await f.provider.wake!(f.workspaceId)).toBe("gone");
      expect(f.machines.start).not.toHaveBeenCalled();
    });
  }
  it("no session item at all is 'gone'", async () => {
    const f = await fixture(undefined);
    expect(await f.provider.wake!(f.workspaceId)).toBe("gone");
    expect(f.machines.start).not.toHaveBeenCalled();
  });
});

describe("what a check needs, from the session item alone", () => {
  const retains = { workerFeatures: [CLOSE_RETENTION_FEATURE] };
  it.each([
    ["READY with the retention feature", { state: "READY", ...retains }, "ready"],
    ["READY with other features only (an old worker)", { state: "READY", workerFeatures: ["task.workflowMode"] }, "unsupported"],
    ["READY with no feature list", { state: "READY" }, "unsupported"],
    ["STOPPED (the instance is gone; the new one runs the current worker)", { state: "STOPPED" }, "wake"],
    ["STOPPED with a stale old feature list", { state: "STOPPED", workerFeatures: ["task.workflowMode"] }, "wake"],
    ["STOPPING", { state: "STOPPING" }, "wake"],
    ["PROVISIONING (a step is starting it)", { state: "PROVISIONING" }, "unsupported"],
    ["FAILED", { state: "FAILED" }, "unsupported"],
    ["DELETING", { state: "DELETING" }, "unsupported"],
    ["DELETED", { state: "DELETED" }, "unsupported"],
    ["READY with a retention already on it", { state: "READY", ...retains, closeRetention: { schemaVersion: 1 } }, "unsupported"],
    ["STOPPED with a retention on it (a Continue wakes it; a Close check is not layered on a retention)", { state: "STOPPED", closeRetention: { schemaVersion: 1 } }, "unsupported"],
    ["STOPPING with a destroy on it", { state: "STOPPING", closeDestroy: { schemaVersion: 1 } }, "unsupported"],
    ["no session", undefined, "unsupported"],
    ["READY with a retention that holds the workspace and was never confirmed", { state: "READY", ...retains, closeRetention: { schemaVersion: 1 } }, "unsupported"],
  ] as const)("%s is %s", async (_name, session, expected) => {
    expect(closeAvailability(session)).toBe(expected);
    const f = await fixture(session === undefined ? undefined : session as Partial<WorkspaceSession>);
    expect(await f.provider.availability!(f.workspaceId)).toBe(expected);
    // The broker's provider reads the same item through its store, and touches no machine.
    const broker = createBrokerCloseInspection(async () => false, f.h.deps.companyId, f.h.store);
    expect(await broker.availability!(f.workspaceId)).toBe(expected);
    expect(f.machines.start).not.toHaveBeenCalled();
    expect(f.machines.health).not.toHaveBeenCalled();
  });
});

describe("a retained session woken by a step: the new instance lifts the old retention only for the step that supersedes it", () => {
  async function woken() {
    const old = { sessionGeneration: 1, instanceId: "i-0000dead", volumeId: "vol-00000001", dataGeneration: randomUUID() };
    const retained = { inspectionOperationId: randomUUID(), inspectionFence: 2, retentionId: randomUUID(), contentDigest: "a".repeat(64), generation: old };
    const closeRetention = { schemaVersion: 1, operationId: retained.inspectionOperationId, fence: 2, generation: old, retained };
    // The session is READY again on a NEW instance and generation, on the SAME volume; the retention record is still the old one.
    const f = await fixture({ state: "READY", generation: 2, instanceId: "i-0000beef", volumeId: "vol-00000001", privateIp: "10.0.0.2", closeRetention } as never);
    const health: MachineHealth = { state: "ready", activeOperations: 0, features: [CLOSE_RETENTION_FEATURE], checkedAt: "2026-11-23T00:00:00.000Z", workspaceDataIdentity: { sessionGeneration: 2, instanceId: "i-0000beef", volumeId: "vol-00000001", dataGeneration: old.dataGeneration } };
    return { f, retained, health };
  }
  it("a step that supersedes the retention removes it (the work can run; only a later Close sees a fresh check)", async () => {
    const { f, retained, health } = await woken();
    await f.provider.noteRuntime!(f.workspaceId, health, { supersedesRetention: retained } as never);
    expect((await f.h.store.get(workspaceSessionKey(f.workspaceId)))?.["closeRetention"]).toBeUndefined();
    expect((await f.h.store.get(workspaceSessionKey(f.workspaceId)))?.["volumeId"]).toBe("vol-00000001");
  });
  it("a start that does not supersede it (a check, a probe) leaves the retention record exactly as it was", async () => {
    const { f, health } = await woken();
    const before = await f.h.store.get(workspaceSessionKey(f.workspaceId));
    await f.provider.noteRuntime!(f.workspaceId, health);
    expect((await f.h.store.get(workspaceSessionKey(f.workspaceId)))?.["closeRetention"]).toEqual(before?.["closeRetention"]);
  });
  it("a step that supersedes ANOTHER retention removes nothing", async () => {
    const { f, retained, health } = await woken();
    await f.provider.noteRuntime!(f.workspaceId, health, { supersedesRetention: { ...retained, retentionId: randomUUID() } } as never);
    expect((await f.h.store.get(workspaceSessionKey(f.workspaceId)))?.["closeRetention"]).toBeDefined();
  });
});

describe("a retention a step has superseded guards nothing: the check may replace it", () => {
  const retains = { workerFeatures: [CLOSE_RETENTION_FEATURE] };
  it.each([
    ["READY with the feature", { state: "READY", ...retains, closeRetention: { schemaVersion: 1 } }, "ready"],
    ["STOPPED", { state: "STOPPED", closeRetention: { schemaVersion: 1 } }, "wake"],
    ["READY, but the close was ACCEPTED (it owns the session)", { state: "READY", ...retains, closeRetention: { schemaVersion: 1, acceptedOperationId: randomUUID() } }, "unsupported"],
    ["READY, with a destroy under way", { state: "READY", ...retains, closeRetention: { schemaVersion: 1 }, closeDestroy: { schemaVersion: 1 } }, "unsupported"],
  ] as const)("%s is %s", async (_name, session, expected) => {
    const f = await fixture(session as Partial<WorkspaceSession>, "provisioning", false);
    expect(await f.provider.availability!(f.workspaceId)).toBe(expected);
    const broker = createBrokerCloseInspection(async () => false, f.h.deps.companyId, f.h.store);
    expect(await broker.availability!(f.workspaceId)).toBe(expected);
  });
  it("a retention that holds the workspace is NOT superseded; one whose workspace moved to another operation or fence is", async () => {
    const holds = { activeOperationId: "op-1", fence: 3 };
    expect(closeAvailability({ state: "READY", ...retains, closeRetention: { operationId: "op-1", fence: 3 } }, holds)).toBe("unsupported");
    expect(closeAvailability({ state: "READY", ...retains, closeRetention: { operationId: "op-2", fence: 3 } }, holds)).toBe("ready");
    expect(closeAvailability({ state: "READY", ...retains, closeRetention: { operationId: "op-1", fence: 2 } }, holds)).toBe("ready");
    expect(closeAvailability({ state: "READY", ...retains, closeRetention: { operationId: "op-1", fence: 3 } }, undefined)).toBe("unsupported");
  });
});

describe("the check replaces a retention a step has superseded, and only that", () => {
  async function checkOver(record: Record<string, unknown>) {
    const f = await fixture({ state: "READY", generation: 2, instanceId: "i-00000001", volumeId: "vol-00000001", privateIp: "10.0.0.2", workerFeatures: [CLOSE_RETENTION_FEATURE] } as never, "provisioning", false);
    const old = (await f.machines.health()).workspaceDataIdentity!;
    // The check's own preflight is at fence 3; the record it finds was made at fence 2.
    await f.h.store.update({ key: { pk: `WORKSPACE#${f.workspaceId}`, sk: "META" }, ops: [change.set("fence", 3)] }).catch(() => undefined);
    const held = (await readWorkspace({ store: f.h.store, companyId: f.h.deps.companyId }, f.workspaceId))!;
    const operationId = held.activeOperationId!, fence = held.fence;
    // The new check's own preflight holds the workspace and is RUNNING (the step that superseded the old record came and went).
    await f.h.store.update({ key: { pk: held.pk, sk: `OPERATION#${operationId}` }, ops: [change.set("kind", "close"), change.set("status", "RUNNING"), change.set("closePreflight", { schemaVersion: 1 })] });
    const stale = { schemaVersion: 1, operationId: randomUUID(), fence: fence - 1, generation: old, ...record };
    await f.h.store.update({ key: workspaceSessionKey(f.workspaceId), ops: [change.set("closeRetention", stale)] });
    const retention = { inspectionOperationId: operationId, inspectionFence: fence, retentionId: randomUUID(), contentDigest: "a".repeat(64), generation: old };
    f.machines.deliver.mockImplementation(async () => ({ answer: { schemaVersion: 1, workspaceId: f.workspaceId, operationId, fence, action: "retain", status: "retained", retention, inspection: { safeToClose: false, repositories: [{ name: "demo", reasons: ["unpushed_head"] }], contentDigest: retention.contentDigest } } }));
    return { f, operationId, fence, stale };
  }
  it("an old record of another preflight is replaced by this check's intent, atomically; the volume is the same", async () => {
    const { f, operationId } = await checkOver({});
    const result = await f.provider.inspectWorkspaceForClose({ workspaceId: f.workspaceId, operationId, fence: (await readWorkspace({ store: f.h.store, companyId: f.h.deps.companyId }, f.workspaceId))!.fence });
    expect(result.retentionId).toBeDefined();
    expect((await f.h.store.get(workspaceSessionKey(f.workspaceId)))?.["closeRetention"]).toMatchObject({ operationId, retained: { inspectionOperationId: operationId } });
    expect((await f.h.store.get(workspaceSessionKey(f.workspaceId)))?.["volumeId"]).toBe("vol-00000001");
  });
  it("a record an ACCEPTED close owns is never replaced: the check refuses and the record is as it was", async () => {
    const { f, operationId, fence } = await checkOver({ acceptedOperationId: randomUUID() });
    const before = await f.h.store.get(workspaceSessionKey(f.workspaceId));
    await expect(f.provider.inspectWorkspaceForClose({ workspaceId: f.workspaceId, operationId, fence })).rejects.toThrow(/another retention owns the session/u);
    expect(await f.h.store.get(workspaceSessionKey(f.workspaceId))).toEqual(before);
  });
});
