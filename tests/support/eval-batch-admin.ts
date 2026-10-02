// A SWE-bench deployment for the batch admin route tests.
import type { SwebenchDeployment } from "../../packages/broker/src/aws/swebench.js";

export function swebenchDeploymentForTests(runnerImage: string): SwebenchDeployment {
  return {
    settings: {
      stateMachineArn: "arn:aws:states:us-east-1:111122223333:stateMachine:agentx-production-swebench-eval",
      subnetIds: ["subnet-0123456789abcdef0"],
      controlPlaneUrl: "https://api.example.com",
      logGroupName: "/agentx/production/swebench",
      maxConcurrentEvals: 4,
    },
    runnerImage,
    defaultModel: { provider: "amazon-bedrock", modelId: "us.anthropic.claude-sonnet-deployment" },
    environment: { PI_CACHE_RETENTION: "long" },
    runnerFeatures: ["model.thinkingLevel"],
  };
}
