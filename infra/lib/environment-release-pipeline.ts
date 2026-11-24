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
  aws_events as events,
  aws_events_targets as targets,
  aws_iam as iam,
  aws_kms as kms,
  aws_logs as logs,
  aws_s3 as s3,
  aws_sns as sns,
} from "aws-cdk-lib";
import type { App } from "aws-cdk-lib";
import type { Construct } from "constructs";
import { environmentCloudFormationRoleName, environmentSettingsPrefix, environmentStackName } from "@agentx/contracts";
import { AGENTX_RELEASE_REPOSITORY_NAME, AGENTX_RELEASE_REPOSITORY_OWNER, RELEASE_TOOL_INSTALL_COMMANDS, RELEASE_TOOL_VARIABLES, releaseProjectSettings } from "./release-pipeline.js";
import { environmentNaming } from "./naming.js";

// The environment release pipeline (staging release pipeline plan v3, lane P1): every merge to the environment's branch deploys to that
// environment after an automated policy or a manual approval, and a deploy that fails its checks rolls back. One generic stack, selected
// with `-c agentxReleasePipeline=<environment>`; it knows no account id (the account is wherever it is deployed) and its region is a prop.
// The production release pipeline (release-pipeline.ts) is a separate stack and its template does not change.

export const ENVIRONMENT_RELEASE_STAGES = ["Source", "Check", "Build", "Preview", "Gates", "Decide", "Approve", "Release"] as const;
export const APPROVE_STAGE = "Approve";
export const MANUAL_APPROVAL_ACTION = "ApproveDeploy";
export const AUTO_APPROVE_ACTION = "AutoApprove";
export const RELEASE_STAGE = "Release";
export const DECIDE_ACTION = "Decide";
/** The pipeline variable namespaces the stages read each other through. */
export const SOURCE_VARIABLES = "SourceVars";
export const DECIDE_VARIABLES = "DecideVars";
/** What the policy pin holds until the controller turns auto on: every run is MANUAL (plan section 6). */
export const POLICY_PIN_MANUAL_ONLY = "MANUAL-ONLY";
/** The gate pack, inside the Ops source artifact. */
export const OPS_PACK_DIR = "ops/staging-release";

/** Every role the stack creates, by key. Each CodeBuild role runs exactly one project, each human role is for one kind of person. */
export const RELEASE_ROLE_KEYS = [
  "pipeline",
  "source",
  "check",
  "build",
  "preview",
  "gates",
  "decide",
  "auto-approver",
  "guard",
  "deploy",
  "postcheck",
  "canary",
  "starter",
  "approver",
  "reader",
  "rollback",
] as const;
export type ReleaseRoleKey = (typeof RELEASE_ROLE_KEYS)[number];

/** The CodeBuild projects, one per role of the same key. */
export const RELEASE_PROJECT_KEYS = ["check", "build", "preview", "gates", "decide", "auto-approver", "guard", "deploy", "postcheck", "canary"] as const;
export type ReleaseProjectKey = (typeof RELEASE_PROJECT_KEYS)[number];

/**
 * The run records live at `<stage>/<execution>/...` (stage FIRST, F3): an IAM `*` crosses `/`, so a leading-wildcard resource for the build
 * stage would also match the gates stage's `build/x` files. With the stage first, the build prefix can never name another stage's records.
 * The S3 prefix each role may write, and nothing else.
 */
export const RUN_WRITE_PREFIX: Readonly<Record<string, string>> = {
  check: "check",
  build: "build",
  preview: "preview",
  gates: "gates",
  decide: "decide",
  guard: "guard",
  deploy: "release",
  postcheck: "release",
  canary: "canary",
  approver: "89",
};
/** Every stage folder of the runs bucket. */
export const RUN_STAGES = ["check", "build", "preview", "gates", "decide", "guard", "release", "canary", "89"] as const;
/**
 * What each stage role reads, lists and writes in the runs bucket: the single source for its S3 grants. A recursive `aws s3 cp` also LISTS the prefix, so `list` names the
 * stages a role downloads whole. The contract test compares these grants, as they appear in the synthesized template, with the gate pack's s3-access.json (the scripts' own
 * paths): every path covered, nothing broader, each grant `<stage>/*` with no leading wildcard.
 */
export const RUN_ACCESS = {
  check: { read: [], list: [], write: ["check"] },
  build: { read: ["check"], list: [], write: ["build"] },
  preview: { read: ["check", "build"], list: ["build"], write: ["preview"] },
  gates: { read: ["check", "preview", "build"], list: ["preview", "build"], write: ["gates"] },
  decide: { read: ["check", "build", "preview", "gates", "decide"], list: ["build", "gates", "release", "89", "decide"], write: ["decide"] },
  guard: { read: ["check", "decide", "preview", "build", "89"], list: ["build"], write: ["guard"] },
  deploy: { read: ["check", "build", "preview", "gates", "decide", "guard", "89"], list: ["build", "gates"], write: ["release"] },
  postcheck: { read: ["check", "build", "preview", "release"], list: [], write: ["release"] },
  // The canary counts and writes the cap ledger (`canary-ledger/`, a folder of its own beside the stage folders) and reads no run record.
  canary: { read: [], list: ["canary-ledger"], write: ["canary", "canary-ledger"] },
  // The explicit rollback (a human role): the last good run's canary result and Preview's package hash, and it lists that run's release package; it writes nothing.
  rollback: { read: ["canary", "preview"], list: ["build"], write: [] },
} as const satisfies Record<string, { read: readonly string[]; list: readonly string[]; write: readonly string[] }>;
export const CANARY_LEDGER_PREFIX = "canary-ledger/";
/** The GitHub CI evidence cache (the unauthenticated API allows 60 requests an hour per address, and CodeBuild shares addresses). Only Decide writes it: a forged entry would be forged CI evidence. */
export const CI_CACHE_PREFIX = "ci-cache/";
/** The release stage, whose rollback the guard, the deploy and the rollback role are about. */
export const GUARD_ACTION = "Guard";

export interface EnvironmentReleaseNames {
  readonly pipeline: string;
  readonly stack: string;
  readonly boundary: string;
  readonly alertsTopic: string;
  role(key: ReleaseRoleKey): string;
  project(key: ReleaseProjectKey): string;
  /** SSM prefix of the release pointers, holds and the policy pin. */
  readonly parameterPrefix: string;
}

/** Fixed names, so the boundary can name the roles it exempts without a reference cycle. CodeBuild project names must not match the broker's `agentx-*` allow-list. */
export function environmentReleaseNames(environment: string, kind = "code"): EnvironmentReleaseNames {
  return {
    pipeline: `rovara-${environment}-${kind}-release`,
    stack: `rovara-${environment}-${kind}-release-pipeline`,
    boundary: `rovara-${environment}-${kind}-release-boundary`,
    alertsTopic: `rovara-${environment}-release-alerts`,
    role: (key) => `rovara-${environment}-${kind}-rel-${key}`,
    project: (key) => `rovara-${environment}-${kind}-release-${key}`,
    parameterPrefix: `/rovara-release/${environment}`,
  };
}

export interface EnvironmentReleasePipelineProps extends Omit<StackProps, "env"> {
  /** The environment the pipeline releases to, for example `staging`. */
  readonly environment: string;
  /** The one region the pipeline and everything it touches lives in. Explicit, never ambient. */
  readonly region: string;
  /** The GitHub repository and the branch whose pushes start a release. */
  readonly repository: { readonly owner: string; readonly name: string; readonly branch: string };
  /** ECR repositories the Build role may push to. Default: the environment's own `agentx-<env>/worker` and `agentx-<env>/slack` (the staging layout). */
  readonly imageRepositories?: readonly string[];
}

/** Global services the region deny leaves out: their calls are not made in the environment's region. */
const GLOBAL_SERVICE_ACTIONS = ["iam:*", "sts:*", "budgets:*", "ce:*", "support:*", "health:*", "route53:*", "cloudfront:*"];

/** Shell shared by the stages: the policy pin is the sha256 of the sorted manifest of EVERY file in the Ops pack (plan P-EDIT, review F2). */
export const POLICY_HASH_COMMAND =
  // F2: EVERY file of the gate pack (the stage scripts run with the Deploy, Guard and PostCheck credentials, the build scripts beside repo code), not only the policy.
  // F5: `find -type f` skips a symlink, which `bash` would still follow, so anything that is not a regular file or a directory (a symlink, device, FIFO or socket) is
  // refused first. A refusal leaves the hash empty (the stage fails closed, or Decide says MANUAL), so it can never equal a real pin.
  `(cd "$OPS/${OPS_PACK_DIR}" && { test -z "$(find . ! -type f ! -type d)" || { echo "the gate pack holds an entry that is not a regular file or a directory (symlink, device, FIFO or socket): refused" >&2; exit 1; }; } && find . -type f | LC_ALL=C sort | xargs sha256sum | sha256sum | cut -d' ' -f1)`;

export class EnvironmentReleasePipelineStack extends Stack {
  readonly names: EnvironmentReleaseNames;

  constructor(scope: Construct, id: string, props: EnvironmentReleasePipelineProps) {
    const names = environmentReleaseNames(props.environment);
    super(scope, id, {
      ...props,
      stackName: props.stackName ?? names.stack,
      env: { region: props.region },
      terminationProtection: props.terminationProtection ?? true,
    });
    this.names = names;
    const { environment, region } = props;
    const naming = environmentNaming(environment);
    const partition = this.partition;
    const account = this.account;
    const arn = (service: string, resource: string, scope: "regional" | "global" = "regional"): string =>
      scope === "regional" ? `arn:${partition}:${service}:${region}:${account}:${resource}` : `arn:${partition}:${service}::${account}:${resource}`;
    const roleArn = (key: ReleaseRoleKey): string => `arn:${partition}:iam::${account}:role/${names.role(key)}`;
    const pipelineArn = arn("codepipeline", names.pipeline);
    const param = (path: string): string => arn("ssm", `parameter${names.parameterPrefix}/${path}`);
    const stackArn = (stackName: string): string => arn("cloudformation", `stack/${stackName}/*`);

    // ---- parameters: nothing account-specific is in the template
    const connectionArn = new CfnParameter(this, "GitHubConnectionArn", {
      type: "String",
      allowedPattern: `^arn:aws(-[a-z]+)?:(codeconnections|codestar-connections):${region}:[0-9]{12}:connection/[0-9a-f-]{36}$`,
      description: `Authorized CodeConnections GitHub connection, in ${region}`,
    });
    const opsRepositoryOwner = new CfnParameter(this, "OpsRepositoryOwner", {
      type: "String",
      allowedPattern: "^[A-Za-z0-9_.-]+$",
      description: "Owner of the repository that holds the gate pack (ops/staging-release)",
    });
    const opsRepositoryName = new CfnParameter(this, "OpsRepositoryName", {
      type: "String",
      allowedPattern: "^[A-Za-z0-9_.-]+$",
      description: "Name of the repository that holds the gate pack",
    });
    const opsBranch = new CfnParameter(this, "OpsBranch", {
      type: "String",
      allowedPattern: "^[A-Za-z0-9_./-]{1,100}$",
      description: "Branch of the gate pack's repository",
    });
    const principalPattern = "^arn:aws[a-z-]*:iam::[0-9]{12}:(role|user)/.+$";
    const humanPrincipals = {
      starter: new CfnParameter(this, "StarterPrincipalArn", { type: "String", allowedPattern: principalPattern, description: "Role or user in this account that may start, stop and retry the pipeline" }),
      approver: new CfnParameter(this, "ApproverPrincipalArn", { type: "String", allowedPattern: principalPattern, description: "Role or user in this account that may approve, pin the policy and clear a hold" }),
      reader: new CfnParameter(this, "ReaderPrincipalArn", { type: "String", allowedPattern: principalPattern, description: "Role or user in this account that may read the pipeline's runs" }),
    } as const;
    const accessArtifactBucketArn = new CfnParameter(this, "AccessArtifactBucketArn", {
      type: "String",
      allowedPattern: "^arn:aws[a-z-]*:s3:::[a-z0-9][a-z0-9.-]{2,62}$",
      description: "The environment's artifact bucket (output ArtifactBucketName of the access stack), which the deploy reads and writes",
    });

    // ---- storage
    const artifactBucket = new s3.Bucket(this, "Artifacts", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // The Release stage's rollback re-runs the last good execution's artifacts: they must outlive last-good (plan P-RB).
      lifecycleRules: [{ expiration: Duration.days(90) }],
      removalPolicy: RemovalPolicy.RETAIN,
    });
    // `<stage>/<execution>/...`: every stage's records. Versioned, and no pipeline role may delete from it.
    const runsBucket = new s3.Bucket(this, "Runs", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      lifecycleRules: [{ noncurrentVersionExpiration: Duration.days(365) }],
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const runObjects = (stage: string): string => `${runsBucket.bucketArn}/${stage}/*`;
    const logGroup = new logs.LogGroup(this, "ReleaseBuildLogs", {
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // ---- alerts: one new topic (Chatbot is added by P9 after the owner's one-time step) and the environment's OperatorAlerts topic
    const alertsKey = new kms.Key(this, "AlertsKey", { enableKeyRotation: true, removalPolicy: RemovalPolicy.RETAIN, description: `Encrypts ${names.alertsTopic}` });
    const alertsTopic = new sns.Topic(this, "AlertsTopic", { topicName: names.alertsTopic, masterKey: alertsKey, enforceSSL: true });
    const operatorAlertsTopicArn = arn("sns", naming.alertsTopicName);
    const alertTopicArns = [alertsTopic.topicArn, operatorAlertsTopicArn];
    // Pipeline and rule failures reach the new topic (and so the team channel once Chatbot is wired); EventBridge publishes with this key.
    alertsKey.addToResourcePolicy(new iam.PolicyStatement({
      sid: "EventsPublishAlerts",
      principals: [new iam.ServicePrincipal("events.amazonaws.com")],
      actions: ["kms:GenerateDataKey*", "kms:Decrypt"],
      resources: ["*"],
    }));
    const publishAlerts = (): iam.PolicyStatement[] => [
      new iam.PolicyStatement({ sid: "PublishAlerts", actions: ["sns:Publish"], resources: alertTopicArns }),
      new iam.PolicyStatement({
        sid: "UseAlertsKey",
        actions: ["kms:GenerateDataKey*", "kms:Decrypt"],
        resources: [alertsKey.keyArn],
        conditions: { StringEquals: { "kms:ViaService": `sns.${region}.amazonaws.com` } },
      }),
    ];

    // ---- the permissions boundary: the most any role of this pipeline can ever do, whatever its own policy says
    const stackNames = {
      access: environmentStackName(environment, "access"),
      pipeline: names.stack,
    };
    const settingsPrefix = environmentSettingsPrefix(environment).replace(/\/$/u, "");
    const canarySecretArn = arn("secretsmanager", `secret:rovara-release/${environment}/canary-credential-??????`);
    const signingKeySecretArn = arn("secretsmanager", `secret:agentx/${environment}/callback-signing-key-??????`);
    const notIn = (...keys: ReleaseRoleKey[]): Record<string, Record<string, string[]>> => ({ StringNotEquals: { "aws:PrincipalArn": keys.map(roleArn) } });
    const boundary = new iam.ManagedPolicy(this, "Boundary", {
      managedPolicyName: names.boundary,
      description: `The most any ${environment} release pipeline role can do`,
      statements: [
        // The ceiling: only the services the pipeline's roles use. Their own policies are far narrower.
        new iam.PolicyStatement({
          sid: "Ceiling",
          actions: [
            "codebuild:*", "codepipeline:*", "s3:*", "logs:*", "ssm:*", "cloudformation:*", "ecr:*", "sts:*", "sns:*", "kms:*", "secretsmanager:*",
            "cloudwatch:*", "lambda:*", "ecs:*", "ec2:Describe*", "elasticloadbalancing:Describe*", "events:Describe*", "events:List*",
            "cognito-idp:Admin*", "bedrock:InvokeModel", "budgets:ViewBudget", "servicequotas:GetServiceQuota",
            "iam:Get*", "iam:List*", "iam:PassRole", "iam:SimulatePrincipalPolicy",
            "codeconnections:UseConnection", "codestar-connections:UseConnection",
          ],
          resources: ["*"],
        }),
        // S4/S1: no IAM writes of any kind, so no role can widen itself or mint another.
        new iam.PolicyStatement({
          sid: "DenyIamWrites",
          effect: iam.Effect.DENY,
          actions: [
            "iam:Create*", "iam:Delete*", "iam:Put*", "iam:Attach*", "iam:Detach*", "iam:Update*", "iam:Add*", "iam:Remove*", "iam:Set*",
            "iam:Tag*", "iam:Untag*", "iam:Upload*", "iam:Enable*", "iam:Deactivate*", "iam:Change*", "iam:Reset*", "iam:Resync*",
          ],
          resources: ["*"],
        }),
        // S2: this region only.
        new iam.PolicyStatement({
          sid: "DenyOtherRegions",
          effect: iam.Effect.DENY,
          notActions: GLOBAL_SERVICE_ACTIONS,
          resources: ["*"],
          conditions: { StringNotEquals: { "aws:RequestedRegion": region } },
        }),
        // S2: this account only. A role may assume only roles of the account it runs in (never a role in another account, such as production).
        new iam.PolicyStatement({
          sid: "DenyAssumeOutsideAccount",
          effect: iam.Effect.DENY,
          actions: ["sts:AssumeRole", "sts:AssumeRoleWithSAML", "sts:AssumeRoleWithWebIdentity"],
          notResources: [arn("iam", "role/*", "global")],
        }),
        // S5/S12: the pipeline never deploys the access stack or itself, however a role got the right.
        new iam.PolicyStatement({
          sid: "DenyAccessAndPipelineStackWrites",
          effect: iam.Effect.DENY,
          actions: [
            "cloudformation:CreateStack", "cloudformation:UpdateStack", "cloudformation:DeleteStack", "cloudformation:ExecuteChangeSet",
            "cloudformation:UpdateTerminationProtection", "cloudformation:SetStackPolicy", "cloudformation:ContinueUpdateRollback",
            "cloudformation:RollbackStack", "cloudformation:CancelUpdateStack",
          ],
          resources: [stackArn(stackNames.access), stackArn(stackNames.pipeline)],
        }),
        // The artifact bucket parameter accepts any name: no role may touch an S3 bucket of another account.
        new iam.PolicyStatement({
          sid: "DenyS3OutsideAccount",
          effect: iam.Effect.DENY,
          actions: ["s3:*"],
          resources: ["*"],
          conditions: { Null: { "aws:ResourceAccount": "false" }, StringNotEquals: { "aws:ResourceAccount": account } },
        }),
        // P-SEP: only the auto-approver and the human approver approve; a build, a gate or the deploy never can.
        new iam.PolicyStatement({
          sid: "DenyApprovalExceptApprovers",
          effect: iam.Effect.DENY,
          actions: ["codepipeline:PutApprovalResult"],
          resources: ["*"],
          conditions: notIn("auto-approver", "approver"),
        }),
        // P0 fact (i): the native rollback target is the last execution that succeeded in Release, which a skipped canary also is. An explicit
        // rollback to the last good execution is the rollback role's alone (the approver principal assumes it); the native one is the service's.
        new iam.PolicyStatement({
          sid: "DenyRollbackStageExceptRollback",
          effect: iam.Effect.DENY,
          actions: ["codepipeline:RollbackStage"],
          resources: ["*"],
          conditions: notIn("rollback"),
        }),
        // P0 fact (4): the pipeline's own release version counter is the check's alone.
        new iam.PolicyStatement({
          sid: "DenyVersionCounterExceptCheck",
          effect: iam.Effect.DENY,
          actions: ["ssm:PutParameter", "ssm:DeleteParameter", "ssm:DeleteParameters"],
          resources: [param("*-release-version")],
          conditions: notIn("check"),
        }),
        // The environment's deploy lock and settings record are the deploy role's alone among the pipeline's roles (the Mac flow's operator role is not under this boundary).
        new iam.PolicyStatement({
          sid: "DenySettingsAndLockWritesExceptDeploy",
          effect: iam.Effect.DENY,
          actions: ["ssm:PutParameter", "ssm:DeleteParameter", "ssm:DeleteParameters", "ssm:LabelParameterVersion", "ssm:UnlabelParameterVersion"],
          resources: [arn("ssm", `parameter${settingsPrefix}/lock`), arn("ssm", `parameter${settingsPrefix}/settings`)],
          conditions: notIn("deploy"),
        }),
        // P0 fact (6): only Decide writes the CI evidence cache.
        new iam.PolicyStatement({
          sid: "DenyCiCacheWritesExceptDecide",
          effect: iam.Effect.DENY,
          actions: ["s3:PutObject"],
          resources: [`${runsBucket.bucketArn}/${CI_CACHE_PREFIX}*`],
          conditions: notIn("decide"),
        }),
        // S3: only the starter starts an execution.
        new iam.PolicyStatement({
          sid: "DenyStartExceptStarter",
          effect: iam.Effect.DENY,
          actions: ["codepipeline:StartPipelineExecution"],
          resources: ["*"],
          conditions: notIn("starter"),
        }),
        // P-EDIT: only the approver writes the policy pin; only the approver clears a hold.
        new iam.PolicyStatement({
          sid: "DenyPinWritesExceptApprover",
          effect: iam.Effect.DENY,
          actions: ["ssm:PutParameter", "ssm:DeleteParameter", "ssm:DeleteParameters", "ssm:LabelParameterVersion", "ssm:UnlabelParameterVersion"],
          resources: [param("policy-pin")],
          conditions: notIn("approver"),
        }),
        new iam.PolicyStatement({
          sid: "DenyHoldDeletesExceptApprover",
          effect: iam.Effect.DENY,
          actions: ["ssm:DeleteParameter", "ssm:DeleteParameters"],
          resources: [param("*-hold/*")],
          conditions: notIn("approver"),
        }),
        // S11/S14: the installed pointer is the post-check's, last-good the canary's, a hold anyone in the release path may set.
        new iam.PolicyStatement({
          sid: "DenyInstalledPointerExceptPostcheck",
          effect: iam.Effect.DENY,
          actions: ["ssm:PutParameter", "ssm:DeleteParameter", "ssm:DeleteParameters"],
          resources: [param("*-installed")],
          conditions: notIn("postcheck"),
        }),
        new iam.PolicyStatement({
          sid: "DenyLastGoodPointerExceptCanary",
          effect: iam.Effect.DENY,
          actions: ["ssm:PutParameter", "ssm:DeleteParameter", "ssm:DeleteParameters"],
          // Both `<kind>-last-good` (the sha) and `<kind>-last-good-execution` (the execution id an explicit rollback targets).
          resources: [param("*-last-good"), param("*-last-good-execution")],
          conditions: notIn("canary"),
        }),
        // Nothing in the pipeline deletes a run record, rewrites the bucket's rules, or writes the canary ledger except the canary.
        new iam.PolicyStatement({
          sid: "DenyRunsBucketDeletesAndRules",
          effect: iam.Effect.DENY,
          actions: ["s3:DeleteObject", "s3:DeleteObjectVersion", "s3:PutBucketPolicy", "s3:DeleteBucketPolicy", "s3:PutLifecycleConfiguration", "s3:PutBucketVersioning", "s3:DeleteBucket"],
          resources: [runsBucket.bucketArn, `${runsBucket.bucketArn}/*`],
        }),
        new iam.PolicyStatement({
          sid: "DenyLedgerWritesExceptCanary",
          effect: iam.Effect.DENY,
          actions: ["s3:PutObject"],
          resources: [`${runsBucket.bucketArn}/${CANARY_LEDGER_PREFIX}*`],
          conditions: notIn("canary"),
        }),
        // S6: the only secret values a role may read: the canary's credential (the canary role) and the callback signing key (the deploy role).
        new iam.PolicyStatement({
          sid: "DenySecretReadsExceptNamed",
          effect: iam.Effect.DENY,
          actions: ["secretsmanager:GetSecretValue", "secretsmanager:BatchGetSecretValue"],
          notResources: [canarySecretArn, signingKeySecretArn],
        }),
        new iam.PolicyStatement({
          sid: "DenyCanarySecretExceptCanary",
          effect: iam.Effect.DENY,
          actions: ["secretsmanager:GetSecretValue"],
          resources: [canarySecretArn],
          conditions: notIn("canary"),
        }),
        new iam.PolicyStatement({
          sid: "DenySigningKeyExceptDeploy",
          effect: iam.Effect.DENY,
          actions: ["secretsmanager:GetSecretValue"],
          resources: [signingKeySecretArn],
          conditions: notIn("deploy"),
        }),
        // S6/S7: the connection to GitHub is used by the source, the check and the build, and by nobody else (the decide stage reads GitHub anonymously).
        new iam.PolicyStatement({
          sid: "DenyConnectionExceptSourceCheckBuild",
          effect: iam.Effect.DENY,
          actions: ["codeconnections:*", "codestar-connections:*"],
          resources: ["*"],
          conditions: notIn("source", "check", "build"),
        }),
        // F4: assets and templates are written once, before Decide, by Preview; nothing after Decide may change what Decide judged.
        new iam.PolicyStatement({
          sid: "DenyAssetAndTemplateWritesExceptPreview",
          effect: iam.Effect.DENY,
          actions: ["s3:PutObject", "s3:DeleteObject", "s3:DeleteObjectVersion", "s3:PutObjectAcl"],
          resources: [`arn:${partition}:s3:::cdk-hnb659fds-assets-${account}-${region}/*`, `${accessArtifactBucketArn.valueAsString}/*`],
          conditions: notIn("preview"),
        }),
        // Only the build pushes images, and nothing deletes them.
        new iam.PolicyStatement({
          sid: "DenyImageWritesExceptBuild",
          effect: iam.Effect.DENY,
          actions: ["ecr:PutImage", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:PutLifecyclePolicy", "ecr:PutImageTagMutability", "ecr:CreateRepository"],
          resources: ["*"],
          conditions: notIn("build"),
        }),
        new iam.PolicyStatement({
          sid: "DenyImageDeletes",
          effect: iam.Effect.DENY,
          actions: ["ecr:BatchDeleteImage", "ecr:DeleteRepository", "ecr:DeleteLifecyclePolicy"],
          resources: ["*"],
        }),
        // S7: alerts go to exactly the two topics.
        new iam.PolicyStatement({
          sid: "DenySnsExceptAlertTopics",
          effect: iam.Effect.DENY,
          actions: ["sns:*"],
          notResources: alertTopicArns,
        }),
      ],
    });
    iam.PermissionsBoundary.of(this).apply(boundary);

    // ---- roles
    const sameAccountHuman = (key: "starter" | "approver" | "reader"): iam.IPrincipal =>
      new iam.PrincipalWithConditions(new iam.AccountRootPrincipal(), { ArnEquals: { "aws:PrincipalArn": humanPrincipals[key].valueAsString } });
    const buildRole = (key: ReleaseProjectKey, description: string): iam.Role =>
      new iam.Role(this, `${key}-role`, {
        roleName: names.role(key),
        description,
        assumedBy: new iam.PrincipalWithConditions(new iam.ServicePrincipal("codebuild.amazonaws.com"), {
          StringEquals: { "aws:SourceArn": arn("codebuild", `project/${names.project(key)}`) },
        }),
      });
    const roles = {
      check: buildRole("check", "Reads history and the release pointers; decides nothing"),
      build: buildRole("build", "The only role that runs the merged repository's code; writes its own records and images, nothing else"),
      preview: buildRole("preview", "Makes and describes change sets, runs pinned gate-pack code"),
      gates: buildRole("gates", "Read-only gates, runs pinned gate-pack code"),
      decide: buildRole("decide", "Runs only the pinned policy; reads the change sets from CloudFormation itself"),
      "auto-approver": buildRole("auto-approver", "Approves only a run whose Decide action said AUTO"),
      guard: buildRole("guard", "The first action of Release: re-checks order, hold, rollback safety and the rollback floor before anything deploys"),
      deploy: buildRole("deploy", "Deploys the decided change sets in the pack's order; never the access stack"),
      postcheck: buildRole("postcheck", "Read-only post-deploy checks; writes the installed pointer"),
      canary: buildRole("canary", "The one tiny real task after a deploy; the only holder of the canary credential"),
    } as const;
    const pipelineRole = new iam.Role(this, "pipeline-role", {
      roleName: names.role("pipeline"),
      description: "CodePipeline's own role: starts builds, moves artifacts, publishes alerts",
      assumedBy: new iam.PrincipalWithConditions(new iam.ServicePrincipal("codepipeline.amazonaws.com"), { StringEquals: { "aws:SourceArn": pipelineArn } }),
    });
    const sourceRole = new iam.Role(this, "source-role", {
      roleName: names.role("source"),
      description: "Reads the repositories through the GitHub connection",
      assumedBy: new iam.PrincipalWithConditions(new iam.AccountRootPrincipal(), { ArnEquals: { "aws:PrincipalArn": roleArn("pipeline") } }),
    });
    const humans = {
      starter: new iam.Role(this, "starter-role", { roleName: names.role("starter"), description: "Starts, stops and retries the pipeline", assumedBy: sameAccountHuman("starter") }),
      approver: new iam.Role(this, "approver-role", { roleName: names.role("approver"), description: "Approves a run, writes the policy pin, clears a hold", assumedBy: sameAccountHuman("approver") }),
      rollback: new iam.Role(this, "rollback-role", { roleName: names.role("rollback"), description: "Rolls the Release stage back to an explicit execution (the last good one); assumed by the approver principal", assumedBy: sameAccountHuman("approver") }),
      reader: new iam.Role(this, "reader-role", { roleName: names.role("reader"), description: "Reads the pipeline and its run records", assumedBy: sameAccountHuman("reader") }),
    } as const;

    // ---- the roles' own policies. Every statement names what it is for.
    const allow = (role: iam.IRole, statements: iam.PolicyStatement[]): void => {
      for (const statement of statements) role.addToPrincipalPolicy(statement);
    };
    const statement = (sid: string, actions: string[], resources: string[], conditions?: Record<string, Record<string, string | string[]>>): iam.PolicyStatement =>
      new iam.PolicyStatement({ sid, actions, resources, ...(conditions === undefined ? {} : { conditions }) });
    const readRun = (...stages: string[]): iam.PolicyStatement => statement("ReadRunRecords", ["s3:GetObject"], stages.map(runObjects));
    const runAccess = (key: keyof typeof RUN_ACCESS): iam.PolicyStatement[] => {
      const access: { read: readonly string[]; list: readonly string[]; write: readonly string[] } = RUN_ACCESS[key];
      return [
        ...(access.read.length === 0 ? [] : [readRun(...access.read)]),
        ...(access.list.length === 0 ? [] : [statement("ListRunRecords", ["s3:ListBucket"], [runsBucket.bucketArn], { StringLike: { "s3:prefix": access.list.map((stage) => `${stage}/*`) } })]),
        ...(access.write.length === 0 ? [] : [statement("WriteOwnRunRecords", ["s3:PutObject"], access.write.map(runObjects))]),
      ];
    };
    const listRuns = statement("ListRunRecords", ["s3:ListBucket"], [runsBucket.bucketArn], { StringLike: { "s3:prefix": RUN_STAGES.map((stage) => `${stage}/*`) } });
    const useConnection = statement("UseGitHubConnection", ["codeconnections:UseConnection", "codestar-connections:UseConnection"], [connectionArn.valueAsString]);
    const identity = statement("WhoAmI", ["sts:GetCallerIdentity"], ["*"]);
    const stackNames8 = (parts: readonly ("foundation" | "identity" | "runtime" | "control-plane" | "slack")[]): string[] => parts.map((part) => stackArn(environmentStackName(environment, part)));
    const deployedParts = ["foundation", "identity", "runtime", "control-plane", "slack"] as const;
    const readStacks = statement("DescribeEnvironmentStacks", ["cloudformation:DescribeStacks", "cloudformation:DescribeStackEvents", "cloudformation:DescribeStackResources", "cloudformation:GetTemplate", "cloudformation:GetTemplateSummary", "cloudformation:ListStackResources", "cloudformation:ListChangeSets", "cloudformation:DescribeChangeSet"], [stackArn(stackNames.access), ...stackNames8(deployedParts)]);
    const readSettings = statement("ReadEnvironmentSettings", ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"], [arn("ssm", `parameter${settingsPrefix}`), arn("ssm", `parameter${settingsPrefix}/*`)]);
    const readPointers = statement("ReadReleasePointers", ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"], [param("*"), arn("ssm", `parameter${names.parameterPrefix}`)]);
    const assetsBucket = `arn:${partition}:s3:::cdk-hnb659fds-assets-${account}-${region}`;

    allow(roles.check, [
      useConnection,
      statement("ReadPolicyPinAndPointers", ["ssm:GetParameter", "ssm:GetParametersByPath"], [param("policy-pin"), param("code-installed"), param("code-hold"), param("code-hold/*")]),
      // P0 fact (4): the pipeline's own release counter (`<major>.<minor>.<patch>`, seeded by hand once); the version is never the repository's own.
      statement("ReadAndAdvanceReleaseVersion", ["ssm:GetParameter", "ssm:PutParameter"], [param("code-release-version")]),
      ...runAccess("check"),
      ...publishAlerts(),
    ]);
    const buildImageRepositories = (props.imageRepositories ?? [`agentx-${environment}/worker`, `agentx-${environment}/slack`]).map((name) => arn("ecr", `repository/${name}`));
    allow(roles.build, [
      statement("EcrAuthorization", ["ecr:GetAuthorizationToken"], ["*"]),
      statement("PushOwnImages", [
        "ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:CompleteLayerUpload", "ecr:DescribeImages", "ecr:DescribeRepositories",
        "ecr:GetDownloadUrlForLayer", "ecr:InitiateLayerUpload", "ecr:PutImage", "ecr:UploadLayerPart",
      ], buildImageRepositories),
      useConnection,
      statement("ReadDeployedStacks", ["cloudformation:DescribeStacks"], [...stackNames8(deployedParts)]),
      readSettings,
      // The gate pack's scripts run here too (beside repo code), so Build checks the pack against the pin first.
      statement("ReadPolicyPin", ["ssm:GetParameter"], [param("policy-pin")]),
      identity,
      ...runAccess("build"),
    ]);
    allow(roles.preview, [
      statement("MakeAndReadChangeSets", ["cloudformation:CreateChangeSet", "cloudformation:DescribeChangeSet", "cloudformation:GetTemplate", "cloudformation:ListChangeSets"], [stackArn(stackNames.access), ...stackNames8(deployedParts)]),
      readStacks,
      statement("PassServiceRoleToCloudFormation", ["iam:PassRole"], [`arn:${partition}:iam::${account}:role/${environmentCloudFormationRoleName(environment)}`], { StringEquals: { "iam:PassedToService": "cloudformation.amazonaws.com" } }),
      // F4: the assets (Lambda code, templates) are put in place HERE, before Decide, so Decide judges the real keys. Nothing after Decide writes an asset
      // (the boundary reserves both buckets to this role).
      statement("PublishAssets", ["s3:PutObject", "s3:GetObject", "s3:ListBucket"], [assetsBucket, `${assetsBucket}/*`]),
      statement("PublishTemplates", ["s3:PutObject", "s3:GetObject", "s3:ListBucket"], [accessArtifactBucketArn.valueAsString, `${accessArtifactBucketArn.valueAsString}/*`]),
      readSettings,
      identity,
      ...runAccess("preview"),
    ]);
    allow(roles.gates, [
      readStacks,
      readSettings,
      readPointers,
      statement("SimulateRoles", ["iam:SimulatePrincipalPolicy", "iam:GetRole", "iam:GetRolePolicy", "iam:ListRolePolicies", "iam:ListAttachedRolePolicies"], [`arn:${partition}:iam::${account}:role/*`]),
      statement("ReadImages", ["ecr:DescribeImages", "ecr:DescribeRepositories"], [arn("ecr", "repository/*")]),
      statement("ReadFunctionsAndLogs", ["lambda:GetFunctionConfiguration", "logs:FilterLogEvents", "logs:StartQuery", "logs:GetQueryResults", "logs:DescribeLogGroups"], ["*"]),
      identity,
      ...runAccess("gates"),
    ]);
    allow(roles.decide, [
      // Read-only: the change sets and templates come from CloudFormation itself, never from the build's files (P-SEP).
      readStacks,
      statement("ReadPolicyPinHoldAndPointers", ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"], [param("*"), arn("ssm", `parameter${names.parameterPrefix}`)]),
      readSettings,
      statement("ReadImages", ["ecr:DescribeImages"], [arn("ecr", "repository/*")]),
      identity,
      ...runAccess("decide"),
      // Rule A of the policy reads how this run started (the trigger kind and its variables): its own pipeline only.
      statement("ReadOwnExecution", ["codepipeline:GetPipelineExecution"], [pipelineArn]),
      statement("ReadAndWriteCiEvidenceCache", ["s3:GetObject", "s3:PutObject"], [`${runsBucket.bucketArn}/${CI_CACHE_PREFIX}*`]),
      ...publishAlerts(),
    ]);
    allow(roles["auto-approver"], [
      statement("ReadOwnPipelineState", ["codepipeline:ListActionExecutions", "codepipeline:GetPipelineState"], [pipelineArn]),
      statement("ApproveTheDeployApproval", ["codepipeline:PutApprovalResult"], [`${pipelineArn}/${APPROVE_STAGE}/${MANUAL_APPROVAL_ACTION}`]),
      statement("ReadPolicyPin", ["ssm:GetParameter"], [param("policy-pin")]),
      readRun("decide"),
      ...publishAlerts(),
    ]);
    allow(roles.guard, [
      // The first action of Release (P0 fact (1)): a rollback re-runs only this stage, so the rollback's own safety checks run here, before Deploy.
      readStacks,
      readSettings,
      readPointers,
      statement("ReadOwnExecutions", ["codepipeline:GetPipelineExecution", "codepipeline:ListPipelineExecutions", "codepipeline:GetPipelineState", "codepipeline:ListActionExecutions"], [pipelineArn]),
      statement("SetHold", ["ssm:PutParameter"], [param("*-hold/*")]),
      identity,
      ...runAccess("guard"),
      ...publishAlerts(),
    ]);
    allow(roles.deploy, [
      // F1/F4: Deploy only EXECUTES the change sets Preview made and Decide judged, as plain AWS CLI from the pinned pack. It creates no change set, assumes no role
      // (a chained CDK bootstrap role would escape this boundary and reach the admin cfn-exec role), writes no asset and passes no role: the stack's own service
      // role does the work. Execution is limited to the pipeline's own change set names, and never reaches the access stack.
      statement("ExecuteDecidedChangeSets", ["cloudformation:ExecuteChangeSet"], stackNames8(deployedParts), { StringLike: { "cloudformation:ChangeSetName": "rovara-pipeline-*" } }),
      statement("TidyChangeSets", ["cloudformation:DescribeChangeSet", "cloudformation:ListChangeSets", "cloudformation:DeleteChangeSet"], [stackArn(stackNames.access), ...stackNames8(deployedParts)], { StringLike: { "cloudformation:ChangeSetName": "rovara-pipeline-*" } }),
      readStacks,
      readSettings,
      statement("ReadCallbackSigningKey", ["secretsmanager:GetSecretValue"], [signingKeySecretArn]),
      // What `agentx deploy` does outside CloudFormation, which executing change sets skips: it holds the environment's deploy lock for the whole deploy (the same parameter
      // the Mac flow takes, so the two can never run at once) and writes the settings record when the deploy succeeds. Exactly these two parameters, nothing else under /agentx.
      statement("TakeAndReleaseDeployLock", ["ssm:PutParameter", "ssm:DeleteParameter"], [arn("ssm", `parameter${settingsPrefix}/lock`)]),
      statement("WriteSettingsRecord", ["ssm:PutParameter"], [arn("ssm", `parameter${settingsPrefix}/settings`)]),
      statement("SetHold", ["ssm:PutParameter"], [param("*-hold/*")]),
      readPointers,
      statement("ReadImages", ["ecr:DescribeImages", "ecr:DescribeRepositories"], [arn("ecr", "repository/*")]),
      identity,
      ...runAccess("deploy"),
      ...publishAlerts(),
    ]);
    allow(roles.postcheck, [
      readStacks,
      readSettings,
      readPointers,
      statement("ReadFunctionsAndServices", ["lambda:GetFunction", "lambda:GetFunctionConfiguration", "ecs:DescribeServices", "ecs:DescribeClusters", "cloudwatch:GetMetricData", "cloudwatch:GetMetricStatistics", "logs:FilterLogEvents"], ["*"]),
      statement("ReadGatewayEventsRolePolicy", ["iam:GetRolePolicy"], [`arn:${partition}:iam::${account}:role/*PriceFetchTaskEventsRole*`]),
      statement("WriteInstalledPointer", ["ssm:PutParameter"], [param("*-installed")]),
      statement("SetHold", ["ssm:PutParameter"], [param("*-hold/*")]),
      identity,
      ...runAccess("postcheck"),
      ...publishAlerts(),
    ]);
    allow(roles.canary, [
      statement("ReadCanaryCredential", ["secretsmanager:GetSecretValue"], [canarySecretArn]),
      statement("ReadMetrics", ["cloudwatch:GetMetricData", "cloudwatch:GetMetricStatistics"], ["*"]),
      statement("WriteLastGoodPointers", ["ssm:PutParameter"], [param("*-last-good"), param("*-last-good-execution")]),
      statement("SetHold", ["ssm:PutParameter"], [param("*-hold/*")]),
      statement("ReadPointers", ["ssm:GetParameter"], [param("*")]),
      ...runAccess("canary"),
      ...publishAlerts(),
    ]);
    // Humans: S8.
    allow(humans.starter, [
      statement("StartStopRetry", ["codepipeline:StartPipelineExecution", "codepipeline:StopPipelineExecution", "codepipeline:RetryStageExecution"], [pipelineArn]),
      statement("ReadPipeline", ["codepipeline:GetPipeline", "codepipeline:GetPipelineState", "codepipeline:GetPipelineExecution", "codepipeline:ListPipelineExecutions", "codepipeline:ListActionExecutions"], [pipelineArn]),
    ]);
    allow(humans.approver, [
      statement("ApproveTheDeployApproval", ["codepipeline:PutApprovalResult"], [`${pipelineArn}/${APPROVE_STAGE}/${MANUAL_APPROVAL_ACTION}`]),
      statement("ReadPipeline", ["codepipeline:GetPipelineState", "codepipeline:GetPipelineExecution", "codepipeline:ListActionExecutions"], [pipelineArn]),
      statement("WritePolicyPinAndClearHolds", ["ssm:PutParameter", "ssm:GetParameter"], [param("policy-pin")]),
      statement("ClearHolds", ["ssm:DeleteParameter", "ssm:GetParametersByPath"], [param("*-hold/*"), param("*-hold")]),
      statement("Upload89Result", ["s3:PutObject"], [runObjects("89")]),
      readRun("check", "build", "preview", "gates", "decide", "release", "canary", "89"),
      listRuns,
    ]);
    allow(humans.rollback, [
      ...runAccess("rollback"),
      // P0 fact (1): an explicit rollback, never the native "most recent success" (a skipped canary is a success too).
      statement("RollbackReleaseStage", ["codepipeline:RollbackStage"], [`${pipelineArn}/${RELEASE_STAGE}`]),
      statement("ReadOwnExecutions", ["codepipeline:GetPipelineExecution", "codepipeline:ListPipelineExecutions", "codepipeline:GetPipelineState"], [pipelineArn]),
      statement("ReadLastGoodExecution", ["ssm:GetParameter"], [param("*-last-good-execution")]),
      ...publishAlerts(),
    ]);
    allow(humans.reader, [
      statement("ReadPipeline", ["codepipeline:GetPipelineState", "codepipeline:GetPipelineExecution", "codepipeline:ListActionExecutions", "codepipeline:ListPipelineExecutions"], [pipelineArn]),
      statement("ReadRunRecords", ["s3:GetObject"], RUN_STAGES.map(runObjects)),
      listRuns,
    ]);
    allow(sourceRole, [useConnection]);

    // ---- projects. Only Build runs the merged repository's code. Every other project runs the pinned gate pack, or plain AWS CLI.
    const sharedVariables = {
      ENVIRONMENT: { value: environment },
      RUNS_BUCKET: { value: runsBucket.bucketName },
      PIPELINE_NAME: { value: names.pipeline },
      PARAM_PREFIX: { value: names.parameterPrefix },
      BRANCH: { value: props.repository.branch },
      ENV_SETTINGS_PREFIX: { value: settingsPrefix },
    };
    const small = {
      environment: { buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2023_STANDARD_3_0, computeType: codebuild.ComputeType.SMALL },
      logging: { cloudWatch: { logGroup } },
    } as const;
    const makeProject = (key: ReleaseProjectKey, description: string, timeoutMinutes: number, commands: readonly string[], overrides: Partial<codebuild.PipelineProjectProps> = {}): codebuild.PipelineProject =>
      new codebuild.PipelineProject(this, `${key}-project`, {
        projectName: names.project(key),
        description,
        role: roles[key],
        timeout: Duration.minutes(timeoutMinutes),
        environmentVariables: sharedVariables,
        ...small,
        buildSpec: pinnedBuildSpec(commands),
        ...overrides,
      });
    const projects = {
      check: makeProject("check", "Records the tree and history, checks the order, reads the hold and the pin", 15, checkCommands()),
      build: new codebuild.PipelineProject(this, "build-project", {
        projectName: names.project("build"),
        description: "The only stage that runs the merged repository's code: images, synth, release package, answers",
        role: roles.build,
        environmentVariables: sharedVariables,
        ...releaseProjectSettings(logGroup),
        buildSpec: buildStageSpec(),
      }),
      preview: makeProject("preview", "Change sets and previews for every stack, with the pinned gate pack", 45, packStage("preview.sh", "preview", { synth: "record", source: true })),
      gates: makeProject("gates", "The read-only gates, with the pinned gate pack", 45, packStage("gates.sh", "gates")),
      decide: makeProject("decide", "Runs only the pinned policy evaluator; fails closed to MANUAL", 90, decideCommands(), {
        buildSpec: pinnedBuildSpec(decideCommands(), ["DECISION", "DECISION_SHA256"]),
      }),
      "auto-approver": makeProject("auto-approver", "Approves the deploy when this run's Decide action said AUTO", 15, autoApproveCommands()),
      guard: makeProject("guard", "First action of Release: order, hold, rollback safety and floor, before anything deploys (P9 fills the rollback rules)", 30, packStage("guard.sh", "guard", { synth: "verify", refuseRollback: true })),
      deploy: makeProject("deploy", "Deploys the decided change sets in the pack's order; never the access stack", 120, packStage("deploy.sh", "release", { synth: "verify", lock: true }), { concurrentBuildLimit: 1 }),
      postcheck: makeProject("postcheck", "Post-deploy checks; writes the installed pointer (P3 fills the checks)", 45, packStage("postcheck.sh", "release")),
      canary: makeProject("canary", "The canary task and its verdict (P9 fills it; until then it records SKIPPED-PLACEHOLDER and moves no pointer)", 45, canaryPlaceholderCommands()),
    } as const;

    // ---- the pipeline
    const codeOutput = new codepipeline.Artifact("Code");
    const opsOutput = new codepipeline.Artifact("Ops");
    const codeSource = new actions.CodeStarConnectionsSourceAction({
      actionName: "Code",
      connectionArn: connectionArn.valueAsString,
      owner: props.repository.owner,
      repo: props.repository.name,
      branch: props.repository.branch,
      codeBuildCloneOutput: true,
      variablesNamespace: SOURCE_VARIABLES,
      output: codeOutput,
      role: sourceRole,
    });
    const opsSource = new actions.CodeStarConnectionsSourceAction({
      actionName: "Ops",
      connectionArn: connectionArn.valueAsString,
      owner: opsRepositoryOwner.valueAsString,
      repo: opsRepositoryName.valueAsString,
      branch: opsBranch.valueAsString,
      output: opsOutput,
      role: sourceRole,
    });
    const execution = { EXEC_ID: { value: "#{codepipeline.PipelineExecutionId}" }, RELEASE_SHA: { value: `#{${SOURCE_VARIABLES}.CommitId}` } };
    const codebuildAction = (key: ReleaseProjectKey, actionName: string, input: codepipeline.Artifact, extraInputs: codepipeline.Artifact[], extra: Partial<actions.CodeBuildActionProps> = {}): actions.CodeBuildAction =>
      new actions.CodeBuildAction({
        actionName,
        project: projects[key],
        input,
        extraInputs,
        environmentVariables: execution,
        role: pipelineRole,
        ...extra,
      });
    const decideAction = codebuildAction("decide", DECIDE_ACTION, opsOutput, [], { variablesNamespace: DECIDE_VARIABLES });
    const approvalTopicSummary = `Decision #{${DECIDE_VARIABLES}.DECISION}; reasons and every row: s3://${runsBucket.bucketName}/decide/#{codepipeline.PipelineExecutionId}/decision.txt`;
    const pipeline = new codepipeline.Pipeline(this, "Pipeline", {
      pipelineName: names.pipeline,
      pipelineType: codepipeline.PipelineType.V2,
      // The newest merge wins; two runs never deploy at once (plan P-ORDER; Release also re-checks the order).
      executionMode: codepipeline.ExecutionMode.SUPERSEDED,
      artifactBucket: artifactBucket as s3.IBucket,
      crossAccountKeys: false,
      // The pipeline is deployed only by hand (S12): a run never changes how the pipeline judges itself.
      restartExecutionOnUpdate: false,
      role: pipelineRole,
      stages: [
        { stageName: "Source", actions: [codeSource, opsSource] },
        { stageName: "Check", actions: [codebuildAction("check", "Check", codeOutput, [opsOutput])] },
        { stageName: "Build", actions: [codebuildAction("build", "Build", codeOutput, [opsOutput])] },
        { stageName: "Preview", actions: [codebuildAction("preview", "Preview", opsOutput, [])] },
        { stageName: "Gates", actions: [codebuildAction("gates", "Gates", opsOutput, [])] },
        { stageName: "Decide", actions: [decideAction] },
        {
          stageName: APPROVE_STAGE,
          actions: [
            new actions.ManualApprovalAction({
              actionName: MANUAL_APPROVAL_ACTION,
              runOrder: 1,
              notificationTopic: alertsTopic,
              additionalInformation: approvalTopicSummary,
              role: pipelineRole,
            }),
            codebuildAction("auto-approver", AUTO_APPROVE_ACTION, opsOutput, [], {
              runOrder: 1,
              environmentVariables: { ...execution, DECISION: { value: `#{${DECIDE_VARIABLES}.DECISION}` } },
            }),
          ],
        },
        {
          // Deploy, post-check and canary are one stage: a failure in any of them re-runs the stage with the last successful execution's artifacts.
          stageName: RELEASE_STAGE,
          onFailure: { result: codepipeline.Result.ROLLBACK },
          actions: [
            codebuildAction("guard", GUARD_ACTION, opsOutput, [], { runOrder: 1 }),
            codebuildAction("deploy", "Deploy", opsOutput, [], { runOrder: 2 }),
            codebuildAction("postcheck", "PostCheck", opsOutput, [], { runOrder: 3 }),
            codebuildAction("canary", "Canary", opsOutput, [], { runOrder: 4 }),
          ],
        },
      ],
      triggers: [{
        providerType: codepipeline.ProviderType.CODE_STAR_SOURCE_CONNECTION,
        gitConfiguration: {
          sourceAction: codeSource,
          // Every merge runs: no file-path filter, no tag trigger. The policy decides what deploys on its own.
          pushFilter: [{ branchesIncludes: [props.repository.branch] }],
        },
      }],
    });
    // CDK grants the pipeline role the topic's publish (the approval's notification) but not the topic's key.
    alertsKey.grant(pipelineRole, "kms:GenerateDataKey*", "kms:Decrypt");

    // Pipeline and release-stage failures (a rollback is the release stage failing) go to the new topic.
    new events.Rule(this, "PipelineFailureAlerts", {
      description: `${names.pipeline}: execution failed or stopped, or the release stage failed (a rollback follows)`,
      eventPattern: {
        source: ["aws.codepipeline"],
        detailType: ["CodePipeline Pipeline Execution State Change", "CodePipeline Stage Execution State Change"],
        detail: { pipeline: [pipeline.pipelineName], state: ["FAILED", "STOPPED"] },
      },
      targets: [new targets.SnsTopic(alertsTopic)],
    });

    new CfnOutput(this, "PipelineName", { value: pipeline.pipelineName });
    new CfnOutput(this, "RunsBucketName", { value: runsBucket.bucketName });
    new CfnOutput(this, "AlertsTopicArn", { value: alertsTopic.topicArn });
    new CfnOutput(this, "BoundaryArn", { value: boundary.managedPolicyArn });
    new CfnOutput(this, "ApproverRoleArn", { value: humans.approver.roleArn });
    new CfnOutput(this, "StarterRoleArn", { value: humans.starter.roleArn });
    new CfnOutput(this, "ReaderRoleArn", { value: humans.reader.roleArn });
  }
}

// ---- inline buildspecs: none is read from the source repository, so a merge cannot change how the pipeline judges itself.

const SHELL_HEADER = ["set -eu", 'OPS="${CODEBUILD_SRC_DIR}"'];
const upload = (stage: string): string => `aws s3 cp --recursive --only-show-errors out/ "s3://\${RUNS_BUCKET}/${stage}/\${EXEC_ID}/"`;

function pinnedBuildSpec(commands: readonly string[], exported: readonly string[] = []): codebuild.BuildSpec {
  return codebuild.BuildSpec.fromObject({
    version: "0.2",
    env: { shell: "bash", ...(exported.length > 0 ? { "exported-variables": [...exported] } : {}) },
    phases: { build: { commands: [...SHELL_HEADER, "mkdir -p out", ...commands] } },
  });
}

/** Check: git history and AWS reads only; it runs no repository code. */
function checkCommands(): string[] {
  return [
    'OPS="${CODEBUILD_SRC_DIR_Ops}"',
    'cd "${CODEBUILD_SRC_DIR}"',
    'test "$(git rev-parse HEAD)" = "${RELEASE_SHA}" || { echo "HEAD is not the triggering commit"; exit 1; }',
    'git fetch --quiet origin "${BRANCH}"',
    'git merge-base --is-ancestor "${RELEASE_SHA}" "origin/${BRANCH}" || { echo "the commit is not on origin/${BRANCH}"; exit 1; }',
    'INSTALLED="$(aws ssm get-parameter --name "${PARAM_PREFIX}/code-installed" --query Parameter.Value --output text 2>/dev/null || echo none)"',
    'if [ "${INSTALLED}" != none ]; then git merge-base --is-ancestor "${INSTALLED}" "${RELEASE_SHA}" || { echo "forward-only: ${INSTALLED} is not an ancestor of ${RELEASE_SHA}"; exit 1; }; fi',
    'HOLDS="$(aws ssm get-parameters-by-path --path "${PARAM_PREFIX}/code-hold/" --query "length(Parameters)" --output text 2>/dev/null || echo unknown)"',
    'PIN="$(aws ssm get-parameter --name "${PARAM_PREFIX}/policy-pin" --query Parameter.Value --output text 2>/dev/null || echo missing)"',
    'MODE=auto-eligible; if [ "${HOLDS}" != 0 ] || [ "${PIN}" = "MANUAL-ONLY" ] || [ "${PIN}" = missing ]; then MODE=manual; fi',
    'git rev-parse "${RELEASE_SHA}^{tree}" > out/tree.txt',
    // P0 fact (4): the release version is the pipeline's own counter (seed code-release-version by hand once, for example 0.5.47); each run takes the next patch.
    'CURRENT="$(aws ssm get-parameter --name "${PARAM_PREFIX}/code-release-version" --query Parameter.Value --output text)" || { echo "seed ${PARAM_PREFIX}/code-release-version first"; exit 1; }',
    'echo "${CURRENT}" | grep -Eq "^[0-9]+[.][0-9]+[.][0-9]+$" || { echo "bad counter ${CURRENT}"; exit 1; }',
    "NEXT=\"$(echo \"${CURRENT}\" | awk -F. '{printf \"%d.%d.%d\", $1, $2, $3 + 1}')\"",
    'aws ssm put-parameter --name "${PARAM_PREFIX}/code-release-version" --type String --overwrite --value "${NEXT}" > /dev/null',
    'echo "${NEXT}" > out/version.txt',
    'if [ "${INSTALLED}" != none ]; then git log --oneline "${INSTALLED}..${RELEASE_SHA}" > out/log.txt; git diff --name-only "${INSTALLED}" "${RELEASE_SHA}" > out/paths.txt; else : > out/log.txt; : > out/paths.txt; fi',
    'printf \'{"sha":"%s","installed":"%s","holds":"%s","pin":"%s","mode":"%s"}\\n\' "${RELEASE_SHA}" "${INSTALLED}" "${HOLDS}" "${PIN}" "${MODE}" > out/check.json',
    upload("check"),
  ];
}

/** A stage that runs one script of the pinned gate pack, and only after the pack's own hash equals the policy pin. A missing script fails the stage. */
/** The sha256 of a release package directory (sorted manifest of every file), as Preview records it and Deploy and Guard re-check it. */
export const RELEASE_HASH_COMMAND = `(cd work/release && find . -type f | LC_ALL=C sort | xargs sha256sum | sha256sum | cut -d' ' -f1)`;

interface PackStageInputs {
  /** record: Preview downloads Build's release package, records its hash and uses it. verify: Guard and Deploy refuse a package that differs from what Preview recorded (F3). */
  synth?: "record" | "verify";
  source?: boolean;
  /** Guard: a ROLLBACK-type execution is refused until the rollback rules exist (P9). */
  refuseRollback?: boolean;
  /** Deploy: hold the environment deploy lock around the script, and write the settings record under it after a successful deploy. */
  lock?: boolean;
}

/** The settings record's script: a pack file, so it is pinned with the rest. Missing means the stage fails closed BEFORE it takes the lock. */
export const SETTINGS_RECORD_SCRIPT = "settings-record.sh";

/**
 * The Deploy stage's own commands around the pack's deploy script: take the environment deploy lock (the one `agentx deploy` takes, created only if absent, never taken over),
 * run the deploy, write the settings record only after it succeeded, and always release the lock. The commands are inline, so a change to the pack cannot skip the lock.
 */
function lockedRun(script: string): string[] {
  return [
    `test -f "$PACK/${SETTINGS_RECORD_SCRIPT}" || { echo "gate pack script ${SETTINGS_RECORD_SCRIPT} is missing: the stage fails closed"; exit 1; }`,
    'aws s3 cp --only-show-errors "s3://${RUNS_BUCKET}/check/${EXEC_ID}/version.txt" work/version.txt && RELEASE_VERSION="$(cat work/version.txt)"',
    'LOCK="${ENV_SETTINGS_PREFIX}/lock"',
    'HOLDER="$( aws sts get-caller-identity --query Arn --output text )"',
    'LOCK_VALUE="$( printf \'{"holder":"%s","command":"%s","acquiredAt":"%s"}\' "${HOLDER}" "pipeline deploy ${EXEC_ID}" "$( date -u +%Y-%m-%dT%H:%M:%S.000Z )" )"',
    'aws ssm put-parameter --name "${LOCK}" --type String --value "${LOCK_VALUE}" > /dev/null 2> work/lock.err || { echo "the environment deploy lock ${LOCK} is held (the Mac flow, or another run): $( cat work/lock.err )"; exit 1; }',
    "set +e",
    `( RUN_DIR="out" bash "$PACK/${script}" && RUN_DIR="out" RELEASE_VERSION="\${RELEASE_VERSION}" SETTINGS_PARAMETER="\${ENV_SETTINGS_PREFIX}/settings" bash "$PACK/${SETTINGS_RECORD_SCRIPT}" )`,
    "RC=$?",
    "set -e",
    // Release only OUR lock: read it, compare it with the exact value this execution wrote (holder, command with the execution id, time), delete only on a match. A lock
    // that is someone else's (a stale takeover while the deploy ran), or gone, is never deleted and fails the stage loudly.
    'CURRENT_LOCK="$( aws ssm get-parameter --name "${LOCK}" --query Parameter.Value --output text 2> /dev/null || echo unreadable )"',
    'LOCK_PROBLEM=""',
    'if [ "${CURRENT_LOCK}" = "${LOCK_VALUE}" ]; then aws ssm delete-parameter --name "${LOCK}" > /dev/null 2>&1 || { echo "WARNING: the deploy lock ${LOCK} could not be released; it goes stale after 2 hours, or delete it" >&2; echo "${LOCK}" > out/lock-not-released.txt; }; else LOCK_PROBLEM="the deploy lock ${LOCK} is no longer ours (someone else holds it, or it is gone): NOT deleted"; fi',
    'if [ -n "${LOCK_PROBLEM}" ]; then echo "ERROR: ${LOCK_PROBLEM}" >&2; echo "${LOCK_PROBLEM}" > out/lock-not-released.txt; fi',
    'test "${RC}" = 0 || exit "${RC}"',
    'test -z "${LOCK_PROBLEM}" || exit 1',
  ];
}

function packStage(script: string, outputStage: string, inputs: PackStageInputs = {}): string[] {
  return [
    'OPS="${CODEBUILD_SRC_DIR}"',
    `PACK="$OPS/${OPS_PACK_DIR}"`,
    `test -f "$PACK/${script}" || { echo "gate pack script ${script} is missing: the stage fails closed"; exit 1; }`,
    `PIN="$(aws ssm get-parameter --name "\${PARAM_PREFIX}/policy-pin" --query Parameter.Value --output text)"`,
    `HASH="$( ${POLICY_HASH_COMMAND} )"`,
    // MANUAL-ONLY is the stand-up and shadow value (plan section 6): the stages still run, and Decide says MANUAL.
    'if [ "${PIN}" != "MANUAL-ONLY" ] && [ "${PIN}" != "${HASH}" ]; then echo "the gate pack does not match the policy pin"; exit 1; fi',
    ...(inputs.refuseRollback === true
      ? [
          'EXEC_TYPE="$(aws codepipeline get-pipeline-execution --pipeline-name "${PIPELINE_NAME}" --pipeline-execution-id "${EXEC_ID}" --query pipelineExecution.executionType --output text)"',
          'if [ "${EXEC_TYPE}" != STANDARD ]; then echo "execution type ${EXEC_TYPE}: the rollback rules are not installed yet (P9), so the guard refuses"; exit 1; fi',
        ]
      : []),
    ...(inputs.synth === undefined
      ? []
      : [
          // P0 fact (5): Preview and Deploy work from the one release package Build made, never from a synth of their own. F3: Preview records its hash, and Guard and Deploy
          // refuse a package that differs (a later run's Build could otherwise rewrite this execution's package between Decide and Deploy).
          'mkdir -p work/release && aws s3 cp --recursive --only-show-errors "s3://${RUNS_BUCKET}/build/${EXEC_ID}/release/" work/release/',
          'test -n "$(find work/release -type f | head -1)" || { echo "the release package is empty"; exit 1; }',
          `RELEASE_HASH="$( ${RELEASE_HASH_COMMAND} )"`,
          ...(inputs.synth === "record"
            ? ['echo "${RELEASE_HASH}" > out/release.sha256', 'SYNTH_DIR="${PWD}/work/release"']
            : [
                'aws s3 cp --only-show-errors "s3://${RUNS_BUCKET}/preview/${EXEC_ID}/release.sha256" work/preview-release.sha256',
                'test "$(cat work/preview-release.sha256)" = "${RELEASE_HASH}" || { echo "the release package differs from the one Preview recorded"; exit 1; }',
              ]),
        ]),
    ...(inputs.source === true
      ? [
          // The pack may want a clean checkout with the local release tag. Build bundles exactly the released commit and the tag; the sha is content-addressed, so a forged bundle cannot pass this check.
          'aws s3 cp --only-show-errors "s3://${RUNS_BUCKET}/build/${EXEC_ID}/source.bundle" work/source.bundle && aws s3 cp --only-show-errors "s3://${RUNS_BUCKET}/check/${EXEC_ID}/version.txt" work/version.txt',
          'git clone --quiet work/source.bundle work/source && SOURCE_DIR="${PWD}/work/source" && RELEASE_VERSION="$(cat work/version.txt)"',
          'test "$(git -C "${SOURCE_DIR}" rev-parse HEAD)" = "${RELEASE_SHA}" || { echo "the source bundle is not the released commit"; exit 1; }',
          'test "$(git -C "${SOURCE_DIR}" rev-parse "v${RELEASE_VERSION}^{commit}")" = "${RELEASE_SHA}" || { echo "the release tag v${RELEASE_VERSION} is not on the released commit"; exit 1; }',
        ]
      : []),
    ...(inputs.lock === true ? lockedRun(script) : [`RUN_DIR="out"${inputs.synth === "record" ? ' SYNTH_DIR="${SYNTH_DIR}"' : ""}${inputs.source === true ? ' SOURCE_DIR="${SOURCE_DIR}" RELEASE_VERSION="${RELEASE_VERSION}"' : ""} bash "$PACK/${script}"`]),
    upload(outputStage),
  ];
}

/** Build: the only stage that runs the repository's code. Image reuse, the synth diffs and the answers come from pack scripts (P3). */
function buildStageSpec(): codebuild.BuildSpec {
  return codebuild.BuildSpec.fromObject({
    version: "0.2",
    env: {
      shell: "bash",
      variables: { NODE_OPTIONS: "--max-old-space-size=8192", ...RELEASE_TOOL_VARIABLES },
    },
    phases: {
      install: { commands: [...RELEASE_TOOL_INSTALL_COMMANDS] },
      pre_build: {
        commands: [
          "set -eu",
          // The gate pack's scripts run in this stage beside repo code: they must be exactly the pinned pack, checked before any repo code runs.
          'OPS="${CODEBUILD_SRC_DIR_Ops}"',
          'PIN="$(aws ssm get-parameter --name "${PARAM_PREFIX}/policy-pin" --query Parameter.Value --output text)"',
          `HASH="$( ${POLICY_HASH_COMMAND} )"`,
          'if [ "${PIN}" != "MANUAL-ONLY" ] && [ "${PIN}" != "${HASH}" ]; then echo "the gate pack does not match the policy pin"; exit 1; fi',
          'test "$(git rev-parse HEAD)" = "${RELEASE_SHA}" || { echo "HEAD is not the triggering commit"; exit 1; }',
          "npm ci",
        ],
      },
      build: {
        commands: [
          "set -eu",
          "mkdir -p out",
          // The version is the pipeline's own counter (Check advanced it): the repository's package.json says 0.1.0, and the CLI reads the release version from a local vX.Y.Z tag.
          'aws s3 cp --only-show-errors "s3://${RUNS_BUCKET}/check/${EXEC_ID}/version.txt" out/version.txt',
          'VERSION="$(cat out/version.txt)"',
          'echo "${VERSION}" | grep -Eq "^[0-9]+[.][0-9]+[.][0-9]+$" || { echo "bad release version ${VERSION}"; exit 1; }',
          'git tag -f "v${VERSION}"',
          // Images (reused by tree tag or built with a new unique tag), synth diffs and answers: P3's pack scripts, run from the Ops artifact.
          'for step in build-images.sh synth-diffs.sh answers-from-deployed.sh; do test -f "${CODEBUILD_SRC_DIR_Ops}/ops/staging-release/${step}" || { echo "gate pack script ${step} is missing: the build fails closed"; exit 1; }; done',
          'RUN_DIR="out" VERSION="${VERSION}" bash "${CODEBUILD_SRC_DIR_Ops}/ops/staging-release/build-images.sh"',
          'RUN_DIR="out" VERSION="${VERSION}" bash "${CODEBUILD_SRC_DIR_Ops}/ops/staging-release/synth-diffs.sh"',
          'WORKER_IMAGE_ARGS="$(cat out/image-args.txt 2>/dev/null || true)"',
          "npm run release:build -- --version \"${VERSION}\" --out out/release ${WORKER_IMAGE_ARGS}",
          'RUN_DIR="out" VERSION="${VERSION}" bash "${CODEBUILD_SRC_DIR_Ops}/ops/staging-release/answers-from-deployed.sh"',
          // Answers hold names only: a secret scan before anything leaves this stage.
          "gitleaks dir --no-banner --redact out",
          // The commit and its tag as a bundle, for Deploy's clean checkout (Deploy checks the sha, so nothing in it is trusted).
          'git bundle create out/source.bundle HEAD "v${VERSION}"',
          upload("build"),
        ],
      },
    },
  });
}

/** Decide: runs only the pinned evaluator and never `npm`. Anything but an exact AUTO from a passing evaluator is MANUAL. */
function decideCommands(): string[] {
  return [
    'OPS="${CODEBUILD_SRC_DIR}"',
    `EVALUATOR="$OPS/${OPS_PACK_DIR}/evaluator/decide.sh"`,
    'DECISION=MANUAL; REASON="evaluator-not-run"',
    'PIN="$(aws ssm get-parameter --name "${PARAM_PREFIX}/policy-pin" --query Parameter.Value --output text 2>/dev/null || echo missing)"',
    `HASH="$( ${POLICY_HASH_COMMAND} )" || HASH=refused`,
    // One command: CodeBuild runs each list entry on its own, so a compound statement must not be split across entries.
    [
      'if [ ! -f "$EVALUATOR" ]; then REASON="evaluator-missing"',
      'elif [ "${PIN}" = "MANUAL-ONLY" ] || [ "${PIN}" = missing ]; then REASON="policy-pin-${PIN}"',
      'elif [ "${PIN}" != "${HASH}" ]; then REASON="policy-pin-mismatch"',
      "else",
      '  set +e; RUN_DIR="out" POLICY_HASH="${HASH}" bash "$EVALUATOR"; RC=$?; set -e',
      "  VERDICT=\"$(jq -r '.verdict // empty' out/decision.json 2>/dev/null || true)\"",
      '  if [ "${RC}" = 0 ] && [ "${VERDICT}" = AUTO ]; then DECISION=AUTO; REASON=""; else REASON="evaluator-rc-${RC}-verdict-${VERDICT:-none}"; fi',
      "fi",
    ].join("\n"),
    // Fail closed in the record too: the file always says what the output variable says.
    'if [ "${DECISION}" != AUTO ]; then if [ -f out/decision.json ] && jq -e . out/decision.json >/dev/null 2>&1; then jq --arg r "${REASON}" \'.verdict = "MANUAL" | .reasons = ((.reasons // []) + [$r])\' out/decision.json > out/decision.tmp && mv out/decision.tmp out/decision.json; else jq -n --arg r "${REASON}" \'{verdict: "MANUAL", reasons: [$r]}\' > out/decision.json; fi; fi',
    'jq -r \'"verdict: " + .verdict + "\\n" + ((.reasons // []) | map("reason: " + .) | join("\\n"))\' out/decision.json > out/decision.txt',
    'DECISION_SHA256="$(sha256sum out/decision.json | cut -d" " -f1)"',
    upload("decide"),
  ];
}

/** AutoApprove: approves only after re-reading the decision and checking that this execution's Decide action succeeded with the same verdict. */
function autoApproveCommands(): string[] {
  return [
    'if [ "${DECISION:-MANUAL}" != AUTO ]; then echo "decision is ${DECISION:-MANUAL}: nothing to approve"; exit 0; fi',
    'aws s3 cp --only-show-errors "s3://${RUNS_BUCKET}/decide/${EXEC_ID}/decision.json" decision.json',
    'test "$(jq -r .verdict decision.json)" = AUTO || { echo "decision.json does not say AUTO"; exit 1; }',
    'DECISION_SHA256="$(sha256sum decision.json | cut -d" " -f1)"',
    'PIN="$(aws ssm get-parameter --name "${PARAM_PREFIX}/policy-pin" --query Parameter.Value --output text)"',
    'test "$(jq -r .policy_hash decision.json)" = "${PIN}" || { echo "the decision was made under another policy than the pin"; exit 1; }',
    // The Decide action of THIS execution succeeded, and its output variable says AUTO.
    `DECIDED="$(aws codepipeline list-action-executions --pipeline-name "\${PIPELINE_NAME}" --filter "pipelineExecutionId=\${EXEC_ID}" --query "actionExecutionDetails[?stageName=='${DECIDE_ACTION}' && actionName=='${DECIDE_ACTION}' && status=='Succeeded'] | [0].output.outputVariables.DECISION" --output text)"`,
    'test "${DECIDED}" = AUTO || { echo "this execution\'s Decide action did not succeed with AUTO"; exit 1; }',
    [
      "for attempt in $(seq 1 20); do",
      `  TOKEN="$(aws codepipeline get-pipeline-state --name "\${PIPELINE_NAME}" --query "stageStates[?stageName=='${APPROVE_STAGE}'].actionStates[?actionName=='${MANUAL_APPROVAL_ACTION}'].latestExecution.token | [0][0]" --output text)"`,
      '  if [ -n "${TOKEN}" ] && [ "${TOKEN}" != None ]; then break; fi; sleep 15',
      "done",
    ].join("\n"),
    'test -n "${TOKEN}" && [ "${TOKEN}" != None ] || { echo "the approval is not waiting"; exit 1; }',
    `aws codepipeline put-approval-result --pipeline-name "\${PIPELINE_NAME}" --stage-name ${APPROVE_STAGE} --action-name ${MANUAL_APPROVAL_ACTION} --token "\${TOKEN}" --result "summary=AUTO \${RELEASE_SHA} policy=\${PIN} decision=\${DECISION_SHA256},status=Approved"`,
  ];
}

/** The canary is P9's. Until then it records that nothing ran and moves no pointer, so last-good never advances on an unproven deploy. */
function canaryPlaceholderCommands(): string[] {
  return [
    'printf \'{"result":"SKIPPED-PLACEHOLDER","sha":"%s"}\\n\' "${RELEASE_SHA}" > out/result.json',
    'echo "canary: placeholder (P9). last-good is not moved."',
    upload("canary"),
  ];
}

/**
 * `-c agentxReleasePipeline=<environment>`: deployed by hand into the environment's own account and region, and the only stack that synthesizes then, so the stacks a
 * release deploys are never part of it. Returns whether it built the stack; with the context unset it does nothing.
 */
export function maybeEnvironmentReleasePipeline(app: App): boolean {
  const environment = app.node.tryGetContext("agentxReleasePipeline") as string | undefined;
  if (environment === undefined) return false;
  const region = app.node.tryGetContext("agentxRegion") as string | undefined;
  if (region === undefined) throw new Error("agentxReleasePipeline requires an explicit agentxRegion context: the pipeline never takes a region from the ambient environment");
  const named = app.node.tryGetContext("agentxEnv") as string | undefined;
  if (named !== undefined && named !== environment) {
    throw new Error(`agentxReleasePipeline=${JSON.stringify(environment)} does not match agentxEnv=${JSON.stringify(named)}`);
  }
  new EnvironmentReleasePipelineStack(app, "AgentXReleasePipeline", {
    description: `AgentX ${environment} release pipeline: every merge to the branch deploys after the policy or an approval`,
    environment,
    region,
    repository: {
      owner: AGENTX_RELEASE_REPOSITORY_OWNER,
      name: AGENTX_RELEASE_REPOSITORY_NAME,
      branch: (app.node.tryGetContext("agentxReleaseBranch") as string | undefined) ?? "code/next",
    },
  });
  return true;
}
