import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
// Nothing from packages/ is imported at the top of this file: the release builds run `npm ci` and then this script on a fresh checkout, with no `dist/` anywhere, and contracts source reaches
// workspace packages through their built `dist/` (F3 cut 1). The two contracts constants it needs, and the public API URL names and guards (loadPublicApiUrlContracts), are loaded after the build step below.
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

// Set by releaseProduction once the build has run (see the comment at the top of this file); deployControlPlane runs only after that.
let CONTROL_PLANE_FOUNDATION_PARAMETERS: readonly string[] = [];
// CODE-PUBLIC-URL: the address stack's names and the PublicApiUrl guards, from packages/contracts. Not imported at the top (see the comment at the top of this file): loadPublicApiUrlContracts sets them once
// the build has run, before readPublicApiInputs, plannedPublicApiUrl or deployControlPlane use any of them. contracts/src/api-address.ts and public-api-url.ts import only zod, never a package's dist/.
const NOT_LOADED = "loadPublicApiUrlContracts must run (after the build) before the public API URL is planned";
let LEGACY_ADDRESS_STACK_NAME = "";
let PUBLIC_API_ORIGIN_OUTPUT = "";
let PUBLIC_API_URL_PARAMETER = "";
let publicApiUrlChangeWarning: (current: string | undefined, proposed: string | undefined) => string | undefined = () => { throw new Error(NOT_LOADED); };
let resolvePublicApiUrl: (input: { addressOrigin: string | undefined; proposed?: string | undefined; required?: boolean }) => string | undefined = () => { throw new Error(NOT_LOADED); };

/** Loads the public API URL names and guards. Idempotent; releaseProduction calls it right after `npm run build`, a test calls it before `plannedPublicApiUrl`. */
export async function loadPublicApiUrlContracts(): Promise<void> {
  ({ LEGACY_ADDRESS_STACK_NAME, PUBLIC_API_ORIGIN_OUTPUT } = await import("../packages/contracts/src/api-address.js"));
  ({ PUBLIC_API_URL_PARAMETER, publicApiUrlChangeWarning, resolvePublicApiUrl } = await import("../packages/contracts/src/public-api-url.js"));
}
const DEFAULT_REPOSITORY = "agentx-worker-production";
const CONTROL_PLANE_STACK = "AgentXControlPlane";
const FOUNDATION_STACK = "AgentXProductionFoundation";
// The runtime stack holds the EC2 worker settings.
const RUNTIME_STACK = "AgentXProductionRuntime";
export const SLACK_ORCHESTRATOR_STACK = "AgentXSlackOrchestrator";
export const SLACK_ORCHESTRATOR_REPOSITORY = "agentx-slack-orchestrator";
// #1277: the firewall setting the live foundation was deployed with (infra/lib/agent-dns-firewall.ts; tests/contract/release-dns-firewall.test.ts keeps the names in step). Not
// imported from infra: this script loads before the build.
const DNS_FIREWALL_CONTEXT_KEY = "agentxDnsFirewall";
const EGRESS_ALLOW_DOMAINS_CONTEXT_KEY = "agentxEgressAllowDomains";
const DNS_FIREWALL_MODE_OUTPUT = "DnsFirewallMode";
const EGRESS_ALLOW_DOMAINS_OUTPUT = "EgressAllowDomains";
// CODE-PUBLIC-URL: --require-public-api-address refuses a release that has no address stack to take the permanent address from; --confirm-public-api-url-change names the issuer change a first or changed address is.
const PRODUCTION_FLAGS = ["--reuse-unchanged-worker", "--require-existing-foundation", "--create-slack-orchestrator", "--require-public-api-address", "--confirm-public-api-url-change"];
const RELEASE_TAG_PATTERN = /^release-\d{8}T\d{6}Z-([a-f0-9]{7,40})$/;

// Every path that environments/base/Dockerfile copies into the worker image, plus the build files.
export const WORKER_IMAGE_INPUTS = [
  "environments/base/Dockerfile",
  ".dockerignore",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "tsconfig.base.json",
  "packages/code-api",
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
  "packages/code-api",
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
  /** CODE-PUBLIC-URL: this install is declared to have an address stack (AgentXApiAddress); a release without one is refused. */
  requirePublicApiAddress: boolean;
  /** CODE-PUBLIC-URL: the operator confirms that a first or changed PublicApiUrl is an issuer change (Cloud's CodeUrl moves in the same window). */
  confirmPublicApiUrlChange: boolean;
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
    requirePublicApiAddress: argv.includes("--require-public-api-address"),
    confirmPublicApiUrlChange: argv.includes("--confirm-public-api-url-change"),
  };
}

function describeIfExists(runner: Runner, region: string, stack: string): StackDescription | undefined {
  return stackExists(runner, region, stack) ? describeStack(runner, region, stack) : undefined;
}

/** CODE-PUBLIC-URL: what plannedPublicApiUrl needs, read once from AWS (read-only) before anything is deployed. */
function readPublicApiInputs(runner: Runner, options: ProductionReleaseOptions): Parameters<typeof plannedPublicApiUrl>[0] {
  return {
    address: describeIfExists(runner, options.region, LEGACY_ADDRESS_STACK_NAME),
    controlPlane: describeIfExists(runner, options.region, CONTROL_PLANE_STACK),
    foundation: describeIfExists(runner, options.region, FOUNDATION_STACK),
    proposed: process.env.AGENTX_PUBLIC_API_URL,
    required: options.requirePublicApiAddress,
    confirmChange: options.confirmPublicApiUrlChange,
  };
}

/** The control plane deploy's `--parameters` for PublicApiUrl: none while the release sends nothing. */
function publicApiUrlArguments(publicApiUrl: string | undefined): string[] {
  return publicApiUrl === undefined ? [] : ["--parameters", `${CONTROL_PLANE_STACK}:${PUBLIC_API_URL_PARAMETER}=${publicApiUrl}`];
}

/** Where the Slack orchestrator reaches the control plane: the permanent address where the install has one (its host is on the firewall's list, checked by plannedPublicApiUrl), else the API's own host. */
function orchestratorControlPlaneUrl(publicApiUrl: string | undefined, apiEndpoint: () => string): string {
  return publicApiUrl === undefined || publicApiUrl === "" ? apiEndpoint() : publicApiUrl;
}

function assertChangeConfirmed(controlPlane: StackDescription | undefined, value: string, confirmed: boolean): void {
  if (controlPlane === undefined) return;
  const warning = publicApiUrlChangeWarning(stackParameter(controlPlane, PUBLIC_API_URL_PARAMETER) ?? "", value);
  if (warning !== undefined && !confirmed) throw new Error(`${warning}; nothing was changed. Pass --confirm-public-api-url-change once Cloud's CodeUrl is ready to move`);
}

function assertFirewallAllows(foundation: StackDescription | undefined, value: string): void {
  if (foundation === undefined || value === "" || foundation.Outputs?.some((output) => output.OutputKey === "ProjectAllowListId") !== true) return;
  const onFirewall = stackParameter(foundation, PUBLIC_API_URL_PARAMETER) ?? "";
  if (onFirewall === value) return;
  throw new Error(`${FOUNDATION_STACK}'s DNS firewall allows ${onFirewall === "" ? "no public API host" : onFirewall} but this release's PublicApiUrl is ${value}: workers and the Slack orchestrator could not reach the control plane. Deploy the foundation with ${PUBLIC_API_URL_PARAMETER}=${value} first`);
}

/**
 * CODE-PUBLIC-URL (DEC 254zzz505, rev 9.2): the PublicApiUrl this release sends to the control plane (and expects of the foundation's DNS firewall), or undefined to send nothing (an install
 * with no address stack, which keeps its raw API host: no behaviour change). Where the address stack exists its PublicApiOrigin output is the only value a create or an update may carry:
 * an empty output, or an `AGENTX_PUBLIC_API_URL` that is empty or differs from it, is refused (a rebuilt control plane would otherwise get the empty default and fall back to the raw host).
 * A first or changed value on a running control plane is an issuer change and needs the explicit confirm. Where the foundation has the DNS firewall, its PublicApiUrl must already be the same
 * value: production runs it in `block`, and without the host on its allow list every worker callback and every Slack orchestrator call would be refused.
 */
export function plannedPublicApiUrl(input: {
  address: StackDescription | undefined;
  controlPlane: StackDescription | undefined;
  foundation: StackDescription | undefined;
  proposed: string | undefined;
  required: boolean;
  confirmChange: boolean;
}): string | undefined {
  const origin = input.address === undefined ? undefined : input.address.Outputs?.find((output) => output.OutputKey === PUBLIC_API_ORIGIN_OUTPUT)?.OutputValue ?? "";
  const value = resolvePublicApiUrl({ addressOrigin: origin, proposed: input.proposed, required: input.required });
  if (value === undefined) return undefined;
  assertChangeConfirmed(input.controlPlane, value, input.confirmChange);
  assertFirewallAllows(input.foundation, value);
  return value;
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
      "5. Refuse foundation drift on routine releases; publish the EC2 worker image and model settings to SSM.",
      "5b. Where AgentXApiAddress exists, refuse an empty or different PublicApiUrl, and a foundation firewall that does not allow its host.",
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
  const { AGENTX_PROTOCOL_VERSION } = await import("../packages/contracts/src/protocol.js");
  ({ CONTROL_PLANE_FOUNDATION_PARAMETERS } = await import("../packages/contracts/src/session.js"));
  await loadPublicApiUrlContracts();
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

  // CODE-PUBLIC-URL: decided before anything is deployed, so a refusal leaves AWS as it was.
  const publicApiUrl = plannedPublicApiUrl(readPublicApiInputs(runner, options));

  let firewallContext: string[] = [];
  if (!stackExists(runner, options.region, FOUNDATION_STACK)) {
    if (options.requireExistingFoundation) {
      throw new Error(`${FOUNDATION_STACK} does not exist; create it with a reviewed manual release first`);
    }
    deployFoundation(runner, options);
  } else {
    firewallContext = foundationFirewallContext(describeStack(runner, options.region, FOUNDATION_STACK));
    assertFoundationHasNoPendingChanges(runner, options, firewallContext);
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
    ...firewallContext,
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
  deployControlPlane(runner, options, foundation, firewallContext, publicApiUrl);
  const slackOrchestratorImage = await releaseSlackOrchestrator(runner, options, identity.Account, revision, foundation, firewallContext, publicApiUrl);

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
  firewallContext: readonly string[],
  publicApiUrl: string | undefined,
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
    ...firewallContext,
    ...profileArgs(options.profile),
    ...parameter("OrchestratorImageUri", image),
    ...parameter("OrchestratorImageRepositoryName", "agentx-slack-orchestrator"),
    ...parameter("TaskRoleArn", stackOutput(controlPlane, "SlackOrchestratorTaskRoleArn")),
    ...parameter("ControlPlaneUrl", orchestratorControlPlaneUrl(publicApiUrl, () => stackOutput(controlPlane, "ApiEndpoint"))),
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

/**
 * #1277: the CDK context that synthesizes the live foundation's DNS firewall, read from the outputs it was deployed with. A foundation with no firewall gives none (the legacy
 * default, off). A foundation that has a firewall but no recorded mode (deployed before #1277) is refused: guessing watch or block could switch the live last rule.
 */
export function foundationFirewallContext(foundation: StackDescription): string[] {
  const output = (key: string) => foundation.Outputs?.find((entry) => entry.OutputKey === key)?.OutputValue;
  const mode = output(DNS_FIREWALL_MODE_OUTPUT);
  if (mode === undefined) {
    if (output("ProjectAllowListId") !== undefined) {
      throw new Error(
        `${FOUNDATION_STACK} has a DNS firewall but does not record its mode; deploy it once with the -c ${DNS_FIREWALL_CONTEXT_KEY} and -c ${EGRESS_ALLOW_DOMAINS_CONTEXT_KEY} it was deployed with, so releases keep it`,
      );
    }
    return [];
  }
  if (mode !== "off" && mode !== "watch" && mode !== "block") throw new Error(`${FOUNDATION_STACK} output ${DNS_FIREWALL_MODE_OUTPUT} must be off, watch or block`);
  const domains = output(EGRESS_ALLOW_DOMAINS_OUTPUT);
  return ["-c", `${DNS_FIREWALL_CONTEXT_KEY}=${mode}`, ...(domains ? ["-c", `${EGRESS_ALLOW_DOMAINS_CONTEXT_KEY}=${domains}`] : [])];
}

function assertFoundationHasNoPendingChanges(runner: Runner, options: ReleaseOptions, firewallContext: readonly string[]): void {
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
    ...firewallContext,
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

function deployControlPlane(runner: Runner, options: ReleaseOptions, foundation: StackDescription, firewallContext: readonly string[], publicApiUrl: string | undefined): void {
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
    ...firewallContext,
    ...profileArgs(options.profile),
    ...optionalControlPlaneParameters(),
    ...publicApiUrlArguments(publicApiUrl),
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
    `  --require-public-api-address   Refuse unless AgentXApiAddress exists: its PublicApiOrigin is the only PublicApiUrl a release may carry (AGENTX_PUBLIC_API_URL, if set, must equal it)\n` +
    `  --confirm-public-api-url-change  Confirm that a first or changed PublicApiUrl changes the token issuer (Cloud's CodeUrl moves in the same window)\n` +
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
