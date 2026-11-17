// L2-2 PR 18a (DEC 254o b): take Slack company mode's named-environment addition out of a synthesized named control-plane template, asserting its exact shape first, so a test
// that pins "everything else" does not have to know it. tests/contract/slack-company-workspaces-infrastructure.test.ts checks each grant in full.
import { expect } from "vitest";
import { removePackedPieces } from "./broker-environment-template.js";

type Resource = { Type: string; Properties: Record<string, unknown>; Condition?: string };
type Template = { Parameters?: Record<string, unknown>; Conditions?: Record<string, unknown>; Resources: Record<string, Resource> };

/** The policies' logical-id prefixes, one per consumer role (control-plane.ts). */
export const SLACK_COMPANY_POLICIES = ["SlackIngress", "ChannelApi", "DeveloperTaskNotifier", "DeveloperIdentity", "SlackIngressMembers", "ChannelApiMembers", "SessionReconciler", "SlackOrchestrator"] as const;
/** Each consumer function's logical-id prefix and the variables the switch adds to it. */
const VARIABLES: ReadonlyArray<readonly [RegExp, readonly string[]]> = [
  [/^SlackIngress[0-9A-F]{8}$/u, ["SLACK_COMPANY_WORKSPACES", "DEVELOPER_SIGNIN_TABLE_NAME", "AGENTX_ENV", "SLACK_TEAM_ID"]],
  [/^ChannelApiIngress[0-9A-F]{8}$/u, ["SLACK_COMPANY_WORKSPACES", "DEVELOPER_SIGNIN_TABLE_NAME"]],
  [/^DeveloperTaskNotifierFunction[0-9A-F]{8}$/u, ["SLACK_COMPANY_WORKSPACES"]],
  [/^DeveloperSignInFunction[0-9A-F]{8}$/u, ["SLACK_COMPANY_WORKSPACES", "STATE_TABLE_NAME"]],
  [/^SessionsReconciler[0-9A-F]{8}$/u, ["SLACK_COMPANY_WORKSPACES"]],
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
  for (const [pattern, names] of VARIABLES) {
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
  const broker = Object.entries(template.Resources).find(([id, resource]) => /^Broker[0-9A-F]{8}$/u.test(id) && resource.Type === "AWS::Lambda::Function")!;
  const brokerVariables = (broker[1].Properties.Environment as { Variables: Record<string, unknown> }).Variables;
  expect(JSON.stringify(brokerVariables.AGENTX_SETTINGS)).toContain('",cw=",{"Ref":"SlackCompanyWorkspaces"}');
  removePackedPieces(brokerVariables, "AGENTX_SETTINGS", ["cw"]);
  // The same PR derives COMPANY_READS (always "enabled" in a named environment) instead of passing it, to make room in the broker's 4 KB environment
  // (DERIVED_BROKER_VARIABLES). The broker still reads the same value; put the old literal back so the pins before it compare unchanged.
  expect(brokerVariables).not.toHaveProperty("COMPANY_READS");
  // At its old place (after DEVELOPER_OIDC_ISSUER), so digests over the JSON text compare too.
  const entries = Object.entries(brokerVariables);
  const at = entries.findIndex(([name]) => name === "DEVELOPER_OIDC_ISSUER");
  expect(at, "the broker's DEVELOPER_OIDC_ISSUER").toBeGreaterThanOrEqual(0);
  entries.splice(at + 1, 0, ["COMPANY_READS", "enabled"]);
  for (const name of Object.keys(brokerVariables)) delete brokerVariables[name];
  Object.assign(brokerVariables, Object.fromEntries(entries));
  return template;
}
