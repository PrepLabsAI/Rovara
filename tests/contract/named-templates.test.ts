import { Stack } from "aws-cdk-lib";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { normalizedTemplate } from "../support/template-snapshot.js";

type Resource = { Type: string; Properties: Record<string, unknown> };
type Statement = { Sid?: string };

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
 * Issue 173 adds the reconciler backstop to a named control plane, and nothing else: three
 * environment variables, two statements and one alarm. Each is checked strictly to be exactly
 * this, then taken out, so the rest of the template must still match the recorded snapshot.
 */
function withoutUnwaitedTaskBackstop(template: unknown): unknown {
  const resources = (template as { Resources: Record<string, Resource> }).Resources;
  const reconcilerEntry = Object.entries(resources).find(([id, resource]) => id.startsWith("SessionsReconciler") && resource.Type === "AWS::Lambda::Function");
  expect(reconcilerEntry).toBeDefined();
  const reconciler = reconcilerEntry![1];
  const variables = (reconciler.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
  const threadsId = Object.keys(resources).find((id) => id.startsWith("SlackThreads") && resources[id]!.Type === "AWS::DynamoDB::Table")!;
  const slackSecretId = Object.keys(resources).find((id) => id.startsWith("SlackSecret") && resources[id]!.Type === "AWS::SecretsManager::Secret")!;
  const topicId = Object.keys(resources).find((id) => id.startsWith("OperatorAlerts") && resources[id]!.Type === "AWS::SNS::Topic");
  expect(threadsId).toBeDefined();
  expect(slackSecretId).toBeDefined();
  expect(topicId).toBeDefined();
  const added = { SLACK_THREADS_TABLE_NAME: { Ref: threadsId }, SLACK_SECRET_ARN: { Ref: slackSecretId }, CALLBACK_SIGNING_KEY: { Ref: "CallbackSigningKey" } };
  expect(Object.fromEntries(Object.keys(added).map((name) => [name, variables[name]]))).toStrictEqual(added);
  for (const name of Object.keys(added)) delete variables[name];
  const roleId = (reconciler.Properties.Role as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"][0];
  const policies = Object.values(resources).filter((resource) => resource.Type === "AWS::IAM::Policy"
    && (resource.Properties.Roles as Array<{ Ref?: string }>).some((role) => role.Ref === roleId));
  const sids = new Set(["ReadThreadWaiters", "PostUnwaitedTaskNote"]);
  const removed: Statement[] = [];
  for (const policy of policies) {
    const document = policy.Properties.PolicyDocument as { Statement: Statement[] };
    removed.push(...document.Statement.filter((statement) => sids.has(statement.Sid ?? "")));
    document.Statement = document.Statement.filter((statement) => !sids.has(statement.Sid ?? ""));
  }
  expect(removed).toStrictEqual([
    {
      Action: "dynamodb:GetItem",
      Condition: {
        "ForAllValues:StringEquals": { "dynamodb:Attributes": ["pk", "sk", "activeTurn"] },
        "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["THREAD#*"] },
        Null: { "dynamodb:Attributes": "false" },
        StringEqualsIfExists: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
      },
      Effect: "Allow",
      Resource: { "Fn::GetAtt": [threadsId, "Arn"] },
      Sid: "ReadThreadWaiters",
    },
    { Action: "secretsmanager:GetSecretValue", Effect: "Allow", Resource: { Ref: slackSecretId }, Sid: "PostUnwaitedTaskNote" },
  ]);
  const alarms = Object.keys(resources).filter((id) => id.startsWith("SessionsUnwaitedTaskFailuresAlarm"));
  expect(alarms).toHaveLength(1);
  const failures = (id: string, metricName: string) => ({
    Id: id, MetricStat: { Metric: { MetricName: metricName, Namespace: "AgentX/staging" }, Period: 600, Stat: "Maximum" }, ReturnData: false,
  });
  expect(resources[alarms[0]!]).toStrictEqual({
    Type: "AWS::CloudWatch::Alarm",
    Properties: {
      AlarmActions: [{ Ref: topicId }],
      AlarmDescription: "The reconciler could not check or cancel Slack tasks idle over 24 hours with nobody waiting, on two runs in a row. Check the reconciler's logs for unwaited_task.cancel_failed, unwaited_task.read_failed and reconciler.unwaited_task_sweep_failed.",
      AlarmName: "agentx-staging-UnwaitedTaskFailures",
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
      EvaluationPeriods: 2,
      Metrics: [
        { Expression: "FILL(cancels, 0) + FILL(reads, 0)", Id: "expr_1", Label: "Unwaited task cancel and read failures", ReturnData: true },
        failures("cancels", "ReconcilerUnwaitedTaskFailures"),
        failures("reads", "ReconcilerUnwaitedTaskReadFailures"),
      ],
      Tags: [{ Key: "agentx:env", Value: "staging" }],
      Threshold: 1,
      TreatMissingData: "notBreaching",
    },
  });
  delete resources[alarms[0]!];
  return template;
}

/**
 * Issue 195 adds the StuckCancels alarm to a named control plane, and nothing else: its retry runs in
 * the reconciler's own process with #173's signing key, so no grant and no environment variable. The
 * alarm is checked here to be exactly this, then taken out, so the rest of the template must still
 * match the recorded snapshot.
 */
function withoutStuckCancelAlarm(template: unknown): unknown {
  const resources = (template as { Resources: Record<string, Resource> }).Resources;
  const topicId = Object.keys(resources).find((id) => id.startsWith("OperatorAlerts") && resources[id]!.Type === "AWS::SNS::Topic");
  expect(topicId).toBeDefined();
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
        { Expression: "FILL(retries, 0) + FILL(ended, 0) + FILL(interrupted, 0) + FILL(failures, 0) + FILL(unretried, 0)", Id: "expr_1", Label: "Stuck cancels retried, ended or failed", ReturnData: true },
        stat("retries", "ReconcilerStuckCancelRetries"),
        stat("ended", "ReconcilerStuckCancelsEnded"),
        stat("interrupted", "ReconcilerStuckCancelsInterrupted"),
        stat("failures", "ReconcilerStuckCancelFailures"),
        stat("unretried", "ReconcilerStuckCancelsUnretried"),
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
// as they were, apart from issue 46's dispatch dead-letter alarm, issue 173's reconciler backstop and
// issue 195's stuck-cancel alarm, each checked and taken out above.
describe("named environment templates", () => {
  const stacks = buildAgentXApp({ agentxEnv: "staging" }).node.children.filter((child): child is Stack => Stack.isStack(child));
  for (const stack of stacks) {
    it(`${stack.stackName} is unchanged`, () => {
      const template = normalizedTemplate(stack);
      expect(stack.stackName === "agentx-staging-control-plane" ? withoutStuckCancelAlarm(withoutUnwaitedTaskBackstop(withoutDispatchDeadLettersAlarm(template))) : template).toMatchSnapshot();
    }, 120_000);
  }
});
