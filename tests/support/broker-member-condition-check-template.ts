import { expect } from "vitest";
import { withoutBrokerCodeBuildStart } from "./broker-codebuild-start-template.js";

type Resource = { Type: string; Properties: Record<string, unknown> };

// SIGNIN-MEMBER-CONDITIONCHECK, DEC 254zzz282 B014-A: pin the one new statement
// exactly before removing it from historical template comparisons. Never remove a policy.
export function withoutBrokerMemberConditionCheck<T>(input: T): T {
  const copy = structuredClone(input);
  // BROKER-CODEBUILD-START: the broker's CodeBuild CodeBuild start policy (both control planes) is asserted exactly and taken out here too, so every pin that takes the member
  // check out keeps the bytes it recorded before that policy existed.
  withoutBrokerCodeBuildStart(copy);
  const resources = (copy as { Resources: Record<string, Resource> }).Resources;
  const idsOf = (prefix: string, type: string) => Object.keys(resources)
    .filter((id) => id.startsWith(prefix) && resources[id]!.Type === type);
  const policies = idsOf("DeveloperSignInBrokerCompanyImportReads", "AWS::IAM::Policy");
  const roles = idsOf("BrokerServiceRole", "AWS::IAM::Role");
  const tables = idsOf("DeveloperSignInTable", "AWS::DynamoDB::Table");
  expect(policies).toHaveLength(1);
  expect(roles).toHaveLength(1);
  expect(tables).toHaveLength(1);
  const policy = resources[policies[0]!]!;
  expect(policy.Properties.Roles).toStrictEqual([{ Ref: roles[0]! }]);
  const document = policy.Properties.PolicyDocument as { Statement: unknown[] };
  expect(document.Statement[0]).toStrictEqual({
    Action: "dynamodb:ConditionCheckItem",
    Condition: {
      "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["COMPANY_MEMBER#*"] },
      Null: { "dynamodb:LeadingKeys": "false" },
    },
    Effect: "Allow",
    Resource: { "Fn::GetAtt": [tables[0]!, "Arn"] },
  });
  document.Statement.splice(0, 1);
  return copy;
}
