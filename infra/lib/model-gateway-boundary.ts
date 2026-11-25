import { Aspects, CfnDeletionPolicy, CfnResource, Stack, type IAspect } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import type { IConstruct } from "constructs";
import { RESOURCE_PREFIX, environmentSettingsPrefix } from "./model-gateway-contracts.js";

/**
 * Rovara Cloud's permissions boundary (owner decision 2026-11-17, matching Rovara Code's agentx-<env>-boundary): the most any role a
 * Cloud stack makes can ever do, whatever its own policy says. Every AWS::IAM::Role in a Cloud stack (the server and redirect
 * functions, the gateway's task, execution, events, Vertex and Bedrock broker roles, the release pipeline's roles, and the roles CDK
 * makes for its own custom resources such as BucketDeployment) carries it, set by an aspect, so a role added later carries it too.
 *
 * Each stack holds its own boundary, a customer-managed policy under /rovara-cloud/<env>/ (CloudFormation names it), so a stack never
 * waits on another stack or app for its boundary (the controller deploys each stack on its own, by change set). The statements depend
 * only on the environment and the stack's part (web, app, pipeline, gateway), never on which switches a stack was synthesized with, and
 * each part gets only what its roles use: only the pipeline may assume the CDK bootstrap roles, only the gateway may call Bedrock.
 *
 * Resources are named where Cloud names them (secrets, settings, CodeBuild projects, the bootstrap roles, the broker role), by the
 * stack-name prefix where CloudFormation generates a long-enough name (`<stack name>-<logical id>-<random>`: tables, log groups, the
 * image repository, buckets), and by the environment's role path for roles (CloudFormation shortens a generated role name past 64
 * characters, stack name included, so a role's name is never relied on). KMS keys, task definitions and Bedrock profiles have
 * generated ids: those are held to this account and region; each key's policy names the roles that may use it.
 */

/** The IAM path of the boundary policies: `/rovara-cloud/<env>/`. */
export function cloudRolePath(env: string): string {
  // environmentSettingsPrefix validates the name and gives `/rovara-cloud/<env>/`.
  return environmentSettingsPrefix(env);
}

/**
 * The IAM path of a part's roles (the parts in ROLE_PATH_PARTS): `/rovara-cloud/<env>/<part>/`, one per part, so a part's PassRole and
 * AssumeRole never reach another part's roles (the gateway never the pipeline's, nor the other way round).
 */
export function cloudPartRolePath(env: string, part: CloudStackPart): string {
  return `${cloudRolePath(env)}${part}/`;
}

/**
 * What a Cloud stack is: the suffix of its stack name, rovara-cloud-<env>-<part>. The one exception is "release-actions": the single release
 * pipeline's private actions stack (cloud-release-actions.ts, stack name rovara-cloud-release-actions), which is not per environment: it lives in the
 * release account, holds the CodeBuild project and role of every environment's Cloud steps, and is bounded as the environment that account runs.
 */
export type CloudStackPart = "web" | "app" | "pipeline" | "gateway-images" | "gateway" | "release-actions";
/** The parts of a per-environment stack (stack name rovara-cloud-<env>-<part>); "release-actions" is left out on purpose, it has no environment in its name. */
export const CLOUD_STACK_PARTS: readonly CloudStackPart[] = ["web", "app", "pipeline", "gateway-images", "gateway"];
/** The one stack that is not per environment (CloudStackPart). */
export const RELEASE_ACTIONS_PART: CloudStackPart = "release-actions";
/** The beta account's release role (L7, BETA-RELEASE-ROLE-PREP.md): the only role the beta build role may assume. (The production build role assumes nothing in beta: see PULL_BETA_IMAGE_ACTIONS.) */
export const CLOUD_BETA_RELEASE_ROLE_NAME = "rovara-cloud-beta-release";
/** The name prefix of the release actions' CodeBuild projects (the legacy runtime boundary denies release-*; the public pipeline's parameter pattern requires it). */
export const CLOUD_RELEASE_PROJECT_PREFIX = "release-cloud-";

/**
 * The parts whose roles live under cloudRolePath. A role's path can't change in place (CloudFormation replaces the role), so the stacks
 * already deployed on staging with roles at "/" (web, app) keep "/". The gateway and pipeline had no live roles when this was made (the
 * staging gateway create rolled back on 2026-11-16 with no role retained; the pipeline is not deployed). Kept at "/" wherever they are:
 * a role with a fixed name (the Bedrock broker, whose ARN every customer's trust policy names), and a role marked with keepRoleAtRoot
 * (the CodeBuild projects' service roles: the template passes their ARN, but cfn-lint E3050 warns that CodeBuild may read a service
 * role with a path wrongly, and nothing assumes or passes them, so "/" costs nothing).
 */
export const ROLE_PATH_PARTS: ReadonlySet<CloudStackPart> = new Set(["pipeline", "gateway", "gateway-images"]);

const atRoot = new WeakSet<IConstruct>();
/** Keeps a role at "/" in a part whose roles are otherwise under the part's path (a service that may not take a role with a path). */
export function keepRoleAtRoot(role: iam.IRole): void {
  atRoot.add(role.node.defaultChild ?? role);
}

export interface BoundaryScope {
  readonly env: string;
  readonly partition: string;
  readonly region: string;
  readonly account: string;
  /** Pipeline only (Rovara-cloud#269): the account its deploy job deploys into, through that account's CDK bootstrap roles. Absent: its own. */
  readonly deployAccount?: string;
}

export interface BoundaryStatement {
  readonly Sid: string;
  readonly Effect: "Allow" | "Deny";
  readonly Action: string[];
  readonly Resource: string[];
  readonly Condition?: Record<string, Record<string, string | string[]>>;
}

/** The CDK bootstrap roles `cdk deploy` assumes from the release pipeline's deploy job: never the CloudFormation execution role. */
export const CDK_BOOTSTRAP_ASSUMED_ROLES = ["deploy-role", "file-publishing-role", "image-publishing-role", "lookup-role"] as const;
export const CDK_BOOTSTRAP_QUALIFIER = "hnb659fds";

/** The customers' roles the Bedrock broker assumes (packages/model-gateway bedrock-byo.ts; model-gateway.ts holds the two equal). */
const BYO_CUSTOMER_ROLE_PREFIX = "RovaraBedrockInvoke-";
const BYO_BROKER_ROLE_PREFIX = "RovaraBedrockBroker-";
/**
 * The conditions on the broker's grant to assume a customer's Bedrock role, in ONE place: model-gateway.ts puts exactly these on the broker role's own
 * policy and this file puts exactly these on the boundary's ceiling for it (L4-HARD, owner 2026-11-18), so the two can never disagree (a test holds them
 * equal and refuses any other external id scheme). The external id is the ONE Bedrock scheme, `rvb-` + an HMAC of (install, company) under the gateway's
 * KMS key (packages/model-gateway/src/bedrock-byo.ts); the session name is the company id; the role is never one in Rovara's own account.
 */
export const BYO_CUSTOMER_EXTERNAL_ID_PATTERN = "rvb-*";
export const BYO_CUSTOMER_SESSION_NAME_PATTERN = "org_*";
export function byoCustomerAssumeConditions(account: string): { StringLike: Record<string, string>; StringNotEquals: Record<string, string> } {
  return {
    StringLike: { "sts:ExternalId": BYO_CUSTOMER_EXTERNAL_ID_PATTERN, "sts:RoleSessionName": BYO_CUSTOMER_SESSION_NAME_PATTERN },
    StringNotEquals: { "aws:ResourceAccount": account },
  };
}
/**
 * The logical ids of the gateway's provider key secrets (model-gateway.ts, `ProviderKey-<provider>` for each of MODEL_GATEWAY_PROVIDERS;
 * a test holds the two equal). With generated names (model-gateway.ts MODEL_GATEWAY_PROVIDER_SECRET_NAMES_CONTEXT_KEY, the default)
 * CloudFormation names a secret `<logical id>-<random>`, with no stack name or environment in it, so the boundary can only name them
 * by that prefix.
 */
export const GATEWAY_PROVIDER_SECRET_LOGICAL_IDS = ["ProviderKeyanthropic"] as const;

/**
 * The single release pipeline's artifact bucket layout, as far as this stack's grants depend on it (PH-S3-PREFIXES). CodePipeline stores an artifact at
 * `<pipeline name, first 20 characters>/<artifact name, first 10 characters>/<id>`; the pipeline lives in Rovara Code, so its name and its artifact names are a contract with
 * it (Code's release-pipeline.ts pins the same values, and a test there holds them). Nothing here reads a real run: the patterns below stay right for any truncation at or
 * beyond those lengths and for none at all (a name longer than its limit is cut to the limit and ends in `*`), and a shorter truncation fails closed (the write is refused
 * and the first beta run shows it). An artifact's prefix is at most ARTIFACT_KEY_NAME_CHARS long, so it is never cut: a prefix is whole in its own folder.
 *
 * The Cloud steps' state artifacts are named `State<Beta|Prod><Action>` (Code's cloudStateArtifactName), so that ONE short prefix tells an environment's state from every other
 * artifact in the bucket: `Source`, `CloudSource`, `ReleaseManifest` and `BetaReleaseManifest` (a bare `Beta*` would match the last; nothing here is that wide).
 */
export const RELEASE_PIPELINE_NAME = "AgentXProductionRelease";
export const ARTIFACT_KEY_PIPELINE_CHARS = 20;
export const ARTIFACT_KEY_NAME_CHARS = 10;
/** Every Cloud state artifact starts with this; each environment's own starts with its own prefix. The boundary caps writes at the first, the roles hold the second. */
export const CLOUD_STATE_ARTIFACT_PREFIX = "State";
export const CLOUD_STATE_ARTIFACT_PREFIXES: Readonly<Record<"beta" | "production", string>> = Object.freeze({ beta: "StateBeta", production: "StateProd" });
/** The S3 resource pattern for every object under one artifact prefix of the pipeline (`<bucket ARN>/<pipeline>/<prefix>*`). */
export function artifactKeyPattern(bucketArn: string, artifactPrefix: string): string {
  if (artifactPrefix.length === 0 || artifactPrefix.length > ARTIFACT_KEY_NAME_CHARS || /[^A-Za-z0-9_-]/u.test(artifactPrefix)) throw new Error(`${artifactPrefix}: not an artifact prefix (1 to ${ARTIFACT_KEY_NAME_CHARS} characters of A-Z a-z 0-9 _ -)`);
  const pipeline = RELEASE_PIPELINE_NAME.length > ARTIFACT_KEY_PIPELINE_CHARS ? `${RELEASE_PIPELINE_NAME.slice(0, ARTIFACT_KEY_PIPELINE_CHARS)}*` : RELEASE_PIPELINE_NAME;
  return `${bucketArn}/${pipeline}/${artifactPrefix}*`;
}

/**
 * What the release actions' boundary needs from the stack's own parameters (names a stack cannot know at synth time): the single release pipeline's artifact
 * bucket (CodePipeline hands every artifact over through it) and the beta account (the beta release role's address). Strings or tokens, never read.
 */
export interface ReleaseActionsBoundaryInputs {
  readonly artifactBucketName: string;
  readonly betaAccountId: string;
}

/** The actions on the gateway image repository the release steps use: push, pull and read, never a lifecycle, scanning, tag or delete action (the repository is protected). */
export const RELEASE_IMAGE_REPOSITORY_ACTIONS = [
  "ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:CompleteLayerUpload", "ecr:DescribeImages", "ecr:GetDownloadUrlForLayer",
  "ecr:InitiateLayerUpload", "ecr:ListImages", "ecr:PutImage", "ecr:UploadLayerPart",
] as const;
/**
 * What the production build role may do to beta's gateway image repository, with its OWN credentials (controller decision 2026-11-24: a read-only repository policy in beta
 * names the role; the beta release role's trust is not widened): pull and describe, never a push or a delete. The same four actions are in the repository policy
 * (cloud-release-actions.ts betaGatewayPullPolicy).
 */
export const PULL_BETA_IMAGE_ACTIONS = ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:DescribeImages", "ecr:GetDownloadUrlForLayer"] as const;
/** The beta gateway image repository's name prefix in the beta account (its images stack: rovara-cloud-beta-gateway-images, repository generated under it). */
export const BETA_GATEWAY_IMAGES_PREFIX = `${RESOURCE_PREFIX}-beta-gateway-images-`;
/** The one-off price fetch's task definition family (the gateway stack's PriceFetchTask construct id; the stack name is not part of it). */
export const PRICE_FETCH_TASK_FAMILY = "RovaraModelGatewayPriceFetchTask";

/** The statements of the release actions' boundary that name the stack's own parameters; appended after the part's own (like the web stack's meter reads). */
export function releaseActionsParameterStatements(partition: string, region: string, inputs: ReleaseActionsBoundaryInputs): BoundaryStatement[] {
  return [
    {
      // CodeBuild reads each input artifact through the pipeline's bucket (S3-managed encryption, so no key).
      Sid: "PipelineArtifacts", Effect: "Allow", Action: ["s3:GetObject", "s3:GetObjectVersion", "s3:GetBucketAcl", "s3:GetBucketLocation"],
      Resource: [`arn:${partition}:s3:::${inputs.artifactBucketName}`, `arn:${partition}:s3:::${inputs.artifactBucketName}/*`],
    },
    {
      // ... and writes its output: only a Cloud state artifact (never Source, CloudSource or a Code release manifest, which a later stage reads). The roles hold one environment's
      // prefix each; the cap is the family. No Deny here: the boundary is nearly full (see the size test), and an Allow this narrow already refuses everything else.
      Sid: "PipelineStateWrites", Effect: "Allow", Action: ["s3:PutObject", "s3:AbortMultipartUpload"],
      Resource: [artifactKeyPattern(`arn:${partition}:s3:::${inputs.artifactBucketName}`, CLOUD_STATE_ARTIFACT_PREFIX)],
    },
    {
      // The beta build role's one grant: the beta release role, through which every beta write happens.
      Sid: "AssumeBetaReleaseRole", Effect: "Allow", Action: ["sts:AssumeRole"],
      Resource: [`arn:${partition}:iam::${inputs.betaAccountId}:role/${CLOUD_BETA_RELEASE_ROLE_NAME}`],
    },
    {
      // Production only: pull beta's gateway image for the promotion (the repository's own policy in beta must name the production build role too).
      Sid: "PullBetaImage", Effect: "Allow", Action: [...PULL_BETA_IMAGE_ACTIONS],
      Resource: [`arn:${partition}:ecr:${region}:${inputs.betaAccountId}:repository/${BETA_GATEWAY_IMAGES_PREFIX}*`],
    },
  ];
}

/** The boundary of one part of one environment. Pure: tests and the controller's simulation call it with plain strings. */
export function cloudBoundaryStatements(scope: BoundaryScope, part: CloudStackPart): BoundaryStatement[] {
  const { env, partition: p, region: r, account: a } = scope;
  // The account the pipeline deploys into: its own, or (beta) another account whose bootstrap roles trust this one.
  const d = scope.deployAccount ?? a;
  const path = cloudRolePath(env);
  const rolesOf = (which: CloudStackPart) => `arn:${p}:iam::${a}:role${cloudPartRolePath(env, which)}*`;
  // Generated names start with the stack name; never `rovara-cloud-<env>-*` (that would match an environment named <env>-eu too).
  const stack = (which: string) => `${RESOURCE_PREFIX}-${env}-${which}`;
  const logs = (groups: string[]): BoundaryStatement => ({
    Sid: "Logs", Effect: "Allow", Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
    Resource: groups.map((group) => `arn:${p}:logs:${r}:${a}:log-group:${group}`),
  });
  const tables = (stacks: string[]): BoundaryStatement => ({
    // Item reads and writes only: no Scan, no batch actions, no table changes, no streams.
    Sid: "TableItems", Effect: "Allow",
    Action: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:ConditionCheckItem", "dynamodb:Query"],
    Resource: stacks.map((s) => `arn:${p}:dynamodb:${r}:${a}:table/${stack(s)}-*`),
  });
  const secrets: BoundaryStatement = { Sid: "OwnSecrets", Effect: "Allow", Action: ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"], Resource: [`arn:${p}:secretsmanager:${r}:${a}:secret:${path.slice(1)}*`] };
  const keys = (actions: string[]): BoundaryStatement => ({ Sid: "KeyUse", Effect: "Allow", Action: actions, Resource: [`arn:${p}:kms:${r}:${a}:key/*`] });
  const projects = ["deploy", "check"].map((what) => `${RESOURCE_PREFIX}-${env}-${what}`);
  const objects = ["s3:GetObject*", "s3:GetBucket*", "s3:List*", "s3:DeleteObject*", "s3:PutObject*", "s3:Abort*"];
  const allows: Record<CloudStackPart, BoundaryStatement[]> = {
    web: [
      // The server logs to its own group; CDK's BucketDeployment function too (cloud-web.ts gives it one).
      logs([`${stack("web")}-*`]),
      // Its State and Companies tables, and (product AI) the gateway's product key table.
      tables(["web", "gateway"]),
      secrets,
      { Sid: "OwnSettings", Effect: "Allow", Action: ["ssm:GetParameter"], Resource: [`arn:${p}:ssm:${r}:${a}:parameter${path}*`] },
      keys(["kms:Decrypt", "kms:GenerateDataKey", "kms:GenerateMac"]),
      // The web app's files: written to its own bucket, read from the CDK asset bucket (never written: other stacks deploy from it).
      { Sid: "OwnBuckets", Effect: "Allow", Action: objects, Resource: [`arn:${p}:s3:::${stack("web")}-*`] },
      { Sid: "ReadDeployAssets", Effect: "Allow", Action: ["s3:GetObject*", "s3:GetBucket*", "s3:List*"], Resource: [`arn:${p}:s3:::cdk-${CDK_BOOTSTRAP_QUALIFIER}-assets-${a}-${r}`, `arn:${p}:s3:::cdk-${CDK_BOOTSTRAP_QUALIFIER}-assets-${a}-${r}/*`] },
    ],
    app: [logs([`${stack("app")}-*`])],
    pipeline: [
      logs([`${stack("pipeline")}-*`, ...projects.map((name) => `/aws/codebuild/${name}*`)]),
      { Sid: "OwnBuckets", Effect: "Allow", Action: objects, Resource: [`arn:${p}:s3:::${stack("pipeline")}-*`] },
      {
        Sid: "PipelineBuilds", Effect: "Allow",
        Action: ["codebuild:BatchGetBuilds", "codebuild:StartBuild", "codebuild:StopBuild", "codebuild:CreateReport*", "codebuild:UpdateReport", "codebuild:BatchPut*"],
        Resource: [...projects.map((name) => `arn:${p}:codebuild:${r}:${a}:project/${name}`), ...projects.map((name) => `arn:${p}:codebuild:${r}:${a}:report-group/${name}-*`)],
      },
      {
        Sid: "PipelineSource", Effect: "Allow",
        Action: ["codeconnections:UseConnection", "codeconnections:GetConnectionToken", "codestar-connections:UseConnection", "codestar-connections:GetConnectionToken"],
        Resource: [`arn:${p}:codeconnections:*:${a}:connection/*`, `arn:${p}:codestar-connections:*:${a}:connection/*`],
      },
      // In another account the release check reads the web stack through that account's lookup role (AssumeDeployRoles) instead.
      ...(d === a ? [{ Sid: "ReleaseCheckReadsWebStack", Effect: "Allow" as const, Action: ["cloudformation:DescribeStacks"], Resource: [`arn:${p}:cloudformation:${r}:${a}:stack/${stack("web")}/*`] }] : []),
      {
        // The pipeline assumes its own action roles (under the path) and the bootstrap roles cdk deploy uses, in the account it deploys
        // into. Only this part may.
        Sid: "AssumeDeployRoles", Effect: "Allow", Action: ["sts:AssumeRole"],
        Resource: [rolesOf("pipeline"), ...CDK_BOOTSTRAP_ASSUMED_ROLES.map((role) => `arn:${p}:iam::${d}:role/cdk-${CDK_BOOTSTRAP_QUALIFIER}-${role}-${d}-${r}`)],
      },
    ],
    "gateway-images": [],
    gateway: [
      logs([`${stack("gateway")}-*`]),
      // Its meter, ledger, markers, prices and product tables, and the web stack's Companies table (budgets, read only by its policy).
      tables(["gateway", "web"]),
      // Its provider key secrets under either naming (model-gateway.ts MODEL_GATEWAY_PROVIDER_SECRET_NAMES_CONTEXT_KEY): the fixed names
      // sit under the environment's prefix; a generated name is `<logical id>-<random>` and carries no environment, so another
      // environment's generated provider secret in the same account and Region also matches. That is a ceiling only: the serving role's
      // own policy names its secrets' exact ARNs, and each environment's secrets are encrypted with that environment's key, whose policy
      // lets only that environment's serving role decrypt (model-gateway.ts OnlyGatewayReads).
      { ...secrets, Resource: [...secrets.Resource, ...GATEWAY_PROVIDER_SECRET_LOGICAL_IDS.map((id) => `arn:${p}:secretsmanager:${r}:${a}:secret:${id}-*`)] },
      keys(["kms:Decrypt", "kms:GenerateMac", "kms:VerifyMac"]),
      {
        Sid: "ModelCalls", Effect: "Allow", Action: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
        // A system inference profile sends calls to foundation models in other Regions of its geography.
        Resource: [`arn:${p}:bedrock:*::foundation-model/*`, `arn:${p}:bedrock:${r}:${a}:inference-profile/*`],
      },
      { Sid: "ImageToken", Effect: "Allow", Action: ["ecr:GetAuthorizationToken"], Resource: ["*"] },
      { Sid: "ImagePull", Effect: "Allow", Action: ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"], Resource: [`arn:${p}:ecr:${r}:${a}:repository/${stack("gateway-images")}-*`] },
      // The daily price fetch: EventBridge runs one task in the gateway's cluster, passing the gateway's own roles.
      { Sid: "PriceFetchTask", Effect: "Allow", Action: ["ecs:RunTask", "ecs:TagResource"], Resource: [`arn:${p}:ecs:${r}:${a}:task-definition/*`, `arn:${p}:ecs:${r}:*:task/${stack("gateway")}-*`] },
      { Sid: "PassOwnRoles", Effect: "Allow", Action: ["iam:PassRole"], Resource: [rolesOf("gateway")] },
      {
        // The serving role assumes its Vertex role (under the path) and the broker.
        Sid: "AssumeGatewayRoles", Effect: "Allow", Action: ["sts:AssumeRole"],
        Resource: [rolesOf("gateway"), `arn:${p}:iam::${a}:role/${BYO_BROKER_ROLE_PREFIX}${env}`],
      },
      {
        // The broker assumes customers' Bedrock roles, in OTHER accounts only, with the company's rvb- external id and its org_ session name: the same
        // conditions its own grant carries (byoCustomerAssumeConditions), so the ceiling is exactly the grant (before L4-HARD it had no conditions).
        Sid: "AssumeCustomerBedrockRoles", Effect: "Allow", Action: ["sts:AssumeRole"],
        Resource: [`arn:${p}:iam::*:role/${BYO_CUSTOMER_ROLE_PREFIX}*`],
        Condition: byoCustomerAssumeConditions(a),
      },
    ],
    // The single release pipeline's Cloud steps (cloud-release-actions.ts): one project and one role per environment, in the release account. The ceiling is the union of what
    // the two roles' own policies grant (the beta role's own policy is far narrower: it may assume the beta release role and nothing else); everything in the release
    // account is this environment's, everything in beta is reached through the beta release role. The pipeline's artifact bucket and the beta account are the
    // stack's parameters, so those two statements come from releaseActionsParameterStatements.
    "release-actions": [
      // The stack's own group, and the default group CodeBuild names for each project (CDK's project policy covers it too).
      logs([`${RESOURCE_PREFIX}-release-actions-*`, `/aws/codebuild/${CLOUD_RELEASE_PROJECT_PREFIX}*`]),
      {
        Sid: "BuildReports", Effect: "Allow", Action: ["codebuild:CreateReportGroup", "codebuild:CreateReport", "codebuild:UpdateReport", "codebuild:BatchPutTestCases", "codebuild:BatchPutCodeCoverages"],
        Resource: [`arn:${p}:codebuild:${r}:${a}:report-group/${CLOUD_RELEASE_PROJECT_PREFIX}*`],
      },
      {
        // Both source actions are full clones: the build clones through each connection.
        Sid: "PipelineSource", Effect: "Allow",
        Action: ["codeconnections:UseConnection", "codeconnections:GetConnectionToken", "codestar-connections:UseConnection", "codestar-connections:GetConnectionToken"],
        Resource: [`arn:${p}:codeconnections:*:${a}:connection/*`, `arn:${p}:codestar-connections:*:${a}:connection/*`],
      },
      {
        // cdk deploy and every CloudFormation call of the stage CLI go through the account's bootstrap roles, never the CloudFormation execution role.
        Sid: "AssumeBootstrapRoles", Effect: "Allow", Action: ["sts:AssumeRole"],
        Resource: CDK_BOOTSTRAP_ASSUMED_ROLES.map((role) => `arn:${p}:iam::${a}:role/cdk-${CDK_BOOTSTRAP_QUALIFIER}-${role}-${a}-${r}`),
      },
      { Sid: "ImageToken", Effect: "Allow", Action: ["ecr:GetAuthorizationToken"], Resource: ["*"] },
      { Sid: "ImageRepository", Effect: "Allow", Action: [...RELEASE_IMAGE_REPOSITORY_ACTIONS], Resource: [`arn:${p}:ecr:${r}:${a}:repository/${stack("gateway-images")}-*`] },
      {
        // The one-off price fetch: the schedule's own task definition, in the gateway's cluster. No overrides, no tags (the build passes none).
        Sid: "PriceFetchRun", Effect: "Allow", Action: ["ecs:RunTask"],
        Resource: [`arn:${p}:ecs:${r}:${a}:task-definition/${PRICE_FETCH_TASK_FAMILY}*`],
        Condition: { ArnLike: { "ecs:cluster": `arn:${p}:ecs:${r}:${a}:cluster/${stack("gateway")}-*` } },
      },
      {
        // Only to ECS tasks. (A task's role can be overridden at RunTask: the identity policy names the two exact roles, which a boundary by path cannot.)
        Sid: "PriceFetchPassRoles", Effect: "Allow", Action: ["iam:PassRole"], Resource: [rolesOf("gateway")],
        Condition: { StringEquals: { "iam:PassedToService": "ecs-tasks.amazonaws.com" } },
      },
      {
        Sid: "PriceFetchReads", Effect: "Allow", Action: ["ecs:DescribeTasks", "ecs:ListTasks", "ecs:DescribeServices", "ecs:ListServices"], Resource: ["*"],
        Condition: { ArnLike: { "ecs:cluster": `arn:${p}:ecs:${r}:${a}:cluster/${stack("gateway")}-*` } },
      },
      { Sid: "TaskDefinitionRead", Effect: "Allow", Action: ["ecs:DescribeTaskDefinition"], Resource: ["*"] },
      { Sid: "PriceScheduleRead", Effect: "Allow", Action: ["events:ListTargetsByRule"], Resource: [`arn:${p}:events:${r}:${a}:rule/*`] },
      {
        Sid: "PriceFetchLogs", Effect: "Allow", Action: ["logs:DescribeLogStreams", "logs:GetLogEvents", "logs:FilterLogEvents"],
        Resource: [`arn:${p}:logs:${r}:${a}:log-group:${stack("gateway")}-PriceFetchLogs*`],
      },
      {
        // The last-good record and the stage's other release records: write only under release/ (the plan's SSM prefix), read the backfill record.
        Sid: "ReleaseRecords", Effect: "Allow", Action: ["ssm:GetParameter", "ssm:GetParameters", "ssm:PutParameter"],
        Resource: [`arn:${p}:ssm:${r}:${a}:parameter${path}release/*`],
      },
      { Sid: "ReleaseChecksRead", Effect: "Allow", Action: ["ssm:GetParameter", "ssm:GetParameters"], Resource: [`arn:${p}:ssm:${r}:${a}:parameter${path}release-checks/*`] },
      { Sid: "CertificateRead", Effect: "Allow", Action: ["acm:DescribeCertificate"], Resource: [`arn:${p}:acm:${r}:${a}:certificate/*`] },
    ],
  };
  return [
    ...allows[part],
    // The Deny statements hold even if a later change widens an Allow above.
    {
      Sid: "DenyIamChanges", Effect: "Deny",
      Action: ["iam:Create*", "iam:Delete*", "iam:Put*", "iam:Attach*", "iam:Detach*", "iam:Update*", "iam:Add*", "iam:Remove*", "iam:Set*", "iam:Tag*", "iam:Untag*", "iam:Upload*", "iam:Change*", "iam:Reset*", "iam:Enable*", "iam:Deactivate*"],
      Resource: ["*"],
    },
    { Sid: "DenyAccountChanges", Effect: "Deny", Action: ["organizations:*", "account:*"], Resource: ["*"] },
    { Sid: "DenyKeyManagement", Effect: "Deny", Action: ["kms:PutKeyPolicy", "kms:CreateGrant", "kms:ScheduleKeyDeletion", "kms:DisableKey", "kms:Delete*"], Resource: ["*"] },
    // The bootstrap's CloudFormation execution role is the account's administrator: no Cloud role may reach it. (A customer's Bedrock
    // role in this account is refused by the broker's own policy, aws:ResourceAccount: a Deny here would also cover other accounts.)
    { Sid: "DenyAdminRoles", Effect: "Deny", Action: ["sts:AssumeRole", "iam:PassRole"], Resource: [`arn:${p}:iam::${a}:role/cdk-${CDK_BOOTSTRAP_QUALIFIER}-cfn-exec-role-*`] },
    ...(part === "release-actions" ? releaseActionsDenies() : []),
  ];
}

/**
 * The release actions' extra Deny statements (BETA-RELEASE-ROLE-PREP.md 2.3 and 2.5), which hold even if a later change widens an Allow: no role may assume the organization's
 * management-account Administrator path (any account), read a secret's value, or use a key other than through S3 (SSM here is plain String records; the artifact objects use the aws/s3 key), or
 * run a task with an interactive shell. The last carries a condition (StringEquals on ecs:enable-execute-command, a String key), which the boundary check cannot evaluate: a test pins it instead (cloud-release-actions.test.ts).
 */
export function releaseActionsDenies(): BoundaryStatement[] {
  return [
    { Sid: "DenyOrganizationAdminRole", Effect: "Deny", Action: ["sts:AssumeRole"], Resource: ["arn:aws:iam::*:role/OrganizationAccountAccessRole"] },
    { Sid: "DenySecretValues", Effect: "Deny", Action: ["secretsmanager:GetSecretValue", "secretsmanager:BatchGetSecretValue"], Resource: ["*"] },
    // Key use is denied everywhere except through S3: the pipeline's artifacts (read and written by CodePipeline and by the projects' own output) are encrypted with the
    // AWS-managed aws/s3 key, and S3 calls KMS as the requesting role. A direct Decrypt of any key (a customer-managed key a key policy happens to name this role on) stays denied.
    { Sid: "DenyKeyUseOutsideS3", Effect: "Deny", Action: ["kms:Decrypt", "kms:GenerateDataKey*"], Resource: ["*"], Condition: { StringNotLike: { "kms:ViaService": "s3.*.amazonaws.com" } } },
    { Sid: "DenyExecIntoTasks", Effect: "Deny", Action: ["ecs:RunTask"], Resource: ["*"], Condition: { StringEquals: { "ecs:enable-execute-command": "true" } } },
  ];
}

/** True for any construct whose CloudFormation resource is AWS::IAM::Role: an iam.CfnRole, or a plain CfnResource (custom-resource providers). */
export function isIamRole(node: IConstruct): node is CfnResource {
  return CfnResource.isCfnResource(node) && node.cfnResourceType === "AWS::IAM::Role";
}

/** Reads a plain CfnResource's raw (PascalCase) properties: an aws-cdk-lib internal field, guarded by a test. */
function rawProperties(node: CfnResource): Record<string, unknown> | undefined {
  return (node as unknown as { _cfnProperties?: Record<string, unknown> })._cfnProperties;
}

class CloudBoundaryAspect implements IAspect {
  constructor(private readonly boundaryArn: string, private readonly path: string | undefined, private readonly stack: Stack) {}

  visit(node: IConstruct): void {
    if (!isIamRole(node) || Stack.of(node) !== this.stack) return;
    const path = atRoot.has(node) ? undefined : this.path;
    if (node instanceof iam.CfnRole) {
      if (node.permissionsBoundary !== undefined) throw new Error(`${node.node.path} already has a permissions boundary`);
      node.permissionsBoundary = this.boundaryArn;
      // L2 roles pass a lazy physical name that resolves to nothing when CloudFormation names the role.
      if (path !== undefined && this.stack.resolve(node.roleName) === undefined) {
        if (node.path !== undefined && node.path !== path) throw new Error(`${node.node.path} already has the path ${node.path}`);
        node.path = path;
      }
      return;
    }
    const properties = rawProperties(node);
    if (properties?.PermissionsBoundary !== undefined) throw new Error(`${node.node.path} already has a permissions boundary`);
    node.addPropertyOverride("PermissionsBoundary", this.boundaryArn);
    if (path !== undefined && properties?.RoleName === undefined) {
      if (properties?.Path !== undefined && properties.Path !== path) throw new Error(`${node.node.path} already has the path ${JSON.stringify(properties.Path)}`);
      node.addPropertyOverride("Path", path);
    }
  }
}

/** The boundary policy's logical id in every Cloud stack (the checker and the controller's simulation find it by this id). */
export const BOUNDARY_LOGICAL_ID = "RoleBoundary";
const bounded = new WeakMap<Stack, iam.CfnManagedPolicy>();

/**
 * Makes the stack's boundary and the aspect that puts it on every role the stack makes (and the environment's role path on the parts
 * in ROLE_PATH_PARTS). The web stack also supplies its meter table ARN for the narrowly conditioned batch reads (the other table
 * actions above already fit). Called once, last, by each Cloud stack's constructor; a second call throws. The gateway's boundary is retained:
 * its Bedrock broker role is retained, and a policy still in use as a role's boundary can't be deleted.
 */
export function applyCloudBoundary(stack: Stack, env: string, part: CloudStackPart, gatewayMeterTableArn?: string, deployAccount?: string, releaseActions?: ReleaseActionsBoundaryInputs): iam.CfnManagedPolicy {
  if (deployAccount !== undefined && part !== "pipeline") throw new Error("only the pipeline deploys into another account");
  if ((part === "release-actions") !== (releaseActions !== undefined)) throw new Error("only the release actions have a bucket and a beta account, and they need both");
  if (bounded.has(stack)) throw new Error(`${stack.node.path} already has its boundary`);
  // Only the web stack's approved meter reads extend the boundary, on the same exact ARN and company keys as its identity policy.
  const meterReads = part === "web" && gatewayMeterTableArn !== undefined ? [new iam.PolicyStatement({
    sid: "GatewayMeterCompanyReads", actions: ["dynamodb:GetItem", "dynamodb:BatchGetItem"], resources: [gatewayMeterTableArn],
    conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["CO#*"] }, Null: { "dynamodb:LeadingKeys": "false" } },
  }).toStatementJson() as Record<string, unknown>] : [];
  const policy = new iam.CfnManagedPolicy(stack, BOUNDARY_LOGICAL_ID, {
    path: cloudRolePath(env),
    description: `Rovara Cloud ${env} (${part}): the permissions boundary of every role this stack makes`,
    policyDocument: { Version: "2012-10-17", Statement: [...cloudBoundaryStatements({ env, partition: stack.partition, region: stack.region, account: stack.account, ...(deployAccount === undefined ? {} : { deployAccount }) }, part), ...meterReads, ...(releaseActions === undefined ? [] : releaseActionsParameterStatements(stack.partition, stack.region, releaseActions))] },
  });
  if (part === "gateway") {
    policy.cfnOptions.deletionPolicy = CfnDeletionPolicy.RETAIN;
    policy.cfnOptions.updateReplacePolicy = CfnDeletionPolicy.RETAIN;
  }
  bounded.set(stack, policy);
  Aspects.of(stack).add(new CloudBoundaryAspect(policy.ref, ROLE_PATH_PARTS.has(part) ? cloudPartRolePath(env, part) : undefined, stack));
  return policy;
}

/** The app-wide guard: a role in a stack that never called applyCloudBoundary fails the synth (a new stack class can't forget it). */
export class RequireCloudBoundary implements IAspect {
  visit(node: IConstruct): void {
    if (isIamRole(node) && !bounded.has(Stack.of(node))) throw new Error(`${node.node.path} is a role in a stack with no Rovara Cloud boundary (call applyCloudBoundary)`);
  }
}
