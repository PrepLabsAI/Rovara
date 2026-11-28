// L2-2 PR 18a (DEC 254o b): take Slack company mode's named-environment addition out of a synthesized named control-plane template, asserting its exact shape first, so a test
// that pins "everything else" does not have to know it. tests/contract/slack-company-workspaces-infrastructure.test.ts checks each grant in full.
import { expect } from "vitest";
import { withoutCompanySignIn, withoutCompanySignInService } from "./company-signin-template.js";

type Resource = { Type: string; Properties: Record<string, unknown>; Condition?: string };
type Template = { Parameters?: Record<string, unknown>; Conditions?: Record<string, unknown>; Resources: Record<string, Resource> };

/** The policies' logical-id prefixes, one per consumer role (control-plane.ts). */
export const SLACK_COMPANY_POLICIES = ["SlackIngress", "ChannelApi", "DeveloperTaskNotifier", "DeveloperIdentity", "SlackIngressMembers", "ChannelApiMembers", "SessionReconciler", "SlackOrchestrator", "Broker", "SlackIngressCompanyBindings", "SlackIngressCompanyProjects", "ChannelApiCompanyProjects", "SlackTokenReader"] as const;
/** Each consumer function's logical-id prefix and the variables the switch adds to it. */
const VARIABLES: ReadonlyArray<readonly [RegExp, readonly string[]]> = [
  [/^SlackIngress[0-9A-F]{8}$/u, ["DEVELOPER_SIGNIN_TABLE_NAME", "AGENTX_ENV", "SLACK_TEAM_ID"]],
  // DEC 254zk: the channel API's company factory needs the environment's name too.
  [/^ChannelApiIngress[0-9A-F]{8}$/u, ["DEVELOPER_SIGNIN_TABLE_NAME", "AGENTX_ENV"]],
  [/^DeveloperTaskNotifierFunction[0-9A-F]{8}$/u, ["AGENTX_ENV"]],
  // SIGNIN-STATE-TABLE: the sign-in function's STATE_TABLE_NAME is no longer part of the switch; it is checked as the real State table and taken out below.
  [/^DeveloperSignInFunction[0-9A-F]{8}$/u, []],
  [/^SessionsReconciler[0-9A-F]{8}$/u, ["AGENTX_ENV"]],
];

export function withoutSlackCompanyMode(input: unknown): unknown {
  const template = input as Template;
  // #1614: company mode is the only mode: no SlackCompanyWorkspaces parameter, no condition, no SLACK_COMPANY_WORKSPACES variable and no packed `cw`. Its grants and variables stay,
  // now unconditional; they are asserted and taken out, so the pins recorded before them hold.
  expect(template.Parameters?.SlackCompanyWorkspaces).toBeUndefined();
  expect(Object.keys(template.Conditions ?? {}).filter((id) => id.startsWith("SlackCompanyMode"))).toEqual([]);
  const policies = Object.entries(template.Resources).filter(([id]) => id.startsWith("SlackCompanyMode"));
    expect(policies.map(([id]) => id.replace(/^SlackCompanyMode/u, "").replace(/[0-9A-F]{8}$/u, "")).sort()).toEqual([...SLACK_COMPANY_POLICIES].sort());
  for (const [id, policy] of policies) {
    // Only inline policies of their own, unconditional.
    expect(policy.Type, id).toBe("AWS::IAM::Policy");
    expect(policy.Condition, id).toBeUndefined();
    delete template.Resources[id];
  }
  // R5 step 1 (DEC 254zzz444): the orchestrator's company-scoped Slack token reader ROLE (its policy is the SlackTokenReader policy above). Exactly one, under the switch's condition and the
  // fixed name; tests/contract/slack-company-token-reader-infrastructure.test.ts checks its trust and policy in full.
  const readers = Object.entries(template.Resources).filter(([id]) => /^SlackCompanyTokenReaderRole[0-9A-F]{8}$/u.test(id));
  expect(readers).toHaveLength(1);
  expect(readers[0]![1].Type).toBe("AWS::IAM::Role");
  expect(readers[0]![1].Condition).toBeUndefined();
  expect(readers[0]![1].Properties.RoleName).toMatch(/^agentx-[a-z0-9-]+-slk$/u);
  delete template.Resources[readers[0]![0]];
  // L2-2 PR 18d: the Slack service's inputs. DEC 254zk: the table and the team are always output (the switch is the slack stack's own, set by config set); no state output.
  const outputs = (template as { Outputs?: Record<string, { Value: unknown; Condition?: string }> }).Outputs ?? {};
  expect(outputs).not.toHaveProperty("SlackCompanyWorkspacesState");
  for (const id of ["SlackCompanyStateTableName", "SlackCompanyTeamId"]) {
    expect(outputs[id], id).toBeDefined();
    expect(outputs[id]!.Condition, id).toBeUndefined();
    delete outputs[id];
  }
  for (const [pattern, names] of VARIABLES) {
    const found = Object.entries(template.Resources).filter(([id, resource]) => pattern.test(id) && resource.Type === "AWS::Lambda::Function");
    expect(found, String(pattern)).toHaveLength(1);
    const variables = (found[0]![1].Properties.Environment as { Variables: Record<string, unknown> }).Variables;
    expect(variables, String(pattern)).not.toHaveProperty("SLACK_COMPANY_WORKSPACES");
    for (const name of names) {
      // Every added value is plain now (no Fn::If on a switch).
      expect(variables[name], `${String(pattern)} ${name}`).toBeDefined();
      expect(JSON.stringify(variables[name]), `${String(pattern)} ${name}`).not.toContain("Fn::If");
      delete variables[name];
    }
  }
  // SIGNIN-STATE-TABLE: the sign-in function's own STATE_TABLE_NAME (developer-signin.ts) is always a plain Ref to the State table, whatever this switch says (the company audit write
  // needs it with company sign-in on). Not part of the switch: checked here and taken out only so the pins that held it out before (rule D) are unchanged.
  const stateTables = Object.entries(template.Resources).filter(([id, resource]) => resource.Type === "AWS::DynamoDB::Table" && /^State[0-9A-F]{8}$/u.test(id));
  expect(stateTables).toHaveLength(1);
  const signIn = Object.entries(template.Resources).filter(([id, resource]) => /^DeveloperSignInFunction[0-9A-F]{8}$/u.test(id) && resource.Type === "AWS::Lambda::Function");
  expect(signIn).toHaveLength(1);
  const signInVariables = (signIn[0]![1].Properties.Environment as { Variables: Record<string, unknown> }).Variables;
  expect(signInVariables.STATE_TABLE_NAME).toStrictEqual({ Ref: stateTables[0]![0] });
  delete signInVariables.STATE_TABLE_NAME;
  const broker = Object.entries(template.Resources).find(([id, resource]) => /^Broker[0-9A-F]{8}$/u.test(id) && resource.Type === "AWS::Lambda::Function")!;
  const brokerVariables = (broker[1].Properties.Environment as { Variables: Record<string, unknown> }).Variables;
  expect(JSON.stringify(brokerVariables.AGENTX_SETTINGS)).not.toMatch(/[",]cw=/u);
  // L2-2 PR 18a also derived COMPANY_READS to make room; DEC 254h (#831, merged first) made the same change, and withoutGithubSignIn (github-signin-template.ts) puts the old
  // literal back where pins taken before it need it. Batch 12: so this helper only checks that the variable stays derived.
  expect(brokerVariables).not.toHaveProperty("COMPANY_READS");
  // DEC 254zg (a): Slack company mode requires company sign-in, so the company layer's switch goes with it.
  return withoutCompanySignIn(template);
}

/** L2-2 PR 18d: the named slack stack's addition: three off-by-default parameters and four container variables (the switch, the table, the team, the environment's name). */
export function withoutSlackCompanyService(input: unknown): unknown {
  const template = input as { Parameters: Record<string, unknown>; Resources: Record<string, Resource> };
  expect(template.Parameters.SlackCompanyWorkspacesState).toBeUndefined();
  expect(template.Parameters.SlackCompanyStateTableName).toMatchObject({ Type: "String", Default: "" });
  expect(template.Parameters.SlackCompanyTeamId).toMatchObject({ Type: "String", Default: "", AllowedPattern: "^$|^T[A-Z0-9]{2,31}$" });
  for (const id of ["SlackCompanyStateTableName", "SlackCompanyTeamId"]) delete template.Parameters[id];
  const tasks = Object.values(template.Resources).filter((resource) => resource.Type === "AWS::ECS::TaskDefinition");
  expect(tasks).toHaveLength(1);
  const container = (tasks[0]!.Properties.ContainerDefinitions as Array<{ Environment: Array<{ Name: string; Value: unknown }> }>)[0]!;
  expect(container.Environment.filter((entry) => entry.Name === "SLACK_COMPANY_WORKSPACES")).toEqual([]);
  const added = container.Environment.filter((entry) => ["STATE_TABLE_NAME", "SLACK_TEAM_ID", "AGENTX_ENV", "SLACK_COMPANY_TOKEN_ROLE_ARN", "SLACK_COMPANY_TOKEN_FALLBACK"].includes(entry.Name));
  expect(added.map((entry) => [entry.Name, entry.Value])).toEqual([
    ["STATE_TABLE_NAME", { Ref: "SlackCompanyStateTableName" }], ["SLACK_TEAM_ID", { Ref: "SlackCompanyTeamId" }],
    ["AGENTX_ENV", expect.any(String)],
    // R5 step 1 (DEC 254zzz444): the token reader role's ARN (built from the environment alone) and the release-1 fallback.
    ["SLACK_COMPANY_TOKEN_ROLE_ARN", expect.objectContaining({ "Fn::Join": expect.any(Array) as unknown }) as unknown], ["SLACK_COMPANY_TOKEN_FALLBACK", "shared"],
  ]);
  container.Environment = container.Environment.filter((entry) => !added.includes(entry));
  return withoutCompanySignInService(template);
}
