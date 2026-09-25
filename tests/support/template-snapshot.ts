import { App, type Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { AgentRuntimeStack } from "../../infra/lib/agent-runtime.js";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { ProductionFoundationStack } from "../../infra/lib/production-foundation.js";
import { ReleasePipelineStack } from "../../infra/lib/release-pipeline.js";
import { SlackOrchestratorStack } from "../../infra/lib/slack-orchestrator.js";

/** Asset hashes change whenever bundled code changes; the names and shapes must not. */
export function normalizedTemplate(stack: Stack): unknown {
  const text = JSON.stringify(Template.fromStack(stack).toJSON());
  return JSON.parse(text.replace(/[a-f0-9]{64}/g, "<asset-hash>"));
}

/**
 * The production stacks, built with the same ids and props as infra/bin/agentx.ts
 * (default deployment mode "instances-ebs", no agentxRegion context: region "us-east-1").
 */
export function legacyProductionStacks(): Stack[] {
  const app = new App({ context: { "@aws-cdk/core:defaultCrossStackReferences": "strong" } });
  const region = "us-east-1";
  return [
    new ControlPlaneStack(app, "AgentXControlPlane", {
      description: "AgentX authenticated control plane and durable dispatch foundation",
    }),
    new ProductionFoundationStack(app, "AgentXProductionFoundation", {
      description: "Stable AgentX production network, encryption, and persistent workspace capacity",
      deploymentRegion: region,
      env: { region },
      terminationProtection: true,
    }),
    new AgentRuntimeStack(app, "AgentXProductionRuntime", {
      description: "AgentX production coding runtime on stable EBS-backed capacity",
      deploymentRegion: region,
      env: { region },
      terminationProtection: true,
    }),
    new ReleasePipelineStack(app, "AgentXReleasePipeline", {
      description: "AgentX production release pipeline for the mainline branch",
      env: { region },
    }),
    new SlackOrchestratorStack(app, "AgentXSlackOrchestrator", {
      description: "Hosted AgentX Slack orchestrator on ECS Fargate",
      env: { region },
    }),
  ];
}
