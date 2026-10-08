import { App, Aspects } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { RetainExceptOnCreate } from "../../infra/lib/retention.js";
import { SlackOrchestratorStack } from "../../infra/lib/slack-orchestrator.js";
import { environmentNaming } from "../../infra/lib/naming.js";

function namedSlackTemplate(): Template {
  const app = new App();
  const stack = new SlackOrchestratorStack(app, "NamedSlack", {
    env: { region: "us-east-1" },
    naming: environmentNaming("diagnostic-retry"),
  });
  Aspects.of(app).add(new RetainExceptOnCreate());
  return Template.fromStack(stack);
}

describe("named Slack ECS diagnostics", () => {
  it("enables ECS Action Logs before creating the orchestrator service", () => {
    const template = namedSlackTemplate();
    template.resourceCountIs("AWS::Logs::DeliverySource", 1);
    template.resourceCountIs("AWS::Logs::DeliveryDestination", 1);
    template.resourceCountIs("AWS::Logs::Delivery", 1);
    template.hasResourceProperties("AWS::Logs::DeliverySource", {
      LogType: "ACTION_LOGS",
    });
    template.hasResourceProperties("AWS::Logs::DeliveryDestination", {
      DeliveryDestinationType: "CWL",
    });

    const deliveryId = Object.keys(template.findResources("AWS::Logs::Delivery"))[0]!;
    const delivery = Object.values(template.findResources("AWS::Logs::Delivery"))[0] as { DependsOn?: string[] };
    const sourceId = Object.keys(template.findResources("AWS::Logs::DeliverySource"))[0]!;
    const destinationId = Object.keys(template.findResources("AWS::Logs::DeliveryDestination"))[0]!;
    expect(delivery.DependsOn).toEqual(expect.arrayContaining([sourceId, destinationId]));
    const service = Object.values(template.findResources("AWS::ECS::Service"))[0] as { DependsOn?: string[] };
    expect(service.DependsOn).toContain(deliveryId);
    template.resourceCountIs("AWS::Events::Rule", 1);
    const ruleEntry = Object.entries(template.findResources("AWS::Events::Rule"))[0]!;
    expect(service.DependsOn).toContain(ruleEntry[0]);
    const rule = ruleEntry[1] as { Properties?: { EventPattern?: Record<string, unknown> } };
    expect(rule.Properties?.EventPattern).toMatchObject({
      source: ["aws.ecs"],
      "detail-type": ["ECS Deployment State Change"],
      detail: { eventName: ["SERVICE_DEPLOYMENT_FAILED"] },
    });
  });

  it("retains attempt-specific service and Action Logs with the key needed to read them", () => {
    const template = namedSlackTemplate();
    const resources = template.toJSON().Resources as Record<string, {
      Type: string;
      DeletionPolicy?: string;
      UpdateReplacePolicy?: string;
      Properties?: { LogGroupName?: unknown; EnableKeyRotation?: boolean };
    }>;
    const logGroups = Object.values(resources).filter((resource) => resource.Type === "AWS::Logs::LogGroup");
    const retainedLogs = logGroups.filter((resource) => resource.DeletionPolicy === "Retain");
    expect(retainedLogs).toHaveLength(2);
    expect(retainedLogs.every((resource) => resource.UpdateReplacePolicy === "Retain")).toBe(true);
    expect(retainedLogs.every((resource) => JSON.stringify(resource.Properties?.LogGroupName).includes("AWS::StackId"))).toBe(true);

    const keys = Object.values(resources).filter((resource) => resource.Type === "AWS::KMS::Key");
    expect(keys).toHaveLength(1);
    expect(keys[0]?.DeletionPolicy).toBe("Retain");
    expect(keys[0]?.UpdateReplacePolicy).toBe("Retain");
    const sources = Object.values(resources).filter((resource) => resource.Type === "AWS::Logs::DeliverySource");
    expect(sources).toHaveLength(1);
    expect(sources[0]?.DeletionPolicy).toBe("Retain");
    expect(sources[0]?.UpdateReplacePolicy).toBe("Retain");
    expect(JSON.stringify(template.toJSON())).toContain("delivery.logs.amazonaws.com");
    expect(JSON.stringify(template.toJSON())).toContain("logs.");
    expect(JSON.stringify(template.toJSON())).toContain("AWS::Region");
  });

  it("does not add delivery or retained diagnostic resources to legacy Slack", () => {
    const template = Template.fromStack(new SlackOrchestratorStack(new App(), "LegacySlack", {
      env: { region: "us-east-1" },
    }));
    template.resourceCountIs("AWS::Logs::DeliverySource", 0);
    template.resourceCountIs("AWS::Logs::DeliveryDestination", 0);
    template.resourceCountIs("AWS::Logs::Delivery", 0);
    const resources = template.toJSON().Resources as Record<string, { Type: string; DeletionPolicy?: string }>;
    expect(Object.values(resources).filter((resource) => resource.Type === "AWS::Logs::LogGroup" && resource.DeletionPolicy === "Retain")).toHaveLength(0);
  });
});
