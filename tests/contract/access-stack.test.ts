import { Stack, type App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
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
