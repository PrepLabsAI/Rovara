// Spec 062 Phase 3: the channel API, event sender and their permissions, off by default, named environments only.
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Resource = { Type: string; Properties: Record<string, unknown> };
type Statement = { Effect?: string; Action: string | string[]; Resource?: unknown; Condition?: Record<string, Record<string, unknown>> };
type TemplateJson = { Parameters: Record<string, Record<string, unknown>>; Resources: Record<string, Resource> };

let named: TemplateJson;
let legacy: TemplateJson;

const controlPlane = (app: ReturnType<typeof buildAgentXApp>, name: string) =>
  Template.fromStack(app.node.children.find((child): child is Stack => Stack.isStack(child) && child.stackName === name)!).toJSON() as TemplateJson;
const ofType = (template: TemplateJson, type: string) => Object.entries(template.Resources).filter(([, resource]) => resource.Type === type);
const withoutHash = (logicalId: string) => logicalId.replace(/[0-9A-F]{8}$/, "");
const functionNamed = (template: TemplateJson, prefix: string) => ofType(template, "AWS::Lambda::Function").find(([id]) => withoutHash(id) === prefix);
const roleOf = (template: TemplateJson, prefix: string) => ((functionNamed(template, prefix)![1].Properties.Role as { "Fn::GetAtt": [string] })["Fn::GetAtt"][0]);
function statementsOf(template: TemplateJson, roleId: string): Statement[] {
  return ofType(template, "AWS::IAM::Policy")
    .filter(([, policy]) => (policy.Properties.Roles as Array<{ Ref: string }>).some((role) => role.Ref === roleId))
    .flatMap(([, policy]) => (policy.Properties.PolicyDocument as { Statement: Statement[] }).Statement);
}
const actions = (statement: Statement) => [statement.Action].flat();

beforeAll(() => {
  named = controlPlane(buildAgentXApp({ agentxEnv: "staging" }), "agentx-staging-control-plane");
  legacy = controlPlane(buildAgentXApp(), "AgentXControlPlane");
}, 300_000);

describe("channel adapters infrastructure", () => {
  it("is off by default, and the flag reaches the broker and the channel API", () => {
    expect(named.Parameters.ChannelAdapters).toMatchObject({ Type: "String", Default: "disabled", AllowedValues: ["enabled", "disabled"] });
    const ingress = functionNamed(named, "ChannelApiIngress")![1];
    expect((ingress.Properties.Environment as { Variables: Record<string, unknown> }).Variables.CHANNEL_ADAPTERS).toEqual({ Ref: "ChannelAdapters" });
    const broker = ofType(named, "AWS::Lambda::Function").find(([id]) => withoutHash(id).startsWith("Broker"))![1];
    expect((broker.Properties.Environment as { Variables: Record<string, unknown> }).Variables.CHANNEL_ADAPTERS).toEqual({ Ref: "ChannelAdapters" });
  });

  it("is absent from the legacy stack", () => {
    expect(legacy.Parameters.ChannelAdapters).toBeUndefined();
    expect(functionNamed(legacy, "ChannelApiIngress")).toBeUndefined();
  });

  it("routes only the three signed POSTs to the channel API, with no API Gateway authorizer", () => {
    const routes = ofType(named, "AWS::ApiGatewayV2::Route").map(([, route]) => route.Properties).filter((route) => String(route.RouteKey).includes("/v1/channels/"));
    expect(routes.map((route) => route.RouteKey).sort()).toEqual(["POST /v1/channels/{channel}/actions", "POST /v1/channels/{channel}/decisions", "POST /v1/channels/{channel}/messages"]);
    for (const route of routes) expect(route.AuthorizationType).toBe("NONE");
  });

  it("lets the channel API read only adapters, bindings (Slack's too, for the built-in adapter) and links from the state table, by key", () => {
    const statements = statementsOf(named, roleOf(named, "ChannelApiIngress"));
    const onState = statements.filter((statement) => JSON.stringify(statement.Resource).includes("State") && !JSON.stringify(statement.Resource).includes("ChannelApiState"));
    expect(onState.map((statement) => [actions(statement), statement.Condition?.["ForAllValues:StringLike"]?.["dynamodb:LeadingKeys"]])).toEqual([
      [["dynamodb:GetItem"], ["CHANNEL_ADAPTERS", "BINDING#*", "CHANNEL_LINK#*", "SLACK_BINDING#*"]],
      [["dynamodb:PutItem"], ["CHANNEL_LINK_CODE#*"]],
    ]);
    // No query, no scan, no other write to the state table.
    for (const statement of statements) {
      for (const action of actions(statement)) expect(["dynamodb:Query", "dynamodb:Scan"]).not.toContain(action);
    }
  });

  it("keeps adapter secrets under their own prefix: the broker writes them, the channel API and sender only read them", () => {
    const secretsOf = (prefix: string) => statementsOf(named, roleOf(named, prefix)).filter((statement) => actions(statement).some((action) => action.startsWith("secretsmanager:")));
    const pattern = /secret:agentx\/staging\/channel-adapter\/\*/;
    for (const prefix of ["ChannelApiIngress", "ChannelApiEventSender"]) {
      const statements = secretsOf(prefix);
      expect(statements.flatMap(actions)).toEqual(["secretsmanager:GetSecretValue"]);
      for (const statement of statements) expect(JSON.stringify(statement.Resource)).toMatch(pattern);
    }
    const brokerRole = (ofType(named, "AWS::Lambda::Function").find(([id]) => withoutHash(id).startsWith("Broker"))![1].Properties.Role as { "Fn::GetAtt": [string] })["Fn::GetAtt"][0];
    const writes = statementsOf(named, brokerRole).filter((statement) => actions(statement).includes("secretsmanager:CreateSecret"));
    expect(writes).toHaveLength(1);
    expect(JSON.stringify(writes[0]!.Resource)).toMatch(pattern);
  });

  it("delivers events from a queue with partial batch failures and a dead-letter queue", () => {
    const mappings = ofType(named, "AWS::Lambda::EventSourceMapping").map(([, mapping]) => mapping.Properties)
      .filter((mapping) => JSON.stringify(mapping.FunctionName).includes("ChannelApiEventSender"));
    expect(mappings).toHaveLength(1);
    expect(mappings[0]!.FunctionResponseTypes).toEqual(["ReportBatchItemFailures"]);
    const queues = ofType(named, "AWS::SQS::Queue").filter(([id]) => id.startsWith("ChannelApi"));
    expect(queues.map(([id]) => withoutHash(id)).sort()).toEqual(["ChannelApiEventDeadLetters", "ChannelApiEvents", "ChannelApiRequestDeadLetters", "ChannelApiRequests"]);
    const events = queues.find(([id]) => withoutHash(id) === "ChannelApiEvents")![1].Properties;
    expect(events.RedrivePolicy).toMatchObject({ maxReceiveCount: 8 });
    const requests = queues.find(([id]) => withoutHash(id) === "ChannelApiRequests")![1].Properties;
    expect(requests.FifoQueue).toBe(true);
    // Phase 7b: a conversation's events arrive in order.
    expect(events.FifoQueue).toBe(true);
    expect(queues.find(([id]) => withoutHash(id) === "ChannelApiEventDeadLetters")![1].Properties.FifoQueue).toBe(true);
  });

  it("registers the built-in Slack adapter at deploy, off until SlackViaChannel is enabled (FR-073, FR-074)", () => {
    expect(named.Parameters.SlackViaChannel).toMatchObject({ Type: "String", Default: "disabled", AllowedValues: ["enabled", "disabled"] });
    expect(legacy.Parameters.SlackViaChannel).toBeUndefined();
    const secrets = ofType(named, "AWS::SecretsManager::Secret").filter(([id]) => withoutHash(id) === "ChannelApiSlackAdapterSecret");
    expect(secrets).toHaveLength(1);
    expect(secrets[0]![1].Properties).toMatchObject({
      Name: "agentx/staging/channel-adapter/slack",
      GenerateSecretString: { PasswordLength: 64, ExcludePunctuation: true, IncludeSpace: false },
    });
    const variables = (prefix: string) => (functionNamed(named, prefix)![1].Properties.Environment as { Variables: Record<string, unknown> }).Variables;
    for (const prefix of ["ChannelApiIngress", "ChannelApiEventSender"]) {
      expect(variables(prefix)).toMatchObject({ BUILT_IN_ADAPTER: { Ref: "SlackViaChannel" }, BUILT_IN_ADAPTER_CHANNEL: "slack", BUILT_IN_ADAPTER_SECRET_NAME: "agentx/staging/channel-adapter/slack" });
      expect(JSON.stringify(variables(prefix).BUILT_IN_ADAPTER_CALLBACK_URL)).toContain("/v1/slack/channel-events");
    }
    expect(variables("SlackIngress")).toMatchObject({ SLACK_VIA_CHANNEL: { Ref: "SlackViaChannel" }, SLACK_ADAPTER_SECRET_NAME: "agentx/staging/channel-adapter/slack" });
    // Slack's ingress may read the adapter's secret, and nothing else under the adapter prefix.
    const reads = statementsOf(named, roleOf(named, "SlackIngress")).filter((statement) => actions(statement).includes("secretsmanager:GetSecretValue"));
    expect(reads.map((statement) => JSON.stringify(statement.Resource)).join()).toContain("ChannelApiSlackAdapterSecret");
    expect(JSON.stringify(reads)).not.toContain("channel-adapter/*");
    const route = ofType(named, "AWS::ApiGatewayV2::Route").map(([, resource]) => resource.Properties).find((properties) => properties.RouteKey === "POST /v1/slack/channel-events");
    expect(route).toMatchObject({ AuthorizationType: "NONE" });
    expect(ofType(legacy, "AWS::ApiGatewayV2::Route").some(([, resource]) => resource.Properties.RouteKey === "POST /v1/slack/channel-events")).toBe(false);
  });

  it("takes the core's commands for Slack, and lets the notifier and reconciler sign them (Phase 7c)", () => {
    const route = ofType(named, "AWS::ApiGatewayV2::Route").map(([, resource]) => resource.Properties).find((properties) => properties.RouteKey === "POST /v1/slack/channel-commands");
    expect(route).toMatchObject({ AuthorizationType: "NONE" });
    expect(ofType(legacy, "AWS::ApiGatewayV2::Route").some(([, resource]) => resource.Properties.RouteKey === "POST /v1/slack/channel-commands")).toBe(false);
    const variables = (prefix: string) => (functionNamed(named, prefix)![1].Properties.Environment as { Variables: Record<string, unknown> }).Variables;
    for (const prefix of ["DeveloperTaskNotifierFunction", "SessionsReconciler"]) {
      expect(variables(prefix), prefix).toMatchObject({ SLACK_VIA_CHANNEL: { Ref: "SlackViaChannel" }, SLACK_ADAPTER_TEAM_ID: { Ref: "SlackTeamId" }, BUILT_IN_ADAPTER_SECRET_NAME: "agentx/staging/channel-adapter/slack" });
      expect(JSON.stringify(variables(prefix).BUILT_IN_ADAPTER_COMMANDS_URL)).toContain("/v1/slack/channel-commands");
      const reads = statementsOf(named, roleOf(named, prefix)).filter((statement) => actions(statement).includes("secretsmanager:GetSecretValue"));
      expect(reads.map((statement) => JSON.stringify(statement.Resource)).join(), prefix).toContain("ChannelApiSlackAdapterSecret");
    }
    // A Canvas takes three Slack calls; the legacy Slack ingress keeps its 10 seconds.
    expect(functionNamed(named, "SlackIngress")![1].Properties.Timeout).toBe(30);
    expect(functionNamed(legacy, "SlackIngress")![1].Properties.Timeout).toBe(10);
  });

  it("expires short-lived channel state by expiresAt", () => {
    const table = ofType(named, "AWS::DynamoDB::Table").find(([id]) => withoutHash(id) === "ChannelApiState")![1];
    expect(table.Properties.TimeToLiveSpecification).toEqual({ AttributeName: "expiresAt", Enabled: true });
  });
});
