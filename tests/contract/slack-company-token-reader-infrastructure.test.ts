// R5 step 1 (DEC 254zzz444): the role the hosted Slack service assumes, tagged with ONE company, to read that company's Slack bot token (infra/lib/slack-company-token-reader.ts).
// Checked in full on both deployments: the role and its policy exist only under the Slack company switch's condition; the trust names the orchestrator, exactly the one company tag and no transitive tag keys; the
// policy's only grant is GetSecretValue on the session's OWN company path (evaluated here with IAM's policy-variable and glob semantics: company A reads A's token and is denied B's); the orchestrator
// keeps its family-wide read for this release (additive) and nothing else gains a path; the container gets the role's ARN and the release-1 fallback.
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { SLACK_COMPANY_TOKEN_FALLBACK_VARIABLE, SLACK_COMPANY_TOKEN_ROLE_VARIABLE, defaultBoundaryStatements, slackTokenReaderBoundaryStatement, slackTokenReaderLookupResource, slackTokenReaderRoleArn, slackTokenReaderRoleName } from "@agentx/contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Statement = { Sid?: string; Effect: string; Action: string | string[]; Resource: unknown; Condition?: unknown; Principal?: unknown };
type Resource = { Type: string; Properties: Record<string, unknown> & { RoleName?: string; Path?: string; Roles?: unknown; AssumeRolePolicyDocument?: { Statement: Statement[] }; PolicyDocument?: { Statement: Statement[] } }; Condition?: string };
type TemplateJson = { Conditions: Record<string, unknown>; Resources: Record<string, Resource> };
const A = "org_aaaaaaaaaaaaaaaaaaaa", B = "org_bbbbbbbbbbbbbbbbbbbb";

const stackJson = (env: string | undefined, part: "control-plane" | "slack"): TemplateJson => {
  const app = buildAgentXApp(env === undefined ? {} : { agentxEnv: env });
  const name = env === undefined ? (part === "slack" ? "AgentXSlackOrchestrator" : "AgentXControlPlane") : `agentx-${env}-${part}`;
  return Template.fromStack(app.node.children.find((child): child is Stack => Stack.isStack(child) && child.stackName === name)!).toJSON() as TemplateJson;
};
const only = (template: TemplateJson, pattern: RegExp, type: string) => {
  const found = Object.entries(template.Resources).filter(([id, resource]) => pattern.test(id) && resource.Type === type);
  expect(found, String(pattern)).toHaveLength(1);
  return found[0]!;
};
const flatten = (value: unknown): string => typeof value === "string" ? value : (value as { "Fn::Join": [string, unknown[]] })["Fn::Join"][1].map((part) => typeof part === "string" ? part : "<token>").join("");
/** IAM's matching of a policy variable and the `*` glob in an ARN pattern, with the session's tag substituted: whether the secret ARN is covered. */
const covers = (pattern: string, tags: Record<string, string>, secretName: string): boolean => {
  const resolved = pattern.replace(/\$\{aws:PrincipalTag\/([^}]+)\}/gu, (_all, key: string) => tags[key] ?? "\u0000");
  // The ARN's account and region are tokens in the template; the secret name is what the pattern fences.
  const name = resolved.slice(resolved.indexOf(":secret:") + ":secret:".length);
  return new RegExp(`^${name.replace(/[.+^$()|[\]\\{}]/gu, "\\$&").replace(/\*/gu, ".*")}$`, "u").test(secretName);
};

let named: TemplateJson, legacy: TemplateJson, namedSlack: TemplateJson, legacySlack: TemplateJson;
beforeAll(() => {
  named = stackJson("staging", "control-plane");
  legacy = stackJson(undefined, "control-plane");
  namedSlack = stackJson("staging", "slack");
  legacySlack = stackJson(undefined, "slack");
}, 240_000);

describe.each([["staging", () => named, "agentx-staging-slk", "staging"], ["production (legacy)", () => legacy, "agentx-production-slk", "production"]] as const)("the Slack token reader role in %s", (label, template, roleName, env) => {
  it("exists only under the Slack company switch's condition, as one role and one policy, with its fixed name", () => {
    const t = template();
    const [roleId, role] = only(t, /^SlackCompanyTokenReaderRole[0-9A-F]{8}$/u, "AWS::IAM::Role");
    const [, policy] = only(t, /^SlackCompanyModeSlackTokenReader[0-9A-F]{8}$/u, "AWS::IAM::Policy");
    const on = Object.keys(t.Conditions).find((id) => id.startsWith("SlackCompanyModeOn"))!;
    expect([role.Condition, policy.Condition]).toEqual([on, on]);
    expect(role.Properties.RoleName).toBe(roleName);
    expect(policy.Properties.Roles).toEqual([{ Ref: roleId }]);
    // Named: under the environment's path and the boundary (the aspects); the legacy deployment has neither.
    if (label === "staging") expect(role.Properties.Path).toBe("/agentx/staging/"); else expect(role.Properties.Path).toBeUndefined();
  });

  it("trusts only the orchestrator's task role, only with exactly the one company tag and no transitive tag keys (sts:AssumeRole and sts:TagSession together)", () => {
    const t = template();
    const [, role] = only(t, /^SlackCompanyTokenReaderRole[0-9A-F]{8}$/u, "AWS::IAM::Role");
    const orchestrator = only(t, /^SlackOrchestratorTaskRole[0-9A-F]{8}$/u, "AWS::IAM::Role")[0];
    expect(role.Properties.AssumeRolePolicyDocument?.Statement).toStrictEqual([{
      Effect: "Allow", Action: ["sts:AssumeRole", "sts:TagSession"], Principal: { AWS: { "Fn::GetAtt": [orchestrator, "Arn"] } },
      Condition: {
        // No transitive tag keys may be requested (sts:TransitiveTagKeys absent), so the company tag cannot travel into a role chain.
        Null: { "aws:RequestTag/rovara:org": "false", "aws:TagKeys": "false", "sts:TransitiveTagKeys": "true" },
        "ForAllValues:StringEquals": { "aws:TagKeys": ["rovara:org"] },
        StringLike: { "aws:RequestTag/rovara:org": "org_????????????????????" },
      },
    }]);
    // No other role's trust names the reader role's principal path: the trust is the orchestrator's alone (no account root, no wildcard).
    expect(JSON.stringify(role.Properties.AssumeRolePolicyDocument)).not.toMatch(/root|"\*"/u);
  });

  it("grants GetSecretValue on the session's own company path only, with the Null guard, and nothing else", () => {
    const [, policy] = only(template(), /^SlackCompanyModeSlackTokenReader[0-9A-F]{8}$/u, "AWS::IAM::Policy");
    const statements = policy.Properties.PolicyDocument!.Statement;
    expect(statements).toHaveLength(1);
    const [statement] = statements;
    expect(statement).toMatchObject({ Sid: "ReadOwnCompanySlackToken", Effect: "Allow", Action: "secretsmanager:GetSecretValue", Condition: { Null: { "aws:PrincipalTag/rovara:org": "false" } } });
    const pattern = flatten(statement!.Resource);
    expect(pattern).toMatch(new RegExp(`:secret:agentx/${env}/slack-workspaces/\\$\\{aws:PrincipalTag/rovara:org\\}/\\*$`, "u"));
    // IAM semantics: a session tagged A reads A's tokens (any team) and is denied B's, the whole family, the install's own app secret and the other families.
    expect(covers(pattern, { "rovara:org": A }, `agentx/${env}/slack-workspaces/${A}/T0AAAAAAA`)).toBe(true);
    expect(covers(pattern, { "rovara:org": A }, `agentx/${env}/slack-workspaces/${B}/T0AAAAAAA`)).toBe(false);
    expect(covers(pattern, { "rovara:org": B }, `agentx/${env}/slack-workspaces/${B}/T0BBBBBBB`)).toBe(true);
    expect(covers(pattern, { "rovara:org": B }, `agentx/${env}/slack-workspaces/${A}/T0BBBBBBB`)).toBe(false);
    for (const other of [`agentx/${env}/slack`, `agentx/${env}/org-connectors/${A}/x`, `agentx/${env}/slack-workspaces/`, `agentx/other/slack-workspaces/${A}/T0AAAAAAA`]) expect(covers(pattern, { "rovara:org": A }, other), other).toBe(false);
    // No tag: the variable resolves to nothing that matches a company path (and the Null guard denies it anyway).
    expect(covers(pattern, {}, `agentx/${env}/slack-workspaces/${A}/T0AAAAAAA`)).toBe(false);
  });

  it("is additive: the orchestrator keeps its family-wide read, gains no policy statement of its own for the assume, and no other grant names the reader role", () => {
    const t = template();
    const [, orchestratorPolicy] = only(t, /^SlackCompanyModeSlackOrchestrator[0-9A-F]{8}$/u, "AWS::IAM::Policy");
    expect(orchestratorPolicy.Properties.PolicyDocument!.Statement.map((statement) => statement.Sid)).toEqual(["ReadSlackWorkspaceTokens", "ReadSlackWorkspaceBindings"]);
    const [roleId] = only(t, /^SlackCompanyTokenReaderRole[0-9A-F]{8}$/u, "AWS::IAM::Role");
    const naming = roleName;
    for (const [id, resource] of Object.entries(t.Resources)) {
      if (id === roleId || resource.Type === "AWS::IAM::Role" && id.startsWith("SlackCompanyTokenReader")) continue;
      const text = JSON.stringify(resource.Properties ?? {});
      // Only the Role resource above, its own policy and the broker's name registry could mention it; nothing grants sts:AssumeRole on it.
      expect(text.includes(naming) && /sts:AssumeRole/u.test(text), id).toBe(false);
    }
    expect(JSON.stringify(t)).not.toContain("sts:AssumeRole\"],\"Effect\":\"Allow\",\"Resource\":\"*\"");
  });
});

describe("the Slack container", () => {
  const container = (template: TemplateJson) => {
    const tasks = Object.values(template.Resources).filter((resource) => resource.Type === "AWS::ECS::TaskDefinition");
    expect(tasks).toHaveLength(1);
    return (tasks[0]!.Properties.ContainerDefinitions as Array<{ Environment: Array<{ Name: string; Value: unknown }> }>)[0]!.Environment;
  };
  it("gets the reader role's ARN, built from the environment alone (the path for a named environment, none for the legacy one), and the release-1 fallback", () => {
    for (const [template, env, named] of [[namedSlack, "staging", true], [legacySlack, "production", false]] as const) {
      const variables = Object.fromEntries(container(template).map((entry) => [entry.Name, entry.Value]));
      expect(flatten(variables[SLACK_COMPANY_TOKEN_ROLE_VARIABLE]), env).toBe(`arn:<token>:iam::<token>:role${named ? `/agentx/${env}/` : "/"}${slackTokenReaderRoleName(env)}`);
      expect(variables[SLACK_COMPANY_TOKEN_FALLBACK_VARIABLE], env).toBe("shared");
    }
  });
});

describe("the boundary statement the runtime boundary carries (SlackTokenReader) and the lookup entry the deploy boundary lists", () => {
  const scope = { env: "staging", partition: "aws", account: "123456789012" };
  it("names the one role by exact ARN, allows only the assume and the tag, and costs a known number of characters", () => {
    const statement = slackTokenReaderBoundaryStatement({ ...scope, named: true });
    expect(statement).toStrictEqual({ Effect: "Allow", Action: ["sts:AssumeRole", "sts:TagSession"], Resource: "arn:aws:iam::123456789012:role/agentx/staging/agentx-staging-slk" });
    expect(slackTokenReaderRoleArn({ ...scope, named: false })).toBe("arn:aws:iam::123456789012:role/agentx-staging-slk");
    expect(slackTokenReaderLookupResource(scope)).toBe("arn:aws:iam::123456789012:role/agentx-staging-slk");
    // IAM counts a policy's characters without whitespace: the statement (and its separating comma) plus the lookup list's added entry (and its comma). DONE.md quotes these numbers.
    const statementCost = JSON.stringify(statement).length + 1;
    const lookupCost = JSON.stringify(slackTokenReaderLookupResource(scope)).length + 1;
    expect([statementCost, lookupCost, statementCost + lookupCost]).toEqual([142, 52, 194]);
    expect(() => slackTokenReaderRoleName("Bad_Name")).toThrow();
  });
  it("is in the runtime boundary as SlackTokenReader, next to the broker's AssumeSessionRoles, and those are the boundary's only sts:AssumeRole", () => {
    const boundary = defaultBoundaryStatements({ ...scope, region: "us-west-2", cloudFormationRoleName: "cfn", });
    expect(boundary.filter((statement) => statement.Action.includes("sts:AssumeRole")).map((statement) => statement.Sid)).toEqual(["AssumeSessionRoles", "SlackTokenReader"]);
  });
});
