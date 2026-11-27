// #1242, #1578: the beta account's side of the release pipeline. The pipeline (release-pipeline.ts, in the release account) deploys every mainline merge to
// beta first; its beta Code release build and beta model gateway steps run as this role. Deployed once into the beta account, by hand
// (-c agentxBetaAccess=enabled); no release deploys it.
//
// The role trusts exactly two principals in the release account: the beta Code build role (AGENTX_BETA_BUILD_ROLE_NAME) and the beta model gateway build role
// (AGENTX_BETA_MODEL_GATEWAY_BUILD_ROLE_NAME). Its rights stay scoped to this account: deploy through this account's CDK bootstrap roles, push the release and
// model gateway images, read the release stacks, and read ECS/logs/ACM for beta's model gateway checks. CI's proof stays in the release account.
import { CfnParameter, Stack, type StackProps, aws_iam as iam } from "aws-cdk-lib";
import type { Construct } from "constructs";
import { BETA_GATEWAY_IMAGES_PREFIX, RELEASE_IMAGE_REPOSITORY_ACTIONS } from "./model-gateway-boundary.js";
import { RESOURCE_PREFIX } from "./model-gateway-contracts.js";
import {
  AGENTX_BETA_BUILD_ROLE_NAME,
  AGENTX_BETA_MODEL_GATEWAY_BUILD_ROLE_NAME,
  AGENTX_BETA_RELEASE_ROLE_NAME,
  AGENTX_PRODUCTION_WORKER_REPOSITORY,
  AGENTX_RELEASE_STACKS,
} from "./release-pipeline.js";
import { AGENTX_SLACK_ORCHESTRATOR_REPOSITORY } from "./slack-orchestrator.js";

export class BetaReleaseAccessStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);
    const releaseAccountId = new CfnParameter(this, "ReleaseAccountId", {
      type: "String",
      allowedPattern: "^[0-9]{12}$",
      description: "The AWS account that holds the release pipeline (AgentXReleasePipeline)",
    });
    const buildRoleArn = `arn:${this.partition}:iam::${releaseAccountId.valueAsString}:role/${AGENTX_BETA_BUILD_ROLE_NAME}`;
    const gatewayBuildRoleArn = `arn:${this.partition}:iam::${releaseAccountId.valueAsString}:role/${AGENTX_BETA_MODEL_GATEWAY_BUILD_ROLE_NAME}`;
    const role = new iam.Role(this, "Role", {
      roleName: AGENTX_BETA_RELEASE_ROLE_NAME,
      assumedBy: new iam.AccountPrincipal(releaseAccountId.valueAsString).withConditions({
        ArnEquals: { "aws:PrincipalArn": [buildRoleArn, gatewayBuildRoleArn] },
      }),
      description: "The release pipeline's beta build and model gateway steps: deploys the release and model gateway stacks in this account (#1242, #1578)",
    });
    const scoped = (service: string, resource: string): string =>
      `arn:${this.partition}:${service}:${this.region}:${this.account}:${resource}`;
    const gatewayPrefix = `${RESOURCE_PREFIX}-beta-gateway`;
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
      new iam.PolicyStatement({
        sid: "BetaModelGatewayRepository",
        actions: [...RELEASE_IMAGE_REPOSITORY_ACTIONS],
        resources: [scoped("ecr", `repository/${BETA_GATEWAY_IMAGES_PREFIX}*`)],
      }),
      new iam.PolicyStatement({
        sid: "BetaModelGatewayServiceReads",
        actions: ["ecs:DescribeServices", "ecs:ListServices", "ecs:DescribeTasks", "ecs:ListTasks"],
        resources: ["*"],
        conditions: { ArnLike: { "ecs:cluster": scoped("ecs", `cluster/${gatewayPrefix}-*`) } },
      }),
      new iam.PolicyStatement({
        sid: "BetaModelGatewayTaskDefinitionRead",
        actions: ["ecs:DescribeTaskDefinition"],
        resources: ["*"],
      }),
      new iam.PolicyStatement({
        sid: "BetaModelGatewayPriceFetchLogs",
        actions: ["logs:DescribeLogStreams", "logs:GetLogEvents", "logs:FilterLogEvents"],
        resources: [scoped("logs", `log-group:${gatewayPrefix}-PriceFetchLogs*`)],
      }),
      new iam.PolicyStatement({
        sid: "BetaModelGatewayCertificateRead",
        actions: ["acm:DescribeCertificate"],
        resources: [scoped("acm", "certificate/*")],
      }),
    ];
    for (const statement of statements) role.addToPolicy(statement);
  }
}
