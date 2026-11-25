// DEC 238 slice 1 in the gateway stack: bring your own Bedrock. No switch (DEC 254zzz520): every gateway with
// -c rovaraModelGatewayProductAi=on, beta, production and named test environments alike, carries it. Two retained pieces every customer role depends on: the
// Bedrock broker role at a FIXED name (only the serving role may assume it; it may only assume customers' RovaraBedrockInvoke-*
// roles with an rvb-* external id and an org_* session name; no Bedrock rights of its own) and the external-id HMAC key (only the
// serving role may make MACs with it). Two companies' isolation is the customer trust policy's job (bedrock-byo tests); here: the
// broker can't be used for anything else, and nothing about it can be replaced by an update.
import type { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { BEDROCK_BYO_ROLE_PREFIX } from "../../packages/model-gateway/src/bedrock-byo.js";
import { GATEWAY_ENV } from "../../packages/model-gateway/src/deploy.js";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { BEDROCK_BYO_CUSTOMER_ROLE_PREFIX, bedrockBrokerRoleName, bedrockExternalIdKeyAlias, MODEL_GATEWAY_CONTEXT_KEY, MODEL_GATEWAY_ENV, MODEL_GATEWAY_PRODUCT_CONTEXT_KEY } from "../../infra/lib/model-gateway.js";

type Resource = { Type: string; Properties: Record<string, unknown>; DeletionPolicy?: string; UpdateReplacePolicy?: string };
type Statement = { Sid?: string; Effect: string; Action: string | string[]; Resource: unknown; Principal?: unknown; Condition?: Record<string, Record<string, unknown>> };
// Production names its kinds, as the release pipeline does (a production deploy that names none is refused: the test below).
const app = (context: Record<string, string>, env = "staging") => buildAgentXApp({ [MODEL_GATEWAY_CONTEXT_KEY]: env, agentxRegion: "us-west-2", ...(env === "production" && context[MODEL_GATEWAY_PRODUCT_CONTEXT_KEY] === "on" ? { rovaraAiSourceKinds: "openai" } : {}), ...context });
const synth = (context: Record<string, string>, env = "staging") => Template.fromStack(app(context, env).node.findChild("RovaraModelGateway") as Stack).toJSON() as { Resources: Record<string, Resource> };
const productOn = { [MODEL_GATEWAY_PRODUCT_CONTEXT_KEY]: "on" };
/** The logical ids as first made: CloudFormation replaces a resource whose logical id changes. Never change these. */
const PINNED = { broker: "BedrockBrokerRoleEF230DEA", key: "BedrockExternalIdKey85A8D0A1" };
const on = synth(productOn);
// Without product AI (company-key mode) there is no Bedrock source and so no broker.
const without = synth({});

const byType = (t: { Resources: Record<string, Resource> }, type: string) => Object.entries(t.Resources).filter(([, r]) => r.Type === type);
const broker = (t: { Resources: Record<string, Resource> }) => byType(t, "AWS::IAM::Role").find(([id]) => id.startsWith("BedrockBrokerRole"));
const externalIdKey = (t: { Resources: Record<string, Resource> }) => byType(t, "AWS::KMS::Key").find(([id]) => id.startsWith("BedrockExternalIdKey"));
// The role boundary (model-gateway-boundary.ts) is a ManagedPolicy attached to no role: a ceiling, not a grant, so it is not read here.
const statements = (t: { Resources: Record<string, Resource> }): Statement[] => Object.values(t.Resources).filter((r) => r.Type === "AWS::IAM::Policy" || (r.Type === "AWS::IAM::ManagedPolicy" && r.Properties.Roles !== undefined)).flatMap((p) => (p.Properties.PolicyDocument as { Statement: Statement[] }).Statement);
const serveEnv = (t: { Resources: Record<string, Resource> }) => {
  const task = Object.entries(t.Resources).find(([id, r]) => r.Type === "AWS::ECS::TaskDefinition" && id.startsWith("ServeTask"))![1];
  return Object.fromEntries((task.Properties.ContainerDefinitions as Array<{ Environment: Array<{ Name: string; Value: unknown }> }>)[0]!.Environment.map((e) => [e.Name, e.Value]));
};
const serveRoleId = (t: { Resources: Record<string, Resource> }) => { const task = Object.entries(t.Resources).find(([id, r]) => r.Type === "AWS::ECS::TaskDefinition" && id.startsWith("ServeTask"))![1]; return (task.Properties.TaskRoleArn as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"][0]; };

describe("bring your own Bedrock in the gateway stack (DEC 238)", () => {
  it("without product AI: no broker, no external-id key, no setting (the template as before)", () => {
    expect(broker(without)).toBeUndefined();
    expect(externalIdKey(without)).toBeUndefined();
    expect(serveEnv(without)[GATEWAY_ENV.bedrockBrokerRole]).toBeUndefined();
    // Outside the role boundary, which names the broker and customers' roles as a ceiling for every gateway (model-gateway-boundary.ts).
    const { RoleBoundary: _boundary, ...rest } = without.Resources;
    expect(_boundary?.Type).toBe("AWS::IAM::ManagedPolicy");
    expect(JSON.stringify({ ...without, Resources: rest })).not.toContain("RovaraBedrock");
  });

  it("the broker: fixed name, retained, one-hour sessions, only the serving role with an org_* session may assume it", () => {
    const [, role] = broker(on)!;
    expect(role.Properties.RoleName).toBe(bedrockBrokerRoleName("staging"));
    expect(role.Properties.RoleName).toBe("RovaraBedrockBroker-staging");
    expect(role.DeletionPolicy).toBe("Retain");
    expect(role.UpdateReplacePolicy).toBe("Retain");
    expect(role.Properties.MaxSessionDuration).toBe(3600);
    const trust = (role.Properties.AssumeRolePolicyDocument as { Statement: Statement[] }).Statement;
    expect(trust).toEqual([{ Action: "sts:AssumeRole", Effect: "Allow", Principal: { AWS: { "Fn::GetAtt": [serveRoleId(on), "Arn"] } }, Condition: { StringLike: { "sts:RoleSessionName": "org_*" } } }]);
  });

  it("the broker's only right: assume customers' RovaraBedrockInvoke-* roles with an rvb-* external id and an org_* session name", () => {
    const [, role] = broker(on)!;
    const policies = role.Properties.Policies as Array<{ PolicyName: string; PolicyDocument: { Statement: Statement[] } }>;
    expect(policies.map((p) => p.PolicyName)).toEqual(["AssumeCustomerBedrockRoles"]);
    expect(policies[0]!.PolicyDocument.Statement).toEqual([{
      Sid: "AssumeCustomerBedrockRoles", Effect: "Allow", Action: "sts:AssumeRole",
      Resource: { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, `:iam::*:role/${BEDROCK_BYO_CUSTOMER_ROLE_PREFIX}*`]] },
      Condition: { StringLike: { "sts:ExternalId": "rvb-*", "sts:RoleSessionName": "org_*" }, StringNotEquals: { "aws:ResourceAccount": { Ref: "AWS::AccountId" } } },
    }]);
    // No managed policy and no separate policy attached to it: nothing else it may do (no Bedrock rights of its own).
    expect(role.Properties.ManagedPolicyArns).toBeUndefined();
    const attached = byType(on, "AWS::IAM::Policy").filter(([, p]) => JSON.stringify(p.Properties.Roles ?? []).includes(broker(on)![0]));
    expect(attached).toEqual([]);
    expect(BEDROCK_BYO_CUSTOMER_ROLE_PREFIX).toBe(BEDROCK_BYO_ROLE_PREFIX);
  });

  it("the serving role may assume the broker only (org_* session), and make external ids only with its own key", () => {
    const s = statements(on);
    const assume = s.filter((x) => [x.Action].flat().includes("sts:AssumeRole"));
    expect(assume.map((x) => x.Sid).sort()).toEqual(["AssumeBedrockBroker", "AssumeVertexFederation"]);
    expect(assume.find((x) => x.Sid === "AssumeBedrockBroker")).toEqual({ Sid: "AssumeBedrockBroker", Effect: "Allow", Action: "sts:AssumeRole", Resource: { "Fn::GetAtt": [broker(on)![0], "Arn"] }, Condition: { StringLike: { "sts:RoleSessionName": "org_*" } } });
    expect(s.find((x) => x.Sid === "MakeBedrockExternalIds")).toEqual({ Sid: "MakeBedrockExternalIds", Effect: "Allow", Action: "kms:GenerateMac", Resource: { "Fn::GetAtt": [externalIdKey(on)![0], "Arn"] } });
    // No Bedrock grant comes with it: the customer's account is the one invoked.
    expect(s.flatMap((x) => [x.Action].flat()).filter((a) => a.startsWith("bedrock:"))).toEqual([]);
  });

  it("the external-id key: HMAC, retained, only the serving role makes MACs, and the account can't schedule its deletion", () => {
    const [, key] = externalIdKey(on)!;
    expect(key.Properties.KeySpec).toBe("HMAC_256");
    expect(key.Properties.KeyUsage).toBe("GENERATE_VERIFY_MAC");
    expect(key.DeletionPolicy).toBe("Retain");
    const policy = (key.Properties.KeyPolicy as { Statement: Statement[] }).Statement;
    expect(policy.map((x) => x.Sid)).toEqual(["AccountManagesNotUses", "OnlyGatewayMakesExternalIds"]);
    expect(policy[1]).toMatchObject({ Action: "kms:GenerateMac", Condition: { ArnEquals: { "aws:PrincipalArn": { "Fn::GetAtt": [serveRoleId(on), "Arn"] } } } });
    expect(JSON.stringify(policy)).not.toMatch(/ScheduleKeyDeletion|kms:Delete|VerifyMac|Decrypt/u);
    // A fixed alias: a replacement key would clash with it and fail the deploy instead of changing every external id.
    const aliases = byType(on, "AWS::KMS::Alias").filter(([, a]) => JSON.stringify(a.Properties.TargetKeyId).includes(externalIdKey(on)![0]));
    expect(aliases.map(([, a]) => a.Properties.AliasName)).toEqual([bedrockExternalIdKeyAlias("staging")]);
    expect(bedrockExternalIdKeyAlias("staging")).toBe("alias/rovara-bedrock-external-id-staging");
  });

  it("the broker's and the key's logical ids are pinned: a rename would replace them and break every customer", () => {
    expect(broker(on)![0]).toBe(PINNED.broker);
    expect(externalIdKey(on)![0]).toBe(PINNED.key);
  });

  it("the serving task gets both settings; the env names match the process's", () => {
    const e = serveEnv(on);
    expect(e[GATEWAY_ENV.bedrockBrokerRole]).toEqual({ "Fn::GetAtt": [broker(on)![0], "Arn"] });
    expect(e[GATEWAY_ENV.bedrockExternalIdKey]).toEqual({ "Fn::GetAtt": [externalIdKey(on)![0], "Arn"] });
    expect(MODEL_GATEWAY_ENV.bedrockBrokerRole).toBe(GATEWAY_ENV.bedrockBrokerRole);
    expect(MODEL_GATEWAY_ENV.bedrockExternalIdKey).toBe(GATEWAY_ENV.bedrockExternalIdKey);
  });

  it("no switch: the old context key is not read (a stale -c rovaraModelGatewayBedrockByo changes nothing, in any environment)", () => {
    for (const env of ["staging", "production"]) {
      expect(JSON.stringify(synth({ ...productOn, rovaraModelGatewayBedrockByo: "yes" }, env))).toEqual(JSON.stringify(synth(productOn, env)));
      expect(broker(synth({ rovaraModelGatewayBedrockByo: "on" }, env))).toBeUndefined();
    }
  });

  it("production with product AI must name its kinds: an install naming none keeps own Bedrock for the AGENTS on, so the deploy is refused (gateway and web)", () => {
    expect(() => buildAgentXApp({ [MODEL_GATEWAY_CONTEXT_KEY]: "production", agentxRegion: "us-west-2", ...productOn })).toThrow(/production must name its company AI sources/u);
    expect(() => buildAgentXApp({ [MODEL_GATEWAY_CONTEXT_KEY]: "production", agentxRegion: "us-west-2", ...productOn, rovaraAiSourceKinds: "" })).toThrow(/production must name/u);
    // The website stack's own check of the same rule stays in Rovara Cloud with that stack (Code's app makes only the gateway's stacks).
    // Naming openai, as the pipeline does, synthesizes; staging is not held to it.
    expect(() => buildAgentXApp({ [MODEL_GATEWAY_CONTEXT_KEY]: "production", agentxRegion: "us-west-2", ...productOn, rovaraAiSourceKinds: "openai" })).not.toThrow();
    expect(() => synth(productOn, "staging")).not.toThrow();
  });

  // DEC 254zzz520: production carries it too. Same pieces under production's own names; the one difference from staging is the names.
  describe("production (no guard, no switch)", () => {
    const prod = synth(productOn, "production");
    const prodWithout = synth({}, "production");

    it("synthesizes: the broker at its fixed production name, the key under its production alias, both retained, logical ids pinned", () => {
      const [brokerId, role] = broker(prod)!;
      expect(brokerId).toBe(PINNED.broker);
      expect(role.Properties.RoleName).toBe("RovaraBedrockBroker-production");
      expect(role.DeletionPolicy).toBe("Retain");
      expect(role.UpdateReplacePolicy).toBe("Retain");
      const [keyId, key] = externalIdKey(prod)!;
      expect(keyId).toBe(PINNED.key);
      expect(key.DeletionPolicy).toBe("Retain");
      const aliases = byType(prod, "AWS::KMS::Alias").filter(([, a]) => JSON.stringify(a.Properties.TargetKeyId).includes(keyId));
      expect(aliases.map(([, a]) => a.Properties.AliasName)).toEqual(["alias/rovara-bedrock-external-id-production"]);
    });

    it("the same trust chain and least privilege as staging: serving role to broker (org_* session), broker to customers' RovaraBedrockInvoke-* roles in OTHER accounts (rvb-* external id, org_* session), no Bedrock rights of its own", () => {
      const [, role] = broker(prod)!;
      const trust = (role.Properties.AssumeRolePolicyDocument as { Statement: Statement[] }).Statement;
      expect(trust).toEqual([{ Action: "sts:AssumeRole", Effect: "Allow", Principal: { AWS: { "Fn::GetAtt": [serveRoleId(prod), "Arn"] } }, Condition: { StringLike: { "sts:RoleSessionName": "org_*" } } }]);
      const policies = role.Properties.Policies as Array<{ PolicyName: string; PolicyDocument: { Statement: Statement[] } }>;
      expect(policies[0]!.PolicyDocument.Statement).toEqual([{
        Sid: "AssumeCustomerBedrockRoles", Effect: "Allow", Action: "sts:AssumeRole",
        Resource: { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, `:iam::*:role/${BEDROCK_BYO_CUSTOMER_ROLE_PREFIX}*`]] },
        Condition: { StringLike: { "sts:ExternalId": "rvb-*", "sts:RoleSessionName": "org_*" }, StringNotEquals: { "aws:ResourceAccount": { Ref: "AWS::AccountId" } } },
      }]);
      const s = statements(prod);
      expect(s.find((x) => x.Sid === "AssumeBedrockBroker")).toEqual({ Sid: "AssumeBedrockBroker", Effect: "Allow", Action: "sts:AssumeRole", Resource: { "Fn::GetAtt": [PINNED.broker, "Arn"] }, Condition: { StringLike: { "sts:RoleSessionName": "org_*" } } });
      expect(s.find((x) => x.Sid === "MakeBedrockExternalIds")).toEqual({ Sid: "MakeBedrockExternalIds", Effect: "Allow", Action: "kms:GenerateMac", Resource: { "Fn::GetAtt": [PINNED.key, "Arn"] } });
      const policy = (externalIdKey(prod)![1].Properties.KeyPolicy as { Statement: Statement[] }).Statement;
      expect(policy[1]).toMatchObject({ Action: "kms:GenerateMac", Condition: { ArnEquals: { "aws:PrincipalArn": { "Fn::GetAtt": [serveRoleId(prod), "Arn"] } } } });
    });

    it("the serving task gets both settings; without product AI production's template has none of it", () => {
      const e = serveEnv(prod);
      expect(e[GATEWAY_ENV.bedrockBrokerRole]).toEqual({ "Fn::GetAtt": [PINNED.broker, "Arn"] });
      expect(e[GATEWAY_ENV.bedrockExternalIdKey]).toEqual({ "Fn::GetAtt": [PINNED.key, "Arn"] });
      expect(broker(prodWithout)).toBeUndefined();
      expect(externalIdKey(prodWithout)).toBeUndefined();
      expect(serveEnv(prodWithout)[GATEWAY_ENV.bedrockBrokerRole]).toBeUndefined();
    });
  });
});
