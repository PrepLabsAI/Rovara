// tests/contract/slack-handoff-infrastructure.test.ts
// Task 19 (gap 10h): Slack presses are handed over as asynchronous invokes (to the broker, and the ingress's own Quick or
// Full start). A press Lambda could not run lands in one failure queue with an alarm; the ingress may invoke only itself.
import { App, aws_iam as iam, aws_sqs as sqs } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it, vi } from "vitest";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { environmentNaming } from "../../infra/lib/naming.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Resource = { DependsOn?: string[]; Type: string; Properties: Record<string, unknown> };

describe("Slack hand-off infrastructure (Task 19)", () => {
  const named = Template.fromStack(new ControlPlaneStack(new App(), "HandOffControlPlane", { naming: environmentNaming("live19") }));
  const legacy = Template.fromStack(new ControlPlaneStack(new App(), "HandOffLegacyControlPlane"));
  const resources = named.toJSON().Resources as Record<string, Resource>;
  const idOf = (type: string, prefix: string) => Object.keys(resources).find((id) => id.startsWith(prefix) && resources[id]!.Type === type)!;

  it("sends a press Lambda could not run, to the broker or the ingress's own start, to one failure queue", () => {
    const queueId = idOf("AWS::SQS::Queue", "SlackHandOffFailureQueue");
    expect(queueId).toBeDefined();
    const configs = Object.values(named.findResources("AWS::Lambda::EventInvokeConfig")) as Resource[];
    const targets = configs.map((config) => JSON.stringify(config.Properties.FunctionName));
    expect(targets.some((target) => target.includes(idOf("AWS::Lambda::Function", "Broker")))).toBe(true);
    expect(targets.some((target) => target.includes(idOf("AWS::Lambda::Function", "SlackIngress")))).toBe(true);
    for (const config of configs) {
      expect(config.Properties.DestinationConfig).toEqual({ OnFailure: { Destination: { "Fn::GetAtt": [queueId, "Arn"] } } });
    }
    expect(configs).toHaveLength(2);
  });

  it("grants the broker destination on its identity policy before creating the invoke config", () => {
    const queueId = idOf("AWS::SQS::Queue", "SlackHandOffFailureQueue");
    const brokerId = idOf("AWS::IAM::Role", "BrokerServiceRole");
    const policies = Object.entries(resources).filter(([, resource]) => resource.Type === "AWS::IAM::Policy" && JSON.stringify(resource.Properties.Roles).includes(brokerId));
    const destinationPolicies = policies.filter(([, policy]) => {
      const statements = (policy.Properties.PolicyDocument as { Statement: Array<{ Action: unknown; Resource: unknown; Effect: string }> }).Statement;
      return statements.some((statement) => JSON.stringify(statement.Resource) === JSON.stringify({ "Fn::GetAtt": [queueId, "Arn"] })
        && statement.Effect === "Allow" && JSON.stringify(statement.Action) === JSON.stringify(["sqs:SendMessage", "sqs:GetQueueAttributes", "sqs:GetQueueUrl"]));
    });
    expect(destinationPolicies, "Lambda's create-time destination check needs the broker identity grant").toHaveLength(1);
    const config = resources[idOf("AWS::Lambda::EventInvokeConfig", "BrokerEventInvokeConfig")]!;
    expect(config.DependsOn, "broker invoke config must explicitly wait for the destination identity grant").toContain(destinationPolicies[0]![0]);
  });

  it("also orders any hand-off queue resource policy before the broker invoke config", () => {
    // The captured method is explicitly invoked with the queue instance via .call below.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const original = sqs.Queue.prototype.grantSendMessages;
    const grant = vi.spyOn(sqs.Queue.prototype, "grantSendMessages").mockImplementation(function (this: sqs.Queue, grantee) {
      if (this.node.id === "SlackHandOffFailureQueue") this.addToResourcePolicy(new iam.PolicyStatement({
        effect: iam.Effect.DENY, principals: [new iam.AnyPrincipal()], actions: ["sqs:PurgeQueue"], resources: [this.queueArn],
      }));
      return original.call(this, grantee);
    });
    try {
      const template = Template.fromStack(new ControlPlaneStack(new App(), "QueuePolicyOrder", { naming: environmentNaming("live19") }));
      const configs = Object.entries(template.findResources("AWS::Lambda::EventInvokeConfig")) as Array<[string, Resource]>;
      const policies = Object.keys(template.findResources("AWS::SQS::QueuePolicy")).filter((id) => id.startsWith("SlackHandOffFailureQueuePolicy"));
      expect(policies).toHaveLength(1);
      expect(configs.find(([id]) => id.startsWith("BrokerEventInvokeConfig"))![1].DependsOn, "broker invoke config must wait for an existing destination queue policy").toContain(policies[0]);
    } finally { grant.mockRestore(); }
  });

  it("alarms the operator on every lost request, not only while the queue holds one", () => {
    const queueId = idOf("AWS::SQS::Queue", "SlackHandOffFailureQueue");
    named.hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmName: "agentx-live19-SlackHandOffFailures", Threshold: 1, EvaluationPeriods: 1, Period: 300,
      MetricName: "NumberOfMessagesSent", Namespace: "AWS/SQS", Statistic: "Sum",
      AlarmDescription: Match.stringLikeRegexp("background request \\(a Slack button press or a scheduled retry\\) was lost.*Check the queue"),
      ComparisonOperator: "GreaterThanOrEqualToThreshold", TreatMissingData: "notBreaching",
      Dimensions: [{ Name: "QueueName", Value: { "Fn::GetAtt": [queueId, "QueueName"] } }],
    });
  });

  it("lets the ingress invoke only itself, in a policy its function does not wait on", () => {
    const ingressId = idOf("AWS::Lambda::Function", "SlackIngress");
    const policy = resources[idOf("AWS::IAM::Policy", "SlackIngressSelfInvoke")]!;
    expect(policy.Properties.PolicyDocument).toEqual({ Version: "2012-10-17", Statement: [
      { Action: "lambda:InvokeFunction", Effect: "Allow", Resource: { "Fn::GetAtt": [ingressId, "Arn"] } },
    ] });
    expect(JSON.stringify((resources[ingressId] as { DependsOn?: unknown }).DependsOn ?? [])).not.toContain("SlackIngressSelfInvoke");
  });

  it("leaves the legacy template without any of it", () => {
    legacy.resourceCountIs("AWS::Lambda::EventInvokeConfig", 0);
    expect(Object.keys(legacy.toJSON().Resources as Record<string, unknown>).some((id) => id.startsWith("SlackHandOff") || id.startsWith("SlackIngressSelfInvoke"))).toBe(false);
  });
});
