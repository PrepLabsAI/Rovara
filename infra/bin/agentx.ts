#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { AgentRuntimeStack } from "../lib/agent-runtime.js";
import { ControlPlaneStack } from "../lib/control-plane.js";
import { DemoRuntimeStack } from "../lib/demo-runtime.js";
import { ProductionFoundationStack } from "../lib/production-foundation.js";

const app = new App({
  context: { "@aws-cdk/core:defaultCrossStackReferences": "strong" },
});
const deploymentRegion = app.node.tryGetContext("agentxRegion") as string | undefined;
const deploymentMode =
  (app.node.tryGetContext("agentxDeploymentMode") as string | undefined) ?? "instances-ebs";
if (deploymentMode !== "instances-ebs" && deploymentMode !== "demo-microvm") {
  throw new Error(
    `unsupported agentxDeploymentMode ${deploymentMode}; expected instances-ebs or demo-microvm`,
  );
}
new ControlPlaneStack(app, "AgentXControlPlane", {
  description: "AgentX authenticated control plane and durable dispatch foundation",
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
  });
  new AgentRuntimeStack(app, "AgentXProductionRuntime", {
    description: "AgentX production coding runtime on stable EBS-backed capacity",
    deploymentRegion: deploymentRegion ?? "us-east-1",
    env: { region: deploymentRegion ?? "us-east-1" },
    terminationProtection: true,
  });
}
