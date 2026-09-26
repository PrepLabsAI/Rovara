import { App, Tags } from "aws-cdk-lib";
import { AgentRuntimeStack } from "./agent-runtime.js";
import { ControlPlaneStack } from "./control-plane.js";
import { DemoRuntimeStack } from "./demo-runtime.js";
import { IdentityStack } from "./identity.js";
import { namingFromContext } from "./naming.js";
import { ProductionFoundationStack } from "./production-foundation.js";
import { ReleasePipelineStack } from "./release-pipeline.js";
import { SlackOrchestratorStack } from "./slack-orchestrator.js";

export function buildAgentXApp(context: Record<string, unknown> = {}): App {
  const app = new App({
    context: { "@aws-cdk/core:defaultCrossStackReferences": "strong", ...context },
  });
  const naming = namingFromContext(app);
  const deploymentRegion = app.node.tryGetContext("agentxRegion") as string | undefined;
  const deploymentMode =
    (app.node.tryGetContext("agentxDeploymentMode") as string | undefined) ?? "instances-ebs";
  if (deploymentMode !== "instances-ebs" && deploymentMode !== "demo-microvm") {
    throw new Error(
      `unsupported agentxDeploymentMode ${deploymentMode}; expected instances-ebs or demo-microvm`,
    );
  }
  // The demo microVM runtime is legacy-only: it predates named environments and has no environment-scoped naming.
  if (naming.env !== undefined && deploymentMode === "demo-microvm") {
    throw new Error(
      `agentxDeploymentMode=demo-microvm is not supported with an agentxEnv context (got ${JSON.stringify(naming.env)})`,
    );
  }
  const identityMode = app.node.tryGetContext("agentxIdentity") as string | undefined;
  if (identityMode !== undefined && identityMode !== "cognito" && identityMode !== "oidc") {
    throw new Error(`unsupported agentxIdentity ${JSON.stringify(identityMode)}; expected cognito, oidc, or unset`);
  }

  new ControlPlaneStack(app, "AgentXControlPlane", {
    description: "AgentX authenticated control plane and durable dispatch foundation",
    naming,
    ...(naming.env === undefined ? {} : { stackName: naming.stackName("control-plane") }),
  });
  if (deploymentMode === "demo-microvm") {
    new DemoRuntimeStack(app, "AgentXDemoRuntime", {
      description: "AgentX VPC-free microVM demonstration runtime",
      deploymentRegion: deploymentRegion ?? "us-east-1",
      env: { region: deploymentRegion ?? "us-east-1" },
    });
  } else {
    new ProductionFoundationStack(app, "AgentXProductionFoundation", {
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
        naming,
        env: { region: deploymentRegion ?? "us-east-1" },
      });
    }
    new AgentRuntimeStack(app, "AgentXProductionRuntime", {
      description: "AgentX production coding runtime on stable EBS-backed capacity",
      deploymentRegion: deploymentRegion ?? "us-east-1",
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
    new SlackOrchestratorStack(app, "AgentXSlackOrchestrator", {
      description: "Hosted AgentX Slack orchestrator on ECS Fargate",
      env: { region: deploymentRegion ?? "us-east-1" },
      naming,
      ...(naming.env === undefined ? {} : { stackName: naming.stackName("slack") }),
    });
  }
  if (naming.env !== undefined) {
    Tags.of(app).add("agentx:env", naming.env);
  }
  return app;
}
