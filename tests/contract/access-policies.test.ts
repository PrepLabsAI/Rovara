import { describe, expect, it } from "vitest";
import {
  BOUNDARY_SERVICES, SERVICE_ROLE_SERVICES, defaultBoundaryArn, defaultBoundaryName, defaultBoundaryStatements, operatorRoleStatements, serviceRoleStatements, type PolicyScope,
} from "../../infra/lib/access-policies.js";

const scope: PolicyScope = {
  env: "staging", partition: "aws", region: "us-east-1", account: "123456789012",
  artifactBucketArn: "arn:aws:s3:::agentx-staging-access-artifactbucket-abc", pullThroughPrefix: "agentx-staging",
  cloudFormationRoleName: "agentx-staging-cloudformation",
};
// Inline and attached policy actions on roles: the regex below catches them by name, but they are
// role-scoped (the first test pins their resource to this environment's role path), not user, group or
// managed-policy management.
const ROLE_SCOPED_POLICY_ACTIONS = ["iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:AttachRolePolicy"];
const actions = (statements: ReturnType<typeof serviceRoleStatements>) => statements.flatMap((s) => s.Action);

describe("service role policy", () => {
  it("scopes every IAM action to the environment's role path, except service-linked roles", () => {
    for (const statement of serviceRoleStatements(scope).filter((s) => s.Action.some((a) => a.startsWith("iam:")))) {
      const resources = [statement.Resource].flat();
      if (statement.Sid === "ServiceLinkedRoles") {
        expect(resources).toEqual(["arn:aws:iam::123456789012:role/aws-service-role/*"]);
        expect(statement.Condition?.StringLike?.["iam:AWSServiceName"]).toBeDefined();
      } else if (statement.Sid === "IamInstanceProfiles") {
        // The EC2 workers' instance profile, under the same path as the environment's roles.
        expect(resources).toEqual(["arn:aws:iam::123456789012:instance-profile/agentx/staging/*"]);
        expect(statement.Action.every((a) => /^iam:[A-Za-z]*InstanceProfile$/.test(a))).toBe(true);
      } else {
        // A path, not a name prefix: generated role names are truncated, and agentx-prod-* would
        // also match the prod-eu environment's roles.
        expect(resources).toEqual(["arn:aws:iam::123456789012:role/agentx/staging/*"]);
      }
    }
  });

  it("always denies creating or changing a role without the given boundary, limited to the actions that carry the key", () => {
    const withBoundary = serviceRoleStatements({ ...scope, permissionsBoundaryArn: "arn:aws:iam::123456789012:policy/Boundary" });
    const require = withBoundary.find((s) => s.Sid === "IamRequireBoundary")!;
    // Only actions that carry iam:PermissionsBoundary (CreateRole and PutRolePermissionsBoundary as
    // the new boundary, the role policy actions as the role's current one). For any other action
    // the key is absent, StringNotEquals is true, and the Deny would block it outright.
    expect(require.Action.sort()).toEqual([
      "iam:AttachRolePolicy", "iam:CreateRole", "iam:DeleteRolePolicy", "iam:DetachRolePolicy", "iam:PutRolePermissionsBoundary", "iam:PutRolePolicy",
    ]);
    for (const keyless of ["iam:UpdateAssumeRolePolicy", "iam:TagRole", "iam:UntagRole", "iam:DeleteRole", "iam:GetRole", "iam:UpdateRole", "iam:UpdateRoleDescription"]) {
      expect(require.Action).not.toContain(keyless);
    }
    expect([require.Resource].flat()).toEqual(["arn:aws:iam::123456789012:role/agentx/staging/*"]);
    expect([withBoundary.find((s) => s.Sid === "IamKeepBoundary")!.Resource].flat()).toEqual(["arn:aws:iam::123456789012:role/agentx/staging/*"]);
    expect(require.Condition).toEqual({ StringNotEquals: { "iam:PermissionsBoundary": "arn:aws:iam::123456789012:policy/Boundary" } });
    expect(withBoundary.find((s) => s.Sid === "IamKeepBoundary")!.Action).toEqual(["iam:DeleteRolePermissionsBoundary"]);
  });

  it("uses the default boundary in the Deny statements when no boundary is given", () => {
    const require = serviceRoleStatements(scope).find((s) => s.Sid === "IamRequireBoundary")!;
    expect(require.Condition).toEqual({ StringNotEquals: { "iam:PermissionsBoundary": "arn:aws:iam::123456789012:policy/agentx/staging/agentx-staging-boundary" } });
    expect(serviceRoleStatements(scope).some((s) => s.Sid === "IamKeepBoundary")).toBe(true);
  });

  it("may change a role's description", () => {
    expect(serviceRoleStatements(scope).find((s) => s.Sid === "IamRoles")!.Action).toContain("iam:UpdateRoleDescription");
  });

  it("creates only the ECS service-linked role", () => {
    const linked = serviceRoleStatements(scope).find((s) => s.Sid === "ServiceLinkedRoles")!;
    expect(linked.Condition).toEqual({ StringLike: { "iam:AWSServiceName": ["ecs.amazonaws.com"] } });
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

  it("may create, update, delete and tag only this environment's monthly budget, never by wildcard", () => {
    const budget = serviceRoleStatements(scope).find((s) => s.Sid === "Budget")!;
    expect(budget.Action.sort()).toEqual(["budgets:ListTagsForResource", "budgets:ModifyBudget", "budgets:TagResource", "budgets:UntagResource", "budgets:ViewBudget"]);
    // Exactly this one budget, never another: no wildcard suffix, no other environment's budget name.
    expect(budget.Resource).toBe("arn:aws:budgets::123456789012:budget/agentx-staging-monthly");
    expect(SERVICE_ROLE_SERVICES).not.toContain("budgets");
    expect(serviceRoleStatements(scope).find((s) => s.Sid === "Services")!.Action).not.toContain("budgets:*");
  });

  it("never grants the service role servicequotas, even by wildcard", () => {
    expect(serviceRoleStatements(scope).find((s) => s.Sid === "Services")!.Action).not.toContain("servicequotas:*");
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
    const stack = (part: string) => `arn:aws:cloudformation:us-east-1:123456789012:stack/agentx-staging-${part}/*`;
    const deployed = ["foundation", "identity", "runtime", "control-plane", "slack"].map(stack);
    expect(byId.Stacks).toEqual([stack("access"), ...deployed]);
    expect(byId.ChangeSets).toEqual(deployed);
    expect(byId.Settings).toEqual(["arn:aws:ssm:us-east-1:123456789012:parameter/agentx/staging", "arn:aws:ssm:us-east-1:123456789012:parameter/agentx/staging/*"]);
    expect(byId.Secrets).toEqual(["arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/staging/*"]);
  });

  it("can never change the access stack, and names every stack exactly", () => {
    const statements = operatorRoleStatements(scope);
    const changeSetStatements = statements.filter((s) => s.Action.some((a) => /ChangeSet/.test(a)));
    expect(changeSetStatements.map((s) => s.Sid)).toEqual(["ChangeSets"]);
    expect([changeSetStatements[0]!.Resource].flat().filter((r) => r.includes("agentx-staging-access"))).toEqual([]);
    const resources = statements.flatMap((s) => [s.Resource].flat());
    expect(resources.filter((r) => r.includes("agentx-staging-*"))).toEqual([]);
    const list = statements.find((s) => s.Action.includes("cloudformation:ListStacks"))!;
    expect(list.Action).toEqual(["cloudformation:ListStacks"]);
    expect(list.Resource).toBe("*");
  });

  it("checks models with InvokeModel only", () => {
    const models = operatorRoleStatements(scope).find((s) => s.Sid === "ModelChecks")!;
    expect(models.Action).toEqual(["bedrock:InvokeModel"]);
  });

  it("reads only this environment's stacks' logs", () => {
    const logs = operatorRoleStatements(scope).find((s) => s.Sid === "Logs")!;
    expect(logs.Action).toEqual(["logs:FilterLogEvents", "logs:StartQuery"]);
    const resources = [logs.Resource].flat();
    expect(resources).toContain("arn:aws:logs:us-east-1:123456789012:log-group:agentx-staging-control-plane-*");
    expect(resources.every((resource) => resource.includes(":log-group:agentx-staging-"))).toBe(true);
  });

  it("may turn on termination protection for the five stacks it deploys, and only those", () => {
    const statements = operatorRoleStatements(scope).filter((s) => s.Action.includes("cloudformation:UpdateTerminationProtection"));
    expect(statements.map((s) => s.Sid)).toEqual(["ChangeSets"]);
    const stack = (part: string) => `arn:aws:cloudformation:us-east-1:123456789012:stack/agentx-staging-${part}/*`;
    expect([statements[0]!.Resource].flat()).toEqual(["foundation", "identity", "runtime", "control-plane", "slack"].map(stack));
  });

  it("may create the environment's admin user only in a user pool tagged for this environment", () => {
    const admin = operatorRoleStatements(scope).find((s) => s.Sid === "AdminUser")!;
    expect(admin.Action.sort()).toEqual(["cognito-idp:AdminAddUserToGroup", "cognito-idp:AdminCreateUser", "cognito-idp:AdminGetUser", "cognito-idp:AdminListGroupsForUser"]);
    expect(admin.Resource).toBe("arn:aws:cognito-idp:us-east-1:123456789012:userpool/*");
    expect(admin.Condition).toEqual({ StringEquals: { "aws:ResourceTag/agentx:env": "staging" } });
  });

  it("may subscribe to and read only this environment's alert topic, and never publish or unsubscribe", () => {
    const statements = operatorRoleStatements(scope);
    const snsResources = new Set(statements.filter((s) => s.Action.some((a) => a.startsWith("sns:"))).flatMap((s) => [s.Resource].flat()));
    expect(snsResources).toEqual(new Set(["arn:aws:sns:us-east-1:123456789012:agentx-staging-alerts"]));
    expect(actions(statements).filter((a) => a.startsWith("sns:")).sort()).toEqual(["sns:ListSubscriptionsByTopic", "sns:Subscribe"]);
    expect(actions(statements)).not.toContain("sns:Publish");
    expect(actions(statements)).not.toContain("sns:Unsubscribe");
  });

  it("may subscribe only email or the alert webhook to the topic, never sqs, lambda or sms", () => {
    const subscribe = operatorRoleStatements(scope).find((s) => s.Action.includes("sns:Subscribe"))!;
    expect(subscribe.Action).toEqual(["sns:Subscribe"]);
    expect(subscribe.Resource).toBe("arn:aws:sns:us-east-1:123456789012:agentx-staging-alerts");
    expect(subscribe.Condition).toEqual({ StringEquals: { "sns:Protocol": ["email", "https"] } });
  });

  it("may flip only the test alarm, by its exact name", () => {
    const alarm = operatorRoleStatements(scope).find((s) => s.Sid === "TestAlarm")!;
    expect(alarm.Action.sort()).toEqual(["cloudwatch:DescribeAlarmHistory", "cloudwatch:SetAlarmState"]);
    // Exact, never agentx-staging-*: that would also match a sibling environment named staging-eu.
    expect(alarm.Resource).toBe("arn:aws:cloudwatch:us-east-1:123456789012:alarm:agentx-staging-TestAlarm");
  });

  it("may read only this environment's budget, and change none", () => {
    const budget = operatorRoleStatements(scope).find((s) => s.Sid === "Budget")!;
    expect(budget.Action).toEqual(["budgets:ViewBudget"]);
    expect(budget.Resource).toBe("arn:aws:budgets::123456789012:budget/agentx-staging-monthly");
    expect(actions(operatorRoleStatements(scope)).filter((a) => a.startsWith("budgets:"))).toEqual(["budgets:ViewBudget"]);
  });

  it("may read only the two EC2 quotas that prerequisites checks, not any other quota", () => {
    const quotas = operatorRoleStatements(scope).find((s) => s.Sid === "Quotas")!;
    expect(quotas.Action).toEqual(["servicequotas:GetServiceQuota"]);
    // Exactly the two quota codes prerequisites.ts checks (ServiceCode "ec2": the vCPU quota
    // L-1216C47A and the Elastic IP quota L-0263D0A3), never a wildcard:
    // arn:partition:servicequotas:region:account:serviceCode/quotaCode.
    expect(quotas.Resource).toEqual([
      "arn:aws:servicequotas:us-east-1:123456789012:ec2/L-1216C47A",
      "arn:aws:servicequotas:us-east-1:123456789012:ec2/L-0263D0A3",
    ]);
  });

  it("may count the region's Elastic IPs, and do nothing else with them, so the address check runs on an operator resume", () => {
    const addresses = operatorRoleStatements(scope).find((s) => s.Sid === "Addresses")!;
    // ec2:DescribeAddresses has no resource-level permissions, so "*" is the only Resource it takes.
    // The region condition keeps it to the environment's own region.
    expect(addresses).toEqual({ Sid: "Addresses", Effect: "Allow", Action: ["ec2:DescribeAddresses"], Resource: "*", Condition: { StringEquals: { "aws:RequestedRegion": "us-east-1" } } });
  });
});

describe("default permission boundary", () => {
  const statements = defaultBoundaryStatements(scope);
  const allows = statements.filter((s) => s.Effect === "Allow");
  const denies = statements.filter((s) => s.Effect === "Deny");

  it("has a deterministic name and ARN under the environment's IAM path", () => {
    expect(defaultBoundaryName("staging")).toBe("agentx-staging-boundary");
    expect(defaultBoundaryArn(scope)).toBe("arn:aws:iam::123456789012:policy/agentx/staging/agentx-staging-boundary");
  });

  it("allows each needed service by wildcard, never IAM, Organizations or Account", () => {
    const services = allows.find((s) => s.Sid === "Services")!;
    expect(services.Action).toEqual(BOUNDARY_SERVICES.map((s) => `${s}:*`));
    expect(services.Resource).toBe("*");
    for (const service of ["iam", "organizations", "account", "sts"]) expect(BOUNDARY_SERVICES).not.toContain(service);
    // The service role's own wildcard services must all pass the boundary it runs under.
    expect(SERVICE_ROLE_SERVICES.filter((s) => !BOUNDARY_SERVICES.includes(s))).toEqual([]);
  });

  it("allows only sts:GetCallerIdentity from STS, never AssumeRole", () => {
    const sts = allows.flatMap((s) => s.Action).filter((a) => a.startsWith("sts:"));
    expect(sts).toEqual(["sts:GetCallerIdentity"]);
    expect(allows.find((s) => s.Sid === "CallerIdentity")).toEqual({ Sid: "CallerIdentity", Effect: "Allow", Action: ["sts:GetCallerIdentity"], Resource: "*" });
    expect(allows.flatMap((s) => s.Action).filter((a) => a === "*" || a === "sts:*" || /^sts:AssumeRole/.test(a))).toEqual([]);
  });

  it("never allows iam:* or any user, group, access key, login profile or managed-policy action", () => {
    const iam = allows.flatMap((s) => s.Action).filter((a) => a.startsWith("iam:") || a === "*");
    expect(iam).not.toContain("iam:*");
    expect(iam).not.toContain("*");
    expect(iam.filter((a) => /User|Group|AccessKey|LoginProfile|PolicyVersion|^iam:(Create|Delete)Policy$|DefaultPolicyVersion/.test(a))).toEqual([]);
    expect(iam.filter((a) => a.includes("*"))).toEqual([]);
  });

  it("scopes role actions and PassRole to AgentX's own roles", () => {
    const byId = Object.fromEntries(allows.map((s) => [s.Sid, s]));
    expect([byId.IamRoles!.Resource].flat()).toEqual(["arn:aws:iam::123456789012:role/agentx/staging/*"]);
    expect(byId.IamRoles!.Action.every((a) => /^iam:[A-Za-z]*Role[A-Za-z]*$/.test(a))).toBe(true);
    expect([byId.PassRoles!.Resource].flat()).toEqual([
      "arn:aws:iam::123456789012:role/agentx/staging/*",
      "arn:aws:iam::123456789012:role/agentx-staging-cloudformation",
    ]);
    expect(byId.PassRoles!.Action).toEqual(["iam:PassRole"]);
    // No pass-role for retired runtime's default instance role: the capacity provider was removed (#118).
    expect(byId.PassDefaultInstanceRole).toBeUndefined();
    expect(byId.ServiceLinkedRoles).toEqual({
      Sid: "ServiceLinkedRoles", Effect: "Allow", Action: ["iam:CreateServiceLinkedRole"],
      Resource: "arn:aws:iam::123456789012:role/aws-service-role/*",
      Condition: { StringLike: { "iam:AWSServiceName": ["ecs.amazonaws.com"] } },
    });
  });

  it("explicitly denies account, organization, user, group and policy management, and changing itself", () => {
    expect(denies.map((s) => ({ Action: s.Action, Resource: s.Resource }))).toEqual([
      { Action: ["organizations:*", "account:*"], Resource: "*" },
      { Action: ["iam:*User*", "iam:*Group*"], Resource: "*" },
      { Action: ["iam:CreatePolicy*", "iam:*PolicyVersion*", "iam:DeletePolicy", "iam:SetDefaultPolicyVersion"], Resource: "*" },
      { Action: ["iam:*Policy*"], Resource: "arn:aws:iam::123456789012:policy/agentx/staging/agentx-staging-boundary" },
    ]);
    expect(denies.every((s) => s.Condition === undefined)).toBe(true);
  });

  it("keeps budgets as a wildcard ceiling: AWS Budgets' resource-level support for Modify/Tag is not independently confirmed", () => {
    const services = defaultBoundaryStatements(scope).find((s) => s.Sid === "Services")!.Action;
    expect(services).toContain("budgets:*");
    expect(BOUNDARY_SERVICES).toContain("budgets");
  });

  it("names the EC2 quota read like sts:GetCallerIdentity: by name, never servicequotas:*", () => {
    const services = defaultBoundaryStatements(scope).find((s) => s.Sid === "Services")!.Action;
    expect(services).not.toContain("servicequotas:*");
    expect(BOUNDARY_SERVICES).not.toContain("servicequotas");
    expect(allows.find((s) => s.Sid === "Quotas")).toEqual({ Sid: "Quotas", Effect: "Allow", Action: ["servicequotas:GetServiceQuota"], Resource: "*" });
  });
});
