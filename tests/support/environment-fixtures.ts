import type { EnvironmentSettings } from "../../packages/cli/src/environments/settings.js";

export const stagingSettings: EnvironmentSettings = {
  schemaVersion: 1,
  env: "staging",
  account: "123456789012",
  region: "us-east-1",
  engine: "templates",
  version: "1.0.0",
  naming: "environment",
  stacks: { foundation: "agentx-staging-foundation", runtime: "agentx-staging-runtime", "control-plane": "agentx-staging-control-plane", slack: "agentx-staging-slack" },
  controlPlaneUrl: "https://abc.execute-api.us-east-1.amazonaws.com",
  identity: { mode: "cognito", issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_x", audience: "client", clientId: "client" },
  models: { orchestrator: "us.anthropic.claude-haiku-4-5-20251001-v1:0", classifier: "amazon.nova-lite-v1:0", worker: "amazon.nova-pro-v1:0" },
  updatedAt: "2026-09-26T00:00:00.000Z",
};
