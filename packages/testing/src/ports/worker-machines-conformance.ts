// Port lane W0: the conformance suite every worker-machines adapter must pass (EC2, local Docker, this machine, the fake).
import { describe, expect, it } from "vitest";
import { MachineError, type MachineHealth, type MachineSpec, type WorkerInvocation, type WorkerMachines } from "@agentx/contracts";

export interface WorkerMachinesUnderTest {
  machines: WorkerMachines;
  /** A valid invocation with this operation id (a uuid). */
  invocation(operationId: string): WorkerInvocation;
  /** What to start. The harness may add the image or sizes its adapter needs. */
  spec(machineKey: string): MachineSpec;
  /** Gives the machine time to change state (the fake does nothing; a real adapter waits). */
  settle?: () => Promise<void>;
  dispose?: () => Promise<void>;
  /**
   * True for an adapter whose real worker may finish (or refuse) the test's job before `health` is asked, so a busy count of at
   * least one cannot be expected. The fake keeps a job until `finish`; a real worker does not.
   */
  jobsMayFinishAtOnce?: boolean;
  /**
   * The same backend as a second company starts machines on it. An adapter that serves several companies passes it, so the suite checks that
   * one company's machine key never reaches another company's machine. When `machines` is a separate object (an adapter made for one
   * company), the suite also checks that the other company cannot ask about, stop, end or hand a job to this company's machine by its id.
   */
  otherCompany?: { machines: WorkerMachines; spec(machineKey: string): MachineSpec };
}
export interface WorkerMachinesHarness {
  create(): Promise<WorkerMachinesUnderTest>;
}

async function ready(under: WorkerMachinesUnderTest, machineId: string): Promise<MachineHealth> {
  let health = await under.machines.health(machineId);
  for (let attempt = 0; attempt < 600 && health.state !== "ready" && health.state !== "busy"; attempt += 1) {
    if (health.state === "unhealthy" || health.state === "terminated") throw new Error(`the machine became ${health.state}`);
    await under.settle?.();
    await new Promise((resolve) => setTimeout(resolve, 5));
    health = await under.machines.health(machineId);
  }
  expect(["ready", "busy"]).toContain(health.state);
  return health;
}

export function runWorkerMachinesConformance(name: string, harness: WorkerMachinesHarness): void {
  async function withMachines<T>(body: (under: WorkerMachinesUnderTest) => Promise<T>): Promise<T> {
    const under = await harness.create();
    try {
      return await body(under);
    } finally {
      await under.dispose?.();
    }
  }
  const OP1 = "11111111-1111-4111-8111-111111111111";
  const OP2 = "22222222-2222-4222-8222-222222222222";

  describe(`worker machines conformance: ${name}`, () => {
    it("says what it can do", () => withMachines(async ({ machines }) => {
      expect(["vm", "container", "none"]).toContain(machines.capabilities.isolation);
      expect(typeof machines.capabilities.persistentVolume).toBe("boolean");
      expect(typeof machines.capabilities.canStop).toBe("boolean");
      expect(machines.capabilities.maxConcurrentMachines === null || machines.capabilities.maxConcurrentMachines >= 1).toBe(true);
    }));

    it("starts a machine that becomes ready, and starting the same key again returns the same machine", () => withMachines(async (under) => {
      const first = await under.machines.start(under.spec("ws-1"));
      expect(first.machineKey).toBe("ws-1");
      expect(["starting", "ready"]).toContain(first.state);
      const again = await under.machines.start(under.spec("ws-1"));
      expect(again.machineId).toBe(first.machineId);
      const health = await ready(under, first.machineId);
      expect(health.activeOperations).toBe(0);
      expect(new Date(health.checkedAt).toString()).not.toBe("Invalid Date");
      expect(Array.isArray(health.features)).toBe(true);
      await under.machines.terminate(first.machineId);
    }));

    it("accepts a job on a ready machine, once per operation id", () => withMachines(async (under) => {
      const { machineId } = await under.machines.start(under.spec("ws-2"));
      await ready(under, machineId);
      expect(await under.machines.deliver(machineId, under.invocation(OP1))).toEqual({ duplicate: false });
      expect(await under.machines.deliver(machineId, under.invocation(OP1))).toEqual({ duplicate: true });
      expect(await under.machines.deliver(machineId, under.invocation(OP2))).toEqual({ duplicate: false });
      const after = await under.machines.health(machineId);
      if (under.jobsMayFinishAtOnce === true) {
        // The job may already be done, but the answer must still be consistent: busy exactly when something is active.
        expect(["ready", "busy"]).toContain(after.state);
        expect(after.state === "busy").toBe(after.activeOperations > 0);
      } else {
        expect(after.activeOperations).toBeGreaterThanOrEqual(1);
      }
      await under.machines.terminate(machineId);
    }));

    it("refuses a job for a machine that is not there or is stopped, with the code that says why", () => withMachines(async (under) => {
      await expect(under.machines.deliver("no-such-machine", under.invocation(OP1))).rejects.toMatchObject({ name: "MachineError", code: "not_found" });
      const { machineId } = await under.machines.start(under.spec("ws-3"));
      await ready(under, machineId);
      if (under.machines.capabilities.canStop) {
        await under.machines.stop(machineId);
        await under.settle?.();
        const error = await under.machines.deliver(machineId, under.invocation(OP1)).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(MachineError);
        expect((error as MachineError).code).toBe("not_ready");
        expect((error as MachineError).retryable).toBe(true);
      }
      await under.machines.terminate(machineId);
    }));

    it("stops a machine and starts it again by its key", () => withMachines(async (under) => {
      if (!under.machines.capabilities.canStop) return;
      const { machineId } = await under.machines.start(under.spec("ws-4"));
      await ready(under, machineId);
      await under.machines.stop(machineId);
      await under.machines.stop(machineId);
      let health = await under.machines.health(machineId);
      for (let attempt = 0; attempt < 600 && health.state !== "stopped"; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        health = await under.machines.health(machineId);
      }
      expect(health.state).toBe("stopped");
      const woken = await under.machines.start(under.spec("ws-4"));
      expect(woken.machineKey).toBe("ws-4");
      await ready(under, woken.machineId);
      await under.machines.terminate(woken.machineId);
    }));

    it("keeps another company's machine with the same key apart, and never lets that company reach this one", () => withMachines(async (under) => {
      const other = under.otherCompany;
      if (other === undefined) return;
      const mine = await under.machines.start(under.spec("ws-6"));
      const theirs = await other.machines.start(other.spec("ws-6"));
      expect(theirs.machineId).not.toBe(mine.machineId);
      await ready(under, mine.machineId);
      await other.machines.terminate(theirs.machineId);
      if (other.machines !== under.machines) {
        // An adapter made for one company: this company's machine is, to the other company, a machine that does not exist.
        expect((await other.machines.health(mine.machineId)).state).toBe("terminated");
        await other.machines.stop(mine.machineId);
        await other.machines.terminate(mine.machineId);
        await expect(other.machines.deliver(mine.machineId, under.invocation(OP1))).rejects.toMatchObject({ name: "MachineError", code: "not_found" });
        await under.settle?.();
      }
      expect(["ready", "busy"]).toContain((await under.machines.health(mine.machineId)).state);
      await under.machines.terminate(mine.machineId);
    }));

    it("terminates a machine for good, as often as asked, and answers health for one that is gone", () => withMachines(async (under) => {
      const { machineId } = await under.machines.start(under.spec("ws-5"));
      await ready(under, machineId);
      await under.machines.terminate(machineId);
      await under.machines.terminate(machineId);
      let health = await under.machines.health(machineId);
      for (let attempt = 0; attempt < 600 && health.state !== "terminated"; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        health = await under.machines.health(machineId);
      }
      expect(health.state).toBe("terminated");
      expect((await under.machines.health("never-existed")).state).toBe("terminated");
      await under.machines.stop("never-existed");
      await under.machines.terminate("never-existed");
    }));
  });
}
