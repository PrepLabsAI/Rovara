// Webhook lane W3 (public GitHub webhook tracking): the control-plane stack's GitHub webhook pieces, kept out of control-plane.ts (its complexity ratchet).
//  - the dedicated webhook secret slot, created EMPTY and readable by the broker's role alone;
//  - the public webhook route's stage throttle and the alarm on its rejected requests.
import { Duration, RemovalPolicy } from "aws-cdk-lib";
import { aws_cloudwatch as cloudwatch, aws_iam as iam, aws_secretsmanager as secretsmanager } from "aws-cdk-lib";
import type { aws_apigatewayv2 as apigwv2, aws_cloudwatch_actions as cloudwatchActions, aws_lambda as lambda } from "aws-cdk-lib";
import type { Construct } from "constructs";
import { GITHUB_WEBHOOK_SECRET_VARIABLE, githubWebhookSecretName } from "@agentx/contracts";
import { addDerivedBrokerVariable } from "./broker-names.js";
import type { AgentXNaming } from "./naming.js";
import { addRouteSettings, type RouteSetting } from "./route-settings.js";

/** The public GitHub webhook route (also the one stage route setting that throttles it). */
export const GITHUB_WEBHOOK_ROUTE = "POST /v1/github/webhooks";

/**
 * The GitHub App's webhook secret has its OWN slot, so rotating it never touches the App's private-key secret. The stack creates the slot EMPTY (no value is ever in a template, a
 * parameter or a log: CloudFormation documents that omitting both SecretString and GenerateSecretString creates an empty secret, so no later release can overwrite what the owner puts
 * there) and the owner stores the value with put-secret-value. Retained, like the callback key's secret: `agentx destroy` removes a retained secret under agentx/<env>/ that carries the
 * environment's tag. Read by the broker's role ALONE among the workloads, through the secret's own resource policy (the broker's role policy has no room left,
 * tests/contract/developer-signin-infrastructure.test.ts): no identity statement anywhere names it, and the plan-evidence job (which holds the App's private key secret) has none.
 * Operators keep their agentx/<env>/* scope, and the deploying role manages it; those are people and tooling, not workloads. The broker is told the NAME (derived, nothing in its 4 KB
 * variables), reads the value at runtime, and uses the App secret's old webhookSecret key only while this slot has no value (aws/github-credentials.ts).
 * Wired by derivation: synthesis stops unless the broker would derive exactly the name the secret was created with (the check that the receiver reads THIS secret).
 */
export function addGithubWebhookSecret(scope: Construct, props: { naming: AgentXNaming; broker: lambda.Function }): void {
  const name = githubWebhookSecretName(props.naming.env ?? "production");
  const secret = new secretsmanager.CfnSecret(scope, "GithubWebhookSecret", {
    name,
    description: "GitHub App webhook secret (set by the owner with put-secret-value; empty until then). Only the broker reads it.",
  });
  secret.applyRemovalPolicy(RemovalPolicy.RETAIN);
  new secretsmanager.CfnResourcePolicy(scope, "GithubWebhookSecretPolicy", {
    secretId: secret.ref,
    resourcePolicy: new iam.PolicyDocument({ statements: [new iam.PolicyStatement({
      sid: "ReadGithubWebhookSecret",
      principals: [new iam.ArnPrincipal(props.broker.role!.roleArn)],
      actions: ["secretsmanager:GetSecretValue"],
      // In a secret's own policy, "*" is this secret.
      resources: ["*"],
    })] }),
  });
  addDerivedBrokerVariable(props.broker, props.naming, GITHUB_WEBHOOK_SECRET_VARIABLE, name);
}

/**
 * The public GitHub webhook route is throttled at the stage: 20 requests a second, bursts of 100, ACROSS ALL CALLERS (a throttled request is a 429 and never reaches the broker; GitHub
 * does not retry it, and the slow backup poll covers a dropped delivery). It is a flood guard, not a per-tenant limit: per-installation fairness is the receiver's own limiter after a
 * valid signature (webhook lane W0). Detailed metrics are on for this one route so the alarm can see a sustained flood (otherwise a junk flood would silently downgrade every tenant to
 * the backup poll). The map is merged with the sign-in routes' (route-settings.ts), never replaced.
 * The alarm: the stage's 429s, a flood of bad signatures (403) or oversize bodies (413) all count as 4xx. A real GitHub delivery is a 2xx, so a steady 4xx rate here is junk, a throttle
 * that is dropping real deliveries, or a secret that GitHub and AWS do not agree on after the owner's set-up. 300 in 5 minutes is about one a second, far below the 20 a second
 * throttle and far above anything a correct set-up produces.
 */
export function guardGithubWebhookRoute(scope: Construct, naming: AgentXNaming, apiId: string, stage: apigwv2.CfnStage, route: apigwv2.CfnRoute, notifyOperator: cloudwatchActions.SnsAction): void {
  const webhookThrottle: RouteSetting = { ThrottlingBurstLimit: 100, ThrottlingRateLimit: 20, DetailedMetricsEnabled: true };
  addRouteSettings(stage, [route], Object.fromEntries([[GITHUB_WEBHOOK_ROUTE, webhookThrottle]]));
  new cloudwatch.Alarm(scope, "GithubWebhookRejectedAlarm", {
    alarmName: naming.alarmName("GithubWebhookRejected"),
    alarmDescription: "The GitHub webhook route is rejecting a steady stream of requests (429 throttle, 403 bad signature or 413). Pull request tracking falls back to the slow backup poll while deliveries are dropped. Check the broker log for github_webhook lines; a bad signature after set-up means GitHub and the webhook secret slot hold different values.",
    metric: new cloudwatch.Metric({
      namespace: "AWS/ApiGateway", metricName: "4xx", statistic: "Sum", period: Duration.minutes(5),
      dimensionsMap: { ApiId: apiId, Stage: "$default", Route: GITHUB_WEBHOOK_ROUTE },
    }),
    threshold: 300,
    evaluationPeriods: 1,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  }).addAlarmAction(notifyOperator);
}
