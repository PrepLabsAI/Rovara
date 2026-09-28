import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { environmentNaming } from "../../infra/lib/naming.js";
import { SlackOrchestratorStack } from "../../infra/lib/slack-orchestrator.js";

const naming = environmentNaming("staging");
const slack = Template.fromStack(new SlackOrchestratorStack(new App(), "AlarmsSlack", { naming }));
const controlPlane = Template.fromStack(new ControlPlaneStack(new App(), "AlarmsControlPlane", { naming }));
const alarm = (name: string) => Object.values(slack.findResources("AWS::CloudWatch::Alarm", { Properties: { AlarmName: name } }))[0] as { Properties: Record<string, unknown>; Condition?: string } | undefined;

describe("FR-045 alarms in the Slack stack (environment naming)", () => {
  it("creates every alarm the spec names, each sending to the environment's topic", () => {
    for (const name of ["TurnErrors", "SlowTurns", "SlackDeliveryFailed", "CheckerFailures", "BedrockThrottling", "ClassifierThrottling", "TestAlarm"]) {
      const found = alarm(`agentx-staging-${name}`);
      expect(found, name).toBeDefined();
      expect(found!.Properties.AlarmActions).toEqual([{ Ref: "OperatorAlertsTopicArn" }]);
    }
  });

  it("turns failed turns and abandoned Slack requests into metrics from the service's own log events", () => {
    slack.hasResourceProperties("AWS::Logs::MetricFilter", Match.objectLike({
      FilterPattern: '{ $.event = "task.failed" }',
      MetricTransformations: [Match.objectLike({ MetricName: "TurnFailed", MetricNamespace: "AgentX/staging", MetricValue: "1" })],
    }));
    slack.hasResourceProperties("AWS::Logs::MetricFilter", Match.objectLike({
      FilterPattern: '{ $.event = "request.abandoned" }',
      MetricTransformations: [Match.objectLike({ MetricName: "SlackDeliveryFailed", MetricValue: "1" })],
    }));
  });

  it("compares the slowest turn in 5 minutes with SlowTurnMinutes", () => {
    slack.hasParameter("SlowTurnMinutes", { Type: "Number", Default: 5, MinValue: 1, MaxValue: 60 });
    expect(alarm("agentx-staging-SlowTurns")!.Properties.Threshold).toEqual({ Ref: "SlowTurnMinutes" });
  });

  it("watches Bedrock throttling only when the orchestrator or classifier runs on Bedrock", () => {
    const bedrock = alarm("agentx-staging-BedrockThrottling")!;
    expect(bedrock.Properties.Namespace).toBe("AWS/Bedrock");
    expect(bedrock.Properties.MetricName).toBe("InvocationThrottles");
    expect(bedrock.Properties.Dimensions).toEqual([{ Name: "ModelId", Value: { Ref: "ModelId" } }]);
    expect(bedrock.Condition).toBeDefined();
    expect(alarm("agentx-staging-ClassifierThrottling")!.Condition).toBeDefined();
  });

  it("keeps the test alarm quiet: it reads a metric nothing emits", () => {
    const test = alarm("agentx-staging-TestAlarm")!;
    // The exact name matters: the service role's Budget/TestAlarm access grant (spec 015 phase
    // 15d2 Task 1) is scoped to this literal alarm name, not a wildcard.
    expect(test.Properties.AlarmName).toBe("agentx-staging-TestAlarm");
    expect(test.Properties.MetricName).toBe("TestAlarmNeverEmitted");
    expect(test.Properties.TreatMissingData).toBe("notBreaching");
  });
});

describe("FR-047 budget in the control-plane stack (environment naming)", () => {
  it("creates the monthly budget only when BudgetMonthlyUsd is not 0, alerting the topic", () => {
    controlPlane.hasParameter("BudgetMonthlyUsd", { Type: "String", Default: "0" });
    controlPlane.hasParameter("BudgetScope", { Type: "String", Default: "tag", AllowedValues: ["tag", "account"] });
    const budgets = controlPlane.findResources("AWS::Budgets::Budget");
    const [budget] = Object.values(budgets) as Array<{ Condition?: string; Properties: { Budget: Record<string, unknown>; NotificationsWithSubscribers: unknown[]; ResourceTags?: unknown[] } }>;
    expect(budget!.Condition).toBeDefined();
    // The exact name matters: the service role's Budget access grant (spec 015 phase 15d2 Task 1)
    // is scoped to arn:<partition>:budgets::<account>:budget/agentx-<env>-monthly, not a wildcard.
    expect(budget!.Properties.Budget.BudgetName).toBe("agentx-staging-monthly");
    expect(JSON.stringify(budget!.Properties.NotificationsWithSubscribers)).toContain("OperatorAlerts");
    expect(JSON.stringify(budget!.Properties.Budget.CostFilters)).toContain("user:agentx:env$staging");
    // C5 / FR-047: every resource the installer creates carries agentx:env; AWS::Budgets::Budget
    // takes tags through ResourceTags rather than the stack's Tags.of(app), so it must be set here.
    expect(budget!.Properties.ResourceTags).toEqual([{ Key: "agentx:env", Value: "staging" }]);
  });

  it("lets AWS Budgets publish to the topic, from this account only", () => {
    const policies = JSON.stringify(controlPlane.findResources("AWS::SNS::TopicPolicy"));
    expect(policies).toContain("budgets.amazonaws.com");
    expect(policies).toContain("aws:SourceAccount");
  });
});

describe("the legacy stacks stay as they are", () => {
  it("adds none of this without environment naming", () => {
    const legacySlack = Template.fromStack(new SlackOrchestratorStack(new App(), "LegacySlack"));
    expect(Object.keys(legacySlack.findParameters("OperatorAlertsTopicArn"))).toEqual([]);
    expect(Object.keys(legacySlack.findResources("AWS::CloudWatch::Alarm"))).toEqual([]);
    const legacyControlPlane = Template.fromStack(new ControlPlaneStack(new App(), "LegacyControlPlane"));
    expect(Object.keys(legacyControlPlane.findResources("AWS::Budgets::Budget"))).toEqual([]);
  });
});
