// vitest: fresh-modules
// #1341: setup-network.ts → task-sandbox.ts → model-helper-block.ts → run-network.ts → setup-network.ts is an import cycle. When setup-network.ts loaded first, run-network.ts read setup-network.ts's slot count before it was set, so
// RUN_NETWORK_SLOTS was undefined and every model helper address was refused (worker-eval-services.test.ts failed at load in shared-module shards). This file needs a fresh module graph so setup-network.ts really loads first.
import { expect, it } from "vitest";

it("the run network slot count and the model helper's address survive setup-network.ts loading first", async () => {
  const { SETUP_NETWORK_SLOTS } = await import("../../packages/worker/src/setup-network.js");
  const { RUN_NETWORK_SLOTS } = await import("../../packages/worker/src/run-network.js");
  const { freshEvalModelBlock } = await import("../../packages/worker/src/verification/eval-bridged-exec.js");
  expect(RUN_NETWORK_SLOTS).toBe(SETUP_NETWORK_SLOTS);
  expect(SETUP_NETWORK_SLOTS).toBe(253);
  expect(freshEvalModelBlock("172.30.7.9").address).toBe("172.30.7.9");
});
