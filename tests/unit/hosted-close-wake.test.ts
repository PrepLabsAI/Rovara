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
    ["STOPPED with a retention on it (ensureSession cannot start it)", { state: "STOPPED", closeRetention: { schemaVersion: 1 } }, "unsupported"],
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
