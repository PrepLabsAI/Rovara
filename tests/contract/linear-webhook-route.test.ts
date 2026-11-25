// DEC 254zzz488: the Linear app's webhook route (POST /v1/linear/webhooks) on BOTH layouts, the named environments and the legacy install (beta, production).
//  - the route exists once, under the same logical ID and key, with the broker's own integration and NO gateway authorizer (Linear cannot present a JWT; the broker verifies the
//    HMAC, the timestamp window, the replay record and the workspace's binding: tests/contract/linear-app-intake.test.ts and tests/unit/linear-oauth.test.ts);
//  - nothing else in the path is named-only: the app's settings secret (<connector prefix>linear-oauth-app) is read by the broker's connector-secret grant, whose prefix is the one the
//    broker computes on that layout; the token key and the State table (the workspace binding, the replay record) are the broker's on both;
//  - the secret read is by the connector prefix grant and by NO broader statement (no all-secrets grant, no wildcard that crosses the prefix, no other role).
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { CONNECTOR_SECRET_PREFIX, environmentConnectorSecretPrefix, HEALTH_ALARM_SUFFIXES } from "@agentx/contracts";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { GITHUB_WEBHOOK_ROUTE } from "../../infra/lib/github-webhook.js";
import { LINEAR_WEBHOOK_ROUTE } from "../../infra/lib/linear-webhook.js";
import { environmentNaming, legacyNaming } from "../../infra/lib/naming.js";
import { LINEAR_APP_SECRET_LEAF, linearAppSecretName } from "../../packages/broker/src/aws/linear-connections.js";
import { LINEAR_WEBHOOK_PATH } from "../../packages/broker/src/aws/linear-app-webhook.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";
import { unpackedBrokerVariables, type ResourcesTemplate } from "../support/broker-environment-template.js";

skipLambdaBundling();

type Json = Record<string, unknown>;
interface Resource { Type: string; Properties: Json; DependsOn?: string[] }
interface Template_ extends ResourcesTemplate { Resources: Record<string, Resource> }
interface Statement { Sid?: string; Effect: string; Action?: string | string[]; NotAction?: unknown; Resource?: unknown; NotResource?: unknown }

const named = Template.fromStack(new ControlPlaneStack(new App(), "LinearWebhookNamed", { naming: environmentNaming("staging") })).toJSON() as Template_;
const legacy = Template.fromStack(new ControlPlaneStack(new App(), "LinearWebhookLegacy")).toJSON() as Template_;

const entries = (template: Template_, type: string) => Object.entries(template.Resources).filter(([, resource]) => resource.Type === type);
const brokerOf = (template: Template_): [string, Resource] => entries(template, "AWS::Lambda::Function").find(([id]) => /^Broker[0-9A-F]{8}$/u.test(id))!;
const roleIdOf = (fn: Resource) => (fn.Properties.Role as { "Fn::GetAtt": string[] })["Fn::GetAtt"][0]!;
const statementsOf = (document: unknown): Statement[] => (document as { Statement: Statement[] }).Statement;

/** Every identity statement in the template, with the role(s) its policy is attached to ("" for a managed policy). */
function identityStatements(template: Template_): Array<{ owner: string; roles: string; statement: Statement }> {
  const found: Array<{ owner: string; roles: string; statement: Statement }> = [];
  for (const [id, resource] of Object.entries(template.Resources)) {
    if (resource.Type === "AWS::IAM::Policy" || resource.Type === "AWS::IAM::ManagedPolicy") {
      for (const statement of statementsOf(resource.Properties.PolicyDocument)) found.push({ owner: id, roles: JSON.stringify(resource.Properties.Roles ?? ""), statement });
    }
    if (resource.Type === "AWS::IAM::Role") {
      for (const policy of (resource.Properties.Policies as Array<{ PolicyDocument: unknown }> | undefined) ?? []) {
        for (const statement of statementsOf(policy.PolicyDocument)) found.push({ owner: id, roles: JSON.stringify([{ Ref: id }]), statement });
      }
    }
  }
  return found;
}

/** A resource as text: pseudo parameters get fixed values, every other reference becomes a marker no secret name pattern can match. */
function rendered(resource: unknown): string[] {
  const render = (part: unknown): string => {
    if (typeof part === "string") return part;
    const value = part as { Ref?: string; "Fn::Join"?: [string, unknown[]] };
    if (value.Ref === "AWS::Partition") return "aws";
    if (value.Ref === "AWS::Region") return "us-west-2";
    if (value.Ref === "AWS::AccountId") return "123456789012";
    if (value["Fn::Join"] !== undefined) return value["Fn::Join"][1].map(render).join(value["Fn::Join"][0]);
    return "<OTHER>";
  };
  return [resource].flat().map(render);
}

const wildcard = (pattern: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/gu, "\\$&").replace(/\*/gu, ".*").replace(/\?/gu, ".")}$`, "iu");
/** Whether any action PATTERN of the statement covers the action (IAM wildcards, case-insensitive). */
const coversAction = (statement: Statement, action: string) => [statement.Action ?? []].flat().some((pattern) => wildcard(pattern).test(action));
/** The statements that allow reading a secret's value whose resource covers `arn` (a NotAction or NotResource Allow counts as reaching: it grants all it does not name). */
function secretReaders(template: Template_, arn: string) {
  return identityStatements(template).filter(({ statement }) => statement.Effect === "Allow"
    && ("NotAction" in statement || coversAction(statement, "secretsmanager:GetSecretValue"))
    && ("NotResource" in statement || rendered(statement.Resource).some((pattern) => wildcard(pattern).test(arn))));
}

describe.each([
  ["named (staging)", named, environmentNaming("staging"), environmentConnectorSecretPrefix("staging")],
  ["legacy (beta, production)", legacy, legacyNaming(), CONNECTOR_SECRET_PREFIX],
] as const)("the Linear webhook path, %s", (_label, template, naming, prefix) => {
  const [brokerId, broker] = brokerOf(template);
  const brokerRole = roleIdOf(broker);
  const variables = unpackedBrokerVariables((broker.Properties.Environment as { Variables: Record<string, unknown> }).Variables, template);
  const secretArn = `arn:aws:secretsmanager:us-west-2:123456789012:secret:${prefix}${LINEAR_APP_SECRET_LEAF}-AbCdEf`;
  const readersOf = (arn: string) => secretReaders(template, arn).filter(({ roles }) => roles.includes(`"${brokerRole}"`) || roles === "\"\"");

  it("has exactly one POST /v1/linear/webhooks route, unauthenticated at the gateway, on the broker's own integration", () => {
    const routes = entries(template, "AWS::ApiGatewayV2::Route");
    const linear = routes.filter(([, route]) => route.Properties.RouteKey === `POST ${LINEAR_WEBHOOK_PATH}`);
    expect(linear.map(([id]) => id)).toEqual(["LinearWebhookRoute"]);
    const proxy = routes.find(([id]) => id === "ProxyRoute")![1];
    expect(linear[0]![1].Properties).toStrictEqual({
      ApiId: proxy.Properties.ApiId,
      RouteKey: "POST /v1/linear/webhooks",
      Target: proxy.Properties.Target,
      AuthorizationType: "NONE",
    });
    // The same integration as every other broker route, and that integration is the broker function.
    const integrationId = ((proxy.Properties.Target as { "Fn::Join": [string, unknown[]] })["Fn::Join"][1].find((part) => typeof part !== "string") as { Ref: string }).Ref;
    expect(template.Resources[integrationId]!.Properties.IntegrationUri).toEqual({ "Fn::GetAtt": [brokerId, "Arn"] });
    // The catch-all stays JWT-authorized: the webhook route is the only one added.
    expect(proxy.Properties.AuthorizationType).toBe("JWT");
    expect(routes.filter(([, route]) => route.Properties.AuthorizationType === "NONE").map(([, route]) => route.Properties.RouteKey)).toContain("POST /v1/linear/webhooks");
  });

  it("reads the app's settings (the signing secret) from <connector prefix>linear-oauth-app, the prefix this layout's broker computes", () => {
    expect(naming.connectorSecretPrefix).toBe(prefix);
    // The broker's own default (broker.ts: process.env.CONNECTOR_SECRET_PREFIX ?? CONNECTOR_SECRET_PREFIX): a named broker derives its prefix, the legacy one passes none and uses the constant.
    expect(variables.CONNECTOR_SECRET_PREFIX ?? CONNECTOR_SECRET_PREFIX).toBe(prefix);
    expect(linearAppSecretName((variables.CONNECTOR_SECRET_PREFIX as string | undefined) ?? CONNECTOR_SECRET_PREFIX)).toBe(`${prefix}linear-oauth-app`);
  });

  it("lets the broker's role read that secret through the connector-prefix grant and nothing broader, and no other role", () => {
    const readers = readersOf(secretArn);
    expect(readers.length).toBeGreaterThan(0);
    // Every statement that reaches the secret names the connector prefix (<prefix>*) as its only resource that covers it: no "*", no "secret:*", no wildcard across the prefix.
    for (const { owner, statement } of readers) {
      const covering = rendered(statement.Resource).filter((pattern) => wildcard(pattern).test(secretArn));
      expect(covering, owner).toEqual([`arn:aws:secretsmanager:us-west-2:123456789012:secret:${prefix}*`]);
      expect(statement.Action, owner).toBe("secretsmanager:GetSecretValue");
      expect(statement).not.toHaveProperty("NotResource");
      expect(statement).not.toHaveProperty("NotAction");
    }
    // No role but the broker's reads it (the control plane's other functions, the plan-evidence job and the dispatcher among them).
    const outside = secretReaders(template, secretArn).filter(({ roles }) => !roles.includes(`"${brokerRole}"`) && roles !== "\"\"");
    expect(outside.map(({ owner, statement }) => `${owner} ${statement.Sid ?? ""}`)).toEqual([]);
    // A secret under the prefix of another layout is not reached.
    const other = prefix === CONNECTOR_SECRET_PREFIX ? environmentConnectorSecretPrefix("staging") : CONNECTOR_SECRET_PREFIX;
    expect(secretReaders(template, `arn:aws:secretsmanager:us-west-2:123456789012:secret:${other}${LINEAR_APP_SECRET_LEAF}-AbCdEf`).map(({ owner }) => owner)).toEqual([]);
  });

  it("gives the broker the token key and the State table the workspace binding and the replay record live in", () => {
    // The key the Linear tokens are sealed under (the webhook's revoke and routing read the connection through it); present on both layouts.
    expect(variables.CHATGPT_CONNECTION_KEY_ARN).toBeDefined();
    const key = entries(template, "AWS::KMS::Key").find(([, resource]) => /ChatGPT/iu.test(String(resource.Properties.Description)))!;
    expect(JSON.stringify(variables.CHATGPT_CONNECTION_KEY_ARN)).toContain(key[0]);
    const brokerStatements = identityStatements(template).filter(({ roles }) => roles.includes(`"${brokerRole}"`));
    const keyArn = { "Fn::GetAtt": [key[0], "Arn"] };
    const keyActions = brokerStatements.filter(({ statement }) => statement.Effect === "Allow" && JSON.stringify(statement.Resource) === JSON.stringify(keyArn)).flatMap(({ statement }) => [statement.Action ?? []].flat());
    const keyPolicy = JSON.stringify(key[1].Properties.KeyPolicy);
    // Legacy: the grant is on the broker's role; named: it is in the key's own policy (with the broker-only Deny).
    if (naming.env === undefined) expect(keyActions).toEqual(expect.arrayContaining(["kms:Decrypt", "kms:Encrypt"]));
    else expect(keyPolicy).toContain("kms:Decrypt");
    const table = entries(template, "AWS::DynamoDB::Table").find(([id]) => id.startsWith("State"))![0];
    const tableActions = brokerStatements.filter(({ statement }) => statement.Effect === "Allow" && JSON.stringify(statement.Resource).includes(table)).flatMap(({ statement }) => [statement.Action ?? []].flat());
    expect(tableActions).toEqual(expect.arrayContaining(["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query"]));
    expect(variables.STATE_TABLE_NAME).toBeDefined();
  });

  // Linear webhook guard: the same flood guard as the GitHub route's (infra/lib/linear-webhook.ts; github-webhook-secret-infrastructure.test.ts).
  it("throttles the route at the stage (20 a second, burst 100, detailed metrics), merged with the other routes' settings: nothing is overwritten", () => {
    const stage = entries(template, "AWS::ApiGatewayV2::Stage")[0]![1];
    const settings = stage.Properties.RouteSettings as Record<string, Json>;
    expect(Object.keys(settings).sort()).toEqual(["ANY /review/{proxy+}", "ANY /v1/app/{proxy+}", "ANY /v1/auth/{proxy+}", "ANY /v1/dev/{proxy+}", GITHUB_WEBHOOK_ROUTE, LINEAR_WEBHOOK_ROUTE].sort());
    expect(settings[LINEAR_WEBHOOK_ROUTE]).toEqual({ ThrottlingBurstLimit: 100, ThrottlingRateLimit: 20, DetailedMetricsEnabled: true });
    // The GitHub route's throttle and the sign-in routes' are as they were.
    expect(settings[GITHUB_WEBHOOK_ROUTE]).toEqual({ ThrottlingBurstLimit: 100, ThrottlingRateLimit: 20, DetailedMetricsEnabled: true });
    for (const key of Object.keys(settings).filter((candidate) => candidate !== GITHUB_WEBHOOK_ROUTE && candidate !== LINEAR_WEBHOOK_ROUTE)) expect(settings[key], key).toEqual({ ThrottlingBurstLimit: 50, ThrottlingRateLimit: 20 });
    // A route setting names a route that must exist first, and the route is still unauthenticated at the gateway.
    expect([stage.DependsOn].flat()).toContain("LinearWebhookRoute");
    expect(template.Resources.LinearWebhookRoute!.Properties.RouteKey).toBe(LINEAR_WEBHOOK_ROUTE);
    expect(template.Resources.LinearWebhookRoute!.Properties.AuthorizationType).toBe("NONE");
  });

  it("alarms the operator, under a name the health probe reads, on a steady stream of rejected requests on that route", () => {
    const alarms = entries(template, "AWS::CloudWatch::Alarm").filter(([, alarm]) => JSON.stringify(alarm.Properties.Dimensions ?? "").includes(LINEAR_WEBHOOK_ROUTE));
    expect(alarms).toHaveLength(1);
    expect(alarms[0]![0]).toMatch(/^LinearWebhookRejectedAlarm/u);
    expect(alarms[0]![1].Properties).toMatchObject({
      AlarmName: naming.alarmName("LinearWebhookRejected"),
      Namespace: "AWS/ApiGateway", MetricName: "4xx", Statistic: "Sum", Period: 300, EvaluationPeriods: 1, Threshold: 300,
      ComparisonOperator: "GreaterThanOrEqualToThreshold", TreatMissingData: "notBreaching",
    });
    const dimensions = alarms[0]![1].Properties.Dimensions as Array<{ Name: string; Value: unknown }>;
    expect(dimensions.find((dimension) => dimension.Name === "Stage")!.Value).toBe("$default");
    expect(dimensions.find((dimension) => dimension.Name === "Route")!.Value).toBe(LINEAR_WEBHOOK_ROUTE);
    // The same operator topic as the GitHub route's alarm.
    const github = entries(template, "AWS::CloudWatch::Alarm").filter(([, alarm]) => JSON.stringify(alarm.Properties.Dimensions ?? "").includes(GITHUB_WEBHOOK_ROUTE));
    expect(github).toHaveLength(1);
    expect(alarms[0]![1].Properties.AlarmActions).toHaveLength(1);
    expect(alarms[0]![1].Properties.AlarmActions).toEqual(github[0]![1].Properties.AlarmActions);
    expect(HEALTH_ALARM_SUFFIXES).toContain("LinearWebhookRejected");
  });
});

describe("the Linear webhook route's layout parity", () => {
  it("has the same logical ID, key and properties on both layouts apart from the API it belongs to", () => {
    const of = (template: Template_) => template.Resources.LinearWebhookRoute!;
    expect(of(legacy).Type).toBe(of(named).Type);
    expect(Object.keys(of(legacy).Properties).sort()).toEqual(Object.keys(of(named).Properties).sort());
    expect(of(legacy).Properties.RouteKey).toBe(of(named).Properties.RouteKey);
    expect(of(legacy).Properties.AuthorizationType).toBe(of(named).Properties.AuthorizationType);
  });
});
