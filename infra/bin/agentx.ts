#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { AgentRuntimeStack } from "../lib/agent-runtime.js";
import { ControlPlaneStack } from "../lib/control-plane.js";
import { DemoRuntimeStack } from "../lib/demo-runtime.js";

const app = new App();
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
  new AgentRuntimeStack(app, "AgentXRuntime", {
    description: "AgentX AgentCore Instances runtime and persistent workspace volume",
    deploymentRegion: deploymentRegion ?? "us-east-1",
    env: { region: deploymentRegion ?? "us-east-1" },
  });
}
