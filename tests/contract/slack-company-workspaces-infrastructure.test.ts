// L2-2 PR 18a (DEC 254o b): Slack company mode's infrastructure. One stack parameter, SlackCompanyWorkspaces (default disabled), named environments only. Each consumer's
// grant is its own inline policy under the switch's condition, so with the switch off CloudFormation creates none of them (the rest of the template is pinned unchanged by
// named-templates.test.ts through tests/support/slack-company-template.ts). Here every grant is checked in full, plus the boundary and the #126 rule (no ingress State write).
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { defaultBoundaryStatements } from "@agentx/contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";
import { unpackedBrokerVariables } from "../support/broker-environment-template.js";
import { SLACK_COMPANY_POLICIES } from "../support/slack-company-template.js";

skipLambdaBundling();

type Resource = { Type: string; Properties: Record<string, unknown>; Condition?: string };
type Statement = { Sid?: string; Effect: string; Action: string | string[]; Resource: unknown; Condition?: Record<string, unknown> };
type TemplateJson = { Parameters: Record<string, Record<string, unknown>>; Conditions: Record<string, unknown>; Resources: Record<string, Resource> };

const controlPlane = (env: string | undefined): TemplateJson => {
  const app = buildAgentXApp(env === undefined ? {} : { agentxEnv: env });
  const name = env === undefined ? "AgentXControlPlane" : `agentx-${env}-control-plane`;
  return Template.fromStack(app.node.children.find((child): child is Stack => Stack.isStack(child) && child.stackName === name)!).toJSON() as TemplateJson;
};
const byPrefix = (template: TemplateJson, prefix: string, type: string) => {
  const found = Object.entries(template.Resources).filter(([id, resource]) => id.replace(/[0-9A-F]{8}$/u, "") === prefix && resource.Type === type);
  expect(found, prefix).toHaveLength(1);
  return found[0]!;
};
const policy = (template: TemplateJson, consumer: string) => byPrefix(template, `SlackCompanyMode${consumer}`, "AWS::IAM::Policy")[1];
const statementsOf = (resource: Resource) => (resource.Properties.PolicyDocument as { Statement: Statement[] }).Statement;
const roleOf = (resource: Resource) => (resource.Properties.Roles as Array<{ Ref: string }>).map((role) => role.Ref);
const roleOfFunction = (template: TemplateJson, prefix: string) => ((byPrefix(template, prefix, "AWS::Lambda::Function")[1].Properties.Role as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"][0]);
const tableArn = (template: TemplateJson, prefix: string) => ({ "Fn::GetAtt": [byPrefix(template, prefix, "AWS::DynamoDB::Table")[0], "Arn"] });
const variablesOf = (template: TemplateJson, prefix: string) => (byPrefix(template, prefix, "AWS::Lambda::Function")[1].Properties.Environment as { Variables: Record<string, unknown> }).Variables;
const TOKENS: Statement = {
  Sid: "ReadSlackWorkspaceTokens", Effect: "Allow", Action: "secretsmanager:GetSecretValue",
  Resource: { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":secretsmanager:", { Ref: "AWS::Region" }, ":", { Ref: "AWS::AccountId" }, ":secret:agentx/staging/slack-workspaces/*"]] },
};
const reads = (sid: string, resource: unknown, keys: string[]): Statement => ({
  Sid: sid, Effect: "Allow", Action: "dynamodb:GetItem", Resource: resource,
  Condition: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": keys }, Null: { "dynamodb:LeadingKeys": "false" } },
});
const BINDINGS = ["SLACK_TEAM#*", "SLACK_WORKSPACE_BINDING"];

let named: TemplateJson;
let legacy: TemplateJson;
let proofEnv: TemplateJson;
let on: string;
beforeAll(() => {
  named = controlPlane("staging");
  legacy = controlPlane(undefined);
  proofEnv = controlPlane("agentxlivetest123");
  on = Object.keys(named.Conditions).find((id) => id.startsWith("SlackCompanyModeOn"))!;
});

describe("Slack company mode's switch (18a)", () => {
  it("is one default-off parameter whose condition is exactly 'enabled' AND company sign-in on (DEC 254zk)", () => {
    expect(named.Parameters.SlackCompanyWorkspaces).toMatchObject({ Type: "String", Default: "disabled", AllowedValues: ["enabled", "disabled"] });
    const companyOn = Object.keys(named.Conditions).find((id) => id.startsWith("CompanySignInSwitchOn"))!;
    expect(named.Conditions[companyOn]).toStrictEqual({ "Fn::Equals": [{ Ref: "CompanySignIn" }, "enabled"] });
    expect(named.Conditions[on]).toStrictEqual({ "Fn::And": [{ "Fn::Equals": [{ Ref: "SlackCompanyWorkspaces" }, "enabled"] }, { Condition: companyOn }] });
  });

  it("does not exist in the deployment that predates environments", () => {
    expect(JSON.stringify(legacy)).not.toMatch(/SlackCompany|SLACK_COMPANY_WORKSPACES|slack-workspaces/u);
  });

  it("grants only through policies under its condition, one per consumer", () => {
    const added = Object.entries(named.Resources).filter(([id]) => id.startsWith("SlackCompanyMode"));
    expect(added.map(([id]) => id.replace(/^SlackCompanyMode/u, "").replace(/[0-9A-F]{8}$/u, "")).sort()).toEqual([...SLACK_COMPANY_POLICIES].sort());
    for (const [id, resource] of added) {
      expect(resource.Type, id).toBe("AWS::IAM::Policy");
      expect(resource.Condition, id).toBe(on);
    }
    // No other policy anywhere reaches the token family except DeveloperIdentity's Add to Slack grant, now its own policy under company sign-in's condition (DEC 254zg (a)).
    const others = Object.entries(named.Resources).filter(([id, resource]) => !id.startsWith("SlackCompanyMode") && JSON.stringify(resource.Properties).includes("slack-workspaces/"));
    expect(others.map(([id]) => id.replace(/[0-9A-F]{8}$/u, ""))).toEqual(["CompanySignInSwitchSlackWorkspaceTokens"]);
    expect(others[0]![1].Condition).toMatch(/^CompanySignInSwitchOn[0-9A-F]{8}$/u);
  });

  it("gives the Slack Lambda and the channel API reads only: bindings, the company link row, project revisions, memberships and the token", () => {
    const state = tableArn(named, "State");
    const signIn = tableArn(named, "DeveloperSignInTable");
    for (const [consumer, fn] of [["SlackIngress", "SlackIngress"], ["ChannelApi", "ChannelApiIngress"]] as const) {
      const role = roleOfFunction(named, fn);
      expect(roleOf(policy(named, consumer))).toEqual([role]);
      expect(statementsOf(policy(named, consumer))).toStrictEqual([
        TOKENS,
        reads("ReadSlackWorkspaceBindingsAndLinks", state, [...BINDINGS, "ORG#*#CHANNEL_LINK#slack/*"]),
        { Sid: "ReadProjectCompany", Effect: "Allow", Action: "dynamodb:Query", Resource: state,
          Condition: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["PROJECT#*"] }, "ForAllValues:StringEquals": { "dynamodb:Attributes": ["pk", "sk", "companyId"] },
            StringEqualsIfExists: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" }, Null: { "dynamodb:LeadingKeys": "false", "dynamodb:Attributes": "false" } } },
      ]);
      expect(roleOf(policy(named, `${consumer}Members`))).toEqual([role]);
      expect(statementsOf(policy(named, `${consumer}Members`))).toStrictEqual([reads("ReadCompanyMemberships", signIn, ["COMPANY_MEMBER#*"])]);
    }
  });

  it("never lets the Slack Lambda write the State table, switch on or off (#126)", () => {
    const role = roleOfFunction(named, "SlackIngress");
    const stateId = byPrefix(named, "State", "AWS::DynamoDB::Table")[0];
    // Every write action DynamoDB has, matched against each granted pattern (so "dynamodb:Put*", "*Item" or "*" count too), on the State table or on "*".
    const writes = ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:BatchWriteItem", "dynamodb:TransactWriteItems", "dynamodb:PartiQLInsert", "dynamodb:PartiQLUpdate", "dynamodb:PartiQLDelete"];
    const glob = (pattern: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/gu, "\\$&").replaceAll("*", ".*").replaceAll("?", ".")}$`, "iu");
    let checked = 0;
    for (const [id, resource] of Object.entries(named.Resources).filter(([, r]) => r.Type === "AWS::IAM::Policy" && roleOf(r).includes(role))) {
      for (const statement of statementsOf(resource)) {
        if (statement.Effect !== "Allow" || !(JSON.stringify(statement.Resource).includes(stateId) || [statement.Resource].flat().includes("*"))) continue;
        checked += 1;
        expect(writes.filter((write) => [statement.Action].flat().some((pattern) => glob(pattern).test(write))), id).toEqual([]);
      }
    }
    // Positive control: the ingress's State reads were looked at.
    expect(checked).toBeGreaterThan(0);
  });

  it("gives the notifier, DeveloperIdentity, the reconciler and the Slack service exactly their reads", () => {
    const state = tableArn(named, "State");
    expect(roleOf(policy(named, "DeveloperTaskNotifier"))).toEqual([roleOfFunction(named, "DeveloperTaskNotifierFunction")]);
    expect(statementsOf(policy(named, "DeveloperTaskNotifier"))).toStrictEqual([TOKENS, reads("ReadSlackWorkspaceBindings", state, [...BINDINGS, "ORG#org_????????????????????#WORKSPACE#*"])]);
    expect(roleOf(policy(named, "DeveloperIdentity"))).toEqual([roleOfFunction(named, "DeveloperSignInFunction")]);
    expect(statementsOf(policy(named, "DeveloperIdentity"))).toStrictEqual([reads("ReadSlackWorkspaceBindings", state, BINDINGS)]);
    expect(roleOf(policy(named, "SessionReconciler"))).toEqual([roleOfFunction(named, "SessionsReconciler")]);
    expect(statementsOf(policy(named, "SessionReconciler"))).toStrictEqual([TOKENS]);
    expect(roleOf(policy(named, "SlackOrchestrator"))).toEqual([byPrefix(named, "SlackOrchestratorTaskRole", "AWS::IAM::Role")[0]]);
    expect(statementsOf(policy(named, "SlackOrchestrator"))).toStrictEqual([TOKENS, reads("ReadSlackWorkspaceBindings", state, BINDINGS)]);
  });

  it("adds the proof's reads only where the proof is installed, under both conditions", () => {
    const proof = policy(proofEnv, "TaskPersonProof");
    expect(statementsOf(proof)).toStrictEqual([{ ...TOKENS, Resource: JSON.parse(JSON.stringify(TOKENS.Resource).replace("agentx/staging/", "agentx/agentxlivetest123/")) as unknown },
      reads("ReadSlackWorkspaceBindings", tableArn(proofEnv, "State"), BINDINGS)]);
    expect(roleOf(proof)[0]).toMatch(/^TaskPersonProofRole/u);
    const both = proof.Condition!;
    const onHere = Object.keys(proofEnv.Conditions).find((id) => id.startsWith("SlackCompanyModeOn"))!;
    const install = Object.keys(proofEnv.Conditions).find((id) => id.includes("InstallTaskPersonProof"))!;
    expect(proofEnv.Conditions[both]).toStrictEqual({ "Fn::And": [{ Condition: onHere }, { Condition: install }] });
    expect(Object.keys(named.Resources).some((id) => id.startsWith("SlackCompanyModeTaskPersonProof"))).toBe(false);
  });

  it("hands each consumer the switch, 'disabled' (or no table) while it is off", () => {
    const off = (value: unknown) => ({ "Fn::If": [on, value, "disabled"] });
    for (const fn of ["SlackIngress", "ChannelApiIngress", "DeveloperTaskNotifierFunction", "DeveloperSignInFunction", "SessionsReconciler"]) {
      expect(variablesOf(named, fn).SLACK_COMPANY_WORKSPACES, fn).toStrictEqual(off("enabled"));
    }
    expect(variablesOf(named, "DeveloperSignInFunction").STATE_TABLE_NAME).toStrictEqual({ "Fn::If": [on, { Ref: byPrefix(named, "State", "AWS::DynamoDB::Table")[0] }, ""] });
    // 18d: the environment's name for the channel API, notifier and reconciler factories, "" while off.
    for (const fn of ["DeveloperTaskNotifierFunction", "SessionsReconciler"]) expect(variablesOf(named, fn).AGENTX_ENV, fn).toStrictEqual({ "Fn::If": [on, "staging", ""] });
    // DEC 254zk: the channel API's factory needs the environment's name too.
    expect(variablesOf(named, "ChannelApiIngress").AGENTX_ENV).toStrictEqual({ "Fn::If": [on, "staging", ""] });
    // 18d, DEC 254zk: the Slack service's table and team are always output (its switch is the slack stack's own, set by agentx config set slack.companyWorkspaces).
    const outputs = (named as unknown as { Outputs: Record<string, { Value: unknown; Condition?: string }> }).Outputs;
    expect(outputs).not.toHaveProperty("SlackCompanyWorkspacesState");
    expect(outputs.SlackCompanyStateTableName).toStrictEqual({ Value: { Ref: byPrefix(named, "State", "AWS::DynamoDB::Table")[0] } });
    expect(outputs.SlackCompanyTeamId).toStrictEqual({ Value: { Ref: "SlackTeamId" } });
    // 18c: the Slack Lambda's factory inputs, "" while off.
    expect(variablesOf(named, "SlackIngress").AGENTX_ENV).toStrictEqual({ "Fn::If": [on, "staging", ""] });
    expect(variablesOf(named, "SlackIngress").SLACK_TEAM_ID).toStrictEqual({ "Fn::If": [on, { Ref: "SlackTeamId" }, ""] });
    for (const fn of ["SlackIngress", "ChannelApiIngress"]) {
      expect(variablesOf(named, fn).DEVELOPER_SIGNIN_TABLE_NAME, fn).toStrictEqual({ "Fn::If": [on, { Ref: byPrefix(named, "DeveloperSignInTable", "AWS::DynamoDB::Table")[0] }, ""] });
    }
    const broker = unpackedBrokerVariables(variablesOf(named, "Broker"));
    // DEC 254zk: the conditioned switch flag ("1" only with company sign-in on too).
    expect(broker.SLACK_COMPANY_WORKSPACES).toEqual({ "Fn::If": [on, "1", "0"] });
    // Derived now (room in the 4 KB environment); the broker still reads "enabled".
    expect(broker.COMPANY_READS).toBe("enabled");
    expect(variablesOf(named, "Broker")).not.toHaveProperty("COMPANY_READS");
  });

  it("needs no new broker grant: its State read/write already covers the T4B index Query and the binding transaction", () => {
    const brokerRole = roleOfFunction(named, "Broker");
    const stateId = byPrefix(named, "State", "AWS::DynamoDB::Table")[0];
    const actions = Object.values(named.Resources).filter((r) => r.Type === "AWS::IAM::Policy" && roleOf(r).includes(brokerRole))
      .flatMap(statementsOf).filter((s) => s.Effect === "Allow" && s.Condition === undefined && JSON.stringify(s.Resource).includes(stateId)).flatMap((s) => [s.Action].flat());
    for (const action of ["dynamodb:Query", "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:ConditionCheckItem"]) expect(actions, action).toContain(action);
    expect(Object.values(named.Resources).some((r) => r.Type === "AWS::IAM::Policy" && r.Condition === on && roleOf(r).includes(brokerRole))).toBe(false);
  });

  it("stays inside the default permissions boundary (allowed service, no Deny matches)", () => {
    const boundary = defaultBoundaryStatements({ env: "staging", partition: "aws", region: "us-east-1", account: "111122223333", cloudFormationRoleName: "agentx-staging-cloudformation" });
    const matches = (pattern: string, action: string) => new RegExp(`^${pattern.replaceAll("*", ".*")}$`, "i").test(action);
    for (const action of ["secretsmanager:GetSecretValue", "dynamodb:GetItem", "dynamodb:Query"]) {
      const applicable = boundary.filter((s) => [s.Action].flat().some((pattern) => matches(pattern, action)));
      expect(applicable.some((s) => s.Effect === "Allow" && s.Resource === "*" && s.Condition === undefined), action).toBe(true);
      expect(applicable.filter((s) => s.Effect === "Deny"), action).toEqual([]);
    }
  });
});
