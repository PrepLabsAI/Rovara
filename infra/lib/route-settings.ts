// The API stage's per-route settings (throttles, detailed metrics) have ONE owner: this helper. A CfnStage has a single `routeSettings` map, and a plain assignment
// (`stage.routeSettings = {...}`) from one construct silently wipes what another construct set before it (the webhook lane W3 found developer-signin.ts doing exactly that,
// which would have dropped the public GitHub webhook route's throttle). Every construct adds its routes here: the map is merged, never replaced, and a route that two
// constructs both set to different values stops synthesis.
import { Token } from "aws-cdk-lib";
import type { aws_apigatewayv2 as apigwv2 } from "aws-cdk-lib";

export interface RouteSetting {
  ThrottlingBurstLimit: number;
  ThrottlingRateLimit: number;
  DetailedMetricsEnabled?: boolean;
}

/** Adds `settings` (route key to setting) to the stage's route settings, keeping every route already there, and makes the stage wait for each route (a setting must name a route that exists). */
export function addRouteSettings(stage: apigwv2.CfnStage, routes: readonly apigwv2.CfnRoute[], settings: Readonly<Record<string, RouteSetting>>): void {
  const current: unknown = stage.routeSettings;
  if (current !== undefined && (Token.isUnresolved(current) || typeof current !== "object" || current === null)) {
    throw new Error("the stage's route settings are not a plain map, so a route cannot be added to them without replacing what is there");
  }
  const merged: Record<string, RouteSetting> = { ...(current as Record<string, RouteSetting> | undefined) };
  for (const [routeKey, setting] of Object.entries(settings)) {
    const existing = merged[routeKey];
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(setting)) throw new Error(`the stage's route settings for ${routeKey} are set twice, differently`);
    merged[routeKey] = setting;
  }
  stage.routeSettings = merged;
  for (const route of routes) stage.addDependency(route);
}
