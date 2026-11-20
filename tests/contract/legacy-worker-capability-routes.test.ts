import { Stack } from "aws-cdk-lib";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { legacyProductionStacks, normalizedTemplate } from "../support/template-snapshot.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

// The legacy install (no agentxEnv) used to lack the two worker-capability GET routes, so a worker's read of its
// source list fell through to the JWT-authorized ANY /{proxy+} route and got 401 (CALLBACK_FORBIDDEN), blocking
// every core-engine task at UNDERSTAND. These tests pin that both installs now have them, under the same IDs.

type Resource = { Type: string; Properties?: Record<string, unknown> };
type Resources = Record<string, Resource>;

const NEW_ROUTES: ReadonlyArray<readonly [string, string]> = [
  ["ContextToolsListRoute", "GET /v1/internal/context-tools"],
  ["DesignReviewPacketRoute", "GET /v1/internal/design-review/packet"],
];

// Every HttpApi route of the legacy control-plane template before this change (logical ID -> route key).
const LEGACY_ROUTES_BEFORE: Readonly<Record<string, string>> = {
  ChannelApiActionsRoute7A0ACA43: "POST /v1/channels/{channel}/actions",
  ChannelApiConversationStateRoute5CAEAB4F: "POST /v1/channels/{channel}/conversation-state",
  ChannelApiDecisionsRoute248618C4: "POST /v1/channels/{channel}/decisions",
  ChannelApiMessagesRouteCECC4513: "POST /v1/channels/{channel}/messages",
  ChannelApiSlackCommandsRoute2A3464BE: "POST /v1/slack/channel-commands",
  ChannelApiSlackEventsRouteC008BAED: "POST /v1/slack/channel-events",
  DeveloperSignInAppRouteBAD38FAA: "ANY /v1/app/{proxy+}",
  DeveloperSignInAuthRoute98555360: "ANY /v1/auth/{proxy+}",
  DeveloperSignInDevRoute4BB932E2: "ANY /v1/dev/{proxy+}",
  DeveloperSignInFeedbackReviewRoute881C7CFE: "ANY /review/{proxy+}",
  GithubWebhookRoute: "POST /v1/github/webhooks",
  ModelAccessRoute: "GET /v1/internal/model-access",
  ProjectSetupExecutionReadRoute: "GET /v1/internal/project-setups/{setupExecutionId}/execution",
  ProxyRoute: "ANY /{proxy+}",
  SlackEventsRoute: "POST /v1/slack/events",
  SlackInteractivityRoute: "POST /v1/slack/interactions",
  SlackServiceRoute: "ANY /v1/service/{proxy+}",
  WorkerCallbackRoute: "POST /v1/internal/{proxy+}",
};

const routesOf = (stack: Stack): Resources => {
  const resources = (normalizedTemplate(stack) as { Resources: Resources }).Resources;
  return Object.fromEntries(Object.entries(resources).filter(([, row]) => row.Type === "AWS::ApiGatewayV2::Route"));
};

describe("worker-capability routes on the legacy install", () => {
  const legacy = routesOf(legacyProductionStacks().find((stack) => stack.stackName === "AgentXControlPlane")!);

  it("has exactly the two capability GET routes, unauthenticated at the gateway, targeting the broker integration", () => {
    for (const [id, routeKey] of NEW_ROUTES) {
      const row = legacy[id];
      expect(row, id).toBeDefined();
      expect(row!.Properties).toEqual({ ...legacy.ModelAccessRoute!.Properties, RouteKey: routeKey });
      expect(row!.Properties?.AuthorizationType).toBe("NONE");
      expect(row!.Properties).not.toHaveProperty("AuthorizerId");
      expect(row!.Properties?.Target).toEqual(legacy.ProxyRoute!.Properties?.Target);
    }
    expect(legacy.ProxyRoute!.Properties?.AuthorizationType).toBe("JWT");
  });

  it("keeps every route ID and key the legacy template already had", () => {
    for (const [id, routeKey] of Object.entries(LEGACY_ROUTES_BEFORE)) {
      expect(legacy[id]?.Properties?.RouteKey, id).toBe(routeKey);
    }
    expect(Object.keys(legacy).sort()).toStrictEqual([...Object.keys(LEGACY_ROUTES_BEFORE), ...NEW_ROUTES.map(([id]) => id)].sort());
  });

  it("has unique route keys", () => {
    const keys = Object.values(legacy).map((row) => row.Properties?.RouteKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("worker-capability routes on a named environment", () => {
  const stacks = buildAgentXApp({ agentxEnv: "staging" }).node.children.filter((child): child is Stack => Stack.isStack(child));
  const named = routesOf(stacks.find((stack) => stack.stackName === "agentx-staging-control-plane")!);

  it("has the same two routes under the same IDs and keys as the legacy install", () => {
    for (const [id, routeKey] of NEW_ROUTES) {
      expect(named[id]?.Properties?.RouteKey, id).toBe(routeKey);
      expect(named[id]?.Properties?.AuthorizationType).toBe("NONE");
    }
  });
});
