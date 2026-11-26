// Webhook lane W3 (public GitHub webhook tracking): the dedicated webhook secret slot and the webhook route's throttle, in the named and the legacy control-plane templates.
//  - the slot is created EMPTY by the stack (no value in the template), retained, and readable by the broker's role alone among the workloads, through the secret's own resource policy;
//    no identity policy anywhere names it or reaches it by a wildcard;
//  - the broker is wired to it by derivation: it derives exactly the name the secret was created with;
//  - the webhook route is throttled (20 a second, burst 100, detailed metrics on) in the SAME stage map as the four sign-in routes: nothing overwrites anything;
//  - one alarm watches the route's rejected traffic.
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { DERIVED_BROKER_VARIABLES, GITHUB_WEBHOOK_SECRET_VARIABLE, githubWebhookSecretName } from "@agentx/contracts";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { GITHUB_WEBHOOK_ROUTE } from "../../infra/lib/github-webhook.js";
import { LINEAR_WEBHOOK_ROUTE } from "../../infra/lib/linear-webhook.js";
import { environmentNaming } from "../../infra/lib/naming.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";
import { unpackedBrokerVariables, type ResourcesTemplate } from "../support/broker-environment-template.js";

skipLambdaBundling();

type Json = Record<string, unknown>;
interface Resource { Type: string; Properties: Json; DeletionPolicy?: string; UpdateReplacePolicy?: string; DependsOn?: string[] }
interface Template_ extends ResourcesTemplate { Resources: Record<string, Resource> }
interface Statement { Sid?: string; Effect: string; Action: string | string[]; Resource?: unknown; Principal?: unknown; Condition?: unknown }

const named = Template.fromStack(new ControlPlaneStack(new App(), "WebhookSecretNamed", { naming: environmentNaming("staging") })).toJSON() as Template_;
const legacy = Template.fromStack(new ControlPlaneStack(new App(), "WebhookSecretLegacy")).toJSON() as Template_;

const entries = (template: Template_, type: string) => Object.entries(template.Resources).filter(([, resource]) => resource.Type === type);
const functionNamed = (template: Template_, prefix: string): [string, Resource] => entries(template, "AWS::Lambda::Function").find(([id]) => new RegExp(`^${prefix}[0-9A-F]{8}$`, "u").test(id))!;
const roleIdOf = (fn: Resource) => (fn.Properties.Role as { "Fn::GetAtt": string[] })["Fn::GetAtt"][0]!;
const statementsOf = (document: unknown): Statement[] => (document as { Statement: Statement[] }).Statement;

/** Every identity statement in the template (role inline policies, standalone policies, managed policies), with the logical id it came from. */
function identityStatements(template: Template_): Array<{ owner: string; statement: Statement }> {
  const found: Array<{ owner: string; statement: Statement }> = [];
  for (const [id, resource] of Object.entries(template.Resources)) {
    if (resource.Type === "AWS::IAM::Policy" || resource.Type === "AWS::IAM::ManagedPolicy") for (const statement of statementsOf(resource.Properties.PolicyDocument)) found.push({ owner: id, statement });
    if (resource.Type === "AWS::IAM::Role") for (const policy of (resource.Properties.Policies as Array<{ PolicyDocument: unknown }> | undefined) ?? []) for (const statement of statementsOf(policy.PolicyDocument)) found.push({ owner: id, statement });
  }
  return found;
}

/** A resource as text: pseudo parameters get fixed values, every other reference becomes a marker that no secret name pattern can match. */
function renderedResource(resource: unknown, secretId: string): string[] {
  const render = (part: unknown): string => {
    if (typeof part === "string") return part;
    const value = part as { Ref?: string; "Fn::Join"?: [string, unknown[]]; "Fn::GetAtt"?: string[]; "Fn::Sub"?: string };
    if (value.Ref === secretId || value["Fn::GetAtt"]?.[0] === secretId) return "<THIS-SECRET>";
    if (value.Ref === "AWS::Partition") return "aws";
    if (value.Ref === "AWS::Region") return "us-west-2";
    if (value.Ref === "AWS::AccountId") return "123456789012";
    if (value["Fn::Join"] !== undefined) return value["Fn::Join"][1].map(render).join(value["Fn::Join"][0]);
    return "<OTHER>";
  };
  return [resource].flat().map(render);
}

/** Opus review: any action PATTERN (IAM wildcards * and ?, case-insensitive) that covers a value read, e.g. "secretsmanager:GetSecret*" or "*:*", not only a fixed list. */
const VALUE_READS = ["secretsmanager:GetSecretValue", "secretsmanager:BatchGetSecretValue"];
const REACHES_SECRETS = (action: string) => {
  const regex = new RegExp(`^${action.replace(/[.+^${}()|[\]\\]/gu, "\\$&").replace(/\*/gu, ".*").replace(/\?/gu, ".")}$`, "iu");
  return VALUE_READS.some((read) => regex.test(read));
};
/** Whether an ARN pattern (with * and ?) covers the secret, whose ARN is the name plus Secrets Manager's hyphen and six characters. */
function patternCovers(pattern: string, name: string): boolean {
  if (pattern === "<THIS-SECRET>" || pattern === "*") return true;
  const arn = `arn:aws:secretsmanager:us-west-2:123456789012:secret:${name}-AbCdEf`;
  const regex = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/gu, "\\$&").replace(/\*/gu, ".*").replace(/\?/gu, ".")}$`, "u");
  return regex.test(arn);
}

describe.each([["named (staging)", named, "staging"], ["legacy (production)", legacy, "production"]] as const)("the dedicated GitHub webhook secret, %s", (_label, template, env) => {
  const name = `agentx/${env}/github-webhook-secret`;
  const found = entries(template, "AWS::SecretsManager::Secret").filter(([, resource]) => resource.Properties.Name === name);
  const [secretId, secret] = found[0] ?? ["", undefined as unknown as Resource];

  it("is one secret under the environment's own name, from the shared name function", () => {
    expect(githubWebhookSecretName(env)).toBe(name);
    expect(found).toHaveLength(1);
  });

  it("is created EMPTY: the template holds no value, no generator and no parameter reference for it, and it is retained", () => {
    expect(secret.Properties).not.toHaveProperty("SecretString");
    expect(secret.Properties).not.toHaveProperty("GenerateSecretString");
    expect(secret.Properties).not.toHaveProperty("SecretBinary");
    expect(JSON.stringify(secret.Properties)).not.toMatch(/Ref|resolve:|Fn::/u);
    expect(secret.DeletionPolicy).toBe("Retain");
    expect(secret.UpdateReplacePolicy).toBe("Retain");
  });

  it("is readable by the broker's role alone: one resource-policy statement, GetSecretValue only, no condition, and no other policy on the secret", () => {
    const policies = entries(template, "AWS::SecretsManager::ResourcePolicy").filter(([, resource]) => JSON.stringify(resource.Properties.SecretId) === JSON.stringify({ Ref: secretId }));
    expect(policies).toHaveLength(1);
    const statements = statementsOf(policies[0]![1].Properties.ResourcePolicy);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatchObject({ Sid: "ReadGithubWebhookSecret", Effect: "Allow", Action: "secretsmanager:GetSecretValue", Resource: "*" });
    expect(statements[0]).not.toHaveProperty("Condition");
    const [, broker] = functionNamed(template, "Broker");
    expect(statements[0]!.Principal).toEqual({ AWS: { "Fn::GetAtt": [roleIdOf(broker), "Arn"] } });
  });

  it("is reached by NO identity policy: no statement names it, and none covers it by a wildcard, a service wildcard or an all-resources grant", () => {
    // Opus review: a NotAction or NotResource Allow is treated as reaching (it grants everything it does not name).
    const reaching = identityStatements(template).filter(({ statement }) => statement.Effect === "Allow" && ("NotAction" in statement || "NotResource" in statement || [statement.Action].flat().some(REACHES_SECRETS))
      && renderedResource(statement.Resource, secretId).some((resource) => patternCovers(resource, name)));
    expect(reaching.map(({ owner, statement }) => `${owner} ${statement.Sid ?? ""}`)).toEqual([]);
    // D1: the plan-evidence job (a function that read the App's secret) is gone from every layout.
    expect(entries(template, "AWS::Lambda::Function").some(([id]) => /^PlanEvidence[0-9A-F]{8}$/u.test(id))).toBe(false);
  });

  it("is wired to the broker by derivation: the broker derives exactly this name, and no function's variables carry it as a value", () => {
    const derived = DERIVED_BROKER_VARIABLES.find((entry) => entry.variable === GITHUB_WEBHOOK_SECRET_VARIABLE);
    expect(derived).toMatchObject({ kind: "text", legacy: true });
    expect(derived!.kind === "text" && derived!.value(env)).toBe(name);
    const [, broker] = functionNamed(template, "Broker");
    const variables = unpackedBrokerVariables((broker.Properties.Environment as { Variables: Record<string, unknown> }).Variables, template);
    expect(variables[GITHUB_WEBHOOK_SECRET_VARIABLE]).toBe(name);
    for (const [id, fn] of entries(template, "AWS::Lambda::Function")) {
      const own = (fn.Properties.Environment as { Variables?: Record<string, unknown> } | undefined)?.Variables ?? {};
      if (!/^Broker[0-9A-F]{8}$/u.test(id)) expect(JSON.stringify(own), id).not.toContain("github-webhook-secret");
    }
  });

  it("throttles the webhook route at the stage, merged with the sign-in routes: nothing overwrites anything", () => {
    const stage = entries(template, "AWS::ApiGatewayV2::Stage")[0]![1];
    const settings = stage.Properties.RouteSettings as Record<string, Json>;
    expect(Object.keys(settings).sort()).toEqual(["ANY /review/{proxy+}", "ANY /v1/app/{proxy+}", "ANY /v1/auth/{proxy+}", "ANY /v1/dev/{proxy+}", GITHUB_WEBHOOK_ROUTE, LINEAR_WEBHOOK_ROUTE].sort());
    expect(settings[GITHUB_WEBHOOK_ROUTE]).toEqual({ ThrottlingBurstLimit: 100, ThrottlingRateLimit: 20, DetailedMetricsEnabled: true });
    // The Linear webhook route shares the map with its own, equal setting (linear-webhook-route.test.ts).
    expect(settings[LINEAR_WEBHOOK_ROUTE]).toEqual({ ThrottlingBurstLimit: 100, ThrottlingRateLimit: 20, DetailedMetricsEnabled: true });
    for (const key of Object.keys(settings).filter((candidate) => candidate !== GITHUB_WEBHOOK_ROUTE && candidate !== LINEAR_WEBHOOK_ROUTE)) expect(settings[key], key).toEqual({ ThrottlingBurstLimit: 50, ThrottlingRateLimit: 20 });
    // A route setting names a route that must exist first.
    const routeId = entries(template, "AWS::ApiGatewayV2::Route").find(([, route]) => route.Properties.RouteKey === GITHUB_WEBHOOK_ROUTE)![0];
    expect([stage.DependsOn].flat()).toContain(routeId);
    // The route itself is unauthenticated (GitHub cannot sign with IAM); the broker verifies the signature.
    expect(entries(template, "AWS::ApiGatewayV2::Route").find(([, route]) => route.Properties.RouteKey === GITHUB_WEBHOOK_ROUTE)![1].Properties.AuthorizationType).toBe("NONE");
  });

  it("alarms the operator on a steady stream of rejected requests on that route", () => {
    const alarms = entries(template, "AWS::CloudWatch::Alarm").filter(([, alarm]) => JSON.stringify(alarm.Properties.Dimensions ?? "").includes(GITHUB_WEBHOOK_ROUTE));
    expect(alarms).toHaveLength(1);
    expect(alarms[0]![1].Properties).toMatchObject({
      Namespace: "AWS/ApiGateway", MetricName: "4xx", Statistic: "Sum", Period: 300, EvaluationPeriods: 1, Threshold: 300,
      ComparisonOperator: "GreaterThanOrEqualToThreshold", TreatMissingData: "notBreaching",
    });
    expect((alarms[0]![1].Properties.Dimensions as Array<{ Name: string; Value: unknown }>).find((dimension) => dimension.Name === "Stage")!.Value).toBe("$default");
    expect(alarms[0]![1].Properties.AlarmActions).toHaveLength(1);
  });
});
