// #1242: the staging account's side of the release pipeline. The pipeline (release-pipeline.ts, in the release account) deploys every mainline merge to
// staging first; its staging build runs the same `npm run release:prod` as production, as this role. Deployed once into the staging account, by hand
// (-c agentxStagingAccess=enabled); no release deploys it.
//
// The role trusts exactly one principal: the staging build's role in the release account (AGENTX_STAGING_BUILD_ROLE_NAME). Its rights are the production
// release build's own (release-pipeline.ts), in this account: deploy through this account's CDK bootstrap roles, push the two release images, read the
// release stacks. CI's proof (the GitHub App's key) stays in the release account.
import { CfnParameter, Stack, type StackProps, aws_iam as iam } from "aws-cdk-lib";
import type { Construct } from "constructs";
import {
  AGENTX_PRODUCTION_WORKER_REPOSITORY,
  AGENTX_RELEASE_STACKS,
  AGENTX_STAGING_BUILD_ROLE_NAME,
  AGENTX_STAGING_RELEASE_ROLE_NAME,
} from "./release-pipeline.js";
import { AGENTX_SLACK_ORCHESTRATOR_REPOSITORY } from "./slack-orchestrator.js";

export class StagingReleaseAccessStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);
    const releaseAccountId = new CfnParameter(this, "ReleaseAccountId", {
      type: "String",
      allowedPattern: "^[0-9]{12}$",
      description: "The AWS account that holds the release pipeline (AgentXReleasePipeline)",
    });
    const buildRoleArn = `arn:${this.partition}:iam::${releaseAccountId.valueAsString}:role/${AGENTX_STAGING_BUILD_ROLE_NAME}`;
    // The account as principal, narrowed to the one role: a principal ARN in a trust policy must already exist, and this stack may come first.
    const role = new iam.Role(this, "Role", {
      roleName: AGENTX_STAGING_RELEASE_ROLE_NAME,
      assumedBy: new iam.AccountPrincipal(releaseAccountId.valueAsString).withConditions({ ArnEquals: { "aws:PrincipalArn": buildRoleArn } }),
      description: "The release pipeline's staging build: deploys the release stacks in this account (#1242)",
    });
    const scoped = (service: string, resource: string): string =>
      `arn:${this.partition}:${service}:${this.region}:${this.account}:${resource}`;
    const statements = [
      new iam.PolicyStatement({
        sid: "AssumeCdkBootstrapRoles",
        actions: ["sts:AssumeRole"],
        resources: [`arn:${this.partition}:iam::${this.account}:role/cdk-hnb659fds-*-${this.account}-${this.region}`],
      }),
      new iam.PolicyStatement({ sid: "EcrAuthorization", actions: ["ecr:GetAuthorizationToken"], resources: ["*"] }),
      new iam.PolicyStatement({
        sid: "ReleaseImageRepositories",
        actions: [
          "ecr:BatchCheckLayerAvailability",
          "ecr:BatchGetImage",
          "ecr:CompleteLayerUpload",
          "ecr:DescribeImages",
          "ecr:DescribeRepositories",
          "ecr:GetDownloadUrlForLayer",
          "ecr:InitiateLayerUpload",
          "ecr:PutImage",
          "ecr:PutImageScanningConfiguration",
          "ecr:PutImageTagMutability",
          "ecr:PutLifecyclePolicy",
          "ecr:UploadLayerPart",
        ],
        resources: [
          scoped("ecr", `repository/${AGENTX_PRODUCTION_WORKER_REPOSITORY}`),
          scoped("ecr", `repository/${AGENTX_SLACK_ORCHESTRATOR_REPOSITORY}`),
        ],
      }),
      new iam.PolicyStatement({
        sid: "ReadReleaseStacks",
        actions: ["cloudformation:DescribeStacks"],
        resources: AGENTX_RELEASE_STACKS.map((name) => scoped("cloudformation", `stack/${name}/*`)),
      }),
    ];
    for (const statement of statements) role.addToPolicy(statement);
  }
}
