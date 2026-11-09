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
  it("refuses a machine beyond its capacity", async () => {
    const machines = new FakeWorkerMachines({ capabilities: { maxConcurrentMachines: 1 } });
    await machines.start({ machineKey: "a", companyId: "c" });
    await expect(machines.start({ machineKey: "b", companyId: "c" })).rejects.toMatchObject({ code: "unavailable", retryable: true });
  });
});
