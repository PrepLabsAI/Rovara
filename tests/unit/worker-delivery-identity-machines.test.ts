// WORKER-DELIVERY-IDENTITY (b-plus) on the core's machines adapter (aws/worker-machines/session-worker-machines.ts): its two requests to a worker, the /ping behind `health` and the POST behind `deliver`
// (which also carries a live steer and a peek), are each preceded by the machine check. A stale row whose address now answers as another workspace's machine gets neither.
import { describe, expect, it, vi } from "vitest";
import type { SessionWorkerPing } from "../../packages/broker/src/aws/worker-machines/session-worker-machines.js";
import { COMPANY_A, COMPANY_B, createSessionMachinesWorld, invocationFor } from "../support/session-machines-world.js";

async function readyMachine() {
  const world = createSessionMachinesWorld();
  const workspaceA = world.workspace(COMPANY_A);
  const workspaceB = world.workspace(COMPANY_B);
  const ping = vi.fn<(url: string) => Promise<SessionWorkerPing | undefined>>(async () => ({ status: "Healthy", activeOperations: 0, features: [] }));
  const post = vi.fn(async () => ({ status: 200, body: "{}" }));
  const machines = world.machinesFor(COMPANY_A, { ping, post });
  const machine = await machines.start({ machineKey: workspaceA, companyId: COMPANY_A });
  await world.settle();
  const session = (await world.sessions.get(workspaceA))!;
  expect(session).toMatchObject({ state: "READY" });
  return { world, machines, machine, workspaceA, workspaceB, session, ping, post };
}

/** The row's instance dies without the row hearing of it, and another workspace's new machine takes its address. */
function takeOver(fixture: Awaited<ReturnType<typeof readyMachine>>) {
  const { world, session, workspaceB } = fixture;
  world.instances.get(session.instanceId!)!.running = false;
  world.instances.set("i-0bbbbbbbbbbbbbbb2", { instanceId: "i-0bbbbbbbbbbbbbbb2", privateIp: session.privateIp!, workspaceId: workspaceB, generation: 1, running: true, accepted: new Set(), active: new Set() });
}

describe("the machines adapter before a request to a worker", () => {
  it("lets the session's own machine through: a ping for health, a POST for a job", async () => {
    const { machines, machine, workspaceA, ping, post, world } = await readyMachine();
    expect((await machines.health(machine.machineId)).state).toBe("ready");
    await machines.deliver(machine.machineId, invocationFor(workspaceA));
    expect(ping).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledOnce();
    expect(world.machineLog).toEqual([]);
  });

  it("sends no POST to a stale address that answers as another workspace's machine: the core is told the machine is gone, and the row is lost", async () => {
    const fixture = await readyMachine();
    const { machines, machine, workspaceA, post, world, session, workspaceB } = fixture;
    takeOver(fixture);
    await expect(machines.deliver(machine.machineId, invocationFor(workspaceA))).rejects.toMatchObject({ code: "not_found" });
    expect(post).not.toHaveBeenCalled();
    expect(world.posts).toEqual([]);
    expect(await world.sessions.get(workspaceA)).toMatchObject({ state: "STOPPED" });
    expect(world.machineLog).toEqual([expect.objectContaining({ event: "dispatch.machine_gone", reason: "not_running", expectedWorkspaceId: workspaceA, heldByWorkspaceId: workspaceB, expectedInstanceId: session.instanceId })]);
    // The core forgets the machine on not_found and starts another on its retry: the next start provisions a new generation, never reusing the address.
    await machines.start({ machineKey: workspaceA, companyId: COMPANY_A });
    expect(await world.sessions.get(workspaceA)).toMatchObject({ state: "PROVISIONING", generation: 2 });
  });

  it("sends no ping to it either: health answers stopped and never touches the address", async () => {
    const fixture = await readyMachine();
    const { machines, machine, ping, world } = fixture;
    takeOver(fixture);
    expect(await machines.health(machine.machineId)).toMatchObject({ state: "stopped", activeOperations: 0, features: [], detail: "the worker's machine is gone" });
    expect(ping).not.toHaveBeenCalled();
    expect(world.machineLog).toHaveLength(1);
  });

  it("gives a peek and a live steer no answer from a machine that is not the session's: nothing is posted, so nothing can be answered", async () => {
    const fixture = await readyMachine();
    const { machines, machine, workspaceA, post } = fixture;
    takeOver(fixture);
    const ask = (kind: "peek" | "steer") => machines.deliver(machine.machineId, { ...invocationFor(workspaceA), kind, payload: kind === "peek" ? { sessionId: "s", question: "what changed?" } : { sessionId: "s", text: "go on" } } as never);
    // The first asks EC2, finds the machine gone and marks the row lost; the second finds the row already STOPPED. Neither reaches the address.
    await expect(ask("peek")).rejects.toMatchObject({ code: "not_found" });
    await expect(ask("steer")).rejects.toMatchObject({ code: "not_ready" });
    expect(post).not.toHaveBeenCalled();
  });

  it("is a retryable `unavailable`, not 'gone', when EC2 cannot be asked: nothing sent, the row untouched", async () => {
    const world = createSessionMachinesWorld();
    const workspaceA = world.workspace(COMPANY_A);
    const post = vi.fn(async () => ({ status: 200, body: "{}" }));
    const ping = vi.fn(async (): Promise<SessionWorkerPing | undefined> => ({ status: "Healthy", features: [] }));
    const verifyMachine = vi.fn(async (): Promise<{ ok: true }> => { throw new Error("RequestLimitExceeded 111122223333"); });
    const machines = world.machinesFor(COMPANY_A, { post, ping, verifyMachine });
    const machine = await machines.start({ machineKey: workspaceA, companyId: COMPANY_A });
    await world.settle();
    const refused = await machines.deliver(machine.machineId, invocationFor(workspaceA)).catch((error: unknown) => error as Error);
    expect(refused).toMatchObject({ code: "unavailable" });
    expect((refused as Error).message).not.toContain("111122223333");
    await expect(machines.health(machine.machineId)).rejects.toMatchObject({ code: "unavailable" });
    expect(post).not.toHaveBeenCalled();
    expect(ping).not.toHaveBeenCalled();
    expect(await world.sessions.get(workspaceA)).toMatchObject({ state: "READY" });
  });

  it("asks for a session of this workspace only, with the row's instance, generation and address", async () => {
    const { world, workspaceA, session } = await readyMachine();
    const asked: unknown[] = [];
    const machines = world.machinesFor(COMPANY_A, { verifyMachine: async (machine) => { asked.push(machine); return { ok: true }; }, ping: async () => ({ status: "Healthy" }) });
    await machines.health(`ec2ws.${workspaceA}`);
    expect(asked).toEqual([{ kind: "workspace", workspaceId: workspaceA, generation: session.generation, instanceId: session.instanceId, privateIp: session.privateIp, subnetIds: [session.subnetId] }]);
  });
});
