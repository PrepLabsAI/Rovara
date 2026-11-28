// DEC 254zg (a), 254zc (6): take the CompanySignIn switch's named-environment addition out of a synthesized named template, asserting its exact shape first, so a test that pins
// "everything else" does not have to know it. tests/contract/company-signin-switch.test.ts evaluates the switch under each parameter value. What the switch MOVED (#865's
// slack-workspaces grant, out of the sign-in role's default policy) is not put back: the pins that held it are updated (owner-approved, DEC 254zg).
import { expect } from "vitest";

type Resource = { Type: string; Properties: Record<string, unknown>; Condition?: string };
type Template = { Parameters?: Record<string, unknown>; Conditions?: Record<string, unknown>; Resources: Record<string, Resource> };

/** The functions that get COMPANY_SIGNIN from the switch (control-plane.ts, developer-signin.ts). */
const READERS = [/^DeveloperSignInFunction[0-9A-F]{8}$/u, /^SlackIngress[0-9A-F]{8}$/u, /^ChannelApiIngress[0-9A-F]{8}$/u, /^DeveloperTaskNotifierFunction[0-9A-F]{8}$/u, /^SessionsReconciler[0-9A-F]{8}$/u];

function variablesOf(template: Template, pattern: RegExp): Record<string, unknown> {
  const found = Object.entries(template.Resources).filter(([id, resource]) => pattern.test(id) && resource.Type === "AWS::Lambda::Function");
  expect(found, String(pattern)).toHaveLength(1);
  return (found[0]![1].Properties.Environment as { Variables: Record<string, unknown> }).Variables;
}

export function withoutCompanySignIn(input: unknown): unknown {
  const template = input as Template;
  // #1614: company mode is the only mode: no CompanySignIn or CompanySelfServe parameter, no condition, no COMPANY_SIGNIN / COMPANY_SELF_SERVE variable and no packed `si`.
  // What stays is the switch's one policy, now unconditional; it is asserted and taken out, so the pins recorded before it hold.
  expect(template.Parameters?.CompanySignIn).toBeUndefined();
  expect(template.Parameters?.CompanySelfServe).toBeUndefined();
  expect(Object.keys(template.Conditions ?? {}).filter((id) => id.startsWith("CompanySignInSwitch"))).toEqual([]);
  const policies = Object.entries(template.Resources).filter(([id]) => id.startsWith("CompanySignInSwitch"));
  expect(policies.map(([id]) => id.replace(/[0-9A-F]{8}$/u, ""))).toEqual(["CompanySignInSwitchSlackWorkspaceTokens"]);
  const [policyId, policy] = policies[0]!;
  expect(policy.Type).toBe("AWS::IAM::Policy");
  expect(policy.Condition).toBeUndefined();
  expect(policy.Properties.PolicyName).toBe("company-signin-slackworkspacetokens");
  expect((policy.Properties.PolicyDocument as { Statement: unknown[] }).Statement).toEqual([expect.objectContaining({
    Sid: "WriteSlackWorkspaceTokens", Effect: "Allow", Action: ["secretsmanager:CreateSecret", "secretsmanager:PutSecretValue", "secretsmanager:GetSecretValue"] })]);
  delete template.Resources[policyId];
  for (const pattern of READERS) expect(variablesOf(template, pattern)).not.toHaveProperty("COMPANY_SIGNIN");
  expect(variablesOf(template, READERS[0]!)).not.toHaveProperty("COMPANY_SELF_SERVE");
  expect(JSON.stringify(variablesOf(template, /^Broker[0-9A-F]{8}$/u).AGENTX_SETTINGS)).not.toMatch(/[",]si=/u);
  return template;
}

/** The named slack stack's copy of the switch. #1614: gone (no CompanySignIn parameter, no COMPANY_SIGNIN in the container). */
export function withoutCompanySignInService(input: unknown): unknown {
  const template = input as { Parameters: Record<string, unknown>; Resources: Record<string, Resource> };
  expect(template.Parameters.CompanySignIn).toBeUndefined();
  const tasks = Object.values(template.Resources).filter((resource) => resource.Type === "AWS::ECS::TaskDefinition");
  expect(tasks).toHaveLength(1);
  const container = (tasks[0]!.Properties.ContainerDefinitions as Array<{ Environment: Array<{ Name: string; Value: unknown }> }>)[0]!;
  expect(container.Environment.filter((entry) => entry.Name === "COMPANY_SIGNIN")).toEqual([]);
  return template;
}
