import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentXError } from "@agentx/contracts";
import { CDK_CONSTRUCT_IDS, assertCdkBootstrapped, assertSourceAtRelease, buildSource, cdkDeployer, type CommandRunner } from "../../packages/cli/src/deploy/cdk-engine.js";
import type { ParameterStore } from "../../packages/cli/src/environments/parameter-store.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";

const SECRET = "s3cr3t-value-that-must-not-leak-0000000000000";

/** A runner whose response depends on the git subcommand, for assertSourceAtRelease tests that now issue two different git calls. */
function gitRunner(responses: { status?: string; tags?: string; tagsError?: Error }): CommandRunner {
  return {
    async run(_command, args) {
      if (args[0] === "status") return { stdout: responses.status ?? "" };
      if (responses.tagsError !== undefined) throw responses.tagsError;
      return { stdout: responses.tags ?? "" };
    },
  };
}

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
    expect(call.args.slice(0, 5)).toEqual(["--no-install", "cdk", "deploy", "AgentXControlPlane", "--exclusively"]);
    expect(call.args).toContain("agentxEnv=staging");
    expect(call.args).toContain("--role-arn");
    expect(call.args).toContain(`agentx-staging-control-plane:OidcIssuer=https://i`);
    expect(call.display).not.toContain(SECRET);
    expect(call.display).toContain("agentx-staging-control-plane:CallbackSigningKey=<redacted>");
  });

  it("keys every --parameters value by the physical stack name, which is what the CDK CLI looks parameters up by", async () => {
    // aws-cdk 2.1142 resolves `--parameters Stack:Key=Value` with parameterMap[stack.stackName]: a
    // construct-id prefix (AgentXControlPlane) never matches a named environment's stack
    // (agentx-staging-control-plane), so every parameter would be silently dropped.
    const dir = await mkdtemp(join(tmpdir(), "agentx-cdk-"));
    const runner = recordingRunner(dir, { "agentx-staging-control-plane": {} });
    const deployer = cdkDeployer({ runner, source: "/src", env: "staging", region: "us-east-1", identityMode: "cognito", outputsDir: dir, outputs: async () => undefined });
    await deployer.deploy({
      part: "control-plane",
      stackName: "agentx-staging-control-plane",
      parameters: { CallbackSigningKey: SECRET, PermissionsBoundaryArn: "arn:aws:iam::1:policy/b", OperatorPrincipalArn: "arn:aws:iam::1:role/o" },
      roleArn: "arn:aws:iam::1:role/r",
      terminationProtection: false,
    });
    const { args } = runner.calls[0]!;
    const values = args.flatMap((arg, index) => (args[index - 1] === "--parameters" ? [arg] : []));
    expect(values).toHaveLength(3);
    for (const value of values) expect(value.slice(0, value.indexOf(":"))).toBe("agentx-staging-control-plane");
  });

  it("builds the release source with npm ci then npm run build, through the runner, each with a display string", async () => {
    const calls: Array<{ command: string; args: string[]; cwd: string; display: string }> = [];
    const runner: CommandRunner = {
      async run(command, args, options) {
        calls.push({ command, args, cwd: options.cwd, display: options.display });
        return { stdout: "" };
      },
    };
    await buildSource({ runner, source: "/src" });
    expect(calls).toEqual([
      { command: "npm", args: ["ci"], cwd: "/src", display: "npm ci" },
      { command: "npm", args: ["run", "build"], cwd: "/src", display: "npm run build" },
    ]);
  });

  it("stops before building when npm ci fails", async () => {
    const calls: string[] = [];
    const runner: CommandRunner = {
      async run(_command, args) {
        calls.push(args.join(" "));
        if (args[0] === "ci") throw new Error("npm ci exited with code 1");
        return { stdout: "" };
      },
    };
    await expect(buildSource({ runner, source: "/src" })).rejects.toThrow("npm ci exited with code 1");
    expect(calls).toEqual(["ci"]);
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

  it("wraps a denied bootstrap parameter read instead of surfacing it raw, preserving the cause", async () => {
    const denied = new Error("AccessDenied: user is not authorized to perform ssm:GetParameter");
    const store: ParameterStore = {
      get: async () => {
        throw denied;
      },
      put: async () => undefined,
      delete: async () => undefined,
      list: async () => [],
    };
    const error: unknown = await assertCdkBootstrapped({ store, region: "us-east-1" }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("could not read /cdk-bootstrap/hnb659fds/version in us-east-1: AccessDenied: user is not authorized to perform ssm:GetParameter");
    expect((error as Error).cause).toBe(denied);
  });

  it("refuses a source checkout that is not at the release tag", async () => {
    const runner = gitRunner({ tags: "v1.2.2\n" });
    await expect(assertSourceAtRelease({ runner, source: "/src", version: "1.2.3" })).rejects.toThrow("must run from a checkout of tag v1.2.3");
  });

  it("refuses a dirty source tree before ever looking at tags, naming the cleanup", async () => {
    const runner = gitRunner({ status: " M packages/cli/src/deploy/cdk-engine.ts\n", tags: "v1.2.3\n" });
    await expect(assertSourceAtRelease({ runner, source: "/src", version: "1.2.3" })).rejects.toThrow(
      "source at /src has uncommitted changes; check out v1.2.3 cleanly",
    );
  });

  it("accepts a clean checkout whose HEAD carries several tags, one of them the release", async () => {
    const runner = gitRunner({ status: "", tags: "some-other-tag\nv1.2.3\n" });
    await expect(assertSourceAtRelease({ runner, source: "/src", version: "1.2.3" })).resolves.toBeUndefined();
  });

  it("treats no tags at HEAD as no tag", async () => {
    const runner = gitRunner({ status: "", tags: "" });
    await expect(assertSourceAtRelease({ runner, source: "/src", version: "1.2.3" })).rejects.toThrow(
      "the cdk engine must run from a checkout of tag v1.2.3; /src is at no tag",
    );
  });

  it("preserves the underlying error and its first line when the tag check itself fails", async () => {
    const runner = gitRunner({ status: "", tagsError: new Error("fatal: not a git repository\nsome extra detail nobody needs") });
    const error: unknown = await assertSourceAtRelease({ runner, source: "/src", version: "1.2.3" }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("is at no tag");
    expect((error as Error).message).toContain("fatal: not a git repository");
    expect((error as Error).message).not.toContain("some extra detail nobody needs");
    expect((error as Error).cause).toBeInstanceOf(Error);
  });

  it("redacts a secret before it is display-quoted, so whitespace and quotes inside it cannot smuggle it through escaped", async () => {
    const SPACEY_SECRET = 'sp ace"quote\\back';
    const dir = await mkdtemp(join(tmpdir(), "agentx-cdk-"));
    const runner = recordingRunner(dir, { "agentx-staging-control-plane": { ApiEndpoint: "https://x" } });
    const deployer = cdkDeployer({ runner, source: "/src", env: "staging", region: "us-east-1", identityMode: "cognito", outputsDir: dir, outputs: async () => undefined });
    await deployer.deploy({
      part: "control-plane",
      stackName: "agentx-staging-control-plane",
      parameters: { CallbackSigningKey: SPACEY_SECRET },
      roleArn: "arn:aws:iam::1:role/r",
      terminationProtection: false,
    });
    const { display } = runner.calls[0]!;
    expect(display).not.toContain(SPACEY_SECRET);
    expect(display).not.toContain("sp ace");
    expect(display).not.toContain("quote");
    expect(display).toContain("agentx-staging-control-plane:CallbackSigningKey=<redacted>");
  });

  it("emits deploying then deployed in order", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentx-cdk-"));
    const runner = recordingRunner(dir, { "agentx-staging-control-plane": { ApiEndpoint: "https://x" } });
    const deployer = cdkDeployer({ runner, source: "/src", env: "staging", region: "us-east-1", identityMode: "cognito", outputsDir: dir, outputs: async () => undefined });
    const events: Array<{ kind: string; stackName: string }> = [];
    await deployer.deploy({
      part: "control-plane",
      stackName: "agentx-staging-control-plane",
      parameters: {},
      roleArn: "arn:aws:iam::1:role/r",
      terminationProtection: false,
      onEvent: (event) => events.push(event),
    });
    expect(events).toEqual([
      { kind: "deploying", stackName: "agentx-staging-control-plane" },
      { kind: "deployed", stackName: "agentx-staging-control-plane" },
    ]);
  });

  it("never emits deployed when the runner rejects", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentx-cdk-"));
    const runner: CommandRunner = {
      run: async () => {
        throw new Error("cdk deploy failed");
      },
    };
    const deployer = cdkDeployer({ runner, source: "/src", env: "staging", region: "us-east-1", identityMode: "cognito", outputsDir: dir, outputs: async () => undefined });
    const events: Array<{ kind: string; stackName: string }> = [];
    await expect(
      deployer.deploy({
        part: "control-plane",
        stackName: "agentx-staging-control-plane",
        parameters: {},
        roleArn: "arn:aws:iam::1:role/r",
        terminationProtection: false,
        onEvent: (event) => events.push(event),
      }),
    ).rejects.toThrow("cdk deploy failed");
    expect(events).toEqual([{ kind: "deploying", stackName: "agentx-staging-control-plane" }]);
  });

  describe("refusals carry CONFIG_INVALID, never an internal error", () => {
    async function code(promise: Promise<unknown>): Promise<string | undefined> {
      const error: unknown = await promise.then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(AgentXError);
      return (error as AgentXError).code;
    }

    it("CDK not bootstrapped", async () => {
      expect(await code(assertCdkBootstrapped({ store: new MemoryParameterStore(), region: "us-east-1" }))).toBe("CONFIG_INVALID");
    });

    it("a dirty source tree", async () => {
      expect(await code(assertSourceAtRelease({ runner: gitRunner({ status: " M x\n" }), source: "/src", version: "1.2.3" }))).toBe("CONFIG_INVALID");
    });

    it("a source checkout at the wrong tag", async () => {
      expect(await code(assertSourceAtRelease({ runner: gitRunner({ tags: "v1.2.2\n" }), source: "/src", version: "1.2.3" }))).toBe("CONFIG_INVALID");
    });
  });

  describe("outputs file handling", () => {
    it("reads a stack with no outputs from CloudFormation: cdk leaves it out of the outputs file (Task 20 live check)", async () => {
      // live15eb: agentx-live15eb-runtime deployed, but "cdk deploy wrote no outputs ... (stacks written: none)".
      const dir = await mkdtemp(join(tmpdir(), "agentx-cdk-"));
      const runner = recordingRunner(dir, {});
      const asked: string[] = [];
      const deployer = cdkDeployer({ runner, source: "/src", env: "staging", region: "us-east-1", identityMode: "cognito", outputsDir: dir, outputs: async (stackName) => { asked.push(stackName); return {}; } });
      await expect(
        deployer.deploy({ part: "runtime", stackName: "agentx-staging-runtime", parameters: {}, roleArn: "arn:aws:iam::1:role/r", terminationProtection: false }),
      ).resolves.toEqual({});
      expect(asked).toEqual(["agentx-staging-runtime"]);
    });

    it("throws naming the stacks actually written when the outputs file has no entry for the requested stack", async () => {
      const dir = await mkdtemp(join(tmpdir(), "agentx-cdk-"));
      const runner = recordingRunner(dir, { "agentx-staging-other-stack": { ApiEndpoint: "https://x" } });
      const deployer = cdkDeployer({ runner, source: "/src", env: "staging", region: "us-east-1", identityMode: "cognito", outputsDir: dir, outputs: async () => undefined });
      await expect(
        deployer.deploy({ part: "control-plane", stackName: "agentx-staging-control-plane", parameters: {}, roleArn: "arn:aws:iam::1:role/r", terminationProtection: false }),
      ).rejects.toThrow(/cdk deploy wrote no outputs for agentx-staging-control-plane to .*control-plane\.json \(stacks written: agentx-staging-other-stack\)/);
    });

    it("still throws when the outputs file names another stack, even though the requested stack exists (review I1)", async () => {
      // An upgrade: the requested stack exists from the install, so CloudFormation would answer its old outputs.
      const dir = await mkdtemp(join(tmpdir(), "agentx-cdk-"));
      const runner = recordingRunner(dir, { "agentx-staging-other-stack": { ApiEndpoint: "https://x" } });
      const asked: string[] = [];
      const deployer = cdkDeployer({ runner, source: "/src", env: "staging", region: "us-east-1", identityMode: "cognito", outputsDir: dir, outputs: async (stackName) => { asked.push(stackName); return { ApiEndpoint: "https://old" }; } });
      await expect(
        deployer.deploy({ part: "control-plane", stackName: "agentx-staging-control-plane", parameters: {}, roleArn: "arn:aws:iam::1:role/r", terminationProtection: false }),
      ).rejects.toThrow(/cdk deploy wrote no outputs for agentx-staging-control-plane to .*control-plane\.json \(stacks written: agentx-staging-other-stack\)$/);
      expect(asked).toEqual([]);
    });

    it("throws when the file names no stacks but CloudFormation reports outputs for the stack (re-review R2)", async () => {
      // A correct deploy of a stack with outputs writes them to the file: these are the old ones.
      const dir = await mkdtemp(join(tmpdir(), "agentx-cdk-"));
      const runner = recordingRunner(dir, {});
      const deployer = cdkDeployer({ runner, source: "/src", env: "staging", region: "us-east-1", identityMode: "cognito", outputsDir: dir, outputs: async () => ({ ApiEndpoint: "https://old" }) });
      await expect(
        deployer.deploy({ part: "control-plane", stackName: "agentx-staging-control-plane", parameters: {}, roleArn: "arn:aws:iam::1:role/r", terminationProtection: false }),
      ).rejects.toThrow(/cdk deploy wrote no outputs for agentx-staging-control-plane to .*control-plane\.json \(stacks written: none\)$/);
    });

    it("says the deploy succeeded when reading a no-outputs stack from CloudFormation fails (review M7)", async () => {
      const dir = await mkdtemp(join(tmpdir(), "agentx-cdk-"));
      const runner = recordingRunner(dir, {});
      const deployer = cdkDeployer({ runner, source: "/src", env: "staging", region: "us-east-1", identityMode: "cognito", outputsDir: dir, outputs: async () => { throw new Error("Rate exceeded"); } });
      await expect(
        deployer.deploy({ part: "runtime", stackName: "agentx-staging-runtime", parameters: {}, roleArn: "arn:aws:iam::1:role/r", terminationProtection: false }),
      ).rejects.toThrow("cdk deploy of agentx-staging-runtime succeeded, but its outputs could not be read from CloudFormation: Rate exceeded");
    });

    it("throws when the outputs file names no stacks and CloudFormation reports no such stack", async () => {
      const dir = await mkdtemp(join(tmpdir(), "agentx-cdk-"));
      const runner = recordingRunner(dir, {});
      const deployer = cdkDeployer({ runner, source: "/src", env: "staging", region: "us-east-1", identityMode: "cognito", outputsDir: dir, outputs: async () => undefined });
      await expect(
        deployer.deploy({ part: "runtime", stackName: "agentx-staging-runtime", parameters: {}, roleArn: "arn:aws:iam::1:role/r", terminationProtection: false }),
      ).rejects.toThrow(/cdk deploy wrote no outputs for agentx-staging-runtime to .*runtime\.json \(stacks written: none\), and CloudFormation reports no such stack/);
    });

    it("deletes a stale outputs file before running, so a run that writes nothing cannot return stale data", async () => {
      const dir = await mkdtemp(join(tmpdir(), "agentx-cdk-"));
      const outputsFile = join(dir, "control-plane.json");
      await writeFile(outputsFile, JSON.stringify({ "agentx-staging-control-plane": { ApiEndpoint: "https://stale" } }));
      const runner: CommandRunner = { run: async () => ({ stdout: "" }) }; // never rewrites the outputs file
      const deployer = cdkDeployer({ runner, source: "/src", env: "staging", region: "us-east-1", identityMode: "cognito", outputsDir: dir, outputs: async () => undefined });
      await expect(
        deployer.deploy({ part: "control-plane", stackName: "agentx-staging-control-plane", parameters: {}, roleArn: "arn:aws:iam::1:role/r", terminationProtection: false }),
      ).rejects.toThrow(/cdk deploy wrote no outputs file/);
      await expect(readFile(outputsFile, "utf8")).rejects.toThrow();
    });

    it("throws a clear message, with cause, when the outputs file is missing entirely", async () => {
      const dir = await mkdtemp(join(tmpdir(), "agentx-cdk-"));
      const runner: CommandRunner = { run: async () => ({ stdout: "" }) };
      const deployer = cdkDeployer({ runner, source: "/src", env: "staging", region: "us-east-1", identityMode: "cognito", outputsDir: dir, outputs: async () => undefined });
      const error: unknown = await deployer
        .deploy({ part: "control-plane", stackName: "agentx-staging-control-plane", parameters: {}, roleArn: "arn:aws:iam::1:role/r", terminationProtection: false })
        .then(
          () => undefined,
          (caught: unknown) => caught,
        );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/cdk deploy wrote no outputs file at .*control-plane\.json/);
      expect((error as Error).cause).toBeDefined();
    });

    it("throws a clear message, with cause, when the outputs file is not valid JSON", async () => {
      const dir = await mkdtemp(join(tmpdir(), "agentx-cdk-"));
      const runner: CommandRunner = {
        run: async (_command, args) => {
          const outIndex = args.indexOf("--outputs-file");
          if (outIndex >= 0) await writeFile(args[outIndex + 1]!, "{ not json");
          return { stdout: "" };
        },
      };
      const deployer = cdkDeployer({ runner, source: "/src", env: "staging", region: "us-east-1", identityMode: "cognito", outputsDir: dir, outputs: async () => undefined });
      const error: unknown = await deployer
        .deploy({ part: "control-plane", stackName: "agentx-staging-control-plane", parameters: {}, roleArn: "arn:aws:iam::1:role/r", terminationProtection: false })
        .then(
          () => undefined,
          (caught: unknown) => caught,
        );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/cdk deploy wrote an unreadable outputs file at .*control-plane\.json/);
      expect((error as Error).cause).toBeDefined();
    });
  });
});
