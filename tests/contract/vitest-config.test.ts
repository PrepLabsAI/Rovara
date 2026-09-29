// CDK synth tests take more than 10 s under a loaded full gate (three gates hit it in phase 15e), so
// the default test timeout leaves room for them (final review M4).
import { describe, expect, it } from "vitest";
import config from "../../vitest.config.js";

describe("the test runner's configuration", () => {
  it("gives every test, CDK synths included, 60 seconds", () => {
    expect(config.test?.testTimeout).toBe(60_000);
  });
});
