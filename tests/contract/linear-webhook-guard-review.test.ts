// Opus review of the Linear webhook guard (9c5f9dd5f): the alarm is pinned in FULL on both layouts (the legacy layout has no full-template pin: its pins are taken with the
// route and guard removed, and withoutLinearWebhookGuard only matches a subset of the alarm's properties), and the stage carries no DefaultRouteSettings to preserve.
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { LINEAR_WEBHOOK_ROUTE } from "../../infra/lib/linear-webhook.js";
import { environmentNaming, legacyNaming } from "../../infra/lib/naming.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Json = Record<string, unknown>;
interface Resource { Type: string; Properties: Json; DependsOn?: string | string[] }
interface Template_ { Resources: Record<string, Resource> }

const named = Template.fromStack(new ControlPlaneStack(new App(), "LinearGuardReviewNamed", { naming: environmentNaming("staging") })).toJSON() as Template_;
const legacy = Template.fromStack(new ControlPlaneStack(new App(), "LinearGuardReviewLegacy")).toJSON() as Template_;
const entries = (template: Template_, type: string) => Object.entries(template.Resources).filter(([, resource]) => resource.Type === type);

describe.each([
  ["named (staging)", named, environmentNaming("staging")],
  ["legacy (beta, production)", legacy, legacyNaming()],
] as const)("Linear webhook guard review, %s", (_label, template, naming) => {
  it("the alarm is exactly this: 4xx on the Linear route of this API's $default stage, one action to the operator topic, nothing else", () => {
    const apis = entries(template, "AWS::ApiGatewayV2::Api");
    expect(apis).toHaveLength(1);
    const alarms = entries(template, "AWS::CloudWatch::Alarm").filter(([, alarm]) => JSON.stringify(alarm.Properties.Dimensions ?? "").includes(LINEAR_WEBHOOK_ROUTE));
    expect(alarms).toHaveLength(1);
    const [, alarm] = alarms[0]!;
    const actions = alarm.Properties.AlarmActions as Array<{ Ref: string }>;
    expect(actions).toHaveLength(1);
    expect(template.Resources[actions[0]!.Ref]!.Type).toBe("AWS::SNS::Topic");
    expect(alarm.Properties).toEqual({
      AlarmName: naming.alarmName("LinearWebhookRejected"),
      AlarmDescription: expect.stringMatching(/^The Linear webhook route is rejecting a steady stream of requests/u) as unknown,
      Namespace: "AWS/ApiGateway", MetricName: "4xx", Statistic: "Sum", Period: 300, EvaluationPeriods: 1, Threshold: 300,
      ComparisonOperator: "GreaterThanOrEqualToThreshold", TreatMissingData: "notBreaching",
      Dimensions: [{ Name: "ApiId", Value: { Ref: apis[0]![0] } }, { Name: "Route", Value: LINEAR_WEBHOOK_ROUTE }, { Name: "Stage", Value: "$default" }],
      AlarmActions: actions,
    });
    expect(alarm.DependsOn).toBeUndefined();
  });

  it("the stage has no DefaultRouteSettings (nothing stage-wide to lose) and keeps its other properties", () => {
    const stages = entries(template, "AWS::ApiGatewayV2::Stage");
    expect(stages).toHaveLength(1);
    const [id, stage] = stages[0]!;
    expect(id).toBe("DefaultStage");
    expect(Object.keys(stage.Properties).sort()).toEqual(["AccessLogSettings", "ApiId", "AutoDeploy", "RouteSettings", "StageName"]);
    expect(stage.Properties.StageName).toBe("$default");
  });
});
