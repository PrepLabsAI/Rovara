import { Stack } from "aws-cdk-lib";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { normalizedTemplate } from "../support/template-snapshot.js";

type Resource = { Type: string; Properties: Record<string, unknown> };

/**
 * Issue 46 adds one resource to a named control plane, and nothing else: the dispatch
 * dead-letter alarm. It is checked here to be exactly this, then taken out, so the rest of the
 * template must still match the recorded snapshot.
 */
function withoutDispatchDeadLettersAlarm(template: unknown): unknown {
  const resources = (template as { Resources: Record<string, Resource> }).Resources;
  const alarms = Object.keys(resources).filter((id) => id.startsWith("DispatchDeadLettersAlarm"));
  expect(alarms).toHaveLength(1);
  const queueId = Object.keys(resources).find((id) => id.startsWith("DispatchDeadLetterQueue") && resources[id]!.Type === "AWS::SQS::Queue");
  const topicId = Object.keys(resources).find((id) => id.startsWith("OperatorAlerts") && resources[id]!.Type === "AWS::SNS::Topic");
  expect(queueId).toBeDefined();
  expect(topicId).toBeDefined();
  expect(resources[alarms[0]!]).toStrictEqual({
    Type: "AWS::CloudWatch::Alarm",
    Properties: {
      AlarmActions: [{ Ref: topicId }],
      AlarmDescription: "A worker dispatch job exhausted its receives and is in the dispatch dead-letter queue. Check the dispatcher logs for its operation ID, then redrive or purge the queue.",
      AlarmName: "agentx-staging-DispatchDeadLetters",
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
      Dimensions: [{ Name: "QueueName", Value: { "Fn::GetAtt": [queueId, "QueueName"] } }],
      EvaluationPeriods: 1,
      MetricName: "ApproximateNumberOfMessagesVisible",
      Namespace: "AWS/SQS",
      Period: 300,
      Statistic: "Maximum",
      Tags: [{ Key: "agentx:env", Value: "staging" }],
      Threshold: 1,
      TreatMissingData: "notBreaching",
    },
  });
  delete resources[alarms[0]!];
  return template;
}

/**
 * Issue 195 adds the stuck-cancel retry to a named control plane, and nothing else: the broker's
 * name in the reconciler's environment, one statement letting it invoke the broker, and the
 * StuckCancels alarm. They are checked here to be exactly these, then taken out, so the rest of the
 * template must still match the recorded snapshot.
 */
function withoutStuckCancelRetry(template: unknown): unknown {
  const resources = (template as { Resources: Record<string, Resource> }).Resources;
  const reconcilers = Object.entries(resources).filter(([id, resource]) => id.startsWith("SessionsReconciler") && resource.Type === "AWS::Lambda::Function");
  expect(reconcilers).toHaveLength(1);
  const reconciler = reconcilers[0]![1];
  const brokerId = Object.keys(resources).find((id) => /^Broker[0-9A-F]{8}$/.test(id) && resources[id]!.Type === "AWS::Lambda::Function");
  const topicId = Object.keys(resources).find((id) => id.startsWith("OperatorAlerts") && resources[id]!.Type === "AWS::SNS::Topic");
  expect(brokerId).toBeDefined();
  expect(topicId).toBeDefined();
  const variables = (reconciler.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
  expect(variables.BROKER_FUNCTION_NAME).toStrictEqual({ Ref: brokerId });
  delete variables.BROKER_FUNCTION_NAME;
  const roleId = (reconciler.Properties.Role as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"][0];
  const policies = Object.values(resources).filter((resource) => resource.Type === "AWS::IAM::Policy"
    && (resource.Properties.Roles as Array<{ Ref?: string }>).some((role) => role.Ref === roleId));
  const removed: Array<{ Sid?: string }> = [];
  for (const policy of policies) {
    const document = policy.Properties.PolicyDocument as { Statement: Array<{ Sid?: string }> };
    removed.push(...document.Statement.filter((statement) => statement.Sid === "RetryStuckCancels"));
    document.Statement = document.Statement.filter((statement) => statement.Sid !== "RetryStuckCancels");
  }
  expect(removed).toStrictEqual([
    { Action: "lambda:InvokeFunction", Effect: "Allow", Resource: { "Fn::GetAtt": [brokerId, "Arn"] }, Sid: "RetryStuckCancels" },
  ]);
  const alarms = Object.keys(resources).filter((id) => id.startsWith("SessionsStuckCancelsAlarm"));
  expect(alarms).toHaveLength(1);
  const stat = (id: string, metricName: string) => ({
    Id: id, MetricStat: { Metric: { MetricName: metricName, Namespace: "AgentX/staging" }, Period: 900, Stat: "Maximum" }, ReturnData: false,
  });
  expect(resources[alarms[0]!]).toStrictEqual({
    Type: "AWS::CloudWatch::Alarm",
    Properties: {
      AlarmActions: [{ Ref: topicId }],
      AlarmDescription: "The reconciler found a task whose cancel never reached its worker, and queued the cancel again or ended the task (or failed to). Check the reconciler's logs for stuck_cancel events: a retried cancel that finishes, or an ended task, needs no action; repeated ones point at a dispatch or worker fault.",
      AlarmName: "agentx-staging-StuckCancels",
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
      EvaluationPeriods: 1,
      Metrics: [
        { Expression: "FILL(retries, 0) + FILL(ended, 0) + FILL(interrupted, 0) + FILL(failures, 0)", Id: "expr_1", Label: "Stuck cancels retried, ended or failed", ReturnData: true },
        stat("retries", "ReconcilerStuckCancelRetries"),
        stat("ended", "ReconcilerStuckCancelsEnded"),
        stat("interrupted", "ReconcilerStuckCancelsInterrupted"),
        stat("failures", "ReconcilerStuckCancelFailures"),
      ],
      Tags: [{ Key: "agentx:env", Value: "staging" }],
      Threshold: 1,
      TreatMissingData: "notBreaching",
    },
  });
  delete resources[alarms[0]!];
  return template;
}

// Issue 157 changes the Slack service's code only. These snapshots were recorded from mainline
// 4a605fd (re-recorded there when mainline merged in), so a named environment's templates must stay
// as they were, apart from issue 46's dispatch dead-letter alarm and issue 195's stuck-cancel
// retry, each checked and taken out above.
describe("named environment templates", () => {
  const stacks = buildAgentXApp({ agentxEnv: "staging" }).node.children.filter((child): child is Stack => Stack.isStack(child));
  for (const stack of stacks) {
    it(`${stack.stackName} is unchanged`, () => {
      const template = normalizedTemplate(stack);
      expect(stack.stackName === "agentx-staging-control-plane" ? withoutStuckCancelRetry(withoutDispatchDeadLettersAlarm(template)) : template).toMatchSnapshot();
    }, 120_000);
  }
});
