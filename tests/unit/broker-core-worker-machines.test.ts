import { describe, expect, it, vi } from "vitest";
import { brokerCoreWorkerMachines } from "../../packages/broker/src/aws/worker-machines/broker-core.js";
import { SessionWorkerFleet, sessionMachineId } from "../../packages/broker/src/aws/worker-machines/session-worker-machines.js";
import { COMPANY_A, COMPANY_B, TABLE, createSessionMachinesWorld } from "../support/session-machines-world.js";

function setup() {
  const world = createSessionMachinesWorld();
  const deps = brokerCoreWorkerMachines({ sessions: world.sessions, documentClient: world.db, tableName: TABLE });
  return { world, deps, fleet: new SessionWorkerFleet(deps) };
}

describe("broker worker operations", () => {

  it("fails closed on missing or malformed workspace company and malformed machine ids", async () => {
    const { world, fleet } = setup();
    const a = fleet.forCompany(COMPANY_A);
    for (const company of [undefined, "bad", 12, COMPANY_B]) {
      const workspace = world.workspace(COMPANY_A);
      await world.machinesFor(COMPANY_A).start({ companyId: COMPANY_A, machineKey: workspace });
      await world.settle();
      const meta = world.db.get(`WORKSPACE#${workspace}`, "META")!;
      world.db.set({ ...meta, companyId: company });
      await a.stop(sessionMachineId(workspace));
      expect((await a.health(sessionMachineId(workspace))).state).toBe("terminated");
    }
    for (const id of [null, undefined, 4, {}, "bad"]) {
      await a.stop(id as string);
      expect((await a.health(id as string)).state).toBe("terminated");
    }
    expect(world.executions.filter((execution) => execution.stateMachineArn.endsWith(":deleter"))).toEqual([]);
  });

  it("refuses start, signing and posting in fixed words before any read or execution", async () => {
    const { world, deps, fleet } = setup();
    const a = fleet.forCompany(COMPANY_A);
    const reads = vi.spyOn(world.db, "send");
    const words = "only the dispatcher starts workers and signs or posts worker jobs";
    for (const call of [
      () => a.start(null as never),
      () => a.start({ companyId: COMPANY_A, machineKey: world.workspace(COMPANY_A) }),
      () => a.deliver("secret-input", null as never),
      () => deps.sessions.ensureSession(null as never),
      () => deps.sign(Buffer.from("secret-input")),
      () => deps.post("secret-input", { authorization: "secret-input", body: "secret-input" }),
    ]) await expect(call()).rejects.toMatchObject({ code: "rejected", message: words });
    expect(world.executions).toEqual([]);
    expect(world.posts).toEqual([]);
    expect(reads).not.toHaveBeenCalled();
  });

  it("reads recorded lost states for the watchdog and refuses unknown live-worker facts", async () => {
    const { world, fleet, deps } = setup();
    const workspace = world.workspace(COMPANY_A, { activeOperationId: "op-running" });
    const machine = await world.machinesFor(COMPANY_A).start({ companyId: COMPANY_A, machineKey: workspace });
    await world.settle();
    await expect(fleet.forCompany(COMPANY_A).health(machine.machineId)).rejects.toMatchObject({ code: "unavailable", message: "live worker health is unavailable on the broker" });
    await expect(deps.ping("secret-input")).rejects.toMatchObject({ code: "unavailable", message: "live worker health is unavailable on the broker" });
    // A Stop keeps the volume: the session is STOPPING, then the reaper's ticks end the instance and it reads stopped. It never reads terminated, and the deleter never runs.
    const volumeId = (await world.sessions.get(workspace))!.volumeId;
    await fleet.forCompany(COMPANY_A).stop(machine.machineId);
    expect((await fleet.forCompany(COMPANY_A).health(machine.machineId)).state).toBe("stopping");
    await world.reap();
    await world.reap();
    expect((await fleet.forCompany(COMPANY_A).health(machine.machineId)).state).toBe("stopped");
    expect((await world.sessions.get(workspace))!.volumeId).toBe(volumeId);
    expect(world.executions.filter((execution) => execution.stateMachineArn.endsWith(":deleter"))).toEqual([]);
    // Only terminate (a Close) deletes: the deleter then gets the volume.
    await fleet.forCompany(COMPANY_A).terminate(machine.machineId);
    await world.settle();
    expect((await fleet.forCompany(COMPANY_A).health(machine.machineId)).state).toBe("terminated");
    expect(world.executions.filter((execution) => execution.stateMachineArn.endsWith(":deleter"))).toMatchObject([{ input: { workspaceId: workspace, volumeId } }]);
  });

  it("keeps the volume of a persistent machine: the broker adapter says so, and a stop with no running operation changes nothing", async () => {
    const { world, fleet } = setup();
    expect(fleet.capabilities.persistentVolume).toBe(true);
    expect(fleet.forCompany(COMPANY_A).capabilities.persistentVolume).toBe(true);
    const workspace = world.workspace(COMPANY_A);
    const machine = await world.machinesFor(COMPANY_A).start({ companyId: COMPANY_A, machineKey: workspace });
    await world.settle();
    await fleet.forCompany(COMPANY_A).stop(machine.machineId);
    expect((await world.sessions.get(workspace))!.state).toBe("READY");
  });
});

it("never echoes failures from workspace, session or deleter reads", async () => {
  const { world } = setup();
  const workspace = world.workspace(COMPANY_A, { activeOperationId: "op-running" });
  const machine = await world.machinesFor(COMPANY_A).start({ companyId: COMPANY_A, machineKey: workspace });
  await world.settle();
  const fail = async (): Promise<never> => { throw new Error("private-resource-canary"); };
  const sessions = (replace: Record<string, unknown>) => ({ sessions: { get: world.sessions.get.bind(world.sessions), deleteSession: world.sessions.deleteSession.bind(world.sessions), requestStop: world.sessions.requestStop.bind(world.sessions), ...replace } as never });
  const words = { code: "unavailable", message: "the broker could not read or cancel the worker session" };
  for (const [override, call] of [
    [{ documentClient: { send: fail } }, "stop"],
    [sessions({ get: fail }), "stop"],
    [sessions({ requestStop: fail }), "stop"],
    [{ documentClient: { send: fail } }, "terminate"],
    [sessions({ deleteSession: fail }), "terminate"],
  ] as const) {
    const deps = brokerCoreWorkerMachines({ ...{ sessions: world.sessions, documentClient: world.db, tableName: TABLE }, ...override });
    const a = new SessionWorkerFleet(deps).forCompany(COMPANY_A);
    await expect(a[call](machine.machineId)).rejects.toMatchObject(words);
  }
});
