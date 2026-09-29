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
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { agentXError } from "@agentx/contracts";
import type { ParameterStore } from "../environments/parameter-store.js";
import type { DeployRequest, StackDeployer, StackOutputs } from "./deployer.js";
import { SECRET_PARAMETERS, type DeployPart } from "./parameters.js";

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** What the cdk engine needs to run a shell command: the release pipeline's real implementation
 * shells out to `child_process`; tests record calls instead. */
export interface CommandRunner {
  run(
    command: string,
    args: string[],
    options: {
      cwd: string;
      display: string;
      /** Applied to a failed run's captured stderr before it is ever surfaced in an error; mirrors
       * `redactSecrets` below so a secret that a child process itself echoes back never leaks
       * through a thrown error the way `display` already keeps it out of the printed command. */
      redact?: (text: string) => string;
      /** Captures stdout without echoing it (a long listing only our own code reads). */
      quiet?: boolean;
    },
  ): Promise<{
    stdout: string;
    /** The child's captured standard error, unredacted; only our own code reads it, and redacts it before showing it. */
    stderr?: string;
  }>;
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
  let parameter: Awaited<ReturnType<ParameterStore["get"]>>;
  try {
    parameter = await input.store.get(CDK_BOOTSTRAP_VERSION_PARAMETER);
  } catch (error) {
    throw new Error(`could not read ${CDK_BOOTSTRAP_VERSION_PARAMETER} in ${input.region}: ${errorMessage(error)}`, { cause: error });
  }
  if (parameter === undefined) {
    throw agentXError(
      "CONFIG_INVALID",
      `CDK is not bootstrapped in ${input.region}; run: npx cdk bootstrap aws://<account>/${input.region} (or use --engine templates, which needs no bootstrap)`,
    );
  }
}

/**
 * Refuses to run the cdk engine from a checkout that isn't exactly, cleanly, the release's tag:
 * unlike the templates engine (which deploys pre-synthesized templates a release records
 * checksums for), the cdk engine synthesizes from whatever source is on disk, so an untagged,
 * mismatched, or locally modified checkout would silently deploy something other than the release
 * it claims to be.
 *
 * `git describe --tags --exact-match` picks one tag when HEAD carries several, which could hide
 * the release tag behind an unrelated one; `git tag --points-at HEAD` lists every tag at HEAD, so
 * the release tag is required to be among them rather than to be the one describe happens to pick.
 */
export async function assertSourceAtRelease(input: { runner: CommandRunner; source: string; version: string }): Promise<void> {
  const expected = `v${input.version}`;

  const { stdout: statusOutput } = await input.runner.run("git", ["status", "--porcelain"], {
    cwd: input.source,
    display: "git status --porcelain",
  });
  if (statusOutput.trim() !== "") {
    throw agentXError("CONFIG_INVALID", `source at ${input.source} has uncommitted changes; check out ${expected} cleanly`);
  }

  let tags: string[];
  try {
    const { stdout } = await input.runner.run("git", ["tag", "--points-at", "HEAD"], {
      cwd: input.source,
      display: "git tag --points-at HEAD",
    });
    tags = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
  } catch (error) {
    // The brief's wording ("... is at no tag") is preserved even when the runner itself failed
    // (not a git repo, git missing, etc.) rather than simply finding zero tags — but the cause
    // must not be silently lost, so it's attached and its first line folded into the message.
    const firstLine = errorMessage(error).split("\n")[0];
    throw new Error(`the cdk engine must run from a checkout of tag ${expected}; ${input.source} is at no tag (${firstLine})`, { cause: error });
  }

  if (!tags.includes(expected)) {
    throw agentXError("CONFIG_INVALID", `the cdk engine must run from a checkout of tag ${expected}; ${input.source} is at ${tags.length === 0 ? "no tag" : tags.join(", ")}`);
  }
}

/**
 * Installs and builds the release's source checkout before `cdk deploy` runs: `infra/dist` is
 * gitignored, so a checkout at the right tag can still hold a stale build (or none at all), and the
 * tag check alone would then pass while `cdk deploy` synthesized something else. `npm ci` installs
 * exactly the lockfile's dependencies (including the CDK CLI `npx --no-install cdk` then runs), and
 * `npm run build` compiles every workspace, infra included.
 */
export async function buildSource(input: { runner: CommandRunner; source: string }): Promise<void> {
  await input.runner.run("npm", ["ci"], { cwd: input.source, display: "npm ci" });
  await input.runner.run("npm", ["run", "build"], { cwd: input.source, display: "npm run build" });
}

/** Quotes an argument for the printed command line when it contains whitespace (only `--app`'s value does today). */
function displayArg(arg: string): string {
  return /\s/.test(arg) ? JSON.stringify(arg) : arg;
}

/** Replaces every secret parameter's value in `text`; mirrors the templates engine's redactor.
 * Must run on each raw argument *before* `displayArg` quotes it: quoting can escape characters
 * (a `"` or `\` inside the secret) that would then no longer match the secret's literal value,
 * letting an escaped fragment of it slip into the printed command unredacted. */
function redactSecrets(text: string, parameters: Record<string, string>): string {
  let redacted = text;
  for (const name of SECRET_PARAMETERS) {
    const value = parameters[name];
    if (value === undefined || value === "") continue;
    redacted = redacted.split(value).join("<redacted>");
  }
  return redacted;
}

/** The cdk command's arguments for one stack (deploy or diff); a deploy passes each parameter by physical stack name. */
function cdkArguments(input: { env: string; region: string; identityMode: "cognito" | "oidc" }, request: DeployRequest, command: "deploy" | "diff"): string[] {
  // --no-install: only the CDK CLI `npm ci` installed from the release's own lockfile, never one npx
  // would otherwise download on the fly.
  const args = ["--no-install", "cdk", command, CDK_CONSTRUCT_IDS[request.part], "--exclusively", "--app", "node infra/dist/bin/agentx.js", "-c", `agentxEnv=${input.env}`, "-c", `agentxRegion=${input.region}`];
  if (input.identityMode === "oidc") args.push("-c", "agentxIdentity=oidc");
  // cdk diff ignores --parameters (CDK 2.1142 warns that they apply only to deploy).
  if (command === "diff") return args;
  // The CDK CLI looks `--parameters` up by the physical stack name (parameterMap[stack.stackName]),
  // not the construct id; a construct-id prefix silently drops every parameter.
  for (const [key, value] of Object.entries(request.parameters)) args.push("--parameters", `${request.stackName}:${key}=${value}`);
  return args;
}

/** FR-042: `cdk diff` for one stack, against the deployed template (`--method=template`: no change
 * set, so nothing is written to AWS). No `--parameters`: CDK 2.1142 ignores them for diff and warns.
 * A template diff cannot see a replacement caused only by a changed parameter value or cascading
 * through a Ref or GetAtt, nor a Conditions or Mappings change that adds or removes a conditional
 * resource; the live check (Task 20) looks at this. cdk prints the diff on stderr; the
 * text returned has every secret redacted. */
export async function cdkDiff(input: { runner: CommandRunner; source: string; env: string; region: string; identityMode: "cognito" | "oidc"; request: DeployRequest }): Promise<string> {
  // --no-notices: a notice naming a guarded resource type would otherwise read as an unclear line.
  const args = [...cdkArguments(input, input.request, "diff"), "--method=template", "--no-notices"];
  const redact = (text: string) => redactSecrets(text, input.request.parameters);
  const display = ["npx", ...args.map((arg) => displayArg(redact(arg)))].join(" ");
  const result = await input.runner.run("npx", args, { cwd: input.source, display, redact, quiet: true });
  return redact([result.stdout, result.stderr ?? ""].filter((part) => part !== "").join("\n"));
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
      const outputsFile = join(input.outputsDir, `${request.part}.json`);
      const args = [...cdkArguments(input, request, "deploy"), "--require-approval", "never", "--outputs-file", outputsFile, ...(request.roleArn === undefined ? [] : ["--role-arn", request.roleArn])];

      // Redact each raw argument first, then quote the (now secret-free) result — quoting after
      // redaction would let an escaped fragment of a secret containing whitespace, a quote, or a
      // backslash slip through unredacted (see redactSecrets's doc comment).
      const display = ["npx", ...args.map((arg) => displayArg(redactSecrets(arg, request.parameters)))].join(" ");
      request.onEvent?.({ kind: "deploying", stackName: request.stackName });

      // A stale outputs file from an earlier run at this path must never be read back as this
      // run's result, so it is removed before `cdk deploy` runs; `force` makes a missing file a
      // no-op rather than an error.
      await rm(outputsFile, { force: true });
      await input.runner.run("npx", args, { cwd: input.source, display, redact: (text) => redactSecrets(text, request.parameters) });

      const outputs = await readOutputs(outputsFile, request.stackName);
      request.onEvent?.({ kind: "deployed", stackName: request.stackName });
      return outputs;
    },
    outputs: input.outputs,
  };
}

/** Reads the outputs file `cdk deploy --outputs-file` wrote and returns `stackName`'s entry.
 * Throws a clear, cause-carrying message for a missing or unparseable file, and — since neither of
 * those is possible once the file is confirmed to parse — a distinct message naming the stacks it
 * actually holds when `stackName` itself has no entry (a stack `cdk deploy` didn't touch, or a
 * `--outputs-file` path that doesn't match what was requested). */
async function readOutputs(file: string, stackName: string): Promise<StackOutputs> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    throw new Error(`cdk deploy wrote no outputs file at ${file}: ${errorMessage(error)}`, { cause: error });
  }
  let written: Record<string, StackOutputs>;
  try {
    written = JSON.parse(raw) as Record<string, StackOutputs>;
  } catch (error) {
    throw new Error(`cdk deploy wrote an unreadable outputs file at ${file}: ${errorMessage(error)}`, { cause: error });
  }
  const outputs = written[stackName];
  if (outputs === undefined) {
    const stacksWritten = Object.keys(written);
    throw new Error(`cdk deploy wrote no outputs for ${stackName} to ${file} (stacks written: ${stacksWritten.length === 0 ? "none" : stacksWritten.join(", ")})`);
  }
  return outputs;
}
