// TWO-BOUNDARIES (owner's choice A): the RUNTIME boundary caps every role a merged template creates; the DEPLOY boundary caps only the CloudFormation service role and the operator role.
// This file proves, from the policy code and from the synthesized access template: who carries which boundary; that the census of what each role needs is still allowed; that every
// escalation by a deploy role or by a runtime role (F1 CloudFormation writes, F2 role and boundary writes, an edit of either boundary, an administrator policy on a runtime role) is
// refused; and that both boundaries fit their managed-policy limit at the longest environment name on the longest partition.
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import {
  defaultBoundaryArn, defaultBoundaryStatements, deployBoundaryArn, deployBoundaryStatements, operatorRoleStatements, serviceRoleStatements, type PolicyScope, type PolicyStatementJson,
} from "@agentx/contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { GATE_FLAGS_ON, LEGACY_ONLY_FLAGS, VALUE_KEYS, enumerateContextKeys } from "../support/context-flags.js";
import { KNOWN_OLD_GAPS, actionsOutside, censusApp, runtimeRoleActions } from "../support/runtime-census.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

const ACCOUNT = "111122223333";
const scope: PolicyScope = {
  env: "staging", partition: "aws", region: "us-west-2", account: ACCOUNT, artifactBucketArn: "arn:aws:s3:::agentx-staging-access-artifactbucket-abc", pullThroughPrefix: "agentx-staging",
  cloudFormationRoleName: "agentx-staging-cloudformation",
};
const RUNTIME_ARN = defaultBoundaryArn(scope);
const DEPLOY_ARN = deployBoundaryArn(scope);
const CFN_ROLE = `arn:aws:iam::${ACCOUNT}:role/agentx-staging-cloudformation`;
const OPERATOR_ROLE = `arn:aws:iam::${ACCOUNT}:role/agentx-staging-operator`;
const BROKER_ROLE = `arn:aws:iam::${ACCOUNT}:role/agentx/staging/agentx-staging-broker-role`;
const SOME_RUNTIME_ROLE = `arn:aws:iam::${ACCOUNT}:role/agentx/staging/agentx-staging-control-plane-SomeRole-ABC`;
const SLACK_ROLE = `arn:aws:iam::${ACCOUNT}:role/agentx/staging/agentx-staging-control-plane-SlackOrchestratorTaskRole-ABC`;
const READER_ROLE = `arn:aws:iam::${ACCOUNT}:role/agentx/staging/agentx-staging-slk`;
const CDK_EXEC_ROLE = `arn:aws:iam::${ACCOUNT}:role/cdk-hnb659fds-cfn-exec-role-${ACCOUNT}-us-west-2`;
const stackArn = (name: string) => `arn:aws:cloudformation:us-west-2:${ACCOUNT}:stack/${name}/11111111-2222-3333-4444-555555555555`;
const ADMIN: PolicyStatementJson[] = [{ Sid: "Admin", Effect: "Allow", Action: ["*"], Resource: "*" }];

// ---- a small evaluator with IAM's rules: explicit Deny in either document wins; otherwise the identity policy AND the boundary must each allow; an absent key makes StringNotEquals true
type Context = Record<string, string | string[]>;
const list = <T>(value: T | T[] | undefined): T[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);
const glob = (pattern: string, ignoreCase: boolean): RegExp => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/gu, "\\$&").replaceAll("*", ".*")}$`, ignoreCase ? "iu" : "u");
function conditionHolds(condition: PolicyStatementJson["Condition"], context: Context): boolean {
  if (condition === undefined) return true;
  return Object.entries(condition).every(([operator, keys]) => Object.entries(keys).every(([key, patterns]) => {
    const raw = context[key];
    const actual = raw === undefined ? [] : list(raw);
    const expected = list(patterns);
    const like = (value: string) => expected.some((pattern) => glob(pattern, false).test(value));
    switch (operator) {
      case "StringEquals": case "ArnEquals": return actual.some((value) => expected.includes(value));
      case "StringNotEquals": return !actual.some((value) => expected.includes(value));
      case "StringLike": return actual.some(like);
      case "ForAnyValue:StringLike": return actual.some(like);
      case "ForAllValues:StringLike": return actual.every(like);
      case "ForAllValues:StringEquals": return actual.every((value) => expected.includes(value));
      case "StringEqualsIfExists": return actual.length === 0 || actual.some((value) => expected.includes(value));
      case "Null": return (actual.length === 0) === (expected[0] === "true");
      case "Bool": return actual.some((value) => expected.includes(value));
      default: throw new Error(`the evaluator does not know the condition operator ${operator}`);
    }
  }));
}
const applies = (statement: PolicyStatementJson, action: string, resource: string, context: Context): boolean =>
  list(statement.Action).some((pattern) => glob(pattern, true).test(action))
  && (statement.NotResource !== undefined ? !list(statement.NotResource).some((pattern) => glob(pattern, false).test(resource)) : list(statement.Resource).some((pattern) => glob(pattern, false).test(resource)))
  && conditionHolds(statement.Condition, context);
type Verdict = "denied" | "allowed" | "not-allowed";
function effective(identity: PolicyStatementJson[], boundary: PolicyStatementJson[], action: string, resource: string, context: Context = {}): Verdict {
  const all = [...identity, ...boundary];
  if (all.some((statement) => statement.Effect === "Deny" && applies(statement, action, resource, context))) return "denied";
  const by = (document: PolicyStatementJson[]) => document.some((statement) => statement.Effect === "Allow" && applies(statement, action, resource, context));
  return by(identity) && by(boundary) ? "allowed" : "not-allowed";
}

const serviceRole = serviceRoleStatements(scope);
const operatorRole = operatorRoleStatements(scope);
const runtimeBoundary = defaultBoundaryStatements(scope);
const deployBoundary = deployBoundaryStatements(scope);
/** The service role and the operator role, each under the DEPLOY boundary, as the call `who` makes it. */
const deploy = { service: (a: string, r: string, c: Context = {}) => effective(serviceRole, deployBoundary, a, r, c), operator: (a: string, r: string, c: Context = {}) => effective(operatorRole, deployBoundary, a, r, c) };
/** A runtime role that was handed AdministratorAccess (the worst an escalation could attach), under the RUNTIME boundary. */
const adminOnRuntime = (a: string, r: string, c: Context = {}) => effective(ADMIN, runtimeBoundary, a, r, c);
const adminOnDeploy = (a: string, r: string, c: Context = {}) => effective(ADMIN, deployBoundary, a, r, c);
const withRole = (roleArn: string): Context => ({ "cloudformation:RoleArn": roleArn });

describe("who carries which boundary (the synthesized templates)", () => {
  const app = buildAgentXApp({ agentxEnv: "staging" });
  const stacks = app.node.children.filter((child): child is Stack => Stack.isStack(child));
  type Json = { Resources: Record<string, { Type: string; Properties: Record<string, unknown> }> };
  const json = (stack: Stack) => Template.fromStack(stack).toJSON() as Json;

  it("gives the CloudFormation service role and the operator role (and only them) the DEPLOY boundary, and every other role in every other stack the RUNTIME boundary's ARN", () => {
    const access = json(stacks.find((stack) => stack.stackName === "agentx-staging-access")!);
    const deployId = Object.entries(access.Resources).find(([, resource]) => resource.Type === "AWS::IAM::ManagedPolicy" && resource.Properties.ManagedPolicyName === "agentx-staging-deploy-boundary")![0];
    const deployEffective = { "Fn::If": ["HasPermissionsBoundary", { Ref: "PermissionsBoundaryArn" }, { Ref: deployId }] };
    const accessRoles = Object.entries(access.Resources).filter(([, resource]) => resource.Type === "AWS::IAM::Role");
    expect(accessRoles.map(([, resource]) => resource.Properties.RoleName).sort()).toEqual(["agentx-staging-cloudformation", "agentx-staging-operator"]);
    for (const [id, role] of accessRoles) expect(role.Properties.PermissionsBoundary, id).toEqual(deployEffective);
    const runtimeEffective = { "Fn::If": ["HasPermissionsBoundary", { Ref: "PermissionsBoundaryArn" }, { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":iam::", { Ref: "AWS::AccountId" }, ":policy/agentx/staging/agentx-staging-boundary"]] }] };
    let others = 0;
    for (const stack of stacks.filter((candidate) => candidate.stackName !== "agentx-staging-access")) {
      for (const [id, role] of Object.entries(json(stack).Resources).filter(([, resource]) => resource.Type === "AWS::IAM::Role")) {
        others += 1;
        expect(role.Properties.PermissionsBoundary, `${stack.stackName} ${id}`).toEqual(runtimeEffective);
      }
    }
    expect(others).toBeGreaterThan(10);
  }, 300_000);

  it("creates the deploy boundary beside the runtime one, under the same condition, at the same path", () => {
    const access = json(stacks.find((stack) => stack.stackName === "agentx-staging-access")!);
    const policies = Object.values(access.Resources).filter((resource) => resource.Type === "AWS::IAM::ManagedPolicy");
    expect(policies.map((resource) => resource.Properties.ManagedPolicyName).sort()).toEqual(["agentx-staging-boundary", "agentx-staging-deploy-boundary"]);
    for (const policy of policies) expect(policy.Properties.Path).toBe("/agentx/staging/");
  }, 300_000);
});

describe("the census: what each role needs is still allowed", () => {
  /** A concrete sample of an IAM pattern: `*` becomes "x". */
  const sample = (pattern: string) => pattern.replaceAll("*", "x");
  /** The request context an identity statement's own condition asks for, so the sample request can satisfy it. */
  const contextFor = (condition: PolicyStatementJson["Condition"]): Context => {
    const context: Context = {};
    for (const [operator, keys] of Object.entries(condition ?? {})) {
      if (!["StringEquals", "StringLike", "ArnEquals", "ForAnyValue:StringLike"].includes(operator)) continue;
      for (const [key, patterns] of Object.entries(keys)) context[key] = list(patterns).map(sample);
    }
    return context;
  };
  it("lets the DEPLOY boundary allow every action of the service role and the operator role, on a sample of every resource the statement names", () => {
    for (const [who, identity] of [["service role", serviceRole], ["operator role", operatorRole]] as const) {
      for (const statement of identity.filter((candidate) => candidate.Effect === "Allow")) {
        for (const action of list(statement.Action)) {
          for (const resource of list(statement.Resource).map(sample)) {
            // A role call carries the runtime boundary (what the deploy boundary asks of it); the statement's own condition keys are added.
            const verdict = effective([statement], deployBoundary, sample(action), resource, { "iam:PermissionsBoundary": RUNTIME_ARN, ...contextFor(statement.Condition) });
            expect(verdict, `${who} ${statement.Sid} ${action} on ${resource}`).not.toBe("not-allowed");
          }
        }
      }
    }
  });

  it("lets the RUNTIME boundary allow what runtime roles use: PassRole on the environment's roles, the one email send, and the services", () => {
    expect(adminOnRuntime("iam:PassRole", SOME_RUNTIME_ROLE)).toBe("allowed");
    expect(adminOnRuntime("ses:SendEmail", `arn:aws:ses:us-west-2:${ACCOUNT}:identity/a@example.com`)).toBe("allowed");
    for (const action of ["dynamodb:GetItem", "s3:PutObject", "lambda:InvokeFunction", "secretsmanager:GetSecretValue", "kms:Decrypt", "bedrock:InvokeModel", "sqs:SendMessage", "states:StartExecution", "ec2:RunInstances"]) {
      expect(adminOnRuntime(action, "*"), action).toBe("allowed");
    }
    // The broker's assume of the saved environment image roles, and the Slack service's of its token reader role.
    const img = `arn:aws:iam::${ACCOUNT}:role/agentx/staging/agentx-staging-img-push`;
    expect(adminOnRuntime("sts:AssumeRole", img, { "aws:PrincipalArn": BROKER_ROLE })).toBe("allowed");
    expect(adminOnRuntime("sts:AssumeRole", READER_ROLE)).toBe("allowed");
    expect(adminOnRuntime("sts:TagSession", READER_ROLE)).toBe("allowed");
  });

  it("keeps what only the deploy roles use out of the RUNTIME boundary (role and instance-profile management, service-linked roles, DNS firewall, events, quotas, caller identity)", () => {
    const cases: Array<[string, string, Context?]> = [
      ["iam:CreateRole", `arn:aws:iam::${ACCOUNT}:role/agentx/staging/new`, { "iam:PermissionsBoundary": RUNTIME_ARN }],
      ["iam:GetRolePolicy", SOME_RUNTIME_ROLE], ["iam:UpdateAssumeRolePolicy", SOME_RUNTIME_ROLE], ["iam:CreateInstanceProfile", `arn:aws:iam::${ACCOUNT}:instance-profile/agentx/staging/x`],
      ["iam:CreateServiceLinkedRole", `arn:aws:iam::${ACCOUNT}:role/aws-service-role/ecs.amazonaws.com/x`, { "iam:AWSServiceName": "ecs.amazonaws.com" }],
      ["route53resolver:CreateFirewallRuleGroup", `arn:aws:route53resolver:us-west-2:${ACCOUNT}:firewall-rule-group/x`], ["events:PutRule", `arn:aws:events:us-west-2:${ACCOUNT}:rule/agentx-staging-x-service-failures`],
      ["servicequotas:GetServiceQuota", "*"], ["sts:GetCallerIdentity", "*"],
    ];
    for (const [action, resource, context] of cases) expect(adminOnRuntime(action, resource, context ?? {}), action).toBe("not-allowed");
  });
});

describe("the census covers every context-gated stack (a new flag cannot hide a role)", () => {
  it("classifies every context key the infra code reads: a gate the census turns on, a value key, or a legacy-only flag", () => {
    const classified = new Set([...Object.keys(GATE_FLAGS_ON), ...VALUE_KEYS, ...LEGACY_ONLY_FLAGS]);
    const read = enumerateContextKeys();
    expect(read.filter((key) => !classified.has(key)), "a new context key: turn it on in GATE_FLAGS_ON (it gates resources) or list it in VALUE_KEYS / LEGACY_ONLY_FLAGS (tests/support/context-flags.ts)").toEqual([]);
    // No stale gate: every flag the census turns on is still read by the code.
    expect(Object.keys(GATE_FLAGS_ON).filter((key) => !read.includes(key))).toEqual([]);
  });

  it("really synthesizes the gated stacks and resources with the flags on (the installer, the CI runner and eval stacks; the requalify machine and the qualification transport)", () => {
    const app = censusApp();
    const censusStacks = app.node.children.filter((child): child is Stack => Stack.isStack(child));
    const names = censusStacks.map((stack) => stack.stackName);
    expect(names).toEqual(expect.arrayContaining(["AgentXInstaller", "AgentXCiRunner", "agentx-staging-eval", "agentx-staging-control-plane"]));
    const controlPlane = JSON.stringify(Template.fromStack(censusStacks.find((stack) => stack.stackName === "agentx-staging-control-plane")!).toJSON());
    expect(controlPlane).toContain("RuntimeRequalify");
    expect(controlPlane).toContain("E2eQualificationTransport");
  }, 300_000);

  it("finds the requalify machine's GetRole (and the transport's policies) among the runtime roles' actions, and the runtime boundary allows it, read-only on the environment's roles", () => {
    const actions = runtimeRoleActions(censusApp());
    expect([...actions.get("agentx-staging-control-plane")!]).toContain("iam:GetRole");
    expect(adminOnRuntime("iam:GetRole", SOME_RUNTIME_ROLE)).toBe("allowed");
    expect(adminOnRuntime("iam:GetRole", CFN_ROLE)).toBe("not-allowed");
    expect(adminOnRuntime("iam:GetRole", `arn:aws:iam::${ACCOUNT}:role/agentx/prod/other`)).toBe("not-allowed");
    for (const write of ["iam:GetRolePolicy", "iam:ListRolePolicies", "iam:UpdateRole", "iam:TagRole", "iam:DeleteRole", "iam:CreateRole"]) expect(adminOnRuntime(write, SOME_RUNTIME_ROLE), write).not.toBe("allowed");
  }, 300_000);

  it("allows every action every stack's roles use, with every flag on (a pinned pre-existing gap aside: no boundary ever allowed the CI runner's connection actions)", () => {
    const allowed = new Set(runtimeBoundary.filter((statement) => statement.Effect === "Allow").flatMap((statement) => statement.Action));
    expect(actionsOutside(censusApp(), allowed)).toEqual([]);
    // The pinned gaps are real gaps in the deploy boundary too (so the single boundary before did not allow them either): nothing the split removed hides here.
    const deployAllowed = new Set(deployBoundary.filter((statement) => statement.Effect === "Allow").flatMap((statement) => statement.Action));
    for (const action of Object.values(KNOWN_OLD_GAPS).flat()) expect(deployAllowed.has(action) || [...deployAllowed].some((a) => a.endsWith(":*") && action.startsWith(a.slice(0, -1))), action).toBe(false);
  }, 300_000);
});

describe("the worker's quota read (DEC 432)", () => {
  it("lets the worker's ListServiceQuotas through the runtime boundary, and nothing else in servicequotas (no Get, Request, Put, Associate, Delete, Tag)", () => {
    expect(adminOnRuntime("servicequotas:ListServiceQuotas", "*")).toBe("allowed");
    for (const action of ["servicequotas:GetServiceQuota", "servicequotas:GetAWSDefaultServiceQuota", "servicequotas:ListAWSDefaultServiceQuotas", "servicequotas:RequestServiceQuotaIncrease", "servicequotas:PutServiceQuotaIncreaseRequestIntoTemplate", "servicequotas:AssociateServiceQuotaTemplate", "servicequotas:DeleteServiceQuotaIncreaseRequestFromTemplate", "servicequotas:TagResource", "servicequotas:*"]) {
      expect(adminOnRuntime(action, "*"), action).toBe("not-allowed");
    }
    // The grant the worker's instance role carries for it is the List alone (the template side is pinned in ec2-worker-infrastructure.test.ts).
    const quotaActions = runtimeRoleActions(censusApp());
    const all = [...quotaActions.values()].flatMap((actions) => [...actions]).filter((action) => action.startsWith("servicequotas:"));
    expect([...new Set(all)]).toEqual(["servicequotas:ListServiceQuotas"]);
  }, 300_000);
});

describe("escalation by the deploy roles (the service role and the operator role under the DEPLOY boundary)", () => {
  it("F1: CloudFormation writes only through the environment's CloudFormation role, and only on the environment's stacks", () => {
    const env = stackArn("agentx-staging-control-plane");
    for (const action of ["cloudformation:CreateStack", "cloudformation:UpdateStack", "cloudformation:CreateChangeSet"]) {
      for (const who of ["service", "operator"] as const) {
        expect(deploy[who](action, env, withRole(CDK_EXEC_ROLE)), `${who} ${action} as the CDK role`).toBe("denied");
        expect(deploy[who](action, env), `${who} ${action} with no role`).toBe("denied");
      }
      expect(adminOnDeploy(action, env, withRole(CFN_ROLE)), `${action} through the environment's role`).toBe("allowed");
    }
    for (const action of ["cloudformation:UpdateStack", "cloudformation:DeleteStack", "cloudformation:ExecuteChangeSet", "cloudformation:CreateChangeSet"]) {
      for (const outside of ["CDKToolkit", "agentx-prod-control-plane", "rovara-staging-code-release-pipeline", "agentx-staging-access"]) {
        for (const who of ["service", "operator"] as const) expect(deploy[who](action, stackArn(outside), withRole(CFN_ROLE)), `${who} ${action} ${outside}`).toBe("denied");
        expect(adminOnDeploy(action, stackArn(outside), withRole(CFN_ROLE)), `admin ${action} ${outside}`).toBe("denied");
      }
    }
  });

  it("F2: a role can be created, rebounded or changed only with the RUNTIME boundary, and never unbounded or bounded by the deploy boundary or an administrator policy", () => {
    const newRole = `arn:aws:iam::${ACCOUNT}:role/agentx/staging/new-role`;
    const ADMIN_POLICY = "arn:aws:iam::aws:policy/AdministratorAccess";
    for (const boundaryBeingSet of [undefined, ADMIN_POLICY, DEPLOY_ARN, `arn:aws:iam::${ACCOUNT}:policy/other`]) {
      const context: Context = boundaryBeingSet === undefined ? {} : { "iam:PermissionsBoundary": boundaryBeingSet };
      for (const action of ["iam:CreateRole", "iam:PutRolePermissionsBoundary"]) {
        expect(deploy.service(action, newRole, context), `${action} ${boundaryBeingSet}`).not.toBe("allowed");
        expect(adminOnDeploy(action, newRole, context), `admin ${action} ${boundaryBeingSet}`).not.toBe("allowed");
      }
    }
    expect(deploy.service("iam:CreateRole", newRole, { "iam:PermissionsBoundary": RUNTIME_ARN })).toBe("allowed");
    expect(deploy.service("iam:PutRolePermissionsBoundary", newRole, { "iam:PermissionsBoundary": RUNTIME_ARN })).toBe("allowed");
    // The policy actions (attach AdministratorAccess included) only on a role that already carries the runtime boundary; never on a root-path role (the two deploy roles) whatever it carries.
    for (const action of ["iam:AttachRolePolicy", "iam:DetachRolePolicy", "iam:PutRolePolicy", "iam:DeleteRolePolicy"]) {
      for (const carried of [undefined, DEPLOY_ARN, `arn:aws:iam::${ACCOUNT}:policy/other`]) {
        const context: Context = carried === undefined ? {} : { "iam:PermissionsBoundary": carried };
        expect(deploy.service(action, SOME_RUNTIME_ROLE, context), `${action} on a role carrying ${carried}`).not.toBe("allowed");
      }
      expect(deploy.service(action, SOME_RUNTIME_ROLE, { "iam:PermissionsBoundary": RUNTIME_ARN })).toBe("allowed");
      for (const rootRole of [CFN_ROLE, OPERATOR_ROLE]) expect(deploy.service(action, rootRole, { "iam:PermissionsBoundary": RUNTIME_ARN }), `${action} on ${rootRole}`).not.toBe("allowed");
    }
  });

  it("F2: no role boundary is ever removed, whatever the role carries", () => {
    for (const context of [{}, { "iam:PermissionsBoundary": RUNTIME_ARN }, { "iam:PermissionsBoundary": DEPLOY_ARN }]) {
      for (const role of [SOME_RUNTIME_ROLE, CFN_ROLE, OPERATOR_ROLE]) {
        // On the environment's roles an explicit Deny; on the two root-path deploy roles there is no Allow at all (the Deny's resource is the environment's path).
        expect(deploy.service("iam:DeleteRolePermissionsBoundary", role, context)).toBe(role === SOME_RUNTIME_ROLE ? "denied" : "not-allowed");
        expect(deploy.operator("iam:DeleteRolePermissionsBoundary", role, context)).not.toBe("allowed");
        expect(adminOnDeploy("iam:DeleteRolePermissionsBoundary", role, context)).not.toBe("allowed");
      }
      expect(adminOnRuntime("iam:DeleteRolePermissionsBoundary", SOME_RUNTIME_ROLE, context)).toBe("denied");
    }
  });

  it("neither boundary can be edited by a role that carries either", () => {
    for (const policy of [RUNTIME_ARN, DEPLOY_ARN]) {
      for (const action of ["iam:CreatePolicyVersion", "iam:DeletePolicy", "iam:SetDefaultPolicyVersion", "iam:DeletePolicyVersion", "iam:TagPolicy", "iam:AttachRolePolicy"]) {
        expect(adminOnDeploy(action, policy), `deploy ${action} ${policy}`).toBe("denied");
        expect(adminOnRuntime(action, policy), `runtime ${action} ${policy}`).toBe("denied");
        expect(deploy.service(action, policy), `service ${action} ${policy}`).not.toBe("allowed");
      }
    }
  });
});

describe("escalation by a runtime role (an administrator policy attached, under the RUNTIME boundary)", () => {
  it("cannot manage roles, users, groups, policies or boundaries, create a service-linked role or an instance profile", () => {
    for (const [action, resource] of [
      ["iam:CreateRole", `arn:aws:iam::${ACCOUNT}:role/agentx/staging/new`], ["iam:CreateUser", `arn:aws:iam::${ACCOUNT}:user/x`], ["iam:CreateGroup", `arn:aws:iam::${ACCOUNT}:group/x`],
      ["iam:CreatePolicy", `arn:aws:iam::${ACCOUNT}:policy/x`], ["iam:AttachRolePolicy", SOME_RUNTIME_ROLE], ["iam:PutRolePermissionsBoundary", SOME_RUNTIME_ROLE],
      ["iam:UpdateAssumeRolePolicy", SOME_RUNTIME_ROLE], ["iam:CreateServiceLinkedRole", `arn:aws:iam::${ACCOUNT}:role/aws-service-role/ecs.amazonaws.com/x`],
      ["organizations:CreateAccount", "*"], ["account:CloseAccount", "*"],
    ] as const) expect(adminOnRuntime(action, resource), action).not.toBe("allowed");
  });

  it("cannot assume the CloudFormation role, the operator role, the CDK roles, another environment's roles, or the image roles as anyone but the broker", () => {
    const img = `arn:aws:iam::${ACCOUNT}:role/agentx/staging/agentx-staging-img-push`;
    for (const target of [CFN_ROLE, OPERATOR_ROLE, CDK_EXEC_ROLE, `arn:aws:iam::${ACCOUNT}:role/agentx/prod/agentx-prod-img-push`, `arn:aws:iam::${ACCOUNT}:role/agentx/staging/agentx-staging-company-secrets`]) {
      expect(adminOnRuntime("sts:AssumeRole", target, { "aws:PrincipalArn": BROKER_ROLE }), target).toBe("not-allowed");
    }
    expect(adminOnRuntime("sts:AssumeRole", img, { "aws:PrincipalArn": SLACK_ROLE })).toBe("not-allowed");
    expect(adminOnRuntime("sts:AssumeRole", img, { "aws:PrincipalArn": BROKER_ROLE })).toBe("allowed");
    for (const action of ["sts:AssumeRoleWithWebIdentity", "sts:GetFederationToken", "sts:*"]) expect(adminOnRuntime(action, img, { "aws:PrincipalArn": BROKER_ROLE }), action).toBe("not-allowed");
  });

  it("cannot write CloudFormation without the environment's role or outside the environment's stacks, nor touch the release pipeline", () => {
    expect(adminOnRuntime("cloudformation:UpdateStack", stackArn("agentx-staging-control-plane"), withRole(CDK_EXEC_ROLE))).toBe("denied");
    expect(adminOnRuntime("cloudformation:CreateChangeSet", stackArn("agentx-staging-control-plane"))).toBe("denied");
    expect(adminOnRuntime("cloudformation:DeleteStack", stackArn("CDKToolkit"), withRole(CFN_ROLE))).toBe("denied");
    expect(adminOnRuntime("ssm:PutParameter", `arn:aws:ssm:us-west-2:${ACCOUNT}:parameter/rovara-release/staging/policy-pin`)).toBe("denied");
    expect(adminOnRuntime("secretsmanager:GetSecretValue", `arn:aws:secretsmanager:us-west-2:${ACCOUNT}:secret:rovara-release/staging/canary-credential-abc`)).toBe("denied");
    expect(adminOnDeploy("ssm:PutParameter", `arn:aws:ssm:us-west-2:${ACCOUNT}:parameter/rovara-release/staging/policy-pin`)).toBe("denied");
  });
});

describe("size: both boundaries fit their managed-policy limit with headroom, at the longest environment name on the longest partition", () => {
  const size = (statements: typeof defaultBoundaryStatements, env: string, partition: string) =>
    JSON.stringify({ Version: "2012-10-17", Statement: statements({ env, partition, region: partition === "aws" ? "us-west-2" : "us-gov-west-1", account: ACCOUNT, cloudFormationRoleName: `agentx-${env}-cloudformation` }) }).replace(/\s/gu, "").length;
  it("keeps the runtime boundary at least 2,000 characters and the deploy boundary at least 300 under 6,144", () => {
    for (const env of ["staging", "a".repeat(20)]) {
      for (const partition of ["aws", "aws-us-gov"]) {
        expect(size(defaultBoundaryStatements, env, partition), `runtime ${env.length} ${partition}`).toBeLessThanOrEqual(6144 - 2000);
        expect(size(deployBoundaryStatements, env, partition), `deploy ${env.length} ${partition}`).toBeLessThanOrEqual(6144 - 300);
      }
    }
  });
});
