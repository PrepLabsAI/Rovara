import { expect } from "vitest";

/** L6 adds exactly this capability-authenticated GET; keep the historical remainder pins intact. */
export function withoutCoreModelAccessRoute(template: unknown): void {
  const resources = (template as { Resources: Record<string, unknown> }).Resources;
  expect(resources["CoreModelAccessRoute"]).toEqual({
    Type: "AWS::ApiGatewayV2::Route",
    Properties: {
      ApiId: { Ref: "HttpApi" },
      AuthorizationType: "NONE",
      RouteKey: "GET /v1/internal/model-access",
      Target: { "Fn::Join": ["", ["integrations/", { Ref: "BrokerIntegration" }]] },
    },
  });
  delete resources["CoreModelAccessRoute"];
}
