import { expect } from "vitest";

/** L6 adds exactly this capability-authenticated GET (logical ID ModelAccessRoute, as staging 0.5.18 holds it: switch-over incident 2026-11-16); keep the historical remainder pins intact. */
export function withoutCoreModelAccessRoute(template: unknown): void {
  const resources = (template as { Resources: Record<string, unknown> }).Resources;
  expect(resources["ModelAccessRoute"]).toEqual({
    Type: "AWS::ApiGatewayV2::Route",
    Properties: {
      ApiId: { Ref: "HttpApi" },
      AuthorizationType: "NONE",
      RouteKey: "GET /v1/internal/model-access",
      Target: { "Fn::Join": ["", ["integrations/", { Ref: "BrokerIntegration" }]] },
    },
  });
  delete resources["ModelAccessRoute"];
}
