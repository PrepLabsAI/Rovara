// #1579: CloudFormation looks a fixed-name role up by its PATH-LESS ARN before it creates it, and cleans it up by that ARN when a create rolls back.
// The deploy role and its boundary allow that only for the roles `IamFixedNameRolesNotYetCreated` lists (contracts access-policies.ts). A fixed-name
// role a later stack adds without a matching entry breaks every FRESH install at that stack (an install that already has the role never notices):
// the broker's role did exactly that from fc5df010e until #1579. This test synthesizes a named environment and requires every fixed-name role the
// deploy role creates to be listed.
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { deployBoundaryStatements, serviceRoleStatements, type PolicyScope } from "@agentx/contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";
skipLambdaBundling();

const ENV = "staging";
const scope: PolicyScope = {
  env: ENV, partition: "aws", region: "us-east-1", account: "123456789012",
  artifactBucketArn: "arn:aws:s3:::agentx-staging-access-artifactbucket-abc", pullThroughPrefix: "agentx-staging",
  cloudFormationRoleName: "agentx-staging-cloudformation",
};

/** The access stack is deployed by the installer's own credentials, not the deploy role, so its fixed-name roles need no lookup entry. */
const DEPLOYED_BY_CALLER = new Set([`agentx-${ENV}-access`]);

function fixedRoleNames(): Array<{ stack: string; logicalId: string; roleName: string }> {
  const stacks = buildAgentXApp({ agentxEnv: ENV, agentxSynthesizer: "legacy" }).node.children.filter((child): child is Stack => Stack.isStack(child));
  const found: Array<{ stack: string; logicalId: string; roleName: string }> = [];
  for (const stack of stacks) {
    if (DEPLOYED_BY_CALLER.has(stack.stackName)) continue;
    const resources = Template.fromStack(stack).toJSON().Resources as Record<string, { Type: string; Properties?: { RoleName?: unknown } }>;
    for (const [logicalId, resource] of Object.entries(resources)) {
      if (resource.Type !== "AWS::IAM::Role" || resource.Properties?.RoleName === undefined) continue;
      expect(typeof resource.Properties.RoleName, `${stack.stackName} ${logicalId}: a fixed role name must be a plain string to be listed`).toBe("string");
      found.push({ stack: stack.stackName, logicalId, roleName: resource.Properties.RoleName as string });
    }
  }
  return found;
}

/** IAM's resource wildcards: `*` is any run of characters, `?` exactly one. */
function iamPattern(arn: string): RegExp {
  return new RegExp(`^${arn.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
}

function listed(statements: ReturnType<typeof serviceRoleStatements>): string[] {
  const statement = statements.find((each) => each.Sid === "IamFixedNameRolesNotYetCreated");
  expect(statement, "the IamFixedNameRolesNotYetCreated statement").toBeDefined();
  return [statement!.Resource].flat();
}

describe("fixed-name roles a fresh install creates", () => {
  const roles = fixedRoleNames();

  it("finds the fixed-name roles of a named environment, the broker's among them", () => {
    expect(roles.map((role) => role.roleName)).toContain(`agentx-${ENV}-broker-role`);
  });

  for (const [label, statements] of [["the deploy role", serviceRoleStatements(scope)], ["the deploy boundary", deployBoundaryStatements(scope)]] as const) {
    it(`lists every one by its path-less ARN in ${label}'s IamFixedNameRolesNotYetCreated`, () => {
      const allowed = listed(statements).map(iamPattern);
      const missing = roles.filter((role) => !allowed.some((pattern) => pattern.test(`arn:aws:iam::123456789012:role/${role.roleName}`)));
      expect(missing, "add each to fixedNameRoleLookupStatement in packages/contracts/src/access-policies.ts").toEqual([]);
    });

    it(`matches nothing in ${label}'s IamFixedNameRolesNotYetCreated beyond those roles, the operator and deploy roles above all`, () => {
      const names = [...roles.map((role) => role.roleName), `agentx-${ENV}-cloudformation`, `agentx-${ENV}-operator`];
      const fixed = new Set(roles.map((role) => role.roleName));
      for (const pattern of listed(statements).map(iamPattern)) {
        const matched = names.filter((name) => pattern.test(`arn:aws:iam::123456789012:role/${name}`));
        expect(matched.length, String(pattern)).toBeGreaterThan(0);
        for (const name of matched) expect(fixed.has(name), `${String(pattern)} matches ${name}`).toBe(true);
      }
    });
  }
});
