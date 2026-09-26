import { describe, expect, it } from "vitest";
import { SERVICE_ROLE_SERVICES, operatorRoleStatements, serviceRoleStatements, type PolicyScope } from "../../infra/lib/access-policies.js";

const scope: PolicyScope = {
  env: "staging", partition: "aws", region: "us-east-1", account: "123456789012",
  artifactBucketArn: "arn:aws:s3:::agentx-staging-access-artifactbucket-abc", pullThroughPrefix: "agentx-staging",
  cloudFormationRoleName: "agentx-staging-cloudformation",
};
// Inline and attached policy actions on roles: the regex below catches them by name, but they are
// role-scoped (the first test pins their resource to this environment's roles), not user, group or
// managed-policy management.
const ROLE_SCOPED_POLICY_ACTIONS = ["iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:AttachRolePolicy"];
const actions = (statements: ReturnType<typeof serviceRoleStatements>) => statements.flatMap((s) => s.Action);

describe("service role policy", () => {
  it("scopes every IAM action to roles named for the environment, except service-linked roles", () => {
    for (const statement of serviceRoleStatements(scope).filter((s) => s.Action.some((a) => a.startsWith("iam:")))) {
      const resources = [statement.Resource].flat();
      if (statement.Sid === "ServiceLinkedRoles") {
        expect(resources).toEqual(["arn:aws:iam::123456789012:role/aws-service-role/*"]);
        expect(statement.Condition?.StringLike?.["iam:AWSServiceName"]).toBeDefined();
      } else {
        expect(resources).toEqual(["arn:aws:iam::123456789012:role/agentx-staging-*"]);
      }
    }
  });

  it("adds the boundary rules only when a boundary is set, limited to the actions that carry the key", () => {
    expect(serviceRoleStatements(scope).some((s) => s.Sid === "IamRequireBoundary")).toBe(false);
    const withBoundary = serviceRoleStatements({ ...scope, permissionsBoundaryArn: "arn:aws:iam::123456789012:policy/Boundary" });
    const require = withBoundary.find((s) => s.Sid === "IamRequireBoundary")!;
    expect(require.Action.sort()).toEqual(["iam:CreateRole", "iam:PutRolePermissionsBoundary"]);
    expect(require.Condition).toEqual({ StringNotEquals: { "iam:PermissionsBoundary": "arn:aws:iam::123456789012:policy/Boundary" } });
    expect(withBoundary.find((s) => s.Sid === "IamKeepBoundary")!.Action).toEqual(["iam:DeleteRolePermissionsBoundary"]);
  });

  it("never grants iam:* or wildcard IAM user, group or policy management", () => {
    const all = actions(serviceRoleStatements(scope));
    expect(all).not.toContain("iam:*");
    expect(all.filter((a) => /^iam:(Create|Delete|Put|Attach).*(User|Group|Policy)$/.test(a) && !ROLE_SCOPED_POLICY_ACTIONS.includes(a))).toEqual([]);
  });

  it("allows only the listed services by wildcard", () => {
    const wildcard = serviceRoleStatements(scope).find((s) => s.Sid === "Services")!;
    expect(wildcard.Action).toEqual(SERVICE_ROLE_SERVICES.map((s) => `${s}:*`));
    expect(SERVICE_ROLE_SERVICES).not.toContain("iam");
    expect(SERVICE_ROLE_SERVICES).not.toContain("organizations");
    expect(SERVICE_ROLE_SERVICES).not.toContain("sts");
  });
});

describe("operator role policy", () => {
  it("has no wildcard actions", () => {
    expect(operatorRoleStatements(scope).flatMap((s) => s.Action).filter((a) => a.endsWith(":*") || a === "*")).toEqual([]);
  });

  it("may pass only the CloudFormation service role, and only to CloudFormation", () => {
    const pass = operatorRoleStatements(scope).filter((s) => s.Action.includes("iam:PassRole"));
    expect(pass).toHaveLength(1);
    expect(pass[0]!.Resource).toBe("arn:aws:iam::123456789012:role/agentx-staging-cloudformation");
    expect(pass[0]!.Condition).toEqual({ StringEquals: { "iam:PassedToService": "cloudformation.amazonaws.com" } });
    expect(operatorRoleStatements(scope).flatMap((s) => s.Action).filter((a) => a.startsWith("iam:") && a !== "iam:PassRole")).toEqual([]);
  });

  it("changes only this environment's stacks, settings and secrets", () => {
    const byId = Object.fromEntries(operatorRoleStatements(scope).map((s) => [s.Sid, [s.Resource].flat()]));
    expect(byId.Stacks).toEqual(["arn:aws:cloudformation:us-east-1:123456789012:stack/agentx-staging-*/*"]);
    expect(byId.Settings).toEqual(["arn:aws:ssm:us-east-1:123456789012:parameter/agentx/staging", "arn:aws:ssm:us-east-1:123456789012:parameter/agentx/staging/*"]);
    expect(byId.Secrets).toEqual(["arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/*"]);
  });
});
