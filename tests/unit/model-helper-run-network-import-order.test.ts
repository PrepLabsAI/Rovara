// The run network's constants must not depend on which module a worker process loads first (the Linux job's shared-module worker project runs many files in one process, so the load order is whatever an earlier file left).
// The cycle is setup-network -> task-sandbox -> model-helper-block -> run-network -> setup-network. Under Vitest a module that is reached while it is still loading gives the importer `undefined` for a name it has not defined yet (native ESM would throw), so
// `RUN_NETWORK_SLOTS = SETUP_NETWORK_SLOTS` once became `undefined` when setup-network.ts was the first of the four to load; `isModelHelperAddress` then refused every helper address ("not the model helper's address for the model host block").
import { describe, expect, it, vi } from "vitest";

const loaders: Record<string, () => Promise<unknown>> = {
  "setup-network": () => import("../../packages/worker/src/setup-network.js"),
  "task-sandbox": () => import("../../packages/worker/src/task-sandbox.js"),
  "model-helper-block": () => import("../../packages/worker/src/model-helper-block.js"),
  "run-network": () => import("../../packages/worker/src/run-network.js"),
  "model-helper-network": () => import("../../packages/worker/src/model-helper-network.js"),
};

describe("run network constants and load order", () => {
  for (const first of Object.keys(loaders)) {
    it(`a helper address of slot 1, 7 and 253 is accepted, 0 and 254 refused, when ${first} loads first`, async () => {
      vi.resetModules();
      await loaders[first]!();
      const { isModelHelperAddress } = await import("../../packages/worker/src/model-helper-block.js");
      const { RUN_NETWORK_SLOTS, runNetworkModelHelperIp } = await import("../../packages/worker/src/run-network.js");
      const { SETUP_NETWORK_SLOTS } = await import("../../packages/worker/src/setup-network.js");
      expect(RUN_NETWORK_SLOTS).toBe(SETUP_NETWORK_SLOTS);
      for (const slot of [1, 7, 253]) expect(isModelHelperAddress(runNetworkModelHelperIp(slot))).toBe(true);
      expect(isModelHelperAddress("172.30.254.9")).toBe(false);
      expect(isModelHelperAddress("172.30.0.9")).toBe(false);
      expect(isModelHelperAddress("172.30.5.10")).toBe(false);
    });
  }
});
