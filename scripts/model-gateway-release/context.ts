// Environment layout and CDK context for Code's model gateway release steps (#1578).
// Keeps the existing gateway stack names (`rovara-cloud-<env>-gateway*`) so nothing is renamed or replaced,
// while storing Code's own last-good record in the release account under `/agentx/release/model-gateway-last-good/<env>`.
import { gatewayAiSourceKinds } from "../../infra/lib/model-gateway-switches.js";
import type { PipelineEnv } from "./types.js";

export const MODEL_GATEWAY_ENVIRONMENTS: readonly PipelineEnv[] = ["beta", "production"];
export const MODEL_GATEWAY_STACK_ID = "RovaraModelGateway";
export const CDK_BOOTSTRAP_QUALIFIER = "hnb659fds";
export const MODEL_GATEWAY_DEFAULT_REGION = "us-east-1";
export const CONTROL_PLANE_STACK_NAME = "AgentXControlPlane";

/** Code's own gateway last-good SSM parameter in the release account (beside code-released and code-history). */
export const MODEL_GATEWAY_LAST_GOOD_PARAMETER: Readonly<Record<PipelineEnv, string>> = Object.freeze({
  beta: "/agentx/release/model-gateway-last-good/beta",
  production: "/agentx/release/model-gateway-last-good/production",
});

/** Legacy Cloud last-good SSM parameter in the target account, read-only during one-time adoption handover. */
export function legacyLastGoodParameter(env: PipelineEnv): string {
  return `/rovara-cloud/${env}/release/last-good`;
}

export function modelGatewayStackName(env: PipelineEnv): string {
  return `rovara-cloud-${env}-gateway`;
}

export function modelGatewayImagesStackName(env: PipelineEnv): string {
  return `rovara-cloud-${env}-gateway-images`;
}

export function changeSetNameFor(exec8: string): string {
  return `rovara-pipeline-${exec8}`;
}

export function modelGatewayCdkContext(env: PipelineEnv, region: string, codeSha: string): Record<string, string> {
  return {
    rovaraModelGateway: env,
    agentxRegion: region,
    rovaraModelGatewayProductAi: "on",
    rovaraModelGatewayRovaraAi: "on",
    rovaraAiSourceKinds: gatewayAiSourceKinds(env),
    rovaraModelGatewayOfferedPrices: "on",
    rovaraCodeSha: codeSha,
  };
}
