import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/bin/agentx.js";
import { environmentNaming, legacyNaming, namingFromContext } from "../../infra/lib/naming.js";

function productionStacks(app: App): Stack[] {
  return app.node.children.filter((child): child is Stack => Stack.isStack(child))
    .filter((stack) => !stack.stackName.includes("ReleasePipeline"));
}

// Names AWS requires to be unique in an account and region. Resource "Name" keys (API names,
// authorizer names) are checked separately: they are not unique-constrained, but must still differ.
const PHYSICAL_NAME_KEYS = ["GroupName", "AgentRuntimeName", "TopicName", "AlarmName", "RoleName", "QueueName", "TableName", "BucketName", "LogGroupName"];

function physicalNames(stack: Stack): string[] {
  const resources = Template.fromStack(stack).toJSON().Resources as Record<string, { Type: string; Properties?: Record<string, unknown> }>;
  return Object.values(resources).flatMap((resource) => [
    ...PHYSICAL_NAME_KEYS.map((key) => resource.Properties?.[key]),
    resource.Type === "AWS::ApiGatewayV2::Api" ? resource.Properties?.Name : undefined,
  ].filter((value): value is string => typeof value === "string"));
}

describe("legacy naming", () => {
  it("reproduces today's names exactly", () => {
    const naming = legacyNaming();
    expect(naming.env).toBeUndefined();
    expect(naming.stackName("foundation")).toBe("AgentXProductionFoundation");
    expect(naming.stackName("runtime")).toBe("AgentXProductionRuntime");
    expect(naming.stackName("control-plane")).toBe("AgentXControlPlane");
    expect(naming.stackName("slack")).toBe("AgentXSlackOrchestrator");
    expect(naming.workerSecurityGroupName).toBe("agentx-production-workers");
    expect(naming.apiName).toBe("agentx-control-plane");
    expect(naming.resourcePrefix).toBe("agentx-production");
    expect(naming.runtimeName).toBe("agentx_production_worker");
    expect(naming.alertsTopicName).toBe("AgentXOperatorAlerts");
    expect(naming.alarmName("ConnectorBroken")).toBe("AgentXConnectorBroken");
    expect(naming.connectorSecretPrefix).toBe("agentx/connectors/");
    expect(naming.metricsNamespace).toBe("AgentX");
    expect(naming.environmentTagValue).toBe("production");
  });

  it("is used when the agentxEnv context is absent", () => {
    expect(namingFromContext(new App()).env).toBeUndefined();
  });
});

describe("environment naming", () => {
  it("names everything with the environment", () => {
    const naming = environmentNaming("dev-2");
    expect(naming.env).toBe("dev-2");
    expect(naming.stackName("control-plane")).toBe("agentx-dev-2-control-plane");
    expect(naming.workerSecurityGroupName).toBe("agentx-dev-2-workers");
    expect(naming.apiName).toBe("agentx-dev-2-control-plane");
    expect(naming.resourcePrefix).toBe("agentx-dev-2");
    expect(naming.runtimeName).toBe("agentx_dev_2_worker");
    expect(naming.alertsTopicName).toBe("agentx-dev-2-alerts");
    expect(naming.alarmName("ConnectorBroken")).toBe("agentx-dev-2-ConnectorBroken");
    expect(naming.connectorSecretPrefix).toBe("agentx/dev-2/connectors/");
    expect(naming.metricsNamespace).toBe("AgentX/dev-2");
    expect(naming.environmentTagValue).toBe("dev-2");
  });

  it("refuses an invalid environment from context", () => {
    expect(() => namingFromContext(new App({ context: { agentxEnv: "Prod" } }))).toThrow(/environment name/);
  });

  it("deploys two environments in one account with no shared physical name or stack name", () => {
    const production = productionStacks(buildAgentXApp({ agentxEnv: "production" }));
    const staging = productionStacks(buildAgentXApp({ agentxEnv: "staging" }));
    expect(production.map((stack) => stack.stackName).sort()).toEqual([
      "agentx-production-control-plane", "agentx-production-foundation", "agentx-production-runtime", "agentx-production-slack",
    ]);
    const productionNames = new Set(production.flatMap(physicalNames));
    const shared = staging.flatMap(physicalNames).filter((name) => productionNames.has(name));
    expect(shared).toEqual([]);
  }, 240_000);

  it("tags every stack's resources with agentx:env", () => {
    const staging = productionStacks(buildAgentXApp({ agentxEnv: "staging" }));
    const control = staging.find((stack) => stack.stackName === "agentx-staging-control-plane")!;
    Template.fromStack(control).hasResourceProperties("AWS::DynamoDB::Table", {
      Tags: Match.arrayWith([{ Key: "agentx:env", Value: "staging" }]),
    });
  }, 120_000);

  it("scopes runtime ARNs and connector secrets to the environment", () => {
    const staging = productionStacks(buildAgentXApp({ agentxEnv: "staging" }));
    const control = staging.find((stack) => stack.stackName === "agentx-staging-control-plane")!;
    const text = JSON.stringify(Template.fromStack(control).toJSON());
    expect(text).toContain("runtime/agentx_staging_worker-*");
    expect(text).not.toContain(":runtime/*");
    expect(text).toContain("secret:agentx/staging/connectors/*");
    expect(text).not.toContain("secret:agentx/connectors/*");
  }, 120_000);
});
