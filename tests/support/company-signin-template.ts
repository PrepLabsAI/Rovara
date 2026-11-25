// DEC 254zg (a), 254zc (6): take the CompanySignIn switch's named-environment addition out of a synthesized named template, asserting its exact shape first, so a test that pins
// "everything else" does not have to know it. tests/contract/company-signin-switch.test.ts evaluates the switch under each parameter value. What the switch MOVED (#865's
// slack-workspaces grant, out of the sign-in role's default policy) is not put back: the pins that held it are updated (owner-approved, DEC 254zg).
import { expect } from "vitest";
import { removePackedPieces } from "./broker-environment-template.js";

type Resource = { Type: string; Properties: Record<string, unknown>; Condition?: string };
type Template = { Parameters?: Record<string, unknown>; Conditions?: Record<string, unknown>; Resources: Record<string, Resource> };

const ON = /^CompanySignInSwitchOn[0-9A-F]{8}$/u;
const SELF_SERVE_ON = /^CompanySignInSwitchSelfServeOn[0-9A-F]{8}$/u;
/** The functions that get COMPANY_SIGNIN from the switch (control-plane.ts, developer-signin.ts). */
const READERS = [/^DeveloperSignInFunction[0-9A-F]{8}$/u, /^SlackIngress[0-9A-F]{8}$/u, /^ChannelApiIngress[0-9A-F]{8}$/u, /^DeveloperTaskNotifierFunction[0-9A-F]{8}$/u, /^SessionsReconciler[0-9A-F]{8}$/u];

function variablesOf(template: Template, pattern: RegExp): Record<string, unknown> {
  const found = Object.entries(template.Resources).filter(([id, resource]) => pattern.test(id) && resource.Type === "AWS::Lambda::Function");
  expect(found, String(pattern)).toHaveLength(1);
  return (found[0]![1].Properties.Environment as { Variables: Record<string, unknown> }).Variables;
}

export function withoutCompanySignIn(input: unknown): unknown {
  const template = input as Template;
  expect(template.Parameters?.CompanySignIn).toMatchObject({ Type: "String", Default: "disabled", AllowedValues: ["enabled", "disabled"] });
  expect(template.Parameters?.CompanySelfServe).toMatchObject({ Type: "String", Default: "disabled", AllowedValues: ["enabled", "disabled"] });
  delete template.Parameters!.CompanySignIn;
  delete template.Parameters!.CompanySelfServe;
  const conditions = Object.keys(template.Conditions ?? {}).filter((id) => id.startsWith("CompanySignInSwitch"));
  expect(conditions).toHaveLength(2);
  const on = conditions.find((id) => ON.test(id))!;
  const selfServe = conditions.find((id) => SELF_SERVE_ON.test(id))!;
  expect(template.Conditions![on]).toStrictEqual({ "Fn::Equals": [{ Ref: "CompanySignIn" }, "enabled"] });
  expect(template.Conditions![selfServe]).toStrictEqual({ "Fn::And": [{ Condition: on }, { "Fn::Equals": [{ Ref: "CompanySelfServe" }, "enabled"] }] });
  // The one policy the switch owns: #865's slack-workspaces grant, under its condition only.
  const policies = Object.entries(template.Resources).filter(([id]) => id.startsWith("CompanySignInSwitch"));
  expect(policies.map(([id]) => id.replace(/[0-9A-F]{8}$/u, ""))).toEqual(["CompanySignInSwitchSlackWorkspaceTokens"]);
  const [policyId, policy] = policies[0]!;
  expect(policy.Type).toBe("AWS::IAM::Policy");
  expect(policy.Condition).toBe(on);
  expect(policy.Properties.PolicyName).toBe("company-signin-slackworkspacetokens");
  expect((policy.Properties.PolicyDocument as { Statement: unknown[] }).Statement).toEqual([expect.objectContaining({
    Sid: "WriteSlackWorkspaceTokens", Effect: "Allow", Action: ["secretsmanager:CreateSecret", "secretsmanager:PutSecretValue", "secretsmanager:GetSecretValue"] })]);
  delete template.Resources[policyId];
  const conditioned = (value: unknown, condition: string, on: string, off: string) => expect(value).toStrictEqual({ "Fn::If": [condition, on, off] });
  for (const pattern of READERS) {
    const variables = variablesOf(template, pattern);
    conditioned(variables.COMPANY_SIGNIN, on, "enabled", "disabled");
    delete variables.COMPANY_SIGNIN;
  }
  const signIn = variablesOf(template, READERS[0]!);
  conditioned(signIn.COMPANY_SELF_SERVE, selfServe, "enabled", "disabled");
  delete signIn.COMPANY_SELF_SERVE;
  const broker = variablesOf(template, /^Broker[0-9A-F]{8}$/u);
  // (`si=",` without the leading quote: a literal piece such as `rl=on` is merged into the string before it.)
  expect(JSON.stringify(broker.AGENTX_SETTINGS)).toContain(`si=",{"Fn::If":["${on}","1","0"]}`);
  removePackedPieces(broker, "AGENTX_SETTINGS", ["si"]);
  for (const id of conditions) delete template.Conditions![id];
  return template;
}

/** The named slack stack's copy of the switch: one off-by-default parameter and the container's COMPANY_SIGNIN. */
export function withoutCompanySignInService(input: unknown): unknown {
  const template = input as { Parameters: Record<string, unknown>; Resources: Record<string, Resource> };
  expect(template.Parameters.CompanySignIn).toMatchObject({ Type: "String", Default: "disabled", AllowedValues: ["enabled", "disabled"] });
  delete template.Parameters.CompanySignIn;
  const tasks = Object.values(template.Resources).filter((resource) => resource.Type === "AWS::ECS::TaskDefinition");
  expect(tasks).toHaveLength(1);
  const container = (tasks[0]!.Properties.ContainerDefinitions as Array<{ Environment: Array<{ Name: string; Value: unknown }> }>)[0]!;
  const added = container.Environment.filter((entry) => entry.Name === "COMPANY_SIGNIN");
  expect(added.map((entry) => entry.Value)).toEqual([{ Ref: "CompanySignIn" }]);
  container.Environment = container.Environment.filter((entry) => entry.Name !== "COMPANY_SIGNIN");
  return template;
}
