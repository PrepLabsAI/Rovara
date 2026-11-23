// CLOSE-RETENTION: the dispatcher's wake of a stopped machine, and the session-item reading of what a check needs. Every machine and session here is a fake port, NOT machine proof: that a real stopped instance
// starts on its kept volume and is inspected is proven only by the Linux grid and the real calls after install. What is pinned: a wake only ever STARTS (never stops, terminates or deletes), it starts only a
// session that is stopped, stopping or already starting, and a session that is not there or is being deleted is never started again.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CLOSE_RETENTION_FEATURE, workspaceSessionKey, type MachineHealth, type WorkerMachines, type WorkspaceSession } from "@agentx/contracts";
import { closeAvailability, createBrokerCloseInspection, createDispatcherCloseInspection } from "../../packages/broker/src/aws/worker-machines/close-retention.js";
import { sessionMachineId } from "../../packages/broker/src/aws/worker-machines/session-worker-machines.js";
import { createHarness } from "../support/task-flow-harness.js";

async function fixture(session: Partial<WorkspaceSession> | undefined, startState: "ready" | "provisioning" = "provisioning") {
  const h = createHarness(); await h.registerProject();
  const { task } = await h.flow.start(h.owner, { requestId: randomUUID(), project: "payments", instructions: "wake me" });
  const workspaceId = task.workspaceId;
  const raw = session === undefined ? undefined : { workspaceId, generation: 2, ...session };
  const full = raw as unknown as WorkspaceSession | undefined;
  if (raw !== undefined) await h.store.put({ item: { ...workspaceSessionKey(workspaceId), entityType: "WORKSPACE_SESSION", ...(JSON.parse(JSON.stringify(raw)) as Record<string, never>) } });
  const health: MachineHealth = { state: "ready", activeOperations: 0, features: [CLOSE_RETENTION_FEATURE], checkedAt: "2026-11-23T00:00:00.000Z", workspaceDataIdentity: { sessionGeneration: 2, instanceId: "i-1", volumeId: "vol-1", dataGeneration: randomUUID() } };
  const machines = { start: vi.fn(async () => ({ machineId: sessionMachineId(workspaceId), machineKey: workspaceId, state: startState })), stop: vi.fn(), terminate: vi.fn(), health: vi.fn(async () => health), deliver: vi.fn() };
  const deleteSession = vi.fn();
  const provider = createDispatcherCloseInspection({ store: h.store, companyId: h.deps.companyId, machines: machines as unknown as WorkerMachines, sessions: { get: async () => full, deleteSession } as never });
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
    const f = await fixture({ state: "READY", instanceId: "i-1", volumeId: "vol-1" });
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
    const old = { sessionGeneration: 1, instanceId: "i-old", volumeId: "vol-1", dataGeneration: randomUUID() };
    const retained = { inspectionOperationId: randomUUID(), inspectionFence: 2, retentionId: randomUUID(), contentDigest: "a".repeat(64), generation: old };
    const closeRetention = { schemaVersion: 1, operationId: retained.inspectionOperationId, fence: 2, generation: old, retained };
    // The session is READY again on a NEW instance and generation, on the SAME volume; the retention record is still the old one.
    const f = await fixture({ state: "READY", generation: 2, instanceId: "i-new", volumeId: "vol-1", privateIp: "10.0.0.2", closeRetention } as never);
    const health: MachineHealth = { state: "ready", activeOperations: 0, features: [CLOSE_RETENTION_FEATURE], checkedAt: "2026-11-23T00:00:00.000Z", workspaceDataIdentity: { sessionGeneration: 2, instanceId: "i-new", volumeId: "vol-1", dataGeneration: old.dataGeneration } };
    return { f, retained, health };
  }
  it("a step that supersedes the retention removes it (the work can run; only a later Close sees a fresh check)", async () => {
    const { f, retained, health } = await woken();
    await f.provider.noteRuntime!(f.workspaceId, health, { supersedesRetention: retained } as never);
    expect((await f.h.store.get(workspaceSessionKey(f.workspaceId)))?.["closeRetention"]).toBeUndefined();
    expect((await f.h.store.get(workspaceSessionKey(f.workspaceId)))?.["volumeId"]).toBe("vol-1");
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
