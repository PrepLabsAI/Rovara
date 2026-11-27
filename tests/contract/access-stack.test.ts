import { Stack, type App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { ENVIRONMENT_PLACEHOLDER } from "@agentx/contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { SERVICE_ROLE_SERVICES, defaultBoundaryStatements, deployBoundaryStatements } from "../../infra/lib/access-policies.js";
import { actionsOutside, censusApp } from "../support/runtime-census.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

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

  const environmentResources = () => stacksOf(app).map((stack) => ({ stack, resources: resourcesOf(stack) }));
  /** The AWS service each resource type in the non-access templates is created through. */
  const resourceTypeServices = () => {
    const serviceOf = (type: string) => type.split("::")[1]!.toLowerCase().replace("apigatewayv2", "apigateway").replace("cognito", "cognito-idp").replace("applicationautoscaling", "application-autoscaling").replace("elasticloadbalancingv2", "elasticloadbalancing").replace("stepfunctions", "states");
    const types = new Set(environmentResources().filter(({ stack }) => stack.stackName !== "agentx-staging-access").flatMap(({ resources }) => Object.values(resources).map((r) => r.Type)));
    // AWS::CDK::Metadata is a CDK pseudo-resource, not an AWS service call. Custom resources are
    // backed by Lambda, so they need the lambda service. Roles, policies and instance profiles are
    // IAM, checked by action. AWS::Budgets::Budget (spec 015 phase 15d2, FR-047) is also checked by
    // action: the service role's scoped "Budget" Sid, never a budgets:* wildcard (SERVICE_ROLE_SERVICES
    // deliberately excludes "budgets"; only the permission boundary's ceiling still wildcards it).
    return new Set([...types].filter((t) => !["AWS::CDK::Metadata", "AWS::IAM::Role", "AWS::IAM::Policy", "AWS::IAM::InstanceProfile", "AWS::Budgets::Budget"].includes(t))
      .map((t) => (t.startsWith("Custom::") || t === "AWS::CloudFormation::CustomResource" ? "lambda" : serviceOf(t))));
  };
  /**
   * Every action of every role's inline statements in every environment template, except the service
   * role's own `Services` wildcards: those are derived from what the templates need, so counting them
   * as a need would make the "nothing unused" checks circular.
   */
  const usedActions = () => new Set(environmentResources().flatMap(({ stack, resources }) => roleStatements(resources)
    .filter((st) => !(stack.stackName === "agentx-staging-access" && st.Sid === "Services"))
    .flatMap((st) => [st.Action].flat())));

  it("exists only for named environments, first in the app", () => {
    expect(access).toBeDefined();
    expect(stacksOf(buildAgentXApp()).some((s) => s.stackName.toLowerCase().includes("access"))).toBe(false);
  });

  it("creates a private, encrypted, versioned artifact bucket kept on delete", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
      VersioningConfiguration: { Status: "Enabled" },
    });
    // Kept on delete and on replacement; a failed first create removes it (named-retention.test.ts).
    template.hasResource("AWS::S3::Bucket", { DeletionPolicy: "RetainExceptOnCreate", UpdateReplacePolicy: "Retain" });
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
    expect(Object.keys(template.toJSON().Outputs as object).sort()).toEqual(["ArtifactBucketName", "CloudFormationRoleArn", "DeployBoundaryArn", "EffectiveBoundaryArn", "OperatorRoleArn", "PullThroughPrefix"]);
  });

  it("declares its parameters with their exact allowed patterns (the operator principal is one role or user, never a whole account: L4-HARD)", () => {
    template.hasParameter("PermissionsBoundaryArn", { Type: "String", Default: "", AllowedPattern: "^$|^arn:aws[a-z-]*:iam::[0-9]{12}:policy/.+$" });
    template.hasParameter("OperatorPrincipalArn", { Type: "String", Default: "", AllowedPattern: "^$|^arn:aws[a-z-]*:iam::[0-9]{12}:(role|user)/.+$" });
    template.hasParameter("OperatorExternalId", { Type: "String", Default: "", AllowedPattern: "^$|^[\\w+=,.@:/-]{2,1224}$" });
  });

  const boundaryPolicies = Object.entries(template.findResources("AWS::IAM::ManagedPolicy") as Record<string, Resource>);
  const policyNamed = (name: string) => boundaryPolicies.find(([, policy]) => policy.Properties.ManagedPolicyName === name) ?? ["missing", undefined] as const;
  const [runtimeId, runtimePolicy] = policyNamed("agentx-staging-boundary");
  const [deployId, deployPolicy] = policyNamed("agentx-staging-deploy-boundary");
  // The RUNTIME boundary is what the roles CloudFormation creates must carry (the EffectiveBoundaryArn output); the DEPLOY boundary caps this stack's two roles.
  const effectiveBoundary = { "Fn::If": ["HasPermissionsBoundary", { Ref: "PermissionsBoundaryArn" }, { Ref: runtimeId }] };
  const effectiveDeployBoundary = { "Fn::If": ["HasPermissionsBoundary", { Ref: "PermissionsBoundaryArn" }, { Ref: deployId }] };
  const scopeFor = { env: "staging", partition: "aws", region: "us-east-1", account: "1", cloudFormationRoleName: "x" };

  it("creates the two default boundaries under the environment path only when no boundary is given", () => {
    expect(boundaryPolicies).toHaveLength(2);
    expect((template.toJSON() as { Conditions: Record<string, unknown> }).Conditions.UseDefaultBoundary).toEqual({ "Fn::Not": [{ Condition: "HasPermissionsBoundary" }] });
    for (const [policy, name, statementsOf] of [[runtimePolicy, "agentx-staging-boundary", defaultBoundaryStatements], [deployPolicy, "agentx-staging-deploy-boundary", deployBoundaryStatements]] as const) {
      expect(policy, name).toBeDefined();
      expect(policy!.Condition).toBe("UseDefaultBoundary");
      // Name and path make the ARNs arn:<partition>:iam::<account>:policy/agentx/staging/<name>, the ARNs every other stack names.
      expect(policy!.Properties.ManagedPolicyName).toBe(name);
      expect(policy!.Properties.Path).toBe("/agentx/staging/");
      const statements = (policy!.Properties.PolicyDocument as { Statement: Statement[] }).Statement;
      expect(statements.map((st) => st.Sid), name).toEqual(statementsOf(scopeFor).map((st) => st.Sid));
    }
  });

  it("applies the DEPLOY boundary to both access roles (the given boundary instead, when there is one), and outputs both", () => {
    template.hasResourceProperties("AWS::IAM::Role", { RoleName: "agentx-staging-cloudformation", PermissionsBoundary: effectiveDeployBoundary });
    template.hasResourceProperties("AWS::IAM::Role", { RoleName: "agentx-staging-operator", PermissionsBoundary: effectiveDeployBoundary });
    template.hasOutput("EffectiveBoundaryArn", { Value: effectiveBoundary });
    template.hasOutput("DeployBoundaryArn", { Value: effectiveDeployBoundary });
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

  it("lets each boundary allow every action the roles it caps use (the census)", () => {
    // AWS-managed policies attached through ManagedPolicyArns, with the service prefixes of the
    // actions in their current default versions (docs.aws.amazon.com/aws-managed-policy/latest/reference/).
    const MANAGED_POLICY_SERVICES: Record<string, string[]> = {
      AWSLambdaBasicExecutionRole: ["logs"],
      AWSLambdaVPCAccessExecutionRole: ["ec2", "logs"],
    };
    const all = stacksOf(app).map(resourcesOf);
    const managed = new Set(all.flatMap((resources) => Object.values(resources).filter((r) => r.Type === "AWS::IAM::Role")
      .flatMap((r) => (r.Properties.ManagedPolicyArns ?? []) as unknown[]).map((arn) => JSON.stringify(arn).match(/policy\/(?:service-role\/)?([A-Za-z0-9]+)/)![1]!)));
    expect([...managed].sort()).toEqual(Object.keys(MANAGED_POLICY_SERVICES).sort());
    const allowsOf = (policy: Resource | undefined) => (policy!.Properties.PolicyDocument as { Statement: Statement[] }).Statement.filter((st) => st.Effect === "Allow");
    const servicesOf = (allowed: Set<string>) => new Set([...allowed].filter((a) => a.endsWith(":*")).map((a) => a.split(":")[0]));
    const deployAllowed = new Set(allowsOf(deployPolicy).flatMap((st) => [st.Action].flat()));
    const runtimeAllowed = new Set(allowsOf(runtimePolicy).flatMap((st) => [st.Action].flat()));
    // The DEPLOY boundary caps the access stack's two roles: every action their inline statements use (less the service role's own Services wildcards, which are derived from the
    // templates) is allowed, no wildcard IAM, and every service the other stacks' resource types need is allowed by wildcard (or events by its rule).
    const accessActions = new Set(roleStatements(resourcesOf(access)).filter((st) => st.Sid !== "Services").flatMap((st) => [st.Action].flat()));
    const deployServices = servicesOf(deployAllowed);
    expect(deployServices.has("iam")).toBe(false);
    const neededServices = new Set([...resourceTypeServices(), ...Object.values(MANAGED_POLICY_SERVICES).flat().filter((s) => s !== "iam")]);
    expect([...neededServices].filter((service) => !deployServices.has(service) && !(service === "events" && deployAllowed.has("events:*")))).toEqual([]);
    // The service role's own boundary Deny action (DeleteRolePermissionsBoundary) is never needed as an allow.
    expect([...accessActions].filter((a) => a !== "iam:DeleteRolePermissionsBoundary" && !deployAllowed.has(a) && !deployServices.has(a.split(":")[0]))).toEqual([]);
    // Nothing the roles never use: every wildcard service is a resource type's service or used by an action.
    const used = new Set([...neededServices, ...[...usedActions()].map((a) => a.split(":")[0]!)]);
    expect([...deployServices].filter((service) => !used.has(service!))).toEqual([]);
    // The RUNTIME boundary caps every other role: every action THEIR statements use, in EVERY stack including the ones behind a context flag (tests/support/context-flags.ts turns every one
    // on; tests/contract/two-boundaries.test.ts checks the flags are enumerated from the code), is allowed by it (IAM, STS and SES only by name), and it has no IAM wildcard.
    const runtimeServices = servicesOf(runtimeAllowed);
    expect(runtimeServices.has("iam")).toBe(false);
    expect(actionsOutside(censusApp(), runtimeAllowed)).toEqual([]);
    for (const named of ["iam:PassRole", "iam:GetRole", "ses:SendEmail"]) expect(runtimeAllowed.has(named), named).toBe(true);
  }, 240_000);

  it("lets the service role and the DEPLOY boundary manage the EC2 workers' instance profile, by name and path, and the runtime boundary not at all", () => {
    const hasProfile = environmentResources().some(({ resources }) => Object.values(resources).some((r) => r.Type === "AWS::IAM::InstanceProfile"));
    expect(hasProfile).toBe(true);
    const profileStatement = (statements: Statement[]) => statements.find((st) => st.Sid === "IamInstanceProfiles");
    const service = profileStatement(roleStatements(template.toJSON().Resources as Record<string, Resource>))!;
    const boundary = profileStatement((deployPolicy!.Properties.PolicyDocument as { Statement: Statement[] }).Statement)!;
    for (const statement of [service, boundary]) {
      expect(statement.Action).toEqual(expect.arrayContaining(["iam:CreateInstanceProfile", "iam:AddRoleToInstanceProfile", "iam:DeleteInstanceProfile"]));
      expect(JSON.stringify(statement.Resource)).toContain("instance-profile/agentx/staging/*");
    }
    expect(profileStatement((runtimePolicy!.Properties.PolicyDocument as { Statement: Statement[] }).Statement)).toBeUndefined();
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
        Sid: "OperatorOfThisAccount", Effect: "Allow", Action: "sts:AssumeRole",
        Principal: { AWS: { "Fn::If": ["HasOperatorPrincipal", { Ref: "OperatorPrincipalArn" },
          { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":iam::", { Ref: "AWS::AccountId" }, ":root"]] }] } },
        Condition: { StringEquals: { "aws:PrincipalAccount": { Ref: "AWS::AccountId" } } },
      }, { "Fn::If": ["HasOperatorExternalId", {
        Sid: "NamedOperatorWithExternalId", Effect: "Allow", Action: "sts:AssumeRole",
        Principal: { AWS: { Ref: "OperatorPrincipalArn" } },
        Condition: { StringEquals: { "sts:ExternalId": { Ref: "OperatorExternalId" } } },
      }, { Ref: "AWS::NoValue" }] }] },
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

  it("lets the service role create every resource type the environment templates contain, and nothing unused", () => {
    const needed = resourceTypeServices();
    // events and route53resolver are granted by scoped statements (EcsFailureEventsRule; DnsFirewall and DnsFirewallList), never by wildcard.
    expect([...needed].filter((service) => !SERVICE_ROLE_SERVICES.includes(service) && service !== "events" && service !== "route53resolver")).toEqual([]);
    // The reverse: every wildcard service is created by some resource type or called by some role.
    const used = new Set([...needed, ...[...usedActions()].map((a) => a.split(":")[0]!)]);
    expect(SERVICE_ROLE_SERVICES.filter((service) => !used.has(service))).toEqual([]);
  }, 240_000);
});
