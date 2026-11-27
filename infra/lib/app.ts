import { readFileSync } from "node:fs";
import { App, Aspects, LegacyStackSynthesizer, Stack, Tags } from "aws-cdk-lib";
import type { IReusableStackSynthesizer } from "aws-cdk-lib";
import { CONTEXT_ENV, CONTEXT_OVERFLOW_LOCATION_ENV } from "aws-cdk-lib/cx-api";
import { AccessStack } from "./access.js";
import { ControlPlaneStack } from "./control-plane.js";
import { IdentityStack } from "./identity.js";
import { INSTALLER_DESCRIPTION, InstallerStack } from "./installer.js";
import { applyLegacyRuntimeBoundaries } from "./legacy-runtime-boundary.js";
import { type AgentXNaming, namingFromContext } from "./naming.js";
import { applyPermissionsBoundaryParameter } from "./permissions-boundary.js";
import { ProductionFoundationStack } from "./production-foundation.js";
import { maybeEnvironmentReleasePipeline } from "./environment-release-pipeline.js";
import { ReleasePipelineStack } from "./release-pipeline.js";
import { RetainExceptOnCreate } from "./retention.js";
import { EnvironmentRolePath } from "./role-path.js";
import { SlackOrchestratorStack } from "./slack-orchestrator.js";
import { CiRunnerStack } from "./ci-runner.js";
import { maybeApiAddressStack } from "./api-address.js";
import { BetaDomainStack } from "./beta-domain.js";
import { BetaReleaseAccessStack } from "./beta-release-access.js";
import { WorkerSettingsStack } from "./worker-settings.js";
import { maybeModelGateway } from "./model-gateway-app.js";
import { SelfHostedModelGatewayStack } from "./self-hosted-gateway.js";

/** The context the App will go on to use, with CDK's own precedence (moved out of buildAgentXApp unchanged, to keep its complexity under the ratchet). */
function mergedAppContext(context: Record<string, unknown>): Record<string, unknown> {
  let cliContext: Record<string, unknown>;
  try {
    cliContext = JSON.parse(process.env[CONTEXT_ENV] ?? "{}") as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `${CONTEXT_ENV} environment variable is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const overflowLocation = process.env[CONTEXT_OVERFLOW_LOCATION_ENV];
  let overflowContext: Record<string, unknown> = {};
  // Matches CDK App's own readContextFromTempFile: `location ? fs().readJSONSync(location) : {}`.
  // An empty (but set) environment variable must be ignored the same way App ignores it, not
  // treated as a path to read.
  if (overflowLocation) {
    try {
      overflowContext = JSON.parse(readFileSync(overflowLocation, "utf8")) as Record<string, unknown>;
    } catch (error) {
      throw new Error(
        `${CONTEXT_OVERFLOW_LOCATION_ENV} (${JSON.stringify(overflowLocation)}) could not be read as JSON: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
  return { ...context, ...cliContext, ...overflowContext };
}

export function buildAgentXApp(context: Record<string, unknown> = {}): App {
  // The default stack synthesizer (and the assembly output directory, below) are
  // App-construction-time settings (Stack cannot pick them up afterwards), so they must be decided
  // before `new App(...)`, from the same context sources CDK itself would merge for every other
  // context key: CDK_CONTEXT_JSON and the context-overflow temp file (how the `cdk` CLI passes `-c`
  // flags and cdk.json to the app it shells out to, since bin/agentx.ts calls buildAgentXApp() with
  // no arguments — the overflow file is used instead of the environment variable when the context
  // is too large for one) and this function's own context argument. App.loadContext treats the
  // constructor's `context` prop as defaults, then layers `{...environment, ...tempFile}` on top of
  // it (the overflow file winning over the environment variable for any key both set), so these
  // pre-App guard clauses must use the same precedence to validate the values the App actually goes
  // on to use. Letting the argument win instead, as before, meant the guard could accept a value
  // that CDK_CONTEXT_JSON/the overflow file would then silently override once the App applied its
  // own precedence — a mismatch between what was validated and what was actually built.
  const mergedContext = mergedAppContext(context);
  const synthesizerMode = mergedContext.agentxSynthesizer as string | undefined;
  if (synthesizerMode !== undefined && synthesizerMode !== "legacy") {
    throw new Error(`unsupported agentxSynthesizer ${JSON.stringify(synthesizerMode)}; expected legacy or unset`);
  }
  // The legacy synthesizer (no CDK bootstrap, assets as template parameters) is only for a named
  // environment: the deployment that predates environments keeps CDK bootstrap.
  if (synthesizerMode === "legacy" && mergedContext.agentxEnv === undefined) {
    throw new Error("agentxSynthesizer=legacy requires a named environment (agentxEnv context); the deployment that predates environments keeps CDK bootstrap");
  }
  // Lets a caller (the release builder) pin the cloud assembly to a directory it controls and
  // cleans up, instead of the auto-generated temporary directory App falls back to when this is
  // unset (unchanged default behavior).
  const outdir = mergedContext.outdir as string | undefined;
  const app = new App({
    context: { "@aws-cdk/core:defaultCrossStackReferences": "strong", ...context },
    ...(outdir === undefined ? {} : { outdir }),
    // aws-cdk-lib types IStackSynthesizer.bootstrapQualifier as `string | undefined` via a getter,
    // which exactOptionalPropertyTypes rejects for the optional `bootstrapQualifier?: string` on
    // IReusableStackSynthesizer (same shape as the artifactBucket cast in release-pipeline.ts).
    ...(synthesizerMode === "legacy" ? { defaultStackSynthesizer: new LegacyStackSynthesizer() as IReusableStackSynthesizer } : {}),
  });
  // The environment release pipeline (-c agentxReleasePipeline=<environment>) is the only stack then; unset, nothing here runs and every other template is unchanged.
  if (maybeEnvironmentReleasePipeline(app)) return app;
  // The model gateway (-c rovaraModelGateway=<environment>, #1478) is its two stacks only; unset, nothing here runs.
  if (maybeModelGateway(app)) return app;
  const naming = namingFromContext(app);
  const deploymentRegion = app.node.tryGetContext("agentxRegion") as string | undefined;
  const deploymentMode =
    (app.node.tryGetContext("agentxDeploymentMode") as string | undefined) ?? "ec2-ebs";
  if (deploymentMode !== "ec2-ebs") {
    throw new Error(`unsupported agentxDeploymentMode ${deploymentMode}; only ec2-ebs is supported`);
  }
  const identityMode = app.node.tryGetContext("agentxIdentity") as string | undefined;
  if (identityMode !== undefined && identityMode !== "cognito" && identityMode !== "oidc") {
    throw new Error(`unsupported agentxIdentity ${JSON.stringify(identityMode)}; expected cognito, oidc, or unset`);
  }
  // The legacy deployment (no agentxEnv context) predates the identity stack and brings its own
  // OIDC provider by fixed configuration, not by this context value; agentxIdentity has no meaning
  // for it.
  if (naming.env === undefined && identityMode !== undefined) {
    throw new Error(
      `agentxIdentity=${JSON.stringify(identityMode)} is not supported without an agentxEnv context; the legacy deployment has no identity stack`,
    );
  }

  // The access stack holds the roles every other environment stack is deployed with, so it comes
  // first. The deployment that predates environments has none.
  let accessStack: AccessStack | undefined;
  if (naming.env !== undefined) {
    const region = deploymentRegion ?? "us-east-1";
    accessStack = new AccessStack(app, "AgentXAccess", {
      description: "AgentX access for a named environment: artifact bucket, image cache rule, deploy and operator roles",
      stackName: naming.stackName("access"),
      naming,
      terminationProtection: true,
      env: { region },
    });
  }
  const controlPlaneStack = new ControlPlaneStack(app, "AgentXControlPlane", {
    description: "AgentX authenticated control plane and durable dispatch foundation",
    naming,
    ...(naming.env === undefined ? {} : { stackName: naming.stackName("control-plane") }),
  });
  const foundationStack = new ProductionFoundationStack(app, "AgentXProductionFoundation", {
    description: "Stable AgentX production network, encryption, and persistent workspace capacity",
    deploymentRegion: deploymentRegion ?? "us-east-1",
    env: { region: deploymentRegion ?? "us-east-1" },
    terminationProtection: true,
    naming,
    ...(naming.env === undefined ? {} : { stackName: naming.stackName("foundation") }),
  });
  // The identity stack is new with named environments; the legacy deployment brings its own OIDC
  // provider instead. Skip it entirely when the environment opts out with agentxIdentity=oidc.
  if (naming.env !== undefined && identityMode !== "oidc") {
    new IdentityStack(app, "AgentXIdentity", {
      description: "AgentX Cognito user pool, admin group and CLI app client for a named environment",
      stackName: naming.stackName("identity"),
      terminationProtection: true,
      naming,
      env: { region: deploymentRegion ?? "us-east-1" },
    });
  }
  // The self-hosted Model Gateway runs inside foundation's existing VPC for named environments
  // (issue #1554). The legacy deployment brings its own external gateway.
  maybeSelfHostedGatewayStack(app, naming, deploymentRegion);
  // The runtime stack holds EC2 worker settings.
  new WorkerSettingsStack(app, "AgentXProductionRuntime", {
    description: "AgentX worker image and model settings for EC2 workers",
    env: { region: deploymentRegion ?? "us-east-1" },
    terminationProtection: true,
    naming,
    ...(naming.env === undefined ? {} : { stackName: naming.stackName("runtime") }),
  });
  // The release pipeline builds and deploys the live production stacks by their fixed legacy
  // names; it has no meaning for a named environment.
  if (naming.env === undefined) {
    new ReleasePipelineStack(app, "AgentXReleasePipeline", {
      description: "AgentX production release pipeline for the mainline branch",
      env: { region: deploymentRegion ?? "us-east-1" },
    });
  }
  const slackStack = new SlackOrchestratorStack(app, "AgentXSlackOrchestrator", {
    description: "Hosted AgentX Slack orchestrator on ECS Fargate",
    env: { region: deploymentRegion ?? "us-east-1" },
    naming,
    ...(naming.env === undefined ? {} : { stackName: naming.stackName("slack") }),
  });
  // The Launch in AWS installer, only when asked for (-c agentxInstaller=enabled); no release
  // deploys it, and the environment it installs is never part of it.
  if (app.node.tryGetContext("agentxInstaller") === "enabled") {
    new InstallerStack(app, "AgentXInstaller", {
      description: INSTALLER_DESCRIPTION,
      env: { region: deploymentRegion ?? "us-east-1" },
    });
  }
  // #1200: CI's CodeBuild-hosted runner for the test shards of pull requests into mainline, only when asked for (-c agentxCiRunner=enabled); no release deploys it.
  if (app.node.tryGetContext("agentxCiRunner") === "enabled") {
    new CiRunnerStack(app, "AgentXCiRunner", {
      description: "CodeBuild-hosted GitHub Actions runner for CI's test shards on pull requests into mainline",
      env: { region: deploymentRegion ?? "us-east-1" },
    });
  }
  // #1242: the beta account's release role, only when asked for (-c agentxBetaAccess=enabled) and deployed into the beta account by hand;
  // the release pipeline's beta build assumes it. No release deploys it.
  if (naming.env === undefined && app.node.tryGetContext("agentxBetaAccess") === "enabled") {
    new BetaReleaseAccessStack(app, "AgentXBetaReleaseAccess", {
      description: "The release pipeline's beta build role in the beta account",
      env: { region: deploymentRegion ?? "us-east-1" },
    });
  }
  // #1242: beta's address (beta.rovara.dev) in front of the beta control plane's API, only when asked for (-c agentxBetaDomain=enabled), by hand.
  if (naming.env === undefined && app.node.tryGetContext("agentxBetaDomain") === "enabled") {
    new BetaDomainStack(app, "AgentXBetaDomain", {
      description: "Beta's address in front of the beta control plane's API",
      env: { region: deploymentRegion ?? "us-east-1" },
    });
  }
  // The deployment that predates environments has no environment boundary, so its runtime roles (Lambda, ECS task, the worker's instance
  // role, the Slack orchestrator) get a deny-only one: no IAM, CloudFormation, CDK deployer role or Lambda code changes. Not the release
  // pipeline stack (the deployer by design), the installer or the other context-gated stacks. An in-place PermissionsBoundary on each role.
  applyLegacyRuntimeBoundaries(naming, { controlPlane: controlPlaneStack, foundation: foundationStack, slack: slackStack });
  if (naming.env !== undefined) {
    Tags.of(app).add("agentx:env", naming.env);
    // Every environment role goes under /agentx/<env>/, the path the CloudFormation service role is
    // scoped to; the access stack's own roles are what that scoping protects, so they stay at root.
    Aspects.of(app).add(new EnvironmentRolePath(naming.env, new Set(accessStack === undefined ? [] : [accessStack])));
    // A failed first create cleans up after itself, so a retry never trips over a kept fixed name.
    Aspects.of(app).add(new RetainExceptOnCreate());
    // Every environment stack gets its own permission boundary parameter, condition, and aspect (the
    // given boundary, else the access stack's default boundary). The access stack already called
    // this itself (it creates the default boundary and needs the effective boundary for its roles'
    // policy statements), so this is a no-op for it.
    for (const stack of app.node.children.filter((c): c is Stack => Stack.isStack(c))) {
      applyPermissionsBoundaryParameter(stack, naming.env);
    }
  }
  // The permanent public address (-c agentxApiAddress=<domain>), only when asked for, by hand; created after the boundary loop on purpose (it declares no role, so it takes no boundary parameter). No release deploys it.
  maybeApiAddressStack(app, naming, deploymentRegion);
  return app;
}

function maybeSelfHostedGatewayStack(app: App, naming: AgentXNaming, deploymentRegion: string | undefined): void {
  if (naming.env === undefined) return;
  new SelfHostedModelGatewayStack(app, "AgentXModelGateway", {
    description: "Self-hosted Model Gateway for a named environment: ECS Fargate service, DynamoDB meter/prices, internal ALB and HTTPS entry point",
    stackName: naming.stackName("gateway"),
    terminationProtection: true,
    naming,
    env: { region: deploymentRegion ?? "us-east-1" },
  });
}
