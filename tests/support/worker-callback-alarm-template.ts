import { expect } from "vitest";

type Resource = { Type: string; Properties: Record<string, unknown> };

/**
 * SETUP-CHECK-WATCH (gap C): a worker whose terminal callback was lost logs one `terminal_callback.failed` line. The control plane adds TWO resources for it, and nothing else (no permission, no variable: the
 * deploy role already holds logs:* and cloudwatch:*): a metric filter on the worker log group that counts the line, and the WorkerTerminalCallbackFailed alarm on that metric. They are checked here to be exactly
 * this, then taken out, so the rest of the template must still match every earlier pin and snapshot.
 *
 * Takes them out of `input` itself (like the other withoutX helpers) and returns it; clone first to keep the original. Only a control plane has them.
 */
export function withoutWorkerCallbackAlarm<T>(input: T): T {
  const resources = (input as { Resources: Record<string, Resource> }).Resources;
  const topicId = Object.keys(resources).find((id) => id.startsWith("OperatorAlerts") && resources[id]!.Type === "AWS::SNS::Topic");
  expect(topicId).toBeDefined();
  const alarms = Object.keys(resources).filter((id) => id.startsWith("WorkerTerminalCallbackFailedAlarm"));
  const filters = Object.keys(resources).filter((id) => id.startsWith("WorkerTerminalCallbackFailedMetric"));
  expect(alarms).toHaveLength(1);
  expect(filters).toHaveLength(1);
  const alarm = resources[alarms[0]!]!;
  const named = (alarm.Properties["AlarmName"] as string).endsWith("WorkerTerminalCallbackFailed");
  expect(named).toBe(true);
  expect(alarm).toStrictEqual({
    Type: "AWS::CloudWatch::Alarm",
    Properties: {
      AlarmActions: [{ Ref: topicId }],
      AlarmDescription: "A worker could not deliver an operation's end to the broker after every retry. Search the worker log group for terminal_callback.failed (invocation id, kind, HTTP status); the operation stays open until the broker's own watch ends it.",
      AlarmName: alarm.Properties["AlarmName"],
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
      EvaluationPeriods: 1,
      MetricName: "WorkerTerminalCallbackFailed",
      Namespace: alarm.Properties["Namespace"],
      Period: 300,
      Statistic: "Sum",
      ...(alarm.Properties["Tags"] === undefined ? {} : { Tags: alarm.Properties["Tags"] }),
      Threshold: 1,
      TreatMissingData: "notBreaching",
    },
  });
  const filter = resources[filters[0]!]!;
  expect(filter.Type).toBe("AWS::Logs::MetricFilter");
  expect(filter.Properties).toStrictEqual({
    FilterPattern: "{ $.event = \"terminal_callback.failed\" }",
    LogGroupName: expect.stringMatching(/^\/agentx\/[a-z0-9-]+\/worker$/u) as string,
    MetricTransformations: [{ MetricName: "WorkerTerminalCallbackFailed", MetricNamespace: alarm.Properties["Namespace"], MetricValue: "1" }],
  });
  delete resources[alarms[0]!];
  delete resources[filters[0]!];
  return withoutDispatchStaleAddressAlarm(input);
}

/**
 * REDACT-BLOCK-REASON (interim signal for the stale-address edge): the dispatcher logs one `dispatch.stale_address` line when a worker answers 401 wrong_workspace. Two more resources count it, same shape as the
 * worker's above: a metric filter on the dispatcher's log group and the DispatchStaleAddress alarm. Checked to be exactly this, then taken out (called by `withoutWorkerCallbackAlarm`, so every template pin that
 * already takes the worker's pair out takes this pair out too).
 */
export function withoutDispatchStaleAddressAlarm<T>(input: T): T {
  const resources = (input as { Resources: Record<string, Resource> }).Resources;
  const alarms = Object.keys(resources).filter((id) => id.startsWith("DispatchStaleAddressAlarm"));
  const filters = Object.keys(resources).filter((id) => id.startsWith("DispatchStaleAddressMetric"));
  expect(alarms).toHaveLength(1);
  expect(filters).toHaveLength(1);
  const alarm = resources[alarms[0]!]!;
  expect(alarm.Type).toBe("AWS::CloudWatch::Alarm");
  expect(alarm.Properties).toMatchObject({ MetricName: "DispatchStaleAddress", Statistic: "Sum", Period: 300, Threshold: 1, EvaluationPeriods: 1, ComparisonOperator: "GreaterThanOrEqualToThreshold", TreatMissingData: "notBreaching" });
  const filter = resources[filters[0]!]!;
  expect(filter.Type).toBe("AWS::Logs::MetricFilter");
  expect(filter.Properties).toMatchObject({
    FilterPattern: "{ $.event = \"dispatch.stale_address\" }",
    MetricTransformations: [{ MetricName: "DispatchStaleAddress", MetricNamespace: alarm.Properties["Namespace"], MetricValue: "1" }],
  });
  delete resources[alarms[0]!];
  delete resources[filters[0]!];
  return input;
}
