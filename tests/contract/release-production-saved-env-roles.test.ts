// The production release wiring of the legacy saved environment roles switch (AGENTX_LEGACY_SAVED_ENV_ROLES), driven through releaseProduction with a fake runner:
//   - a bad value is refused before anything runs, even on a dry run;
//   - the revert guard reads the deployed control plane (describe-stacks only) and refuses before the git checks, the worker build and push, and any deploy.
// The pure helpers are unit tested in legacy-saved-env-role-path.test.ts; this file pins that releaseProduction actually calls them, and in which order.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type * as ReleaseCommon from "../../scripts/release-common.js";

const recorded = vi.hoisted(() => ({
  calls: [] as string[][],
  controlPlaneOutputs: [] as Array<{ OutputKey: string; OutputValue: string }>,
}));

vi.mock("../../scripts/release-common.js", async (importOriginal) => {
  const original = await importOriginal<typeof ReleaseCommon>();
  class FakeRunner {
    run(command: string, args: readonly string[]): string {
      recorded.calls.push([command, ...args]);
      throw new Error(`unexpected run ${command}`);
    }
    capture(command: string, args: readonly string[]) {
      recorded.calls.push([command, ...args]);
      if (command === "git" && args[0] === "rev-parse") return { status: 0, stdout: "0123456789abcdef\n", stderr: "" };
      throw new Error(`unexpected capture ${command}`);
    }
    aws(args: readonly string[]) {
      recorded.calls.push(["aws", ...args]);
      if (args[0] === "cloudformation" && args[1] === "describe-stacks") {
        return {
          status: 0,
          stdout: args.includes("--query") ? JSON.stringify({ Outputs: recorded.controlPlaneOutputs }) : "",
          stderr: "",
        };
      }
      throw new Error(`unexpected aws ${args.join(" ")}`);
    }
  }
  return { ...original, Runner: FakeRunner };
});

const { releaseProduction, parseProductionReleaseArgs } = await import("../../scripts/release-production.js");

const MOVED_ARN = "arn:aws:iam::111122223333:role/agentx/production/agentx-production-img-push";
const ROOT_ARN = "arn:aws:iam::111122223333:role/agentx-production-img-push";
const SWITCH = "AGENTX_LEGACY_SAVED_ENV_ROLES";

describe("releaseProduction and the legacy saved environment roles switch", () => {
  let stdout: MockInstance<typeof process.stdout.write>;
  let previous: string | undefined;

  beforeEach(() => {
    recorded.calls.length = 0;
    recorded.controlPlaneOutputs = [];
    previous = process.env[SWITCH];
    delete process.env[SWITCH];
    stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    stdout.mockRestore();
    if (previous === undefined) delete process.env[SWITCH];
    else process.env[SWITCH] = previous;
  });

  const release = (dryRun = false) =>
    releaseProduction({ ...parseProductionReleaseArgs(["--skip-checks", "--allow-dirty"], {}), dryRun });

  it("refuses an unknown value before anything runs, on a real release and on a dry run", async () => {
    process.env[SWITCH] = "bogus";
    await expect(release()).rejects.toThrow(/AGENTX_LEGACY_SAVED_ENV_ROLES must be one of/);
    await expect(release(true)).rejects.toThrow(/AGENTX_LEGACY_SAVED_ENV_ROLES must be one of/);
    expect(recorded.calls).toEqual([]);
  });

  it.each([
    ["unset", undefined],
    ["none", "none"],
    ["root", "root"],
  ])("refuses a release carrying %s against an install whose roles moved, using describe-stacks alone", async (_name, value) => {
    if (value !== undefined) process.env[SWITCH] = value;
    recorded.controlPlaneOutputs = [{ OutputKey: "SavedEnvImgPushRoleArn", OutputValue: MOVED_ARN }];
    await expect(release()).rejects.toThrow(/AGENTX_LEGACY_SAVED_ENV_ROLES=path/);
    // Nothing past the read-only checks ran: no git, no sts, no ecr, no docker, no build, no deploy.
    expect(recorded.calls.length).toBeGreaterThan(0);
    for (const call of recorded.calls) {
      expect(call.slice(0, 3), call.join(" ")).toEqual(["aws", "cloudformation", "describe-stacks"]);
    }
  });

  it("lets a release carrying path past the guard on a moved install, and one with no moved roles", async () => {
    process.env[SWITCH] = "path";
    recorded.controlPlaneOutputs = [{ OutputKey: "SavedEnvImgPushRoleArn", OutputValue: MOVED_ARN }];
    await expect(release()).rejects.toThrow(/unexpected aws sts/);
    delete process.env[SWITCH];
    recorded.controlPlaneOutputs = [{ OutputKey: "SavedEnvImgPushRoleArn", OutputValue: ROOT_ARN }];
    await expect(release()).rejects.toThrow(/unexpected aws sts/);
    // Both got as far as the identity lookup, which is the first call after the guard and the git checks.
    expect(recorded.calls.some((call) => call.includes("sts"))).toBe(true);
  });
});
