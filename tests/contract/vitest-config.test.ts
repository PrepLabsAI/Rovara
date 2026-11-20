// CDK synth tests take more than 10 s under a loaded full gate (three gates hit it in phase 15e), so
// the default test timeout leaves room for them (final review M4).
import { readdirSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import config from "../../vitest.config.js";
import nativeP0Config from "../../vitest.native-p0.config.js";
import nightlyConfig from "../../vitest.nightly.config.js";
import { nativeP0Files, nightlyOnlyFiles, postDeployFiles } from "../support/vitest-shared-config.js";

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

  it("leaves the nightly-only tests out of `npm test` and runs them, and nothing else, in the nightly profile", () => {
    expect(nightlyOnlyFiles).toContain("tests/unit/eval-question-simulation.test.ts");
    // #1236: the detectors' growth check runs nightly, and in a pull request only when the change reaches it.
    expect(nightlyOnlyFiles).toContain("tests/unit/worker-env-detect-growth.test.ts");
    expect(nightlyOnlyFiles).toContain("tests/unit/local-up-flow.test.ts");
    // Every workflow-e2e suite, read from the folder, so a new one is nightly-only too.
    const workflowE2e = readdirSync("tests/integration/workflow-e2e").filter((name) => name.endsWith(".test.ts")).map((name) => `tests/integration/workflow-e2e/${name}`);
    expect(workflowE2e.length).toBeGreaterThan(10);
    expect(nightlyOnlyFiles).toEqual(expect.arrayContaining(workflowE2e));
    expect(config.test?.exclude).toEqual(expect.arrayContaining(nightlyOnlyFiles));
    expect(nightlyConfig.test?.include).toEqual([...nightlyOnlyFiles, ...postDeployFiles]);
    expect(nightlyConfig.test?.passWithNoTests).toBe(false);
    expect(nightlyConfig.test?.globalSetup).toEqual(config.test?.globalSetup);
  });

  // #1242: the integration journeys that belong after a beta environment never run on code merge, not even in an affected run.
  it("leaves the post-deploy journeys out of every pull request and push run, affected runs included, and runs them nightly", async () => {
    expect(postDeployFiles).toContain("tests/integration/slack-workflow-e2e.test.ts");
    expect(config.test?.exclude).toEqual(expect.arrayContaining(postDeployFiles));
    const previous = process.env.ROVARA_NIGHTLY_TESTS;
    process.env.ROVARA_NIGHTLY_TESTS = "1";
    try {
      vi.resetModules();
      const affected = (await import("../../vitest.config.js")).default;
      expect(affected.test?.exclude).toEqual(expect.arrayContaining(postDeployFiles));
      expect(affected.test?.exclude).not.toEqual(expect.arrayContaining(nightlyOnlyFiles));
    } finally {
      if (previous === undefined) delete process.env.ROVARA_NIGHTLY_TESTS; else process.env.ROVARA_NIGHTLY_TESTS = previous;
    }
    expect(nightlyConfig.test?.include).toEqual(expect.arrayContaining(postDeployFiles));
  });
});
