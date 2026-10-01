// Release helpers shared by the production release and its tests.
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { resolve } from "node:path";

const DEFAULT_REGION = "us-east-1";
const DEFAULT_REPOSITORY = "agentx-worker-production";
const CONTROL_PLANE_STACK = "AgentXControlPlane";

export interface ReleaseOptions {
  region: string;
  repository: string;
  profile?: string;
  workerImage?: string;
  allowDirty: boolean;
  skipChecks: boolean;
  dryRun: boolean;
}

export interface ReleaseManifest {
  releasedAt: string;
  gitRevision: string;
  workerImage: string;
  controlPlaneUrl: string;
  protocolVersion: number;
  region: string;
  accountId: string;
}

export interface StackDescription {
  Parameters?: Array<{ ParameterKey?: string; ParameterValue?: string }>;
  Outputs?: Array<{ OutputKey?: string; OutputValue?: string }>;
}

interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Takes `--env <name>` out of the arguments, leaving every other argument in place. */
export function splitEnvFlag(argv: readonly string[]): { env?: string; rest: string[] } {
  const index = argv.indexOf("--env");
  if (index < 0) return { rest: [...argv] };
  const env = argv[index + 1];
  if (env === undefined || env.startsWith("--")) throw new Error("--env requires a value");
  return { env, rest: argv.filter((_, position) => position !== index && position !== index + 1) };
}

export function parseReleaseArgs(
  argv: readonly string[],
  environment = process.env,
  extraFlags: readonly string[] = [],
): ReleaseOptions {
  const valueAfter = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    if (index < 0) return undefined;
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    return value;
  };
  const known = new Set([
    "--region",
    "--repository",
    "--profile",
    "--worker-image",
    "--allow-dirty",
    "--skip-checks",
    "--dry-run",
    "--help",
    ...extraFlags,
  ]);
  for (const argument of argv) {
    if (argument.startsWith("--") && !known.has(argument)) {
      throw new Error(`unknown option ${argument}`);
    }
  }
  return {
    region: valueAfter("--region") ?? environment.AWS_REGION ?? environment.AWS_DEFAULT_REGION ?? DEFAULT_REGION,
    repository: valueAfter("--repository") ?? DEFAULT_REPOSITORY,
    ...(valueAfter("--profile") ?? environment.AWS_PROFILE
      ? { profile: valueAfter("--profile") ?? environment.AWS_PROFILE }
      : {}),
    ...(valueAfter("--worker-image") ? { workerImage: valueAfter("--worker-image") } : {}),
    allowDirty: argv.includes("--allow-dirty"),
    skipChecks: argv.includes("--skip-checks"),
    dryRun: argv.includes("--dry-run"),
  };
}

export function releaseTag(now: Date, revision: string): string {
  const timestamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const shortRevision = revision.slice(0, 12);
  if (!/^[a-f0-9]{7,40}$/.test(revision)) throw new Error("git revision must be hexadecimal");
  return `release-${timestamp}-${shortRevision}`;
}

export function assertDigestImage(value: string, expectedRepositoryUri?: string): void {
  if (!/^.+@sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error("worker image must be an immutable sha256 digest URI");
  }
  if (expectedRepositoryUri && !value.startsWith(`${expectedRepositoryUri}@sha256:`)) {
    throw new Error(`worker image must belong to ${expectedRepositoryUri}`);
  }
}

export class Runner {
  constructor(private readonly options: ReleaseOptions) {}

  run(command: string, args: readonly string[], input?: string): string {
    process.stdout.write(`\n+ ${formatCommand(command, args)}\n`);
    const execution = spawnSync(command, [...args], {
      cwd: process.cwd(),
      env: process.env,
      encoding: "utf8",
      stdio: input === undefined ? ["inherit", "inherit", "inherit"] : ["pipe", "inherit", "inherit"],
      ...(input === undefined ? {} : { input }),
    } satisfies SpawnSyncOptionsWithStringEncoding);
    if (execution.error) throw execution.error;
    if ((execution.status ?? 1) !== 0) {
      throw new Error(`${command} exited with status ${execution.status ?? "unknown"}`);
    }
    return execution.stdout ?? "";
  }

  capture(command: string, args: readonly string[], allowFailure = false): CommandResult {
    const execution = spawnSync(command, [...args], {
      cwd: process.cwd(),
      env: process.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (execution.error) throw execution.error;
    const result = {
      status: execution.status ?? 1,
      stdout: execution.stdout ?? "",
      stderr: execution.stderr ?? "",
    };
    if (!allowFailure && result.status !== 0) {
      process.stderr.write(result.stderr);
      throw new Error(`${command} exited with status ${result.status}`);
    }
    return result;
  }

  aws(args: readonly string[], allowFailure = false): CommandResult {
    return this.capture("aws", [...args, ...profileArgs(this.options.profile)], allowFailure);
  }
}

export function ensureRepository(runner: Runner, options: ReleaseOptions): void {
  const describe = runner.aws([
    "ecr",
    "describe-repositories",
    "--region",
    options.region,
    "--repository-names",
    options.repository,
  ], true);
  if (describe.status !== 0) {
    if (!describe.stderr.includes("RepositoryNotFoundException")) {
      process.stderr.write(describe.stderr);
      throw new Error("unable to inspect the ECR repository");
    }
    const created = runner.aws([
      "ecr",
      "create-repository",
      "--region",
      options.region,
      "--repository-name",
      options.repository,
      "--image-scanning-configuration",
      "scanOnPush=true",
      "--image-tag-mutability",
      "IMMUTABLE",
    ]);
    process.stdout.write(created.stdout);
  }
  const lifecyclePolicy = resolve("infra/ecr-lifecycle-policy.json");
  runner.aws([
    "ecr",
    "put-image-scanning-configuration",
    "--region",
    options.region,
    "--repository-name",
    options.repository,
    "--image-scanning-configuration",
    "scanOnPush=true",
  ]);
  runner.aws([
    "ecr",
    "put-lifecycle-policy",
    "--region",
    options.region,
    "--repository-name",
    options.repository,
    "--lifecycle-policy-text",
    `file://${lifecyclePolicy}`,
  ]);
  runner.aws([
    "ecr",
    "put-image-tag-mutability",
    "--region",
    options.region,
    "--repository-name",
    options.repository,
    "--image-tag-mutability",
    "IMMUTABLE",
  ]);
}

export function verifyRepositoryImage(runner: Runner, options: ReleaseOptions, workerImage: string): void {
  const digest = workerImage.slice(workerImage.indexOf("@") + 1);
  runner.aws([
    "ecr",
    "describe-images",
    "--region",
    options.region,
    "--repository-name",
    options.repository,
    "--image-ids",
    `imageDigest=${digest}`,
    "--query",
    "imageDetails[0].imageDigest",
    "--output",
    "text",
  ]);
}

export interface ImageBuild {
  repository: string;
  repositoryUri: string;
  dockerfile: string;
  localName: string;
  smokeTest: (runner: Runner, image: string) => Promise<void>;
  /** linux/arm64 unless given: the EC2 workers and the Slack service run on Graviton. */
  platform?: "linux/arm64" | "linux/amd64";
  /**
   * Replaces the tag's `release-` prefix. The repository keeps only the newest twenty `release-`
   * images, so an image that is not a release (spec 043's SWE-bench runner) must not use it.
   */
  tagPrefix?: string;
}

export async function buildAndPushWorker(
  runner: Runner,
  options: ReleaseOptions,
  repositoryUri: string,
  revision: string,
): Promise<string> {
  return buildAndPushImage(runner, options, {
    repository: options.repository,
    repositoryUri,
    dockerfile: "environments/base/Dockerfile",
    localName: "agentx-worker",
    smokeTest: smokeTestWorker,
  }, revision);
}

export async function buildAndPushImage(
  runner: Runner,
  options: ReleaseOptions,
  image: ImageBuild,
  revision: string,
): Promise<string> {
  const release = releaseTag(new Date(), revision);
  const tag = image.tagPrefix === undefined ? release : `${image.tagPrefix}${release.slice("release-".length)}`;
  const localImage = `${image.localName}:${tag}`;
  const remoteImage = `${image.repositoryUri}:${tag}`;
  runner.run("docker", [
    "buildx",
    "build",
    "--platform",
    image.platform ?? "linux/arm64",
    "--load",
    "--tag",
    localImage,
    "--label",
    `org.opencontainers.image.revision=${revision}`,
    "--label",
    `org.opencontainers.image.created=${new Date().toISOString()}`,
    "--file",
    image.dockerfile,
    ".",
  ]);
  await image.smokeTest(runner, localImage);

  const password = runner.aws([
    "ecr",
    "get-login-password",
    "--region",
    options.region,
  ]).stdout;
  runner.run("docker", ["login", "--username", "AWS", "--password-stdin", image.repositoryUri.split("/")[0]!], password);
  runner.run("docker", ["tag", localImage, remoteImage]);
  runner.run("docker", ["push", remoteImage]);
  const digest = runner.aws([
    "ecr",
    "describe-images",
    "--region",
    options.region,
    "--repository-name",
    image.repository,
    "--image-ids",
    `imageTag=${tag}`,
    "--query",
    "imageDetails[0].imageDigest",
    "--output",
    "text",
  ]).stdout.trim();
  const pushed = `${image.repositoryUri}@${digest}`;
  assertDigestImage(pushed, image.repositoryUri);
  return pushed;
}

async function smokeTestWorker(runner: Runner, image: string): Promise<void> {
  // The tools that run a project's devcontainer through the EC2 host's Docker (#121).
  const tools = runner.capture("docker", [
    "run", "--rm", "--entrypoint", "sh", image, "-c",
    "docker --version && docker compose version && node node_modules/@devcontainers/cli/devcontainer.js --version",
  ], true);
  if (tools.status !== 0) {
    process.stderr.write(tools.stderr);
    throw new Error("worker image lacks the Docker CLI, Compose or the devcontainer CLI");
  }
  const container = `agentx-worker-release-smoke-${process.pid}`;
  const publicKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey
    .export({ format: "der", type: "spki" }).toString("base64");
  runner.run("docker", [
    "run", "--detach", "--rm", "--name", container, "--publish", "127.0.0.1::8080",
    "--env", `AGENTX_INVOKE_PUBLIC_KEY=${publicKey}`,
    "--env", `AGENTX_WORKSPACE_ID=${randomUUID()}`,
    "--env", "AGENTX_SESSION_GENERATION=1", image,
  ]);
  try {
    let port = "";
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const portResult = runner.capture("docker", ["port", container, "8080/tcp"], true);
      const match = portResult.stdout.match(/:(\d+)\s*$/m);
      if (match?.[1]) {
        port = match[1];
        try {
          const response = await fetch(`http://127.0.0.1:${port}/ping`);
          const body = await response.json() as { status?: string };
          if (response.ok && body.status === "Healthy") return;
        } catch {
          // Container startup is asynchronous; retry until the bounded deadline.
        }
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    }
    throw new Error(`worker smoke test did not become healthy${port ? ` on port ${port}` : ""}`);
  } finally {
    runner.capture("docker", ["stop", container], true);
  }
}

export function stackExists(runner: Runner, region: string, stack: string): boolean {
  const result = runner.aws([
    "cloudformation",
    "describe-stacks",
    "--region",
    region,
    "--stack-name",
    stack,
  ], true);
  if (result.status === 0) return true;
  if (result.stderr.includes("does not exist")) return false;
  process.stderr.write(result.stderr);
  throw new Error(`unable to inspect CloudFormation stack ${stack}`);
}

export function describeStack(runner: Runner, region: string, stack: string): StackDescription {
  const result = runner.aws([
    "cloudformation",
    "describe-stacks",
    "--region",
    region,
    "--stack-name",
    stack,
    "--query",
    "Stacks[0]",
    "--output",
    "json",
  ]);
  return parseJson<StackDescription>(result.stdout);
}

export function stackOutput(stack: StackDescription, key: string): string {
  const value = stack.Outputs?.find((output) => output.OutputKey === key)?.OutputValue;
  if (!value) throw new Error(`CloudFormation output ${key} is missing`);
  return value;
}

export function stackParameter(stack: StackDescription, key: string): string | undefined {
  return stack.Parameters?.find((parameter) => parameter.ParameterKey === key)?.ParameterValue;
}

export function optionalControlPlaneParameters(): string[] {
  return controlPlaneParameterDefinitions().flatMap(({ parameter, environment }) => {
    const value = process.env[environment];
    return value ? ["--parameters", `${CONTROL_PLANE_STACK}:${parameter}=${value}`] : [];
  });
}

function controlPlaneParameterDefinitions(): Array<{ parameter: string; environment: string }> {
  return [
    { parameter: "OidcIssuer", environment: "AGENTX_OIDC_ISSUER" },
    { parameter: "OidcAudience", environment: "AGENTX_OIDC_AUDIENCE" },
    { parameter: "AdminClaim", environment: "AGENTX_ADMIN_CLAIM" },
    { parameter: "AdminValues", environment: "AGENTX_ADMIN_VALUES" },
    { parameter: "CallbackSigningKey", environment: "AGENTX_CALLBACK_SIGNING_KEY" },
    { parameter: "GitHubAppCredentialRef", environment: "AGENTX_GITHUB_APP_CREDENTIAL_REF" },
    { parameter: "GitHubAppId", environment: "AGENTX_GITHUB_APP_ID" },
    { parameter: "GitHubAppPrivateKeySecretArn", environment: "AGENTX_GITHUB_PRIVATE_KEY_SECRET_ARN" },
  ];
}

export function profileArgs(profile: string | undefined): string[] {
  return profile ? ["--profile", profile] : [];
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function formatCommand(command: string, args: readonly string[]): string {
  const sensitive = new Set(["CallbackSigningKey"]);
  return [command, ...args].map((argument) => {
    const parameter = [...sensitive].find((name) => argument.includes(`:${name}=`));
    if (parameter) return `${argument.slice(0, argument.indexOf("=") + 1)}<redacted>`;
    return /^[A-Za-z0-9_./:=@-]+$/.test(argument) ? argument : JSON.stringify(argument);
  }).join(" ");
}
