import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AGENTX_PROTOCOL_VERSION } from "../packages/contracts/src/protocol.js";
import { CONTROL_PLANE_FOUNDATION_PARAMETERS } from "../packages/contracts/src/session.js";
import {
  Runner,
  assertDigestImage,
  buildAndPushImage,
  buildAndPushWorker,
  describeStack,
  ensureRepository,
  optionalControlPlaneParameters,
  parseReleaseArgs,
  profileArgs,
  runTests,
  stackExists,
  stackOutput,
  stackParameter,
  verifyRepositoryImage,
  type ReleaseManifest,
  type ReleaseOptions,
  type StackDescription,
} from "./release-common.js";

const DEFAULT_REPOSITORY = "agentx-worker-production";
const CONTROL_PLANE_STACK = "AgentXControlPlane";
const FOUNDATION_STACK = "AgentXProductionFoundation";
// The runtime stack holds the EC2 worker settings.
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
  "packages/model-runtime",
  "packages/verifier",
  "upstream/e2e-0.20.0.tgz",
  "packages/worker",
  "packages/cli/package.json",
  "packages/orchestrator/package.json",
  "packages/broker/package.json",
  "packages/gateway/package.json",
  "packages/mcp/package.json",
  "packages/slack-service/package.json",
  "packages/local-adapters/package.json",
  "packages/aws-adapters/package.json",
  "packages/testing/package.json",
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
  "packages/model-runtime",
  "packages/verifier/package.json",
  "upstream/e2e-0.20.0.tgz",
  "packages/orchestrator",
  "packages/slack-service",
  "packages/cli/package.json",
  "packages/worker/package.json",
  "packages/broker/package.json",
  "packages/gateway/package.json",
  "packages/mcp/package.json",
  "packages/local-adapters/package.json",
  "packages/aws-adapters/package.json",
  "packages/testing/package.json",
  "infra/package.json",
] as const;

export interface ProductionReleaseOptions extends ReleaseOptions {
  reuseUnchangedWorker: boolean;
  requireExistingFoundation: boolean;
  createSlackOrchestrator: boolean;
}

export interface ProductionReleaseManifest extends ReleaseManifest {
  deploymentMode: "ec2-ebs";
  modelProvider: string;
  modelId: string;
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

/** The two worker-capability routes the control plane stack creates (infra/lib/control-plane.ts). A route with either key that was made by hand makes the stack update fail with AlreadyExists. */
export const WORKER_CAPABILITY_ROUTE_KEYS: readonly string[] = [
  "GET /v1/internal/context-tools",
  "GET /v1/internal/design-review/packet",
];

interface StackResourceSummaries { StackResourceSummaries?: Array<{ LogicalResourceId?: string; PhysicalResourceId?: string; ResourceType?: string; ResourceStatus?: string }>; NextToken?: string }
interface HttpApiRoutes { Items?: Array<{ RouteId?: string; RouteKey?: string }>; NextToken?: string }

/**
 * Read-only preflight: refuse when the control plane's HTTP API holds a worker-capability route that the AgentXControlPlane stack
 * does not own. CloudFormation would try to create the route and fail with AlreadyExists, and the template diff cannot see a
 * hand-made route. Reads only (describe-stacks, list-stack-resources, get-routes); a missing stack passes.
 * "Owns" means the route's RouteId is the PhysicalResourceId of one of the stack's resources.
 */
export function assertNoHandMadeCapabilityRoutes(runner: Pick<Runner, "aws">, options: Pick<ReleaseOptions, "region" | "profile">): void {
  if (!stackExists(runner as Runner, options.region, CONTROL_PLANE_STACK)) return;
  const resources: NonNullable<StackResourceSummaries["StackResourceSummaries"]> = [];
  let token: string | undefined;
  do {
    const page = JSON.parse(runner.aws([
      "cloudformation", "list-stack-resources", "--region", options.region, "--stack-name", CONTROL_PLANE_STACK, "--output", "json",
      ...(token === undefined ? [] : ["--starting-token", token]),
    ]).stdout) as StackResourceSummaries;
    resources.push(...(page.StackResourceSummaries ?? []));
    token = page.NextToken;
  } while (token !== undefined);
  const apiId = resources.find((row) => row.LogicalResourceId === "HttpApi" && row.ResourceType === "AWS::ApiGatewayV2::Api" && row.ResourceStatus !== "DELETE_COMPLETE")?.PhysicalResourceId;
  if (apiId === undefined) throw new Error(`${CONTROL_PLANE_STACK} has no HttpApi resource; cannot check its routes`);
  const owned = new Set(resources.filter((row) => row.ResourceStatus !== "DELETE_COMPLETE").map((row) => row.PhysicalResourceId).filter((id): id is string => id !== undefined));
  const routes: NonNullable<HttpApiRoutes["Items"]> = [];
  token = undefined;
  do {
    const page = JSON.parse(runner.aws([
      "apigatewayv2", "get-routes", "--region", options.region, "--api-id", apiId, "--output", "json",
      ...(token === undefined ? [] : ["--starting-token", token]),
    ]).stdout) as HttpApiRoutes;
    routes.push(...(page.Items ?? []));
    token = page.NextToken;
  } while (token !== undefined);
  const handMade = routes.filter((route) => route.RouteKey !== undefined && WORKER_CAPABILITY_ROUTE_KEYS.includes(route.RouteKey) && route.RouteId !== undefined && !owned.has(route.RouteId));
  if (handMade.length === 0) return;
  const profile = profileArgs(options.profile).join(" ");
  throw new Error([
    `${CONTROL_PLANE_STACK} would fail with AlreadyExists: these worker-capability routes on API ${apiId} were not created by the stack.`,
    ...handMade.map((route) => `  ${route.RouteKey ?? ""}  route id ${route.RouteId ?? ""}`),
    "Nothing was changed. Delete them right before the release (tasks cannot read sources until the stack recreates them), then run the release again:",
    ...handMade.map((route) => `  aws apigatewayv2 delete-route --region ${options.region} --api-id ${apiId} --route-id ${route.RouteId ?? ""}${profile === "" ? "" : ` ${profile}`}`),
  ].join("\n"));
}

export async function releaseProduction(
  options: ProductionReleaseOptions,
): Promise<ProductionReleaseManifest | undefined> {
  if (options.dryRun) {
    process.stdout.write([
      "AgentX production release plan:",
      "0. Read-only first: refuse if the control plane's API holds a worker-capability route the stack does not own.",
      "1. Verify the working tree and run typecheck, lint and tests.",
      "2. Apply bounded retention and immutable tags to the production ECR repository.",
      options.reuseUnchangedWorker
        ? "3. Reuse the deployed worker digest when no worker image input changed; otherwise build, smoke-test and push a linux/arm64 worker."
        : "3. Build, smoke-test and push a linux/arm64 worker by immutable digest.",
      options.requireExistingFoundation
        ? "4. Refuse to continue unless the protected VPC/EBS capacity foundation already exists."
        : "4. Create the protected VPC/EBS capacity foundation only when it does not exist.",
      "5. Refuse foundation drift on routine releases; publish the EC2 worker image and model settings to SSM.",
      "6. Update the control plane after the worker settings.",
      options.createSlackOrchestrator
        ? "7. Build or reuse the Slack orchestrator image and create or update AgentXSlackOrchestrator."
        : "7. If AgentXSlackOrchestrator exists, build or reuse its image and update it; otherwise skip it.",
      "8. Do not register, prepare, rewrite, stop, or migrate any workspace.",
      "",
    ].join("\n"));
    return undefined;
  }

  const runner = new Runner(options);
  // Read-only, before any check, build, push or deploy.
  assertNoHandMadeCapabilityRoutes(runner, options);
  const revision = runner.capture("git", ["rev-parse", "HEAD"]).stdout.trim();
  if (!options.allowDirty) {
    const dirty = runner.capture("git", ["status", "--porcelain"]).stdout.trim();
    if (dirty) throw new Error("working tree is dirty; commit changes or pass --allow-dirty explicitly");
  }
  if (!options.skipChecks) {
    runner.run("npm", ["run", "typecheck"]);
    runner.run("npm", ["run", "lint"]);
    runTests(runner);
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
    throw new Error("AgentXControlPlane must exist before the worker settings are released");
  }
  const existingSettings = stackExists(runner, options.region, RUNTIME_STACK)
    ? describeStack(runner, options.region, RUNTIME_STACK)
    : undefined;
  const modelProvider = process.env.AGENTX_MODEL_PROVIDER
    ?? (existingSettings ? stackParameter(existingSettings, "ModelProvider") : undefined);
  const modelId = process.env.AGENTX_MODEL_ID
    ?? (existingSettings ? stackParameter(existingSettings, "ModelId") : undefined);
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
    "agentxDeploymentMode=ec2-ebs",
    "-c",
    `agentxRegion=${options.region}`,
    ...profileArgs(options.profile),
    "--parameters",
    `${RUNTIME_STACK}:WorkerImageUri=${workerImage}`,
    "--parameters",
    `${RUNTIME_STACK}:ModelProvider=${modelProvider}`,
    "--parameters",
    `${RUNTIME_STACK}:ModelId=${modelId}`,
    "--outputs-file",
    "cdk.out/agentx-production-runtime-outputs.json",
  ]);

  // The control plane goes last. The worker parses invocations strictly, so a broker that sends a
  // field an older worker image does not know about fails the task. Publishing the image first
  // means every worker booted after this point is the tolerant side of the window; a worker
  // already running keeps its image until the idle reaper stops it.
  deployControlPlane(runner, options, foundation);
  const slackOrchestratorImage = await releaseSlackOrchestrator(runner, options, identity.Account, revision, foundation);

  const manifest: ProductionReleaseManifest = {
    releasedAt: new Date().toISOString(),
    gitRevision: revision,
    workerImage,
    controlPlaneUrl: stackOutput(describeStack(runner, options.region, CONTROL_PLANE_STACK), "ApiEndpoint"),
    protocolVersion: AGENTX_PROTOCOL_VERSION,
    region: options.region,
    accountId: identity.Account,
    deploymentMode: "ec2-ebs",
    modelProvider,
    modelId,
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
    "agentxDeploymentMode=ec2-ebs",
    "-c",
    `agentxRegion=${options.region}`,
    ...profileArgs(options.profile),
    ...parameter("OrchestratorImageUri", image),
    ...parameter("OrchestratorImageRepositoryName", "agentx-slack-orchestrator"),
    ...parameter("TaskRoleArn", stackOutput(controlPlane, "SlackOrchestratorTaskRoleArn")),
    ...parameter("ControlPlaneUrl", stackOutput(controlPlane, "ApiEndpoint")),
    ...parameter("SlackRequestQueueUrl", stackOutput(controlPlane, "SlackRequestQueueUrl")),
    ...parameter("SlackThreadsTableName", stackOutput(controlPlane, "SlackThreadsTableName")),
    ...parameter("TurnRecordsTableName", stackOutput(controlPlane, "TurnRecordsTableName")),
    ...parameter("ThreadSessionBucketName", stackOutput(controlPlane, "SlackThreadSessionBucketName")),
    ...parameter("SlackSecretArn", stackOutput(controlPlane, "SlackSecretArn")),
    // #1131: the Slack service's alarms (FR-045) notify the control plane's alert topic.
    ...parameter("OperatorAlertsTopicArn", stackOutput(controlPlane, "OperatorAlertsTopicArn")),
    // Spec 062 Phase 7d: the channel API's queues and the built-in Slack adapter's commands, once the control plane has them.
    // #1171: and Slack company mode's inputs (the State table and the install's team), which the control plane outputs; the two switches keep their previous values.
    ...["ChannelRequestQueueUrl", "ChannelEventQueueUrl", "SlackAdapterCommandsUrl", "SlackAdapterSecretName", "SlackCompanyStateTableName", "SlackCompanyTeamId"].flatMap((name) => {
      const value = controlPlane.Outputs?.find((output) => output.OutputKey === name)?.OutputValue;
      return value ? parameter(name, value) : [];
    }),
    ...parameter("VpcId", stackOutput(foundation, "VpcId")),
    ...parameter("PrivateSubnetIds", stackOutput(foundation, "PrivateSubnetIds")),
    "--outputs-file",
    "cdk.out/agentx-slack-orchestrator-outputs.json",
  ]);
  return image;
}

async function smokeTestSlackOrchestrator(runner: Runner, image: string): Promise<void> {
  const script = [
    "await import('@agentx/orchestrator/orchestrator');",
    "await import('@agentx/orchestrator/control-plane-api');",
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
    "agentxDeploymentMode=ec2-ebs",
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
    "agentxDeploymentMode=ec2-ebs",
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

function deployControlPlane(runner: Runner, options: ReleaseOptions, foundation: StackDescription): void {
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
    "agentxDeploymentMode=ec2-ebs",
    "-c",
    `agentxRegion=${options.region}`,
    ...profileArgs(options.profile),
    ...optionalControlPlaneParameters(),
    ...CONTROL_PLANE_FOUNDATION_PARAMETERS.flatMap((name) => ["--parameters", `${CONTROL_PLANE_STACK}:${name}=${stackOutput(foundation, name)}`]),
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
