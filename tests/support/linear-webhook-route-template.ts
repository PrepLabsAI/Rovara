import { expect } from "vitest";

type Resource = { Type: string; Properties: Record<string, unknown>; DependsOn?: string | string[] };

const ROUTE_KEY = "POST /v1/linear/webhooks";

/**
 * Linear webhook guard (follow-up to DEC 254zzz488): BOTH layouts gain, and ONLY gain, the Linear route's stage throttle (one RouteSettings entry in the `$default` stage, which waits for the
 * route) and one alarm on the route's rejected requests, the same as the GitHub route's (tests/support/webhook-secret-template.ts). Each is pinned exactly here and then taken out of `input`
 * itself, so every earlier pin and snapshot holds as recorded: the legacy pins as recorded, and the named full-template pin through its recorded "minus the guard" value.
 * Takes out no other route setting and no other alarm.
 */
export function withoutLinearWebhookGuard<T>(input: T): T {
  const resources = (input as { Resources: Record<string, Resource> }).Resources;
  const idsOf = (type: string, matches: (resource: Resource) => boolean) => Object.keys(resources).filter((id) => resources[id]!.Type === type && matches(resources[id]!));

  const alarms = idsOf("AWS::CloudWatch::Alarm", (resource) => JSON.stringify(resource.Properties.Dimensions ?? "").includes(ROUTE_KEY));
  expect(alarms).toHaveLength(1);
  expect(resources[alarms[0]!]!.Properties).toMatchObject({
    Namespace: "AWS/ApiGateway", MetricName: "4xx", Statistic: "Sum", Period: 300, EvaluationPeriods: 1, Threshold: 300,
    ComparisonOperator: "GreaterThanOrEqualToThreshold", TreatMissingData: "notBreaching",
  });
  expect(String(resources[alarms[0]!]!.Properties.AlarmName)).toMatch(/LinearWebhookRejected$/u);

  const routes = idsOf("AWS::ApiGatewayV2::Route", (resource) => resource.Properties.RouteKey === ROUTE_KEY);
  expect(routes).toHaveLength(1);
  const stages = idsOf("AWS::ApiGatewayV2::Stage", () => true);
  expect(stages).toHaveLength(1);
  const stage = resources[stages[0]!]!;
  const settings = stage.Properties.RouteSettings as Record<string, unknown>;
  expect(settings[ROUTE_KEY]).toEqual({ ThrottlingBurstLimit: 100, ThrottlingRateLimit: 20, DetailedMetricsEnabled: true });
  delete settings[ROUTE_KEY];
  const dependsOn = [stage.DependsOn].flat().filter((id): id is string => id !== undefined);
  expect(dependsOn).toContain(routes[0]!);
  const remaining = dependsOn.filter((id) => id !== routes[0]!);
  if (remaining.length === 0) delete stage.DependsOn;
  else stage.DependsOn = Array.isArray(stage.DependsOn) ? remaining : remaining[0]!;

  delete resources[alarms[0]!];
  return input;
}

/**
 * DEC 254zzz488: the legacy install (beta, production) gains the Linear app's webhook route, under the logical ID the named environments already had. It is one
 * AWS::ApiGatewayV2::Route and nothing else: no authorizer (the broker verifies the HMAC, the timestamp and the workspace's binding), the broker's own integration (the same target as
 * ProxyRoute). It is checked here to be exactly that, then taken out of `input` itself (like the other withoutX helpers), so every earlier pin and snapshot of the legacy template still
 * holds as recorded. Clone first to keep the original. tests/contract/linear-webhook-route.test.ts pins the route and the rest of the webhook path on both layouts.
 * LEGACY ONLY: it takes out the guard first (withoutLinearWebhookGuard: the route's throttle and alarm, which only exist with the route), so a legacy pin holds as recorded before the route.
 */
export function withoutLinearWebhookRoute<T>(input: T): T {
  withoutLinearWebhookGuard(input);
  const resources = (input as { Resources: Record<string, Resource> }).Resources;
  const route = resources["LinearWebhookRoute"];
  expect(route).toBeDefined();
  expect(route).toStrictEqual({
    Type: "AWS::ApiGatewayV2::Route",
    Properties: {
      ApiId: resources["ProxyRoute"]!.Properties["ApiId"],
      AuthorizationType: "NONE",
      RouteKey: "POST /v1/linear/webhooks",
      Target: resources["ProxyRoute"]!.Properties["Target"],
    },
  });
  delete resources["LinearWebhookRoute"];
  return input;
}
