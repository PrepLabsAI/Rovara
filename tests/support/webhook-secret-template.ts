import { expect } from "vitest";

type Resource = { Type: string; Properties: Record<string, unknown>; DependsOn?: string | string[]; DeletionPolicy?: string; UpdateReplacePolicy?: string };

const ROUTE_KEY = "POST /v1/github/webhooks";

/**
 * Webhook lane W3 (public GitHub webhook tracking): the control-plane stack gains, and ONLY gains:
 *  - the dedicated webhook secret (an EMPTY, retained Secrets Manager secret named agentx/<env>/github-webhook-secret) and its resource policy (the broker's role, GetSecretValue);
 *  - the webhook route's stage throttle (one RouteSettings entry, the stage waiting for that route);
 *  - one alarm on the route's rejected requests.
 * Each is pinned exactly here and then removed, so the older pins and snapshots keep proving that nothing else in the template moved. Never removes a policy statement.
 */
export function withoutWebhookSecretLane<T>(input: T): T {
  const copy = structuredClone(input);
  const resources = (copy as { Resources: Record<string, Resource> }).Resources;
  const idsOf = (type: string, matches: (resource: Resource) => boolean) => Object.keys(resources).filter((id) => resources[id]!.Type === type && matches(resources[id]!));

  const secrets = idsOf("AWS::SecretsManager::Secret", (resource) => /^agentx\/[a-z0-9-]+\/github-webhook-secret$/u.test(String(resource.Properties.Name)));
  expect(secrets).toHaveLength(1);
  const secret = resources[secrets[0]!]!;
  // A named environment's stack tags (agentx:env, which `agentx destroy` needs to find a retained secret) arrive as Tags; nothing else is in the properties: no value, no generator.
  expect(Object.keys(secret.Properties).filter((key) => key !== "Tags").sort()).toEqual(["Description", "Name"]);
  if (secret.Properties.Tags !== undefined) expect(JSON.stringify(secret.Properties.Tags)).toContain("agentx:env");
  // Retained: in the whole app the policy reads RetainExceptOnCreate (CDK's stack-wide retain flag), standalone it reads Retain; both keep the secret on a stack delete or replacement.
  expect(String(secret.DeletionPolicy)).toMatch(/^Retain/u);
  expect(String(secret.UpdateReplacePolicy)).toMatch(/^Retain/u);

  const policies = idsOf("AWS::SecretsManager::ResourcePolicy", (resource) => JSON.stringify(resource.Properties.SecretId) === JSON.stringify({ Ref: secrets[0]! }));
  expect(policies).toHaveLength(1);
  const document = resources[policies[0]!]!.Properties.ResourcePolicy as { Statement: Array<Record<string, unknown>> };
  expect(document.Statement).toHaveLength(1);
  expect(document.Statement[0]).toMatchObject({ Sid: "ReadGithubWebhookSecret", Effect: "Allow", Action: "secretsmanager:GetSecretValue", Resource: "*" });
  const roles = idsOf("AWS::IAM::Role", () => true).filter((id) => /^BrokerServiceRole[0-9A-F]{8}$/u.test(id));
  expect(roles).toHaveLength(1);
  expect(document.Statement[0]!.Principal).toEqual({ AWS: { "Fn::GetAtt": [roles[0]!, "Arn"] } });

  const alarms = idsOf("AWS::CloudWatch::Alarm", (resource) => JSON.stringify(resource.Properties.Dimensions ?? "").includes(ROUTE_KEY));
  expect(alarms).toHaveLength(1);

  const routes = idsOf("AWS::ApiGatewayV2::Route", (resource) => resource.Properties.RouteKey === ROUTE_KEY);
  expect(routes).toHaveLength(1);
  const stages = idsOf("AWS::ApiGatewayV2::Stage", () => true);
  expect(stages).toHaveLength(1);
  const stage = resources[stages[0]!]!;
  const settings = stage.Properties.RouteSettings as Record<string, unknown>;
  expect(settings[ROUTE_KEY]).toEqual({ ThrottlingBurstLimit: 100, ThrottlingRateLimit: 20, DetailedMetricsEnabled: true });
  delete settings[ROUTE_KEY];
  const dependsOn = [stage.DependsOn].flat().filter((id): id is string => id !== undefined);
  expect(dependsOn).toContain(routes[0]!);
  const remaining = dependsOn.filter((id) => id !== routes[0]!);
  if (remaining.length === 0) delete stage.DependsOn;
  else stage.DependsOn = Array.isArray(stage.DependsOn) ? remaining : remaining[0]!;

  delete resources[alarms[0]!];
  delete resources[policies[0]!];
  delete resources[secrets[0]!];
  return copy;
}
