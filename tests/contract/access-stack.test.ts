import { Stack, type App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { ENVIRONMENT_PLACEHOLDER } from "@agentx/contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { SERVICE_ROLE_SERVICES, defaultBoundaryStatements } from "../../infra/lib/access-policies.js";

const stacksOf = (app: App) => app.node.children.filter((c): c is Stack => Stack.isStack(c));
type Statement = { Sid?: string; Effect: string; Action: string | string[]; Resource: unknown; Condition?: unknown };
type Resource = { Type: string; Condition?: string; Properties: Record<string, unknown> };
const resourcesOf = (stack: Stack) => Template.fromStack(stack).toJSON().Resources as Record<string, Resource>;
/** Every inline statement of every role: the role's own Policies and each AWS::IAM::Policy. */
function roleStatements(resources: Record<string, Resource>): Statement[] {
  return Object.values(resources).flatMap((r) => {
    if (r.Type === "AWS::IAM::Role") return ((r.Properties.Policies ?? []) as { PolicyDocument: { Statement: Statement[] } }[]).flatMap((p) => p.PolicyDocument.Statement);
    if (r.Type === "AWS::IAM::Policy") return (r.Properties.PolicyDocument as { Statement: Statement[] }).Statement;
    return [];
  });
}

describe("access stack", () => {
  const app = buildAgentXApp({ agentxEnv: "staging" });
  const access = stacksOf(app).find((s) => s.stackName === "agentx-staging-access")!;
  const template = Template.fromStack(access);

  it("exists only for named environments, first in the app", () => {
    expect(access).toBeDefined();
    expect(stacksOf(buildAgentXApp()).some((s) => s.stackName.toLowerCase().includes("access"))).toBe(false);
  });

  it("creates a private, encrypted, versioned artifact bucket kept on delete", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
      VersioningConfiguration: { Status: "Enabled" },
    });
    template.hasResource("AWS::S3::Bucket", { DeletionPolicy: "Retain" });
  });

  it("creates the pull-through cache rule for ECR Public", () => {
    template.hasResourceProperties("AWS::ECR::PullThroughCacheRule", { EcrRepositoryPrefix: "agentx-staging", UpstreamRegistryUrl: "public.ecr.aws" });
  });

  it("creates the CloudFormation service role and the operator role with fixed names", () => {
    template.hasResourceProperties("AWS::IAM::Role", { RoleName: "agentx-staging-cloudformation",
      AssumeRolePolicyDocument: Match.objectLike({ Statement: Match.arrayWith([Match.objectLike({ Principal: { Service: "cloudformation.amazonaws.com" } })]) }) });
    template.hasResourceProperties("AWS::IAM::Role", { RoleName: "agentx-staging-operator", MaxSessionDuration: 3600 });
  });

  it("outputs what later deploys need", () => {
    expect(Object.keys(template.toJSON().Outputs as object).sort()).toEqual(["ArtifactBucketName", "CloudFormationRoleArn", "EffectiveBoundaryArn", "OperatorRoleArn", "PullThroughPrefix"]);
  });

  it("declares both parameters with their exact allowed patterns", () => {
    template.hasParameter("PermissionsBoundaryArn", { Type: "String", Default: "", AllowedPattern: "^$|^arn:aws[a-z-]*:iam::[0-9]{12}:policy/.+$" });
    template.hasParameter("OperatorPrincipalArn", { Type: "String", Default: "", AllowedPattern: "^$|^arn:aws[a-z-]*:iam::[0-9]{12}:(root|role/.+|user/.+)$" });
  });

  const boundaryPolicies = Object.entries(template.findResources("AWS::IAM::ManagedPolicy") as Record<string, Resource>);
  const boundaryId = boundaryPolicies[0]?.[0] ?? "missing";
  const effectiveBoundary = { "Fn::If": ["HasPermissionsBoundary", { Ref: "PermissionsBoundaryArn" }, { Ref: boundaryId }] };

  it("creates the default boundary under the environment path only when no boundary is given", () => {
    expect(boundaryPolicies).toHaveLength(1);
    const [, policy] = boundaryPolicies[0]!;
    expect(policy.Condition).toBe("UseDefaultBoundary");
    expect((template.toJSON() as { Conditions: Record<string, unknown> }).Conditions.UseDefaultBoundary).toEqual({ "Fn::Not": [{ Condition: "HasPermissionsBoundary" }] });
    // Name and path make its ARN arn:<partition>:iam::<account>:policy/agentx/staging/agentx-staging-boundary,
    // the ARN every other stack names.
    expect(policy.Properties.ManagedPolicyName).toBe("agentx-staging-boundary");
    expect(policy.Properties.Path).toBe("/agentx/staging/");
    const statements = (policy.Properties.PolicyDocument as { Statement: Statement[] }).Statement;
    expect(statements.map((st) => st.Sid)).toEqual(defaultBoundaryStatements({ env: "staging", partition: "aws", account: "1", cloudFormationRoleName: "x" }).map((st) => st.Sid));
  });

  it("always applies a boundary to both access roles: the given one, else the default", () => {
    template.hasResourceProperties("AWS::IAM::Role", { RoleName: "agentx-staging-cloudformation", PermissionsBoundary: effectiveBoundary });
    template.hasResourceProperties("AWS::IAM::Role", { RoleName: "agentx-staging-operator", PermissionsBoundary: effectiveBoundary });
    template.hasOutput("EffectiveBoundaryArn", { Value: effectiveBoundary });
  });

  it("always emits both boundary Deny statements, naming the effective boundary", () => {
    const roles = Object.values(template.findResources("AWS::IAM::Role", { Properties: { RoleName: "agentx-staging-cloudformation" } }));
    expect(roles).toHaveLength(1);
    const statements = (roles[0] as { Properties: { Policies: { PolicyDocument: { Statement: Record<string, unknown>[] } }[] } }).Properties.Policies[0]!.PolicyDocument.Statement;
    expect(statements.filter((st) => "Fn::If" in st)).toEqual([]);
    const require = statements.find((st) => st.Sid === "IamRequireBoundary")!;
    expect(require.Effect).toBe("Deny");
    expect(require.Condition).toEqual({ StringNotEquals: { "iam:PermissionsBoundary": effectiveBoundary } });
    expect(statements.find((st) => st.Sid === "IamKeepBoundary")!.Effect).toBe("Deny");
  });

  it("lets the default boundary allow every action AgentX's roles use", () => {
    // AWS-managed policies attached through ManagedPolicyArns, with the service prefixes of the
    // actions in their current default versions (docs.aws.amazon.com/aws-managed-policy/latest/reference/).
    const MANAGED_POLICY_SERVICES: Record<string, string[]> = {
      AWSLambdaBasicExecutionRole: ["logs"],
      BedrockAgentCoreRuntimeInstancesOperatorRolePolicy: ["ec2", "autoscaling", "events", "iam"],
    };
    // The IAM actions of those managed policies, checked by name like the inline ones below.
    const MANAGED_POLICY_IAM_ACTIONS = ["iam:CreateServiceLinkedRole", "iam:PassRole"];
    const all = stacksOf(app).map(resourcesOf);
    const actions = new Set(all.flatMap(roleStatements).flatMap((st) => [st.Action].flat()));
    const managed = new Set(all.flatMap((resources) => Object.values(resources).filter((r) => r.Type === "AWS::IAM::Role")
      .flatMap((r) => (r.Properties.ManagedPolicyArns ?? []) as unknown[]).map((arn) => JSON.stringify(arn).match(/policy\/(?:service-role\/)?([A-Za-z0-9]+)/)![1]!)));
    expect([...managed].sort()).toEqual(Object.keys(MANAGED_POLICY_SERVICES).sort());

    const boundary = (boundaryPolicies[0]![1].Properties.PolicyDocument as { Statement: Statement[] }).Statement.filter((st) => st.Effect === "Allow");
    const allowed = new Set(boundary.flatMap((st) => [st.Action].flat()));
    const allowedServices = new Set([...allowed].filter((a) => a.endsWith(":*")).map((a) => a.split(":")[0]));
    expect(allowedServices.has("iam")).toBe(false);
    const needed = new Set([...[...actions].map((a) => a.split(":")[0]!), ...Object.values(MANAGED_POLICY_SERVICES).flat()]);
    expect([...needed].filter((service) => service !== "iam" && !allowedServices.has(service))).toEqual([]);
    const iamActions = [...[...actions].filter((a) => a.startsWith("iam:")), ...MANAGED_POLICY_IAM_ACTIONS];
    expect(iamActions.length).toBeGreaterThan(0);
    // The service role's own boundary Deny actions (DeleteRolePermissionsBoundary) are never needed as allows.
    expect(iamActions.filter((a) => a !== "iam:DeleteRolePermissionsBoundary" && !allowed.has(a))).toEqual([]);
    // Nothing the roles never use.
    expect([...allowedServices].filter((service) => !needed.has(service))).toEqual([]);
  }, 240_000);

  it("lets only CloudFormation in this account assume the service role", () => {
    template.hasResourceProperties("AWS::IAM::Role", {
      RoleName: "agentx-staging-cloudformation",
      AssumeRolePolicyDocument: { Version: "2012-10-17", Statement: [{
        Effect: "Allow", Principal: { Service: "cloudformation.amazonaws.com" }, Action: "sts:AssumeRole",
        Condition: { StringEquals: { "aws:SourceAccount": { Ref: "AWS::AccountId" } } },
      }] },
    });
  });

  it("trusts the given operator principal, or the account root when none is given", () => {
    template.hasResourceProperties("AWS::IAM::Role", {
      RoleName: "agentx-staging-operator",
      AssumeRolePolicyDocument: { Version: "2012-10-17", Statement: [{
        Effect: "Allow", Action: "sts:AssumeRole",
        Principal: { AWS: { "Fn::If": ["HasOperatorPrincipal", { Ref: "OperatorPrincipalArn" },
          { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":iam::", { Ref: "AWS::AccountId" }, ":root"]] }] } },
      }] },
    });
  });

  it("keeps the access roles at the root path", () => {
    for (const role of Object.values(template.findResources("AWS::IAM::Role"))) {
      expect((role as { Properties: Record<string, unknown> }).Properties.Path).toBeUndefined();
    }
  });

  it("names no literal region in the released access template, so it deploys in any region", () => {
    const released = buildAgentXApp({ agentxEnv: ENVIRONMENT_PLACEHOLDER, agentxSynthesizer: "legacy" }).synth();
    const text = JSON.stringify(released.getStackByName(`agentx-${ENVIRONMENT_PLACEHOLDER}-access`).template);
    expect(text).not.toContain("us-east-1");
    expect(text).toContain('"Ref":"AWS::Region"');
  }, 240_000);

  it("lets the service role create every resource type the environment templates contain", () => {
    const serviceOf = (type: string) => type.split("::")[1]!.toLowerCase().replace("bedrockagentcore", "bedrock-agentcore").replace("apigatewayv2", "apigateway").replace("cognito", "cognito-idp").replace("applicationautoscaling", "application-autoscaling");
    const types = new Set(stacksOf(app).filter((s) => s.stackName !== "agentx-staging-access")
      .flatMap((s) => Object.values(Template.fromStack(s).toJSON().Resources as Record<string, { Type: string }>).map((r) => r.Type)));
    // AWS::CDK::Metadata is a CDK pseudo-resource, not an AWS service call. Custom resources are
    // backed by Lambda, so they need the lambda service.
    const needed = [...types].filter((t) => t !== "AWS::CDK::Metadata" && t !== "AWS::IAM::Role" && t !== "AWS::IAM::Policy")
      .map((t) => (t.startsWith("Custom::") || t === "AWS::CloudFormation::CustomResource" ? "lambda" : serviceOf(t)));
    expect([...new Set(needed)].filter((service) => !SERVICE_ROLE_SERVICES.includes(service))).toEqual([]);
  }, 240_000);
});
