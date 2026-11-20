// The production release wiring of the legacy saved environment roles switch (AGENTX_LEGACY_SAVED_ENV_ROLES), driven through releaseProduction with a fake runner:
//   - a bad value is refused before anything runs, even on a dry run;
//   - the mode is judged from the deployed control plane (describe-stacks only), before the git checks, the worker build and push, and any deploy:
//       roles under /agentx/production/ + unset: the release derives `path` and the control plane deploy carries it (no pipeline change needed after the move);
//       roles under /agentx/production/ + none or root: refused (it would revert the move);
//       no saved role outputs (between the two deploys, or after a failed second one) + unset or root: refused (it would create the deleted roles again); `path` and `none` go through;
//   - no control plane at all (a fresh install): nothing derived, the explicit value only.
// The pure helpers are unit tested in legacy-saved-env-role-path.test.ts; this file pins that releaseProduction actually calls them, and in which order.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type * as ReleaseCommon from "../../scripts/release-common.js";
import { CONTROL_PLANE_FOUNDATION_PARAMETERS } from "../../packages/contracts/src/session.js";

type Output = { OutputKey: string; OutputValue: string };
const recorded = vi.hoisted(() => ({
  calls: [] as string[][],
  /** The control plane's outputs, or undefined when the stack does not exist. */
  controlPlane: [] as Output[] | undefined,
  foundationParameters: [] as string[],
}));

class StoppedAtControlPlane extends Error {}

vi.mock("../../scripts/release-common.js", async (importOriginal) => {
  const original = await importOriginal<typeof ReleaseCommon>();
  const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
  class FakeRunner {
    run(command: string, args: readonly string[]): string {
      recorded.calls.push([command, ...args]);
      if (command === "npx" && args[0] === "cdk" && args[1] === "deploy" && args[2] === "AgentXControlPlane") throw new StoppedAtControlPlane("reached the control plane deploy");
      return "";
    }
    capture(command: string, args: readonly string[]) {
      recorded.calls.push([command, ...args]);
      if (command === "git" && args[0] === "rev-parse") return ok("0123456789abcdef\n");
      if (command === "npx" && args[0] === "cdk" && args[1] === "diff") return ok();
      throw new Error(`unexpected capture ${command}`);
    }
    aws(args: readonly string[]) {
      recorded.calls.push(["aws", ...args]);
      if (args[0] === "cloudformation" && args[1] === "describe-stacks") {
        const stack = args[args.indexOf("--stack-name") + 1];
        const query = args.includes("--query");
        if (stack === "AgentXControlPlane") {
          if (recorded.controlPlane === undefined) return { status: 254, stdout: "", stderr: "Stack with id AgentXControlPlane does not exist" };
          return ok(query ? JSON.stringify({ Outputs: recorded.controlPlane }) : "");
        }
        if (stack === "AgentXProductionFoundation") {
          return ok(query ? JSON.stringify({ Outputs: recorded.foundationParameters.map((OutputKey) => ({ OutputKey, OutputValue: `${OutputKey}-value` })) }) : "");
        }
        return ok(query ? JSON.stringify({ Parameters: [] }) : "");
      }
      if (args[0] === "sts") return ok(JSON.stringify({ Account: "111122223333" }));
      return ok("{}");
    }
  }
  return { ...original, Runner: FakeRunner };
});

const { releaseProduction, parseProductionReleaseArgs } = await import("../../scripts/release-production.js");

const MOVED_ARN = "arn:aws:iam::111122223333:role/agentx/production/agentx-production-img-push";
const ROOT_ARN = "arn:aws:iam::111122223333:role/agentx-production-img-push";
const SWITCH = "AGENTX_LEGACY_SAVED_ENV_ROLES";
const WORKER_IMAGE = `111122223333.dkr.ecr.us-east-1.amazonaws.com/agentx-worker-production@sha256:${"a".repeat(64)}`;
const pushRole = (arn: string): Output[] => [{ OutputKey: "SavedEnvImgPushRoleArn", OutputValue: arn }];

describe("releaseProduction and the legacy saved environment roles switch", () => {
  let stdout: MockInstance<typeof process.stdout.write>;
  const saved: Record<string, string | undefined> = {};
  const environmentKeys = [SWITCH, "AGENTX_MODEL_PROVIDER", "AGENTX_MODEL_ID"];

  beforeEach(() => {
    recorded.calls.length = 0;
    recorded.controlPlane = [];
    recorded.foundationParameters = [...CONTROL_PLANE_FOUNDATION_PARAMETERS];
    for (const key of environmentKeys) saved[key] = process.env[key];
    delete process.env[SWITCH];
    process.env.AGENTX_MODEL_PROVIDER = "bedrock";
    process.env.AGENTX_MODEL_ID = "model-id-for-the-test";
    stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    stdout.mockRestore();
    for (const key of environmentKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  const release = (dryRun = false) =>
    releaseProduction({ ...parseProductionReleaseArgs(["--skip-checks", "--allow-dirty", "--worker-image", WORKER_IMAGE], {}), dryRun });
  /** The `-c` value of the control plane deploy the release reached, if any. */
  const controlPlaneContext = () => {
    const deploy = recorded.calls.find((call) => call[0] === "npx" && call[1] === "cdk" && call[2] === "deploy" && call[3] === "AgentXControlPlane");
    return deploy?.filter((argument) => argument.startsWith("agentxLegacySavedEnvRoles="));
  };
  const onlyDescribeStacks = () => {
    expect(recorded.calls.length).toBeGreaterThan(0);
    for (const call of recorded.calls) expect(call.slice(0, 3), call.join(" ")).toEqual(["aws", "cloudformation", "describe-stacks"]);
  };

  it("refuses an unknown value before anything runs, on a real release and on a dry run", async () => {
    process.env[SWITCH] = "bogus";
    await expect(release()).rejects.toThrow(/AGENTX_LEGACY_SAVED_ENV_ROLES must be one of/);
    await expect(release(true)).rejects.toThrow(/AGENTX_LEGACY_SAVED_ENV_ROLES must be one of/);
    expect(recorded.calls).toEqual([]);
  });

  it("the fake release reaches the control plane deploy on a default install, with no mode flag", async () => {
    recorded.controlPlane = pushRole(ROOT_ARN);
    await expect(release()).rejects.toThrow(StoppedAtControlPlane);
    expect(controlPlaneContext()).toEqual([]);
  });

  it.each([
    ["none", "none"],
    ["root", "root"],
  ])("refuses a release carrying %s against an install whose roles moved, using describe-stacks alone", async (_name, value) => {
    process.env[SWITCH] = value;
    recorded.controlPlane = pushRole(MOVED_ARN);
    await expect(release()).rejects.toThrow(/would revert them/);
    onlyDescribeStacks();
  });

  it("derives path from the deployed control plane when the mode is unset, and the deploy carries it", async () => {
    recorded.controlPlane = pushRole(MOVED_ARN);
    await expect(release()).rejects.toThrow(StoppedAtControlPlane);
    expect(controlPlaneContext()).toEqual(["agentxLegacySavedEnvRoles=path"]);
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["root", "root"],
  ])("refuses a release with the mode %s against a control plane with no saved role outputs (between the two deploys), using describe-stacks alone", async (_name, value) => {
    if (value !== undefined) process.env[SWITCH] = value;
    recorded.controlPlane = [];
    await expect(release()).rejects.toThrow(/under way/);
    onlyDescribeStacks();
  });

  it.each([
    ["path", "agentxLegacySavedEnvRoles=path"],
    ["none", "agentxLegacySavedEnvRoles=none"],
  ])("lets an explicit %s through against a control plane with no saved role outputs", async (value, flag) => {
    process.env[SWITCH] = value;
    recorded.controlPlane = [];
    await expect(release()).rejects.toThrow(StoppedAtControlPlane);
    expect(controlPlaneContext()).toEqual([flag]);
  });

  it("derives nothing on a fresh install (no control plane yet): the explicit value only", async () => {
    recorded.controlPlane = undefined;
    // The fake reports the stack missing everywhere, so the release stops at the existence check, past the guard.
    await expect(release()).rejects.toThrow(/AgentXControlPlane must exist/);
    expect(recorded.calls.some((call) => call.includes("sts"))).toBe(true);
  });
});
