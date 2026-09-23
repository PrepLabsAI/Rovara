import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AGENTX_PROTOCOL_VERSION } from "../packages/contracts/src/protocol.js";
import {
  Runner,
  assertDigestImage,
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
} from "./release-demo.js";

const DEFAULT_REPOSITORY = "agentx-worker-production";
const CONTROL_PLANE_STACK = "AgentXControlPlane";
const DEMO_RUNTIME_STACK = "AgentXDemoRuntime";
const FOUNDATION_STACK = "AgentXProductionFoundation";
const RUNTIME_STACK = "AgentXProductionRuntime";
export interface ProductionReleaseManifest extends ReleaseManifest {
  capacityProviderArn: string;
  deploymentMode: "instances-ebs";
}

interface CapacityProviderDescription {
  status?: string;
  statusReason?: string;
}

export function parseProductionReleaseArgs(
  argv: readonly string[],
  environment = process.env,
): ReleaseOptions {
  const options = parseReleaseArgs(argv, environment);
  return argv.includes("--repository")
    ? options
    : { ...options, repository: DEFAULT_REPOSITORY };
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
  options: ReleaseOptions,
): Promise<ProductionReleaseManifest | undefined> {
  if (options.dryRun) {
    process.stdout.write([
      "AgentX production release plan:",
      "1. Verify the working tree and run typecheck, lint and tests.",
      "2. Apply bounded retention and immutable tags to the production ECR repository.",
      "3. Build, smoke-test and push a linux/arm64 worker by immutable digest.",
      "4. Create the protected VPC/EBS capacity foundation only when it does not exist.",
      "5. Refuse foundation drift on routine releases; update only the production runtime.",
      "6. Update the control plane after the runtime is READY, then enforce 30-day log retention.",
      "7. Do not register, prepare, rewrite, stop, or migrate any workspace.",
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
  const demoRuntime = stackExists(runner, options.region, DEMO_RUNTIME_STACK)
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
