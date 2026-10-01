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

// Issue 157 changes the Slack service's code only. These snapshots were recorded from mainline
// 4a605fd (re-recorded there when mainline merged in), so a named environment's templates must stay
// as they were, apart from issue 46's dispatch dead-letter alarm, checked and taken out above.
describe("named environment templates", () => {
  const stacks = buildAgentXApp({ agentxEnv: "staging" }).node.children.filter((child): child is Stack => Stack.isStack(child));
  for (const stack of stacks) {
    it(`${stack.stackName} is unchanged`, () => {
      const template = normalizedTemplate(stack);
      expect(stack.stackName === "agentx-staging-control-plane" ? withoutDispatchDeadLettersAlarm(template) : template).toMatchSnapshot();
    }, 120_000);
  }
});
