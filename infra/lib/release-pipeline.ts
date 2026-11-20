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
export const AGENTX_RELEASE_REPOSITORY_NAME = "Rovara";
export const AGENTX_RELEASE_BRANCH = "mainline";
// Must not match the broker's `agentx-*` CodeBuild gate allow-list, or a worker could start a release.
export const AGENTX_RELEASE_PROJECT_NAME = "release-agentx-production";
// #1242: the beta release's project, under the same rule as the production one.
export const AGENTX_BETA_RELEASE_PROJECT_NAME = "release-agentx-beta";
export const AGENTX_RELEASE_PIPELINE_NAME = "AgentXProductionRelease";
/** The pipeline's last stage. Its inbound transition stays disabled: enabling it is the manual approval that promotes beta's commit (#1242). */
export const AGENTX_PRODUCTION_STAGE = "Production";
/** The beta release build's own role, by a fixed name: the beta account's release role trusts exactly this role (beta-release-access.ts). */
export const AGENTX_BETA_BUILD_ROLE_NAME = "agentx-release-beta-build";
/** The role in the beta account that the beta release runs as (beta-release-access.ts). */
export const AGENTX_BETA_RELEASE_ROLE_NAME = "agentx-beta-release";
/** The AWS profile the beta build writes for that role: assumed from the build's own credentials, and assumed again by each AWS CLI and CDK process. */
export const AGENTX_BETA_PROFILE = "agentx-beta";
export const AGENTX_PRODUCTION_WORKER_REPOSITORY = "agentx-worker-production";
export const AGENTX_RELEASE_AWS_CLI_VERSION = "2.36.47";
export const AGENTX_RELEASE_STACKS = [
  "AgentXControlPlane",
  "AgentXProductionFoundation",
  "AgentXProductionRuntime",
  "AgentXSlackOrchestrator",
] as const;
// Deployable inputs only: the worker and Slack orchestrator images, the control-plane Lambdas, and the CDK app.
// packages/aws-adapters is left out on purpose: the legacy production template must stay byte-identical, and the images take only that
// package's manifest (for npm ci), whose dependency changes always arrive with package-lock.json, which is listed.
export const AGENTX_RELEASE_TRIGGER_PATHS = [
  "environments/**",
  "infra/**",
  "packages/{broker,cli,contracts,gateway,local-adapters,mcp,model-runtime,orchestrator,slack-service,verifier,worker}/**",
  "upstream/e2e-0.20.0.tgz",
  "{package.json,package-lock.json,tsconfig.json,tsconfig.base.json,.dockerignore}",
] as const;

export class ReleasePipelineStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const connectionArn = new CfnParameter(this, "GitHubConnectionArn", {
      type: "String",
      allowedPattern:
        "^arn:aws(-[a-z]+)?:(codeconnections|codestar-connections):[a-z0-9-]+:[0-9]{12}:connection/[0-9a-f-]{36}$",
      description: "Authorized CodeConnections GitHub connection for PrepLabsAI/Rovara",
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

    const betaAccountId = new CfnParameter(this, "BetaAccountId", {
      type: "String",
      allowedPattern: "^[0-9]{12}$",
      description: "The AWS account of the beta environment, which every mainline release deploys to before production (#1242)",
    });
    const betaReleaseRoleArn = `arn:${this.partition}:iam::${betaAccountId.valueAsString}:role/${AGENTX_BETA_RELEASE_ROLE_NAME}`;
    const pipelineArn = `arn:${this.partition}:codepipeline:${this.region}:${this.account}:${AGENTX_RELEASE_PIPELINE_NAME}`;

    const project = new codebuild.PipelineProject(this, "ReleaseBuild", {
      projectName: AGENTX_RELEASE_PROJECT_NAME,
      description: "Runs npm run release:prod for AgentX mainline commits",
      ...releaseProjectSettings(logGroup),
      buildSpec: releaseBuildSpec({
        // #1242: the first thing the production release does is close the gate it came through, so that only this promotion gets in; the next
        // beta commit waits in front of Production until someone enables the transition again.
        firstCommands: [
          `aws codepipeline disable-stage-transition --pipeline-name ${AGENTX_RELEASE_PIPELINE_NAME} --stage-name ${AGENTX_PRODUCTION_STAGE} --transition-type Inbound --reason "${PROMOTION_GATE_REASON}"`,
        ],
        release: 'npm run release:prod -- --region "$AWS_REGION" --reuse-unchanged-worker --require-existing-foundation $RELEASE_CHECKS',
      }),
    });

    // #1242: the beta release runs the same release in the beta account. CI's proof reads GitHub with this account's GitHub App first (the
    // build's own credentials); the release itself then runs as the beta account's release role, through a profile that every AWS CLI and CDK
    // process assumes afresh, so a long release never outlives one role session.
    const betaRole = new iam.Role(this, "BetaReleaseBuildRole", {
      roleName: AGENTX_BETA_BUILD_ROLE_NAME,
      assumedBy: new iam.ServicePrincipal("codebuild.amazonaws.com"),
      description: "The beta release build: CI's proof in this account, then the release as the beta account's release role",
    });
    const betaProject = new codebuild.PipelineProject(this, "BetaReleaseBuild", {
      projectName: AGENTX_BETA_RELEASE_PROJECT_NAME,
      description: "Runs npm run release:prod in the beta account for AgentX mainline commits (#1242)",
      role: betaRole,
      ...releaseProjectSettings(logGroup),
      buildSpec: releaseBuildSpec({
        firstCommands: [],
        variables: { BETA_RELEASE_ROLE_ARN: betaReleaseRoleArn },
        beforeRelease: [
          "mkdir -p ~/.aws",
          `printf '[profile ${AGENTX_BETA_PROFILE}]\\nrole_arn = %s\\ncredential_source = EcsContainer\\nrole_session_name = beta-release\\nregion = %s\\n' "$BETA_RELEASE_ROLE_ARN" "$AWS_REGION" >> ~/.aws/config`,
          `aws sts get-caller-identity --profile ${AGENTX_BETA_PROFILE}`,
        ],
        release: `npm run release:prod -- --region "$AWS_REGION" --profile ${AGENTX_BETA_PROFILE} --reuse-unchanged-worker --require-existing-foundation $RELEASE_CHECKS`,
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
      // #1166: the release's CI proof reads GitHub as the install's own GitHub App (scripts/release-ci-proof.ts), whose key is in this account's agentx/github-apps/ secrets.
      new iam.PolicyStatement({
        sid: "ReadGithubAppKeyForCiProof",
        actions: ["secretsmanager:GetSecretValue"],
        resources: [scoped("secretsmanager", "secret:agentx/github-apps/*")],
      }),
      new iam.PolicyStatement({
        sid: "ReadReleaseStacks",
        actions: ["cloudformation:DescribeStacks"],
        resources: AGENTX_RELEASE_STACKS.map((name) => scoped("cloudformation", `stack/${name}/*`)),
      }),
      useConnection,
    ];
    for (const policy of policies) project.addToRolePolicy(policy);
    project.addToRolePolicy(new iam.PolicyStatement({
      sid: "ClosePromotionGate",
      actions: ["codepipeline:DisableStageTransition"],
      resources: [`${pipelineArn}/${AGENTX_PRODUCTION_STAGE}`, pipelineArn],
    }));
    // The beta build needs only CI's proof here (the GitHub App's key and the control plane's description) and the beta account's role.
    for (const policy of policies.filter((policy) => policy.sid === "ReadGithubAppKeyForCiProof" || policy.sid === "ReadReleaseStacks")) {
      betaProject.addToRolePolicy(policy);
    }
    betaProject.addToRolePolicy(useConnection);
    betaProject.addToRolePolicy(new iam.PolicyStatement({
      sid: "AssumeBetaReleaseRole",
      actions: ["sts:AssumeRole"],
      resources: [betaReleaseRoleArn],
    }));

    const sourceRole = new iam.Role(this, "SourceActionRole", {
      assumedBy: new iam.AccountRootPrincipal(),
      description: "Reads AgentX mainline through the GitHub connection",
    });
    sourceRole.addToPolicy(useConnection);

    const sourceOutput = new codepipeline.Artifact("Source");
    const releaseOutput = new codepipeline.Artifact("ReleaseManifest");
    const betaOutput = new codepipeline.Artifact("BetaReleaseManifest");
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
      pipelineName: AGENTX_RELEASE_PIPELINE_NAME,
      pipelineType: codepipeline.PipelineType.V2,
      // #1242: every merge goes to beta; production takes beta's newest commit only when someone enables the transition into Production.
      // A run waiting in front of a disabled transition is replaced by a newer one only in SUPERSEDED mode, which is what makes one promotion carry
      // every merge since the last. (QUEUED, #114, kept each merge apart; two merges that land while beta is deploying now go to beta together.)
      executionMode: codepipeline.ExecutionMode.SUPERSEDED,
      // aws-cdk-lib types Bucket.isWebsite as `boolean | undefined`, which exactOptionalPropertyTypes rejects for IBucket.
      artifactBucket: artifactBucket as s3.IBucket,
      crossAccountKeys: false,
      restartExecutionOnUpdate: false,
      stages: [
        { stageName: "Source", actions: [source] },
        {
          stageName: "Beta",
          actions: [
            new actions.CodeBuildAction({
              actionName: "ReleaseBeta",
              project: betaProject,
              input: sourceOutput,
              outputs: [betaOutput],
            }),
          ],
        },
        {
          stageName: AGENTX_PRODUCTION_STAGE,
          // The manual approval: enable this transition (console, or `aws codepipeline enable-stage-transition`) to promote the commit waiting here.
          transitionToEnabled: false,
          transitionDisabledReason: PROMOTION_GATE_REASON,
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

/** Why the transition into Production is disabled; also the reason the production release gives when it closes it again. */
// CodePipeline allows only letters, digits, spaces and !@().*?- in a transition's reason.
export const PROMOTION_GATE_REASON = "Production waits for a manual approval - enable this transition to release the commit waiting here (issue 1242)";

function releaseProjectSettings(logGroup: logs.ILogGroup) {
  return {
    environment: {
      buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2023_STANDARD_3_0,
      // 8 vCPUs: the release runs the whole test suite (as an unprivileged account), about 16 minutes. 32 vCPUs only helps
      // with more test files at once, which makes the trusted-base rule-file reads fail intermittently (#569).
      computeType: codebuild.ComputeType.LARGE,
      privileged: true,
    },
    concurrentBuildLimit: 1,
    // #1151: a release that runs the full checks (CI proof not proven) and rebuilds the worker took over 60 minutes; one proven by CI takes 5-15.
    timeout: Duration.minutes(120),
    cache: codebuild.Cache.local(codebuild.LocalCacheMode.DOCKER_LAYER),
    logging: { cloudWatch: { logGroup } },
  };
}

interface ReleaseBuildSpec {
  /** Commands before the tools are installed. */
  firstCommands: string[];
  variables?: Record<string, string>;
  /** Commands after CI's proof, before the release. */
  beforeRelease?: string[];
  release: string;
}

function releaseBuildSpec(spec: ReleaseBuildSpec): codebuild.BuildSpec {
  return codebuild.BuildSpec.fromObject({
    version: "0.2",
    env: {
      shell: "bash",
      // #1118: the release's typecheck (tsc -b) needs about 4 GB of heap since mainline took code/next; Node's default limit on this
      // 16 GB build machine is lower, and tsc died with "JavaScript heap out of memory". 8 GB leaves the tests' own processes room.
      variables: { NODE_OPTIONS: "--max-old-space-size=8192", AWS_CLI_VERSION: AGENTX_RELEASE_AWS_CLI_VERSION, GITLEAKS_VERSION: "8.30.1", GITLEAKS_SHA256: "e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080", ...spec.variables },
    },
    phases: {
      install: {
        // Tools go under /opt so the release's dirty-tree check sees an untouched checkout.
        commands: [
          ...spec.firstCommands,
          'node_version="$(cat .node-version)"',
          'node_archive="node-v${node_version}-linux-arm64.tar.xz"',
          'curl -fsSL -o "/tmp/${node_archive}" "https://nodejs.org/dist/v${node_version}/${node_archive}"',
          'curl -fsSL "https://nodejs.org/dist/v${node_version}/SHASUMS256.txt" | grep " ${node_archive}$" | (cd /tmp && sha256sum -c -)',
          'mkdir -p /opt/node && tar -xJf "/tmp/${node_archive}" -C /opt/node --strip-components=1',
          'curl -fsSL -o /tmp/awscliv2.zip "https://awscli.amazonaws.com/awscli-exe-linux-aarch64-${AWS_CLI_VERSION}.zip"',
          "unzip -q /tmp/awscliv2.zip -d /tmp && /tmp/aws/install --install-dir /opt/aws-cli --bin-dir /opt/aws-cli/bin",
          // The port guard's tests run the real secret scan (tests/unit/port-guard.test.ts): the same gitleaks release CI pins, for this machine's arm64.
          'curl -fsSL -o /tmp/gitleaks.tar.gz "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_arm64.tar.gz"',
          'echo "${GITLEAKS_SHA256}  /tmp/gitleaks.tar.gz" | sha256sum -c -',
          "mkdir -p /opt/gitleaks && tar -xzf /tmp/gitleaks.tar.gz -C /opt/gitleaks gitleaks",
          'export PATH="/opt/node/bin:/opt/aws-cli/bin:/opt/gitleaks:$PATH"',
          "node --version && npm --version && aws --version && gitleaks version && docker buildx version",
        ],
      },
      pre_build: {
        commands: ["npm ci"],
      },
      build: {
        commands: [
          // #1145: skip the typecheck, lint and tests only when GitHub CI's gate already passed on exactly this code (the same file tree; scripts/release-ci-proof.ts).
          // Not proven (behind mainline, CI not green, GitHub unreachable): every check runs, as before. The proof itself never fails the build.
          `if node scripts/release-ci-proof.ts --repository ${AGENTX_RELEASE_REPOSITORY_OWNER}/${AGENTX_RELEASE_REPOSITORY_NAME} --github-app-stack ${AGENTX_RELEASE_STACKS[0]} --region "$AWS_REGION"; then RELEASE_CHECKS=--skip-checks; else RELEASE_CHECKS=; fi; ` +
            [...(spec.beforeRelease ?? []), spec.release].join(" && "),
        ],
      },
    },
    artifacts: {
      files: ["cdk.out/agentx-production-release.json"],
      "discard-paths": "yes",
    },
  });
}
