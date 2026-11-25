// DEC 254zzz488 follow-up (Linear webhook guard): the public Linear webhook route's stage throttle and the alarm on its rejected requests, the same as the GitHub route's
// (github-webhook.ts). Kept out of control-plane.ts (its complexity ratchet). Both layouts: the named environments and the legacy install (beta, production).
import { Duration } from "aws-cdk-lib";
import { aws_cloudwatch as cloudwatch } from "aws-cdk-lib";
import type { aws_apigatewayv2 as apigwv2, aws_cloudwatch_actions as cloudwatchActions } from "aws-cdk-lib";
import type { Construct } from "constructs";
import type { AgentXNaming } from "./naming.js";
import { addRouteSettings, type RouteSetting } from "./route-settings.js";

/** The public Linear webhook route (also the one stage route setting that throttles it). */
export const LINEAR_WEBHOOK_ROUTE = "POST /v1/linear/webhooks";

/**
 * The public Linear webhook route is throttled at the stage: 20 requests a second, bursts of 100, ACROSS ALL CALLERS (a throttled request is a 429 and never reaches the broker; it is a
 * flood guard, not a per-workspace limit). Detailed metrics are on for this one route so the alarm can see a sustained flood. The map is merged with the other routes' (route-settings.ts),
 * never replaced. Linear treats a non-2xx answer as a failed delivery and retries it, so a 429 from a real burst is retried, not lost.
 * The alarm: the stage's 429s, a flood of bad signatures, stale timestamps (all 401) or oversize bodies count as 4xx. A real Linear delivery is a 2xx, so a steady 4xx rate here is junk, a
 * throttle that is dropping real deliveries, or a signing secret that Linear and AWS do not agree on after the owner's set-up. 300 in 5 minutes is about one a second, far below the 20 a
 * second throttle and far above anything a correct set-up produces.
 */
export function guardLinearWebhookRoute(scope: Construct, naming: AgentXNaming, apiId: string, stage: apigwv2.CfnStage, route: apigwv2.CfnRoute, notifyOperator: cloudwatchActions.SnsAction): void {
  const webhookThrottle: RouteSetting = { ThrottlingBurstLimit: 100, ThrottlingRateLimit: 20, DetailedMetricsEnabled: true };
  addRouteSettings(stage, [route], Object.fromEntries([[LINEAR_WEBHOOK_ROUTE, webhookThrottle]]));
  new cloudwatch.Alarm(scope, "LinearWebhookRejectedAlarm", {
    alarmName: naming.alarmName("LinearWebhookRejected"),
    alarmDescription: "The Linear webhook route is rejecting a steady stream of requests (429 throttle, 401 bad signature or stale timestamp, or 413). Linear issue and comment intake is dropped while this lasts. Check the broker log for linear.webhook_signature_failed lines; a bad signature after set-up means Linear and the app settings secret hold different webhook secrets.",
    metric: new cloudwatch.Metric({
      namespace: "AWS/ApiGateway", metricName: "4xx", statistic: "Sum", period: Duration.minutes(5),
      dimensionsMap: { ApiId: apiId, Stage: "$default", Route: LINEAR_WEBHOOK_ROUTE },
    }),
    threshold: 300,
    evaluationPeriods: 1,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  }).addAlarmAction(notifyOperator);
}
