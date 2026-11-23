// L4-HW8b (owner DEC 254zzz42 (a)): the hosted lessons' Slack source (L4-HW8, aws/hosted-slack-thread.ts) needs the broker to send one signed `thread_messages` command to the built-in Slack adapter. That takes
//   1. the connect line: `channelAdapters.connectSlackPoster(broker, ...)` gives the broker the seven variables every other Slack poster has (SLACK_VIA_CHANNEL, SLACK_ADAPTER_TEAM_ID, BUILT_IN_ADAPTER_*);
//   2. the narrowest secret read: GetSecretValue on the ONE Slack adapter secret, for the ONE broker role, in the SECRET's own policy (the broker's inline policy is at its ceiling; no identity grant,
//      no customer key so no kms:Decrypt); and
//   3. nothing else: legacy (production) unchanged; no Put/Update/Describe/Create/Delete on that secret; no other secret newly readable; the broker's identity policy untouched.
// The deploy role and the default boundary are checked on the policy documents (a template diff misses the boundary), and the widening mutants are run against the same checker.
import { isDeepStrictEqual } from "node:util";
import { Stack, type App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { defaultBoundaryStatements, serviceRoleStatements, type PolicyStatementJson } from "@agentx/contracts";
import { adapterTakesCommand, SLACK_CHANNEL } from "@agentx/contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { builtInAdapterFromEnvironment } from "../../packages/broker/src/aws/channel-adapters.js";
import { hostedLessonsSlack } from "../../packages/broker/src/aws/hosted-slack-thread.js";
import { brokerSlackSecretPolicyDocument, slackPosterVariables } from "../support/broker-slack-poster-template.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Resource = { Type: string; Properties: Record<string, unknown>; DependsOn?: unknown };
type TemplateJson = { Resources: Record<string, Resource> };
type Statement = { Sid?: string; Effect: string; Action: string | string[]; Resource: unknown; Principal?: unknown };
const stacksOf = (app: App) => app.node.children.filter((child): child is Stack => Stack.isStack(child));
const ofType = (template: TemplateJson, type: string) => Object.entries(template.Resources).filter(([, resource]) => resource.Type === type);
const idOf = (template: TemplateJson, prefix: string, type: string): string => {
  const found = ofType(template, type).map(([id]) => id).filter((id) => new RegExp(`^${prefix}[0-9A-F]{8}$`, "u").test(id));
  expect(found, prefix).toHaveLength(1);
  return found[0]!;
};
const list = <T>(value: T | T[]): T[] => (Array.isArray(value) ? value : [value]);

/**
 * What the broker may do in Secrets Manager through the secrets' own policies, per secret: `secret id -> sorted actions`. Every ResourcePolicy statement naming the broker role as its principal,
 * any other principal form that could include it (a wildcard, an account root, a list) is returned as "*".
 */
function brokerSecretPolicyAccess(template: TemplateJson): Record<string, string[]> {
  const broker = idOf(template, "BrokerServiceRole", "AWS::IAM::Role");
  const out: Record<string, string[]> = {};
  for (const [, policy] of ofType(template, "AWS::SecretsManager::ResourcePolicy")) {
    const secretId = policy.Properties.SecretId as { Ref?: string };
    if (typeof secretId?.Ref !== "string") throw new Error("a secret resource policy names its secret other than by reference");
    const secret = secretId.Ref;
    for (const statement of (policy.Properties.ResourcePolicy as { Statement: Statement[] }).Statement) {
      if (statement.Effect !== "Allow") continue;
      const principal = JSON.stringify(statement.Principal);
      const names = principal.includes(`"${broker}"`) || principal.includes('"*"') || principal.includes(":root") || principal.includes("AWS::AccountId");
      if (!names) continue;
      out[secret] = [...new Set([...(out[secret] ?? []), ...list(statement.Action)])].sort();
    }
  }
  return out;
}

/** Every identity statement of the broker role's inline policies that could reach a secret: the ones with a Secrets Manager action. */
function brokerIdentitySecretStatements(template: TemplateJson): Statement[] {
  const broker = idOf(template, "BrokerServiceRole", "AWS::IAM::Role");
  return ofType(template, "AWS::IAM::Policy")
    .filter(([, policy]) => JSON.stringify(policy.Properties.Roles).includes(`"${broker}"`))
    .flatMap(([, policy]) => (policy.Properties.PolicyDocument as { Statement: Statement[] }).Statement)
    .filter((statement) => (statement as { NotAction?: unknown }).NotAction !== undefined || list(statement.Action).some((action) => /^(secretsmanager|kms):|^\*$/iu.test(action)));
}

/** The whole of change 2 and 3, as one checker. Throws a message naming the first thing that is not exactly as approved. */
function checkBrokerSlackPoster(template: TemplateJson, env: string, baseline: { identitySecretStatements: string }): void {
  const resources = template.Resources;
  const brokerId = idOf(template, "Broker", "AWS::Lambda::Function");
  const roleId = idOf(template, "BrokerServiceRole", "AWS::IAM::Role");
  const apis = ofType(template, "AWS::ApiGatewayV2::Api").map(([id]) => id);
  if (apis.length !== 1) throw new Error("one HTTP API");
  const variables = (resources[brokerId]!.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
  for (const [name, value] of Object.entries(slackPosterVariables(apis[0]!, env))) {
    if (!isDeepStrictEqual(variables[name], value)) throw new Error(`broker variable ${name} is not exactly as approved`);
  }
  // The Slack adapter secret: one, by name, no customer key.
  const secrets = ofType(template, "AWS::SecretsManager::Secret").filter(([, secret]) => secret.Properties.Name === `agentx/${env}/channel-adapter/slack`);
  if (secrets.length !== 1) throw new Error("one Slack adapter secret");
  if ("KmsKeyId" in secrets[0]![1].Properties) throw new Error("the Slack adapter secret has a customer key: kms:Decrypt would be needed and is not granted");
  // Its policy: exactly the one statement.
  const policies = ofType(template, "AWS::SecretsManager::ResourcePolicy").filter(([, policy]) => isDeepStrictEqual(policy.Properties.SecretId, { Ref: secrets[0]![0] }));
  if (policies.length !== 1) throw new Error("one resource policy on the Slack adapter secret");
  if (!isDeepStrictEqual(policies[0]![1].Properties.ResourcePolicy, brokerSlackSecretPolicyDocument(roleId))) throw new Error("the Slack adapter secret's policy is not exactly the approved statement");
  if (Object.keys(policies[0]![1].Properties).sort().join() !== "ResourcePolicy,SecretId") throw new Error("the resource policy has properties beyond the policy and the secret");
  // Through policies, the broker reaches exactly three secrets: the callback key (before this change), this one (GetSecretValue only) and, since webhook lane W3, the GitHub webhook secret
  // (an empty slot the owner fills; GetSecretValue only, checked in github-webhook-secret-infrastructure.test.ts).
  const access = brokerSecretPolicyAccess(template);
  const callbackKey = ofType(template, "AWS::SecretsManager::Secret").filter(([, secret]) => secret.Properties.Name === `agentx/${env}/callback-key`).map(([id]) => id);
  const githubWebhook = ofType(template, "AWS::SecretsManager::Secret").filter(([, secret]) => secret.Properties.Name === `agentx/${env}/github-webhook-secret`).map(([id]) => id);
  if (JSON.stringify(Object.keys(access).sort()) !== JSON.stringify([...callbackKey, ...githubWebhook, secrets[0]![0]].sort())) throw new Error(`the broker reaches secrets by policy beyond the callback key, the GitHub webhook secret and the Slack adapter's: ${Object.keys(access).join(", ")}`);
  if (JSON.stringify(access[secrets[0]![0]]) !== JSON.stringify(["secretsmanager:GetSecretValue"])) throw new Error("the broker's access to the Slack adapter secret is not GetSecretValue alone");
  // The broker's identity policy is exactly what it was: no new Secrets Manager or KMS statement.
  if (JSON.stringify(brokerIdentitySecretStatements(template)) !== baseline.identitySecretStatements) throw new Error("the broker's identity policy changed in Secrets Manager or KMS actions");
}

/** A plain evaluation for one action: allowed by an Allow whose resource is `*`, denied by no Deny naming it. */
const matches = (pattern: string, action: string): boolean => new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, "\\$&")).join(".*")}$`, "iu").test(action);
function allows(statements: readonly PolicyStatementJson[], action: string): boolean {
  const named = (statement: PolicyStatementJson) => [statement.Action].flat().some((pattern) => matches(String(pattern), action));
  if (statements.some((statement) => statement.Effect === "Deny" && named(statement))) return false;
  return statements.some((statement) => statement.Effect === "Allow" && statement.Resource === "*" && named(statement));
}

describe("the broker's Slack poster and its read of the Slack adapter secret (L4-HW8b)", () => {
  let named: TemplateJson;
  let legacy: TemplateJson;
  let baseline: { identitySecretStatements: string };

  beforeAll(() => {
    named = Template.fromStack(stacksOf(buildAgentXApp({ agentxEnv: "staging" })).find((stack) => stack.stackName === "agentx-staging-control-plane")!).toJSON() as TemplateJson;
    legacy = Template.fromStack(stacksOf(buildAgentXApp()).find((stack) => stack.node.id === "AgentXControlPlane")!).toJSON() as TemplateJson;
    // The broker's identity Secrets Manager / KMS statements as this tree synthesizes them: the mutants below add to a copy and must differ from this. That the head equals the base here (this change adds
    // none) is shown by the base-versus-head template diff in the PR and by the digest pins, which take out only the additions asserted above; the first test pins their shape.
    baseline = { identitySecretStatements: JSON.stringify(brokerIdentitySecretStatements(named)) };
  }, 240_000);

  it("the broker's identity policy has these Secrets Manager statements and no GetSecretValue on any adapter secret or on *", () => {
    const statements = brokerIdentitySecretStatements(named);
    const reads = statements.filter((statement) => list(statement.Action).includes("secretsmanager:GetSecretValue"));
    for (const statement of reads) {
      const resource = JSON.stringify(statement.Resource);
      expect(resource, "no read of the adapter secrets by identity").not.toContain("channel-adapter");
      expect(statement.Resource, "no GetSecretValue on *").not.toBe("*");
      expect(resource).not.toContain('"*"');
    }
    // The adapter secrets are only created and written by the broker (registering an adapter), as before.
    const adapterStatements = statements.filter((statement) => JSON.stringify(statement.Resource).includes("channel-adapter"));
    expect(adapterStatements.map((statement) => list(statement.Action).sort())).toEqual([["secretsmanager:CreateSecret", "secretsmanager:PutSecretValue"]]);
    expect(statements.filter((statement) => list(statement.Action).some((action) => action.startsWith("kms:")))).toEqual([]);
  });

  it("gives the named broker the seven variables and the one statement, exactly (named staging)", () => {
    expect(() => checkBrokerSlackPoster(named, "staging", baseline)).not.toThrow();
    const roleId = idOf(named, "BrokerServiceRole", "AWS::IAM::Role");
    const policy = ofType(named, "AWS::SecretsManager::ResourcePolicy").find(([, p]) => JSON.stringify(p.Properties.ResourcePolicy).includes("ReadSlackAdapterSecretBroker"))![1];
    expect(policy.Properties.ResourcePolicy).toEqual({
      Version: "2012-10-17",
      Statement: [{ Sid: "ReadSlackAdapterSecretBroker", Effect: "Allow", Principal: { AWS: { "Fn::GetAtt": [roleId, "Arn"] } }, Action: "secretsmanager:GetSecretValue", Resource: "*" }],
    });
  });

  it("is off until SlackViaChannel is enabled: the variables are references to the switch, which defaults to disabled", () => {
    const template = Template.fromStack(stacksOf(buildAgentXApp({ agentxEnv: "staging" })).find((stack) => stack.stackName === "agentx-staging-control-plane")!).toJSON() as TemplateJson & { Parameters: Record<string, { Default?: string; AllowedValues?: string[] }> };
    expect(template.Parameters.SlackViaChannel).toMatchObject({ Default: "disabled", AllowedValues: ["enabled", "disabled"] });
    const variables = (named.Resources[idOf(named, "Broker", "AWS::Lambda::Function")]!.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
    expect(variables.SLACK_VIA_CHANNEL).toEqual({ Ref: "SlackViaChannel" });
    expect(variables.BUILT_IN_ADAPTER).toEqual({ Ref: "SlackViaChannel" });
  });

  it("leaves the legacy (production) deployment's broker without any of it", () => {
    const variables = (legacy.Resources[idOf(legacy, "Broker", "AWS::Lambda::Function")]!.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
    for (const name of Object.keys(slackPosterVariables("x", "production"))) expect(variables, name).not.toHaveProperty(name);
    expect(JSON.stringify(ofType(legacy, "AWS::SecretsManager::ResourcePolicy"))).not.toContain("ReadSlackAdapterSecretBroker");
  });

  it("is what the hosted code reads: the variables, set to enabled, give the broker a built-in Slack adapter that takes thread_messages and a lessons factory", () => {
    const variables = (named.Resources[idOf(named, "Broker", "AWS::Lambda::Function")]!.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
    const resolved: Record<string, string> = {};
    for (const name of Object.keys(slackPosterVariables("x", "staging"))) {
      const value = variables[name];
      resolved[name] = typeof value === "string" ? value : JSON.stringify(value).includes("channel-commands") ? "https://api.example.com/v1/slack/channel-commands"
        : JSON.stringify(value).includes("channel-events") ? "https://api.example.com/v1/slack/channel-events" : name === "SLACK_ADAPTER_TEAM_ID" ? "T0123456789" : "enabled";
    }
    const adapter = builtInAdapterFromEnvironment(resolved);
    expect(adapter?.channel).toBe(SLACK_CHANNEL);
    expect(adapter?.commandsUrl).toBe("https://api.example.com/v1/slack/channel-commands");
    expect(adapter?.secretName).toBe("agentx/staging/channel-adapter/slack");
    expect(adapter !== undefined && adapterTakesCommand(adapter, "thread_messages")).toBe(true);
    expect(hostedLessonsSlack({ env: resolved, secretsManager: { send: async () => ({}) } as never })).toBeTypeOf("function");
    // With the switch off, the same variables give no Slack source (fail closed).
    expect(hostedLessonsSlack({ env: { ...resolved, SLACK_VIA_CHANNEL: "disabled", BUILT_IN_ADAPTER: "disabled" }, secretsManager: { send: async () => ({}) } as never })).toBeUndefined();
  });

  describe("the deploy role and the default boundary (checked on the policy documents: a template diff misses the boundary)", () => {
    const scope = { env: "staging", partition: "aws", region: "us-west-2", account: "111122223333", cloudFormationRoleName: "agentx-staging-cloudformation" } as const;
    // What CloudFormation calls to create, update and delete an AWS::SecretsManager::ResourcePolicy (BlockPublicPolicy included) on the secret, and what the broker calls at run time.
    // Not confirmed against the service's reference (the AWS documentation server was unavailable); the check below does not depend on the list being exact, since the deploy role and the
    // boundary allow secretsmanager:* and no Deny in either names Secrets Manager.
    const ACTIONS = ["secretsmanager:PutResourcePolicy", "secretsmanager:GetResourcePolicy", "secretsmanager:DeleteResourcePolicy", "secretsmanager:ValidateResourcePolicy", "secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue"];

    it("both allow every one of them, and neither has a Deny that names Secrets Manager", () => {
      const service = serviceRoleStatements({ ...scope, artifactBucketArn: "arn:aws:s3:::b" } as never);
      const boundary = defaultBoundaryStatements(scope);
      for (const action of ACTIONS) {
        expect(allows(service, action), `deploy role: ${action}`).toBe(true);
        expect(allows(boundary, action), `boundary: ${action}`).toBe(true);
      }
      for (const statements of [service, boundary]) {
        expect(statements.filter((statement) => statement.Effect === "Deny" && [statement.Action].flat().some((action) => /^(secretsmanager|\*)/u.test(String(action))))).toEqual([]);
      }
    });

    it("the same deploy already creates a resource policy on the callback signing key's secret", () => {
      const callbackPolicy = ofType(named, "AWS::SecretsManager::ResourcePolicy").filter(([, policy]) => JSON.stringify(policy.Properties.ResourcePolicy).includes("ReadCallbackSigningKey"));
      expect(callbackPolicy).toHaveLength(1);
    });
  });

  describe("widening mutants fail the same checker", () => {
    const clone = (): TemplateJson => structuredClone(named);
    const slackPolicy = (template: TemplateJson): Resource => ofType(template, "AWS::SecretsManager::ResourcePolicy").find(([, p]) => JSON.stringify(p.Properties.ResourcePolicy).includes("ReadSlackAdapterSecretBroker"))![1];
    const statementOf = (template: TemplateJson): Record<string, unknown> => ((slackPolicy(template).Properties.ResourcePolicy as { Statement: Record<string, unknown>[] }).Statement[0])!;
    const mutants: Array<[string, (template: TemplateJson) => void, string?]> = [
      ["M1 the action is a wildcard", (t) => { statementOf(t).Action = "secretsmanager:*"; }],
      ["M2 the action adds PutSecretValue", (t) => { statementOf(t).Action = ["secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue"]; }],
      ["M3 the action is UpdateSecret", (t) => { statementOf(t).Action = "secretsmanager:UpdateSecret"; }],
      ["M4 the action adds GetResourcePolicy... and PutResourcePolicy", (t) => { statementOf(t).Action = ["secretsmanager:GetSecretValue", "secretsmanager:PutResourcePolicy"]; }],
      ["M5 the principal is any AWS principal", (t) => { statementOf(t).Principal = { AWS: "*" }; }],
      ["M6 the principal is the account root", (t) => { statementOf(t).Principal = { AWS: { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":iam::", { Ref: "AWS::AccountId" }, ":root"]] } }; }],
      ["M7 the principal is another role", (t) => { statementOf(t).Principal = { AWS: { "Fn::GetAtt": [idOf(t, "DispatcherServiceRole", "AWS::IAM::Role"), "Arn"] } }; }],
      ["M8 a second statement allows another role to read it", (t) => { (slackPolicy(t).Properties.ResourcePolicy as { Statement: unknown[] }).Statement.push({ ...statementOf(t), Sid: "Other", Principal: { AWS: { "Fn::GetAtt": [idOf(t, "DispatcherServiceRole", "AWS::IAM::Role"), "Arn"] } } }); }],
      ["M9 the policy is on another secret (the GitHub key's / the callback key's neighbour)", (t) => {
        const other = ofType(t, "AWS::SecretsManager::Secret").find(([, secret]) => secret.Properties.Name !== "agentx/staging/channel-adapter/slack" && secret.Properties.Name !== "agentx/staging/callback-key"
          // Webhook lane W3: the GitHub webhook secret is the broker's third, approved secret (the broker is already in its policy).
          && secret.Properties.Name !== "agentx/staging/github-webhook-secret");
        if (other === undefined) throw new Error("fixture: no other secret in the template");
        slackPolicy(t).Properties.SecretId = { Ref: other[0] };
      }],
      ["M10 the broker is added to a second secret's policy", (t) => {
        const other = ofType(t, "AWS::SecretsManager::Secret").find(([, secret]) => secret.Properties.Name !== "agentx/staging/channel-adapter/slack" && secret.Properties.Name !== "agentx/staging/callback-key"
          // Webhook lane W3: the GitHub webhook secret is the broker's third, approved secret.
          && secret.Properties.Name !== "agentx/staging/github-webhook-secret");
        if (other === undefined) throw new Error("fixture: no other secret in the template");
        t.Resources.ExtraPolicy = { Type: "AWS::SecretsManager::ResourcePolicy", Properties: { SecretId: { Ref: other[0] }, ResourcePolicy: structuredClone(slackPolicy(t).Properties.ResourcePolicy) } };
      }],
      ["M11 an identity statement reads every secret", (t) => {
        const [, policy] = ofType(t, "AWS::IAM::Policy").find(([, p]) => JSON.stringify(p.Properties.Roles).includes(idOf(t, "BrokerServiceRole", "AWS::IAM::Role")))!;
        (policy.Properties.PolicyDocument as { Statement: unknown[] }).Statement.push({ Effect: "Allow", Action: "secretsmanager:GetSecretValue", Resource: "*" });
      }],
      ["M12 an identity statement reads the adapter secrets by prefix (the broker role's policy grows)", (t) => {
        const [, policy] = ofType(t, "AWS::IAM::Policy").find(([, p]) => JSON.stringify(p.Properties.Roles).includes(idOf(t, "BrokerServiceRole", "AWS::IAM::Role")))!;
        (policy.Properties.PolicyDocument as { Statement: unknown[] }).Statement.push({ Effect: "Allow", Action: "secretsmanager:GetSecretValue", Resource: { "Fn::GetAtt": [ofType(t, "AWS::SecretsManager::Secret").find(([, s]) => s.Properties.Name === "agentx/staging/channel-adapter/slack")![0], "Id"] } });
      }],
      ["M13b a NotAction statement is added to the broker", (t) => {
        const [, policy] = ofType(t, "AWS::IAM::Policy").find(([, p]) => JSON.stringify(p.Properties.Roles).includes(idOf(t, "BrokerServiceRole", "AWS::IAM::Role")))!;
        (policy.Properties.PolicyDocument as { Statement: unknown[] }).Statement.push({ Effect: "Allow", NotAction: "s3:*", Resource: "*" });
      }],
      ["M13c a mixed-case GetSecretValue statement is added", (t) => {
        const [, policy] = ofType(t, "AWS::IAM::Policy").find(([, p]) => JSON.stringify(p.Properties.Roles).includes(idOf(t, "BrokerServiceRole", "AWS::IAM::Role")))!;
        (policy.Properties.PolicyDocument as { Statement: unknown[] }).Statement.push({ Effect: "Allow", Action: "SecretsManager:GetSecretValue", Resource: "*" });
      }],
      ["M13 a kms grant is added to the broker", (t) => {
        const [, policy] = ofType(t, "AWS::IAM::Policy").find(([, p]) => JSON.stringify(p.Properties.Roles).includes(idOf(t, "BrokerServiceRole", "AWS::IAM::Role")))!;
        (policy.Properties.PolicyDocument as { Statement: unknown[] }).Statement.push({ Effect: "Allow", Action: "kms:Decrypt", Resource: "*" });
      }],
      ["M14 the secret gets a customer key", (t) => {
        ofType(t, "AWS::SecretsManager::Secret").find(([, s]) => s.Properties.Name === "agentx/staging/channel-adapter/slack")![1].Properties.KmsKeyId = "alias/x";
      }],
      ["M15 the Slack poster variable for the secret names another secret", (t) => {
        ((t.Resources[idOf(t, "Broker", "AWS::Lambda::Function")]!.Properties.Environment as { Variables: Record<string, unknown> }).Variables).BUILT_IN_ADAPTER_SECRET_NAME = "agentx/staging/callback-key";
      }],
      ["M16 the commands URL is left out", (t) => {
        delete ((t.Resources[idOf(t, "Broker", "AWS::Lambda::Function")]!.Properties.Environment as { Variables: Record<string, unknown> }).Variables).BUILT_IN_ADAPTER_COMMANDS_URL;
      }],
      ["M17 the resource policy is removed", (t) => { for (const [id, p] of ofType(t, "AWS::SecretsManager::ResourcePolicy")) if (JSON.stringify(p.Properties.ResourcePolicy).includes("ReadSlackAdapterSecretBroker")) delete t.Resources[id]; }],
    ];
    it("the unmutated template passes", () => { expect(() => checkBrokerSlackPoster(clone(), "staging", baseline)).not.toThrow(); });
    for (const [label, mutate] of mutants) {
      it(`${label} is refused`, () => {
        const mutated = clone();
        expect(() => mutate(mutated), "the mutant itself applies").not.toThrow();
        expect(() => checkBrokerSlackPoster(mutated, "staging", baseline)).toThrow(/.+/u);
      });
    }
  });
});
