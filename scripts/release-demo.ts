import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AGENTX_PROTOCOL_VERSION } from "../packages/contracts/src/protocol.js";

const DEFAULT_REGION = "us-east-1";
const DEFAULT_REPOSITORY = "agentx-worker-demo";
const CONTROL_PLANE_STACK = "AgentXControlPlane";
const RUNTIME_STACK = "AgentXDemoRuntime";
const LOG_RETENTION_DAYS = 30;

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
  runtimeArn: string;
  runtimeVersion: string;
  protocolVersion: number;
  region: string;
  accountId: string;
}

export interface StackDescription {
  Parameters?: Array<{ ParameterKey?: string; ParameterValue?: string }>;
  Outputs?: Array<{ OutputKey?: string; OutputValue?: string }>;
}

export interface RuntimeDescription {
  status?: string;
  agentRuntimeVersion?: string;
  agentRuntimeArtifact?: { containerConfiguration?: { containerUri?: string } };
}

interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
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

export function runtimeIdFromArn(runtimeArn: string): string {
  const marker = ":runtime/";
  const index = runtimeArn.lastIndexOf(marker);
  const runtimeId = index < 0 ? "" : runtimeArn.slice(index + marker.length);
  if (!/^[A-Za-z0-9_-]+$/.test(runtimeId)) throw new Error(`invalid AgentCore runtime ARN: ${runtimeArn}`);
  return runtimeId;
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

export async function releaseDemo(options: ReleaseOptions): Promise<ReleaseManifest | undefined> {
  if (options.dryRun) {
    process.stdout.write([
      "AgentX demo release plan:",
      "1. Verify the working tree and run typecheck, lint and tests.",
      "2. Apply immutable tags and infra/ecr-lifecycle-policy.json to ECR.",
      "3. Build and smoke-test a linux/arm64 worker, then push a unique release tag.",
      "4. Update an existing AgentXDemoRuntime before its control plane to avoid protocol skew.",
      "5. Deploy AgentXControlPlane, preserving existing secrets and parameters.",
      "6. Verify runtime READY, exact image digest, and 30-day runtime-log retention.",
      "",
    ].join("\n"));
    return undefined;
  }

  const runner = new Runner(options);
  const revision = runner.capture("git", ["rev-parse", "HEAD"]).stdout.trim();
  if (!options.allowDirty) {
    const dirty = runner.capture("git", ["status", "--porcelain"]).stdout.trim();
    if (dirty) throw new Error("working tree is dirty; commit changes or pass --allow-dirty explicitly");
  }
  if (!options.skipChecks) {
    runner.run("npm", ["run", "typecheck"]);
    runner.run("npm", ["run", "lint"]);
    runner.run("npm", ["test"]);
  }

  const identity = parseJson<{ Account?: string }>(
    runner.aws(["sts", "get-caller-identity", "--output", "json"]).stdout,
  );
  if (!identity.Account) throw new Error("AWS did not return an account ID");
  const repositoryUri = `${identity.Account}.dkr.ecr.${options.region}.amazonaws.com/${options.repository}`;
  ensureRepository(runner, options);

  const workerImage = options.workerImage ?? await buildAndPushWorker(runner, options, repositoryUri, revision);
  assertDigestImage(workerImage, repositoryUri);
  verifyRepositoryImage(runner, options, workerImage);

  runner.run("npm", ["run", "build"]);
  const controlPlaneExists = stackExists(runner, options.region, CONTROL_PLANE_STACK);
  const runtimeExists = stackExists(runner, options.region, RUNTIME_STACK);
  if (runtimeExists && !controlPlaneExists) {
    throw new Error("runtime stack exists without its control plane; repair that partial deployment first");
  }
  const existingControlPlane = controlPlaneExists
    ? describeStack(runner, options.region, CONTROL_PLANE_STACK)
    : undefined;
  const existingRuntime = runtimeExists
    ? describeStack(runner, options.region, RUNTIME_STACK)
    : undefined;
  const modelProvider = process.env.AGENTX_MODEL_PROVIDER
    ?? (existingRuntime ? stackParameter(existingRuntime, "ModelProvider") : undefined);
  const modelId = process.env.AGENTX_MODEL_ID
    ?? (existingRuntime ? stackParameter(existingRuntime, "ModelId") : undefined);
  if (!modelProvider || !modelId) {
    throw new Error("AGENTX_MODEL_PROVIDER and AGENTX_MODEL_ID are required for the first runtime deployment");
  }

  let controlPlaneUrl: string;
  let deployedRuntime: { runtimeArn: string; runtime: RuntimeDescription };
  if (existingControlPlane && existingRuntime) {
    controlPlaneUrl = stackOutput(existingControlPlane, "ApiEndpoint");
    deployedRuntime = await deployRuntime(
      runner,
      options,
      workerImage,
      controlPlaneUrl,
      modelProvider,
      modelId,
    );
    // Runtime first, then the control plane: a strictly parsed invocation field must reach a worker
    // that already knows it. Creating both for the first time has no old worker, so it may differ.
    deployControlPlane(runner, options, true);
    const updatedUrl = stackOutput(describeStack(runner, options.region, CONTROL_PLANE_STACK), "ApiEndpoint");
    if (updatedUrl !== controlPlaneUrl) {
      controlPlaneUrl = updatedUrl;
      deployedRuntime = await deployRuntime(
        runner,
        options,
        workerImage,
        controlPlaneUrl,
        modelProvider,
        modelId,
      );
    }
  } else {
    deployControlPlane(runner, options, controlPlaneExists);
    controlPlaneUrl = stackOutput(describeStack(runner, options.region, CONTROL_PLANE_STACK), "ApiEndpoint");
    deployedRuntime = await deployRuntime(
      runner,
      options,
      workerImage,
      controlPlaneUrl,
      modelProvider,
      modelId,
    );
  }

  const { runtimeArn, runtime } = deployedRuntime;
  const manifest: ReleaseManifest = {
    releasedAt: new Date().toISOString(),
    gitRevision: revision,
    workerImage,
    controlPlaneUrl,
    runtimeArn,
    runtimeVersion: runtime.agentRuntimeVersion ?? "unknown",
    protocolVersion: AGENTX_PROTOCOL_VERSION,
    region: options.region,
    accountId: identity.Account,
  };
  mkdirSync(resolve("cdk.out"), { recursive: true });
  writeFileSync(resolve("cdk.out/agentx-release.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
  process.stdout.write(`\nAgentX release complete:\n${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function deployControlPlane(runner: Runner, options: ReleaseOptions, alreadyExists: boolean): void {
  const controlPlaneParameters = alreadyExists
    ? optionalControlPlaneParameters()
    : requiredControlPlaneParameters();
  runner.run("npx", [
    "cdk",
    "deploy",
    CONTROL_PLANE_STACK,
    "--app",
    "node infra/dist/bin/agentx.js",
    "--require-approval",
    "never",
    "-c",
    "agentxDeploymentMode=demo-microvm",
    "-c",
    `agentxRegion=${options.region}`,
    ...profileArgs(options.profile),
    ...controlPlaneParameters,
    "--outputs-file",
    "cdk.out/agentx-control-plane-outputs.json",
  ]);
}

async function deployRuntime(
  runner: Runner,
  options: ReleaseOptions,
  workerImage: string,
  controlPlaneUrl: string,
  modelProvider: string,
  modelId: string,
): Promise<{ runtimeArn: string; runtime: RuntimeDescription }> {
  runner.run("npx", [
    "cdk",
    "deploy",
    RUNTIME_STACK,
    "--app",
    "node infra/dist/bin/agentx.js",
    "--require-approval",
    "never",
    "-c",
    "agentxDeploymentMode=demo-microvm",
    "-c",
    `agentxRegion=${options.region}`,
    ...profileArgs(options.profile),
    "--parameters",
    `${RUNTIME_STACK}:WorkerImageUri=${workerImage}`,
    "--parameters",
    `${RUNTIME_STACK}:ControlPlaneUrl=${controlPlaneUrl}`,
    "--parameters",
    `${RUNTIME_STACK}:ModelProvider=${modelProvider}`,
    "--parameters",
    `${RUNTIME_STACK}:ModelId=${modelId}`,
    "--outputs-file",
    "cdk.out/agentx-demo-outputs.json",
  ]);
  const runtimeStack = describeStack(runner, options.region, RUNTIME_STACK);
  const runtimeArn = stackOutput(runtimeStack, "AgentRuntimeArn");
  const runtimeId = runtimeIdFromArn(runtimeArn);
  const runtime = await waitForRuntime(runner, options.region, runtimeId, workerImage);
  const logGroup = `/aws/bedrock-agentcore/runtimes/${runtimeId}-DEFAULT`;
  ensureLogRetention(runner, options.region, logGroup);
  return { runtimeArn, runtime };
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
  const tag = releaseTag(new Date(), revision);
  const localImage = `${image.localName}:${tag}`;
  const remoteImage = `${image.repositoryUri}:${tag}`;
  runner.run("docker", [
    "buildx",
    "build",
    "--platform",
    "linux/arm64",
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
  runner.run("docker", ["run", "--detach", "--rm", "--name", container, "--publish", "127.0.0.1::8080", image]);
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

function requiredControlPlaneParameters(): string[] {
  const missing = controlPlaneParameterDefinitions()
    .filter(({ environment }) => !process.env[environment])
    .map(({ environment }) => environment);
  if (missing.length > 0) {
    throw new Error(`first control-plane deployment requires: ${missing.join(", ")}`);
  }
  return optionalControlPlaneParameters();
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

export async function waitForRuntime(
  runner: Runner,
  region: string,
  runtimeId: string,
  expectedImage: string,
): Promise<RuntimeDescription> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = runner.aws([
      "bedrock-agentcore-control",
      "get-agent-runtime",
      "--region",
      region,
      "--agent-runtime-id",
      runtimeId,
      "--output",
      "json",
    ]);
    const runtime = parseJson<RuntimeDescription>(result.stdout);
    if (runtime.status === "READY") {
      const deployedImage = runtime.agentRuntimeArtifact?.containerConfiguration?.containerUri;
      if (deployedImage !== expectedImage) {
        throw new Error(`runtime READY with unexpected worker image ${deployedImage ?? "missing"}`);
      }
      return runtime;
    }
    if (runtime.status === "CREATE_FAILED" || runtime.status === "UPDATE_FAILED") {
      throw new Error(`AgentCore runtime entered ${runtime.status}`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10_000));
  }
  throw new Error("AgentCore runtime did not become READY within ten minutes");
}

export function ensureLogRetention(runner: Runner, region: string, logGroup: string): void {
  const describe = runner.aws([
    "logs",
    "describe-log-groups",
    "--region",
    region,
    "--log-group-name-prefix",
    logGroup,
    "--query",
    `logGroups[?logGroupName=='${logGroup}'].logGroupName | [0]`,
    "--output",
    "text",
  ]);
  if (describe.stdout.trim() !== logGroup) {
    runner.aws(["logs", "create-log-group", "--region", region, "--log-group-name", logGroup]);
  }
  runner.aws([
    "logs",
    "put-retention-policy",
    "--region",
    region,
    "--log-group-name",
    logGroup,
    "--retention-in-days",
    String(LOG_RETENTION_DAYS),
  ]);
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

function usage(): string {
  return `Usage: npm run release:demo -- [options]\n\n` +
    `Options:\n` +
    `  --region <region>          AWS region (default: us-east-1)\n` +
    `  --profile <profile>        AWS CLI/CDK profile\n` +
    `  --repository <name>        ECR repository (default: agentx-worker-demo)\n` +
    `  --worker-image <digest>    Deploy an already-published image from that repository\n` +
    `  --allow-dirty              Explicitly allow releasing an uncommitted checkout\n` +
    `  --skip-checks              Skip typecheck, lint, and tests\n` +
    `  --dry-run                  Print the release stages without changing AWS\n` +
    `  --help                     Show this help\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--help")) {
    process.stdout.write(usage());
  } else {
    releaseDemo(parseReleaseArgs(process.argv.slice(2))).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`AgentX release failed: ${message}\n`);
      process.exitCode = 1;
    });
  }
}
