// Engine host (lane E2, step 4): Code's EC2 workspace sessions on the core's worker-machines port, with no AWS: the real SessionManager over the fake table, the session state machines
// played by timers, and a worker per instance that checks every invoke token with the worker's own verifier (tests/support/session-machines-world.ts).
// Proves: the port's conformance suite (with a second company on the same fleet); a company's adapter never reaches another company's workspace, or a workspace without a valid company;
// the fleet itself answers nothing; a missing placement brings the job back.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { MachineError, type OrgId, type WorkerMachines } from "@agentx/contracts";
import { runWorkerMachinesConformance } from "../support/ports/worker-machines-conformance.js";
import { COMPANY_A, COMPANY_B, TABLE, createSessionMachinesWorld, invocationFor } from "../support/session-machines-world.js";
import { FLEET_UNBOUND_WORDS, SessionWorkerFleet, SessionWorkerMachines, sessionMachineId } from "../../packages/broker/src/aws/worker-machines/session-worker-machines.js";
import { workspaceCompanyReader } from "../../packages/broker/src/aws/worker-machines/workspace-company.js";

/** The suite names machines with short keys (`ws-1`); a session machine is keyed by its workspace id, so each key gets a workspace of the key's company. */
function keyedWorkspaces(world: ReturnType<typeof createSessionMachinesWorld>, company: OrgId) {
  const workspaces = new Map<string, string>();
  return (machineKey: string): string => {
    let workspaceId = workspaces.get(machineKey);
    if (workspaceId === undefined) {
      workspaceId = world.workspace(company);
      workspaces.set(machineKey, workspaceId);
    }
    return workspaceId;
  };
}

runWorkerMachinesConformance("EC2 workspace sessions (Code's AWS deployment)", {
  async create() {
    const world = createSessionMachinesWorld();
    const ofA = keyedWorkspaces(world, COMPANY_A);
    const ofB = keyedWorkspaces(world, COMPANY_B);
    return {
      machines: world.machinesFor(COMPANY_A, { workspaceOfKey: ofA }),
      // An invocation is for the workspace of the machine it is delivered to: the suite delivers to `ws-2` only.
      invocation: (operationId: string) => invocationFor(ofA("ws-2"), operationId),
      spec: (machineKey: string) => ({ machineKey, companyId: COMPANY_A }),
      settle: () => world.settle(),
      dispose: () => world.settle(),
      otherCompany: { machines: world.machinesFor(COMPANY_B, { workspaceOfKey: ofB }), spec: (machineKey: string) => ({ machineKey, companyId: COMPANY_B }) },
    };
  },
});

describe("Code's EC2 session machines, company by company", () => {
  it("refuses to deliver one workspace's invocation to another workspace's machine", async () => {
    const world = createSessionMachinesWorld();
    const machines = world.machinesFor(COMPANY_A);
    const machineWorkspaceId = world.workspace(COMPANY_A);
    const otherWorkspaceId = world.workspace(COMPANY_A);
    const machine = await machines.start({ machineKey: machineWorkspaceId, companyId: COMPANY_A });
    await world.settle();

    await expect(machines.deliver(machine.machineId, invocationFor(otherWorkspaceId))).rejects.toMatchObject({ code: "rejected" });
    expect(world.posts).toEqual([]);
  });

  it("never starts, stops, ends, asks about or hands a job to another company's workspace, and tells it apart from no workspace at all only by nothing", async () => {
    const world = createSessionMachinesWorld();
    const ofB = world.workspace(COMPANY_B);
    const a = world.machinesFor(COMPANY_A);
    const b = world.machinesFor(COMPANY_B);
    const started = await b.start({ machineKey: ofB, companyId: COMPANY_B });
    await world.settle();
    expect((await b.health(started.machineId)).state).toBe("ready");

    // A start of B's workspace through A's adapter, with A's company or B's in the spec: refused, the same words as a workspace that does not exist.
    const missing = await a.start({ machineKey: randomUUID(), companyId: COMPANY_A }).catch((error: unknown) => error);
    const foreign = await a.start({ machineKey: ofB, companyId: COMPANY_A }).catch((error: unknown) => error);
    expect(foreign).toBeInstanceOf(MachineError);
    expect((foreign as MachineError).message).toBe((missing as MachineError).message);
    await expect(a.start({ machineKey: ofB, companyId: COMPANY_B })).rejects.toMatchObject({ code: "rejected" });

    // Asked by id: B's machine does not exist for A.
    expect((await a.health(started.machineId)).state).toBe("terminated");
    await expect(a.deliver(started.machineId, invocationFor(ofB))).rejects.toMatchObject({ code: "not_found" });
    await a.stop(started.machineId);
    await a.terminate(started.machineId);
    await world.settle();
    expect(world.posts).toEqual([]);
    expect(world.executions.filter((execution) => execution.stateMachineArn.endsWith(":deleter"))).toEqual([]);
    expect((await b.health(started.machineId)).state).toBe("ready");
  });

  it("treats a workspace whose record names no valid company, or two different ones, as nobody's", async () => {
    const world = createSessionMachinesWorld();
    const a = world.machinesFor(COMPANY_A);
    for (const fields of [{ companyId: undefined, orgId: COMPANY_A }, { companyId: "acme" }, { orgId: COMPANY_B }, { companyId: 7 }]) {
      const workspaceId = world.workspace(COMPANY_A, fields);
      await expect(a.start({ machineKey: workspaceId, companyId: COMPANY_A })).rejects.toMatchObject({ code: "rejected" });
    }
    // A record with no company at all: no install-wide company stands in for it (one Code install serves every company).
    const bare = world.workspace(undefined);
    await expect(a.start({ machineKey: bare, companyId: COMPANY_A })).rejects.toMatchObject({ code: "rejected" });
    expect(world.executions).toEqual([]);
    // Positive control: the same adapter starts a workspace of its own company.
    const own = world.workspace(COMPANY_A);
    await expect(a.start({ machineKey: own, companyId: COMPANY_A })).resolves.toMatchObject({ machineId: sessionMachineId(own) });
    expect(world.executions).toHaveLength(1);
  });

  it("answers nothing through the fleet itself: only a company's adapter acts, and a malformed company id is refused", async () => {
    const world = createSessionMachinesWorld();
    const fleet = world.fleet();
    // Called through the port, as a holder that forgot to bind it would.
    const port: WorkerMachines = fleet;
    const workspaceId = world.workspace(COMPANY_A);
    for (const call of [
      () => port.start({ machineKey: workspaceId, companyId: COMPANY_A }), () => port.stop(sessionMachineId(workspaceId)), () => port.terminate(sessionMachineId(workspaceId)),
      () => port.health(sessionMachineId(workspaceId)), () => port.deliver(sessionMachineId(workspaceId), invocationFor(workspaceId)),
    ]) await expect(call()).rejects.toMatchObject({ code: "rejected", message: FLEET_UNBOUND_WORDS });
    expect(world.executions).toEqual([]);
    for (const bad of ["", "acme", "org_A", undefined as unknown as string]) expect(() => fleet.forCompany(bad)).toThrow(MachineError);
    const deps = { companyOfWorkspace: async () => undefined } as unknown as ConstructorParameters<typeof SessionWorkerMachines>[0];
    expect(() => new SessionWorkerMachines({ ...deps, companyId: "nobody" })).toThrow(MachineError);
    // One adapter per company, kept.
    expect(fleet.forCompany(COMPANY_A)).toBe(fleet.forCompany(COMPANY_A));
    expect(fleet.forCompany(COMPANY_A)).not.toBe(fleet.forCompany(COMPANY_B));
    expect(fleet).toBeInstanceOf(SessionWorkerFleet);
  });

  it("refuses a spec that chooses what the worker runs: the launch template alone says", async () => {
    const world = createSessionMachinesWorld();
    const a = world.machinesFor(COMPANY_A);
    const workspaceId = world.workspace(COMPANY_A);
    for (const extra of [{ image: "ami-0123" }, { resources: { cpu: 64 } }, { environment: { AWS_ACCESS_KEY_ID: "x" } }]) {
      await expect(a.start({ machineKey: workspaceId, companyId: COMPANY_A, ...extra })).rejects.toMatchObject({ code: "rejected" });
    }
    expect(world.executions).toEqual([]);
  });
});

describe("whose a workspace is", () => {
  it("requires the pointer's scoped workspace, with the same company on every read", async () => {
    const world = createSessionMachinesWorld();
    const id = randomUUID();
    const key = { pk: `ORG#${COMPANY_A}#WORKSPACE#${id}`, sk: "META" };
    world.db.set({ pk: `WORKSPACE#${id}`, sk: "META", entityType: "WORKSPACE_COMPANY_POINTER", workspaceId: id, companyId: COMPANY_A });
    const companyOf = workspaceCompanyReader(world.db, TABLE);
    const integrity = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await companyOf(id)).toBeUndefined();
    expect(integrity.mock.calls).toEqual([[{ component: "broker", event: "workspace.pointer_integrity" }]]);
    integrity.mockClear();
    world.db.set({ ...key, entityType: "WORKSPACE", id, companyId: COMPANY_B });
    expect(await companyOf(id)).toBeUndefined();
    expect(integrity.mock.calls).toEqual([[{ component: "broker", event: "workspace.pointer_integrity" }]]);
    integrity.mockClear();
    world.db.set({ ...key, entityType: "WORKSPACE", id, companyId: COMPANY_A, orgId: COMPANY_B });
    expect(await companyOf(id)).toBeUndefined();
    world.db.set({ ...key, entityType: "WORKSPACE", id, companyId: COMPANY_A, orgId: COMPANY_A });
    expect(await companyOf(id)).toBe(COMPANY_A);
    world.db.set({ ...key, entityType: "WORKSPACE", id, companyId: COMPANY_B });
    expect(await companyOf(id)).toBeUndefined();
    integrity.mockRestore();
  });
  it("reads the company from the workspace record only", async () => {
    const world = createSessionMachinesWorld();
    const companyOf = workspaceCompanyReader(world.db, TABLE);
    expect(await companyOf(world.workspace(COMPANY_A))).toBe(COMPANY_A);
    expect(await companyOf(randomUUID())).toBeUndefined();
    expect(await companyOf(world.workspace(COMPANY_A, { orgId: COMPANY_B }))).toBeUndefined();
  });

  it("brings a job back (never ends the task) when the install has no worker placement: a configuration fault, not the job's", async () => {
    const world = createSessionMachinesWorld();
    const a = world.machinesFor(COMPANY_A, { binding: async () => undefined });
    await expect(a.start({ machineKey: world.workspace(COMPANY_A), companyId: COMPANY_A })).rejects.toMatchObject({ code: "unavailable" });
    expect(world.executions).toEqual([]);
  });
});
