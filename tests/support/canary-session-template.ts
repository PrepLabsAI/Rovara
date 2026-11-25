import { expect } from "vitest";

type Resource = { Type: string; Properties: Record<string, unknown>; Condition?: string };
type Template = { Parameters: Record<string, Record<string, unknown>>; Conditions?: Record<string, unknown>; Rules?: Record<string, unknown>; Resources: Record<string, Resource>; Outputs: Record<string, unknown> };

const PARAMETERS = ["CanarySessionPlacementEnvironment", "CanarySessionPerson", "CanarySessionCompany", "CanarySessionStepRoleName"];
/** What the construct builds, by type: the function with its log group, role, role policy and invoke permission, two metric filters, three alarms. */
export const CANARY_RESOURCE_TYPES = [
  "AWS::CloudWatch::Alarm", "AWS::CloudWatch::Alarm", "AWS::CloudWatch::Alarm", "AWS::IAM::Policy", "AWS::IAM::Role", "AWS::Lambda::Function", "AWS::Lambda::Permission", "AWS::Logs::LogGroup", "AWS::Logs::MetricFilter", "AWS::Logs::MetricFilter",
];
const PREFIX = "DeveloperSignInCanarySession";

/**
 * CANARY-SESSION (the beta canary's session function): the LEGACY control plane (beta and production share it) gains four empty-by-default parameters, one condition, one template rule, the function with its
 * log group, role, role policy and invoke permission, two metric filters and three alarms (all under that condition), one conditional output, and a condition around the developer token key's deny list (it names the sign-in function's role, and
 * this function's role only while the function exists). Each is asserted here and taken out of `input` itself (like the other withoutX helpers; clone first to keep the original), so every earlier pin and
 * snapshot of the legacy template holds as recorded. tests/contract/canary-session-infrastructure.test.ts proves what the additions do. Take it out FIRST (innermost): its function holds one more public
 * address site (the issuer), which the public-URL helper counts.
 */
export function withoutCanarySession<T>(input: T): T {
  const template = input as unknown as Template;
  for (const name of PARAMETERS) {
    expect(template.Parameters[name], name).toMatchObject({ Type: "String", Default: "" });
    delete template.Parameters[name];
  }
  const conditions = Object.keys(template.Conditions ?? {}).filter((id) => id.startsWith(PREFIX));
  expect(conditions).toHaveLength(1);
  delete template.Conditions![conditions[0]!];
  const rules = Object.keys(template.Rules ?? {}).filter((id) => id.startsWith(PREFIX));
  expect(rules).toHaveLength(1);
  delete template.Rules![rules[0]!];
  if (Object.keys(template.Rules!).length === 0) delete template.Rules;
  const ids = Object.keys(template.Resources).filter((id) => id.startsWith(PREFIX));
  expect(ids.map((id) => template.Resources[id]!.Type).sort()).toEqual([...CANARY_RESOURCE_TYPES].sort());
  for (const id of ids) {
    expect(template.Resources[id]!.Condition, id).toBe(conditions[0]);
    delete template.Resources[id];
  }
  expect(Object.keys(template.Outputs).filter((name) => name.startsWith("CanarySession"))).toEqual(["CanarySessionFunctionArn"]);
  delete template.Outputs.CanarySessionFunctionArn;
  const keys = Object.entries(template.Resources).filter(([id, resource]) => resource.Type === "AWS::KMS::Key" && id.startsWith("DeveloperSignInTokenKey"));
  expect(keys).toHaveLength(1);
  const policy = keys[0]![1].Properties.KeyPolicy as { Statement: Array<{ Sid?: string; Condition?: { ArnNotEquals?: Record<string, unknown> } }> };
  const deny = policy.Statement.find((statement) => statement.Sid === "SignAndGetPublicKeyOnlyAsDeveloperIdentity")!;
  const principals = deny.Condition!.ArnNotEquals!["aws:PrincipalArn"] as { "Fn::If": [string, unknown[], unknown] };
  expect(principals["Fn::If"][0]).toBe(conditions[0]);
  expect(principals["Fn::If"][1]).toEqual([principals["Fn::If"][2], { "Fn::GetAtt": [expect.stringMatching(/^DeveloperSignInCanarySessionFunctionServiceRole[0-9A-F]{8}$/u), "Arn"] }]);
  deny.Condition!.ArnNotEquals!["aws:PrincipalArn"] = principals["Fn::If"][2];
  return input;
}

type Conditioned = { Parameters: Record<string, Record<string, unknown>>; Conditions?: Record<string, unknown>; Rules?: Record<string, { RuleCondition: unknown; Assertions: Array<{ Assert: unknown }> }>; Resources: Record<string, { Type: string; Condition?: string }> };

/** CloudFormation's Fn::Equals, Fn::Not, Fn::And, Fn::Or, Condition and Ref to a parameter, over the given parameter values (the template's defaults for any not given). */
export function conditionHolds(template: Conditioned, expression: unknown, values: Record<string, string>): boolean {
  const e = expression as Record<string, unknown[]> & { Condition?: string };
  const valueOf = (value: unknown): unknown => (typeof value === "object" && value !== null && "Ref" in value ? values[(value as { Ref: string }).Ref] ?? template.Parameters[(value as { Ref: string }).Ref]?.Default : value);
  if (e.Condition !== undefined) return conditionHolds(template, template.Conditions![e.Condition], values);
  if (e["Fn::Equals"] !== undefined) return JSON.stringify(valueOf(e["Fn::Equals"][0])) === JSON.stringify(valueOf(e["Fn::Equals"][1]));
  if (e["Fn::Not"] !== undefined) return !conditionHolds(template, e["Fn::Not"][0], values);
  if (e["Fn::And"] !== undefined) return e["Fn::And"].every((part) => conditionHolds(template, part, values));
  if (e["Fn::Or"] !== undefined) return e["Fn::Or"].some((part) => conditionHolds(template, part, values));
  throw new Error(`test setup: unsupported condition ${JSON.stringify(expression)}`);
}

/** What a deploy of the template with these parameter values does about the canary function: the resources it creates, whether the template rule passes, and whether every value is allowed. */
export function canaryDeploy(template: Conditioned, values: Record<string, string>): { created: string[]; ruleOk: boolean; allowed: boolean } {
  const rules = Object.values(template.Rules ?? {}).filter((candidate) => JSON.stringify(candidate).includes("CanarySession"));
  expect(rules).toHaveLength(1);
  const ruleOk = !conditionHolds(template, rules[0]!.RuleCondition, values) || rules[0]!.Assertions.every((assertion) => conditionHolds(template, assertion.Assert, values));
  const allowed = Object.entries(values).every(([name, value]) => {
    const pattern = template.Parameters[name]!.AllowedPattern as string | undefined;
    return pattern === undefined || new RegExp(pattern, "u").test(value);
  });
  const created = Object.entries(template.Resources).filter(([, resource]) => resource.Condition === undefined || conditionHolds(template, { Condition: resource.Condition }, values)).map(([id]) => id).filter((id) => id.startsWith(PREFIX));
  return { created, ruleOk, allowed };
}
