import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { environmentNaming, legacyNaming, namingFromContext } from "../../infra/lib/naming.js";

function productionStacks(app: App): Stack[] {
  return app.node.children.filter((child): child is Stack => Stack.isStack(child))
    .filter((stack) => !stack.stackName.includes("ReleasePipeline"));
}

// Names AWS requires to be unique in an account and region. Resource "Name" keys (API names,
// authorizer names) are checked separately: they are not unique-constrained, but must still differ.
const PHYSICAL_NAME_KEYS = ["GroupName", "AgentRuntimeName", "TopicName", "AlarmName", "RoleName", "QueueName", "TableName", "BucketName", "LogGroupName", "AliasName", "Family"];

// AWS::BedrockAgentCore::CapacityProvider and AWS::ApiGatewayV2::Api both use the generic "Name"
// key, which most other resource types also carry for unrelated purposes (e.g. a tag's own "Name"
// entry), so they are checked by resource type rather than added to PHYSICAL_NAME_KEYS.
const NAME_PROPERTY_BY_TYPE = new Set(["AWS::ApiGatewayV2::Api", "AWS::BedrockAgentCore::CapacityProvider"]);

function physicalNames(stack: Stack): string[] {
  const resources = Template.fromStack(stack).toJSON().Resources as Record<string, { Type: string; Properties?: Record<string, unknown> }>;
  return Object.values(resources).flatMap((resource) => [
    ...PHYSICAL_NAME_KEYS.map((key) => resource.Properties?.[key]),
    NAME_PROPERTY_BY_TYPE.has(resource.Type) ? resource.Properties?.Name : undefined,
  ].filter((value): value is string => typeof value === "string"));
}

// CloudFormation export names are account-and-region unique, like physical names.
function exportNames(stack: Stack): string[] {
  const outputs = Template.fromStack(stack).toJSON().Outputs as Record<string, { Export?: { Name?: unknown } }> | undefined;
  return Object.values(outputs ?? {})
    .map((output) => output.Export?.Name)
    .filter((value): value is string => typeof value === "string");
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
    expect(naming.capacityProviderName).toBe("agentx_production_capacity_v3");
    expect(naming.workspaceKeyAlias).toBe("alias/agentx/production-workspaces");
    expect(naming.alertsTopicName).toBe("AgentXOperatorAlerts");
    expect(naming.alarmName("ConnectorBroken")).toBe("AgentXConnectorBroken");
    expect(naming.connectorSecretPrefix).toBe("agentx/connectors/");
    expect(naming.metricsNamespace).toBe("AgentX");
    expect(naming.environmentTagValue).toBe("production");
    expect(naming.taskFamily).toBe("agentx-slack-orchestrator");
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
    expect(naming.capacityProviderName).toBe("agentx_dev_2_capacity");
    expect(naming.workspaceKeyAlias).toBe("alias/agentx/dev-2/workspaces");
    expect(naming.alertsTopicName).toBe("agentx-dev-2-alerts");
    expect(naming.alarmName("ConnectorBroken")).toBe("agentx-dev-2-ConnectorBroken");
    expect(naming.connectorSecretPrefix).toBe("agentx/dev-2/connectors/");
    expect(naming.metricsNamespace).toBe("AgentX/dev-2");
    expect(naming.environmentTagValue).toBe("dev-2");
    expect(naming.taskFamily).toBe("agentx-dev-2-slack-orchestrator");
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
    const productionExports = new Set(production.flatMap(exportNames));
    const sharedExports = staging.flatMap(exportNames).filter((name) => productionExports.has(name));
    expect(sharedExports).toEqual([]);
  }, 240_000);

  it("tags every stack's resources with agentx:env", () => {
    const staging = productionStacks(buildAgentXApp({ agentxEnv: "staging" }));
    const foundation = staging.find((stack) => stack.stackName === "agentx-staging-foundation")!;
    const runtime = staging.find((stack) => stack.stackName === "agentx-staging-runtime")!;
    const control = staging.find((stack) => stack.stackName === "agentx-staging-control-plane")!;
    const slack = staging.find((stack) => stack.stackName === "agentx-staging-slack")!;

    Template.fromStack(foundation).hasResourceProperties("AWS::EC2::SecurityGroup", {
      Tags: Match.arrayWith([{ Key: "agentx:env", Value: "staging" }]),
    });
    // CfnRuntime is tagged with a plain string map, not the {Key,Value} array most other resources use.
    Template.fromStack(runtime).hasResourceProperties("AWS::BedrockAgentCore::Runtime", {
      Tags: Match.objectLike({ "agentx:env": "staging" }),
    });
    Template.fromStack(control).hasResourceProperties("AWS::DynamoDB::Table", {
      Tags: Match.arrayWith([{ Key: "agentx:env", Value: "staging" }]),
    });
    Template.fromStack(slack).hasResourceProperties("AWS::ECS::Cluster", {
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

  it("scopes the broker's capacity-provider session termination to the environment's capacity provider", () => {
    const staging = productionStacks(buildAgentXApp({ agentxEnv: "staging" }));
    const control = staging.find((stack) => stack.stackName === "agentx-staging-control-plane")!;
    const text = JSON.stringify(Template.fromStack(control).toJSON());
    expect(text).toContain("capacity-provider/agentx_staging_capacity-*");
    expect(text).not.toContain("capacity-provider/*");
  }, 120_000);

  it("does not leak the legacy production Environment tag onto foundation or runtime resources", () => {
    const staging = productionStacks(buildAgentXApp({ agentxEnv: "staging" }));
    const foundation = staging.find((stack) => stack.stackName === "agentx-staging-foundation")!;
    const runtime = staging.find((stack) => stack.stackName === "agentx-staging-runtime")!;
    for (const stack of [foundation, runtime]) {
      const text = JSON.stringify(Template.fromStack(stack).toJSON());
      expect(text).toContain('"Environment":"staging"');
      expect(text).not.toContain('"Environment":"production"');
      expect(text).not.toContain('"Key":"Environment","Value":"production"');
    }
  }, 120_000);

  it("tells the environment's broker its connector secret prefix, and leaves legacy unchanged", () => {
    const stagingControl = productionStacks(buildAgentXApp({ agentxEnv: "staging" })).find((stack) => stack.stackName === "agentx-staging-control-plane")!;
    expect(JSON.stringify(Template.fromStack(stagingControl).toJSON())).toContain("\"CONNECTOR_SECRET_PREFIX\":\"agentx/staging/connectors/\"");
    const legacyControl = productionStacks(buildAgentXApp()).find((stack) => stack.stackName === "AgentXControlPlane")!;
    expect(JSON.stringify(Template.fromStack(legacyControl).toJSON())).not.toContain("CONNECTOR_SECRET_PREFIX");
  }, 240_000);

  it("keeps each environment's metrics and alarms in its own namespace", () => {
    const stacks = productionStacks(buildAgentXApp({ agentxEnv: "staging" }));
    const text = stacks.map((stack) => JSON.stringify(Template.fromStack(stack).toJSON())).join("\n");
    expect(text).not.toMatch(/"(?:Namespace|MetricNamespace)":"AgentX"/);
    expect(text).toContain("\"AGENTX_METRICS_NAMESPACE\":\"AgentX/staging\"");
    expect(text).toMatch(/"(?:Namespace|MetricNamespace)":"AgentX\/staging"/);
  }, 240_000);

  it("deploys legacy production next to a staging environment with no shared physical name or export name", () => {
    const legacy = productionStacks(buildAgentXApp());
    const staging = productionStacks(buildAgentXApp({ agentxEnv: "staging" }));
    const legacyNames = new Set(legacy.flatMap(physicalNames));
    const shared = staging.flatMap(physicalNames).filter((name) => legacyNames.has(name));
    expect(shared).toEqual([]);
    const legacyExports = new Set(legacy.flatMap(exportNames));
    const sharedExports = staging.flatMap(exportNames).filter((name) => legacyExports.has(name));
    expect(sharedExports).toEqual([]);
  }, 240_000);
});
