import { afterEach, describe, it } from "vitest";
import { CARRIER_GROUPS, carriersRunnable, runCarrierGroupLocally } from "../support/e2e-midstep-carriers.js";
import { expectCarrierGroup } from "../support/e2e-midstep-carriers-expect.js";

// The MIDSTEP-2 carrier test (CI option A) on this machine: the real executor, the pinned CLI, a real Chromium, the carrier fixture app and the worker's real model proxy answering from the
// scripted double. The Docker version of the same groups, in the real executor image, is tests/linux/e2e-midstep-carriers.test.ts; both judge a group with `expectCarrierGroup`.
// After the step's first model call one click makes the app acquire a session cookie, a local storage token, a session storage token, a JSON leaf token, a `?token=` URL, an Authorization-header
// call, an IndexedDB token and an opaque id under a neutral key; the page then shows one of them (or none) and the next model call is what the test is about. Skipped where the executor
// is not built (`tsc -b`) or no Chromium is installed.
const runs: Array<{ cleanup(): Promise<void> }> = [];
afterEach(async () => { await Promise.all(runs.splice(0).map((run) => run.cleanup())); });

describe.runIf(carriersRunnable)("a value the app acquires after the step's first model call never reaches the model", () => {
  for (const [index, group] of CARRIER_GROUPS.entries()) {
    it(`group ${String(index + 1)} (${group.join(", ")}): strong values are refused in any spelling, the weak one is masked as <session>, the control goes through`, async () => {
      const run = await runCarrierGroupLocally(group);
      runs.push(run);
      expectCarrierGroup(run);
    }, 400_000);
  }
});
