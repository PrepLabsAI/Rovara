// Port lane W0: the fake worker machines pass the worker-machines conformance suite.
import { randomUUID } from "node:crypto";
import { AGENTX_PROTOCOL_VERSION, WorkerInvocationSchema, type WorkerInvocation } from "@agentx/contracts";
import { describe, expect, it } from "vitest";
import { FakeWorkerMachines } from "../../packages/broker/src/ports/fake-worker-machines.js";
import { runWorkerMachinesConformance } from "../support/ports/worker-machines-conformance.js";

function invocation(operationId: string): WorkerInvocation {
  return WorkerInvocationSchema.parse({
    protocolVersion: AGENTX_PROTOCOL_VERSION,
    operationId,
    workspaceId: randomUUID(),
    fence: 1,
    projectRevision: 1,
    callbackCapability: "c".repeat(48),
    kind: "task",
    payload: { conversationId: randomUUID(), prompt: "make the change" },
  });
}

runWorkerMachinesConformance("fake", {
  async create() {
    return {
      machines: new FakeWorkerMachines({ startingChecks: 2 }),
      invocation,
      spec: (machineKey) => ({ machineKey, companyId: "org_aaaaaaaaaaaaaaaaaaaa" }),
    };
  },
});

describe("fake worker machines", () => {
  it("keeps two companies' machines with the same key apart", async () => {
    const machines = new FakeWorkerMachines();
    const one = await machines.start({ machineKey: "ws", companyId: "org_aaaaaaaaaaaaaaaaaaaa" });
    const two = await machines.start({ machineKey: "ws", companyId: "org_bbbbbbbbbbbbbbbbbbbb" });
    expect(one.machineId).not.toBe(two.machineId);
  });

  it("does not run a job again when it is delivered again after it finished", async () => {
    const machines = new FakeWorkerMachines({ startingChecks: 0 });
    const { machineId } = await machines.start({ machineKey: "a", companyId: "c" });
    await machines.health(machineId);
    const job = invocation("11111111-1111-4111-8111-111111111111");
    expect(await machines.deliver(machineId, job)).toEqual({ duplicate: false });
    machines.finish(machineId, job.operationId);
    expect(await machines.deliver(machineId, job)).toEqual({ duplicate: true });
  });

  it("refuses a machine beyond its capacity", async () => {
    const machines = new FakeWorkerMachines({ capabilities: { maxConcurrentMachines: 1 } });
    await machines.start({ machineKey: "a", companyId: "c" });
    await expect(machines.start({ machineKey: "b", companyId: "c" })).rejects.toMatchObject({ code: "unavailable", retryable: true });
  });
});
