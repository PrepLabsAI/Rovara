#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { App, Tags } from "aws-cdk-lib";
import { AgentRuntimeStack } from "../lib/agent-runtime.js";
import { ControlPlaneStack } from "../lib/control-plane.js";
import { DemoRuntimeStack } from "../lib/demo-runtime.js";
import { namingFromContext } from "../lib/naming.js";
import { ProductionFoundationStack } from "../lib/production-foundation.js";
import { ReleasePipelineStack } from "../lib/release-pipeline.js";
import { SlackOrchestratorStack } from "../lib/slack-orchestrator.js";

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

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) buildAgentXApp().synth();
