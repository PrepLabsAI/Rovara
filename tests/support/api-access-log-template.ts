import { expect } from "vitest";
import { API_ACCESS_LOG_FORMAT } from "../../infra/lib/api-access-log.js";

type Resource = { Type: string; Properties: Record<string, unknown>; DependsOn?: unknown; UpdateReplacePolicy?: string; DeletionPolicy?: string };

/** The access log group's name for an install: a named environment (`env`), or the legacy production install (none). */
export function apiAccessLogGroupName(env?: string): string {
  return `/aws/vendedlogs/agentx/${env ?? "production"}/control-plane-api-access`;
}

/**
 * APIGW-ACCESS-LOGS (2026-11-24): the control plane gains exactly two changes and nothing else: one CloudWatch log group (one month, destroyed with the stack, a fixed name under
 * `/aws/vendedlogs/agentx/<env>/`) and `AccessLogSettings` on the `$default` stage (that group's ARN and the JSON format). Both are checked here to be exactly this, then taken out, so the
 * rest of the template must still match every recorded pin and snapshot. A named environment's tag is the one the other resources carry.
 *
 * Takes the additions out of `input` itself (like the other withoutX helpers) and returns it; clone first to keep the original.
 */
export function withoutApiAccessLog<T>(input: T, install: { env?: string } = {}): T {
  const resources = (input as { Resources: Record<string, Resource> }).Resources;
  const groups = Object.keys(resources).filter((id) => id.startsWith("ApiAccessLogs"));
  expect(groups).toHaveLength(1);
  const groupId = groups[0]!;
  expect(resources[groupId]).toStrictEqual({
    Type: "AWS::Logs::LogGroup",
    Properties: {
      LogGroupName: apiAccessLogGroupName(install.env),
      RetentionInDays: 30,
      ...(install.env === undefined ? {} : { Tags: [{ Key: "agentx:env", Value: install.env }] }),
    },
    UpdateReplacePolicy: "Delete",
    DeletionPolicy: "Delete",
  });
  const stage = resources["DefaultStage"]!;
  expect(stage.Type).toBe("AWS::ApiGatewayV2::Stage");
  expect(stage.Properties.AccessLogSettings).toStrictEqual({ DestinationArn: { "Fn::GetAtt": [groupId, "Arn"] }, Format: API_ACCESS_LOG_FORMAT });
  delete stage.Properties.AccessLogSettings;
  delete resources[groupId];
  return input;
}
