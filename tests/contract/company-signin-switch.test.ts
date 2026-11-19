// DEC 254zg (a), 254zc (6): Code's company layer is ONE stack parameter, CompanySignIn (default disabled). Every function that reads COMPANY_SIGNIN gets it from that switch's
// condition, the slack-workspaces grant (#865) exists only while it is on, and self-serve create (CompanySelfServe, default disabled) needs both switches. These tests evaluate the
// synthesized templates under each parameter value, as CloudFormation would (conditions, Fn::If), so "off" means the deployed resources hold no grant and every variable is off.
import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { environmentNaming } from "../../infra/lib/naming.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";
import { unpackedBrokerVariables } from "../support/broker-environment-template.js";

skipLambdaBundling();

type Resource = { Type: string; Condition?: string; Properties: Record<string, unknown> };
type TemplateJson = { Parameters: Record<string, Record<string, unknown>>; Conditions?: Record<string, unknown>; Resources: Record<string, Resource>; Outputs?: Record<string, { Condition?: string }> };
type Statement = { Effect?: string; Sid?: string; Action: string | string[]; Resource?: unknown; Condition?: unknown };

const stacksOf = (app: App) => app.node.children.filter((child): child is Stack => Stack.isStack(child));
const synth = (app: App, name: string): TemplateJson => {
  const stack = stacksOf(app).find((candidate) => candidate.stackName === name);
  if (stack === undefined) throw new Error(`no stack ${name}`);
  return Template.fromStack(stack).toJSON() as TemplateJson;
};

/** CloudFormation's view of a template under the given parameter values: conditions evaluated, resources whose condition is false dropped, Fn::If chosen. */
function deployed(template: TemplateJson, values: Record<string, string>): TemplateJson {
  const parameter = (name: string): string => { const fallback = template.Parameters[name]?.Default; return values[name] ?? (typeof fallback === "string" ? fallback : `\u0000${name}`); };
  const memo = new Map<string, boolean>();
  const value = (node: unknown): unknown => {
    if (node !== null && typeof node === "object" && !Array.isArray(node)) {
      const record = node as Record<string, unknown>;
      if (typeof record.Ref === "string" && record.Ref in template.Parameters) return parameter(record.Ref);
      // The approved account is the one the template's own install condition names (task-person-proof.ts), never written here.
      if (record.Ref === "AWS::AccountId") return values["AWS::AccountId"] ?? approvedAccount(template);
      if (record.Ref === "AWS::Region") return values["AWS::Region"] ?? "us-east-1";
    }
    return node;
  };
  const truth = (node: unknown): boolean => {
    const record = node as Record<string, unknown[]> & { Condition?: string };
    if (typeof record.Condition === "string") return condition(record.Condition);
    if (record["Fn::Equals"] !== undefined) return JSON.stringify(value(record["Fn::Equals"][0])) === JSON.stringify(value(record["Fn::Equals"][1]));
    if (record["Fn::And"] !== undefined) return record["Fn::And"].every(truth);
    if (record["Fn::Or"] !== undefined) return record["Fn::Or"].some(truth);
    if (record["Fn::Not"] !== undefined) return !truth(record["Fn::Not"][0]);
    throw new Error(`unknown condition ${JSON.stringify(node)}`);
  };
  const condition = (name: string): boolean => {
    if (!memo.has(name)) memo.set(name, truth(template.Conditions?.[name]));
    return memo.get(name)!;
  };
  const resolve = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(resolve);
    if (node === null || typeof node !== "object") return node;
    const record = node as Record<string, unknown>;
    const choice = record["Fn::If"] as [string, unknown, unknown] | undefined;
    if (choice !== undefined) return resolve(condition(choice[0]) ? choice[1] : choice[2]);
    if (typeof record.Ref === "string" && record.Ref in template.Parameters) return parameter(record.Ref);
    return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, resolve(child)]));
  };
  const resources = Object.fromEntries(Object.entries(template.Resources)
    .filter(([, resource]) => resource.Condition === undefined || condition(resource.Condition))
    .map(([id, resource]) => [id, resolve(resource) as Resource]));
  const outputs = Object.fromEntries(Object.entries(template.Outputs ?? {}).filter(([, output]) => output.Condition === undefined || condition(output.Condition)));
  return { ...template, Resources: resources, Outputs: outputs };
}

/** The account the proof's install condition compares AWS::AccountId with (empty when the template has none). */
function approvedAccount(template: TemplateJson): string {
  for (const expression of Object.values(template.Conditions ?? {})) {
    const found = /\{"Fn::Equals":\[\{"Ref":"AWS::AccountId"\},"([0-9]{12})"\]\}/u.exec(JSON.stringify(expression));
    if (found !== null) return found[1]!;
  }
  return "";
}

const ids = (template: TemplateJson, prefix: string, type = "AWS::Lambda::Function") =>
  Object.keys(template.Resources).filter((id) => id.startsWith(prefix) && template.Resources[id]!.Type === type);
const onlyId = (template: TemplateJson, prefix: string, type?: string): string => {
  const found = ids(template, prefix, type);
  if (found.length !== 1) throw new Error(`expected one ${prefix}, found ${found.join(", ")}`);
  return found[0]!;
};
const variablesOf = (template: TemplateJson, id: string): Record<string, unknown> =>
  // Batch 13: #863 (batch 12) keeps the broker's names in their SSM parameter, so the template is passed to unpack them.
  unpackedBrokerVariables(((template.Resources[id]!.Properties.Environment as { Variables?: Record<string, unknown> } | undefined)?.Variables) ?? {}, template);

/** Every statement of every IAM policy in the template (policy resources, managed policies and roles' inline policies), with its resource's logical ID. */
function statements(template: TemplateJson): Array<{ policy: string; statement: Statement }> {
  return Object.entries(template.Resources).flatMap(([policy, resource]) => {
    const documents = resource.Type === "AWS::IAM::Policy" || resource.Type === "AWS::IAM::ManagedPolicy" ? [resource.Properties.PolicyDocument]
      : resource.Type === "AWS::IAM::Role" ? ((resource.Properties.Policies as Array<{ PolicyDocument: unknown }> | undefined) ?? []).map((inline) => inline.PolicyDocument) : [];
    return documents.flatMap((document) => (document as { Statement: Statement[] }).Statement.map((statement) => ({ policy, statement })));
  });
}
/** Any statement at all that names the per-company token family. */
const namesSlackWorkspaces = (template: TemplateJson) => statements(template).filter(({ statement }) => JSON.stringify(statement.Resource).includes(SLACK_WORKSPACES));
const SLACK_WORKSPACES = "slack-workspaces/*";
const grantsSlackWorkspaceWrite = (template: TemplateJson) => statements(template).filter(({ statement }) =>
  [statement.Action].flat().includes("secretsmanager:CreateSecret") && JSON.stringify(statement.Resource).includes(SLACK_WORKSPACES));

/** The functions that read COMPANY_SIGNIN in a named control plane (construct-path prefixes of their logical IDs). */
const READERS = ["Broker", "DeveloperSignInFunction", "SlackIngress", "ChannelApiIngress", "DeveloperTaskNotifierFunction", "SessionsReconciler"];

let staging: TemplateJson;
let stagingSlack: TemplateJson;
let legacy: TemplateJson;
let legacySlack: TemplateJson;
let proof: TemplateJson;

beforeAll(() => {
  const app = buildAgentXApp({ agentxEnv: "staging" });
  staging = synth(app, "agentx-staging-control-plane");
  stagingSlack = synth(app, "agentx-staging-slack");
  const legacyApp = buildAgentXApp();
  legacy = synth(legacyApp, "AgentXControlPlane");
  legacySlack = synth(legacyApp, "AgentXSlackOrchestrator");
  proof = Template.fromStack(new ControlPlaneStack(new App(), "Proof", { env: { region: "us-east-1" }, naming: environmentNaming("agentxlivetest123") })).toJSON() as TemplateJson;
}, 300_000);

describe("CompanySignIn and CompanySelfServe: the parameters", () => {
  it("are declared once each on the named control plane, enabled or disabled, disabled by default", () => {
    for (const name of ["CompanySignIn", "CompanySelfServe"]) {
      expect(staging.Parameters[name]).toMatchObject({ Type: "String", Default: "disabled", AllowedValues: ["enabled", "disabled"] });
    }
    expect(stagingSlack.Parameters.CompanySignIn).toMatchObject({ Type: "String", Default: "disabled", AllowedValues: ["enabled", "disabled"] });
  });

  // #1129: the legacy deployment (production) has the company layer too, off by default, so production can make invite codes once an operator switches it on.
  it("are declared on the legacy control plane too, disabled by default, with every company-only grant under the switch and every reader off", () => {
    for (const name of ["CompanySignIn", "CompanySelfServe"]) {
      expect(legacy.Parameters[name]).toMatchObject({ Type: "String", Default: "disabled", AllowedValues: ["enabled", "disabled"] });
    }
    // No name built from a missing environment name.
    expect(JSON.stringify(legacy)).not.toMatch(/agentx\/undefined|undefined\//u);
    const legacyReaders = ["Broker", "DeveloperSignInFunction", "SlackIngress", "ChannelApiIngress", "DeveloperTaskNotifierFunction", "SessionsReconciler"];
    const off = deployed(legacy, {});
    for (const reader of legacyReaders) expect(variablesOf(off, onlyId(off, reader)).COMPANY_SIGNIN, reader).toBe("disabled");
    expect(variablesOf(off, onlyId(off, "DeveloperSignInFunction")).COMPANY_SELF_SERVE).toBe("disabled");
    // Off: no company sign-in policy is deployed, and nothing names the per-company Slack token family.
    expect(Object.values(off.Resources).filter((resource) => resource.Type === "AWS::IAM::Policy" && JSON.stringify(resource.Properties.PolicyName ?? "").includes("company-signin-"))).toEqual([]);
    expect(namesSlackWorkspaces(off)).toEqual([]);
    // Every company sign-in policy carries the switch's condition.
    const companyPolicies = Object.entries(legacy.Resources).filter(([, resource]) => JSON.stringify(resource.Properties.PolicyName ?? "").includes("company-signin-"));
    expect(companyPolicies.map(([id]) => id.replace(/[0-9A-F]{8}$/u, "")).sort()).toEqual(["CompanySignInSwitchBrokerCompanyMemberships", "CompanySignInSwitchSignInCompanyGrants", "CompanySignInSwitchSlackWorkspaceTokens"]);
    const companyOn = Object.keys(legacy.Conditions ?? {}).find((id) => id.startsWith("CompanySignInSwitchOn"))!;
    for (const [, resource] of companyPolicies) expect(resource.Condition).toBe(companyOn);
    const on = deployed(legacy, { CompanySignIn: "enabled" });
    for (const reader of legacyReaders) expect(variablesOf(on, onlyId(on, reader)).COMPANY_SIGNIN, reader).toBe("enabled");
    expect(variablesOf(on, onlyId(on, "DeveloperSignInFunction")).COMPANY_SELF_SERVE).toBe("disabled");
    expect(grantsSlackWorkspaceWrite(on).map(({ statement }) => JSON.stringify(statement.Resource))).toEqual([expect.stringContaining("secret:agentx/production/slack-workspaces/*")]);
    expect(variablesOf(deployed(legacy, { CompanySignIn: "enabled", CompanySelfServe: "enabled" }), onlyId(on, "DeveloperSignInFunction")).COMPANY_SELF_SERVE).toBe("enabled");
    // Slack company mode stays named-only: the legacy Slack stack has no copy of the switch.
    expect(Object.keys(legacySlack.Parameters)).not.toContain("CompanySignIn");
    expect(JSON.stringify(legacySlack)).not.toMatch(/COMPANY_SIGNIN|COMPANY_SELF_SERVE|company-signin-/u);
  });

  it("drive two conditions: on exactly when CompanySignIn is enabled, and self-serve only with both", () => {
    const conditions = Object.entries(staging.Conditions ?? {});
    const on = conditions.filter(([, expression]) => JSON.stringify(expression) === JSON.stringify({ "Fn::Equals": [{ Ref: "CompanySignIn" }, "enabled"] }));
    expect(on).toHaveLength(1);
    const selfServe = conditions.filter(([, expression]) => JSON.stringify(expression).includes("CompanySelfServe"));
    expect(selfServe).toHaveLength(1);
    expect(selfServe[0]![1]).toEqual({ "Fn::And": [{ Condition: on[0]![0] }, { "Fn::Equals": [{ Ref: "CompanySelfServe" }, "enabled"] }] });
  });
});

describe("company sign-in disabled (the default)", () => {
  it("deploys no slack-workspaces grant on any role, and no company-signin policy at all", () => {
    for (const values of [{}, { CompanySignIn: "disabled" }, { CompanySignIn: "disabled", CompanySelfServe: "enabled" }]) {
      const off = deployed(staging, values);
      expect(grantsSlackWorkspaceWrite(off)).toEqual([]);
      // No statement anywhere (any action, any policy kind) names the per-company token family while company sign-in is off.
      expect(namesSlackWorkspaces(off)).toEqual([]);
      expect(Object.values(off.Resources).filter((resource) => resource.Type === "AWS::IAM::Policy" && String(resource.Properties.PolicyName).startsWith("company-signin-"))).toEqual([]);
    }
  });

  it("gives every reader COMPANY_SIGNIN=disabled, and the sign-in function COMPANY_SELF_SERVE=disabled", () => {
    const off = deployed(staging, {});
    for (const reader of READERS) expect(variablesOf(off, onlyId(off, reader)).COMPANY_SIGNIN, reader).toBe("disabled");
    expect(variablesOf(off, onlyId(off, "DeveloperSignInFunction")).COMPANY_SELF_SERVE).toBe("disabled");
    expect(deployed(stagingSlack, {}).Resources[onlyId(stagingSlack, "", "AWS::ECS::TaskDefinition")]).toBeDefined();
    expect(containerVariables(deployed(stagingSlack, {})).COMPANY_SIGNIN).toBe("disabled");
  });
});

describe("company sign-in enabled", () => {
  it("deploys exactly one slack-workspaces grant: the sign-in function's Create/Put/GetSecretValue on agentx/staging/slack-workspaces/*", () => {
    const on = deployed(staging, { CompanySignIn: "enabled" });
    const found = grantsSlackWorkspaceWrite(on);
    expect(found).toHaveLength(1);
    const policy = on.Resources[found[0]!.policy]!;
    expect(policy.Properties.PolicyName).toBe("company-signin-slackworkspacetokens");
    expect(policy.Properties.Roles).toEqual([{ Ref: onlyId(staging, "DeveloperSignInFunctionServiceRole", "AWS::IAM::Role") }]);
    expect((policy.Properties.PolicyDocument as { Statement: Statement[] }).Statement).toEqual([{
      Sid: "WriteSlackWorkspaceTokens", Effect: "Allow",
      Action: ["secretsmanager:CreateSecret", "secretsmanager:PutSecretValue", "secretsmanager:GetSecretValue"],
      Resource: { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":secretsmanager:", { Ref: "AWS::Region" }, ":", { Ref: "AWS::AccountId" }, ":secret:agentx/staging/slack-workspaces/*"]] },
    }]);
    // The grant is the company layer's own policy, under its condition: never in a role's default policy.
    expect(staging.Resources[found[0]!.policy]!.Condition).toBe(Object.entries(staging.Conditions ?? {}).find(([, expression]) => JSON.stringify(expression) === JSON.stringify({ "Fn::Equals": [{ Ref: "CompanySignIn" }, "enabled"] }))![0]);
  });

  it("gives every reader COMPANY_SIGNIN=enabled, the Slack service too once its stack takes the value", () => {
    const on = deployed(staging, { CompanySignIn: "enabled" });
    for (const reader of READERS) expect(variablesOf(on, onlyId(on, reader)).COMPANY_SIGNIN, reader).toBe("enabled");
    expect(containerVariables(deployed(stagingSlack, { CompanySignIn: "enabled" })).COMPANY_SIGNIN).toBe("enabled");
  });

  it("keeps self-serve off unless CompanySelfServe is enabled too", () => {
    const selfServe = (values: Record<string, string>) => variablesOf(deployed(staging, values), onlyId(staging, "DeveloperSignInFunction")).COMPANY_SELF_SERVE;
    expect(selfServe({ CompanySignIn: "enabled" })).toBe("disabled");
    expect(selfServe({ CompanySignIn: "enabled", CompanySelfServe: "disabled" })).toBe("disabled");
    expect(selfServe({ CompanySignIn: "disabled", CompanySelfServe: "enabled" })).toBe("disabled");
    expect(selfServe({ CompanySignIn: "enabled", CompanySelfServe: "enabled" })).toBe("enabled");
  });
});

describe("per-company Slack bots (SlackCompanyWorkspaces, DEC 254zk) need company sign-in too", () => {
  const slackPolicies = (template: TemplateJson) => Object.values(template.Resources).filter((resource) => resource.Type === "AWS::IAM::Policy" && String(resource.Properties.PolicyName).startsWith("slack-company-workspaces-"));
  const SLACK_READERS = ["Broker", "SlackIngress", "ChannelApiIngress", "DeveloperTaskNotifierFunction", "SessionsReconciler", "DeveloperSignInFunction"];

  it("its condition is SlackCompanyWorkspaces enabled AND company sign-in on", () => {
    const on = Object.entries(staging.Conditions ?? {}).find(([, expression]) => JSON.stringify(expression) === JSON.stringify({ "Fn::Equals": [{ Ref: "CompanySignIn" }, "enabled"] }))![0];
    const slack = Object.entries(staging.Conditions ?? {}).filter(([, expression]) => JSON.stringify(expression).includes("SlackCompanyWorkspaces"));
    expect(slack).toHaveLength(1);
    expect(slack[0]![1]).toEqual({ "Fn::And": [{ "Fn::Equals": [{ Ref: "SlackCompanyWorkspaces" }, "enabled"] }, { Condition: on }] });
  });

  it.each([[{}], [{ SlackCompanyWorkspaces: "enabled" }], [{ CompanySignIn: "enabled" }]])("%j: no Slack company grant, and SLACK_COMPANY_WORKSPACES=disabled everywhere", (values) => {
    const off = deployed(staging, values);
    expect(slackPolicies(off)).toEqual([]);
    for (const reader of SLACK_READERS) expect(variablesOf(off, onlyId(off, reader)).SLACK_COMPANY_WORKSPACES, reader).toBe("disabled");
  });

  it("both on: every Slack consumer has both switches enabled and what its company factory needs (table, environment, install team), and its own grant", () => {
    const values = { CompanySignIn: "enabled", SlackCompanyWorkspaces: "enabled", SlackTeamId: "T0INSTALL0" };
    const on = deployed(staging, values);
    for (const reader of ["SlackIngress", "ChannelApiIngress", "DeveloperTaskNotifierFunction", "SessionsReconciler", "DeveloperSignInFunction"]) {
      const variables = variablesOf(on, onlyId(on, reader));
      expect(variables, reader).toMatchObject({ SLACK_COMPANY_WORKSPACES: "enabled", COMPANY_SIGNIN: "enabled", AGENTX_ENV: "staging" });
      expect(variables.STATE_TABLE_NAME, reader).toEqual({ Ref: onlyId(staging, "State", "AWS::DynamoDB::Table") });
      expect(variables.SLACK_TEAM_ID ?? variables.SLACK_ADAPTER_TEAM_ID, reader).toBe("T0INSTALL0");
    }
    expect(variablesOf(on, onlyId(on, "Broker"))).toMatchObject({ SLACK_COMPANY_WORKSPACES: "enabled", COMPANY_SIGNIN: "enabled" });
    // DEC 254zzz32/35: the broker's (company token family and the install's Slack secret, read-only).
    expect(slackPolicies(on).map((policy) => policy.Properties.PolicyName).sort()).toEqual([
      "slack-company-workspaces-broker", "slack-company-workspaces-channelapi", "slack-company-workspaces-channelapimembers", "slack-company-workspaces-developeridentity", "slack-company-workspaces-developertasknotifier",
      "slack-company-workspaces-sessionreconciler", "slack-company-workspaces-slackingress", "slack-company-workspaces-slackingressmembers", "slack-company-workspaces-slackorchestrator",
    ]);
    // The Slack service's inputs are output whatever the switches, so config set can turn the service on without an upgrade.
    for (const template of [on, deployed(staging, {})]) expect(Object.keys(template.Outputs ?? {})).toEqual(expect.arrayContaining(["SlackCompanyStateTableName", "SlackCompanyTeamId"]));
    expect(Object.keys(staging.Outputs ?? {})).not.toContain("SlackCompanyWorkspacesState");
  });

  it("the Slack service gets both switches and its inputs from its own stack's parameters", () => {
    const variables = containerVariables(deployed(stagingSlack, { CompanySignIn: "enabled", SlackCompanyWorkspacesState: "enabled", SlackCompanyStateTableName: "agentx-staging-state", SlackCompanyTeamId: "T0INSTALL0" }));
    expect(variables).toMatchObject({ COMPANY_SIGNIN: "enabled", SLACK_COMPANY_WORKSPACES: "enabled", STATE_TABLE_NAME: "agentx-staging-state", SLACK_TEAM_ID: "T0INSTALL0", AGENTX_ENV: "staging" });
  });
});

describe("TaskPersonProof (DEC 254zc (6))", () => {
  it("gets COMPANY_SIGNIN, SLACK_COMPANY_WORKSPACES and the State table from the same switches, so its pinned version follows them", () => {
    const fn = onlyId(proof, "TaskPersonProofFunction");
    const values = { TaskPersonProofEnabled: "true" };
    expect(variablesOf(deployed(proof, values), fn)).toMatchObject({ COMPANY_SIGNIN: "disabled", SLACK_COMPANY_WORKSPACES: "disabled", STATE_TABLE_NAME: "" });
    expect(variablesOf(deployed(proof, { ...values, CompanySignIn: "enabled" }), fn)).toMatchObject({ COMPANY_SIGNIN: "enabled", SLACK_COMPANY_WORKSPACES: "disabled", STATE_TABLE_NAME: "" });
    expect(variablesOf(deployed(proof, { ...values, CompanySignIn: "enabled", SlackCompanyWorkspaces: "enabled" }), fn)).toMatchObject({
      COMPANY_SIGNIN: "enabled", SLACK_COMPANY_WORKSPACES: "enabled", STATE_TABLE_NAME: { Ref: onlyId(proof, "State", "AWS::DynamoDB::Table") } });
    const policy = (template: TemplateJson) => Object.values(template.Resources).filter((resource) => resource.Properties?.PolicyName === "slack-company-workspaces-taskpersonproof");
    expect(policy(deployed(proof, { ...values, SlackCompanyWorkspaces: "enabled" }))).toEqual([]);
    expect(policy(deployed(proof, { ...values, CompanySignIn: "enabled", SlackCompanyWorkspaces: "enabled" }))).toHaveLength(1);
  });
});

function containerVariables(template: TemplateJson): Record<string, unknown> {
  const definition = template.Resources[onlyId(template, "", "AWS::ECS::TaskDefinition")]!;
  const [container] = definition.Properties.ContainerDefinitions as Array<{ Environment: Array<{ Name: string; Value: unknown }> }>;
  return Object.fromEntries(container!.Environment.map((entry) => [entry.Name, entry.Value]));
}
