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
import { portGuardNamesParameter, portGuardNamesReadStatements, portGuardStepCommands, portGuardStepVariables } from "./port-guard-step.js";
import { AGENTX_SLACK_ORCHESTRATOR_REPOSITORY } from "./slack-orchestrator.js";

export const AGENTX_RELEASE_REPOSITORY_OWNER = "PrepLabsAI";
export const AGENTX_RELEASE_REPOSITORY_NAME = "Rovara";
export const AGENTX_RELEASE_BRANCH = "mainline";
// Must not match the broker's `agentx-*` CodeBuild gate allow-list, or a worker could start a release.
export const AGENTX_RELEASE_PROJECT_NAME = "release-agentx-production";
// #1242: the beta release's project, under the same rule as the production one.
export const AGENTX_BETA_RELEASE_PROJECT_NAME = "release-agentx-beta";
export const AGENTX_RELEASE_PIPELINE_NAME = "AgentXProductionRelease";
/** The pipeline's last stage. Its inbound transition stays disabled, so a run waits in front of it (#1242); the run is released by its OWN approval action (DEC 254zzz506). */
export const AGENTX_PRODUCTION_STAGE = "Production";
/**
 * PROD-APPROVAL-BOUND (DEC 254zzz506: every production deploy needs the owner's explicit approval for THAT run). The Production stage holds a CodePipeline manual approval, run order 2, right after
 * the Code Preflight (run order 1, read-only: its first command closes the transition, then the port guard runs). Every other Production action, all of them writers, runs after the approval.
 * An approval belongs to one execution, so an open transition alone (enabled while no run waited, or left open when the Code Preflight failed before its first command) can no
 * longer let the NEXT run into Production unapproved: that run stops at its own approval. The gate closes BEFORE the approval, so a rejected or timed-out run leaves the transition closed, whatever
 * the outcome. The transition stays disabled as well: it holds the run that is waiting (a newer run replaces it, SUPERSEDED mode, #1242), the approval releases it.
 * No role this template creates may approve, enable the transition, or start or retry an execution.
 */
export const AGENTX_PRODUCTION_APPROVAL_ACTION = "ApproveProduction";
/** An unanswered approval fails after this long (the run stops; the stage unlocks); CodePipeline's own default is 7 days. */
export const AGENTX_PRODUCTION_APPROVAL_TIMEOUT_HOURS = 24;
/** The beta release build's own role, by a fixed name: the beta account's release role trusts exactly this role (beta-release-access.ts). */
export const AGENTX_BETA_BUILD_ROLE_NAME = "agentx-release-beta-build";
/** The role in the beta account that the beta release runs as (beta-release-access.ts). */
export const AGENTX_BETA_RELEASE_ROLE_NAME = "agentx-beta-release";
/** The AWS profile the beta build writes for that role: assumed from the build's own credentials, and assumed again by each AWS CLI and CDK process. */
export const AGENTX_BETA_PROFILE = "agentx-beta";
/**
 * The Code half of each stage's Preflight, a public project run first in Beta and in Production: in Production its FIRST command closes the transition
 * into Production (moved out of the production release project, so the gate closes before any gate runs), then it runs the port guard on the Code tree with
 * the private name list, whatever the CI proof says (L14). The names end with the stage's.
 */
export const AGENTX_CODE_PREFLIGHT_PROJECT_PREFIX = "release-agentx-preflight";
export const AGENTX_BETA_CODE_PREFLIGHT_PROJECT_NAME = `${AGENTX_CODE_PREFLIGHT_PROJECT_PREFIX}-beta`;
export const AGENTX_PRODUCTION_CODE_PREFLIGHT_PROJECT_NAME = `${AGENTX_CODE_PREFLIGHT_PROJECT_PREFIX}-production`;
/**
 * The namespaces of the two source actions: their CommitId reaches every Cloud action. CodePipeline refuses a namespace that equals the name of any artifact of the pipeline
 * ("Namespaces must be unique across the pipeline definition and cannot conflict with any artifact names"), and the Cloud source's output artifact is named `CloudSource`
 * (its name is part of the S3 key layout the Cloud stack's grants rely on), so its namespace carries a suffix. Beta's Cloud Preflight reads `#{CloudSourceVariables.CommitId}` as CLOUD_SOURCE_COMMIT (the commit a pushed Cloud tag points at).
 */
export const CODE_SOURCE_NAMESPACE = "CodeSource";
export const CLOUD_SOURCE_NAMESPACE = "CloudSourceVariables";
export const AGENTX_PRODUCTION_WORKER_REPOSITORY = "agentx-worker-production";

/**
 * The pipeline's artifact bucket holds every artifact of every run, and it is not versioned: a role that can write anywhere in it can overwrite the `Source` and
 * `CloudSource` artifacts that a later stage reads (the Production stage builds from the same `Source` the approval was given on), or another stage's output. Each build role
 * therefore writes only its own output artifacts (PH-S3-PREFIXES), and the bucket's own grant (ReleaseArtifactBucket) gives it nothing else.
 *
 * CodePipeline stores an artifact at `<pipeline name, first 20 characters>/<artifact name, first 10 characters>/<id>`. Nothing here reads a real run: the patterns stay right for
 * any truncation at or beyond those lengths and for none at all (a name longer than its limit is cut to the limit and ends in `*`), and a shorter truncation fails closed (a write
 * is refused and the first beta run shows it). The private Cloud stack's grants (cloud-release-actions.ts) hold the same two numbers and the Cloud state prefixes below.
 */
export const ARTIFACT_KEY_PIPELINE_CHARS = 20;
export const ARTIFACT_KEY_NAME_CHARS = 10;
/**
 * The Cloud steps' state artifacts: `State<Beta|Prod><Action>`. One short prefix per environment tells an environment's states from every other artifact in the bucket
 * (`Source`, `CloudSource`, `ReleaseManifest`, `BetaReleaseManifest`): a bare `Beta*` would match `BetaReleaseManifest`, the Code beta release's own output.
 */
export const CLOUD_STATE_ARTIFACT_PREFIXES = { beta: "StateBeta", production: "StateProd" } as const;
export const cloudStateArtifactName = (environment: "beta" | "production", action: string): string => `${CLOUD_STATE_ARTIFACT_PREFIXES[environment]}${action}`;
/** The S3 resource pattern of every object of one artifact: `<bucket ARN>/<pipeline>/<artifact>`, cut as CodePipeline cuts it (a cut name ends in `*`). */
export function artifactKeyPattern(bucketArn: string, artifactName: string): string {
  const pipeline = AGENTX_RELEASE_PIPELINE_NAME.length > ARTIFACT_KEY_PIPELINE_CHARS ? `${AGENTX_RELEASE_PIPELINE_NAME.slice(0, ARTIFACT_KEY_PIPELINE_CHARS)}*` : AGENTX_RELEASE_PIPELINE_NAME;
  const artifact = artifactName.length > ARTIFACT_KEY_NAME_CHARS ? `${artifactName.slice(0, ARTIFACT_KEY_NAME_CHARS)}*` : `${artifactName}/*`;
  return `${bucketArn}/${pipeline}/${artifact}`;
}

/**
 * The pipeline's artifact bucket, which hands out its write grant by role. aws-cdk-lib gives the project of every CodeBuild action that has an output
 * `bucket.grantReadWrite(project)`: read, PutObject, tagging and retention, DeleteObject* and Abort*, on the whole bucket. For a project registered with `scopeWrites` the grant
 * is read on the bucket (what the inputs need) and PutObject plus AbortMultipartUpload (a failed upload leaves no stranded parts) on the project's own output artifacts, and nothing else. Any other grantee (the pipeline's own role, the source
 * action roles) gets CDK's grant unchanged.
 */
export class ReleaseArtifactBucket extends s3.Bucket {
  private readonly ownOutputs = new Map<iam.IPrincipal, readonly string[]>();

  /** The object patterns a project's role may write: its output artifacts, and what the explicit Deny leaves out. */
  scopeWrites(project: codebuild.IProject, outputNames: readonly string[]): string[] {
    const patterns = outputNames.map((name) => artifactKeyPattern(this.bucketArn, name));
    this.ownOutputs.set(project.grantPrincipal, patterns);
    return patterns;
  }

  override grantReadWrite(identity: iam.IGrantable, objectsKeyPattern?: unknown): iam.Grant {
    const patterns = this.ownOutputs.get(identity.grantPrincipal);
    if (patterns === undefined) return super.grantReadWrite(identity, objectsKeyPattern);
    return this.grantRead(identity).combine(iam.Grant.addToPrincipal({ grantee: identity, actions: ["s3:PutObject", "s3:AbortMultipartUpload"], resourceArns: [...patterns] }));
  }
}

// The Cloud half of the one pipeline. Its CodeBuild projects, their roles and the Cloud permissions boundary live in a small private stack
// (the Cloud release actions stack, lane L1b); this stack only references the projects by name, through parameters (BETA-CLOUD-PLAN 1.1, C6).
/**
 * STUB, until the interface of the Cloud stage CLI (L2-STAGE-CLI-INTERFACE.md) and the private actions stack name them: the default values of the two project-name
 * parameters. Each is ONE project per environment; the step an action runs arrives as CLOUD_STEP_VARIABLE. A hand redeploy passes the real names. Both must start
 * with `release-`: the legacy runtime boundary denies every CodeBuild action on `project/release-*`, and the broker may start only `agentx-*` projects.
 */
export const CLOUD_BETA_ACTIONS_PROJECT_STUB = "release-cloud-beta";
export const CLOUD_PRODUCTION_ACTIONS_PROJECT_STUB = "release-cloud-production";
export const CLOUD_PROJECT_NAME_PATTERN = "^release-[A-Za-z0-9_-]{1,120}$";
/**
 * The stage CLI's inputs, as environment variables on every Cloud action (names from the stage CLI's interface, section 1 and 7): the environment and the step
 * (one project per environment, the step overridden per action), the execution id and the Code commit. PIPELINE_STATE_ARTIFACT names the previous action's
 * output artifact: CodeBuild puts a secondary input at $CODEBUILD_SRC_DIR_<artifact name>, and each action's output has a name of its own, so the buildspec
 * resolves the directory from this name.
 */
export const CLOUD_ENVIRONMENT_VARIABLE = "STAGE_ENV";
export const CLOUD_STEP_VARIABLE = "STAGE_STEP";
export const CLOUD_STATE_ARTIFACT_VARIABLE = "PIPELINE_STATE_ARTIFACT";
/**
 * What the Preflight actions export (the private buildspec's `exported-variables`) for this stack's Code actions to read: the EFFECTIVE value of CODE_RELEASE (a
 * rollback run forces `skip`, BETA-CLOUD-PLAN 1.3). A missing export fails the Code action; it is never read as `run`.
 */
export const CLOUD_PREFLIGHT_EXPORT_CODE_RELEASE = "CODE_RELEASE_EFFECTIVE";
/** The V2 pipeline variables (BETA-CLOUD-PLAN 1.3). Every one has a default, or a push or tag trigger could not start the pipeline. */
export const PIPELINE_VARIABLE_CLOUD_REF = "CLOUD_REF";
export const PIPELINE_VARIABLE_CODE_RELEASE = "CODE_RELEASE";
export const PIPELINE_VARIABLE_CLOUD_PROD = "CLOUD_PROD";
/**
 * `release` (the default), `adopt` or `rollback`. An adoption run changes nothing (the stage CLI maps it to its adoption mode, and refuses a release run in an environment it
 * never adopted). A rollback run deploys an EARLIER released Code commit, named by CODE_ROLLBACK_TARGET, or (target `none`) rolls Cloud back and leaves Code alone.
 */
export const PIPELINE_VARIABLE_MODE = "PIPELINE_MODE";
export const PIPELINE_MODE_DEFAULT = "release";
/**
 * The Code commit a rollback run deploys: a full 40-hex sha that must be in the stage's release history (CODE_HISTORY_PARAMETER), checked by the Code Preflight before any guard
 * runs. `none` (a variable's default may not be empty) means no Code rollback; any other mode refuses a target. Not a switch: a per-run parameter that does nothing in a release run.
 */
export const PIPELINE_VARIABLE_ROLLBACK_TARGET = "CODE_ROLLBACK_TARGET";
export const ROLLBACK_TARGET_NONE = "none";
/**
 * What each stage's Code Preflight exports, as ONE short value with no quotes, to that stage's Cloud PREFLIGHT action only (CodePipeline caps an action's configuration value at 1000
 * characters and the Cloud actions' environment is already near it; the stage CLI carries the parts to its later steps in its state artifact):
 *   live:<40hex>,target:<40hex|none>,supersedes:<execution uuid|none>,supersedesSha:<40hex|none>
 * live = the commit the stage has released (the rollback pin); target = CODE_ROLLBACK_TARGET; supersedes and supersedesSha = the execution waiting in front of Production that this run
 * replaces and the Code commit it holds (Beta's Preflight looks; Production's always says none, the stage CLI keeps Beta's). Every part is checked before it is written, so nothing needs quoting.
 */
export const CODE_CONTEXT_VARIABLE = "CODE_CTX";
export const CODE_PREFLIGHT_NAMESPACE = { beta: "BetaCodePreflight", production: "ProductionCodePreflight" } as const;
/** The account each stage's Cloud actions must be running in; the stage CLI refuses anything else (exit 3). Never written as a literal here: Beta's comes from BetaAccountId, Production's is this stack's own account. */
export const CLOUD_EXPECTED_ACCOUNT_VARIABLE = "ROVARA_EXPECTED_DEPLOY_ACCOUNT";
/**
 * The last Code commit each stage released: a plain SSM String in this account, written by the Code release build as its LAST command (so only after a release that
 * finished, never for a CODE_RELEASE=skip run), read by that stage's Code Preflight. It is the trust anchor of the port-guard step: the guard that runs while the
 * private name list is on disk is the previously released commit's, over everything since. Seeded by hand once (the live Code sha); unset or unreadable fails the step.
 */
export const CODE_RELEASED_PARAMETER = {
  beta: "/agentx/release/code-released/beta",
  production: "/agentx/release/code-released/production",
} as const;
/**
 * The bounded history of what each stage released: a JSON list of the last CODE_HISTORY_LIMIT Code shas, newest first, an SSM String beside the released record. Written by the
 * SAME finished-release step as the record (one braced group, first, so a failed release writes neither), with the same IAM writer rule; read tolerantly when written (a missing or
 * garbled list starts a fresh one) and strictly by a rollback (a missing or garbled list refuses). A rollback may only target a sha in it.
 */
export const CODE_HISTORY_PARAMETER = {
  beta: "/agentx/release/code-history/beta",
  production: "/agentx/release/code-history/production",
} as const;
export const CODE_HISTORY_LIMIT = 10;
/** The newest vX.Y.Z tag on the Cloud trunk. A value to type on a manual run; never CLOUD_REF's default and never what a tag-push run carries. */
export const CLOUD_REF_LATEST = "latest";
/**
 * CLOUD_REF's default (a variable's default may not be empty), so what every triggered run carries. CodePipeline V2 cannot bind the pushed tag to a variable: a trigger has no variables, and the
 * CodeStarSourceConnection output variables (AuthorDate, BranchName, CommitId, CommitMessage, ConnectionArn, FullRepositoryName) hold no tag name. So the Cloud actions get the commit the
 * Cloud source resolved (CLOUD_SOURCE_COMMIT_VARIABLE), and the value below tells the Cloud Preflight to resolve the ref from that commit: exactly one vX.Y.Z tag on it, else refuse before any write.
 */
export const CLOUD_REF_FROM_TRIGGER = "from-trigger";
/** The Cloud source's commit (`#{CloudSourceVariables.CommitId}`), on Beta's Cloud Preflight action (Production's reads the ref Beta resolved): the commit the pushed tag points at when a tag push started the run. */
export const CLOUD_SOURCE_COMMIT_VARIABLE = "CLOUD_SOURCE_COMMIT";
/** CLOUD_PROD's default: a triggered run never deploys production's Cloud; the production flip sets `on` explicitly, per run. */
export const CLOUD_PROD_DEFAULT = "off";
/** The tags that start a run: `v1.2.3` yes, `v1.2.3-rc1` no. */
export const CLOUD_TAG_TRIGGER = { tagsIncludes: ["v*.*.*"], tagsExcludes: ["v*-*"] } as const;
/** The Cloud steps of a stage, in order; the Code release sits after GatewayCheck (gateway, then Code, then web and app: BETA-CLOUD-PLAN 1.2). */
export const CLOUD_STEPS_BEFORE_CODE = [
  { action: "Preflight", step: "preflight" },
  { action: "CloudImage", step: "image" },
  { action: "CloudGateway", step: "gateway" },
  { action: "GatewayCheck", step: "gateway-check" },
] as const;
export const CLOUD_STEPS_AFTER_CODE = [
  { action: "CloudWebApp", step: "web-app" },
  { action: "CloudProof", step: "proof" },
] as const;
export const AGENTX_RELEASE_AWS_CLI_VERSION = "2.36.47";
// Every stack the release scripts name (scripts/release-production.ts, release-common.ts): the release roles may read these (cloudformation:DescribeStacks) and no more.
// A stack the release only READS still belongs here: without the grant, DescribeStacks answers AccessDenied, which the release cannot tell from a missing stack (train 41: AgentXApiAddress).
// tests/contract/release-stacks-list.test.ts fails if a stack the scripts name is missing. Append only: [0] is the install's GitHub App stack for CI's proof.
export const AGENTX_RELEASE_STACKS = [
  "AgentXControlPlane",
  "AgentXProductionFoundation",
  "AgentXProductionRuntime",
  "AgentXSlackOrchestrator",
  "AgentXApiAddress",
] as const;
// Deployable inputs only: the worker and Slack orchestrator images, the control-plane Lambdas, and the CDK app.
// packages/aws-adapters is left out on purpose: the legacy production template must stay byte-identical, and the images take only that
// package's manifest (for npm ci), whose dependency changes always arrive with package-lock.json, which is listed.
export const AGENTX_RELEASE_TRIGGER_PATHS = [
  "environments/**",
  "infra/**",
  "packages/{broker,cli,code-api,contracts,gateway,local-adapters,mcp,model-runtime,orchestrator,slack-service,verifier,worker}/**",
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

    // The Cloud repository, the second source. Owner, name, branch (the trunk: it changes with the branch plan, so it is never a constant here) and the
    // connection are parameters with no defaults, so the hand deploy states them; the private runbook has the values.
    const cloudOwner = new CfnParameter(this, "CloudRepoOwner", {
      type: "String",
      allowedPattern: "^[A-Za-z0-9-]{1,39}$",
      description: "GitHub owner of the Cloud repository, the pipeline's second source",
    });
    const cloudName = new CfnParameter(this, "CloudRepoName", {
      type: "String",
      allowedPattern: "^[A-Za-z0-9._-]{1,100}$",
      description: "Name of the Cloud repository, the pipeline's second source",
    });
    const cloudBranch = new CfnParameter(this, "CloudRepoBranch", {
      type: "String",
      allowedPattern: "^[A-Za-z0-9._/-]{1,100}$",
      description: "The Cloud trunk branch the second source follows; a release resolves its tag on this branch",
    });
    const cloudConnectionArn = new CfnParameter(this, "CloudConnectionArn", {
      type: "String",
      allowedPattern:
        "^arn:aws(-[a-z]+)?:(codeconnections|codestar-connections):[a-z0-9-]+:[0-9]{12}:connection/[0-9a-f-]{36}$",
      description: "Authorized CodeConnections GitHub connection that can read the Cloud repository",
    });
    const useCloudConnection = new iam.PolicyStatement({
      actions: ["codeconnections:UseConnection", "codestar-connections:UseConnection"],
      resources: [cloudConnectionArn.valueAsString],
    });
    // The Cloud actions' CodeBuild projects, by name, from the private actions stack. Deploy that stack first: CodePipeline refuses an action whose project does not exist.
    const cloudProjectNames = {
      beta: new CfnParameter(this, "CloudBetaProjectName", {
        type: "String",
        default: CLOUD_BETA_ACTIONS_PROJECT_STUB,
        allowedPattern: CLOUD_PROJECT_NAME_PATTERN,
        description: `The Cloud actions' CodeBuild project for the Beta stage (owned by the private Cloud actions stack); must start with release-`,
      }),
      production: new CfnParameter(this, "CloudProductionProjectName", {
        type: "String",
        default: CLOUD_PRODUCTION_ACTIONS_PROJECT_STUB,
        allowedPattern: CLOUD_PROJECT_NAME_PATTERN,
        description: `The Cloud actions' CodeBuild project for the Production stage (owned by the private Cloud actions stack); must start with release-`,
      }),
    };

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

    const project = new codebuild.PipelineProject(this, "ReleaseBuild", {
      projectName: AGENTX_RELEASE_PROJECT_NAME,
      description: "Runs npm run release:prod for AgentX mainline commits",
      ...releaseProjectSettings(logGroup),
      buildSpec: releaseBuildSpec({
        historyParameter: CODE_HISTORY_PARAMETER.production,
        // The gate it came through is closed by the production Code Preflight, first thing in the Production stage (before Preflight's gates), not here.
        release: 'npm run release:prod -- --region "$AWS_REGION" --reuse-unchanged-worker --require-existing-foundation $RELEASE_CHECKS',
        afterRelease: [recordReleasedCode(CODE_RELEASED_PARAMETER.production, CODE_HISTORY_PARAMETER.production)],
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
        historyParameter: CODE_HISTORY_PARAMETER.beta,
        variables: { BETA_RELEASE_ROLE_ARN: betaReleaseRoleArn },
        beforeRelease: [
          "mkdir -p ~/.aws",
          `printf '[profile ${AGENTX_BETA_PROFILE}]\\nrole_arn = %s\\ncredential_source = EcsContainer\\nrole_session_name = beta-release\\nregion = %s\\n' "$BETA_RELEASE_ROLE_ARN" "$AWS_REGION" >> ~/.aws/config`,
          `aws sts get-caller-identity --profile ${AGENTX_BETA_PROFILE}`,
        ],
        release: `npm run release:prod -- --region "$AWS_REGION" --profile ${AGENTX_BETA_PROFILE} --reuse-unchanged-worker --require-existing-foundation $RELEASE_CHECKS`,
        afterRelease: [recordReleasedCode(CODE_RELEASED_PARAMETER.beta, CODE_HISTORY_PARAMETER.beta)],
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
    const releasedCodeArn = (stage: "beta" | "production"): string => scoped("ssm", `parameter${CODE_RELEASED_PARAMETER[stage]}`);
    project.addToRolePolicy(new iam.PolicyStatement({ sid: "RecordReleasedCode", actions: ["ssm:PutParameter"], resources: [releasedCodeArn("production")] }));
    // The release history beside it: read to prepend, written by the same step (same writer rule: this role only, that one parameter).
    const codeHistoryArn = (stage: "beta" | "production"): string => scoped("ssm", `parameter${CODE_HISTORY_PARAMETER[stage]}`);
    project.addToRolePolicy(new iam.PolicyStatement({ sid: "RecordCodeHistory", actions: ["ssm:GetParameter", "ssm:PutParameter"], resources: [codeHistoryArn("production")] }));
    // The Code half of Preflight (L14 and #1242). The private name list is an SSM SecureString in this account: the stack takes its NAME and the key's ARN as
    // parameters, with no default, so a deploy without them fails rather than building a step that cannot load the list.
    const portGuardNames = portGuardNamesParameter(this);
    const portGuardKey = new CfnParameter(this, "PortGuardNamesKeyArn", {
      type: "String",
      allowedPattern: "^arn:aws(-[a-z]+)?:kms:[a-z0-9-]+:[0-9]{12}:key/[0-9a-f-]{36}$",
      description: "The customer-managed KMS key that encrypts the port guard's name list (decrypt is granted through SSM only)",
    });
    const preflightProject = (id: string, projectName: string, closesGate: boolean): codebuild.PipelineProject => {
      const preflight = new codebuild.PipelineProject(this, id, {
        projectName,
        description: closesGate
          ? "Closes the transition into Production, then runs the port guard on the Code tree with the private name list (#1242, L14)"
          : "Runs the port guard on the Code tree with the private name list, before the Beta stage's gates and writes (L14)",
        environment: {
          buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2023_STANDARD_3_0,
          computeType: codebuild.ComputeType.MEDIUM,
        },
        concurrentBuildLimit: 1,
        timeout: Duration.minutes(30),
        logging: { cloudWatch: { logGroup } },
        buildSpec: codePreflightBuildSpec(
          closesGate,
          portGuardNames.valueAsString,
          closesGate ? CODE_RELEASED_PARAMETER.production : CODE_RELEASED_PARAMETER.beta,
          closesGate ? CODE_HISTORY_PARAMETER.production : CODE_HISTORY_PARAMETER.beta,
        ),
      });
      if (closesGate) {
        preflight.addToRolePolicy(new iam.PolicyStatement({
          sid: "ClosePromotionGate",
          actions: ["codepipeline:DisableStageTransition"],
          resources: [`${pipelineArn}/${AGENTX_PRODUCTION_STAGE}`, pipelineArn],
        }));
      }
      for (const statement of portGuardNamesReadStatements({
        partition: this.partition,
        region: this.region,
        account: this.account,
        parameterName: portGuardNames.valueAsString,
        keyArn: portGuardKey.valueAsString,
      })) preflight.addToRolePolicy(statement);
      // The last released Code commit of this stage: the port-guard step's trust anchor.
      preflight.addToRolePolicy(new iam.PolicyStatement({
        sid: "ReadReleasedCode",
        actions: ["ssm:GetParameter"],
        resources: [releasedCodeArn(closesGate ? "production" : "beta")],
      }));
      // The stage's release history, read-only: a rollback may only target a commit in it.
      preflight.addToRolePolicy(new iam.PolicyStatement({
        sid: "ReadCodeHistory",
        actions: ["ssm:GetParameter"],
        resources: [codeHistoryArn(closesGate ? "production" : "beta")],
      }));
      if (!closesGate) {
        // Beta's Preflight names the execution waiting in front of Production (the one this run supersedes) for the promotion summary: read-only, this pipeline only.
        preflight.addToRolePolicy(new iam.PolicyStatement({
          sid: "ReadWaitingRun",
          actions: ["codepipeline:GetPipelineState", "codepipeline:GetPipelineExecution"],
          resources: [pipelineArn],
        }));
      }
      // The action's input is the Code clone, which the project reads through the repository's connection.
      preflight.addToRolePolicy(useConnection);
      if (closesGate) {
        // The Production Code Preflight runs BEFORE the owner's approval, so it may clone and may not push: UseConnection is denied when the provider action needs write permission
        // (codeconnections:ProviderPermissionsRequired = read_write; the other value is read_only; the legacy prefix has its own key). A Deny, because CDK adds an unconditioned
        // codestar-connections:UseConnection Allow to the role of every CodeBuild action whose input is a connection source, and a condition on an Allow could not take it back.
        // StringEquals read_write, not StringNotEquals read_only: a request that lacks the key (not verified against a live clone) is not denied, so Production cannot break at its first action.
        for (const prefix of ["codeconnections", "codestar-connections"]) {
          preflight.addToRolePolicy(new iam.PolicyStatement({
            sid: `ReadOnlyConnectionUse${prefix === "codeconnections" ? "" : "Legacy"}`,
            effect: iam.Effect.DENY,
            actions: [`${prefix}:UseConnection`],
            resources: [connectionArn.valueAsString],
            conditions: { StringEquals: { [`${prefix}:ProviderPermissionsRequired`]: "read_write" } },
          }));
        }
      }
      return preflight;
    };
    const betaPreflightProject = preflightProject("BetaCodePreflight", AGENTX_BETA_CODE_PREFLIGHT_PROJECT_NAME, false);
    const productionPreflightProject = preflightProject("ProductionCodePreflight", AGENTX_PRODUCTION_CODE_PREFLIGHT_PROJECT_NAME, true);
    // The beta build needs only CI's proof here (the GitHub App's key and the control plane's description) and the beta account's role.
    for (const policy of policies.filter((policy) => policy.sid === "ReadGithubAppKeyForCiProof" || policy.sid === "ReadReleaseStacks")) {
      betaProject.addToRolePolicy(policy);
    }
    betaProject.addToRolePolicy(useConnection);
    betaProject.addToRolePolicy(new iam.PolicyStatement({ sid: "RecordReleasedCode", actions: ["ssm:PutParameter"], resources: [releasedCodeArn("beta")] }));
    betaProject.addToRolePolicy(new iam.PolicyStatement({ sid: "RecordCodeHistory", actions: ["ssm:GetParameter", "ssm:PutParameter"], resources: [codeHistoryArn("beta")] }));
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
    const cloudSourceRole = new iam.Role(this, "CloudSourceActionRole", {
      assumedBy: new iam.AccountRootPrincipal(),
      description: "Reads the Cloud repository through its GitHub connection",
    });
    cloudSourceRole.addToPolicy(useCloudConnection);

    const sourceOutput = new codepipeline.Artifact("Source");
    const cloudSourceOutput = new codepipeline.Artifact("CloudSource");
    const releaseOutput = new codepipeline.Artifact("ReleaseManifest");
    const betaOutput = new codepipeline.Artifact("BetaReleaseManifest");
    // Each release build writes its own manifest and nothing else in the artifact bucket (PH-S3-PREFIXES). The bucket gives the project's role read on the bucket and PutObject on
    // its own output (ReleaseArtifactBucket), and the Deny holds even if a later change widens that: every write but its own output is refused (NotResource), including the
    // Source and CloudSource artifacts the Production stage reads, the other release's manifest and the Cloud state artifacts. No delete, no abort, no tagging, no retention.
    for (const [buildProject, output] of [[project, releaseOutput], [betaProject, betaOutput]] as const) {
      const ownOutput = artifactBucket.scopeWrites(buildProject, [output.artifactName!]);
      buildProject.addToRolePolicy(new iam.PolicyStatement({
        sid: "DenyArtifactWritesOutsideOwnOutput", effect: iam.Effect.DENY, actions: ["s3:PutObject*", "s3:DeleteObject*", "s3:AbortMultipartUpload"], notResources: ownOutput,
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
    // A full clone, so the Cloud stage CLI can resolve the newest release tag on the trunk (or CLOUD_REF) in Preflight, before any write.
    const cloudSource = new actions.CodeStarConnectionsSourceAction({
      actionName: "CloudGitHub",
      connectionArn: cloudConnectionArn.valueAsString,
      owner: cloudOwner.valueAsString,
      repo: cloudName.valueAsString,
      branch: cloudBranch.valueAsString,
      codeBuildCloneOutput: true,
      output: cloudSourceOutput,
      role: cloudSourceRole,
      variablesNamespace: CLOUD_SOURCE_NAMESPACE,
    });

    // V2 variables: every one has a default, so a push or a tag starts a run; a manual run overrides them.
    const cloudRef = new codepipeline.Variable({
      variableName: PIPELINE_VARIABLE_CLOUD_REF,
      defaultValue: CLOUD_REF_FROM_TRIGGER,
      description: `Cloud tag (vX.Y.Z); ${CLOUD_REF_FROM_TRIGGER} (triggered runs) is the one tag on the Cloud commit, else refuse; ${CLOUD_REF_LATEST}: newest tag, manual runs. An older tag is a Cloud rollback`,
    });
    const codeRelease = new codepipeline.Variable({
      variableName: PIPELINE_VARIABLE_CODE_RELEASE,
      defaultValue: "run",
      description: "run releases the Code commit of this run; skip releases Cloud only (Code waits for a later run). Preflight may force skip, never run",
    });
    const cloudProd = new codepipeline.Variable({
      variableName: PIPELINE_VARIABLE_CLOUD_PROD,
      defaultValue: CLOUD_PROD_DEFAULT,
      description: "off (default: no trigger deploys production Cloud) leaves it as it is; on deploys Cloud in the Production stage. Set on for the run that promotes (per run, not a switch)",
    });

    const pipelineMode = new codepipeline.Variable({
      variableName: PIPELINE_VARIABLE_MODE,
      defaultValue: PIPELINE_MODE_DEFAULT,
      description: "release deploys; adopt only checks and changes nothing (run it once per environment first); rollback deploys an earlier released Code commit (CODE_ROLLBACK_TARGET) and/or an older Cloud tag",
    });
    const rollbackTarget = new codepipeline.Variable({
      variableName: PIPELINE_VARIABLE_ROLLBACK_TARGET,
      defaultValue: ROLLBACK_TARGET_NONE,
      description: "With PIPELINE_MODE=rollback: the 40-character Code commit to deploy; it must be in the stage release history. none leaves Code alone; any other mode requires none",
    });
    const modeVariable = {
      [PIPELINE_VARIABLE_MODE]: { value: pipelineMode.reference() },
      [PIPELINE_VARIABLE_ROLLBACK_TARGET]: { value: rollbackTarget.reference() },
    };
    const betaPreflightNamespace = "BetaPreflight";
    const productionPreflightNamespace = "ProductionPreflight";
    /**
     * One Cloud action: the stage CLI runs `<step>` for `environment` in the environment's private project. The primary input is the Cloud clone, the Code clone is the
     * second, and the previous action's output (the manifest, the stage CLI's `PipelineState`) is the third. Every action writes an output of its own, which the next reads.
     */
    const cloudAction = (
      environment: "beta" | "production",
      spec: { action: string; step: string },
      runOrder: number,
      previous: codepipeline.Artifact | undefined,
    ): { action: actions.CodeBuildAction; output: codepipeline.Artifact } => {
      const prefix = environment === "beta" ? "Beta" : "Production";
      const output = new codepipeline.Artifact(cloudStateArtifactName(environment, spec.action));
      return {
        output,
        action: new actions.CodeBuildAction({
          actionName: spec.action,
          project: codebuild.Project.fromProjectName(this, `Cloud${prefix}${spec.action}`, cloudProjectNames[environment].valueAsString),
          runOrder,
          input: cloudSourceOutput,
          extraInputs: [sourceOutput, ...(previous === undefined ? [] : [previous])],
          outputs: [output],
          ...(spec.step === "preflight" ? { variablesNamespace: environment === "beta" ? betaPreflightNamespace : productionPreflightNamespace } : {}),
          environmentVariables: {
            [CLOUD_ENVIRONMENT_VARIABLE]: { value: environment },
            [CLOUD_STEP_VARIABLE]: { value: spec.step },
            ...(previous === undefined ? {} : { [CLOUD_STATE_ARTIFACT_VARIABLE]: { value: previous.artifactName! } }),
            [PIPELINE_VARIABLE_CLOUD_REF]: { value: cloudRef.reference() },
            [PIPELINE_VARIABLE_CODE_RELEASE]: { value: codeRelease.reference() },
            [PIPELINE_VARIABLE_CLOUD_PROD]: { value: cloudProd.reference() },
            [PIPELINE_VARIABLE_MODE]: { value: pipelineMode.reference() },
            // Only the Cloud Preflight gets the Code context of its stage (see CODE_CONTEXT_VARIABLE); the later steps read it from the stage CLI's state.
            ...(spec.step === "preflight" ? { [CODE_CONTEXT_VARIABLE]: { value: `#{${CODE_PREFLIGHT_NAMESPACE[environment]}.${CODE_CONTEXT_VARIABLE}}` } } : {}),
            // Beta's Preflight only (the 1000-character limit): it resolves a CLOUD_REF of from-trigger from this commit; Production's Preflight and the later steps read the resolved ref from the stage CLI's state.
            ...(spec.step === "preflight" && environment === "beta" ? { [CLOUD_SOURCE_COMMIT_VARIABLE]: { value: cloudSource.variables.commitId } } : {}),
            [CLOUD_EXPECTED_ACCOUNT_VARIABLE]: { value: environment === "beta" ? betaAccountId.valueAsString : this.account },
            EXEC_ID: { value: "#{codepipeline.PipelineExecutionId}" },
            CODE_SHA: { value: source.variables.commitId },
          },
        }),
      };
    };
    /** The Code release action: the EFFECTIVE CODE_RELEASE comes from this stage's Preflight, never from the pipeline variable directly. */
    const codeAction = (actionName: string, codeProject: codebuild.IProject, runOrder: number, preflightNamespace: string, output: codepipeline.Artifact): actions.CodeBuildAction =>
      new actions.CodeBuildAction({
        actionName,
        project: codeProject,
        runOrder,
        input: sourceOutput,
        outputs: [output],
        environmentVariables: {
          CODE_RELEASE: { value: `#{${preflightNamespace}.${CLOUD_PREFLIGHT_EXPORT_CODE_RELEASE}}` },
          [PIPELINE_VARIABLE_MODE]: { value: pipelineMode.reference() },
          [PIPELINE_VARIABLE_ROLLBACK_TARGET]: { value: rollbackTarget.reference() },
        },
      });
    /** A stage: the Code Preflight, then the Cloud steps up to the gateway check, the Code release, then web and app. The state chain runs through the Cloud steps only. */
    const stageActions = (
      environment: "beta" | "production",
      codePreflight: actions.CodeBuildAction,
      codeStep: (runOrder: number) => actions.CodeBuildAction,
      firstState: codepipeline.Artifact | undefined,
      reserved = 0,
    ): { actions: actions.CodeBuildAction[]; last: codepipeline.Artifact | undefined } => {
      const built: actions.CodeBuildAction[] = [codePreflight];
      let state = firstState;
      // The first Cloud action follows the Code Preflight, after the `reserved` run orders a caller keeps for an action of its own (Production's approval).
      let runOrder = codePreflight.actionProperties.runOrder! + 1 + reserved;
      const cloud = (spec: { action: string; step: string }): void => {
        const made = cloudAction(environment, spec, runOrder, state);
        built.push(made.action);
        state = made.output;
        runOrder += 1;
      };
      for (const spec of CLOUD_STEPS_BEFORE_CODE) cloud(spec);
      built.push(codeStep(runOrder));
      runOrder += 1;
      for (const spec of CLOUD_STEPS_AFTER_CODE) cloud(spec);
      return { actions: built, last: state };
    };
    const beta = stageActions(
      "beta",
      new actions.CodeBuildAction({
        actionName: "CodePreflight",
        project: betaPreflightProject,
        runOrder: 1,
        input: sourceOutput,
        variablesNamespace: CODE_PREFLIGHT_NAMESPACE.beta,
        environmentVariables: { ...modeVariable, EXEC_ID: { value: "#{codepipeline.PipelineExecutionId}" } },
      }),
      (runOrder) => codeAction("ReleaseBeta", betaProject, runOrder, betaPreflightNamespace, betaOutput),
      undefined,
    );

    // The approval's text names the run (execution id), the Code commit, the Cloud commit Beta resolved from, and the variables that decide what the run does. All are values of THIS
    // execution, resolved when the action starts (a manual approval's CustomData takes #{...} references; the configuration limit is 1000 characters, pinned by a test).
    // The Cloud TAG Beta resolved is in the stage CLI's state, not an exported variable: the owner reads it in Beta's Preflight log (the approval says so).
    const approvalText = [
      `Approve THIS run only: pipeline execution #{codepipeline.PipelineExecutionId}.`,
      `Production releases Code commit ${source.variables.commitId} with the Cloud source commit of this run, ${cloudSource.variables.commitId}.`,
      `Cloud ref ${cloudRef.reference()}, Cloud production ${cloudProd.reference()}, Code release ${codeRelease.reference()}, mode ${pipelineMode.reference()}, rollback target ${rollbackTarget.reference()}.`,
      "The Cloud tag Beta resolved and deployed is the one named in Beta's Preflight log: check it before you approve. Reject any run that is not the one you meant to release.",
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
      variables: [cloudRef, codeRelease, cloudProd, pipelineMode, rollbackTarget],
      // #1242: every merge goes to beta; production takes beta's newest commit only when someone enables the transition into Production AND approves that run (the Production stage's first action).
      // A run waiting in front of a disabled transition is replaced by a newer one only in SUPERSEDED mode, which is what makes one promotion carry
      // every merge since the last. (QUEUED, #114, kept each merge apart; two merges that land while beta is deploying now go to beta together.)
      // A run with CODE_RELEASE=skip supersedes a waiting promotion too: its Code waits for a later run (Preflight prints that).
      executionMode: codepipeline.ExecutionMode.SUPERSEDED,
      // aws-cdk-lib types Bucket.isWebsite as `boolean | undefined`, which exactOptionalPropertyTypes rejects for IBucket.
      artifactBucket: artifactBucket as s3.IBucket,
      crossAccountKeys: false,
      restartExecutionOnUpdate: false,
      stages: [
        { stageName: "Source", actions: [source, cloudSource] },
        {
          // Preflight first (read-only: the Code half runs the port guard, the Cloud half resolves the Cloud ref, pins Code, runs the gates and previews the change sets),
          // then the gateway, then Code, then web and app.
          stageName: "Beta",
          actions: beta.actions,
        },
        {
          stageName: AGENTX_PRODUCTION_STAGE,
          // The transition holds the run that is waiting here (enable it, console or `aws codepipeline enable-stage-transition`, to let that run in). It is NOT the approval: the
          // approval is the stage's second action, one per execution, so an open transition cannot admit a run the owner has not approved (DEC 254zzz506).
          transitionToEnabled: false,
          transitionDisabledReason: PROMOTION_GATE_REASON,
          // The Code Preflight comes FIRST (read-only): its first command closes the gate this run came through, so a newer run cannot pass the open transition while this one waits for
          // its approval or runs its gates, and a rejected or timed-out run leaves the transition closed. The approval comes SECOND, before every other action (all of them writers).
          // Its Cloud counterpart then reads the beta run's final state.
          actions: ((production) => [production.actions[0]!, productionApproval, ...production.actions.slice(1)])(stageActions(
            "production",
            new actions.CodeBuildAction({
              actionName: "CodePreflight",
              project: productionPreflightProject,
              runOrder: 1,
              input: sourceOutput,
              variablesNamespace: CODE_PREFLIGHT_NAMESPACE.production,
              environmentVariables: modeVariable,
            }),
            (runOrder) => codeAction("ReleaseProduction", project, runOrder, productionPreflightNamespace, releaseOutput),
            beta.last,
            1,
          )),
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
        // A Cloud release tag starts a run too: the Code half of that run is the newest mainline commit, which the Preflight pins. The run carries CLOUD_REF=from-trigger and CLOUD_PROD=off
        // (never `latest`, never `on`), and the transition into Production stays disabled and the stage opens with its own approval: the tag alone cannot reach Production.
        {
          providerType: codepipeline.ProviderType.CODE_STAR_SOURCE_CONNECTION,
          gitConfiguration: {
            sourceAction: cloudSource,
            pushFilter: [{ tagsIncludes: [...CLOUD_TAG_TRIGGER.tagsIncludes], tagsExcludes: [...CLOUD_TAG_TRIGGER.tagsExcludes] }],
          },
        },
      ],
    });

    // The Cloud projects' roles read and write this bucket (CodePipeline hands every artifact over through it); the private stack takes the name.
    new CfnOutput(this, "ArtifactBucketName", { value: artifactBucket.bucketName, description: "The pipeline's artifact bucket, for the Cloud actions' project roles" });
  }
}

/**
 * The record of the last released Code commit: this stage's Code Preflight reads it (codePreflightBuildSpec). The commit is CodeBuild's own
 * $CODEBUILD_RESOLVED_SOURCE_VERSION (what CodePipeline handed this build), not anything the release step could change in the checkout; empty or not 40 hex stops the build
 * before anything is recorded. Written with the build's own credentials, never the beta profile.
 */
export const RECORD_SOURCE_CHECK =
  'if [ "$PIPELINE_MODE" = rollback ] && [ "$CODE_ROLLBACK_TARGET" != none ]; then RELEASED_SOURCE="$CODE_ROLLBACK_TARGET"; else RELEASED_SOURCE="$CODEBUILD_RESOLVED_SOURCE_VERSION"; fi; ' +
  '[[ "$RELEASED_SOURCE" =~ ^[0-9a-f]{40}$ ]] || { echo "the source version of this build is not a commit id; the release is not recorded" >&2; exit 1; }';
/**
 * The release history: prepend the released commit to the stage's list, drop repeats, keep the first CODE_HISTORY_LIMIT, write it back. The old list is read tolerantly: only the
 * quoted 40-hex entries are taken, whatever else the value holds, and a missing parameter starts a new list; any OTHER read failure stops the build (it would otherwise overwrite
 * a list it could not read). Same commit as the record ($RELEASED_SOURCE).
 */
export function codeHistoryWrite(parameter: string): string {
  return [
    'HIST_ERR="$(mktemp)"',
    `{ HIST_OLD="$(aws ssm get-parameter --name ${parameter} --query Parameter.Value --output text 2>"$HIST_ERR")" || { grep -q ParameterNotFound "$HIST_ERR" && HIST_OLD=; } || { cat "$HIST_ERR" >&2; false; }; }`,
    `HIST_NEW="$({ printf '%s\\n' "$RELEASED_SOURCE"; printf '%s\\n' "$HIST_OLD" | { grep -oE '"[0-9a-f]{40}"' || true; } | tr -d '"'; } | awk '!seen[$0]++' | head -n ${CODE_HISTORY_LIMIT} | awk 'BEGIN{printf "["} {printf "%s\\"%s\\"", (NR>1?",":""), $0} END{printf "]"}')"`,
    `aws ssm put-parameter --name ${parameter} --type String --overwrite --value "$HIST_NEW"`,
  ].join(" && ");
}
function recordReleasedCode(parameter: string, historyParameter: string): string {
  // One group, so the `&&` chain it ends gates all of it: a failed release records nothing, neither the history nor the record. The history goes first and the record stays the
  // last command: a history written and a record not (a failure in between) names a commit that really was released, which a rollback may use and the next run's range simply covers.
  return `{ ${RECORD_SOURCE_CHECK}; ${codeHistoryWrite(historyParameter)} && aws ssm put-parameter --name ${parameter} --type String --overwrite --value "$RELEASED_SOURCE"; }`;
}

/** Why the transition into Production is disabled; also the reason the production release gives when it closes it again. */
// CodePipeline allows only letters, digits, spaces and !@().*?- in a transition's reason.
export const PROMOTION_GATE_REASON = "Production waits for the owner - enable this transition to let the run waiting here in and then approve ApproveProduction for that run (issue 1242)";

export function releaseProjectSettings(logGroup: logs.ILogGroup) {
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

/** The versions RELEASE_TOOL_INSTALL_COMMANDS reads. */
export const RELEASE_TOOL_VARIABLES = { AWS_CLI_VERSION: AGENTX_RELEASE_AWS_CLI_VERSION, GITLEAKS_VERSION: "8.30.1", GITLEAKS_SHA256: "e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080" } as const;

/** Pinned Node, AWS CLI and gitleaks, installed under /opt (shared with the environment release pipeline, which must install exactly the same tools). */
export const RELEASE_TOOL_INSTALL_COMMANDS: readonly string[] = [
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
];

/**
 * The Code half of Preflight. In Production the FIRST command closes the transition (before the tools are installed). The port guard step then runs on this run's
 * commit whatever the CI proof says: nothing here reads release-ci-proof or --skip-checks, and CODE_RELEASE does not switch it off.
 *
 * Trust (L14 review a and b; L1 review R4): the guard scripts that run while the decrypted list is on disk are those of the PREVIOUSLY RELEASED commit, which passed this
 * step itself, checked out as a separate worktree; never the ones this run's commit (or any commit since) changes. The guard then judges the FULL range from that commit
 * to this one, so a landing of several merges, or a rebase or squash landing, is covered whole. `--allow-guard-edits` is passed only because of that. The step refuses
 * (exit 2, nothing runs) unless the released commit is recorded, is in this clone, and is an ancestor of this commit, and this commit is the released commit itself
 * (a Cloud tag run with no new Code), a merge commit, or a single commit directly on it; a linear multi-commit landing is refused. The repository's merge settings
 * (rebase merges off, merge queue group size 1) stay the controller's call.
 *
 * A ROLLBACK run (PIPELINE_MODE=rollback with a CODE_ROLLBACK_TARGET) is judged the same way with the roles reversed: the guard that runs is still the CURRENT released commit's (the
 * worktree is the released commit, nothing from the target or from this run's commit runs while the list is on disk), over target..released. Before anything runs, the step refuses
 * (exit 2) unless the stage's release history is readable and lists the target, the target is not the released commit itself, is in this clone, and is an ancestor of the released commit.
 * The checks on this run's own commit (ancestor, merge shape) do not apply to a rollback, so the clone is moved to the released commit and they pass trivially.
 *
 * It exports ONE variable, CODE_CTX (see CODE_CONTEXT_VARIABLE): the released commit (the stage CLI's rollback pin), the rollback target and, from Beta's Preflight, the execution
 * waiting in front of Production that this run replaces, for the promotion summary.
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
      // PIPELINE_MODE and CODE_ROLLBACK_TARGET: the pipeline's action sets them; release and none are only the values of a build started by hand.
      variables: { PIPELINE_MODE: PIPELINE_MODE_DEFAULT, [PIPELINE_VARIABLE_ROLLBACK_TARGET]: ROLLBACK_TARGET_NONE, ...RELEASE_TOOL_VARIABLES, ...portGuardStepVariables(namesParameter) },
      "exported-variables": [CODE_CONTEXT_VARIABLE],
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
      // The run says which mode it is in (a note in the log), and a value that is neither release nor adopt stops here. The only adoption switch is this variable:
      // the pipeline has no other override (nothing named ROVARA_ADOPT_* is a variable or an action input), so nobody who can start an execution can bypass a gate.
      pre_build: { commands: [PIPELINE_MODE_NOTE, ROLLBACK_TARGET_CHECK] },
      build: {
        commands: [
          // The previously released commit, from the record the Code release writes after each finished release.
          `RELEASED_SHA="$(aws ssm get-parameter --name ${releasedParameter} --query Parameter.Value --output text)" || ${refuse("the last released Code commit could not be read")}`,
          `[[ "$RELEASED_SHA" =~ ^[0-9a-f]{40}$ ]] || ${refuse("the last released Code commit is not recorded")}`,
          `git cat-file -e "$RELEASED_SHA^{commit}" || ${refuse("the last released Code commit is not in this clone")}`,
          // What the stage's Cloud Preflight gets: one quote-free value (the target was checked in pre_build, the others just above and in the supersession lookup).
          ...supersedesCommands(!closesGate),
          `export ${CODE_CONTEXT_VARIABLE}="live:$RELEASED_SHA,target:${target},supersedes:$SUPERSEDES_EXEC,supersedesSha:$SUPERSEDES_SHA"`,
          // A rollback: the target must be in the stage's history and older than the released commit, or nothing runs. Then this clone moves to the released commit, so the
          // checks below (which are about this run's own commit) pass without applying to a commit that is not being released.
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
          // A rollback adds the second range: what the rollback takes away, judged by the same released guard (the range above is empty then: the clone sits on the released commit).
          `${rollbackOnly} git update-ref refs/heads/${PORT_GUARD_ROLLBACK_REF} "${target}"`,
          ...rollbackGuard.map((command) => `${rollbackOnly} ${command}`),
        ],
      },
    },
  });
}
export const PIPELINE_MODE_NOTE =
  'case "$PIPELINE_MODE" in release|adopt|rollback) echo "NOTE: pipeline mode is $PIPELINE_MODE" ;; *) echo "PIPELINE_MODE must be release, adopt or rollback, got: $PIPELINE_MODE" >&2; exit 1;; esac';
/** The target and the mode agree: a target is a full commit id and only rollback takes one (an unknown or misplaced value stops the build at its first command). */
export const ROLLBACK_TARGET_CHECK =
  'if [ "$PIPELINE_MODE" = rollback ] && [ "$CODE_ROLLBACK_TARGET" != none ]; then ' +
  '[[ "$CODE_ROLLBACK_TARGET" =~ ^[0-9a-f]{40}$ ]] || { echo "CODE_ROLLBACK_TARGET must be a full 40-character commit id, or none, got: $CODE_ROLLBACK_TARGET" >&2; exit 1; }; ' +
  'echo "NOTE: Code rollback target is $CODE_ROLLBACK_TARGET"; ' +
  'elif [ "$PIPELINE_MODE" != rollback ] && [ "$CODE_ROLLBACK_TARGET" != none ]; then ' +
  'echo "CODE_ROLLBACK_TARGET is only for PIPELINE_MODE=rollback; got $CODE_ROLLBACK_TARGET in mode $PIPELINE_MODE" >&2; exit 1; fi';
/**
 * Beta's Preflight: the execution waiting in front of Production (the one a newer run replaces in SUPERSEDED mode) and the Code commit it holds, for the promotion summary. It is
 * information for the approver, so a lookup that fails prints a warning and leaves both as `none` rather than stopping every release; the values are checked before they are used.
 * Production's Preflight does not look (`lookup` false): both stay `none` and the stage CLI keeps Beta's. The shapes of get-pipeline-state (stageStates[].inboundExecution) and
 * get-pipeline-execution (artifactRevisions[].revisionId by artifact name) are not proven against AWS.
 */
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
      `echo "NOTE: this run replaces the execution $WAITING_EXEC, which is waiting for Production"; fi`,
  ];
}
/**
 * The first three rollback checks, shared by the Code Preflight and the Code release build (each reads the stage's history with its own role): the history is readable, is a strict
 * JSON list of 40-hex strings (whitespace is ignored; anything else refuses), and lists $CODE_ROLLBACK_TARGET. Each is the body of a `{ ...; }` group; `fail` writes the refusal.
 */
export function rollbackTargetInHistory(historyParameter: string, fail: (why: string) => string): string[] {
  const target = `$${PIPELINE_VARIABLE_ROLLBACK_TARGET}`;
  return [
    `HIST_VALUE="$(aws ssm get-parameter --name ${historyParameter} --query Parameter.Value --output text)" || ${fail("the Code release history could not be read")}`,
    `HIST_FLAT="$(printf '%s' "$HIST_VALUE" | tr -d ' \\t\\r\\n')"; HIST_RE='^\\[("[0-9a-f]{40}"(,"[0-9a-f]{40}")*)?\\]$'; [[ "$HIST_FLAT" =~ $HIST_RE ]] || ${fail("the Code release history is not a list of commits")}`,
    `[[ "$HIST_FLAT" == *"\\"${target}\\""* ]] || ${fail("the rollback target is not in this stage's Code release history")}`,
  ];
}
/**
 * What a LINEAR landing (several commits on the released commit, none a merge: a rebase merge, or a merge queue group landed without merge commits) gets. Nothing makes the
 * commits in between one reviewed change, so this run does not release them. The next normal merge (a merge commit on top of them) is released with them, and scanned whole.
 */
export const LINEAR_LANDING_REFUSAL =
  '{ echo "port-guard: this landing has $(git rev-list --count "$RELEASED_SHA..HEAD") commits on the last released commit that were not merged as one change, so this run does not release them. The next normal merge (a merge commit on top of them) releases them, scanned whole; or re-land the change as one squash or one merge." >&2; exit 2; }';
/** An octopus merge (three or more parents) is not accepted whatever its first parent is. */
export const OCTOPUS_REFUSAL =
  '{ echo "port-guard: this commit is an octopus merge ($(( $(git rev-list --parents -n 1 HEAD | wc -w) - 1 )) parents), which the release does not accept. Re-land the change as a normal two-parent merge or as one squash." >&2; exit 2; }';
const PORT_GUARD_TIP_REF = "release-tip";
const PORT_GUARD_ROLLBACK_REF = "rollback-target";
const PORT_GUARD_TRUSTED_DIRECTORY = "/tmp/port-guard-trusted";

interface ReleaseBuildSpec {
  /** This stage's release history parameter (the rollback checks read it). */
  historyParameter: string;
  variables?: Record<string, string>;
  /** Commands after CI's proof, before the release. */
  beforeRelease?: string[];
  release: string;
  /** Commands after a release that finished (not run for a CODE_RELEASE=skip run). */
  afterRelease?: string[];
}

/** True in a Code release build that must do nothing: a run with CODE_RELEASE=skip releases Cloud only (BETA-CLOUD-PLAN 1.3). */
const CODE_RELEASE_IS_SKIP = '[ "$CODE_RELEASE" = skip ]';
/** The value reaches the build from this stage's Preflight, or from the buildspec's own default for a hand-started build; anything else is refused, never read as `run`. */
export const CODE_RELEASE_CHECK =
  'case "$CODE_RELEASE" in run|skip) ;; *) echo "CODE_RELEASE must be run or skip, got: $CODE_RELEASE" >&2; exit 1;; esac';
/**
 * The Code release agrees with the run's mode, or stops at its first commands: the mode and target are valid together (ROLLBACK_TARGET_CHECK), a rollback with a target must
 * release (a Cloud-side `skip` would leave Code where it is while the operator asked for it to move), and a rollback with no target must not (it would release this run's commit).
 * These run for a skipped build too. Then the build repeats the Preflight's own checks on the target before it checks anything out (it reads the same history with its own role): the
 * history lists the target, and the target is in the clone and an ancestor of this run's commit (the build cannot read the released record, and every released commit is an ancestor of
 * mainline's tip). The Preflight is the gate; this is the second look, so a release build started some other way still cannot deploy a commit that was never released.
 */
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
/** What a skipped build writes where the release manifest would be, so the stage's artifact still exists. */
const SKIPPED_MANIFEST = "mkdir -p cdk.out && printf '{\"codeRelease\":\"skip\"}\\n' > cdk.out/agentx-production-release.json";

function releaseBuildSpec(spec: ReleaseBuildSpec): codebuild.BuildSpec {
  const proofAndRelease =
    // #1145: skip the typecheck, lint and tests only when GitHub CI's gate already passed on exactly this code (the same file tree; scripts/release-ci-proof.ts).
    // Not proven (behind mainline, CI not green, GitHub unreachable): every check runs, as before. The proof itself never fails the build.
    `if node scripts/release-ci-proof.ts --repository ${AGENTX_RELEASE_REPOSITORY_OWNER}/${AGENTX_RELEASE_REPOSITORY_NAME} --github-app-stack ${AGENTX_RELEASE_STACKS[0]} --region "$AWS_REGION"; then RELEASE_CHECKS=--skip-checks; else RELEASE_CHECKS=; fi; ` +
    [...(spec.beforeRelease ?? []), spec.release, ...(spec.afterRelease ?? [])].join(" && ");
  return codebuild.BuildSpec.fromObject({
    version: "0.2",
    env: {
      shell: "bash",
      // #1118: the release's typecheck (tsc -b) needs about 4 GB of heap since mainline took code/next; Node's default limit on this
      // 16 GB build machine is lower, and tsc died with "JavaScript heap out of memory". 8 GB leaves the tests' own processes room.
      // CODE_RELEASE: the pipeline's action sets it from Preflight; `run` is only the value of a build started by hand.
      // PIPELINE_MODE and CODE_ROLLBACK_TARGET likewise: the pipeline's action sets them, the defaults are a release.
      variables: {
        NODE_OPTIONS: "--max-old-space-size=8192",
        CODE_RELEASE: "run",
        PIPELINE_MODE: PIPELINE_MODE_DEFAULT,
        [PIPELINE_VARIABLE_ROLLBACK_TARGET]: ROLLBACK_TARGET_NONE,
        ...RELEASE_TOOL_VARIABLES,
        ...spec.variables,
      },
    },
    phases: {
      install: {
        // Tools go under /opt so the release's dirty-tree check sees an untouched checkout.
        commands: [
          CODE_RELEASE_CHECK,
          '[ "$CODE_RELEASE" != skip ] || echo "CODE_RELEASE=skip: this run releases Cloud only; Code is not built or deployed"',
          ...rollbackReleaseChecks(spec.historyParameter),
          // A Code rollback deploys the target: it becomes the checkout before anything is installed or built (the tools install from its own .node-version).
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
