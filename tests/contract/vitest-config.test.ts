// CDK synth tests take more than 10 s under a loaded full gate (three gates hit it in phase 15e), so
// the default test timeout leaves room for them (final review M4).
import { describe, expect, it } from "vitest";
import config from "../../vitest.config.js";
import nativeP0Config from "../../vitest.native-p0.config.js";
import { nativeP0Files } from "../support/vitest-shared-config.js";

describe("the test runner's configuration", () => {
  it("gives every test, CDK synths included, 60 seconds", () => {
    expect(config.test?.testTimeout).toBe(60_000);
  });

  it("keeps the three required contained P0 journeys in an explicit no-empty native profile", () => {
    expect(config.test?.exclude).toEqual(expect.arrayContaining(nativeP0Files));
    expect(nativeP0Config.test?.include).toEqual(nativeP0Files);
    expect(nativeP0Config.test?.passWithNoTests).toBe(false);
    expect(nativeP0Config.test?.globalSetup).toEqual(config.test?.globalSetup);
    expect(nativeP0Config.test?.testTimeout).toBe(config.test?.testTimeout);
  });
});
