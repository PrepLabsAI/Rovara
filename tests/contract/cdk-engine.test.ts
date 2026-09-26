import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CDK_CONSTRUCT_IDS, assertCdkBootstrapped, assertSourceAtRelease, cdkDeployer, type CommandRunner } from "../../packages/cli/src/deploy/cdk-engine.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";

const SECRET = "s3cr3t-value-that-must-not-leak-0000000000000";

function recordingRunner(outputsDir: string, outputs: Record<string, Record<string, string>>): CommandRunner & { calls: Array<{ command: string; args: string[]; display: string }> } {
  const calls: Array<{ command: string; args: string[]; display: string }> = [];
  return {
    calls,
    async run(command, args, options) {
      calls.push({ command, args, display: options.display });
      const outIndex = args.indexOf("--outputs-file");
      if (outIndex >= 0) await writeFile(args[outIndex + 1]!, JSON.stringify(outputs));
      return { stdout: "" };
    },
  };
}

describe("cdk engine", () => {
  it("maps every part to its construct id", () => {
    expect(CDK_CONSTRUCT_IDS).toEqual({ access: "AgentXAccess", foundation: "AgentXProductionFoundation", identity: "AgentXIdentity", runtime: "AgentXProductionRuntime", "control-plane": "AgentXControlPlane", slack: "AgentXSlackOrchestrator" });
  });

  it("deploys one stack exclusively with its parameters and role, and returns its outputs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentx-cdk-"));
    const runner = recordingRunner(dir, { "agentx-staging-control-plane": { ApiEndpoint: "https://x" } });
    const deployer = cdkDeployer({ runner, source: "/src", env: "staging", region: "us-east-1", identityMode: "cognito", outputsDir: dir, outputs: async () => undefined });
    const out = await deployer.deploy({ part: "control-plane", stackName: "agentx-staging-control-plane", parameters: { CallbackSigningKey: SECRET, OidcIssuer: "https://i" }, roleArn: "arn:aws:iam::123456789012:role/agentx-staging-cloudformation", terminationProtection: false });
    expect(out).toEqual({ ApiEndpoint: "https://x" });
    const call = runner.calls[0]!;
    expect(call.command).toBe("npx");
    expect(call.args.slice(0, 4)).toEqual(["cdk", "deploy", "AgentXControlPlane", "--exclusively"]);
    expect(call.args).toContain("agentxEnv=staging");
    expect(call.args).toContain("--role-arn");
    expect(call.args).toContain(`AgentXControlPlane:OidcIssuer=https://i`);
    expect(call.display).not.toContain(SECRET);
    expect(call.display).toContain("AgentXControlPlane:CallbackSigningKey=<redacted>");
  });

  it("passes agentxIdentity=oidc when the environment brings its own provider", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentx-cdk-"));
    const runner = recordingRunner(dir, { "agentx-staging-runtime": {} });
    await cdkDeployer({ runner, source: "/src", env: "staging", region: "us-east-1", identityMode: "oidc", outputsDir: dir, outputs: async () => undefined })
      .deploy({ part: "runtime", stackName: "agentx-staging-runtime", parameters: {}, roleArn: "arn:aws:iam::1:role/r", terminationProtection: true });
    expect(runner.calls[0]!.args).toContain("agentxIdentity=oidc");
  });

  it("refuses to run when CDK is not bootstrapped, naming the fix and the alternative", async () => {
    await expect(assertCdkBootstrapped({ store: new MemoryParameterStore(), region: "us-east-1" })).rejects.toThrow(/cdk bootstrap .*--engine templates/);
  });

  it("refuses a source checkout that is not at the release tag", async () => {
    const runner: CommandRunner = { run: async () => ({ stdout: "v1.2.2\n" }) };
    await expect(assertSourceAtRelease({ runner, source: "/src", version: "1.2.3" })).rejects.toThrow("must run from a checkout of tag v1.2.3");
  });
});
