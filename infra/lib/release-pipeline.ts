import {
  CfnOutput,
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
import {
  BETA_GATEWAY_IMAGES_PREFIX,
  CDK_BOOTSTRAP_ASSUMED_ROLES,
  CDK_BOOTSTRAP_QUALIFIER,
  PULL_BETA_IMAGE_ACTIONS,
  RELEASE_IMAGE_REPOSITORY_ACTIONS,
} from "./model-gateway-boundary.js";
import { RESOURCE_PREFIX } from "./model-gateway-contracts.js";
import { portGuardNamesParameter, portGuardNamesReadStatements, portGuardStepCommands, portGuardStepVariables } from "./port-guard-step.js";
import { AGENTX_SLACK_ORCHESTRATOR_REPOSITORY } from "./slack-orchestrator.js";

export const AGENTX_RELEASE_REPOSITORY_OWNER = "PrepLabsAI";
export const AGENTX_RELEASE_REPOSITORY_NAME = "Rovara-Code";
export const AGENTX_RELEASE_BRANCH = "mainline";
// Must not match the broker's `agentx-*` CodeBuild gate allow-list, or a worker could start a release.
export const AGENTX_RELEASE_PROJECT_NAME = "release-agentx-production";
// #1242: the beta release's project, under the same rule as the production one.
export const AGENTX_BETA_RELEASE_PROJECT_NAME = "release-agentx-beta";
export const AGENTX_BETA_MODEL_GATEWAY_PROJECT_NAME = "release-agentx-model-gateway-beta";
export const AGENTX_PRODUCTION_MODEL_GATEWAY_PROJECT_NAME = "release-agentx-model-gateway-production";
export const AGENTX_RELEASE_PIPELINE_NAME = "AgentXProductionRelease";
/** The pipeline's last stage. Its inbound transition stays disabled, so a run waits in front of it (#1242); the run is released by its OWN approval action (DEC 254zzz506). */
export const AGENTX_PRODUCTION_STAGE = "Production";
/**
 * PROD-APPROVAL-BOUND (DEC 254zzz506: every production deploy needs the owner's explicit approval for THAT run). The Production stage holds a CodePipeline manual approval, run order 2, right after
 * the Code Preflight (run order 1, read-only: its first command closes the transition, then the port guard runs). Every other Production action, all of them writers, runs after the approval.
 */
export const AGENTX_PRODUCTION_APPROVAL_ACTION = "ApproveProduction";
/** An unanswered approval fails after this long (the run stops; the stage unlocks); CodePipeline's own default is 7 days. */
export const AGENTX_PRODUCTION_APPROVAL_TIMEOUT_HOURS = 24;
/** The beta release build's own role, by a fixed name: the beta account's release role trusts exactly this role and the beta gateway build role (beta-release-access.ts). */
export const AGENTX_BETA_BUILD_ROLE_NAME = "agentx-release-beta-build";
/** The beta model gateway build's own role, by a fixed name (trusted by beta-release-access.ts). */
export const AGENTX_BETA_MODEL_GATEWAY_BUILD_ROLE_NAME = "agentx-release-model-gateway-beta-build";
/** The production model gateway build's own role, by a fixed name (named in beta's gateway ECR repository policy via betaModelGatewayPullPolicy). */
export const AGENTX_PRODUCTION_MODEL_GATEWAY_BUILD_ROLE_NAME = "agentx-release-model-gateway-production-build";
/** The role in the beta account that the beta release and beta model gateway steps run as (beta-release-access.ts). */
export const AGENTX_BETA_RELEASE_ROLE_NAME = "agentx-beta-release";
/** The AWS profile the beta builds write for that role: assumed from the build's own credentials, and assumed again by each AWS CLI and CDK process. */
export const AGENTX_BETA_PROFILE = "agentx-beta";
/**
 * Each stage's Preflight, run first in Beta and in Production: in Production its FIRST command closes the transition
 * into Production, then it runs the port guard on the Code tree with the private name list, whatever the CI proof says (L14).
 */
export const AGENTX_CODE_PREFLIGHT_PROJECT_PREFIX = "release-agentx-preflight";
export const AGENTX_BETA_CODE_PREFLIGHT_PROJECT_NAME = `${AGENTX_CODE_PREFLIGHT_PROJECT_PREFIX}-beta`;
export const AGENTX_PRODUCTION_CODE_PREFLIGHT_PROJECT_NAME = `${AGENTX_CODE_PREFLIGHT_PROJECT_PREFIX}-production`;
/** The namespace of the Code source action (must not equal any artifact name). */
export const CODE_SOURCE_NAMESPACE = "CodeSource";
export const AGENTX_PRODUCTION_WORKER_REPOSITORY = "agentx-worker-production";

/**
 * The pipeline's artifact bucket holds every artifact of every run, and it is not versioned: a role that can write anywhere in it can overwrite the `Source` artifact
 * that a later stage reads (Production builds from the same `Source` the approval was given on), or another stage's output. Each build role therefore writes only its
 * own output artifacts (PH-S3-PREFIXES), and ReleaseArtifactBucket gives it nothing else.
 */
export const ARTIFACT_KEY_PIPELINE_CHARS = 20;
export const ARTIFACT_KEY_NAME_CHARS = 10;
/**
 * Code's model gateway state artifacts: `Gateway<Beta|Prod><Image|Deploy|Check>`.
 * With the 10-character cut, beta's share `GatewayBet*` and production's share `GatewayPro*`, disjoint from `Source`, `ReleaseManifest`, and `BetaReleaseManifest`.
 */
export const MODEL_GATEWAY_STATE_ARTIFACT_PREFIXES = { beta: "GatewayBeta", production: "GatewayProd" } as const;
export const modelGatewayStateArtifactName = (environment: "beta" | "production", suffix: string): string =>
  `${MODEL_GATEWAY_STATE_ARTIFACT_PREFIXES[environment]}${suffix}`;
/** The S3 resource pattern of every object of one artifact: `<bucket ARN>/<pipeline>/<artifact>`, cut as CodePipeline cuts it (a cut name ends in `*`). */
export function artifactKeyPattern(bucketArn: string, artifactName: string): string {
  const pipeline = AGENTX_RELEASE_PIPELINE_NAME.length > ARTIFACT_KEY_PIPELINE_CHARS ? `${AGENTX_RELEASE_PIPELINE_NAME.slice(0, ARTIFACT_KEY_PIPELINE_CHARS)}*` : AGENTX_RELEASE_PIPELINE_NAME;
  const artifact = artifactName.length > ARTIFACT_KEY_NAME_CHARS ? `${artifactName.slice(0, ARTIFACT_KEY_NAME_CHARS)}*` : `${artifactName}/*`;
  return `${bucketArn}/${pipeline}/${artifact}`;
}

/**
 * The pipeline's artifact bucket, which hands out its write grant by role. For a project registered with `scopeWrites`, the grant is read on the bucket
 * and PutObject plus AbortMultipartUpload on the project's own output artifacts only.
 */
export class ReleaseArtifactBucket extends s3.Bucket {
  private readonly ownOutputs = new Map<iam.IPrincipal, readonly string[]>();

  scopeWrites(project: codebuild.IProject, outputNames: readonly string[]): string[] {
    const patterns = [...new Set(outputNames.map((name) => artifactKeyPattern(this.bucketArn, name)))];
    this.ownOutputs.set(project.grantPrincipal, patterns);
    return patterns;
  }

  override grantReadWrite(identity: iam.IGrantable, objectsKeyPattern?: unknown): iam.Grant {
    const patterns = this.ownOutputs.get(identity.grantPrincipal);
    if (patterns === undefined) return super.grantReadWrite(identity, objectsKeyPattern);
    return this.grantRead(identity).combine(iam.Grant.addToPrincipal({ grantee: identity, actions: ["s3:PutObject", "s3:AbortMultipartUpload"], resourceArns: [...patterns] }));
  }
}

/** The V2 pipeline variables (Code-only, #1578). Every one has a default so a qualifying push to mainline starts a run. */
export const PIPELINE_VARIABLE_CODE_RELEASE = "CODE_RELEASE";
export const CODE_RELEASE_DEFAULT = "run";
export const CODE_RELEASE_EXPLICIT_VALUES = ["run", "skip"] as const;
/**
 * `release` (the default), `adopt` or `rollback`. An adoption run checks the live model gateway against Code's records and changes nothing
 * (run it once per environment before the first release). A rollback run deploys an earlier released Code commit and/or recorded model gateway digest.
 */
export const PIPELINE_VARIABLE_MODE = "PIPELINE_MODE";
export const PIPELINE_MODE_DEFAULT = "release";
export const PIPELINE_VARIABLE_ROLLBACK_TARGET = "CODE_ROLLBACK_TARGET";
export const ROLLBACK_TARGET_NONE = "none";
export const PIPELINE_VARIABLE_MODEL_GATEWAY_DIGEST = "MODEL_GATEWAY_DIGEST";
export const MODEL_GATEWAY_DIGEST_NONE = "none";
/** Exported by each stage's CodePreflight: the stage's previously released Code commit. */
export const CODE_LIVE_SHA_VARIABLE = "CODE_LIVE_SHA";
export const CODE_PREFLIGHT_NAMESPACE = { beta: "BetaCodePreflight", production: "ProductionCodePreflight" } as const;
export const MODEL_GATEWAY_ENV_VARIABLE = "GATEWAY_STAGE_ENV";
export const MODEL_GATEWAY_STEP_VARIABLE = "GATEWAY_STAGE_STEP";
export const MODEL_GATEWAY_STATE_ARTIFACT_VARIABLE = "PIPELINE_STATE_ARTIFACT";
export const MODEL_GATEWAY_EXPECTED_ACCOUNT_VARIABLE = "ROVARA_EXPECTED_DEPLOY_ACCOUNT";

/** The last Code commit each stage released: an SSM String in the release account, written as the Code release build's last command. */
export const CODE_RELEASED_PARAMETER = {
  beta: "/agentx/release/code-released/beta",
  production: "/agentx/release/code-released/production",
} as const;
/** Bounded history of the last CODE_HISTORY_LIMIT Code commits each stage released, in the release account. */
export const CODE_HISTORY_PARAMETER = {
  beta: "/agentx/release/code-history/beta",
  production: "/agentx/release/code-history/production",
} as const;
export const CODE_HISTORY_LIMIT = 10;
/** Code's last-good model gateway record per environment, stored in the release account beside code-released and code-history (#1578). */
export const MODEL_GATEWAY_LAST_GOOD_PARAMETER = {
  beta: "/agentx/release/model-gateway-last-good/beta",
  production: "/agentx/release/model-gateway-last-good/production",
} as const;

/** The Code-owned model gateway steps of each stage, in order, before the Code release (#1578). */
export const MODEL_GATEWAY_STEPS = [
  { action: "ModelGatewayImage", step: "image", artifactSuffix: "Image" },
  { action: "ModelGatewayDeploy", step: "deploy", artifactSuffix: "Deploy" },
  { action: "ModelGatewayCheck", step: "check", artifactSuffix: "Check" },
] as const;

export const AGENTX_RELEASE_AWS_CLI_VERSION = "2.36.47";
export const AGENTX_RELEASE_CRANE_VERSION = "0.20.6";
export const AGENTX_RELEASE_CRANE_SHA256 = "fc0515857bc38e4ddd2d37a5ab03fb5959449c7b2d4ad759bcc1174ac0cad91b";

// Every stack the release scripts name (scripts/release-production.ts, release-common.ts): the release roles may read these (cloudformation:DescribeStacks) and no more.
// tests/contract/release-stacks-list.test.ts fails if a stack the scripts name is missing. Append only: [0] is the install's GitHub App stack for CI's proof.
export const AGENTX_RELEASE_STACKS = [
  "AgentXControlPlane",
  "AgentXProductionFoundation",
  "AgentXProductionRuntime",
  "AgentXSlackOrchestrator",
  "AgentXApiAddress",
] as const;

// Deployable inputs only: the worker, Slack orchestrator and model gateway images, the control-plane Lambdas, and the CDK app.
export const AGENTX_RELEASE_TRIGGER_PATHS = [
  "environments/**",
  "infra/**",
  "packages/{broker,cli,code-api,contracts,gateway,local-adapters,mcp,model-gateway,model-runtime,orchestrator,slack-service,verifier,worker}/**",
  "scripts/model-gateway-image.ts",
  "scripts/model-gateway-release/**",
  "upstream/e2e-0.20.0.tgz",
  "{package.json,package-lock.json,tsconfig.json,tsconfig.base.json,.dockerignore}",
] as const;

/**
 * The repository policy beta's model gateway image repository needs so Code's production model gateway build role can pull from it
 * cross-account with its own credentials (read-only). Apply once in beta using the ProductionModelGatewayBuildRoleArn output.
 */
export function betaModelGatewayPullPolicy(productionBuildRoleArn: string): { Version: string; Statement: Array<Record<string, unknown>> } {
  return {
    Version: "2012-10-17",
    Statement: [{ Sid: "ProductionCodeReleasePull", Effect: "Allow", Principal: { AWS: productionBuildRoleArn }, Action: [...PULL_BETA_IMAGE_ACTIONS] }],
  };
}

export class ReleasePipelineStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const connectionArn = new CfnParameter(this, "GitHubConnectionArn", {
      type: "String",
      allowedPattern:
        "^arn:aws(-[a-z]+)?:(codeconnections|codestar-connections):[a-z0-9-]+:[0-9]{12}:connection/[0-9a-f-]{36}$",
      description: "Authorized CodeConnections GitHub connection for PrepLabsAI/Rovara-Code",
    });
    const useConnection = new iam.PolicyStatement({
      actions: ["codeconnections:UseConnection", "codestar-connections:UseConnection"],
      resources: [connectionArn.valueAsString],
    });

    const artifactBucket = new ReleaseArtifactBucket(this, "Artifacts", {
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
    const scoped = (service: string, resource: string): string =>
      `arn:${this.partition}:${service}:${this.region}:${this.account}:${resource}`;
    const releasedCodeArn = (stage: "beta" | "production"): string => scoped("ssm", `parameter${CODE_RELEASED_PARAMETER[stage]}`);
    const codeHistoryArn = (stage: "beta" | "production"): string => scoped("ssm", `parameter${CODE_HISTORY_PARAMETER[stage]}`);
    const gatewayLastGoodArn = (stage: "beta" | "production"): string => scoped("ssm", `parameter${MODEL_GATEWAY_LAST_GOOD_PARAMETER[stage]}`);

    const project = new codebuild.PipelineProject(this, "ReleaseBuild", {
      projectName: AGENTX_RELEASE_PROJECT_NAME,
      description: "Runs npm run release:prod for AgentX mainline commits",
      ...releaseProjectSettings(logGroup),
      buildSpec: releaseBuildSpec({
        historyParameter: CODE_HISTORY_PARAMETER.production,
        release: 'npm run release:prod -- --region "$AWS_REGION" --reuse-unchanged-worker --require-existing-foundation $RELEASE_CHECKS',
        afterRelease: [recordReleasedCode(CODE_RELEASED_PARAMETER.production, CODE_HISTORY_PARAMETER.production)],
      }),
    });

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
        historyParameter: CODE_HISTORY_PARAMETER.beta,
        variables: { BETA_RELEASE_ROLE_ARN: betaReleaseRoleArn },
        beforeRelease: betaProfileSetupCommands(),
        release: `npm run release:prod -- --region "$AWS_REGION" --profile ${AGENTX_BETA_PROFILE} --reuse-unchanged-worker --require-existing-foundation $RELEASE_CHECKS`,
        afterRelease: [recordReleasedCode(CODE_RELEASED_PARAMETER.beta, CODE_HISTORY_PARAMETER.beta)],
      }),
    });

    const productionReleasePolicies = buildProductionReleasePolicies(this, scoped, useConnection);
    for (const policy of productionReleasePolicies) project.addToRolePolicy(policy);
    project.addToRolePolicy(new iam.PolicyStatement({ sid: "RecordReleasedCode", actions: ["ssm:PutParameter"], resources: [releasedCodeArn("production")] }));
    project.addToRolePolicy(new iam.PolicyStatement({ sid: "RecordCodeHistory", actions: ["ssm:GetParameter", "ssm:PutParameter"], resources: [codeHistoryArn("production")] }));

    for (const policy of productionReleasePolicies.filter((policy) => policy.sid === "ReadGithubAppKeyForCiProof" || policy.sid === "ReadReleaseStacks")) {
      betaProject.addToRolePolicy(policy);
    }
    betaProject.addToRolePolicy(useConnection);
    betaProject.addToRolePolicy(new iam.PolicyStatement({ sid: "RecordReleasedCode", actions: ["ssm:PutParameter"], resources: [releasedCodeArn("beta")] }));
    betaProject.addToRolePolicy(new iam.PolicyStatement({ sid: "RecordCodeHistory", actions: ["ssm:GetParameter", "ssm:PutParameter"], resources: [codeHistoryArn("beta")] }));
    betaProject.addToRolePolicy(new iam.PolicyStatement({ sid: "AssumeBetaReleaseRole", actions: ["sts:AssumeRole"], resources: [betaReleaseRoleArn] }));

    const portGuardNames = portGuardNamesParameter(this);
    const portGuardKey = new CfnParameter(this, "PortGuardNamesKeyArn", {
      type: "String",
      allowedPattern: "^arn:aws(-[a-z]+)?:kms:[a-z0-9-]+:[0-9]{12}:key/[0-9a-f-]{36}$",
      description: "The customer-managed KMS key that encrypts the port guard's name list (decrypt is granted through SSM only)",
    });

    const betaPreflightProject = createPreflightProject(this, {
      id: "BetaCodePreflight", projectName: AGENTX_BETA_CODE_PREFLIGHT_PROJECT_NAME, closesGate: false, logGroup,
      portGuardNames: portGuardNames.valueAsString, portGuardKey: portGuardKey.valueAsString,
      releasedCodeArn: releasedCodeArn("beta"), codeHistoryArn: codeHistoryArn("beta"),
      pipelineArn, connectionArn: connectionArn.valueAsString, useConnection,
    });
    const productionPreflightProject = createPreflightProject(this, {
      id: "ProductionCodePreflight", projectName: AGENTX_PRODUCTION_CODE_PREFLIGHT_PROJECT_NAME, closesGate: true, logGroup,
      portGuardNames: portGuardNames.valueAsString, portGuardKey: portGuardKey.valueAsString,
      releasedCodeArn: releasedCodeArn("production"), codeHistoryArn: codeHistoryArn("production"),
      pipelineArn, connectionArn: connectionArn.valueAsString, useConnection,
    });

    const betaGateway = createModelGatewayProject(this, {
      environment: "beta", logGroup, betaAccountId: betaAccountId.valueAsString, betaReleaseRoleArn,
      lastGoodArn: gatewayLastGoodArn("beta"), releasedCodeArn: releasedCodeArn("beta"), scoped, useConnection,
    });
    const productionGateway = createModelGatewayProject(this, {
      environment: "production", logGroup, betaAccountId: betaAccountId.valueAsString, betaReleaseRoleArn,
      lastGoodArn: gatewayLastGoodArn("production"), releasedCodeArn: releasedCodeArn("production"), scoped, useConnection,
    });

    const sourceRole = new iam.Role(this, "SourceActionRole", {
      assumedBy: new iam.AccountRootPrincipal(),
      description: "Reads AgentX mainline through the GitHub connection",
    });
    sourceRole.addToPolicy(useConnection);

    const sourceOutput = new codepipeline.Artifact("Source");
    const releaseOutput = new codepipeline.Artifact("ReleaseManifest");
    const betaOutput = new codepipeline.Artifact("BetaReleaseManifest");
    const gatewayBetaArtifacts = MODEL_GATEWAY_STEPS.map((s) => new codepipeline.Artifact(modelGatewayStateArtifactName("beta", s.artifactSuffix)));
    const gatewayProdArtifacts = MODEL_GATEWAY_STEPS.map((s) => new codepipeline.Artifact(modelGatewayStateArtifactName("production", s.artifactSuffix)));

    const scopedOutputs: ReadonlyArray<readonly [codebuild.IProject, readonly string[]]> = [
      [project, [releaseOutput.artifactName!]],
      [betaProject, [betaOutput.artifactName!]],
      [betaGateway.project, gatewayBetaArtifacts.map((a) => a.artifactName!)],
      [productionGateway.project, gatewayProdArtifacts.map((a) => a.artifactName!)],
    ];
    for (const [buildProject, names] of scopedOutputs) {
      const ownOutput = artifactBucket.scopeWrites(buildProject, names);
      buildProject.addToRolePolicy(new iam.PolicyStatement({
        sid: "DenyArtifactWritesOutsideOwnOutput", effect: iam.Effect.DENY,
        actions: ["s3:PutObject*", "s3:DeleteObject*", "s3:AbortMultipartUpload"], notResources: ownOutput,
      }));
    }

    const source = new actions.CodeStarConnectionsSourceAction({
      actionName: "GitHub",
      connectionArn: connectionArn.valueAsString,
      owner: AGENTX_RELEASE_REPOSITORY_OWNER,
      repo: AGENTX_RELEASE_REPOSITORY_NAME,
      branch: AGENTX_RELEASE_BRANCH,
      codeBuildCloneOutput: true,
      output: sourceOutput,
      role: sourceRole,
      variablesNamespace: CODE_SOURCE_NAMESPACE,
    });

    const codeRelease = new codepipeline.Variable({
      variableName: PIPELINE_VARIABLE_CODE_RELEASE,
      defaultValue: CODE_RELEASE_DEFAULT,
      description: "run (default: triggered pushes release Code and the model gateway); skip (manual runs) skips deploying both",
    });
    const pipelineMode = new codepipeline.Variable({
      variableName: PIPELINE_VARIABLE_MODE,
      defaultValue: PIPELINE_MODE_DEFAULT,
      description: "release deploys; adopt checks the live model gateway against Code records and changes nothing; rollback deploys an earlier Code commit and/or recorded gateway digest",
    });
    const rollbackTarget = new codepipeline.Variable({
      variableName: PIPELINE_VARIABLE_ROLLBACK_TARGET,
      defaultValue: ROLLBACK_TARGET_NONE,
      description: "With PIPELINE_MODE=rollback: the 40-character Code commit to deploy (must be in the stage release history). none leaves Code alone; any other mode requires none",
    });
    const gatewayDigest = new codepipeline.Variable({
      variableName: PIPELINE_VARIABLE_MODEL_GATEWAY_DIGEST,
      defaultValue: MODEL_GATEWAY_DIGEST_NONE,
      description: "With PIPELINE_MODE=rollback: the recorded sha256:... model gateway digest to deploy in Beta (none resolves from CODE_ROLLBACK_TARGET). Any other mode requires none",
    });

    const preflightVars = {
      [PIPELINE_VARIABLE_MODE]: { value: pipelineMode.reference() },
      [PIPELINE_VARIABLE_ROLLBACK_TARGET]: { value: rollbackTarget.reference() },
    };
    const gatewayStageActions = (
      environment: "beta" | "production",
      gatewayProject: codebuild.IProject,
      outputs: readonly codepipeline.Artifact[],
      startRunOrder: number,
      previousArtifact: codepipeline.Artifact | undefined,
    ): { actions: actions.CodeBuildAction[]; last: codepipeline.Artifact } => {
      let prev = previousArtifact;
      const built: actions.CodeBuildAction[] = [];
      MODEL_GATEWAY_STEPS.forEach((spec, idx) => {
        const output = outputs[idx]!;
        built.push(new actions.CodeBuildAction({
          actionName: spec.action,
          project: gatewayProject,
          runOrder: startRunOrder + idx,
          input: sourceOutput,
          extraInputs: prev === undefined ? [] : [prev],
          outputs: [output],
          environmentVariables: {
            [MODEL_GATEWAY_STEP_VARIABLE]: { value: spec.step },
            ...(prev === undefined ? {} : { [MODEL_GATEWAY_STATE_ARTIFACT_VARIABLE]: { value: prev.artifactName! } }),
            [PIPELINE_VARIABLE_CODE_RELEASE]: { value: codeRelease.reference() },
            [PIPELINE_VARIABLE_MODE]: { value: pipelineMode.reference() },
            [PIPELINE_VARIABLE_ROLLBACK_TARGET]: { value: rollbackTarget.reference() },
            [PIPELINE_VARIABLE_MODEL_GATEWAY_DIGEST]: { value: gatewayDigest.reference() },
            EXEC_ID: { value: "#{codepipeline.PipelineExecutionId}" },
            CODE_SHA: { value: source.variables.commitId },
            [CODE_LIVE_SHA_VARIABLE]: { value: `#{${CODE_PREFLIGHT_NAMESPACE[environment]}.${CODE_LIVE_SHA_VARIABLE}}` },
          },
        }));
        prev = output;
      });
      return { actions: built, last: prev! };
    };

    const codeReleaseAction = (actionName: string, codeProject: codebuild.IProject, runOrder: number, output: codepipeline.Artifact): actions.CodeBuildAction =>
      new actions.CodeBuildAction({
        actionName,
        project: codeProject,
        runOrder,
        input: sourceOutput,
        outputs: [output],
        environmentVariables: {
          [PIPELINE_VARIABLE_CODE_RELEASE]: { value: codeRelease.reference() },
          [PIPELINE_VARIABLE_MODE]: { value: pipelineMode.reference() },
          [PIPELINE_VARIABLE_ROLLBACK_TARGET]: { value: rollbackTarget.reference() },
        },
      });

    const betaGatewayChain = gatewayStageActions("beta", betaGateway.project, gatewayBetaArtifacts, 2, undefined);
    const prodGatewayChain = gatewayStageActions("production", productionGateway.project, gatewayProdArtifacts, 3, betaGatewayChain.last);

    const approvalText = [
      `Approve THIS run only: pipeline execution #{codepipeline.PipelineExecutionId}.`,
      `Production releases Code commit ${source.variables.commitId} and its model gateway (using Beta's exact image digest).`,
      `Code release ${codeRelease.reference()}, mode ${pipelineMode.reference()}, rollback target ${rollbackTarget.reference()}, gateway digest ${gatewayDigest.reference()}.`,
      "Check Beta's logs before you approve. Reject any run that is not the one you meant to release.",
    ].join(" ");
    const productionApproval = new actions.ManualApprovalAction({
      actionName: AGENTX_PRODUCTION_APPROVAL_ACTION,
      runOrder: 2,
      additionalInformation: approvalText,
      timeout: Duration.hours(AGENTX_PRODUCTION_APPROVAL_TIMEOUT_HOURS),
    });

    new codepipeline.Pipeline(this, "Pipeline", {
      pipelineName: AGENTX_RELEASE_PIPELINE_NAME,
      pipelineType: codepipeline.PipelineType.V2,
      variables: [codeRelease, pipelineMode, rollbackTarget, gatewayDigest],
      executionMode: codepipeline.ExecutionMode.SUPERSEDED,
      artifactBucket: artifactBucket as s3.IBucket,
      crossAccountKeys: false,
      restartExecutionOnUpdate: false,
      stages: [
        { stageName: "Source", actions: [source] },
        {
          stageName: "Beta",
          actions: [
            new actions.CodeBuildAction({
              actionName: "CodePreflight",
              project: betaPreflightProject,
              runOrder: 1,
              input: sourceOutput,
              variablesNamespace: CODE_PREFLIGHT_NAMESPACE.beta,
              environmentVariables: { ...preflightVars, EXEC_ID: { value: "#{codepipeline.PipelineExecutionId}" } },
            }),
            ...betaGatewayChain.actions,
            codeReleaseAction("ReleaseBeta", betaProject, 5, betaOutput),
          ],
        },
        {
          stageName: AGENTX_PRODUCTION_STAGE,
          transitionToEnabled: false,
          transitionDisabledReason: PROMOTION_GATE_REASON,
          actions: [
            new actions.CodeBuildAction({
              actionName: "CodePreflight",
              project: productionPreflightProject,
              runOrder: 1,
              input: sourceOutput,
              variablesNamespace: CODE_PREFLIGHT_NAMESPACE.production,
              environmentVariables: preflightVars,
            }),
            productionApproval,
            ...prodGatewayChain.actions,
            codeReleaseAction("ReleaseProduction", project, 6, releaseOutput),
          ],
        },
      ],
      triggers: [
        {
          providerType: codepipeline.ProviderType.CODE_STAR_SOURCE_CONNECTION,
          gitConfiguration: {
            sourceAction: source,
            pushFilter: [{
              branchesIncludes: [AGENTX_RELEASE_BRANCH],
              filePathsIncludes: [...AGENTX_RELEASE_TRIGGER_PATHS],
            }],
          },
        },
      ],
    });

    new CfnOutput(this, "ProductionModelGatewayBuildRoleArn", {
      value: productionGateway.role.roleArn,
      description: "Principal ARN for beta's model gateway ECR repository pull policy (betaModelGatewayPullPolicy)",
    });
  }
}

function buildProductionReleasePolicies(
  stack: Stack,
  scoped: (service: string, resource: string) => string,
  useConnection: iam.PolicyStatement,
): iam.PolicyStatement[] {
  return [
    new iam.PolicyStatement({
      sid: "AssumeCdkBootstrapRoles",
      actions: ["sts:AssumeRole"],
      resources: [`arn:${stack.partition}:iam::${stack.account}:role/cdk-hnb659fds-*-${stack.account}-${stack.region}`],
    }),
    new iam.PolicyStatement({
      sid: "EcrAuthorization",
      actions: ["ecr:GetAuthorizationToken"],
      resources: ["*"],
    }),
    new iam.PolicyStatement({
      sid: "ProductionWorkerRepository",
      actions: [
        "ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:CompleteLayerUpload", "ecr:DescribeImages",
        "ecr:DescribeRepositories", "ecr:GetDownloadUrlForLayer", "ecr:InitiateLayerUpload", "ecr:PutImage",
        "ecr:PutImageScanningConfiguration", "ecr:PutImageTagMutability", "ecr:PutLifecyclePolicy", "ecr:UploadLayerPart",
      ],
      resources: [
        scoped("ecr", `repository/${AGENTX_PRODUCTION_WORKER_REPOSITORY}`),
        scoped("ecr", `repository/${AGENTX_SLACK_ORCHESTRATOR_REPOSITORY}`),
      ],
    }),
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
}

interface PreflightProjectArgs {
  id: string;
  projectName: string;
  closesGate: boolean;
  logGroup: logs.ILogGroup;
  portGuardNames: string;
  portGuardKey: string;
  releasedCodeArn: string;
  codeHistoryArn: string;
  pipelineArn: string;
  connectionArn: string;
  useConnection: iam.PolicyStatement;
}

function createPreflightProject(stack: Stack, args: PreflightProjectArgs): codebuild.PipelineProject {
  const preflight = new codebuild.PipelineProject(stack, args.id, {
    projectName: args.projectName,
    description: args.closesGate
      ? "Closes the transition into Production, then runs the port guard on the Code tree with the private name list (#1242, L14)"
      : "Runs the port guard on the Code tree with the private name list, before Beta's writes (L14)",
    environment: {
      buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2023_STANDARD_3_0,
      computeType: codebuild.ComputeType.MEDIUM,
    },
    concurrentBuildLimit: 1,
    timeout: Duration.minutes(30),
    logging: { cloudWatch: { logGroup: args.logGroup } },
    buildSpec: codePreflightBuildSpec(
      args.closesGate,
      args.portGuardNames,
      args.closesGate ? CODE_RELEASED_PARAMETER.production : CODE_RELEASED_PARAMETER.beta,
      args.closesGate ? CODE_HISTORY_PARAMETER.production : CODE_HISTORY_PARAMETER.beta,
    ),
  });
  if (args.closesGate) {
    preflight.addToRolePolicy(new iam.PolicyStatement({
      sid: "ClosePromotionGate",
      actions: ["codepipeline:DisableStageTransition"],
      resources: [`${args.pipelineArn}/${AGENTX_PRODUCTION_STAGE}`, args.pipelineArn],
    }));
  }
  for (const statement of portGuardNamesReadStatements({
    partition: stack.partition, region: stack.region, account: stack.account,
    parameterName: args.portGuardNames, keyArn: args.portGuardKey,
  })) preflight.addToRolePolicy(statement);
  preflight.addToRolePolicy(new iam.PolicyStatement({ sid: "ReadReleasedCode", actions: ["ssm:GetParameter"], resources: [args.releasedCodeArn] }));
  preflight.addToRolePolicy(new iam.PolicyStatement({ sid: "ReadCodeHistory", actions: ["ssm:GetParameter"], resources: [args.codeHistoryArn] }));
  if (!args.closesGate) {
    preflight.addToRolePolicy(new iam.PolicyStatement({
      sid: "ReadWaitingRun",
      actions: ["codepipeline:GetPipelineState", "codepipeline:GetPipelineExecution"],
      resources: [args.pipelineArn],
    }));
  }
  preflight.addToRolePolicy(args.useConnection);
  if (args.closesGate) {
    for (const prefix of ["codeconnections", "codestar-connections"]) {
      preflight.addToRolePolicy(new iam.PolicyStatement({
        sid: `ReadOnlyConnectionUse${prefix === "codeconnections" ? "" : "Legacy"}`,
        effect: iam.Effect.DENY,
        actions: [`${prefix}:UseConnection`],
        resources: [args.connectionArn],
        conditions: { StringEquals: { [`${prefix}:ProviderPermissionsRequired`]: "read_write" } },
      }));
    }
  }
  return preflight;
}

interface ModelGatewayProjectArgs {
  environment: "beta" | "production";
  logGroup: logs.ILogGroup;
  betaAccountId: string;
  betaReleaseRoleArn: string;
  lastGoodArn: string;
  releasedCodeArn: string;
  scoped: (service: string, resource: string) => string;
  useConnection: iam.PolicyStatement;
}

function createModelGatewayProject(stack: Stack, args: ModelGatewayProjectArgs): { project: codebuild.PipelineProject; role: iam.Role } {
  const isBeta = args.environment === "beta";
  const role = new iam.Role(stack, isBeta ? "BetaModelGatewayBuildRole" : "ProductionModelGatewayBuildRole", {
    roleName: isBeta ? AGENTX_BETA_MODEL_GATEWAY_BUILD_ROLE_NAME : AGENTX_PRODUCTION_MODEL_GATEWAY_BUILD_ROLE_NAME,
    assumedBy: new iam.ServicePrincipal("codebuild.amazonaws.com"),
    description: `Runs Code's ${args.environment} model gateway image, deploy, and check steps (#1578)`,
  });
  role.addToPolicy(args.useConnection);
  role.addToPolicy(new iam.PolicyStatement({ sid: "RecordModelGatewayLastGood", actions: ["ssm:GetParameter", "ssm:PutParameter"], resources: [args.lastGoodArn] }));
  role.addToPolicy(new iam.PolicyStatement({ sid: "ReadReleasedCode", actions: ["ssm:GetParameter"], resources: [args.releasedCodeArn] }));
  role.addToPolicy(new iam.PolicyStatement({
    sid: "DenyOrganizationAdminRole", effect: iam.Effect.DENY, actions: ["sts:AssumeRole"], resources: ["arn:aws:iam::*:role/OrganizationAccountAccessRole"],
  }));

  if (isBeta) {
    role.addToPolicy(new iam.PolicyStatement({ sid: "AssumeBetaReleaseRole", actions: ["sts:AssumeRole"], resources: [args.betaReleaseRoleArn] }));
  } else {
    addProductionModelGatewayPolicies(stack, role, args.betaAccountId, args.scoped);
  }

  const project = new codebuild.PipelineProject(stack, isBeta ? "BetaModelGatewayBuild" : "ProductionModelGatewayBuild", {
    projectName: isBeta ? AGENTX_BETA_MODEL_GATEWAY_PROJECT_NAME : AGENTX_PRODUCTION_MODEL_GATEWAY_PROJECT_NAME,
    description: `Runs Code's ${args.environment} model gateway release steps (image, deploy, check) (#1578)`,
    role,
    environment: {
      buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2023_STANDARD_3_0,
      computeType: codebuild.ComputeType.LARGE,
      privileged: true,
      environmentVariables: {
        NODE_OPTIONS: { value: "--max-old-space-size=8192" },
        [MODEL_GATEWAY_ENV_VARIABLE]: { value: args.environment },
        [MODEL_GATEWAY_EXPECTED_ACCOUNT_VARIABLE]: { value: isBeta ? args.betaAccountId : stack.account },
        ...(isBeta ? { BETA_RELEASE_ROLE_ARN: { value: args.betaReleaseRoleArn }, ROVARA_PIPELINE_PROFILE: { value: AGENTX_BETA_PROFILE } } : { BETA_ACCOUNT_ID: { value: args.betaAccountId } }),
      },
    },
    concurrentBuildLimit: 1,
    timeout: Duration.minutes(90),
    cache: codebuild.Cache.local(codebuild.LocalCacheMode.DOCKER_LAYER),
    logging: { cloudWatch: { logGroup: args.logGroup } },
    buildSpec: modelGatewayBuildSpec(args.environment),
  });
  return { project, role };
}

function addProductionModelGatewayPolicies(
  stack: Stack,
  role: iam.Role,
  betaAccountId: string,
  scoped: (service: string, resource: string) => string,
): void {
  const gatewayPrefix = `${RESOURCE_PREFIX}-production-gateway`;
  role.addToPolicy(new iam.PolicyStatement({
    sid: "AssumeCdkBootstrapRoles",
    actions: ["sts:AssumeRole"],
    resources: CDK_BOOTSTRAP_ASSUMED_ROLES.map((kind) => `arn:${stack.partition}:iam::${stack.account}:role/cdk-${CDK_BOOTSTRAP_QUALIFIER}-${kind}-${stack.account}-${stack.region}`),
  }));
  role.addToPolicy(new iam.PolicyStatement({ sid: "EcrAuthorization", actions: ["ecr:GetAuthorizationToken"], resources: ["*"] }));
  role.addToPolicy(new iam.PolicyStatement({
    sid: "PullBetaModelGatewayImage",
    actions: [...PULL_BETA_IMAGE_ACTIONS],
    resources: [`arn:${stack.partition}:ecr:${stack.region}:${betaAccountId}:repository/${BETA_GATEWAY_IMAGES_PREFIX}*`],
  }));
  role.addToPolicy(new iam.PolicyStatement({
    sid: "ProductionModelGatewayRepository",
    actions: [...RELEASE_IMAGE_REPOSITORY_ACTIONS],
    resources: [scoped("ecr", `repository/${gatewayPrefix}-images-*`)],
  }));
  role.addToPolicy(new iam.PolicyStatement({
    sid: "ModelGatewayServiceReads",
    actions: ["ecs:DescribeServices", "ecs:ListServices", "ecs:DescribeTasks", "ecs:ListTasks"],
    resources: ["*"],
    conditions: { ArnLike: { "ecs:cluster": scoped("ecs", `cluster/${gatewayPrefix}-*`) } },
  }));
  role.addToPolicy(new iam.PolicyStatement({ sid: "ModelGatewayTaskDefinitionRead", actions: ["ecs:DescribeTaskDefinition"], resources: ["*"] }));
  role.addToPolicy(new iam.PolicyStatement({
    sid: "ModelGatewayPriceFetchLogs",
    actions: ["logs:DescribeLogStreams", "logs:GetLogEvents", "logs:FilterLogEvents"],
    resources: [scoped("logs", `log-group:${gatewayPrefix}-PriceFetchLogs*`)],
  }));
  role.addToPolicy(new iam.PolicyStatement({
    sid: "ModelGatewayCertificateRead",
    actions: ["acm:DescribeCertificate"],
    resources: [scoped("acm", "certificate/*")],
  }));
}

function betaProfileSetupCommands(): string[] {
  return [
    "mkdir -p ~/.aws",
    `printf '[profile ${AGENTX_BETA_PROFILE}]\\nrole_arn = %s\\ncredential_source = EcsContainer\\nrole_session_name = beta-release\\nregion = %s\\n' "$BETA_RELEASE_ROLE_ARN" "$AWS_REGION" >> ~/.aws/config`,
    `aws sts get-caller-identity --profile ${AGENTX_BETA_PROFILE}`,
  ];
}

export function modelGatewayBuildSpec(environment: "beta" | "production"): codebuild.BuildSpec {
  const craneInstall = environment === "production"
    ? [
        'curl -fsSL -o /tmp/crane.tar.gz "https://github.com/google/go-containerregistry/releases/download/v${CRANE_VERSION}/go-containerregistry_Linux_arm64.tar.gz"',
        'echo "${CRANE_SHA256}  /tmp/crane.tar.gz" | sha256sum -c -',
        "mkdir -p /opt/crane && tar -xzf /tmp/crane.tar.gz -C /opt/crane crane",
        'export PATH="/opt/crane:$PATH"',
        "crane version",
      ]
    : [];
  const stateResolve =
    'if [ -n "${PIPELINE_STATE_ARTIFACT:-}" ]; then case "$PIPELINE_STATE_ARTIFACT" in *[!A-Za-z0-9_]*) echo "PIPELINE_STATE_ARTIFACT is not an artifact name" >&2; exit 1;; esac; ' +
    'state_ref="CODEBUILD_SRC_DIR_${PIPELINE_STATE_ARTIFACT}"; state_dir="${!state_ref:-}"; ' +
    'if [ ! -f "$state_dir/manifest.json" ]; then echo "no manifest.json in previous artifact $PIPELINE_STATE_ARTIFACT" >&2; exit 1; fi; ' +
    'export PIPELINE_MANIFEST="$state_dir/manifest.json"; fi';
  return codebuild.BuildSpec.fromObject({
    version: "0.2",
    env: {
      shell: "bash",
      variables: {
        ...RELEASE_TOOL_VARIABLES,
        ...(environment === "production" ? { CRANE_VERSION: AGENTX_RELEASE_CRANE_VERSION, CRANE_SHA256: AGENTX_RELEASE_CRANE_SHA256 } : {}),
        CODE_RELEASE: CODE_RELEASE_DEFAULT,
        PIPELINE_MODE: PIPELINE_MODE_DEFAULT,
        [PIPELINE_VARIABLE_ROLLBACK_TARGET]: ROLLBACK_TARGET_NONE,
        [PIPELINE_VARIABLE_MODEL_GATEWAY_DIGEST]: MODEL_GATEWAY_DIGEST_NONE,
      },
    },
    phases: {
      install: {
        commands: [
          ...RELEASE_TOOL_INSTALL_COMMANDS,
          ...craneInstall,
          ...(environment === "beta" ? betaProfileSetupCommands() : []),
        ],
      },
      pre_build: {
        commands: ["npm ci --ignore-scripts --no-audit --no-fund"],
      },
      build: {
        commands: [
          `: "\${${MODEL_GATEWAY_STEP_VARIABLE}:?${MODEL_GATEWAY_STEP_VARIABLE} is not set}"`,
          `[ "$${MODEL_GATEWAY_ENV_VARIABLE}" = ${environment} ] || { echo "this project runs ${environment} steps only; ${MODEL_GATEWAY_ENV_VARIABLE} is '$${MODEL_GATEWAY_ENV_VARIABLE}'" >&2; exit 1; }`,
          `case "$${MODEL_GATEWAY_STEP_VARIABLE}" in image|deploy|check) ;; *) echo "unknown ${MODEL_GATEWAY_STEP_VARIABLE} '$${MODEL_GATEWAY_STEP_VARIABLE}'" >&2; exit 1;; esac`,
          stateResolve,
          `npx --no-install tsx scripts/model-gateway-release/cli.ts "$${MODEL_GATEWAY_ENV_VARIABLE}" "$${MODEL_GATEWAY_STEP_VARIABLE}"`,
        ],
      },
    },
    artifacts: { files: ["**/*"], "base-directory": "out" },
  });
}

/**
 * The record of the last released Code commit: this stage's Code Preflight reads it (codePreflightBuildSpec).
 */
export const RECORD_SOURCE_CHECK =
  'if [ "$PIPELINE_MODE" = rollback ] && [ "$CODE_ROLLBACK_TARGET" != none ]; then RELEASED_SOURCE="$CODE_ROLLBACK_TARGET"; else RELEASED_SOURCE="$CODEBUILD_RESOLVED_SOURCE_VERSION"; fi; ' +
  '[[ "$RELEASED_SOURCE" =~ ^[0-9a-f]{40}$ ]] || { echo "the source version of this build is not a commit id; the release is not recorded" >&2; exit 1; }';

export function codeHistoryWrite(parameter: string): string {
  return [
    'HIST_ERR="$(mktemp)"',
    `{ HIST_OLD="$(aws ssm get-parameter --name ${parameter} --query Parameter.Value --output text 2>"$HIST_ERR")" || { grep -q ParameterNotFound "$HIST_ERR" && HIST_OLD=; } || { cat "$HIST_ERR" >&2; false; }; }`,
    `HIST_NEW="$({ printf '%s\\n' "$RELEASED_SOURCE"; printf '%s\\n' "$HIST_OLD" | { grep -oE '"[0-9a-f]{40}"' || true; } | tr -d '"'; } | awk '!seen[$0]++' | head -n ${CODE_HISTORY_LIMIT} | awk 'BEGIN{printf "["} {printf "%s\\"%s\\"", (NR>1?",":""), $0} END{printf "]"}')"`,
    `aws ssm put-parameter --name ${parameter} --type String --overwrite --value "$HIST_NEW"`,
  ].join(" && ");
}

function recordReleasedCode(parameter: string, historyParameter: string): string {
  return `{ ${RECORD_SOURCE_CHECK}; ${codeHistoryWrite(historyParameter)} && aws ssm put-parameter --name ${parameter} --type String --overwrite --value "$RELEASED_SOURCE"; }`;
}

/** Why the transition into Production is disabled; also the reason the production release gives when it closes it again. */
// CodePipeline allows only letters, digits, spaces and !@().*?- in a transition's reason.
export const PROMOTION_GATE_REASON = "Production waits for the owner - enable this transition to let the run waiting here in and then approve ApproveProduction for that run (issue 1242)";

export function releaseProjectSettings(logGroup: logs.ILogGroup) {
  return {
    environment: {
      buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2023_STANDARD_3_0,
      computeType: codebuild.ComputeType.LARGE,
      privileged: true,
    },
    concurrentBuildLimit: 1,
    timeout: Duration.minutes(120),
    cache: codebuild.Cache.local(codebuild.LocalCacheMode.DOCKER_LAYER),
    logging: { cloudWatch: { logGroup } },
  };
}

/** The versions RELEASE_TOOL_INSTALL_COMMANDS reads. */
export const RELEASE_TOOL_VARIABLES = { AWS_CLI_VERSION: AGENTX_RELEASE_AWS_CLI_VERSION, GITLEAKS_VERSION: "8.30.1", GITLEAKS_SHA256: "e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080" } as const;

/** Pinned Node, AWS CLI and gitleaks, installed under /opt (shared with the environment release pipeline). */
export const RELEASE_TOOL_INSTALL_COMMANDS: readonly string[] = [
  'node_version="$(cat .node-version)"',
  'node_archive="node-v${node_version}-linux-arm64.tar.xz"',
  'curl -fsSL -o "/tmp/${node_archive}" "https://nodejs.org/dist/v${node_version}/${node_archive}"',
  'curl -fsSL "https://nodejs.org/dist/v${node_version}/SHASUMS256.txt" | grep " ${node_archive}$" | (cd /tmp && sha256sum -c -)',
  'mkdir -p /opt/node && tar -xJf "/tmp/${node_archive}" -C /opt/node --strip-components=1',
  'curl -fsSL -o /tmp/awscliv2.zip "https://awscli.amazonaws.com/awscli-exe-linux-aarch64-${AWS_CLI_VERSION}.zip"',
  "unzip -q /tmp/awscliv2.zip -d /tmp && /tmp/aws/install --install-dir /opt/aws-cli --bin-dir /opt/aws-cli/bin",
  'curl -fsSL -o /tmp/gitleaks.tar.gz "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_arm64.tar.gz"',
  'echo "${GITLEAKS_SHA256}  /tmp/gitleaks.tar.gz" | sha256sum -c -',
  "mkdir -p /opt/gitleaks && tar -xzf /tmp/gitleaks.tar.gz -C /opt/gitleaks gitleaks",
  'export PATH="/opt/node/bin:/opt/aws-cli/bin:/opt/gitleaks:$PATH"',
  "node --version && npm --version && aws --version && gitleaks version && docker buildx version",
];

/**
 * Each stage's Code Preflight. In Production the FIRST command closes the transition before tools are installed.
 * Runs the port guard from the trusted worktree of the previously released Code commit, over the full range since,
 * and exports CODE_LIVE_SHA for this stage's model gateway steps.
 */
export function codePreflightBuildSpec(closesGate: boolean, namesParameter: string, releasedParameter: string, historyParameter: string): codebuild.BuildSpec {
  const refuse = (why: string): string => `{ echo "port-guard: ${why}; refusing to run the release" >&2; exit 2; }`;
  const target = `$${PIPELINE_VARIABLE_ROLLBACK_TARGET}`;
  const rollbackOnly = `[ "${target}" = ${ROLLBACK_TARGET_NONE} ] ||`;
  const rollbackGuard = portGuardStepCommands(["--range", `${PORT_GUARD_ROLLBACK_REF}..${PORT_GUARD_TIP_REF}`, "--allow-guard-edits"]).filter((command) => command.startsWith("node "));
  return codebuild.BuildSpec.fromObject({
    version: "0.2",
    env: {
      shell: "bash",
      variables: { PIPELINE_MODE: PIPELINE_MODE_DEFAULT, [PIPELINE_VARIABLE_ROLLBACK_TARGET]: ROLLBACK_TARGET_NONE, ...RELEASE_TOOL_VARIABLES, ...portGuardStepVariables(namesParameter) },
      "exported-variables": [CODE_LIVE_SHA_VARIABLE],
    },
    phases: {
      install: {
        commands: [
          ...(closesGate
            ? [`aws codepipeline disable-stage-transition --pipeline-name ${AGENTX_RELEASE_PIPELINE_NAME} --stage-name ${AGENTX_PRODUCTION_STAGE} --transition-type Inbound --reason "${PROMOTION_GATE_REASON}"`]
            : []),
          ...RELEASE_TOOL_INSTALL_COMMANDS,
        ],
      },
      pre_build: { commands: [PIPELINE_MODE_NOTE, ROLLBACK_TARGET_CHECK] },
      build: {
        commands: [
          `RELEASED_SHA="$(aws ssm get-parameter --name ${releasedParameter} --query Parameter.Value --output text)" || ${refuse("the last released Code commit could not be read")}`,
          `[[ "$RELEASED_SHA" =~ ^[0-9a-f]{40}$ ]] || ${refuse("the last released Code commit is not recorded")}`,
          `git cat-file -e "$RELEASED_SHA^{commit}" || ${refuse("the last released Code commit is not in this clone")}`,
          ...supersedesCommands(!closesGate),
          `export ${CODE_LIVE_SHA_VARIABLE}="$RELEASED_SHA"`,
          ...rollbackTargetInHistory(historyParameter, refuse).map((body) => `${rollbackOnly} { ${body}; }`),
          `${rollbackOnly} { [ "${target}" != "$RELEASED_SHA" ] || ${refuse("the rollback target is the commit already released")}; }`,
          `${rollbackOnly} { git cat-file -e "${target}^{commit}" || ${refuse("the rollback target is not in this clone")}; }`,
          `${rollbackOnly} { git merge-base --is-ancestor "${target}" "$RELEASED_SHA" || ${refuse("the rollback target is not older than the last released commit")}; }`,
          `${rollbackOnly} git checkout -q --detach "$RELEASED_SHA"`,
          `git merge-base --is-ancestor "$RELEASED_SHA" HEAD || ${refuse("the last released Code commit is not an ancestor of this commit")}`,
          `[ "$(git rev-parse HEAD)" = "$RELEASED_SHA" ] || [ "$(git rev-list --parents -n 1 HEAD | wc -w | tr -d ' ')" -le 3 ] || ${OCTOPUS_REFUSAL}`,
          `[ "$(git rev-parse HEAD)" = "$RELEASED_SHA" ] || [ "$(git rev-list --parents -n 1 HEAD | wc -w | tr -d ' ')" = 3 ] || [ "$(git rev-parse HEAD^1)" = "$RELEASED_SHA" ] || ${LINEAR_LANDING_REFUSAL}`,
          `git update-ref refs/heads/${PORT_GUARD_TIP_REF} HEAD`,
          `git worktree add --detach ${PORT_GUARD_TRUSTED_DIRECTORY} "$RELEASED_SHA"`,
          `cd ${PORT_GUARD_TRUSTED_DIRECTORY}`,
          ...portGuardStepCommands(["--range", `HEAD..${PORT_GUARD_TIP_REF}`, "--allow-guard-edits"]),
          `${rollbackOnly} git update-ref refs/heads/${PORT_GUARD_ROLLBACK_REF} "${target}"`,
          ...rollbackGuard.map((command) => `${rollbackOnly} ${command}`),
        ],
      },
    },
  });
}

export const PIPELINE_MODE_NOTE =
  'case "$PIPELINE_MODE" in release|adopt|rollback) echo "NOTE: pipeline mode is $PIPELINE_MODE" ;; *) echo "PIPELINE_MODE must be release, adopt or rollback, got: $PIPELINE_MODE" >&2; exit 1;; esac';
export const ROLLBACK_TARGET_CHECK =
  'if [ "$PIPELINE_MODE" = rollback ] && [ "$CODE_ROLLBACK_TARGET" != none ]; then ' +
  '[[ "$CODE_ROLLBACK_TARGET" =~ ^[0-9a-f]{40}$ ]] || { echo "CODE_ROLLBACK_TARGET must be a full 40-character commit id, or none, got: $CODE_ROLLBACK_TARGET" >&2; exit 1; }; ' +
  'echo "NOTE: Code rollback target is $CODE_ROLLBACK_TARGET"; ' +
  'elif [ "$PIPELINE_MODE" != rollback ] && [ "$CODE_ROLLBACK_TARGET" != none ]; then ' +
  'echo "CODE_ROLLBACK_TARGET is only for PIPELINE_MODE=rollback; got $CODE_ROLLBACK_TARGET in mode $PIPELINE_MODE" >&2; exit 1; fi';

export function supersedesCommands(lookup: boolean): string[] {
  const stateQuery = `'stageStates[?stageName==\`${AGENTX_PRODUCTION_STAGE}\`].inboundExecution.pipelineExecutionId | [0]'`;
  const revisionQuery = "'pipelineExecution.artifactRevisions[?name==`Source`].revisionId | [0]'";
  const uuid = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
  const none = "SUPERSEDES_EXEC=none; SUPERSEDES_SHA=none";
  if (!lookup) return [none];
  return [
    none,
    `WAITING_EXEC="$(aws codepipeline get-pipeline-state --name ${AGENTX_RELEASE_PIPELINE_NAME} --query ${stateQuery} --output text)" || { echo "WARN: the execution waiting for Production could not be read; the summary will not name it" >&2; WAITING_EXEC=; }`,
    `if [[ "$WAITING_EXEC" =~ ${uuid} ]] && [ "$WAITING_EXEC" != "\${EXEC_ID:-}" ]; then ` +
      `WAITING_SHA="$(aws codepipeline get-pipeline-execution --pipeline-name ${AGENTX_RELEASE_PIPELINE_NAME} --pipeline-execution-id "$WAITING_EXEC" --query ${revisionQuery} --output text)" || WAITING_SHA=; ` +
      `[[ "$WAITING_SHA" =~ ^[0-9a-f]{40}$ ]] || WAITING_SHA=none; ` +
      `SUPERSEDES_EXEC="$WAITING_EXEC"; SUPERSEDES_SHA="$WAITING_SHA"; ` +
      `echo "NOTE: this run replaces the execution $WAITING_EXEC (Code $SUPERSEDES_SHA), which is waiting for Production"; fi`,
  ];
}

export function rollbackTargetInHistory(historyParameter: string, fail: (why: string) => string): string[] {
  const target = `$${PIPELINE_VARIABLE_ROLLBACK_TARGET}`;
  return [
    `HIST_VALUE="$(aws ssm get-parameter --name ${historyParameter} --query Parameter.Value --output text)" || ${fail("the Code release history could not be read")}`,
    `HIST_FLAT="$(printf '%s' "$HIST_VALUE" | tr -d ' \\t\\r\\n')"; HIST_RE='^\\[("[0-9a-f]{40}"(,"[0-9a-f]{40}")*)?\\]$'; [[ "$HIST_FLAT" =~ $HIST_RE ]] || ${fail("the Code release history is not a list of commits")}`,
    `[[ "$HIST_FLAT" == *"\\"${target}\\""* ]] || ${fail("the rollback target is not in this stage's Code release history")}`,
  ];
}

export const LINEAR_LANDING_REFUSAL =
  '{ echo "port-guard: this landing has $(git rev-list --count "$RELEASED_SHA..HEAD") commits on the last released commit that were not merged as one change, so this run does not release them. The next normal merge (a merge commit on top of them) releases them, scanned whole; or re-land the change as one squash or one merge." >&2; exit 2; }';
export const OCTOPUS_REFUSAL =
  '{ echo "port-guard: this commit is an octopus merge ($(( $(git rev-list --parents -n 1 HEAD | wc -w) - 1 )) parents), which the release does not accept. Re-land the change as a normal two-parent merge or as one squash." >&2; exit 2; }';
const PORT_GUARD_TIP_REF = "release-tip";
const PORT_GUARD_ROLLBACK_REF = "rollback-target";
const PORT_GUARD_TRUSTED_DIRECTORY = "/tmp/port-guard-trusted";

interface ReleaseBuildSpec {
  historyParameter: string;
  variables?: Record<string, string>;
  beforeRelease?: string[];
  release: string;
  afterRelease?: string[];
}

/** True in a Code release build that must do nothing: explicit CODE_RELEASE=skip or PIPELINE_MODE=adopt (one-time adopt run changes nothing). */
const CODE_RELEASE_IS_SKIP = '{ [ "$CODE_RELEASE" = skip ] || [ "$PIPELINE_MODE" = adopt ]; }';
export const CODE_RELEASE_CHECK =
  'case "$CODE_RELEASE" in run|skip) ;; *) echo "CODE_RELEASE must be run or skip, got: $CODE_RELEASE" >&2; exit 1;; esac';

export const rollbackReleaseChecks = (historyParameter: string): string[] => {
  const fail = (why: string): string => `{ echo "${why}; Code is not rolled back" >&2; exit 1; }`;
  const target = `$${PIPELINE_VARIABLE_ROLLBACK_TARGET}`;
  return [
    ...ROLLBACK_MODE_CHECKS,
    ...rollbackTargetInHistory(historyParameter, fail).map((body) => `[ "${target}" = ${ROLLBACK_TARGET_NONE} ] || { ${body}; }`),
    `[ "${target}" = ${ROLLBACK_TARGET_NONE} ] || { git cat-file -e "${target}^{commit}" || ${fail("the rollback target is not in this clone")}; }`,
    `[ "${target}" = ${ROLLBACK_TARGET_NONE} ] || { git merge-base --is-ancestor "${target}" HEAD || ${fail("the rollback target is not an ancestor of this run's commit")}; }`,
  ];
};
const ROLLBACK_MODE_CHECKS: readonly string[] = [
  'case "$PIPELINE_MODE" in release|adopt|rollback) ;; *) echo "PIPELINE_MODE must be release, adopt or rollback, got: $PIPELINE_MODE" >&2; exit 1;; esac',
  ROLLBACK_TARGET_CHECK,
  'if [ "$PIPELINE_MODE" = rollback ]; then if [ "$CODE_ROLLBACK_TARGET" = none ]; then [ "$CODE_RELEASE" = skip ] || { echo "a rollback run with no Code rollback target does not release Code, but CODE_RELEASE is $CODE_RELEASE" >&2; exit 1; }; ' +
    'else [ "$CODE_RELEASE" = run ] || { echo "a Code rollback target was given but CODE_RELEASE is $CODE_RELEASE, so Code would not be rolled back" >&2; exit 1; }; fi; fi',
];
const codeReleaseGuarded = (command: string): string => `${CODE_RELEASE_IS_SKIP} || { ${command}; }`;
const SKIPPED_MANIFEST = "mkdir -p cdk.out && printf '{\"codeRelease\":\"skip\"}\\n' > cdk.out/agentx-production-release.json";

function releaseBuildSpec(spec: ReleaseBuildSpec): codebuild.BuildSpec {
  const proofAndRelease =
    `if node scripts/release-ci-proof.ts --repository ${AGENTX_RELEASE_REPOSITORY_OWNER}/${AGENTX_RELEASE_REPOSITORY_NAME} --github-app-stack ${AGENTX_RELEASE_STACKS[0]} --region "$AWS_REGION"; then RELEASE_CHECKS=--skip-checks; else RELEASE_CHECKS=; fi; ` +
    [...(spec.beforeRelease ?? []), spec.release, ...(spec.afterRelease ?? [])].join(" && ");
  return codebuild.BuildSpec.fromObject({
    version: "0.2",
    env: {
      shell: "bash",
      variables: {
        NODE_OPTIONS: "--max-old-space-size=8192",
        CODE_RELEASE: CODE_RELEASE_DEFAULT,
        PIPELINE_MODE: PIPELINE_MODE_DEFAULT,
        [PIPELINE_VARIABLE_ROLLBACK_TARGET]: ROLLBACK_TARGET_NONE,
        ...RELEASE_TOOL_VARIABLES,
        ...spec.variables,
      },
    },
    phases: {
      install: {
        commands: [
          CODE_RELEASE_CHECK,
          '[ "$CODE_RELEASE" != skip ] || echo "CODE_RELEASE=skip: Code is not built or deployed"',
          '[ "$PIPELINE_MODE" != adopt ] || echo "PIPELINE_MODE=adopt: adopt run checks the live model gateway and leaves Code unchanged"',
          ...rollbackReleaseChecks(spec.historyParameter),
          codeReleaseGuarded('[ "$PIPELINE_MODE" != rollback ] || [ "$CODE_ROLLBACK_TARGET" = none ] || git checkout -q --detach "$CODE_ROLLBACK_TARGET"'),
          ...RELEASE_TOOL_INSTALL_COMMANDS.map(codeReleaseGuarded),
        ],
      },
      pre_build: {
        commands: [codeReleaseGuarded("npm ci")],
      },
      build: {
        commands: [`if ${CODE_RELEASE_IS_SKIP}; then ${SKIPPED_MANIFEST}; else ${proofAndRelease}; fi`],
      },
    },
    artifacts: {
      files: ["cdk.out/agentx-production-release.json"],
      "discard-paths": "yes",
    },
  });
}
