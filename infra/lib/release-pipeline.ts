import {
  CfnParameter,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
  aws_codebuild as codebuild,
  aws_codepipeline as codepipeline,
  aws_codepipeline_actions as actions,
  aws_iam as iam,
  aws_logs as logs,
  aws_s3 as s3,
} from "aws-cdk-lib";
import type { Construct } from "constructs";
import { AGENTX_SLACK_ORCHESTRATOR_REPOSITORY } from "./slack-orchestrator.js";

export const AGENTX_RELEASE_REPOSITORY_OWNER = "PrepLabsAI";
export const AGENTX_RELEASE_REPOSITORY_NAME = "AgentX";
export const AGENTX_RELEASE_BRANCH = "mainline";
// Must not match the broker's `agentx-*` CodeBuild gate allow-list, or a worker could start a release.
export const AGENTX_RELEASE_PROJECT_NAME = "release-agentx-production";
export const AGENTX_PRODUCTION_WORKER_REPOSITORY = "agentx-worker-production";
export const AGENTX_RELEASE_AWS_CLI_VERSION = "2.36.47";
export const AGENTX_RELEASE_STACKS = [
  "AgentXControlPlane",
  "AgentXProductionFoundation",
  "AgentXProductionRuntime",
  "AgentXSlackOrchestrator",
] as const;
// Deployable inputs only: the worker and Slack orchestrator images, the control-plane Lambdas, and the CDK app.
export const AGENTX_RELEASE_TRIGGER_PATHS = [
  "environments/**",
  "infra/**",
  "packages/{broker,cli,contracts,gateway,model-runtime,orchestrator,slack-service,worker}/**",
  "{package.json,package-lock.json,tsconfig.json,tsconfig.base.json,.dockerignore}",
] as const;

export class ReleasePipelineStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const connectionArn = new CfnParameter(this, "GitHubConnectionArn", {
      type: "String",
      allowedPattern:
        "^arn:aws(-[a-z]+)?:(codeconnections|codestar-connections):[a-z0-9-]+:[0-9]{12}:connection/[0-9a-f-]{36}$",
      description: "Authorized CodeConnections GitHub connection for PrepLabsAI/AgentX",
    });
    const useConnection = new iam.PolicyStatement({
      actions: ["codeconnections:UseConnection", "codestar-connections:UseConnection"],
      resources: [connectionArn.valueAsString],
    });

    const artifactBucket = new s3.Bucket(this, "Artifacts", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [{ expiration: Duration.days(30) }],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const logGroup = new logs.LogGroup(this, "ReleaseBuildLogs", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const project = new codebuild.PipelineProject(this, "ReleaseBuild", {
      projectName: AGENTX_RELEASE_PROJECT_NAME,
      description: "Runs npm run release:prod for AgentX mainline commits",
      environment: {
        buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2023_STANDARD_3_0,
        computeType: codebuild.ComputeType.MEDIUM,
        privileged: true,
      },
      concurrentBuildLimit: 1,
      timeout: Duration.minutes(60),
      cache: codebuild.Cache.local(codebuild.LocalCacheMode.DOCKER_LAYER),
      logging: { cloudWatch: { logGroup } },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: "0.2",
        env: {
          shell: "bash",
          variables: { AWS_CLI_VERSION: AGENTX_RELEASE_AWS_CLI_VERSION },
        },
        phases: {
          install: {
            // Tools go under /opt so the release's dirty-tree check sees an untouched checkout.
            commands: [
              'node_version="$(cat .node-version)"',
              'node_archive="node-v${node_version}-linux-arm64.tar.xz"',
              'curl -fsSL -o "/tmp/${node_archive}" "https://nodejs.org/dist/v${node_version}/${node_archive}"',
              'curl -fsSL "https://nodejs.org/dist/v${node_version}/SHASUMS256.txt" | grep " ${node_archive}$" | (cd /tmp && sha256sum -c -)',
              'mkdir -p /opt/node && tar -xJf "/tmp/${node_archive}" -C /opt/node --strip-components=1',
              'curl -fsSL -o /tmp/awscliv2.zip "https://awscli.amazonaws.com/awscli-exe-linux-aarch64-${AWS_CLI_VERSION}.zip"',
              "unzip -q /tmp/awscliv2.zip -d /tmp && /tmp/aws/install --install-dir /opt/aws-cli --bin-dir /opt/aws-cli/bin",
              'export PATH="/opt/node/bin:/opt/aws-cli/bin:$PATH"',
              "node --version && npm --version && aws --version && docker buildx version",
            ],
          },
          pre_build: {
            commands: ["npm ci"],
          },
          build: {
            commands: [
              'npm run release:prod -- --region "$AWS_REGION" --reuse-unchanged-worker --require-existing-foundation',
            ],
          },
        },
        artifacts: {
          files: ["cdk.out/agentx-production-release.json"],
          "discard-paths": "yes",
        },
      }),
    });

    const scoped = (service: string, resource: string): string =>
      `arn:${this.partition}:${service}:${this.region}:${this.account}:${resource}`;
    const policies = [
      new iam.PolicyStatement({
        sid: "AssumeCdkBootstrapRoles",
        actions: ["sts:AssumeRole"],
        resources: [
          `arn:${this.partition}:iam::${this.account}:role/cdk-hnb659fds-*-${this.account}-${this.region}`,
        ],
      }),
      new iam.PolicyStatement({
        sid: "EcrAuthorization",
        actions: ["ecr:GetAuthorizationToken"],
        resources: ["*"],
      }),
      new iam.PolicyStatement({
        sid: "ProductionWorkerRepository",
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
      useConnection,
    ];
    for (const policy of policies) project.addToRolePolicy(policy);

    const sourceRole = new iam.Role(this, "SourceActionRole", {
      assumedBy: new iam.AccountRootPrincipal(),
      description: "Reads AgentX mainline through the GitHub connection",
    });
    sourceRole.addToPolicy(useConnection);

    const sourceOutput = new codepipeline.Artifact("Source");
    const releaseOutput = new codepipeline.Artifact("ReleaseManifest");
    const source = new actions.CodeStarConnectionsSourceAction({
      actionName: "GitHub",
      connectionArn: connectionArn.valueAsString,
      owner: AGENTX_RELEASE_REPOSITORY_OWNER,
      repo: AGENTX_RELEASE_REPOSITORY_NAME,
      branch: AGENTX_RELEASE_BRANCH,
      codeBuildCloneOutput: true,
      output: sourceOutput,
      role: sourceRole,
    });

    new codepipeline.Pipeline(this, "Pipeline", {
      pipelineName: "AgentXProductionRelease",
      pipelineType: codepipeline.PipelineType.V2,
      // Each merge is released on its own, in order: a waiting release is never replaced by a newer one
      // (#114), so a failure always points at one merge.
      executionMode: codepipeline.ExecutionMode.QUEUED,
      // aws-cdk-lib types Bucket.isWebsite as `boolean | undefined`, which exactOptionalPropertyTypes rejects for IBucket.
      artifactBucket: artifactBucket as s3.IBucket,
      crossAccountKeys: false,
      restartExecutionOnUpdate: false,
      stages: [
        { stageName: "Source", actions: [source] },
        {
          stageName: "Release",
          actions: [
            new actions.CodeBuildAction({
              actionName: "ReleaseProduction",
              project,
              input: sourceOutput,
              outputs: [releaseOutput],
            }),
          ],
        },
      ],
      triggers: [{
        providerType: codepipeline.ProviderType.CODE_STAR_SOURCE_CONNECTION,
        gitConfiguration: {
          sourceAction: source,
          pushFilter: [{
            branchesIncludes: [AGENTX_RELEASE_BRANCH],
            filePathsIncludes: [...AGENTX_RELEASE_TRIGGER_PATHS],
          }],
        },
      }],
    });
  }
}
