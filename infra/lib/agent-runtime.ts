// AgentCore constants the foundation and demo stacks still use. The AgentCore runtime itself left
// the release in #117 (see worker-settings.ts); these go with the rest of AgentCore in #118/#119.
export const AGENTX_WORKSPACE_MOUNT = "/mnt/workspace";
export const AGENTX_WORKSPACE_VOLUME = "workspace";
export const AGENTCORE_INSTANCES_REGIONS = new Set([
  "ap-northeast-1",
  "ap-south-1",
  "ap-southeast-1",
  "ap-southeast-2",
  "eu-central-1",
  "eu-west-1",
  "us-east-1",
  "us-east-2",
  "us-west-2",
]);
