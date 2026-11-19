// DEC 254zzz(2): the install company import's two sign-in table reads (DEC 254zzz29/254zzz32: the GetItem also takes the company's sign-in issuer row and email index), added to the named control-plane template as the broker's own role policy (BrokerCompanyImportReads).
// Each digest or snapshot test that pins the rest of the template asserts those two statements exactly, then takes the policy out (in place), so the pins it holds stay the
// ones recorded before this change: removing exactly this policy gives back the old template. The statements are also asserted in full, with the sign-in function's reads,
// in tests/contract/developer-signin-infrastructure.test.ts. A template with no such policy (the legacy deployment, production) is returned as it is.
import { expect } from "vitest";

type Resource = { Type: string; Properties: Record<string, unknown>; DependsOn?: string[] };
type Template = { Resources: Record<string, Resource> };

const POLICY_ID = /^DeveloperSignInBrokerCompanyImportReads[0-9A-F]{8}$/u;

export function withoutCompanyImportReads<T>(input: T): T {
  // DEC 254zzz33: the sign-in function's company grants are the same kind of named-only role policy, asserted and taken out with it (every pin that takes one out takes both).
  withoutSignInCompanyGrants(input);
  const resources = (input as unknown as Template).Resources;
  const found = Object.keys(resources).filter((id) => POLICY_ID.test(id));
  expect(found.length, "at most one BrokerCompanyImportReads policy").toBeLessThanOrEqual(1);
  if (found.length === 0) return input;
  const id = found[0]!;
  const policy = resources[id]!;
  expect(policy.Type).toBe("AWS::IAM::Policy");
  const tables = Object.keys(resources).filter((candidate) => candidate.startsWith("DeveloperSignInTable") && resources[candidate]!.Type === "AWS::DynamoDB::Table");
  expect(tables).toHaveLength(1);
  const resource = { "Fn::GetAtt": [tables[0]!, "Arn"] };
  const roles = Object.keys(resources).filter((candidate) => /^BrokerServiceRole[0-9A-F]{8}$/u.test(candidate) && resources[candidate]!.Type === "AWS::IAM::Role");
  expect(roles).toHaveLength(1);
  expect(policy.Properties.Roles).toEqual([{ Ref: roles[0]! }]);
  expect(Object.keys(policy.Properties).sort()).toEqual(["PolicyDocument", "PolicyName", "Roles"]);
  expect(policy.Properties.PolicyDocument).toEqual({
    Version: "2012-10-17",
    Statement: [
      { Action: "dynamodb:GetItem", Condition: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["ORG#org_????????????????????#COMPANY", "ORG#org_????????????????????#SIGNIN_ISSUER", "ORG#org_????????????????????#EMAIL#*"] }, Null: { "dynamodb:LeadingKeys": "false" } }, Effect: "Allow", Resource: resource },
      { Action: "dynamodb:Query", Condition: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["ORG#org_????????????????????#MEMBERS"] }, Null: { "dynamodb:LeadingKeys": "false" } }, Effect: "Allow", Resource: resource },
    ],
  });
  expect(Object.entries(resources).filter(([other, candidate]) => other !== id && JSON.stringify(candidate.DependsOn ?? []).includes(id)), "nothing depends on the policy").toEqual([]);
  delete resources[id];
  return input;
}

const SIGNIN_POLICY_ID = /^DeveloperSignInSignInCompanyGrants[0-9A-F]{8}$/u;
const NULL_GUARD = { Null: { "dynamodb:LeadingKeys": "false" } };
const keys = (...leading: string[]) => ({ "ForAllValues:StringLike": { "dynamodb:LeadingKeys": leading }, ...NULL_GUARD });

/** DEC 254zzz33: the sign-in function's company grants (SignInCompanyGrants), asserted exactly, then taken out in place. A template without it (legacy) is returned as it is. */
export function withoutSignInCompanyGrants<T>(input: T): T {
  const resources = (input as unknown as Template).Resources;
  const found = Object.keys(resources).filter((id) => SIGNIN_POLICY_ID.test(id));
  expect(found.length, "at most one SignInCompanyGrants policy").toBeLessThanOrEqual(1);
  if (found.length === 0) return input;
  const id = found[0]!;
  const policy = resources[id]!;
  expect(policy.Type).toBe("AWS::IAM::Policy");
  const tables = Object.keys(resources).filter((candidate) => candidate.startsWith("DeveloperSignInTable") && resources[candidate]!.Type === "AWS::DynamoDB::Table");
  expect(tables).toHaveLength(1);
  const resource = { "Fn::GetAtt": [tables[0]!, "Arn"] };
  const roles = Object.keys(resources).filter((candidate) => /^DeveloperSignInFunctionServiceRole[0-9A-F]{8}$/u.test(candidate) && resources[candidate]!.Type === "AWS::IAM::Role");
  expect(roles).toHaveLength(1);
  expect(policy.Properties.Roles).toEqual([{ Ref: roles[0]! }]);
  expect(Object.keys(policy.Properties).sort()).toEqual(["PolicyDocument", "PolicyName", "Roles"]);
  const statements = (policy.Properties.PolicyDocument as { Statement: Array<Record<string, unknown>> }).Statement;
  expect(statements.slice(0, 4)).toEqual([
    { Action: "dynamodb:ConditionCheckItem", Condition: keys("COMPANY_MEMBER#*", "COMPANY_SELF_SERVE", "DEVELOPER#*", "SESSION#*"), Effect: "Allow", Resource: resource },
    { Action: "dynamodb:Query", Condition: keys("ORG#org_????????????????????#MEMBERS", "ORG#org_????????????????????#PREAPPROVAL", "COMPANY_INVITE_CODES", "SIGNIN_LINKS#*"), Effect: "Allow", Resource: resource },
    { Action: "dynamodb:DeleteItem", Condition: keys("SIGNIN_LINKS#*"), Effect: "Allow", Resource: resource },
    { Action: "dynamodb:DeleteItem", Condition: keys("ORG#org_????????????????????#COMPANY", "ORG#org_????????????????????#MEMBERS", "COMPANY_MEMBER#*"), Effect: "Allow", Resource: resource },
  ]);
  expect(statements).toHaveLength(5);
  expect(statements[4]).toEqual({ Action: "secretsmanager:GetSecretValue", Effect: "Allow", Resource: expect.anything() as unknown });
  expect(JSON.stringify(statements[4]!.Resource)).toMatch(/:secret:agentx\/[a-z0-9-]+\/org-signin\/\*\/oidc-\?\?\?\?\?\?"/u);
  expect(Object.entries(resources).filter(([other, candidate]) => other !== id && JSON.stringify(candidate.DependsOn ?? []).includes(id)), "nothing depends on the policy").toEqual([]);
  delete resources[id];
  return input;
}
