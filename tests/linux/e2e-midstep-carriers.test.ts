import { afterAll, describe, expect, it } from "vitest";
import { CARRIER_GROUPS } from "../support/e2e-midstep-carriers.js";
import { expectCarrierGroup } from "../support/e2e-midstep-carriers-expect.js";
import { removeCarrierDirs, runCarrierGroupInDocker } from "../support/linux-carriers.js";

// MIDSTEP-2, CI option A: a value the app acquires AFTER the step's first model call never reaches the model. The production Docker host runs the carrier fixture app
// (tests/fixtures/e2e-midstep-carriers) and the real executor image with real Chromium; the worker's real model session answers from the scripted double and records every call. After the
// first call one click makes the app acquire a Set-Cookie session cookie, a local storage token, a session storage token, a JSON leaf token, a `?token=` URL, an Authorization-header call, an
// IndexedDB token and one opaque id under a neutral key. The page then shows one of them (or none), and the call that follows is judged on the recorded transcripts and on the calls the
// provider received:
// - a strong value (cookie, local, session, json, url, bearer, idb) never appears, plain, percent-encoded, double percent-encoded or base64; the step ends right after its one ok call;
// - the weak id appears as `<session>` and never as itself, and does not end the run `credential-leak`;
// - a control case that shows nothing secret gets its second call through, so a refusal in the others is about what the page shows;
// - no transcript is truncated (`omitted` absent on every answered call).
// The values are generated at random for each run, reach the app through a file in a temp directory (the owned mount) and are written nowhere else. The route allows three agent steps in a
// group, so the nine cases run as three groups. The same groups run, without Docker, in tests/unit/e2e-midstep-carriers-run.test.ts. It runs only in CI's `linux-runtime` job (ubuntu-24.04-arm,
// ROVARA_DOCKER=1, ROVARA_EXECUTOR_IMAGE); everywhere else it skips.
describe.runIf(process.platform === "linux" && process.env.ROVARA_DOCKER === "1")("mid-step values never reach the model, on a real Docker host", () => {
  afterAll(removeCarrierDirs, 120_000);

  for (const [index, group] of CARRIER_GROUPS.entries()) {
    it(`group ${String(index + 1)} (${group.join(", ")}): strong values are refused in any spelling, the weak one is masked as <session>, the control goes through`, async () => {
      const run = await runCarrierGroupInDocker(group);
      expect(run.exitCode, run.why()).not.toBeNull();
      expectCarrierGroup(run);
      // The host's own predicate over every byte of the run's out directory: no account credential of the run.
      expect(run.credentialsLeaked, run.why()).toBe(false);
    }, 600_000);
  }
});
