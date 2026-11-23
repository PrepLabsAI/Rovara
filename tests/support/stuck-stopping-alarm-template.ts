import { expect } from "vitest";

type Resource = { Type: string; Properties: Record<string, unknown> };

/** The alarm's name, namespace and tag for an install: a named environment (`env`), or the legacy production install (none). */
export function stuckStoppingInstall(env?: string): { alarmName: string; namespace: string; env?: string } {
  return env === undefined ? { alarmName: "AgentXSessionStuckStopping", namespace: "AgentX" } : { alarmName: `agentx-${env}-SessionStuckStopping`, namespace: `AgentX/${env}`, env };
}

/**
 * DEC 254zzz432 P1: a session that stays STOPPING keeps its instance billing, so the session lifecycle adds ONE resource to a control plane, and nothing else:
 * the SessionStuckStopping alarm on the reaper's SessionsStopping metric (no new permission: the reaper writes metrics in log format). It is checked here to be
 * exactly this, then taken out, so the rest of the template must still match the recorded snapshot.
 *
 * Takes the alarm out of `input` itself (like the other withoutX helpers) and returns it; clone first to keep the original.
 */
export function withoutStuckStoppingAlarm<T>(input: T, install: { alarmName: string; namespace: string; env?: string }): T {
  const resources = (input as { Resources: Record<string, Resource> }).Resources;
  const topicId = Object.keys(resources).find((id) => id.startsWith("OperatorAlerts") && resources[id]!.Type === "AWS::SNS::Topic");
  expect(topicId).toBeDefined();
  const alarms = Object.keys(resources).filter((id) => id.startsWith("SessionsStuckStoppingAlarm"));
  expect(alarms).toHaveLength(1);
  expect(resources[alarms[0]!]).toStrictEqual({
    Type: "AWS::CloudWatch::Alarm",
    Properties: {
      AlarmActions: [{ Ref: topicId }],
      AlarmDescription: "An EC2 session has stayed STOPPING for ten minutes, so its instance may still be running and billing. Check the reaper's logs, then the workspace's instance and volume in EC2 (a terminate that failed or an instance stuck shutting down, or a volume that will not detach).",
      AlarmName: install.alarmName,
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
      DatapointsToAlarm: 10,
      EvaluationPeriods: 10,
      MetricName: "SessionsStopping",
      Namespace: install.namespace,
      Period: 60,
      Statistic: "Minimum",
      ...(install.env === undefined ? {} : { Tags: [{ Key: "agentx:env", Value: install.env }] }),
      Threshold: 1,
      TreatMissingData: "notBreaching",
    },
  });
  delete resources[alarms[0]!];
  return input;
}
