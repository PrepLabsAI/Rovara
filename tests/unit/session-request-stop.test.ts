// STOP-NON-DESTRUCTIVE: SessionManager.requestStop (READY -> STOPPING for a person's Stop, fenced on the workspace's active operation in the same transaction) and what it needs around it:
// the reaper finishes the stop and keeps the volume, a Close inside the STOPPING window still deletes the volume (STOPPING -> DELETING), and the reaper survives that race.
// The real SessionManager, reaper handler and session-steps over the fake table; the provisioner and deleter state machines are played by timers (tests/support/session-machines-world.ts).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { COMPANY_A, createSessionMachinesWorld, type SessionMachinesWorld } from "../support/session-machines-world.js";

const OP = "7a1f0c52-3d4e-4b8a-9c11-2f6e5d4c3b21";

/** A READY session whose workspace runs operation OP. */
async function readyWithOperation(fields: Record<string, unknown> = { activeOperationId: OP }) {
  const world = createSessionMachinesWorld();
  const workspaceId = world.workspace(COMPANY_A, fields);
  await world.machinesFor(COMPANY_A).start({ machineKey: workspaceId, companyId: COMPANY_A });
  await world.settle();
  const session = (await world.sessions.get(workspaceId))!;
  expect(session.state).toBe("READY");
  return { world, workspaceId, session };
}

/** The reaper's STOPPING pass takes two ticks: the first ends the instance, the next sees it gone and marks the session STOPPED. */
async function reapTwice(world: SessionMachinesWorld) {
  await world.reap();
  return world.reap();
}
const deleterRuns = (world: SessionMachinesWorld) => world.executions.filter((execution) => execution.stateMachineArn.endsWith(":deleter"));
const setActiveOperation = (world: SessionMachinesWorld, workspaceId: string, activeOperationId: string | null) =>
  world.db.set({ ...world.db.get(`WORKSPACE#${workspaceId}`, "META")!, activeOperationId });

/** Runs `before` once, right before the first transaction the session manager sends (the gap between its read and its write). */
function inTheGap(world: SessionMachinesWorld, before: () => void): void {
  const send = world.db.send.bind(world.db);
  let done = false;
  (world.db as { send: unknown }).send = async (command: unknown) => {
    if (!done && command instanceof TransactWriteCommand) { done = true; before(); }
    return send(command as never);
  };
}

describe("requestStop: READY to STOPPING, only while the workspace still runs the operation it saw", () => {
  it("T7a claims a READY session whose workspace runs an operation; the instance and volume ids stay on the item", async () => {
    const { world, workspaceId, session } = await readyWithOperation();
    expect(await world.sessions.requestStop(workspaceId)).toBe(true);
    const after = (await world.sessions.get(workspaceId))!;
    expect(after).toMatchObject({ state: "STOPPING", generation: session.generation, volumeId: session.volumeId, instanceId: session.instanceId });
    expect(deleterRuns(world)).toEqual([]);
  });

  it("T7b is a no-op without a running operation (absent, null, or no workspace record): the idle rule takes the instance", async () => {
    for (const fields of [{}, { activeOperationId: null }]) {
      const { world, workspaceId } = await readyWithOperation(fields);
      expect(await world.sessions.requestStop(workspaceId)).toBe(false);
      expect((await world.sessions.get(workspaceId))!.state).toBe("READY");
    }
  });

  it("T7c a result that cleared the operation between the read and the write: no stop (ConditionCheck, M11)", async () => {
    const { world, workspaceId } = await readyWithOperation();
    inTheGap(world, () => setActiveOperation(world, workspaceId, null));
    expect(await world.sessions.requestStop(workspaceId)).toBe(false);
    expect((await world.sessions.get(workspaceId))!.state).toBe("READY");
  });

  it("T7d the next step took the workspace between the read and the write: no stop of the new step's instance (ConditionCheck on the value read, M11)", async () => {
    const { world, workspaceId } = await readyWithOperation();
    inTheGap(world, () => setActiveOperation(world, workspaceId, "op-next-step"));
    expect(await world.sessions.requestStop(workspaceId)).toBe(false);
    expect((await world.sessions.get(workspaceId))!.state).toBe("READY");
  });

  // CLOSE-RETENTION (the binding rebase item of STOP-NON-DESTRUCTIVE): a session held for a Close's retention is never claimed by a Stop, and no deleter path reaches it, in any state.
  /** The session item with a valid retention (or destroy) record on the volume it holds. */
  const retain = (world: SessionMachinesWorld, workspaceId: string, field: "closeRetention" | "closeDestroy", state?: string, holds: boolean = true) => {
    const row = world.db.get(`WORKSPACE#${workspaceId}`, "SESSION")!;
    const generation = { sessionGeneration: Number(row["generation"]), instanceId: String(row["instanceId"]), volumeId: String(row["volumeId"]), dataGeneration: randomUUID() };
    const retained = { inspectionOperationId: randomUUID(), inspectionFence: 2, retentionId: randomUUID(), contentDigest: "a".repeat(64), generation };
    const record = field === "closeRetention"
      ? { schemaVersion: 1, operationId: holds ? OP : randomUUID(), fence: 2, generation, retained }
      : { schemaVersion: 1, acceptedOperationId: randomUUID(), retention: retained, effectId: "terminate-1", machineIds: ["machine-1"] };
    // A STOPPED session has no instance or address (the schema says so).
    // The retention's preflight is the operation the workspace is held by (a live retention), or another one (a step took the workspace since).
    world.db.set({ ...world.db.get(`WORKSPACE#${workspaceId}`, "META")!, fence: 2 });
    const item: Record<string, unknown> = { ...row, ...(state === undefined ? {} : { state }), [field]: record };
    if (state === "STOPPED") { delete item["instanceId"]; delete item["privateIp"]; }
    world.db.set(item);
  };

  for (const field of ["closeRetention", "closeDestroy"] as const) {
    it(`T7r a READY session that carries ${field} is never claimed by a Stop: a no-op, not a throw, and the session is untouched`, async () => {
      const { world, workspaceId } = await readyWithOperation();
      retain(world, workspaceId, field);
      const before = world.db.get(`WORKSPACE#${workspaceId}`, "SESSION");
      expect(await world.sessions.requestStop(workspaceId)).toBe(false);
      expect(world.db.get(`WORKSPACE#${workspaceId}`, "SESSION")).toEqual(before);
      expect(deleterRuns(world)).toEqual([]);
    });
  }

  it("T7u a retention a step has superseded (the workspace is held by another operation than its preflight, the lift never landed) does not shield the instance from a Stop: the claim is made, the record and the volume are kept", async () => {
    const { world, workspaceId } = await readyWithOperation();
    retain(world, workspaceId, "closeRetention", undefined, false);
    const before = world.db.get(`WORKSPACE#${workspaceId}`, "SESSION")!;
    expect(await world.sessions.requestStop(workspaceId)).toBe(true);
    expect(world.db.get(`WORKSPACE#${workspaceId}`, "SESSION")).toMatchObject({ state: "STOPPING", closeRetention: before["closeRetention"], volumeId: before["volumeId"] });
    expect(deleterRuns(world)).toEqual([]);
  });
  it("T7v ... but never one an ACCEPTED close owns, superseded or not", async () => {
    const { world, workspaceId } = await readyWithOperation();
    retain(world, workspaceId, "closeRetention", undefined, false);
    const row = world.db.get(`WORKSPACE#${workspaceId}`, "SESSION")!;
    world.db.set({ ...row, closeRetention: { ...(row["closeRetention"] as object), acceptedOperationId: randomUUID() } });
    expect(await world.sessions.requestStop(workspaceId)).toBe(false);
  });

  it("T7s a retained session is never deleted from STOPPING, STOPPED or READY by the plain deleter: WORKSPACE_BUSY, no deleter execution, the volume stays", async () => {
    for (const state of ["READY", "STOPPING", "STOPPED"] as const) {
      const { world, workspaceId } = await readyWithOperation();
      const volumeBefore = world.db.get(`WORKSPACE#${workspaceId}`, "SESSION")!["volumeId"];
      retain(world, workspaceId, "closeRetention", state);
      await expect(world.sessions.deleteSession(workspaceId)).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
      expect(deleterRuns(world)).toEqual([]);
      expect(world.db.get(`WORKSPACE#${workspaceId}`, "SESSION")).toMatchObject({ state, volumeId: String(volumeBefore) });
    }
  });

  it("T7e two concurrent Stops: one claims, the other sees STOPPING and does nothing; neither throws", async () => {
    const { world, workspaceId } = await readyWithOperation();
    const results = await Promise.all([world.sessions.requestStop(workspaceId), world.sessions.requestStop(workspaceId)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await world.sessions.get(workspaceId))!.state).toBe("STOPPING");
  });

  it("T7f a session that moved to a new generation in the gap is claimed at the generation that is READY now (the operation still runs on it), never at the old one (M3)", async () => {
    const { world, workspaceId, session } = await readyWithOperation();
    const key = sessionKey(workspaceId);
    inTheGap(world, () => world.db.set({ ...world.db.get(key.pk, key.sk)!, generation: session.generation + 1 }));
    expect(await world.sessions.requestStop(workspaceId)).toBe(true);
    expect((await world.sessions.get(workspaceId))!).toMatchObject({ state: "STOPPING", generation: session.generation + 1 });
  });

  it("T7g STOPPING, STOPPED, FAILED, DELETING, NONE and DELETED sessions are left exactly as they are, no throw (M5, M8)", async () => {
    const dropInstance = ["instanceId", "privateIp", "launchedAt", "readyAt"];
    const shapes: Record<string, string[]> = { STOPPING: [], STOPPED: dropInstance, FAILED: dropInstance, DELETING: [], DELETED: dropInstance, NONE: [...dropInstance, "volumeId", "availabilityZone", "subnetId", "lastActivityAt", "workerFeatures", "instanceType", "executionArn"] };
    for (const [state, drop] of Object.entries(shapes)) {
      const { world, workspaceId } = await readyWithOperation();
      const key = sessionKey(workspaceId);
      const before = Object.fromEntries(Object.entries({ ...world.db.get(key.pk, key.sk)!, state, ...(state === "NONE" ? { generation: 0 } : {}) }).filter(([field]) => !drop.includes(field)));
      world.db.set(before);
      expect(await world.sessions.requestStop(workspaceId), state).toBe(false);
      expect(world.db.get(key.pk, key.sk), state).toEqual(before);
      expect(deleterRuns(world)).toEqual([]);
    }
  });

  it("T7h no session at all is a no-op", async () => {
    const world = createSessionMachinesWorld();
    expect(await world.sessions.requestStop(world.workspace(COMPANY_A, { activeOperationId: OP }))).toBe(false);
  });

  it("T7i a PROVISIONING session is refused (unavailable): the instance is not up yet (M4)", async () => {
    const world = createSessionMachinesWorld();
    world.provisionerHolds = true;
    const workspaceId = world.workspace(COMPANY_A, { activeOperationId: OP });
    await world.machinesFor(COMPANY_A).start({ machineKey: workspaceId, companyId: COMPANY_A });
    expect((await world.sessions.get(workspaceId))!.state).toBe("PROVISIONING");
    await expect(world.sessions.requestStop(workspaceId)).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
    world.provisionerHolds = false;
    await world.settle();
  });
});

describe("the reaper finishes a requested stop and keeps the volume", () => {
  it("T9b a STOPPING session with a live instance: the instance is ended, then STOPPED with the same volume, and no deleter ever runs", async () => {
    const { world, workspaceId, session } = await readyWithOperation();
    await world.sessions.requestStop(workspaceId);
    expect(world.instances.get(session.instanceId!)!.running).toBe(true);
    const report = await reapTwice(world);
    expect(report.stopped).toEqual([workspaceId]);
    expect(world.instances.get(session.instanceId!)!.running).toBe(false);
    const after = (await world.sessions.get(workspaceId))!;
    expect(after).toMatchObject({ state: "STOPPED", volumeId: session.volumeId });
    expect(after.instanceId).toBeUndefined();
    expect(deleterRuns(world)).toEqual([]);
  });

  it("T4a a STOPPED session is woken on a new generation on the SAME volume", async () => {
    const { world, workspaceId, session } = await readyWithOperation();
    await world.sessions.requestStop(workspaceId);
    await reapTwice(world);
    await world.machinesFor(COMPANY_A).start({ machineKey: workspaceId, companyId: COMPANY_A });
    await world.settle();
    const woken = (await world.sessions.get(workspaceId))!;
    expect(woken).toMatchObject({ state: "READY", generation: session.generation + 1, volumeId: session.volumeId });
    const provisions = world.executions.filter((execution) => execution.stateMachineArn.endsWith(":provisioner"));
    expect(provisions.at(-1)!.input).toMatchObject({ volumeId: session.volumeId });
  });
});

describe("T6b a Close inside the STOPPING window still deletes the volume", () => {
  it("deleteSession moves STOPPING to DELETING, with the volume id and the instance id in the deleter's input (M10)", async () => {
    const { world, workspaceId, session } = await readyWithOperation();
    await world.sessions.requestStop(workspaceId);
    expect(await world.sessions.deleteSession(workspaceId)).toEqual({ state: "DELETING" });
    await world.settle();
    const runs = deleterRuns(world);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.input).toEqual({ workspaceId, instanceId: session.instanceId, volumeId: session.volumeId });
    expect((await world.sessions.get(workspaceId))!.state).toBe("DELETED");
    expect(world.instances.get(session.instanceId!)!.running).toBe(false);
  });

  it("the reaper tick that finds the session already DELETING does not throw and does not mark it STOPPED", async () => {
    const { world, workspaceId } = await readyWithOperation();
    await world.sessions.requestStop(workspaceId);
    for (const instance of world.instances.values()) instance.running = false;
    // The reaper lists the STOPPING session, then the Close lands before its markStopped.
    const list = world.sessions.listByState.bind(world.sessions);
    world.sessions.listByState = async (state) => {
      const found = await list(state);
      if (state === "STOPPING") await world.sessions.deleteSession(workspaceId);
      return found;
    };
    await expect(world.reap()).resolves.toMatchObject({ stopped: [] });
    await world.settle();
    expect((await world.sessions.get(workspaceId))!.state).toBe("DELETED");
  });

  it("one session lost to a Close does not stop the reaper from finishing the others in the same tick", async () => {
    const { world, workspaceId: closed } = await readyWithOperation();
    const other = world.workspace(COMPANY_A, { activeOperationId: OP });
    await world.machinesFor(COMPANY_A).start({ machineKey: other, companyId: COMPANY_A });
    await world.settle();
    await world.sessions.requestStop(closed);
    await world.sessions.requestStop(other);
    for (const instance of world.instances.values()) instance.running = false;
    // The reaper lists both as STOPPING, then the Close lands on the first before its markStopped.
    const list = world.sessions.listByState.bind(world.sessions);
    world.sessions.listByState = async (state) => {
      const found = await list(state);
      if (state === "STOPPING") await world.sessions.deleteSession(closed);
      return found;
    };
    const report = await world.reap();
    expect(report.stopped).toEqual([other]);
    await world.settle();
    expect((await world.sessions.get(closed))!.state).toBe("DELETED");
    expect((await world.sessions.get(other))!.state).toBe("STOPPED");
  });
});

describe("review (Opus 204421204): the reaper's tolerance is for a Close's STALE_FENCE only", () => {
  it("any other failure of markStopped (a throttled or broken write) still fails the tick, so it is retried and alarmed, never logged as a Close", async () => {
    const { world, workspaceId } = await readyWithOperation();
    await world.sessions.requestStop(workspaceId);
    for (const instance of world.instances.values()) instance.running = false;
    world.sessions.markStopped = async () => { throw Object.assign(new Error("Rate of requests exceeds the allowed throughput."), { name: "ProvisionedThroughputExceededException" }); };
    await expect(world.reap()).rejects.toMatchObject({ name: "ProvisionedThroughputExceededException" });
    expect((await world.sessions.get(workspaceId))!.state).toBe("STOPPING");
  });
});

function sessionKey(workspaceId: string): { pk: string; sk: string } {
  return { pk: `WORKSPACE#${workspaceId}`, sk: "SESSION" };
}
