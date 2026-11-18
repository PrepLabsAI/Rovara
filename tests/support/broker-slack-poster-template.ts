// L4-HW8b (owner DEC 254zzz42 (a)): the broker posts to Slack through the built-in adapter like the other Slack posters (`channelAdapters.connectSlackPoster(broker, ...)`, infra/lib/control-plane.ts), and may read
// the Slack adapter secret through the SECRET's own resource policy (`ReadSlackAdapterSecretBroker`). Each digest or snapshot test that pins the rest of the control-plane template asserts these additions
// exactly, then takes them out (in place), so the pins they hold stay the ones recorded before this change: removing exactly these additions gives back the old template. The same additions are asserted in
// full, with the widening mutants, in tests/contract/broker-slack-poster-infrastructure.test.ts. A template with none of them (the legacy deployment, production, which gets none of it) is returned as it is.
import { expect } from "vitest";

type Resource = { Type: string; Properties: Record<string, unknown>; DependsOn?: string[] };
type Template = { Resources: Record<string, Resource> };

const BROKER_FUNCTION = /^Broker[0-9A-F]{8}$/u;
const BROKER_ROLE = /^BrokerServiceRole[0-9A-F]{8}$/u;

/** The seven variables `connectSlackPoster` gives a function, as the template holds them (the API's endpoint and the two parameters are references). */
export function slackPosterVariables(apiId: string, env: string): Record<string, unknown> {
  const endpoint = { "Fn::GetAtt": [apiId, "ApiEndpoint"] };
  return {
    SLACK_VIA_CHANNEL: { Ref: "SlackViaChannel" },
    SLACK_ADAPTER_TEAM_ID: { Ref: "SlackTeamId" },
    BUILT_IN_ADAPTER: { Ref: "SlackViaChannel" },
    BUILT_IN_ADAPTER_CHANNEL: "slack",
    BUILT_IN_ADAPTER_CALLBACK_URL: { "Fn::Join": ["", [endpoint, "/v1/slack/channel-events"]] },
    BUILT_IN_ADAPTER_COMMANDS_URL: { "Fn::Join": ["", [endpoint, "/v1/slack/channel-commands"]] },
    BUILT_IN_ADAPTER_SECRET_NAME: `agentx/${env}/channel-adapter/slack`,
  };
}

/** The one statement the Slack adapter secret's own policy gives the broker. */
export function brokerSlackSecretPolicyDocument(brokerRoleId: string): unknown {
  return {
    Version: "2012-10-17",
    Statement: [{
      Sid: "ReadSlackAdapterSecretBroker", Effect: "Allow", Principal: { AWS: { "Fn::GetAtt": [brokerRoleId, "Arn"] } },
      Action: "secretsmanager:GetSecretValue", Resource: "*",
    }],
  };
}

export function withoutBrokerSlackPoster<T>(input: T, env: string): T {
  const resources = (input as unknown as Template).Resources;
  const apis = Object.keys(resources).filter((id) => resources[id]!.Type === "AWS::ApiGatewayV2::Api");
  expect(apis).toHaveLength(1);
  const brokers = Object.keys(resources).filter((id) => BROKER_FUNCTION.test(id) && resources[id]!.Type === "AWS::Lambda::Function");
  expect(brokers).toHaveLength(1);
  const roles = Object.keys(resources).filter((id) => BROKER_ROLE.test(id) && resources[id]!.Type === "AWS::IAM::Role");
  expect(roles).toHaveLength(1);
  const variables = (resources[brokers[0]!]!.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
  const expected = slackPosterVariables(apis[0]!, env);
  if (!(("SLACK_VIA_CHANNEL") in variables)) return input;
  for (const [name, value] of Object.entries(expected)) {
    expect(variables[name], `the broker's ${name}`).toEqual(value);
    delete variables[name];
  }
  const secrets = Object.keys(resources).filter((id) => resources[id]!.Type === "AWS::SecretsManager::Secret" && resources[id]!.Properties.Name === `agentx/${env}/channel-adapter/slack`);
  expect(secrets).toHaveLength(1);
  const policies = Object.keys(resources).filter((id) => resources[id]!.Type === "AWS::SecretsManager::ResourcePolicy" && JSON.stringify(resources[id]!.Properties.SecretId) === JSON.stringify({ Ref: secrets[0]! }));
  expect(policies).toHaveLength(1);
  const policy = resources[policies[0]!]!;
  expect(Object.keys(policy.Properties).sort()).toEqual(["ResourcePolicy", "SecretId"]);
  expect(policy.Properties.ResourcePolicy).toEqual(brokerSlackSecretPolicyDocument(roles[0]!));
  expect(Object.entries(resources).filter(([other, candidate]) => other !== policies[0] && JSON.stringify(candidate.DependsOn ?? []).includes(policies[0]!)), "nothing depends on the policy").toEqual([]);
  delete resources[policies[0]!];
  return input;
}
