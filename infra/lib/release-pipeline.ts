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
/** The pipeline's last stage. Its inbound transition stays disabled: enabling it is the manual approval that promotes beta's commit (#1242). */
export const AGENTX_PRODUCTION_STAGE = "Production";
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
/** The namespaces of the two source actions: their CommitId reaches every Cloud action. */
export const CODE_SOURCE_NAMESPACE = "CodeSource";
export const CLOUD_SOURCE_NAMESPACE = "CloudSource";
export const AGENTX_PRODUCTION_WORKER_REPOSITORY = "agentx-worker-production";

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
/** `release` (the default) or `adopt`: an adoption run changes nothing (the stage CLI maps it to its adoption mode, and refuses a release run in an environment it never adopted). */
export const PIPELINE_VARIABLE_MODE = "PIPELINE_MODE";
export const PIPELINE_MODE_DEFAULT = "release";
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
/** CLOUD_REF's default: the newest vX.Y.Z tag on the Cloud trunk (a variable's default may not be empty). */
export const CLOUD_REF_LATEST = "latest";
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
        // The gate it came through is closed by the production Code Preflight, first thing in the Production stage (before Preflight's gates), not here.
        release: 'npm run release:prod -- --region "$AWS_REGION" --reuse-unchanged-worker --require-existing-foundation $RELEASE_CHECKS',
        afterRelease: [recordReleasedCode(CODE_RELEASED_PARAMETER.production)],
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
        variables: { BETA_RELEASE_ROLE_ARN: betaReleaseRoleArn },
        beforeRelease: [
          "mkdir -p ~/.aws",
          `printf '[profile ${AGENTX_BETA_PROFILE}]\\nrole_arn = %s\\ncredential_source = EcsContainer\\nrole_session_name = beta-release\\nregion = %s\\n' "$BETA_RELEASE_ROLE_ARN" "$AWS_REGION" >> ~/.aws/config`,
          `aws sts get-caller-identity --profile ${AGENTX_BETA_PROFILE}`,
        ],
        release: `npm run release:prod -- --region "$AWS_REGION" --profile ${AGENTX_BETA_PROFILE} --reuse-unchanged-worker --require-existing-foundation $RELEASE_CHECKS`,
        afterRelease: [recordReleasedCode(CODE_RELEASED_PARAMETER.beta)],
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
        buildSpec: codePreflightBuildSpec(closesGate, portGuardNames.valueAsString, closesGate ? CODE_RELEASED_PARAMETER.production : CODE_RELEASED_PARAMETER.beta),
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
      // The action's input is the Code clone, which the project reads through the repository's connection.
      preflight.addToRolePolicy(useConnection);
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
      defaultValue: CLOUD_REF_LATEST,
      description: `The Cloud release tag to deploy (vX.Y.Z); ${CLOUD_REF_LATEST} is the newest tag on the Cloud trunk. An older tag is a Cloud rollback: it forces CODE_RELEASE=skip`,
    });
    const codeRelease = new codepipeline.Variable({
      variableName: PIPELINE_VARIABLE_CODE_RELEASE,
      defaultValue: "run",
      description: "run releases the Code commit of this run; skip releases Cloud only (Code waits for a later run). Preflight may force skip, never run",
    });
    const cloudProd = new codepipeline.Variable({
      variableName: PIPELINE_VARIABLE_CLOUD_PROD,
      defaultValue: "on",
      description: "on deploys Cloud in the Production stage; off leaves production Cloud as it is for this run (a per-run choice, not a switch)",
    });

    const pipelineMode = new codepipeline.Variable({
      variableName: PIPELINE_VARIABLE_MODE,
      defaultValue: PIPELINE_MODE_DEFAULT,
      description: "release deploys; adopt only checks that Cloud as deployed is what the pipeline would deploy, and changes nothing. Run adopt once per environment before the first release run",
    });
    const modeVariable = { [PIPELINE_VARIABLE_MODE]: { value: pipelineMode.reference() } };
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
      const output = new codepipeline.Artifact(`${prefix}${spec.action}State`);
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
        environmentVariables: { CODE_RELEASE: { value: `#{${preflightNamespace}.${CLOUD_PREFLIGHT_EXPORT_CODE_RELEASE}}` } },
      });
    /** A stage: the Code Preflight, then the Cloud steps up to the gateway check, the Code release, then web and app. The state chain runs through the Cloud steps only. */
    const stageActions = (
      environment: "beta" | "production",
      codePreflight: actions.CodeBuildAction,
      codeStep: (runOrder: number) => actions.CodeBuildAction,
      firstState: codepipeline.Artifact | undefined,
    ): { actions: actions.CodeBuildAction[]; last: codepipeline.Artifact | undefined } => {
      const built: actions.CodeBuildAction[] = [codePreflight];
      let state = firstState;
      let runOrder = 2;
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
      new actions.CodeBuildAction({ actionName: "CodePreflight", project: betaPreflightProject, runOrder: 1, input: sourceOutput, environmentVariables: modeVariable }),
      (runOrder) => codeAction("ReleaseBeta", betaProject, runOrder, betaPreflightNamespace, betaOutput),
      undefined,
    );

    new codepipeline.Pipeline(this, "Pipeline", {
      pipelineName: AGENTX_RELEASE_PIPELINE_NAME,
      pipelineType: codepipeline.PipelineType.V2,
      variables: [cloudRef, codeRelease, cloudProd, pipelineMode],
      // #1242: every merge goes to beta; production takes beta's newest commit only when someone enables the transition into Production.
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
          // The manual approval: enable this transition (console, or `aws codepipeline enable-stage-transition`) to promote the commit waiting here.
          transitionToEnabled: false,
          transitionDisabledReason: PROMOTION_GATE_REASON,
          // CodePreflight comes FIRST and its first command closes the gate this run came through, so a newer run cannot pass the open transition while the gates run.
          // Its Cloud counterpart then reads the beta run's final state.
          actions: stageActions(
            "production",
            new actions.CodeBuildAction({ actionName: "CodePreflight", project: productionPreflightProject, runOrder: 1, input: sourceOutput, environmentVariables: modeVariable }),
            (runOrder) => codeAction("ReleaseProduction", project, runOrder, productionPreflightNamespace, releaseOutput),
            beta.last,
          ).actions,
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
        // A Cloud release tag starts a run too: the Code half of that run is the newest mainline commit, which the Preflight pins.
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
  'RELEASED_SOURCE="$CODEBUILD_RESOLVED_SOURCE_VERSION"; [[ "$RELEASED_SOURCE" =~ ^[0-9a-f]{40}$ ]] || { echo "the source version of this build is not a commit id; the release is not recorded" >&2; exit 1; }';
function recordReleasedCode(parameter: string): string {
  // One group, so the `&&` chain it ends gates all of it: a failed release records nothing.
  return `{ ${RECORD_SOURCE_CHECK}; aws ssm put-parameter --name ${parameter} --type String --overwrite --value "$RELEASED_SOURCE"; }`;
}

/** Why the transition into Production is disabled; also the reason the production release gives when it closes it again. */
// CodePipeline allows only letters, digits, spaces and !@().*?- in a transition's reason.
export const PROMOTION_GATE_REASON = "Production waits for a manual approval - enable this transition to release the commit waiting here (issue 1242)";

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
 */
export function codePreflightBuildSpec(closesGate: boolean, namesParameter: string, releasedParameter: string): codebuild.BuildSpec {
  const refuse = (why: string): string => `{ echo "port-guard: ${why}; refusing to run the release" >&2; exit 2; }`;
  return codebuild.BuildSpec.fromObject({
    version: "0.2",
    env: {
      shell: "bash",
      // PIPELINE_MODE: the pipeline's action sets it; `release` is only the value of a build started by hand.
      variables: { PIPELINE_MODE: PIPELINE_MODE_DEFAULT, ...RELEASE_TOOL_VARIABLES, ...portGuardStepVariables(namesParameter) },
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
      pre_build: { commands: [PIPELINE_MODE_NOTE] },
      build: {
        commands: [
          // The previously released commit, from the record the Code release writes after each finished release.
          `RELEASED_SHA="$(aws ssm get-parameter --name ${releasedParameter} --query Parameter.Value --output text)" || ${refuse("the last released Code commit could not be read")}`,
          `[[ "$RELEASED_SHA" =~ ^[0-9a-f]{40}$ ]] || ${refuse("the last released Code commit is not recorded")}`,
          `git cat-file -e "$RELEASED_SHA^{commit}" || ${refuse("the last released Code commit is not in this clone")}`,
          `git merge-base --is-ancestor "$RELEASED_SHA" HEAD || ${refuse("the last released Code commit is not an ancestor of this commit")}`,
          `[ "$(git rev-parse HEAD)" = "$RELEASED_SHA" ] || [ "$(git rev-list --parents -n 1 HEAD | wc -w | tr -d ' ')" -le 3 ] || ${OCTOPUS_REFUSAL}`,
          `[ "$(git rev-parse HEAD)" = "$RELEASED_SHA" ] || [ "$(git rev-list --parents -n 1 HEAD | wc -w | tr -d ' ')" = 3 ] || [ "$(git rev-parse HEAD^1)" = "$RELEASED_SHA" ] || ${LINEAR_LANDING_REFUSAL}`,
          `git update-ref refs/heads/${PORT_GUARD_TIP_REF} HEAD`,
          `git worktree add --detach ${PORT_GUARD_TRUSTED_DIRECTORY} "$RELEASED_SHA"`,
          `cd ${PORT_GUARD_TRUSTED_DIRECTORY}`,
          ...portGuardStepCommands(["--range", `HEAD..${PORT_GUARD_TIP_REF}`, "--allow-guard-edits"]),
        ],
      },
    },
  });
}
export const PIPELINE_MODE_NOTE =
  'case "$PIPELINE_MODE" in release|adopt) echo "NOTE: pipeline mode is $PIPELINE_MODE" ;; *) echo "PIPELINE_MODE must be release or adopt, got: $PIPELINE_MODE" >&2; exit 1;; esac';
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
const PORT_GUARD_TRUSTED_DIRECTORY = "/tmp/port-guard-trusted";

interface ReleaseBuildSpec {
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
      variables: { NODE_OPTIONS: "--max-old-space-size=8192", CODE_RELEASE: "run", ...RELEASE_TOOL_VARIABLES, ...spec.variables },
    },
    phases: {
      install: {
        // Tools go under /opt so the release's dirty-tree check sees an untouched checkout.
        commands: [
          CODE_RELEASE_CHECK,
          '[ "$CODE_RELEASE" != skip ] || echo "CODE_RELEASE=skip: this run releases Cloud only; Code is not built or deployed"',
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
