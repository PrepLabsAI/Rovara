// The cdk deploy engine: an alternative to the templates engine that shells out to `cdk deploy`
// from a release-tagged source checkout, one stack at a time. Chosen for an install/upgrade that
// needs the flexibility of a real CDK deploy (drift reconciliation, asset diffing) instead of the
// templates engine's pre-synthesized, pre-uploaded change sets. Every other stack is deployed
// through the service role the access stack creates; the access stack itself is deployed with the
// caller's own credentials (no --role-arn), same as the templates engine.
//
// Termination protection is not this engine's job: the CDK app itself sets
// `terminationProtection: true` on the protected stacks' constructs (infra/lib/app.ts), so unlike
// the templates engine (which calls UpdateTerminationProtection after a bare CloudFormation
// change set), this engine never needs to touch it.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ParameterStore } from "../environments/parameter-store.js";
import type { DeployRequest, StackDeployer, StackOutputs } from "./deployer.js";
import { SECRET_PARAMETERS, type DeployPart } from "./parameters.js";

/** What the cdk engine needs to run a shell command: the release pipeline's real implementation
 * shells out to `child_process`; tests record calls instead. */
export interface CommandRunner {
  run(command: string, args: string[], options: { cwd: string; display: string }): Promise<{ stdout: string }>;
}

/** Every deploy part's CDK construct id, exactly as infra/lib/app.ts names them. */
export const CDK_CONSTRUCT_IDS: Record<DeployPart, string> = {
  access: "AgentXAccess",
  foundation: "AgentXProductionFoundation",
  identity: "AgentXIdentity",
  runtime: "AgentXProductionRuntime",
  "control-plane": "AgentXControlPlane",
  slack: "AgentXSlackOrchestrator",
};

/** The SSM parameter the CDK CLI itself writes on `cdk bootstrap`, under the default qualifier. */
const CDK_BOOTSTRAP_VERSION_PARAMETER = "/cdk-bootstrap/hnb659fds/version";

/**
 * Refuses to run the cdk engine in a region CDK has never been bootstrapped in: without a
 * bootstrap stack there is no staging bucket for `cdk deploy` to upload assets and the nested
 * template to, so the deploy would fail deep into the run instead of failing fast here.
 */
export async function assertCdkBootstrapped(input: { store: ParameterStore; region: string }): Promise<void> {
  const parameter = await input.store.get(CDK_BOOTSTRAP_VERSION_PARAMETER);
  if (parameter === undefined) {
    throw new Error(
      `CDK is not bootstrapped in ${input.region}; run: npx cdk bootstrap aws://<account>/${input.region} (or use --engine templates, which needs no bootstrap)`,
    );
  }
}

/**
 * Refuses to run the cdk engine from a checkout that isn't exactly the release's tag: unlike the
 * templates engine (which deploys pre-synthesized templates a release records checksums for), the
 * cdk engine synthesizes from whatever source is on disk, so an untagged or mismatched checkout
 * would silently deploy something other than the release it claims to be.
 */
export async function assertSourceAtRelease(input: { runner: CommandRunner; source: string; version: string }): Promise<void> {
  const expected = `v${input.version}`;
  let described: string;
  try {
    const { stdout } = await input.runner.run("git", ["describe", "--tags", "--exact-match"], {
      cwd: input.source,
      display: "git describe --tags --exact-match",
    });
    described = stdout.trim();
  } catch {
    described = "";
  }
  if (described !== expected) {
    throw new Error(`the cdk engine must run from a checkout of tag ${expected}; ${input.source} is at ${described === "" ? "no tag" : described}`);
  }
}

/** Quotes an argument for the printed command line when it contains whitespace (only `--app`'s value does today). */
function displayArg(arg: string): string {
  return /\s/.test(arg) ? JSON.stringify(arg) : arg;
}

/** Replaces every secret parameter's value in `text`; mirrors the templates engine's redactor. */
function redactSecrets(text: string, parameters: Record<string, string>): string {
  let redacted = text;
  for (const name of SECRET_PARAMETERS) {
    const value = parameters[name];
    if (value === undefined || value === "") continue;
    redacted = redacted.split(value).join("<redacted>");
  }
  return redacted;
}

export function cdkDeployer(input: {
  runner: CommandRunner;
  source: string;
  env: string;
  region: string;
  identityMode: "cognito" | "oidc";
  outputsDir: string;
  outputs: (stackName: string) => Promise<StackOutputs | undefined>;
}): StackDeployer {
  return {
    async deploy(request: DeployRequest): Promise<StackOutputs> {
      const constructId = CDK_CONSTRUCT_IDS[request.part];
      const outputsFile = join(input.outputsDir, `${request.part}.json`);

      const args: string[] = [
        "cdk",
        "deploy",
        constructId,
        "--exclusively",
        "--app",
        "node infra/dist/bin/agentx.js",
        "-c",
        `agentxEnv=${input.env}`,
        "-c",
        `agentxRegion=${input.region}`,
      ];
      if (input.identityMode === "oidc") args.push("-c", "agentxIdentity=oidc");
      args.push("--require-approval", "never", "--outputs-file", outputsFile);
      if (request.roleArn !== undefined) args.push("--role-arn", request.roleArn);
      for (const [key, value] of Object.entries(request.parameters)) {
        args.push("--parameters", `${constructId}:${key}=${value}`);
      }

      const display = redactSecrets(["npx", ...args.map(displayArg)].join(" "), request.parameters);
      request.onEvent?.({ kind: "deploying", stackName: request.stackName });
      await input.runner.run("npx", args, { cwd: input.source, display });

      const written = JSON.parse(await readFile(outputsFile, "utf8")) as Record<string, StackOutputs>;
      const outputs = written[request.stackName] ?? {};
      request.onEvent?.({ kind: "deployed", stackName: request.stackName });
      return outputs;
    },
    outputs: input.outputs,
  };
}
