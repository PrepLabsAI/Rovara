import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AGENTX_PROTOCOL_VERSION } from "../packages/contracts/src/protocol.js";
import {
  Runner,
  assertDigestImage,
  buildAndPushImage,
  buildAndPushWorker,
  describeStack,
  ensureLogRetention,
  ensureRepository,
  optionalControlPlaneParameters,
  parseReleaseArgs,
  profileArgs,
  runtimeIdFromArn,
  stackExists,
  stackOutput,
  stackParameter,
  verifyRepositoryImage,
  waitForRuntime,
  type ReleaseManifest,
  type ReleaseOptions,
  type StackDescription,
} from "./release-demo.js";

const DEFAULT_REPOSITORY = "agentx-worker-production";
const CONTROL_PLANE_STACK = "AgentXControlPlane";
const DEMO_RUNTIME_STACK = "AgentXDemoRuntime";
const FOUNDATION_STACK = "AgentXProductionFoundation";
const RUNTIME_STACK = "AgentXProductionRuntime";
export const SLACK_ORCHESTRATOR_STACK = "AgentXSlackOrchestrator";
export const SLACK_ORCHESTRATOR_REPOSITORY = "agentx-slack-orchestrator";
const PRODUCTION_FLAGS = ["--reuse-unchanged-worker", "--require-existing-foundation", "--create-slack-orchestrator"];
const RELEASE_TAG_PATTERN = /^release-\d{8}T\d{6}Z-([a-f0-9]{7,40})$/;

// Every path that environments/base/Dockerfile copies into the worker image, plus the build files.
export const WORKER_IMAGE_INPUTS = [
  "environments/base/Dockerfile",
  ".dockerignore",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "tsconfig.base.json",
  "packages/contracts",
  "packages/worker",
  "packages/cli/package.json",
  "packages/broker/package.json",
  "packages/slack-service/package.json",
  "infra/package.json",
] as const;

// Every path that environments/slack/Dockerfile copies into the Slack orchestrator image, plus the build files.
export const SLACK_ORCHESTRATOR_IMAGE_INPUTS = [
  "environments/slack/Dockerfile",
  ".dockerignore",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "tsconfig.base.json",
  "packages/contracts",
  "packages/cli",
  "packages/slack-service",
  "packages/worker/package.json",
  "packages/broker/package.json",
  "infra/package.json",
] as const;

export interface ProductionReleaseOptions extends ReleaseOptions {
  reuseUnchangedWorker: boolean;
  requireExistingFoundation: boolean;
  createSlackOrchestrator: boolean;
}

export interface ProductionReleaseManifest extends ReleaseManifest {
  capacityProviderArn: string;
  deploymentMode: "instances-ebs";
  slackOrchestratorImage?: string;
}

interface DeployedImage {
  label: string;
  stack: string;
  parameter: string;
  repository: string;
  repositoryUri: string;
  inputs: readonly string[];
}

interface CapacityProviderDescription {
  status?: string;
  statusReason?: string;
}

export function parseProductionReleaseArgs(
  argv: readonly string[],
  environment = process.env,
): ProductionReleaseOptions {
  const options = parseReleaseArgs(argv, environment, PRODUCTION_FLAGS);
  return {
    ...options,
    ...(argv.includes("--repository") ? {} : { repository: DEFAULT_REPOSITORY }),
    reuseUnchangedWorker: argv.includes("--reuse-unchanged-worker"),
    requireExistingFoundation: argv.includes("--require-existing-foundation"),
    createSlackOrchestrator: argv.includes("--create-slack-orchestrator"),
  };
}

export function releaseRevisionFromTags(tags: readonly string[]): string | undefined {
  for (const tag of tags) {
    const revision = RELEASE_TAG_PATTERN.exec(tag)?.[1];
    if (revision) return revision;
  }
  return undefined;
}

export function reusableWorkerImage(
  runner: Runner,
  options: ReleaseOptions,
  repositoryUri: string,
): string | undefined {
  return reusableImage(runner, options, {
    label: "worker",
    stack: RUNTIME_STACK,
    parameter: "WorkerImageUri",
    repository: options.repository,
    repositoryUri,
    inputs: WORKER_IMAGE_INPUTS,
  });
}

export function reusableImage(runner: Runner, options: ReleaseOptions, image: DeployedImage): string | undefined {
  const build = (reason: string): undefined => {
    process.stdout.write(`\nBuilding a new ${image.label} image: ${reason}.\n`);
    return undefined;
  };
  if (!stackExists(runner, options.region, image.stack)) {
    return build(`${image.stack} is not deployed`);
  }
  const deployedImage = stackParameter(describeStack(runner, options.region, image.stack), image.parameter);
  if (!deployedImage?.startsWith(`${image.repositoryUri}@sha256:`)) {
    return build(`the deployed image ${deployedImage ?? "(none)"} is not in ${image.repositoryUri}`);
  }
  const digest = deployedImage.slice(deployedImage.indexOf("@") + 1);
  const described = runner.aws([
    "ecr",
    "describe-images",
    "--region",
    options.region,
    "--repository-name",
    image.repository,
    "--image-ids",
    `imageDigest=${digest}`,
    "--query",
    "imageDetails[0].imageTags",
    "--output",
    "json",
  ], true);
  if (described.status !== 0) {
    return build(`ECR could not describe the deployed image ${digest}`);
  }
  const revision = releaseRevisionFromTags((JSON.parse(described.stdout) as string[] | null) ?? []);
  if (!revision) {
    return build(`the deployed image ${digest} has no release-<time>-<commit> tag`);
  }
  if (runner.capture("git", ["cat-file", "-e", `${revision}^{commit}`], true).status !== 0) {
    return build(`the deployed commit ${revision} is not in this checkout's history`);
  }
  const diff = runner.capture("git", ["diff", "--quiet", revision, "HEAD", "--", ...image.inputs], true);
  if (diff.status === 1) return build(`${image.label} image inputs changed since ${revision}`);
  if (diff.status !== 0) return build(`git could not compare ${revision} with HEAD`);
  process.stdout.write(
    `\nReusing deployed ${image.label} image ${deployedImage}: no ${image.label} image inputs changed since ${revision}.\n`,
  );
  return deployedImage;
}

export function capacityProviderIdFromArn(capacityProviderArn: string): string {
  const marker = ":capacity-provider/";
  const index = capacityProviderArn.lastIndexOf(marker);
  const capacityProviderId = index < 0 ? "" : capacityProviderArn.slice(index + marker.length);
  if (!/^[A-Za-z][A-Za-z0-9_]{0,47}-[A-Za-z0-9]{10}$/.test(capacityProviderId)) {
    throw new Error(`invalid AgentCore capacity provider ARN: ${capacityProviderArn}`);
  }
  return capacityProviderId;
}

export async function releaseProduction(
  options: ProductionReleaseOptions,
): Promise<ProductionReleaseManifest | undefined> {
  if (options.dryRun) {
    process.stdout.write([
      "AgentX production release plan:",
      "1. Verify the working tree and run typecheck, lint and tests.",
      "2. Apply bounded retention and immutable tags to the production ECR repository.",
      options.reuseUnchangedWorker
        ? "3. Reuse the deployed worker digest when no worker image input changed; otherwise build, smoke-test and push a linux/arm64 worker."
        : "3. Build, smoke-test and push a linux/arm64 worker by immutable digest.",
      options.requireExistingFoundation
        ? "4. Refuse to continue unless the protected VPC/EBS capacity foundation already exists."
        : "4. Create the protected VPC/EBS capacity foundation only when it does not exist.",
      "5. Refuse foundation drift on routine releases; update only the production runtime.",
      "6. Update the control plane after the runtime is READY, then enforce 30-day log retention.",
      options.createSlackOrchestrator
        ? "7. Build or reuse the Slack orchestrator image and create or update AgentXSlackOrchestrator."
        : "7. If AgentXSlackOrchestrator exists, build or reuse its image and update it; otherwise skip it.",
      "8. Do not register, prepare, rewrite, stop, or migrate any workspace.",
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

  const identity = JSON.parse(
    runner.aws(["sts", "get-caller-identity", "--output", "json"]).stdout,
  ) as { Account?: string };
  if (!identity.Account) throw new Error("AWS did not return an account ID");
  const repositoryUri = `${identity.Account}.dkr.ecr.${options.region}.amazonaws.com/${options.repository}`;
  ensureRepository(runner, options);

  const workerImage = options.workerImage
    ?? (options.reuseUnchangedWorker ? reusableWorkerImage(runner, options, repositoryUri) : undefined)
    ?? await buildAndPushWorker(runner, options, repositoryUri, revision);
  assertDigestImage(workerImage, repositoryUri);
  verifyRepositoryImage(runner, options, workerImage);

  runner.run("npm", ["run", "build"]);
  if (!stackExists(runner, options.region, CONTROL_PLANE_STACK)) {
    throw new Error("AgentXControlPlane must exist before the production runtime is released");
  }
  const controlPlane = describeStack(runner, options.region, CONTROL_PLANE_STACK);
  const controlPlaneUrl = stackOutput(controlPlane, "ApiEndpoint");
  const existingRuntime = stackExists(runner, options.region, RUNTIME_STACK)
    ? describeStack(runner, options.region, RUNTIME_STACK)
    : undefined;
  // The retired demo runtime only supplies model defaults for the first production release.
  const demoRuntime = !existingRuntime && stackExists(runner, options.region, DEMO_RUNTIME_STACK)
    ? describeStack(runner, options.region, DEMO_RUNTIME_STACK)
    : undefined;
  const modelProvider = process.env.AGENTX_MODEL_PROVIDER
    ?? (existingRuntime ? stackParameter(existingRuntime, "ModelProvider") : undefined)
    ?? (demoRuntime ? stackParameter(demoRuntime, "ModelProvider") : undefined);
  const modelId = process.env.AGENTX_MODEL_ID
    ?? (existingRuntime ? stackParameter(existingRuntime, "ModelId") : undefined)
    ?? (demoRuntime ? stackParameter(demoRuntime, "ModelId") : undefined);
  if (!modelProvider || !modelId) {
    throw new Error("AGENTX_MODEL_PROVIDER and AGENTX_MODEL_ID are required for the first production release");
  }

  if (!stackExists(runner, options.region, FOUNDATION_STACK)) {
    if (options.requireExistingFoundation) {
      throw new Error(`${FOUNDATION_STACK} does not exist; create it with a reviewed manual release first`);
    }
    deployFoundation(runner, options);
  } else {
    assertFoundationHasNoPendingChanges(runner, options);
  }
  const foundation = describeStack(runner, options.region, FOUNDATION_STACK);
  const capacityProviderArn = stackOutput(foundation, "CapacityProviderArn");
  await waitForCapacityProvider(runner, options.region, capacityProviderArn);

  runner.run("npx", [
    "cdk",
    "deploy",
    RUNTIME_STACK,
    "--exclusively",
    "--app",
    "node infra/dist/bin/agentx.js",
    "--require-approval",
    "never",
    "-c",
    "agentxDeploymentMode=instances-ebs",
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
    "--parameters",
    `${RUNTIME_STACK}:CapacityProviderArn=${capacityProviderArn}`,
    "--outputs-file",
    "cdk.out/agentx-production-runtime-outputs.json",
  ]);

  const runtimeStack = describeStack(runner, options.region, RUNTIME_STACK);
  const runtimeArn = stackOutput(runtimeStack, "AgentRuntimeArn");
  const runtimeId = runtimeIdFromArn(runtimeArn);
  const runtime = await waitForRuntime(runner, options.region, runtimeId, workerImage);
  ensureLogRetention(
    runner,
    options.region,
    `/aws/bedrock-agentcore/runtimes/${runtimeId}-DEFAULT`,
  );

  deployControlPlane(runner, options);
  const deployedControlPlaneUrl = stackOutput(
    describeStack(runner, options.region, CONTROL_PLANE_STACK),
    "ApiEndpoint",
  );
  if (deployedControlPlaneUrl !== controlPlaneUrl) {
    throw new Error(
      "the control-plane URL changed; rerun the production release so the runtime receives the new callback URL",
    );
  }
  const slackOrchestratorImage = await releaseSlackOrchestrator(runner, options, identity.Account, revision, foundation);

  const manifest: ProductionReleaseManifest = {
    releasedAt: new Date().toISOString(),
    gitRevision: revision,
    workerImage,
    controlPlaneUrl,
    runtimeArn,
    runtimeVersion: runtime.agentRuntimeVersion ?? "unknown",
    protocolVersion: AGENTX_PROTOCOL_VERSION,
    region: options.region,
    accountId: identity.Account,
    capacityProviderArn,
    deploymentMode: "instances-ebs",
    ...(slackOrchestratorImage === undefined ? {} : { slackOrchestratorImage }),
  };
  mkdirSync(resolve("cdk.out"), { recursive: true });
  writeFileSync(
    resolve("cdk.out/agentx-production-release.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600 },
  );
  process.stdout.write(`\nAgentX production release complete:\n${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

async function releaseSlackOrchestrator(
  runner: Runner,
  options: ProductionReleaseOptions,
  accountId: string,
  revision: string,
  foundation: StackDescription,
): Promise<string | undefined> {
  const exists = stackExists(runner, options.region, SLACK_ORCHESTRATOR_STACK);
  if (!exists && !options.createSlackOrchestrator) {
    process.stdout.write(
      `\nSkipping ${SLACK_ORCHESTRATOR_STACK}: it does not exist. Create it once with --create-slack-orchestrator.\n`,
    );
    return undefined;
  }
  const imageOptions: ReleaseOptions = { ...options, repository: SLACK_ORCHESTRATOR_REPOSITORY };
  const repositoryUri = `${accountId}.dkr.ecr.${options.region}.amazonaws.com/${SLACK_ORCHESTRATOR_REPOSITORY}`;
  ensureRepository(runner, imageOptions);
  const image = (options.reuseUnchangedWorker
    ? reusableImage(runner, imageOptions, {
        label: "Slack orchestrator",
        stack: SLACK_ORCHESTRATOR_STACK,
        parameter: "OrchestratorImageUri",
        repository: SLACK_ORCHESTRATOR_REPOSITORY,
        repositoryUri,
        inputs: SLACK_ORCHESTRATOR_IMAGE_INPUTS,
      })
    : undefined)
    ?? await buildAndPushImage(runner, imageOptions, {
      repository: SLACK_ORCHESTRATOR_REPOSITORY,
      repositoryUri,
      dockerfile: "environments/slack/Dockerfile",
      localName: "agentx-slack-orchestrator",
      smokeTest: smokeTestSlackOrchestrator,
    }, revision);
  assertDigestImage(image, repositoryUri);
  verifyRepositoryImage(runner, imageOptions, image);

  const controlPlane = describeStack(runner, options.region, CONTROL_PLANE_STACK);
  const parameter = (name: string, value: string) => ["--parameters", `${SLACK_ORCHESTRATOR_STACK}:${name}=${value}`];
  runner.run("npx", [
    "cdk",
    "deploy",
    SLACK_ORCHESTRATOR_STACK,
    "--exclusively",
    "--app",
    "node infra/dist/bin/agentx.js",
    "--require-approval",
    "never",
    "-c",
    "agentxDeploymentMode=instances-ebs",
    "-c",
    `agentxRegion=${options.region}`,
    ...profileArgs(options.profile),
    ...parameter("OrchestratorImageUri", image),
    ...parameter("TaskRoleArn", stackOutput(controlPlane, "SlackOrchestratorTaskRoleArn")),
    ...parameter("ControlPlaneUrl", stackOutput(controlPlane, "ApiEndpoint")),
    ...parameter("SlackRequestQueueUrl", stackOutput(controlPlane, "SlackRequestQueueUrl")),
    ...parameter("SlackThreadsTableName", stackOutput(controlPlane, "SlackThreadsTableName")),
    ...parameter("ThreadSessionBucketName", stackOutput(controlPlane, "SlackThreadSessionBucketName")),
    ...parameter("SlackSecretArn", stackOutput(controlPlane, "SlackSecretArn")),
    ...parameter("VpcId", stackOutput(foundation, "VpcId")),
    ...parameter("PrivateSubnetIds", stackOutput(foundation, "PrivateSubnetIds")),
    "--outputs-file",
    "cdk.out/agentx-slack-orchestrator-outputs.json",
  ]);
  return image;
}

async function smokeTestSlackOrchestrator(runner: Runner, image: string): Promise<void> {
  const script = [
    "await import('@agentx/cli/orchestrator');",
    "await import('@agentx/cli/control-plane-api');",
    "await import('/opt/agentx/packages/slack-service/dist/consumer.js');",
    "console.log('slack orchestrator modules ok');",
  ].join(" ");
  const result = runner.capture("docker", ["run", "--rm", image, "node", "--input-type=module", "-e", script], true);
  if (result.status !== 0 || !result.stdout.includes("slack orchestrator modules ok")) {
    process.stderr.write(result.stderr);
    throw new Error("Slack orchestrator image smoke test failed");
  }
}

function deployFoundation(runner: Runner, options: ReleaseOptions): void {
  runner.run("npx", [
    "cdk",
    "deploy",
    FOUNDATION_STACK,
    "--exclusively",
    "--app",
    "node infra/dist/bin/agentx.js",
    "--require-approval",
    "never",
    "-c",
    "agentxDeploymentMode=instances-ebs",
    "-c",
    `agentxRegion=${options.region}`,
    ...profileArgs(options.profile),
    "--outputs-file",
    "cdk.out/agentx-production-foundation-outputs.json",
  ]);
}

function assertFoundationHasNoPendingChanges(runner: Runner, options: ReleaseOptions): void {
  const result = runner.capture("npx", [
    "cdk",
    "diff",
    FOUNDATION_STACK,
    "--app",
    "node infra/dist/bin/agentx.js",
    "--fail",
    "-c",
    "agentxDeploymentMode=instances-ebs",
    "-c",
    `agentxRegion=${options.region}`,
    ...profileArgs(options.profile),
  ], true);
  if (result.status !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    throw new Error(
      "production foundation drift detected; review and deploy it separately before releasing application code",
    );
  }
}

async function waitForCapacityProvider(
  runner: Runner,
  region: string,
  capacityProviderArn: string,
): Promise<void> {
  const capacityProviderId = capacityProviderIdFromArn(capacityProviderArn);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = runner.aws([
      "bedrock-agentcore-control",
      "get-capacity-provider",
      "--region",
      region,
      "--capacity-provider-id",
      capacityProviderId,
      "--output",
      "json",
    ]);
    const capacityProvider = JSON.parse(result.stdout) as CapacityProviderDescription;
    if (capacityProvider.status === "READY") return;
    if (capacityProvider.status === "CREATE_FAILED" || capacityProvider.status === "UPDATE_FAILED") {
      throw new Error(
        `capacity provider entered ${capacityProvider.status}: ${capacityProvider.statusReason ?? "no reason returned"}`,
      );
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10_000));
  }
  throw new Error("AgentCore capacity provider did not become READY within ten minutes");
}

function deployControlPlane(runner: Runner, options: ReleaseOptions): void {
  runner.run("npx", [
    "cdk",
    "deploy",
    CONTROL_PLANE_STACK,
    "--exclusively",
    "--app",
    "node infra/dist/bin/agentx.js",
    "--require-approval",
    "never",
    "-c",
    "agentxDeploymentMode=instances-ebs",
    "-c",
    `agentxRegion=${options.region}`,
    ...profileArgs(options.profile),
    ...optionalControlPlaneParameters(),
    "--outputs-file",
    "cdk.out/agentx-control-plane-outputs.json",
  ]);
}

function usage(): string {
  return `Usage: npm run release:prod -- [options]\n\n` +
    `Options:\n` +
    `  --region <region>          AWS region (default: us-east-1)\n` +
    `  --profile <profile>        AWS CLI/CDK profile\n` +
    `  --repository <name>        ECR repository (default: agentx-worker-production)\n` +
    `  --worker-image <digest>    Deploy an already-published image from that repository\n` +
    `  --reuse-unchanged-worker   Reuse the deployed worker and Slack orchestrator images when their inputs are unchanged\n` +
    `  --require-existing-foundation  Fail instead of creating the production foundation\n` +
    `  --create-slack-orchestrator    Create AgentXSlackOrchestrator if it does not exist (first release only)\n` +
    `  --allow-dirty              Explicitly allow releasing an uncommitted checkout\n` +
    `  --skip-checks              Skip typecheck, lint, and tests\n` +
    `  --dry-run                  Print the release stages without changing AWS\n` +
    `  --help                     Show this help\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--help")) {
    process.stdout.write(usage());
  } else {
    releaseProduction(parseProductionReleaseArgs(process.argv.slice(2))).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`AgentX production release failed: ${message}\n`);
      process.exitCode = 1;
    });
  }
}
