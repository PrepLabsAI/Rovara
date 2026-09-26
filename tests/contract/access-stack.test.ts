import { Stack, type App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { ENVIRONMENT_PLACEHOLDER } from "@agentx/contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { SERVICE_ROLE_SERVICES } from "../../infra/lib/access-policies.js";

const stacksOf = (app: App) => app.node.children.filter((c): c is Stack => Stack.isStack(c));

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
    expect(Object.keys(template.toJSON().Outputs as object).sort()).toEqual(["ArtifactBucketName", "CloudFormationRoleArn", "OperatorRoleArn", "PullThroughPrefix"]);
  });

  it("declares both parameters with their exact allowed patterns", () => {
    template.hasParameter("PermissionsBoundaryArn", { Type: "String", Default: "", AllowedPattern: "^$|^arn:aws[a-z-]*:iam::[0-9]{12}:policy/.+$" });
    template.hasParameter("OperatorPrincipalArn", { Type: "String", Default: "", AllowedPattern: "^$|^arn:aws[a-z-]*:iam::[0-9]{12}:(root|role/.+|user/.+)$" });
  });

  it("applies the boundary to both access roles only when one is given", () => {
    const boundary = { "Fn::If": ["HasPermissionsBoundary", { Ref: "PermissionsBoundaryArn" }, { Ref: "AWS::NoValue" }] };
    template.hasResourceProperties("AWS::IAM::Role", { RoleName: "agentx-staging-cloudformation", PermissionsBoundary: boundary });
    template.hasResourceProperties("AWS::IAM::Role", { RoleName: "agentx-staging-operator", PermissionsBoundary: boundary });
  });

  it("emits both boundary Deny statements only under HasPermissionsBoundary", () => {
    const roles = Object.values(template.findResources("AWS::IAM::Role", { Properties: { RoleName: "agentx-staging-cloudformation" } }));
    expect(roles).toHaveLength(1);
    const statements = (roles[0] as { Properties: { Policies: { PolicyDocument: { Statement: Record<string, unknown>[] } }[] } }).Properties.Policies[0]!.PolicyDocument.Statement;
    for (const sid of ["IamRequireBoundary", "IamKeepBoundary"]) {
      expect(statements.some((s) => s.Sid === sid), `${sid} must not be emitted unconditionally`).toBe(false);
      const wrapped = statements.find((s) => {
        const branches = s["Fn::If"] as [string, { Sid?: string }, unknown] | undefined;
        return branches?.[1]?.Sid === sid;
      });
      expect(wrapped, sid).toBeDefined();
      const branches = wrapped!["Fn::If"] as [string, { Effect: string }, unknown];
      expect(branches[0]).toBe("HasPermissionsBoundary");
      expect(branches[1].Effect).toBe("Deny");
      expect(branches[2]).toEqual({ Ref: "AWS::NoValue" });
    }
  });

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
