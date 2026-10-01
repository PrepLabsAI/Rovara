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

  it("filters by the agentx:env tag under tag scope, and nothing at all under account scope", () => {
    const [budget] = Object.values(controlPlane.findResources("AWS::Budgets::Budget")) as Array<{ Properties: { Budget: { CostFilters: unknown } } }>;
    expect(budget!.Properties.Budget.CostFilters).toEqual({
      "Fn::If": ["BudgetByTag", { TagKeyValue: ["user:agentx:env$staging"] }, { Ref: "AWS::NoValue" }],
    });
  });

  it("refuses anything but a plain integer (no leading zero) as the monthly budget amount", () => {
    // "00" must not slip past the HasBudget condition's StringEquals check against the literal "0".
    controlPlane.hasParameter("BudgetMonthlyUsd", { Type: "String", Default: "0", AllowedPattern: "^(0|[1-9][0-9]{0,6})$" });
  });

  it("makes the budget depend on the topic policy, so Budgets never publishes before it may", () => {
    const [budget] = Object.values(controlPlane.findResources("AWS::Budgets::Budget")) as Array<{ DependsOn?: string | string[] }>;
    const topicPolicyIds = Object.keys(controlPlane.findResources("AWS::SNS::TopicPolicy"));
    expect(topicPolicyIds.length).toBeGreaterThan(0);
    const dependsOn = [budget!.DependsOn].flat().filter((id): id is string => typeof id === "string");
    expect(dependsOn.length).toBeGreaterThan(0);
    expect(dependsOn.every((id) => topicPolicyIds.includes(id))).toBe(true);
  });

  it("lets AWS Budgets publish to the topic, from this account and only a Budgets ARN in it", () => {
    // Finds the statement AWS Budgets actually gets, rather than searching the whole policy
    // document as a string: the existing CloudWatch statement also carries "aws:SourceAccount" and
    // would satisfy a plain string search even if the Budgets statement's own condition were wrong
    // or missing.
    const policies = Object.values(controlPlane.findResources("AWS::SNS::TopicPolicy")) as Array<{
      Properties: { PolicyDocument: { Statement: Array<{ Principal?: { Service?: string }; Condition?: Record<string, unknown> }> } };
    }>;
    const statement = policies.flatMap((p) => p.Properties.PolicyDocument.Statement).find((s) => s.Principal?.Service === "budgets.amazonaws.com");
    expect(statement).toBeDefined();
    const condition = statement!.Condition as { StringEquals?: Record<string, unknown>; ArnLike?: Record<string, unknown> };
    expect(condition.StringEquals).toEqual({ "aws:SourceAccount": { Ref: "AWS::AccountId" } });
    expect(condition.ArnLike).toEqual({ "aws:SourceArn": { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":budgets::", { Ref: "AWS::AccountId" }, ":*"]] } });
  });
});

describe("issue #46: the dispatch dead-letter queue alarm (environment naming)", () => {
  it("alarms on any visible message in the dispatch dead-letter queue, sending to the environment's topic", () => {
    const found = Object.values(controlPlane.findResources("AWS::CloudWatch::Alarm", { Properties: { AlarmName: "agentx-staging-DispatchDeadLetters" } })) as Array<{ Properties: Record<string, unknown>; Condition?: string }>;
    expect(found).toHaveLength(1);
    const dispatch = found[0]!;
    const [queueId] = Object.keys(controlPlane.findResources("AWS::SQS::Queue")).filter((id) => /^DispatchDeadLetterQueue[0-9A-F]{8}$/.test(id));
    expect(queueId).toBeDefined();
    expect(dispatch.Properties.Namespace).toBe("AWS/SQS");
    expect(dispatch.Properties.MetricName).toBe("ApproximateNumberOfMessagesVisible");
    expect(dispatch.Properties.Dimensions).toEqual([{ Name: "QueueName", Value: { "Fn::GetAtt": [queueId, "QueueName"] } }]);
    expect(dispatch.Properties.Statistic).toBe("Maximum");
    expect(dispatch.Properties.Period).toBe(300);
    expect(dispatch.Properties.Threshold).toBe(1);
    expect(dispatch.Properties.EvaluationPeriods).toBe(1);
    expect(dispatch.Properties.ComparisonOperator).toBe("GreaterThanOrEqualToThreshold");
    expect(dispatch.Properties.TreatMissingData).toBe("notBreaching");
    expect(dispatch.Condition).toBeUndefined();
    const [topicId] = Object.keys(controlPlane.findResources("AWS::SNS::Topic")).filter((id) => id.startsWith("OperatorAlerts"));
    expect(topicId).toBeDefined();
    expect(dispatch.Properties.AlarmActions).toEqual([{ Ref: topicId }]);
  });

  it("names the alarm with a single-word suffix, so the admin health route lists it as this environment's", () => {
    // health-probes.ts skips any name with a further hyphen after the prefix (a sibling environment).
    const prefix = naming.alarmName("");
    const [queueId] = Object.keys(controlPlane.findResources("AWS::SQS::Queue")).filter((id) => /^DispatchDeadLetterQueue[0-9A-F]{8}$/.test(id));
    const names = Object.values(controlPlane.findResources("AWS::CloudWatch::Alarm"))
      .map((resource) => resource as { Properties: { AlarmName?: string; Dimensions?: unknown } })
      .filter((resource) => JSON.stringify(resource.Properties.Dimensions ?? []).includes(`"${queueId}"`))
      .map((resource) => resource.Properties.AlarmName);
    expect(names).toHaveLength(1);
    expect(names[0]!.startsWith(prefix)).toBe(true);
    expect(names[0]!.slice(prefix.length)).toMatch(/^[A-Za-z0-9]+$/);
  });
});

describe("the legacy stacks stay as they are", () => {
  it("adds none of this without environment naming", () => {
    const legacySlack = Template.fromStack(new SlackOrchestratorStack(new App(), "LegacySlack"));
    expect(Object.keys(legacySlack.findParameters("OperatorAlertsTopicArn"))).toEqual([]);
    expect(Object.keys(legacySlack.findResources("AWS::CloudWatch::Alarm"))).toEqual([]);
    const legacyControlPlane = Template.fromStack(new ControlPlaneStack(new App(), "LegacyControlPlane"));
    expect(Object.keys(legacyControlPlane.findResources("AWS::Budgets::Budget"))).toEqual([]);
    expect(Object.keys(legacyControlPlane.findResources("AWS::CloudWatch::Alarm", { Properties: { AlarmName: "AgentXDispatchDeadLetters" } }))).toEqual([]);
    const legacyAlarmQueues = Object.values(legacyControlPlane.findResources("AWS::CloudWatch::Alarm")).map((resource) => JSON.stringify((resource as { Properties: { Dimensions?: unknown } }).Properties.Dimensions ?? []));
    expect(legacyAlarmQueues.some((dimensions) => dimensions.includes("DispatchDeadLetterQueue"))).toBe(false);
  });
});
