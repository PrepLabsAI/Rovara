// CDK synth tests take more than 10 s under a loaded full gate (three gates hit it in phase 15e), so
// the default test timeout leaves room for them (final review M4).
import { readdirSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import config from "../../vitest.config.js";
import nativeP0Config from "../../vitest.native-p0.config.js";
import linuxConfig from "../../vitest.linux.config.js";
import nightlyConfig from "../../vitest.nightly.config.js";
import { moduleMockingFiles, nativeP0Files, nightlyOnlyFiles, postDeployFiles, sharedGroupNames, sharedModuleGroups } from "../support/vitest-shared-config.js";

describe("the test runner's configuration", () => {
  it("keeps the Linux Docker profile in one isolated project so CLI exclusions apply", () => {
    expect(linuxConfig.test?.projects).toBeUndefined();
    expect(linuxConfig.test?.include).toEqual(["tests/linux/**/*.test.ts"]);
    expect(linuxConfig.test?.isolate).toBe(true);
    expect(linuxConfig.test?.globalSetup).toEqual(config.test?.globalSetup);
    expect(linuxConfig.test?.testTimeout).toBe(config.test?.testTimeout);
  });

  it("gives every test, CDK synths included, 60 seconds", () => {
    expect(config.test?.testTimeout).toBe(60_000);
    // #1263: and every setup or teardown hook the same 60 seconds.
    expect(config.test?.hookTimeout).toBe(60_000);
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
    // #1256: and the 256 KiB hostile-file sweep, split from worker-env-detect-hardening (whose fast checks run in every run).
    expect(nightlyOnlyFiles).toContain("tests/unit/worker-env-detect-redos.test.ts");
    expect(nightlyOnlyFiles).not.toContain("tests/unit/worker-env-detect-hardening.test.ts");
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
    // #1272: and six more integration journeys.
    for (const file of [
      "tests/unit/stage-selection-adversarial.test.ts",
      "tests/integration/pull-request-publication.test.ts",
      "tests/integration/worker-verification.test.ts",
      "tests/unit/install-qualification-web.test.ts",
      "tests/contract/workflow-e2e-harness.test.ts",
      "tests/integration/pull-request-maintenance.test.ts",
    ]) expect(postDeployFiles).toContain(file);
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

  it("puts the files that mock modules, themselves or through a helper under tests/, in a fresh-modules project and every other file in one shared group", () => {
    type Project = { test?: { name?: string; include?: string[]; exclude?: string[]; isolate?: boolean } };
    const projects = (config.test?.projects ?? []) as Project[];
    expect(projects.map((project) => project.test?.name)).toEqual(["fresh-modules", ...sharedGroupNames]);
    for (const project of projects) expect(project.test?.isolate, project.test?.name).toBe(project.test?.name === "fresh-modules");
    const [fresh, ...shared] = projects as [Project, ...Project[]];
    expect(fresh.test?.include).toEqual(moduleMockingFiles);
    // A file that calls vi.mock itself, and one that mocks only through tests/support/core-context-world.ts.
    expect(moduleMockingFiles).toContain("tests/contract/core-admin-stop-company.test.ts");
    expect(moduleMockingFiles).toContain("tests/integration/core-context-routes.test.ts");
    expect(moduleMockingFiles).not.toContain("tests/unit/core-sqs-reflect-wiring.test.ts");
    // Every test file lands in exactly one project, and each shared group is the list sharedModuleGroups gives it.
    const testFiles = ["tests", "packages"].flatMap((directory) => readdirSync(directory, { recursive: true, encoding: "utf8" })
      .filter((path) => path.endsWith(".test.ts") && !path.split("/").some((part) => part === "node_modules" || part === "dist" || part.startsWith(".")))
      .map((path) => `${directory}/${path}`));
    const placed = projects.flatMap((project) => project.test?.include ?? []);
    expect([...placed].sort()).toEqual([...testFiles].sort());
    for (const project of shared) expect(project.test?.include).toEqual(sharedModuleGroups[project.test!.name as (typeof sharedGroupNames)[number]]);
    // A group is picked by the package a file loads; the broker's files split further by area.
    expect(sharedModuleGroups["broker-core"]).toContain("tests/unit/core-sqs-reflect-wiring.test.ts");
    expect(sharedModuleGroups.worker).toContain("tests/unit/worker-execution-target.test.ts");
  });
});
