// L2-2 PR 18a (DEC 254o b): take Slack company mode's named-environment addition out of a synthesized named control-plane template, asserting its exact shape first, so a test
// that pins "everything else" does not have to know it. tests/contract/slack-company-workspaces-infrastructure.test.ts checks each grant in full.
import { expect } from "vitest";
import { removePackedPieces } from "./broker-environment-template.js";
import { withoutCompanySignIn, withoutCompanySignInService } from "./company-signin-template.js";

type Resource = { Type: string; Properties: Record<string, unknown>; Condition?: string };
type Template = { Parameters?: Record<string, unknown>; Conditions?: Record<string, unknown>; Resources: Record<string, Resource> };

/** The policies' logical-id prefixes, one per consumer role (control-plane.ts). */
export const SLACK_COMPANY_POLICIES = ["SlackIngress", "ChannelApi", "DeveloperTaskNotifier", "DeveloperIdentity", "SlackIngressMembers", "ChannelApiMembers", "SessionReconciler", "SlackOrchestrator", "Broker", "SlackIngressCompanyBindings", "SlackIngressCompanyProjects", "ChannelApiCompanyProjects"] as const;
/** Each consumer function's logical-id prefix and the variables the switch adds to it. */
const VARIABLES: ReadonlyArray<readonly [RegExp, readonly string[]]> = [
  [/^SlackIngress[0-9A-F]{8}$/u, ["SLACK_COMPANY_WORKSPACES", "DEVELOPER_SIGNIN_TABLE_NAME", "AGENTX_ENV", "SLACK_TEAM_ID"]],
  // DEC 254zk: the channel API's company factory needs the environment's name too.
  [/^ChannelApiIngress[0-9A-F]{8}$/u, ["SLACK_COMPANY_WORKSPACES", "DEVELOPER_SIGNIN_TABLE_NAME", "AGENTX_ENV"]],
  [/^DeveloperTaskNotifierFunction[0-9A-F]{8}$/u, ["SLACK_COMPANY_WORKSPACES", "AGENTX_ENV"]],
  // SIGNIN-STATE-TABLE: the sign-in function's STATE_TABLE_NAME is no longer part of the switch; it is checked as the real State table and taken out below.
  [/^DeveloperSignInFunction[0-9A-F]{8}$/u, ["SLACK_COMPANY_WORKSPACES"]],
  [/^SessionsReconciler[0-9A-F]{8}$/u, ["SLACK_COMPANY_WORKSPACES", "AGENTX_ENV"]],
];

/** True when the condition's expression is `Fn::Equals [Ref SlackCompanyWorkspaces, enabled]` (optionally ANDed with another condition). */
const onCondition = (template: Template, id: string): boolean => {
  const expression = JSON.stringify(template.Conditions?.[id]);
  return expression.includes('{"Fn::Equals":[{"Ref":"SlackCompanyWorkspaces"},"enabled"]}') || expression.includes('{"Condition":"SlackCompanyModeOn');
};

export function withoutSlackCompanyMode(input: unknown, options: { proof?: boolean } = {}): unknown {
  const template = input as Template;
  expect(template.Parameters?.SlackCompanyWorkspaces).toStrictEqual({
    Type: "String", Default: "disabled", AllowedValues: ["enabled", "disabled"],
    Description: "enabled: Slack workspaces other than SlackTeamId use their company's own bot token and company checks (needs company sign-in); disabled: only the install's workspace is served, as before",
  });
  delete template.Parameters!.SlackCompanyWorkspaces;
  const conditions = Object.keys(template.Conditions ?? {}).filter((id) => id.startsWith("SlackCompanyMode"));
  expect(conditions.sort()).toEqual(options.proof === true ? [expect.stringMatching(/^SlackCompanyModeOn/u), expect.stringMatching(/^SlackCompanyModeTaskPersonProofOn/u)].sort() : [expect.stringMatching(/^SlackCompanyModeOn/u)]);
  for (const id of conditions) expect(onCondition(template, id), id).toBe(true);
  const policies = Object.entries(template.Resources).filter(([id]) => id.startsWith("SlackCompanyMode"));
  const expected = [...SLACK_COMPANY_POLICIES, ...(options.proof === true ? ["TaskPersonProof"] : [])];
  expect(policies.map(([id]) => id.replace(/^SlackCompanyMode/u, "").replace(/[0-9A-F]{8}$/u, "")).sort()).toEqual([...expected].sort());
  for (const [id, policy] of policies) {
    // Only inline policies under the switch's condition: nothing exists while it is off.
    expect(policy.Type, id).toBe("AWS::IAM::Policy");
    expect(conditions, id).toContain(policy.Condition);
    delete template.Resources[id];
  }
  for (const id of conditions) delete template.Conditions![id];
  // L2-2 PR 18d: the Slack service's inputs. DEC 254zk: the table and the team are always output (the switch is the slack stack's own, set by config set); no state output.
  const outputs = (template as { Outputs?: Record<string, { Value: unknown; Condition?: string }> }).Outputs ?? {};
  expect(outputs).not.toHaveProperty("SlackCompanyWorkspacesState");
  for (const id of ["SlackCompanyStateTableName", "SlackCompanyTeamId"]) {
    expect(outputs[id], id).toBeDefined();
    expect(outputs[id]!.Condition, id).toBeUndefined();
    delete outputs[id];
  }
  // DEC 254zc (6): the proof function's switch variables (its COMPANY_SIGNIN is withoutCompanySignIn's).
  const variables = options.proof === true ? [...VARIABLES, [/^TaskPersonProofFunction[0-9A-F]{8}$/u, ["SLACK_COMPANY_WORKSPACES", "STATE_TABLE_NAME"]] as const] : VARIABLES;
  for (const [pattern, names] of variables) {
    const found = Object.entries(template.Resources).filter(([id, resource]) => pattern.test(id) && resource.Type === "AWS::Lambda::Function");
    expect(found, String(pattern)).toHaveLength(1);
    const variables = (found[0]![1].Properties.Environment as { Variables: Record<string, unknown> }).Variables;
    for (const name of names) {
      const value = JSON.stringify(variables[name]);
      // Every added value is an Fn::If on the switch's condition, so while it is off the function gets "disabled" or "".
      expect(value, `${String(pattern)} ${name}`).toMatch(/^\{"Fn::If":\["SlackCompanyModeOn[0-9A-F]{8}",/u);
      expect(value, `${String(pattern)} ${name}`).toMatch(/,("disabled"|"")\]\}$/u);
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
  // DEC 254zk: the conditioned switch flag ("1" only with company sign-in on too), not the raw parameter.
  expect(JSON.stringify(brokerVariables.AGENTX_SETTINGS)).toMatch(/",cw=",\{"Fn::If":\["SlackCompanyModeOn[0-9A-F]{8}","1","0"\]\}/u);
  removePackedPieces(brokerVariables, "AGENTX_SETTINGS", ["cw"]);
  // L2-2 PR 18a also derived COMPANY_READS to make room; DEC 254h (#831, merged first) made the same change, and withoutGithubSignIn (github-signin-template.ts) puts the old
  // literal back where pins taken before it need it. Batch 12: so this helper only checks that the variable stays derived.
  expect(brokerVariables).not.toHaveProperty("COMPANY_READS");
  // DEC 254zg (a): Slack company mode requires company sign-in, so the company layer's switch goes with it.
  return withoutCompanySignIn(template, options);
}

/** L2-2 PR 18d: the named slack stack's addition: three off-by-default parameters and four container variables (the switch, the table, the team, the environment's name). */
export function withoutSlackCompanyService(input: unknown): unknown {
  const template = input as { Parameters: Record<string, unknown>; Resources: Record<string, Resource> };
  expect(template.Parameters.SlackCompanyWorkspacesState).toMatchObject({ Type: "String", Default: "disabled", AllowedValues: ["enabled", "disabled"] });
  expect(template.Parameters.SlackCompanyStateTableName).toMatchObject({ Type: "String", Default: "" });
  expect(template.Parameters.SlackCompanyTeamId).toMatchObject({ Type: "String", Default: "", AllowedPattern: "^$|^T[A-Z0-9]{2,31}$" });
  for (const id of ["SlackCompanyWorkspacesState", "SlackCompanyStateTableName", "SlackCompanyTeamId"]) delete template.Parameters[id];
  const tasks = Object.values(template.Resources).filter((resource) => resource.Type === "AWS::ECS::TaskDefinition");
  expect(tasks).toHaveLength(1);
  const container = (tasks[0]!.Properties.ContainerDefinitions as Array<{ Environment: Array<{ Name: string; Value: unknown }> }>)[0]!;
  const added = container.Environment.filter((entry) => ["SLACK_COMPANY_WORKSPACES", "STATE_TABLE_NAME", "SLACK_TEAM_ID", "AGENTX_ENV"].includes(entry.Name));
  expect(added.map((entry) => [entry.Name, entry.Value])).toEqual([
    ["SLACK_COMPANY_WORKSPACES", { Ref: "SlackCompanyWorkspacesState" }], ["STATE_TABLE_NAME", { Ref: "SlackCompanyStateTableName" }], ["SLACK_TEAM_ID", { Ref: "SlackCompanyTeamId" }],
    ["AGENTX_ENV", expect.any(String)],
  ]);
  container.Environment = container.Environment.filter((entry) => !added.includes(entry));
  return withoutCompanySignInService(template);
}
