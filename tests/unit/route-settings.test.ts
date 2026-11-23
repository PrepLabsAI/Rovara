// Webhook lane W3: the API stage's route settings have one owner. A plain `stage.routeSettings = {...}` from one construct wipes what another set (developer-signin.ts did,
// which would have dropped the public webhook route's throttle); addRouteSettings merges, in either order, and refuses a route set twice differently.
import { App, Stack } from "aws-cdk-lib";
import { aws_apigatewayv2 as apigwv2 } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { addRouteSettings } from "../../infra/lib/route-settings.js";

function fixture() {
  const stack = new Stack(new App(), "RouteSettings");
  const api = new apigwv2.CfnApi(stack, "Api", { name: "api", protocolType: "HTTP" });
  const stage = new apigwv2.CfnStage(stack, "Stage", { apiId: api.ref, stageName: "$default" });
  const route = (id: string, routeKey: string) => new apigwv2.CfnRoute(stack, id, { apiId: api.ref, routeKey });
  return { stack, stage, route };
}
const A = { ThrottlingBurstLimit: 50, ThrottlingRateLimit: 20 };
const B = { ThrottlingBurstLimit: 100, ThrottlingRateLimit: 20, DetailedMetricsEnabled: true };

describe("addRouteSettings", () => {
  it("keeps the routes another construct set, whichever adds first", () => {
    for (const order of [["a", "b"], ["b", "a"]] as const) {
      const { stage, route } = fixture();
      const routes = { a: route("RouteA", "ANY /a"), b: route("RouteB", "POST /b") };
      const settings = { a: { "ANY /a": A }, b: { "POST /b": B } };
      for (const key of order) addRouteSettings(stage, [routes[key]], settings[key]);
      expect(stage.routeSettings).toEqual({ "ANY /a": A, "POST /b": B });
    }
  });

  it("makes the stage wait for every route it names", () => {
    const { stack, stage, route } = fixture();
    addRouteSettings(stage, [route("RouteA", "ANY /a"), route("RouteB", "POST /b")], { "ANY /a": A, "POST /b": B });
    const resources = Template.fromStack(stack).toJSON().Resources as Record<string, { DependsOn?: string[] }>;
    expect([...(resources.Stage?.DependsOn ?? [])].sort()).toEqual(["RouteA", "RouteB"]);
  });

  it("stops synthesis when one route is set twice, differently, and accepts the same setting twice", () => {
    const { stage, route } = fixture();
    const r = route("RouteA", "ANY /a");
    addRouteSettings(stage, [r], { "ANY /a": A });
    expect(() => addRouteSettings(stage, [r], { "ANY /a": A })).not.toThrow();
    expect(() => addRouteSettings(stage, [r], { "ANY /a": B })).toThrow(/ANY \/a are set twice, differently/u);
  });
});
