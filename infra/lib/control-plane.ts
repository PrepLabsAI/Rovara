import { grantProviderKeySecrets } from "./model-keys.js";
import { resolve } from "node:path";
import {
  ArnFormat,
  Aws,
  CfnCondition,
  CfnOutput,
  CfnParameter,
  Duration,
  Fn,
  RemovalPolicy,
  SecretValue,
  Stack,
  type StackProps,
  Token,
  aws_apigatewayv2 as apigwv2,
  aws_budgets as budgets,
  aws_cloudwatch as cloudwatch,
  aws_cloudwatch_actions as cloudwatchActions,
  aws_dynamodb as dynamodb,
  aws_iam as iam,
  aws_kms as kms,
  aws_lambda as lambda,
  aws_lambda_destinations as lambdaDestinations,
  aws_lambda_nodejs as lambdaNodejs,
  aws_logs as logs,
  aws_s3 as s3,
  aws_scheduler as scheduler,
  aws_scheduler_targets as schedulerTargets,
  aws_secretsmanager as secretsmanager,
  aws_sns as sns,
  aws_sqs as sqs,
} from "aws-cdk-lib";
import type { Construct } from "constructs";
import { CORE_DISPATCHER_TIMEOUT_SECONDS, CORE_BROKER_TIMEOUT_SECONDS, E2E_ARTIFACT_RETENTION_DAYS, EVIDENCE_RETENTION_DAYS, E2E_ARTIFACT_RETENTION_TAG_KEY, E2E_ARTIFACT_RETENTION_TAG_VALUE, HEALTH_ALARM_SUFFIXES, INDEX_EXPIRY_ATTRIBUTE, OUTBOX_PENDING_INDEX, WORKER_SETTING_PARAMETERS, WORKFLOW_DISPATCH_DUE_INDEX, WORKSPACE_PROJECT_INDEX, WORKSPACE_SESSION_STATE_INDEX, TEST_SERVICES_SETTING_VARIABLE, TEST_SERVICE_IMAGES_SETTING_VARIABLE, EGRESS_ADDRESSES_PARAMETER_PATTERN, EGRESS_ADDRESSES_VARIABLE, NAT_EGRESS_ADDRESSES_OUTPUT, WORKER_SANDBOX_EGRESS_DEFAULT, WORKER_SANDBOX_EGRESS_SETTING_VARIABLE, WORKER_SANDBOX_EGRESS_VALUES } from "@agentx/contracts";
import { EgressAlarms } from "./egress-alarms.js";
import { type AgentXNaming, legacyNaming } from "./naming.js";
import { ChannelAdapters } from "./channel-adapters.js";
import { CoreEngine, TEST_SERVICES_PARAMETER, TEST_SERVICE_IMAGES_PARAMETER } from "./core-engine.js";
import { CompanySecrets } from "./company-secrets.js";
import { addGithubWebhookSecret, GITHUB_WEBHOOK_ROUTE, guardGithubWebhookRoute } from "./github-webhook.js";
import { SavedEnvImages } from "./saved-env-images.js";
import { DeveloperSignIn, developerSignInParameters } from "./developer-signin.js";
import { TaskPersonProof } from "./task-person-proof.js";
import { addBrokerDeadLetterQueues, addBrokerName, addBrokerSetting, addDerivedBrokerVariable, brokerEnvironmentName, brokerNamesParameterArn } from "./broker-names.js";
import { CompanySignInSwitch } from "./company-signin.js";
import { DeveloperTaskNotifier } from "./developer-task-notifier.js";
import { SessionLifecycle } from "./session-lifecycle.js";
import { REQUALIFY_CONTEXT_KEY, REQUALIFY_DEFAULT_HOUR_UTC, RuntimeRequalify } from "./runtime-requalify.js";
import { swebenchNames } from "./swebench-eval.js";
import { COMPANY_PROJECT_REVISION_KEYS, COMPANY_SLACK_CHANNEL_BINDING_KEYS, SLACK_BINDING_READ_KEYS, SLACK_COMPANY_WORKSPACES_VARIABLE, SlackCompanyWorkspaces } from "./slack-company-workspaces.js";
import { SWEBENCH_DEPLOYMENT_MODE } from "./swebench-eval-definition.js";

const MAX_DISPATCH_ATTEMPTS = 5;
/** Days an evidence pack stored under the `evidence-record` tag value is kept before the bucket expires it. */
export const EVIDENCE_RECORD_RETENTION_DAYS = 365;

/** L4-IAMR: the one statement that lets the dispatcher read a company's stored artifacts (named environments): its Sid and the two key prefixes it names, tests/contract/dispatcher-artifacts-read.test.ts pins them. */
export const DISPATCHER_ARTIFACTS_READ_SID = "ReadCompanyArtifacts";
export const DISPATCHER_ARTIFACTS_READ_PREFIXES = ["private/*", "workspaces/*"] as const;
// Matches MAX_RECEIVE_COUNT in packages/slack-service, which reports the final attempt in the thread.
export const SLACK_MAX_RECEIVE_COUNT = 5;
// What the ingress Lambda may read of a turn record for the Details view (spec 014 FR-024):
// TURN_DETAILS_ATTRIBUTES in packages/contracts/src/slack-details.ts plus the table keys pk and sk
// (required). The byTime index keys exportPk and exportSk are not needed by this policy and carry no
// new data; they stay listed so a later projection that names them is not refused.
// A contract test keeps the two lists equal.
export const TURN_DETAILS_READ_ATTRIBUTES = [
  "pk", "sk", "exportPk", "exportSk",
  "eventId", "subject", "receivedAt", "requestedBy", "disposition", "durationMs", "model", "offeredTools", "calls",
  "callsTruncated", "emptyResponse", "usage", "usageError", "recordingErrors", "argumentsOmitted", "error", "expiresAt",
];

export interface ControlPlaneStackProps extends StackProps {
  naming?: AgentXNaming;
}

/**
 * Issue 206: the alarms in this app the health probe would not read: each must be named
 * `<prefix><suffix>` with a suffix from HEALTH_ALARM_SUFFIXES. Every stack of a named app is the
 * same environment, and alarm names are plain strings (naming.alarmName).
 */
function unlistedAlarms(scope: Construct, prefix: string, egressPrefix: string = prefix): string[] {
  const listed = new Set<string>(HEALTH_ALARM_SUFFIXES.map((suffix) => `${prefix}${suffix}`));
  return scope.node.root.node.findAll().flatMap((construct) => {
    // CloudWatch returns a composite alarm only to a DescribeAlarms grant on *, which the broker has not.
    if (construct instanceof cloudwatch.CfnCompositeAlarm) return [`the health probe cannot read composite alarm ${construct.node.path}`];
    if (!(construct instanceof cloudwatch.CfnAlarm)) return [];
    // The foundation's egress alarms keep the live names agentx-<env>-blocked-dns-spike and agentx-<env>-nat-egress-spike-<az>, which the probe's single-word suffixes
    // cannot list. They notify the alerts topic and are not on the admin health route.
    // Only those names: any other alarm inside EgressAlarms is still refused. The legacy production install's health alarms are AgentX<suffix>, but its egress alarms (when its
    // DNS firewall is switched on, agentxDnsFirewall) keep the same agentx-production-* shape, so they are matched under its resource prefix instead (egressPrefix).
    const name = construct.alarmName;
    if (name !== undefined && !Token.isUnresolved(name) && name.startsWith(egressPrefix) && construct.node.scopes.some((parent) => parent instanceof EgressAlarms)
      && (name === `${egressPrefix}blocked-dns-spike` || /^nat-egress-spike-[a-z0-9]+-az[0-9]+$/.test(name.slice(egressPrefix.length)))) return [];
    if (name !== undefined && !Token.isUnresolved(name) && listed.has(name)) return [];
    return [`the health probe does not read alarm ${construct.node.path} (${String(name)}): name it ${prefix}<suffix> and add the suffix to HEALTH_ALARM_SUFFIXES`];
  });
}

export class ControlPlaneStack extends Stack {
  constructor(scope: Construct, id: string, props?: ControlPlaneStackProps) {
    super(scope, id, props);
    const naming = props?.naming ?? legacyNaming();
    // Approved headroom fallback: 144 is the largest integer ARN estimate that keeps
    // the broker's 1,000-character reserve under 8,500 after restoring its destination grant.
    // The longest-environment resolved aggregate is pinned separately against IAM's quota.
    if (naming.env !== undefined) this.node.setContext("@aws-cdk/aws-iam.arnSizeEstimate", 144);
    const projectSetupRuntimeCatalogId = `${naming.resourcePrefix}-project-setup-runtime-v1`;
    const e2eFeatureRuntimeCatalogId = `${naming.resourcePrefix}-e2e-mock-runtime-v1`;

    const oidcIssuer = new CfnParameter(this, "OidcIssuer", { type: "String" });
    const oidcAudience = new CfnParameter(this, "OidcAudience", { type: "String" });
    const callbackSigningKey = new CfnParameter(this, "CallbackSigningKey", {
      type: "String",
      noEcho: true,
      minLength: 32,
      description: "Random secret used to scope and authenticate worker callbacks",
    });
    // The callback signing key as a secret, so no Lambda's environment holds it: the stack creates this secret from the NoEcho parameter's value (an upgrade passes the parameter's previous
    // value, so the key carries over without anyone reading or printing it). Each function gets only the secret's NAME (shorter than the key, so no environment grows) and a GetSecretValue on
    // exactly this secret's ARN. A named environment's name is under agentx/<env>/, so the operator role's secrets scope covers it, and it is not agentx/<env>/callback-signing-key, which the CLI
    // keeps as its own copy and a stack cannot take over. Retained, as the Slack secret is: `agentx destroy` removes a retained secret under agentx/<env>/ that carries the environment's tag.
    const callbackSigningKeySecretName = `agentx/${naming.env ?? "production"}/callback-key`;
    const callbackSigningKeySecret = new secretsmanager.Secret(this, "CallbackSigningKeySecret", {
      secretName: callbackSigningKeySecretName,
      description: "The callback signing key (a copy the stack made from its CallbackSigningKey parameter); Lambdas read it by name",
      secretStringValue: SecretValue.cfnParameter(callbackSigningKey),
      removalPolicy: RemovalPolicy.RETAIN,
    });
    // Who reads it: the broker, the eval tick and (named environments) the reconciler, by the secret's own resource policy, which costs no byte of the functions' role policies (the broker's has
    // no room left: tests/contract/developer-signin-infrastructure.test.ts). The dispatcher's read is an identity statement under the core switch's condition (core-engine.ts). The one
    // statement is added after the functions exist, at the end of this constructor's wiring.
    const callbackSigningKeyReaders: iam.IRole[] = [];
    const adminClaim = new CfnParameter(this, "AdminClaim", {
      type: "String",
      default: "cognito:groups",
    });
    const adminValues = new CfnParameter(this, "AdminValues", {
      type: "String",
      default: '["agentx-admin"]',
      description: "JSON string array of claim values that grant AgentX administrator access",
    });
    const githubAppCredentialRef = new CfnParameter(this, "GitHubAppCredentialRef", {
      type: "String",
      default: "github-agentx-sdlc",
    });
    // No account or installation: the broker looks up the App's installation per repository owner (#123).
    // Empty: the broker reads the id from the private-key secret's appId. agentx init deploys the
    // control plane before it creates the GitHub App, so it has no id to pass yet.
    const githubAppId = new CfnParameter(this, "GitHubAppId", {
      type: "String",
      default: "",
      description: "GitHub App id; empty reads it from the private-key secret's appId",
    });
    const githubAppPrivateKeySecretArn = new CfnParameter(this, "GitHubAppPrivateKeySecretArn", {
      type: "String",
      description: "Complete Secrets Manager ARN containing the GitHub App private key PEM",
    });
    // Spec 025 phase 25a: declared on the stack itself so the names are exact. The legacy deployment (production) has
    // the developer task settings too, so it runs tasks as named environments do.
    const signInParameters = developerSignInParameters(this, { tasks: true });
    const taskPersonProofEnabled = naming.env === "agentxlivetest123" ? new CfnParameter(this, "TaskPersonProofEnabled", {
      type: "String",
      default: "false",
      allowedValues: ["true", "false"],
      description: "Install the dedicated task person proof workload in the approved named TEST environment",
    }) : undefined;

    const state = new dynamodb.Table(this, "State", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      // Retained: workspace and operation records must outlive a stack deletion.
      removalPolicy: RemovalPolicy.RETAIN,
      // Spec 025 A6 (Q5, owner answer 2026-09-30): failure and usage index items expire by TTL in
      // named environments. Adding a TTL to an existing table is an in-place update. 25c note 2: the
      // sharing items, NOTICE and CHANNEL_OPERATION, expire on it too; they exist only in named
      // environments (D14). No other State item carries indexExpiresAt (a test pins the files that
      // name it). The legacy table stays as it is.
      ...(naming.env === undefined ? {} : { timeToLiveAttribute: INDEX_EXPIRY_ATTRIBUTE }),
    });

    const artifacts = new s3.Bucket(this, "Artifacts", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // M1.3 Task 3.7b, owner decision D4: a browser or API round's screenshots expire 30 days after they are written. A lifecycle filter matches the start of a key, and a screenshot's
      // key starts like every other private object's, so the rule matches the tag the broker puts on a screenshot and on nothing else. The bucket is not versioned: expiry deletes.
      // Named environments only: the legacy production template stays as it is.
      ...(naming.env === undefined ? {} : { lifecycleRules: [
        { id: "ExpireE2EScreenshots", expiration: Duration.days(E2E_ARTIFACT_RETENTION_DAYS), tagFilters: { [E2E_ARTIFACT_RETENTION_TAG_KEY]: E2E_ARTIFACT_RETENTION_TAG_VALUE } },
        // Stored evidence expires by class, on the same tag key: evidence-short is video and trace (14 days), evidence-std is screenshots, API samples, output tails and the stored pack
        // (30 days). The days are the live rules' exactly and are not configurable here: S3 applies a lifecycle rule to objects already stored, so a shorter rule would delete older
        // evidence. Prefix AND tag (S3 reads that as an `And` filter): an object outside the private evidence keys that happens to carry the tag never matches.
        ...(["evidence-short", "evidence-std"] as const).map((retentionClass) => ({ id: retentionClass === "evidence-short" ? "ExpireEvidenceShort" : "ExpireEvidenceStd",
          expiration: Duration.days(EVIDENCE_RETENTION_DAYS[retentionClass].default), prefix: "private/", tagFilters: { [E2E_ARTIFACT_RETENTION_TAG_KEY]: retentionClass } })),
        // A pack an earlier release stored with its own tag value, `evidence-record`, is kept for a year, then expires (a constant). Nothing in this bucket outside
        // these tagged evidence objects and the nightly maps expires (DEC 222: the cost ledger, approvals and decisions are kept forever, and none of them is stored here).
        { id: "ExpireEvidenceRecord", expiration: Duration.days(EVIDENCE_RECORD_RETENTION_DAYS), prefix: "private/", tagFilters: { [E2E_ARTIFACT_RETENTION_TAG_KEY]: "evidence-record" } },
        // The nightly run's coverage maps (`nightly-maps/<company>/<project>/<digest>.json`, NIGHTLY_MAPS_PREFIX) expire after 30 days; selection reads a map no older than 7 days.
        { id: "ExpireNightlyMaps", prefix: "nightly-maps/", expiration: Duration.days(30) },
      ] }),
      // Retained: the broker's operation artifacts must outlive a stack deletion.
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const deadLetterQueue = new sqs.Queue(this, "DispatchDeadLetterQueue", {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      retentionPeriod: Duration.days(14),
    });
    const dispatchQueue = new sqs.Queue(this, "DispatchQueue", {
      deadLetterQueue: { queue: deadLetterQueue, maxReceiveCount: MAX_DISPATCH_ATTEMPTS },
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      visibilityTimeout: Duration.minutes(2),
    });

    // ENV-ROOM (infra/lib/broker-names.ts): the broker gets its generated names packed (AGENTX_NAMES) and derives what the environment's name decides. #1149: the legacy
    // install (production) too, under "production", deriving only the values identical to its own (contracts LEGACY_INSTALL_LAYOUT).
    // ENV-ROOM 2: the entry reads the broker's names from their SSM parameter before it loads broker.ts (packages/broker/src/aws/broker-handler.ts).
    const broker = packagedFunction(this, "Broker", "packages/broker/src/aws/broker-handler.ts", {
      OIDC_ISSUER: oidcIssuer.valueAsString,
      ADMIN_CLAIM: adminClaim.valueAsString,
      ADMIN_VALUES: adminValues.valueAsString,
      CALLBACK_SIGNING_KEY_SECRET_ID: callbackSigningKeySecretName,
      GITHUB_APP_CREDENTIAL_REF: githubAppCredentialRef.valueAsString,
      GITHUB_APP_ID: githubAppId.valueAsString,
      GITHUB_APP_PRIVATE_KEY_SECRET_ARN: githubAppPrivateKeySecretArn.valueAsString,
    }, Duration.seconds(CORE_BROKER_TIMEOUT_SECONDS));
    // Named environments: the broker's role and function keep the fixed names a named environment has always had (agentx-<env>-broker-role, agentx-<env>-broker), so an
    // install already running under them updates them in place instead of replacing them, and operator tools and other stacks that name them keep working. A resource with a
    // fixed name cannot be replaced by CloudFormation: a later change that needs a new role or function must change the name in the same release. The legacy template is unchanged.
    if (naming.env !== undefined) {
      (broker.role!.node.defaultChild as iam.CfnRole).roleName = brokerRoleName(naming);
      (broker.node.defaultChild as lambda.CfnFunction).functionName = brokerFunctionName(naming);
    }
    addBrokerName(broker, naming, "stateTable", state.tableName, state.tableName);
    addBrokerName(broker, naming, "artifactBucket", artifacts.bucketName, artifacts.bucketName);
    addDerivedBrokerVariable(broker, naming, "AGENTX_PROJECT_SETUP_RUNTIME_CATALOG_ID", projectSetupRuntimeCatalogId);
    addDerivedBrokerVariable(broker, naming, "AGENTX_E2E_FEATURE_RUNTIME_CATALOG_ID", e2eFeatureRuntimeCatalogId);
    // Webhook lane W3: the dedicated GitHub webhook secret slot, readable by the broker's role alone (infra/lib/github-webhook.ts).
    addGithubWebhookSecret(this, { naming, broker });
    const connectorSecretsArn = this.formatArn({ service: "secretsmanager", resource: "secret", resourceName: `${naming.connectorSecretPrefix}*`, arnFormat: ArnFormat.COLON_RESOURCE_NAME });
    if (naming.env !== undefined) {
      // The two grantReadWriteData statements' action/resource cross product, less dynamodb:GetRecords and dynamodb:GetShardIterator (ENV-ROOM 2, IAM room for the names
      // parameter): those act only on a stream ARN (`table/<name>/stream/<label>`), which neither resource here is, so on these resources they granted nothing.
      broker.addToRolePolicy(new iam.PolicyStatement({
        actions: ["dynamodb:BatchGetItem", "dynamodb:Query", "dynamodb:GetItem", "dynamodb:Scan", "dynamodb:ConditionCheckItem", "dynamodb:BatchWriteItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:DescribeTable"],
        resources: [state.tableArn, `${state.tableArn}/index/*`],
      }));
      // Keep the existing grantReadWrite action strings and both resources verbatim.
      artifacts.addToResourcePolicy(new iam.PolicyStatement({
        principals: [new iam.ArnPrincipal(broker.role!.roleArn)],
        actions: ["s3:GetObject*", "s3:GetBucket*", "s3:List*", "s3:DeleteObject*", "s3:PutObject", "s3:PutObjectLegalHold", "s3:PutObjectRetention", "s3:PutObjectTagging", "s3:PutObjectVersionTagging", "s3:Abort*"],
        resources: [artifacts.bucketArn, artifacts.arnForObjects("*")],
      }));
      broker.addToRolePolicy(new iam.PolicyStatement({ actions: ["secretsmanager:GetSecretValue"], resources: [githubAppPrivateKeySecretArn.valueAsString, connectorSecretsArn] }));
    } else {
      state.grantReadWriteData(broker);
      artifacts.grantReadWrite(broker);
      broker.addToRolePolicy(new iam.PolicyStatement({ actions: ["secretsmanager:GetSecretValue"], resources: [githubAppPrivateKeySecretArn.valueAsString] }));
      broker.addToRolePolicy(new iam.PolicyStatement({ actions: ["secretsmanager:GetSecretValue"], resources: [connectorSecretsArn] }));
    }
    callbackSigningKeyReaders.push(broker.role!);
    // A rotated OAuth refresh token is written back to its own secret. Only secrets that
    // `agentx admin credential authorize` tagged for it are writable, never other connector secrets.
    broker.addToRolePolicy(new iam.PolicyStatement({
      actions: ["secretsmanager:PutSecretValue"],
      resources: [this.formatArn({ service: "secretsmanager", resource: "secret", resourceName: `${naming.connectorSecretPrefix}*`, arnFormat: ArnFormat.COLON_RESOURCE_NAME })],
      conditions: { StringEquals: { "secretsmanager:ResourceTag/agentx-writable": "refresh-token" } },
    }));
    broker.addToRolePolicy(new iam.PolicyStatement({
      actions: ["codebuild:StartBuild", "codebuild:BatchGetBuilds"],
      resources: [this.formatArn({ service: "codebuild", resource: "project", resourceName: "agentx-*" })],
    }));
    if (naming.env !== undefined) addDerivedBrokerVariable(broker, naming, "CONNECTOR_SECRET_PREFIX", naming.connectorSecretPrefix);
    // Spec 043: SWE-bench runs. The broker reads the optional eval stack's settings, the runner image
    // and the worker model per request, and starts the eval state machine by its fixed name; both
    // exist only once the eval stack is deployed, and until then a run is refused as not installed.
    addDerivedBrokerVariable(broker, naming, "SWEBENCH_SETTINGS_PREFIX", naming.ec2.workerSettingsPrefix);
    // M1.4 Task 4.10 (PREFIXGAP): the broker derives the AI navigation route from the installation's worker settings only when it knows where they are. Nothing ever set this, so setup
    // approval said "AI navigation steps will not run" and dispatch offered none. Named environments only: the legacy production template stays as it is. The read grant below covers it.
    if (naming.env !== undefined) addDerivedBrokerVariable(broker, naming, "AGENTX_E2E_AGENT_SETTINGS_PREFIX", naming.ec2.workerSettingsPrefix);
    const swebenchParameterArns = [
      swebenchNames(naming).settingsParameterName,
      swebenchNames(naming).runnerImageParameterName,
      swebenchNames(naming).runnerFeaturesParameterName,
      ...Object.values(WORKER_SETTING_PARAMETERS).map((name) => `${naming.ec2.workerSettingsPrefix}${name}`),
    ].map((name) => `arn:${Aws.PARTITION}:ssm:${Aws.REGION}:${Aws.ACCOUNT_ID}:parameter${name}`);
    // The eval batch tick reads the SWE-bench settings and the worker settings the deployment reads for an eval run, but never the AI navigation model setting (Task 4.10A review M-2) or the missing-key fallback model (Task 4.10D): it boots no worker and runs no model of its own.
    const evalSettingArns = [
      swebenchNames(naming).settingsParameterName,
      swebenchNames(naming).runnerImageParameterName,
      swebenchNames(naming).runnerFeaturesParameterName,
      ...Object.entries(WORKER_SETTING_PARAMETERS).filter(([key]) => key !== "e2eAgentModel" && key !== "modelFallback").map(([, name]) => `${naming.ec2.workerSettingsPrefix}${name}`),
    ].map((name) => `arn:${Aws.PARTITION}:ssm:${Aws.REGION}:${Aws.ACCOUNT_ID}:parameter${name}`);
    const swebenchStateMachineArn = this.formatArn({ service: "states", resource: "stateMachine", resourceName: swebenchNames(naming).stateMachineName, arnFormat: ArnFormat.COLON_RESOURCE_NAME });
    // ENV-ROOM 2: a named broker reads its names from their one SSM parameter (infra/lib/broker-names.ts) with this same action, so the parameter's ARN joins this statement
    // rather than adding one (the broker's inline policy has little room: tests/contract/developer-signin-infrastructure.test.ts, broker IAM headroom).
    // #1149: the legacy install's broker reads its names parameter too (under "production").
    broker.addToRolePolicy(new iam.PolicyStatement({ actions: ["ssm:GetParameters"], resources: [...swebenchParameterArns, brokerNamesParameterArn(brokerEnvironmentName(naming))] }));
    // Named: the broker's two StartExecution grants (this and the session deleter's, sessions.connectBroker) are one statement, for the same room. Legacy: as before.
    if (naming.env === undefined) broker.addToRolePolicy(new iam.PolicyStatement({ actions: ["states:StartExecution"], resources: [swebenchStateMachineArn] }));

    // Spec 061: a stored plan's cited code is read from GitHub in the background, with retries, so a slow or failing
    // GitHub never holds up the plan. The broker starts the job right after the plan commits (an async invoke), and
    // its recovery sweep starts any row that is due; the job needs nothing from the broker. 150 seconds: the code is
    // read inside 120, and the rest is for attaching the bundle and cleaning up. 1,024 MB: files are read in memory.
    // Developer tasks, and so their plans, exist only in named environments; the legacy templates gain nothing.
    let planEvidenceFunction: lambda.Function | undefined;
    if (naming.env !== undefined) {
      const planEvidence = packagedFunction(this, "PlanEvidence", "packages/broker/src/aws/plan-evidence-handler.ts", {
        STATE_TABLE_NAME: state.tableName,
        ARTIFACT_BUCKET_NAME: artifacts.bucketName,
        GITHUB_APP_CREDENTIAL_REF: githubAppCredentialRef.valueAsString,
        GITHUB_APP_ID: githubAppId.valueAsString,
        GITHUB_APP_PRIVATE_KEY_SECRET_ARN: githubAppPrivateKeySecretArn.valueAsString,
      }, Duration.seconds(150), [], 1024);
      // The State table, one action at a time, each on the partitions it needs (the sort key cannot be narrowed here):
      // reads of the task record, its evidence pointer, the job rows and the project revision the task started from; the
      // pointer is written with PutItem (DEVTASK#, put once, never the task record's workflow); the job row is claimed and
      // rescheduled with UpdateItem and removed with DeleteItem. No Query: the sweep runs in the broker.
      planEvidence.addToRolePolicy(new iam.PolicyStatement({
        sid: "ReadTaskJobAndProject",
        actions: ["dynamodb:GetItem"],
        resources: [state.tableArn],
        conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DEVTASK#*", "PLAN_EVIDENCE", "PROJECT#*"] } },
      }));
      planEvidence.addToRolePolicy(new iam.PolicyStatement({
        sid: "PutEvidencePointer",
        actions: ["dynamodb:PutItem"],
        resources: [state.tableArn],
        conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DEVTASK#*"] } },
      }));
      planEvidence.addToRolePolicy(new iam.PolicyStatement({
        sid: "ClaimAndCloseJobRow",
        actions: ["dynamodb:UpdateItem", "dynamodb:DeleteItem"],
        resources: [state.tableArn],
        conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["PLAN_EVIDENCE"] } },
      }));
      // The plan is read back from its own folder, and the bundle is written only beside it.
      planEvidence.addToRolePolicy(new iam.PolicyStatement({ sid: "ReadPlanDocuments", actions: ["s3:GetObject"], resources: [artifacts.arnForObjects("private/*")] }));
      planEvidence.addToRolePolicy(new iam.PolicyStatement({ sid: "WriteEvidenceBundles", actions: ["s3:PutObject"], resources: [artifacts.arnForObjects("private/*/plan-documents/*.evidence.*.json")] }));
      // The GitHub App's key, to read files as the broker does.
      planEvidence.addToRolePolicy(new iam.PolicyStatement({ sid: "GitHubAppKey", actions: ["secretsmanager:GetSecretValue"], resources: [githubAppPrivateKeySecretArn.valueAsString] }));
      // Named only (this block): the broker's invoke of this function and of the sign-in function are one statement, added with the sign-in function below (ENV-ROOM 2 room).
      planEvidenceFunction = planEvidence;
      addBrokerName(broker, naming, "planEvidenceFunction", planEvidence.functionName, planEvidence.functionName);
    }

    const outboxPublisher = packagedFunction(
      this,
      "OutboxPublisher",
      "packages/broker/src/aws/outbox-publisher.ts",
      {
        STATE_TABLE_NAME: state.tableName,
        DISPATCH_QUEUE_URL: dispatchQueue.queueUrl,
      },
    );
    state.grantStreamRead(outboxPublisher);
    state.grantReadWriteData(outboxPublisher);
    dispatchQueue.grantSendMessages(outboxPublisher);
    // The State table's stream has two readers: this outbox publisher and, in named environments,
    // the DeveloperTaskNotifier (developer-task-notifier.ts). That is the per-shard maximum AWS
    // recommends: later phases (such as 25e's Slack Confirm DMs) add filters to an existing
    // trigger, never a third reader.
    new lambda.EventSourceMapping(this, "OutboxStreamMapping", {
      // Keep the legacy activity-index reader, excluding core company rows (no extra reader).
      // #1148: the legacy install too, now that it has the core engine.
      filters: [lambda.FilterCriteria.filter({ dynamodb: { NewImage: { pk: { S: [{ "anything-but": { prefix: "ORG#" } }] } } } })],
      target: outboxPublisher,
      eventSourceArn: state.tableStreamArn!,
      startingPosition: lambda.StartingPosition.LATEST,
      batchSize: 100,
      retryAttempts: 3,
      bisectBatchOnError: true,
    });

    const dispatcher = packagedFunction(
      this,
      "Dispatcher",
      "packages/broker/src/aws/dispatcher.ts",
      {
        STATE_TABLE_NAME: state.tableName,
        AGENTX_PROJECT_SETUP_RUNTIME_CATALOG_ID: projectSetupRuntimeCatalogId,
        MAX_DISPATCH_ATTEMPTS: String(MAX_DISPATCH_ATTEMPTS),
        ARTIFACT_BUCKET_NAME: artifacts.bucketName,
      },
      Duration.seconds(CORE_DISPATCHER_TIMEOUT_SECONDS),
    );
    dispatchQueue.grantConsumeMessages(dispatcher);
    state.grantReadWriteData(dispatcher);
    // The dispatcher holds a CHECKS reference's kind to the admission it names; it reads only the immutable admission objects.
    dispatcher.addToRolePolicy(new iam.PolicyStatement({ actions: ["s3:GetObject"], resources: [artifacts.arnForObjects("workflow-e2e-admissions/*")] }));
    // L4-IAMR (owner decision 2026-11-18, DEC 254zzz26), named environments only (the core engine's): the dispatcher's company-bound artifact reader (createCompanyArtifactReader, for the
    // second eval pass and the like) reads a company's stored artifacts. Read only: GetObject on the two prefixes the reader's keys live under, no List, no Put, no other prefix, no other
    // bucket. The bucket is S3-managed encrypted (no KMS key), so no kms grant. Every read is still checked in code against company, workspace owner and the ARTIFACT row.
    // #1148: the legacy install (production) too, with the core engine.
    {
      dispatcher.addToRolePolicy(new iam.PolicyStatement({ sid: DISPATCHER_ARTIFACTS_READ_SID, actions: ["s3:GetObject"], resources: DISPATCHER_ARTIFACTS_READ_PREFIXES.map((prefix) => artifacts.arnForObjects(prefix)) }));
    }
    // EC2 workers (#76): the idle reaper and reconciler find sessions by state through this sparse index.
    state.addGlobalSecondaryIndex({
      indexName: WORKSPACE_SESSION_STATE_INDEX.name,
      partitionKey: { name: WORKSPACE_SESSION_STATE_INDEX.partitionKey, type: dynamodb.AttributeType.STRING },
      sortKey: { name: WORKSPACE_SESSION_STATE_INDEX.sortKey, type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    // Spec 041: GET /v1/dev/workspaces lists a project's workspaces through this sparse index.
    // Only workspace META items carry `workspaceProject`, so nothing else is indexed.
    state.addGlobalSecondaryIndex({
      indexName: WORKSPACE_PROJECT_INDEX.name,
      partitionKey: { name: WORKSPACE_PROJECT_INDEX.partitionKey, type: dynamodb.AttributeType.STRING },
      sortKey: { name: WORKSPACE_PROJECT_INDEX.sortKey, type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    // Sparse due-time index: only received, retryable, or leased GitHub deliveries carry these keys.
    state.addGlobalSecondaryIndex({
      indexName: "github-webhook-recovery",
      partitionKey: { name: "webhookRecoveryPk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "webhookRecoverySk", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    // Lane E2 step 4: the core's outbox relay reads its pending messages through this sparse index (only a core outbox row carries `outboxState`). #1148: the legacy install too
    // (an in-place index add on its State table; empty until the core writes an outbox row).
    {
      if (OUTBOX_PENDING_INDEX.sortAttribute === undefined) throw new Error("the outbox pending index has a sort key");
      state.addGlobalSecondaryIndex({
        indexName: OUTBOX_PENDING_INDEX.name,
        partitionKey: { name: OUTBOX_PENDING_INDEX.partitionAttribute, type: dynamodb.AttributeType.STRING },
        sortKey: { name: OUTBOX_PENDING_INDEX.sortAttribute, type: dynamodb.AttributeType.STRING },
        projectionType: dynamodb.ProjectionType.ALL,
      });
    }
    // Gap 6: sparse due-time index over workflow dispatch rows, so the recovery sweep reads due rows first.
    state.addGlobalSecondaryIndex({
      indexName: WORKFLOW_DISPATCH_DUE_INDEX.name,
      partitionKey: { name: WORKFLOW_DISPATCH_DUE_INDEX.partitionKey, type: dynamodb.AttributeType.STRING },
      sortKey: { name: WORKFLOW_DISPATCH_DUE_INDEX.sortKey, type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    // The dispatcher signs each invocation to an EC2 worker; workers verify with the public key
    // alone (#80). Only the dispatcher may sign: the key policy denies kms:Sign to every other
    // principal, whatever its IAM policy grants.
    const invokeSigningKey = new kms.Key(this, "InvokeSigningKey", {
      alias: naming.ec2.invokeSigningKeyAlias,
      description: `Signs AgentX ${naming.environmentTagValue} invocations to EC2 workers`,
      keySpec: kms.KeySpec.ECC_NIST_P256,
      keyUsage: kms.KeyUsage.SIGN_VERIFY,
      pendingWindow: Duration.days(7),
      // Tokens live 60 seconds and workers get the public key at boot, so nothing outlives the key.
      removalPolicy: RemovalPolicy.DESTROY,
    });
    invokeSigningKey.grant(dispatcher, "kms:Sign");
    invokeSigningKey.addToResourcePolicy(new iam.PolicyStatement({
      sid: "SignOnlyAsDispatcher",
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ["kms:Sign"],
      resources: ["*"],
      conditions: { ArnNotEquals: { "aws:PrincipalArn": dispatcher.role!.roleArn } },
    }));
    new CfnOutput(this, "InvokeSigningKeyArn", { value: invokeSigningKey.keyArn });

    new lambda.EventSourceMapping(this, "DispatchQueueMapping", {
      target: dispatcher,
      eventSourceArn: dispatchQueue.queueArn,
      batchSize: 1,
      reportBatchItemFailures: true,
    });

    const memberWorkspaceLimit = new CfnParameter(this, "SlackMemberWorkspaceLimit", {
      type: "Number",
      default: 3,
      minValue: 1,
      description: "Maximum Slack thread workspaces one channel member may start",
    });
    const organizationWorkspaceLimit = new CfnParameter(this, "SlackOrganizationWorkspaceLimit", {
      type: "Number",
      default: 20,
      minValue: 1,
      description: "Maximum Slack thread workspaces for the whole Slack organization",
    });
    // Operators store the real values with put-secret-value; the generated placeholder rejects every request until then.
    const slackSecret = new secretsmanager.Secret(this, "SlackSecret", {
      // Under environment naming, a fixed name under agentx/<env>/ so the operator role's secrets
      // scope covers it. The legacy deployment keeps its generated name.
      ...(naming.env === undefined ? {} : { secretName: `agentx/${naming.env}/slack` }),
      description: "AgentX Slack app credentials as JSON: {\"signingSecret\":\"...\",\"botToken\":\"xoxb-...\"}",
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ botToken: "unset" }),
        generateStringKey: "signingSecret",
        excludePunctuation: true,
      },
      // Retained: the Slack app credentials must outlive a stack deletion.
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const slackThreads = new dynamodb.Table(this, "SlackThreads", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      timeToLiveAttribute: "expiresAt",
      // Retained: Slack thread state must outlive a stack deletion.
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const slackDeadLetterQueue = new sqs.Queue(this, "SlackRequestDeadLetterQueue", {
      fifo: true,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      retentionPeriod: Duration.days(14),
    });
    const slackRequestQueue = new sqs.Queue(this, "SlackRequestQueue", {
      fifo: true,
      contentBasedDeduplication: false,
      deadLetterQueue: { queue: slackDeadLetterQueue, maxReceiveCount: SLACK_MAX_RECEIVE_COUNT },
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      visibilityTimeout: Duration.minutes(15),
      retentionPeriod: Duration.days(4),
    });
    const threadSessions = new s3.Bucket(this, "SlackThreadSessions", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      lifecycleRules: [{ noncurrentVersionExpiration: Duration.days(30) }],
      // Retained: Pi thread sessions must outlive a stack deletion.
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const slackOrchestratorRole = new iam.Role(this, "SlackOrchestratorTaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com", {
        conditions: { StringEquals: { "aws:SourceAccount": this.account } },
      }),
      description: "Hosted AgentX Slack orchestrator; the only principal allowed on /v1/service routes",
    });
    slackRequestQueue.grantConsumeMessages(slackOrchestratorRole);
    // Spec 061 slice 2: "Ask AgentX to reply to this comment" on the task page queues the comment for the Slack service (send only).
    if (naming.env !== undefined) {
      slackRequestQueue.addToResourcePolicy(new iam.PolicyStatement({
        principals: [new iam.ArnPrincipal(broker.role!.roleArn)],
        actions: ["sqs:SendMessage", "sqs:GetQueueAttributes", "sqs:GetQueueUrl"],
        resources: [slackRequestQueue.queueArn],
      }));
    } else slackRequestQueue.grantSendMessages(broker);
    addBrokerName(broker, naming, "slackRequestQueue", slackRequestQueue.queueName, slackRequestQueue.queueUrl);
    slackThreads.grantReadWriteData(slackOrchestratorRole);
    threadSessions.grantReadWrite(slackOrchestratorRole);
    slackSecret.grantRead(slackOrchestratorRole);
    slackOrchestratorRole.addToPolicy(new iam.PolicyStatement({
      actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
      resources: [
        `arn:${this.partition}:bedrock:*::foundation-model/*`,
        `arn:${this.partition}:bedrock:${this.region}:${this.account}:inference-profile/*`,
      ],
    }));
    // One record per Slack event, kept 30 days for diagnosis and evaluation cases (feature 013 FR-025).
    // The broker reads it for the admin export. The ingress Lambda reads one record's non-text fields
    // for the Details view (spec 014), granted below. Nothing else can read it.
    const turnRecords = new dynamodb.Table(this, "TurnRecords", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      timeToLiveAttribute: "expiresAt",
      // Retained: turn records are audit data that must outlive a stack deletion.
      removalPolicy: RemovalPolicy.RETAIN,
    });
    turnRecords.addGlobalSecondaryIndex({
      indexName: "byTime",
      partitionKey: { name: "exportPk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "exportSk", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    // The service writes each record once with a condition and never reads the table back.
    slackOrchestratorRole.addToPolicy(new iam.PolicyStatement({
      actions: ["dynamodb:PutItem"],
      resources: [turnRecords.tableArn],
    }));
    // The admin export pages the time index newest first; the broker needs nothing else on this table.
    broker.addToRolePolicy(new iam.PolicyStatement({
      actions: ["dynamodb:Query"],
      resources: [turnRecords.tableArn, `${turnRecords.tableArn}/index/byTime`],
    }));
    addBrokerName(broker, naming, "turnRecordsTable", turnRecords.tableName, turnRecords.tableName);

    // No subscription by default: the deployer subscribes an email address or connects AWS Chatbot.
    const operatorAlerts = new sns.Topic(this, "OperatorAlerts", {
      topicName: naming.alertsTopicName,
      displayName: "AgentX operator alerts",
      enforceSSL: true,
    });
    // enforceSSL leaves only a Deny in the topic policy, which replaces SNS's default same-account
    // Allow, so the alarms need their own grant to publish.
    operatorAlerts.addToResourcePolicy(new iam.PolicyStatement({
      principals: [new iam.ServicePrincipal("cloudwatch.amazonaws.com")],
      actions: ["sns:Publish"],
      resources: [operatorAlerts.topicArn],
      conditions: {
        StringEquals: { "aws:SourceAccount": this.account },
        ArnLike: { "aws:SourceArn": `arn:${this.partition}:cloudwatch:${this.region}:${this.account}:alarm:*` },
      },
    }));
    // FR-047, environment naming only. AWS Budgets publishes the budget's notifications to the
    // same topic, so the topic policy must allow it (enforceSSL left only a Deny).
    if (naming.env !== undefined) {
      const budgetsTopicPublish = operatorAlerts.addToResourcePolicy(new iam.PolicyStatement({
        principals: [new iam.ServicePrincipal("budgets.amazonaws.com")],
        actions: ["sns:Publish"],
        resources: [operatorAlerts.topicArn],
        conditions: {
          StringEquals: { "aws:SourceAccount": this.account },
          ArnLike: { "aws:SourceArn": `arn:${this.partition}:budgets::${this.account}:*` },
        },
      }));
      const monthlyUsd = new CfnParameter(this, "BudgetMonthlyUsd", {
        type: "String", default: "0", allowedPattern: "^(0|[1-9][0-9]{0,6})$",
        description: "The environment's monthly AWS budget in US dollars; 0 means no budget",
      });
      const scope = new CfnParameter(this, "BudgetScope", {
        type: "String", default: "tag", allowedValues: ["tag", "account"],
        description: "tag: costs tagged agentx:env for this environment (the tag must be activated in Billing); account: the whole account",
      });
      const hasBudget = new CfnCondition(this, "HasBudget", { expression: Fn.conditionNot(Fn.conditionEquals(monthlyUsd.valueAsString, "0")) });
      const byTag = new CfnCondition(this, "BudgetByTag", { expression: Fn.conditionEquals(scope.valueAsString, "tag") });
      const notify = (type: "ACTUAL" | "FORECASTED", threshold: number) => ({
        notification: { notificationType: type, comparisonOperator: "GREATER_THAN", threshold, thresholdType: "PERCENTAGE" },
        subscribers: [{ subscriptionType: "SNS", address: operatorAlerts.topicArn }],
      });
      const budget = new budgets.CfnBudget(this, "MonthlyBudget", {
        budget: {
          budgetName: naming.alarmName("monthly"),
          budgetType: "COST",
          timeUnit: "MONTHLY",
          // CloudFormation passes the parameter's string; the Budgets resource accepts it as its number.
          budgetLimit: { amount: Token.asNumber(monthlyUsd.valueAsString), unit: "USD" },
          costFilters: Fn.conditionIf(byTag.logicalId, { TagKeyValue: [`user:agentx:env$${naming.env}`] }, Aws.NO_VALUE),
        },
        notificationsWithSubscribers: [notify("ACTUAL", 80), notify("FORECASTED", 100)],
        // C5 / FR-047: every resource the installer creates carries agentx:env. AWS::Budgets::Budget
        // takes tags through ResourceTags rather than the stack's Tags.of(app), so it is set here
        // explicitly; Tags.of(app) does not reach this resource.
        resourceTags: [{ key: "agentx:env", value: naming.env }],
      });
      budget.cfnOptions.condition = hasBudget;
      // AWS Budgets creates the notification's SNS subscriber as part of creating the budget, so the
      // topic policy above must already allow budgets.amazonaws.com to publish before that happens;
      // otherwise the subscription confirmation publish could race ahead of the policy statement.
      if (budgetsTopicPublish.policyDependable !== undefined) budget.node.addDependency(budgetsTopicPublish.policyDependable);
    }
    const notifyOperator = new cloudwatchActions.SnsAction(operatorAlerts);
    // The broker publishes these in embedded metric format with a dimensionless series as well as a
    // per-connector one; the alarms read the dimensionless series, so they cover every connector.
    const agentxSum = (metricName: string, period: Duration) =>
      new cloudwatch.Metric({ namespace: naming.metricsNamespace, metricName, statistic: "Sum", period });
    if (naming.env !== undefined) addDerivedBrokerVariable(broker, naming, "AGENTX_METRICS_NAMESPACE", naming.metricsNamespace);
    new cloudwatch.Alarm(this, "ConnectorBrokenAlarm", {
      alarmName: naming.alarmName("ConnectorBroken"),
      alarmDescription: "A connector's discovery failed or a vendor changed an approved tool's schema. Check the broker logs for connector metrics and connector.* events.",
      metric: new cloudwatch.MathExpression({
        expression: "FILL(discovery, 0) + FILL(drift, 0)",
        usingMetrics: {
          discovery: agentxSum("ConnectorDiscoveryFailed", Duration.minutes(5)),
          drift: agentxSum("ConnectorSchemaDrift", Duration.minutes(5)),
        },
        period: Duration.minutes(5),
        label: "Connector discovery failures and schema drift",
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(notifyOperator);
    new cloudwatch.Alarm(this, "ConnectorNotConnectedAlarm", {
      alarmName: naming.alarmName("ConnectorNotConnected"),
      alarmDescription: "A connector's vendor credential is missing, revoked or rejected. Check the broker logs for the connector, then reconnect it with agentx connectors.",
      metric: agentxSum("ConnectorNotConnected", Duration.minutes(5)),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(notifyOperator);
    new cloudwatch.Alarm(this, "EmptyResponsesAlarm", {
      alarmName: naming.alarmName("EmptyResponses"),
      alarmDescription: "More than three orchestrator turns in an hour ended without text. Export recent turns with agentx admin turns export.",
      metric: agentxSum("TurnEmptyResponse", Duration.hours(1)),
      threshold: 3,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(notifyOperator);
    new cloudwatch.Alarm(this, "RecordingFailuresAlarm", {
      alarmName: naming.alarmName("RecordingFailures"),
      alarmDescription: "Turn records or turn metrics are being lost: a turn record write failed or the Slack service could not emit turn metrics. Check the Slack orchestrator logs for turn_record.write_failed and turn_metrics.emit_failed. A write that timed out may still have landed, so check the table before assuming the record is lost.",
      metric: new cloudwatch.MathExpression({
        expression: "FILL(write,0) + FILL(emit,0)",
        usingMetrics: {
          write: agentxSum("TurnRecordWriteFailed", Duration.minutes(5)),
          emit: agentxSum("TurnMetricsEmitFailed", Duration.minutes(5)),
        },
        period: Duration.minutes(5),
        label: "Turn record write and turn metric emit failures",
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(notifyOperator);
    // A request that fails its final attempt without reaching the processor's own reporting lands here
    // with no turn record and no other signal.
    new cloudwatch.Alarm(this, "SlackDeadLettersAlarm", {
      alarmName: naming.alarmName("SlackDeadLetters"),
      alarmDescription: "A Slack request exhausted its receives and is in the Slack request dead-letter queue. Check the Slack orchestrator logs for its event ID.",
      metric: slackDeadLetterQueue.metricApproximateNumberOfMessagesVisible({
        statistic: "Maximum",
        period: Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(notifyOperator);
    // Issue #46: a dispatch job that exhausts its receives lands here and nothing else reports it.
    // #1131: every deployment, production (the legacy template) included.
    {
      new cloudwatch.Alarm(this, "DispatchDeadLettersAlarm", {
        alarmName: naming.alarmName("DispatchDeadLetters"),
        alarmDescription: "A worker dispatch job exhausted its receives and is in the dispatch dead-letter queue. Check the dispatcher logs for its operation ID, then redrive or purge the queue.",
        metric: deadLetterQueue.metricApproximateNumberOfMessagesVisible({
          statistic: "Maximum",
          period: Duration.minutes(5),
        }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(notifyOperator);
    }

    addBrokerName(broker, naming, "slackOrchestratorRole", slackOrchestratorRole.roleName, slackOrchestratorRole.roleArn);
    addBrokerSetting(broker, naming, "memberWorkspaceLimit", memberWorkspaceLimit.valueAsString);
    addBrokerSetting(broker, naming, "organizationWorkspaceLimit", organizationWorkspaceLimit.valueAsString);

    const appPostedMessages = new CfnParameter(this, "SlackAppPostedMessages", {
      type: "String",
      default: "accept",
      allowedValues: ["accept", "ignore"],
      description: "accept: answer mentions a person posts through another app with their own Slack token; ignore: answer only typed mentions",
    });
    const threadTurnsPerMinute = new CfnParameter(this, "SlackThreadTurnsPerMinute", {
      // A CloudFormation Number parameter accepts decimals (e.g. "6.5") within its min/max, which the
      // Lambda's own whole-number check then refuses at cold start, taking all Slack ingress down
      // with no alarm. A String with this pattern refuses that value at deploy time instead.
      type: "String",
      default: "6",
      allowedPattern: "^([1-9]|[1-5][0-9]|60)$",
      constraintDescription: "must be a whole number from 1 to 60",
      description: "Most requests one Slack thread may start in a minute; further requests pause the thread with one notice",
    });
    const slackIngress = packagedFunction(
      this,
      "SlackIngress",
      "packages/broker/src/aws/slack-ingress.ts",
      {
        STATE_TABLE_NAME: state.tableName,
        SLACK_THREADS_TABLE_NAME: slackThreads.tableName,
        SLACK_REQUEST_QUEUE_URL: slackRequestQueue.queueUrl,
        SLACK_SECRET_ARN: slackSecret.secretArn,
        SLACK_APP_POSTED_MESSAGES: appPostedMessages.valueAsString,
        SLACK_THREAD_TURNS_PER_MINUTE: threadTurnsPerMinute.valueAsString,
      },
      Duration.seconds(10),
    );
    slackIngress.addToRolePolicy(new iam.PolicyStatement({
      actions: ["dynamodb:GetItem"],
      resources: [state.tableArn],
      conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["SLACK_BINDING#*"] } },
    }));
    slackThreads.grantReadWriteData(slackIngress);
    slackRequestQueue.grantSendMessages(slackIngress);
    // The stop command (#126): the broker cancels the thread's running task for the ingress, which
    // itself gets no write access to the state table and no callback key.
    slackIngress.addEnvironment("BROKER_FUNCTION_NAME", broker.functionName);
    broker.grantInvoke(slackIngress);
    slackSecret.grantRead(slackIngress);
    // The Details view (spec 014 FR-024): Slack's interactivity request runs on this Lambda and must
    // open the modal within 3 seconds, so it reads the one turn record the clicked button names, by
    // key. It may read only the attributes the view shows: never the request or response text, the
    // workspace or the worker operations. No Query or Scan, and no index.
    slackIngress.addToRolePolicy(new iam.PolicyStatement({
      actions: ["dynamodb:GetItem"],
      resources: [turnRecords.tableArn],
      conditions: {
        "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["THREAD#*"] },
        "ForAllValues:StringEquals": { "dynamodb:Attributes": TURN_DETAILS_READ_ATTRIBUTES },
        StringEqualsIfExists: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
        // ForAllValues passes when dynamodb:Attributes is absent, and GetItem has no Select, so a read
        // without a ProjectionExpression (which returns every attribute) must be refused outright.
        Null: { "dynamodb:Attributes": "false" },
      },
    }));
    slackIngress.addEnvironment("TURN_RECORDS_TABLE_NAME", turnRecords.tableName);

    const api = new apigwv2.CfnApi(this, "HttpApi", {
      name: naming.apiName,
      protocolType: "HTTP",
    });
    const integration = new apigwv2.CfnIntegration(this, "BrokerIntegration", {
      apiId: api.ref,
      integrationType: "AWS_PROXY",
      integrationUri: broker.functionArn,
      payloadFormatVersion: "2.0",
    });
    const authorizer = new apigwv2.CfnAuthorizer(this, "JwtAuthorizer", {
      apiId: api.ref,
      authorizerType: "JWT",
      identitySource: ["$request.header.Authorization"],
      name: "agentx-jwt",
      jwtConfiguration: {
        audience: [oidcAudience.valueAsString],
        issuer: oidcIssuer.valueAsString,
      },
    });
    new apigwv2.CfnRoute(this, "ProxyRoute", {
      apiId: api.ref,
      routeKey: "ANY /{proxy+}",
      target: `integrations/${integration.ref}`,
      authorizationType: "JWT",
      authorizerId: authorizer.ref,
    });
    new apigwv2.CfnRoute(this, "WorkerCallbackRoute", {
      apiId: api.ref,
      routeKey: "POST /v1/internal/{proxy+}",
      target: `integrations/${integration.ref}`,
      authorizationType: "NONE",
    });
    // Logical ID "ModelAccessRoute" on purpose (switch-over incident 2026-11-16): the 0.5.18 staging stack already holds this
    // route key under that ID. A new ID made CloudFormation create a second GET /v1/internal/model-access route before its
    // cleanup deleted the old one, and the update failed with 409 AlreadyExists. Keeping the ID updates it in place.
    // Pinned by tests/unit/collision-check.test.ts; check new previews with scripts/collision-check.ts.
    if (props?.naming !== undefined) new apigwv2.CfnRoute(this, "ModelAccessRoute", {
      apiId: api.ref,
      routeKey: "GET /v1/internal/model-access",
      target: `integrations/${integration.ref}`,
      authorizationType: "NONE",
    });
    // Worker capabilities authenticate these exact reads in the broker, before company discovery.
    // Keep ContextToolsListRoute: the recorded 0.5.18 template already used this ID for the catalog GET.
    // Created for the legacy install (no environment) too: without them a worker's GET falls through to the
    // JWT-authorized ANY /{proxy+} route and gets 401, which blocks every core-engine task at UNDERSTAND.
    // Same IDs and keys for every install, so named environments are unchanged.
    new apigwv2.CfnRoute(this, "ContextToolsListRoute", {
      apiId: api.ref,
      routeKey: "GET /v1/internal/context-tools",
      target: `integrations/${integration.ref}`,
      authorizationType: "NONE",
    });
    new apigwv2.CfnRoute(this, "DesignReviewPacketRoute", {
      apiId: api.ref,
      routeKey: "GET /v1/internal/design-review/packet",
      target: `integrations/${integration.ref}`,
      authorizationType: "NONE",
    });
    // The setup worker authenticates this one source read with its short-lived project-setup
    // capability, which the broker verifies. Keep the API Gateway exception limited to this GET;
    // the generic internal callback route remains POST-only.
    new apigwv2.CfnRoute(this, "ProjectSetupExecutionReadRoute", {
      apiId: api.ref,
      routeKey: "GET /v1/internal/project-setups/{setupExecutionId}/execution",
      target: `integrations/${integration.ref}`,
      authorizationType: "NONE",
    });
    // Guided onboarding PR 7: the Linear OAuth app signs its webhook bodies itself; the broker verifies the HMAC, the timestamp and the workspace's binding. Named environments only.
    if (naming.env !== undefined) new apigwv2.CfnRoute(this, "LinearWebhookRoute", {
      apiId: api.ref,
      routeKey: "POST /v1/linear/webhooks",
      target: `integrations/${integration.ref}`,
      authorizationType: "NONE",
    });
    // GitHub signs webhook bodies itself; the broker verifies its HMAC and linked repository scope.
    const githubWebhookRoute = new apigwv2.CfnRoute(this, "GithubWebhookRoute", {
      apiId: api.ref,
      routeKey: GITHUB_WEBHOOK_ROUTE,
      target: `integrations/${integration.ref}`,
      authorizationType: "NONE",
    });
    // Confused-deputy guard: only this account's own EventBridge schedules may assume the recovery roles.
    // Scheduler sets aws:SourceArn to the schedule group's ARN, not the schedule's; these schedules use the default group.
    const schedulerPrincipal = new iam.ServicePrincipal("scheduler.amazonaws.com", { conditions: {
      StringEquals: {
        "aws:SourceAccount": this.account,
        "aws:SourceArn": `arn:${this.partition}:scheduler:${this.region}:${this.account}:schedule-group/default`,
      },
    } });
    const githubRecoveryRole = new iam.Role(this, "GithubWebhookRecoveryRole", {
      assumedBy: schedulerPrincipal,
    });
    broker.grantInvoke(githubRecoveryRole);
    new scheduler.CfnSchedule(this, "GithubWebhookRecoverySchedule", {
      flexibleTimeWindow: { mode: "OFF" },
      scheduleExpression: "rate(1 minute)",
      state: "ENABLED",
      target: {
        arn: broker.functionArn,
        roleArn: githubRecoveryRole.roleArn,
        input: JSON.stringify({ source: "agentx.github-webhook-recovery" }),
        retryPolicy: { maximumRetryAttempts: 2, maximumEventAgeInSeconds: 300 },
      },
    });
    new scheduler.CfnSchedule(this, "WorkflowMergeRecoverySchedule", {
      flexibleTimeWindow: { mode: "OFF" },
      scheduleExpression: "rate(1 minute)",
      state: "ENABLED",
      target: {
        arn: broker.functionArn,
        roleArn: githubRecoveryRole.roleArn,
        input: JSON.stringify({ source: "agentx.workflow-merge-recovery" }),
        retryPolicy: { maximumRetryAttempts: 2, maximumEventAgeInSeconds: 300 },
      },
    });
    // Gap 6: re-run any workflow dispatch (an automatic review start) left behind after its result committed.
    const workflowDispatchRecoveryRole = new iam.Role(this, "WorkflowDispatchRecoveryRole", {
      assumedBy: schedulerPrincipal,
    });
    broker.grantInvoke(workflowDispatchRecoveryRole);
    new scheduler.CfnSchedule(this, "WorkflowDispatchRecoverySchedule", {
      flexibleTimeWindow: { mode: "OFF" },
      scheduleExpression: "rate(1 minute)",
      state: "ENABLED",
      target: {
        arn: broker.functionArn,
        roleArn: workflowDispatchRecoveryRole.roleArn,
        input: JSON.stringify({ source: "agentx.workflow-dispatch-recovery" }),
        retryPolicy: { maximumRetryAttempts: 2, maximumEventAgeInSeconds: 300 },
      },
    });
    const defaultStage = new apigwv2.CfnStage(this, "DefaultStage", {
      apiId: api.ref,
      stageName: "$default",
      autoDeploy: true,
    });
    // Webhook lane W3: the public GitHub webhook route's throttle and its alarm (infra/lib/github-webhook.ts).
    guardGithubWebhookRoute(this, naming, api.ref, defaultStage, githubWebhookRoute, notifyOperator);
    broker.addPermission("ApiInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      sourceArn: `arn:${this.partition}:execute-api:${this.region}:${this.account}:${api.ref}/*/*/*`,
    });

    const slackIntegration = new apigwv2.CfnIntegration(this, "SlackIngressIntegration", {
      apiId: api.ref,
      integrationType: "AWS_PROXY",
      integrationUri: slackIngress.functionArn,
      payloadFormatVersion: "2.0",
    });
    new apigwv2.CfnRoute(this, "SlackEventsRoute", {
      apiId: api.ref,
      routeKey: "POST /v1/slack/events",
      target: `integrations/${slackIntegration.ref}`,
      authorizationType: "NONE",
    });
    // Slack's interactivity request URL (spec 014): signed button presses, handled by the same Lambda.
    new apigwv2.CfnRoute(this, "SlackInteractivityRoute", {
      apiId: api.ref,
      routeKey: "POST /v1/slack/interactions",
      target: `integrations/${slackIntegration.ref}`,
      authorizationType: "NONE",
    });
    new apigwv2.CfnRoute(this, "SlackServiceRoute", {
      apiId: api.ref,
      routeKey: "ANY /v1/service/{proxy+}",
      target: `integrations/${integration.ref}`,
      authorizationType: "AWS_IAM",
    });
    slackIngress.addPermission("ApiInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      sourceArn: `arn:${this.partition}:execute-api:${this.region}:${this.account}:${api.ref}/*/*/v1/slack/events`,
    });
    slackIngress.addPermission("InteractivityInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      sourceArn: `arn:${this.partition}:execute-api:${this.region}:${this.account}:${api.ref}/*/*/v1/slack/interactions`,
    });
    slackOrchestratorRole.addToPolicy(new iam.PolicyStatement({
      actions: ["execute-api:Invoke"],
      resources: [`arn:${this.partition}:execute-api:${this.region}:${this.account}:${api.ref}/*/*/v1/service/*`],
    }));

    // Spec 062: the channel API. Every deployment has the built-in Slack adapter, off until SlackViaChannel is enabled
    // (Phase 7d); named environments may also register other adapters, off until ChannelAdapters is enabled.
    const channelAdapters = new ChannelAdapters(this, "ChannelApi", {
      naming, env: naming.env ?? "production", api, state, broker, orchestratorRole: slackOrchestratorRole, notifyOperator,
      slack: { ingress: slackIngress, integration: slackIntegration, threads: slackThreads, appPostedMessages: appPostedMessages.valueAsString, threadTurnsPerMinute: threadTurnsPerMinute.valueAsString },
      registry: true, sharedTasks: naming.env !== undefined,
      turnRecords: { table: turnRecords, detailsAttributes: TURN_DETAILS_READ_ATTRIBUTES },
    });
    new CfnOutput(this, "SlackAdapterCommandsUrl", { value: `${api.attrApiEndpoint}/v1/slack/channel-commands` });
    new CfnOutput(this, "SlackAdapterSecretName", { value: `agentx/${naming.env ?? "production"}/channel-adapter/slack` });
    new CfnOutput(this, "ChannelRequestQueueUrl", { value: channelAdapters.requests.queueUrl });
    new CfnOutput(this, "ChannelEventQueueUrl", { value: channelAdapters.events.queueUrl });
    // Spec 025 phase 25a: developer sign-in and tasks, in every deployment; the legacy one is named production.
    const taskParameters = signInParameters.tasks;
    // DEC 254zg (a): the company layer's switch (CompanySignIn); every function that reads COMPANY_SIGNIN gets it from here, and every company-only grant is a policy under its
    // condition (company-signin.ts). #1129: the legacy deployment (production) too, off by default, so production can make invite codes once it is switched on.
    const companySignIn = signInParameters.company === undefined ? undefined : new CompanySignInSwitch(this, "CompanySignInSwitch", signInParameters.company);
    // DEC 254o (b), L2-2 PR 18a: Slack company mode's switch (stack parameter SlackCompanyWorkspaces, default disabled). Named environments only; every grant it adds is a
    // separate policy under its condition, so nothing is granted while it is off (slack-company-workspaces.ts). DEC 254zg (a), 254zk: its condition also requires company
    // sign-in, so its grants and its "enabled" exist only with both switches on.
    // #1171: the legacy deployment (production) too, off by default (owner 2026-11-19: no named-only features); off, its Slack stays on its one workspace, as before.
    const slackCompany = companySignIn === undefined ? undefined : new SlackCompanyWorkspaces(this, "SlackCompanyMode", { naming, requires: companySignIn.isOn });
    if (slackCompany !== undefined) {
      // The Slack Lambda and the channel API's Slack router: the team's binding and company, the linked person (company-scoped link row, sign-in membership below), the
      // project's revisions (company check) and the company's token. Reads only: link notices and codes are written by the broker (#126 holds).
      for (const [id, fn] of [["SlackIngress", slackIngress], ["ChannelApi", channelAdapters.ingress]] as const) {
        slackCompany.grant(id, fn.role!, [
          slackCompany.tokenRead(),
          slackCompany.stateReads(state, "ReadSlackWorkspaceBindingsAndLinks", [...SLACK_BINDING_READ_KEYS, "ORG#*#CHANNEL_LINK#slack/*"]),
          // Only a revision's company (company-check.ts recordInCompany): never a project's definition or runtime binding.
          new iam.PolicyStatement({ sid: "ReadProjectCompany", actions: ["dynamodb:Query"], resources: [state.tableArn],
            conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["PROJECT#*"] }, "ForAllValues:StringEquals": { "dynamodb:Attributes": ["pk", "sk", "companyId"] },
              StringEqualsIfExists: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" }, Null: { "dynamodb:LeadingKeys": "false", "dynamodb:Attributes": "false" } } }),
        ]);
        fn.addEnvironment(SLACK_COMPANY_WORKSPACES_VARIABLE, slackCompany.value);
      }
      // DEC 254zzz80 (R2-F1, owner-approved): the Slack Lambda reads a NAMED company's channel binding in the company's own partition (ORG#<company>#SLACK_BINDING#<team>), for the
      // install team (its operator binding names the company) and every company-mode team. GetItem only, exact company-id shape, the Null guard; its own policy under the switch's
      // condition (nothing while company mode is off), so no existing statement changes.
      slackCompany.grant("SlackIngressCompanyBindings", slackIngress.role!, [slackCompany.stateReads(state, "ReadCompanySlackChannelBindings", COMPANY_SLACK_CHANNEL_BINDING_KEYS)]);
      // DEC 254zzz80 (R2-F1 lane 1 review M2; new IAM for the owner's OK): whether a NAMED company holds a project, from its own revisions (slack-company-wiring.ts getProject).
      // Query only, keys plus companyId and candidate, the exact company-id shape; its own policy per consumer under the switch's condition, so no existing statement changes.
      for (const [id, fn] of [["SlackIngressCompanyProjects", slackIngress], ["ChannelApiCompanyProjects", channelAdapters.ingress]] as const) {
        slackCompany.grant(id, fn.role!, [new iam.PolicyStatement({ sid: "ReadCompanyProjectRevisions", actions: ["dynamodb:Query"], resources: [state.tableArn],
          conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": [...COMPANY_PROJECT_REVISION_KEYS] }, "ForAllValues:StringEquals": { "dynamodb:Attributes": ["pk", "sk", "companyId", "candidate"] },
            StringEqualsIfExists: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" }, Null: { "dynamodb:LeadingKeys": "false", "dynamodb:Attributes": "false" } } })]);
      }
      // L2-2 PR 18c: the Slack Lambda's company factory needs the environment's name (the token path) and the install's team (always the legacy path); "" while off.
      slackIngress.addEnvironment("AGENTX_ENV", Token.asString(Fn.conditionIf(slackCompany.isOn.logicalId, naming.env ?? "production", "")));
      slackIngress.addEnvironment("SLACK_TEAM_ID", Token.asString(Fn.conditionIf(slackCompany.isOn.logicalId, signInParameters.slackTeamId.valueAsString, "")));
      // DEC 254zk: the switch's conditioned value (enabled only with company sign-in on too), as every other consumer gets it.
      addBrokerSetting(broker, naming, "slackCompanyWorkspaces", slackCompany.flag);
      // DEC 254zzz32: the broker reads a company's own bot token (slack-company-wiring.ts readSecret: the hosted core's Slack task threads, link notices), as the other
      // Slack consumers do. Read-only, the token family only, its own policy under the switch's condition (nothing while it is off; never the broker's DefaultPolicy).
      // DEC 254zzz35: and the install's own Slack app secret (agentx/<env>/slack), read-only, for the install's own workspace (built-in company), which has no company token: its
      // bot token is that secret's (the broker's Slack company wiring passes it as legacyToken). Same policy, same condition: nothing while company mode is off.
      slackCompany.grant("Broker", broker.role!, [slackCompany.tokenRead(),
        new iam.PolicyStatement({ sid: "ReadInstallSlackToken", actions: ["secretsmanager:GetSecretValue"], resources: [slackSecret.secretArn] })]);
      // DEC 254zk: the channel API's company factory needs the environment's name too (it already has STATE_TABLE_NAME and SLACK_ADAPTER_TEAM_ID); "" while off.
      channelAdapters.ingress.addEnvironment("AGENTX_ENV", Token.asString(Fn.conditionIf(slackCompany.isOn.logicalId, naming.env ?? "production", "")));
    }
    if (taskParameters !== undefined) {
      const developerSignIn = new DeveloperSignIn(this, "DeveloperSignIn", {
        naming, env: naming.env ?? "production", api, stage: defaultStage, brokerIntegration: integration, broker, dispatcher, slackSecret, parameters: signInParameters, turnRecords, stateTable: state,
        ...(companySignIn === undefined ? {} : { company: companySignIn }),
      });
      // Named: one statement for the broker's two invokes (the plan evidence job and the sign-in function; developer-signin.ts leaves its grant to this), ENV-ROOM 2's IAM room.
      // The same resources CDK's grantInvoke gives each: the function and its versions and aliases.
      if (naming.env !== undefined) {
        if (planEvidenceFunction === undefined) throw new Error("a named control plane has the plan evidence function");
        const invoked = [planEvidenceFunction, developerSignIn.function];
        broker.addToRolePolicy(new iam.PolicyStatement({ actions: ["lambda:InvokeFunction"], resources: invoked.flatMap((fn) => [fn.functionArn, `${fn.functionArn}:*`]) }));
      }
      // The Slack Lambda and the channel API Lambda (Slack company mode reads it: lead 2, #873).
      if (companySignIn !== undefined) for (const fn of [slackIngress, channelAdapters.ingress]) companySignIn.addTo(fn);
      // Spec 063 FR-005: the admin client's own rule for who is an administrator, read at company sign-in.
      developerSignIn.function.addEnvironment("ADMIN_OIDC_ISSUER", oidcIssuer.valueAsString);
      developerSignIn.function.addEnvironment("ADMIN_CLAIM", adminClaim.valueAsString);
      developerSignIn.function.addEnvironment("ADMIN_VALUES", adminValues.valueAsString);
      if (naming.env === "agentxlivetest123" && taskPersonProofEnabled !== undefined) {
        const proof = new TaskPersonProof(this, "TaskPersonProof", {
          naming,
          enabled: taskPersonProofEnabled,
          slackTeamId: signInParameters.slackTeamId,
          slackSecret,
          developerSignInTable: developerSignIn.table,
          dispatcher,
          // DEC 254zc (6): the proof's switch variables come with the infrastructure switch (they change the version the dispatcher pins).
          ...(companySignIn === undefined || slackCompany === undefined ? {} : { companySwitches: {
            COMPANY_SIGNIN: companySignIn.value, SLACK_COMPANY_WORKSPACES: slackCompany.value,
            STATE_TABLE_NAME: Token.asString(Fn.conditionIf(slackCompany.isOn.logicalId, state.tableName, "")),
          } }),
        });
        if (slackCompany !== undefined) {
          slackCompany.grant("TaskPersonProof", proof.role, [slackCompany.tokenRead(), slackCompany.stateReads(state, "ReadSlackWorkspaceBindings", SLACK_BINDING_READ_KEYS)], proof.install);
        }
      }
      addBrokerSetting(broker, naming, "taskPeopleChanges", taskParameters.taskPeopleChangesEnabled.valueAsString);
      addBrokerSetting(broker, naming, "taskPeoplePublicInvitations", taskParameters.taskPeoplePublicInvitationsEnabled.valueAsString);
      addBrokerSetting(broker, naming, "taskPeoplePrivateInvitations", taskParameters.taskPeoplePrivateInvitationsEnabled.valueAsString);
      addBrokerSetting(broker, naming, "workflowDependencies", taskParameters.workflowDependenciesEnabled.valueAsString);
      // Sign in with ChatGPT (#338): seals each developer's ChatGPT tokens in the State table. A
      // connection belongs to a signed-in developer, so it exists only where developer sign-in
      // does. Only the broker encrypts and decrypts with it, always under an encryption context
      // naming the developer and the field. Deleting it (with the stack) only leaves connections to redo.
      const chatGptConnectionKey = new kms.Key(this, "ChatGptConnectionKey", {
        description: "AgentX: seals developers' Sign in with ChatGPT tokens",
        enableKeyRotation: true,
        pendingWindow: Duration.days(7),
        removalPolicy: RemovalPolicy.DESTROY,
      });
      // Named environments only: the legacy (production) template keeps the grant on the broker's role, as mainline deploys it.
      if (naming.env !== undefined) {
        chatGptConnectionKey.addToResourcePolicy(new iam.PolicyStatement({
          principals: [new iam.ArnPrincipal(broker.role!.roleArn)],
          actions: ["kms:Encrypt", "kms:Decrypt"], resources: ["*"],
        }));
        // L4-HARD (owner 2026-11-18): the Deny the other keys have. The default key policy lets the account's root delegate to IAM, so without this any account admin with
        // kms:Decrypt in their own IAM policy could open developers' ChatGPT tokens. Now only the broker uses the key (like the invoke signing key and the sign-in token keys).
        // The broker's sealer and the Linear token wrapper always pass an encryption context; requiring one in the policy is deferred (it would change the headroom pins' evaluator
        // contexts). Named environments only, like the Allow above.
        chatGptConnectionKey.addToResourcePolicy(new iam.PolicyStatement({
          sid: "UseOnlyAsBroker",
          effect: iam.Effect.DENY,
          principals: [new iam.AnyPrincipal()],
          actions: ["kms:Encrypt", "kms:Decrypt", "kms:ReEncrypt*", "kms:GenerateDataKey*"],
          resources: ["*"],
          conditions: { ArnNotEquals: { "aws:PrincipalArn": broker.role!.roleArn } },
        }));
      } else chatGptConnectionKey.grant(broker, "kms:Encrypt", "kms:Decrypt");
      addBrokerName(broker, naming, "chatGptConnectionKey", chatGptConnectionKey.keyId, chatGptConnectionKey.keyArn);
      // Spec 025 phase 25c: sharing, named environments only (D14).
      const notifier = new DeveloperTaskNotifier(this, "DeveloperTaskNotifier", { naming, coreBroker: broker, controlPlaneUrl: api.attrApiEndpoint, state, artifactBucket: artifacts, slackSecret, taskPeopleChangesEnabled: taskParameters.taskPeopleChangesEnabled, notifyOperator });
      if (companySignIn !== undefined) companySignIn.addTo(notifier.function);
      // Migration plan v3.2 lane E2: the core engine's dispatch queue and its scheduled jobs (core-engine.ts), for every install (#1148: the legacy install too, under "production").
      new CoreEngine(this, "CoreEngineJobs", { naming, env: naming.env ?? "production", broker, dispatcher, notifyOperator });
      // Lane T6 (DEFERRED T6-SECRETS-IAM-20261114-v2): the role the broker will assume for one company's secrets; nothing assumes it yet. #1129: the legacy deployment
      // (production) too, its secrets under agentx/production/.
      {
        const companySecretsRole = new CompanySecrets(this, "CompanySecrets", { env: naming.env ?? "production", brokerRole: broker.role! }).role;
        addBrokerName(broker, naming, "companySecretsRole", companySecretsRole.roleName, companySecretsRole.roleArn);
      }
      // L4-SE6 (owner-approved 2026-11-18): the saved environment images' registry side: ONE repository creation template for `rovara-env/<env>` and the three roles (push, pull, manage) that trust only
      // the broker. Named environments only (the legacy template is unchanged). It publishes the output contract (briefs/lead4/L4-SE-OUTPUT-CONTRACT.md) and gives the broker the three role ARNs and the prefix; the broker gets no new policy statement
      // (the trust names its role and the boundary allows the AssumeRole). Nothing assumes a role until the broker's switch is on.
      // #1148: the legacy install too (its repositories under rovara-env/production; the feature stays off until SavedEnvironments is on).
      new SavedEnvImages(this, "SavedEnvImages", { env: naming.env ?? "production", brokerRole: broker.role! }).expose(this, broker);
      // Spec 025 A13: the admin health route reads the environment's alarms, by name, and
      // the depths of its dead-letter queues. Read-only, and on exactly these resources.
      const alarmPrefix = naming.alarmName("");
      addDerivedBrokerVariable(broker, naming, "AGENTX_ALARM_PREFIX", alarmPrefix);
      // Issue 206: the probe reads them by exact name (HEALTH_ALARM_SUFFIXES), since a prefix listing
      // is authorized against * while a call naming its alarms is authorized against each alarm's
      // ARN, which this grant covers. A CDK alarm missing from that list would go unreported, so the
      // app refuses to synthesize one. This holds when an environment's stacks deploy from one
      // revision, as a release does: a stack deployed alone from a newer revision could add an
      // alarm this broker does not list.
      this.node.addValidation({ validate: () => unlistedAlarms(this, alarmPrefix, naming.env === undefined ? `${naming.resourcePrefix}-` : alarmPrefix) });
      broker.addToRolePolicy(new iam.PolicyStatement({
        actions: ["cloudwatch:DescribeAlarms"],
        resources: [`arn:${this.partition}:cloudwatch:${this.region}:${this.account}:alarm:${alarmPrefix}*`],
      }));
      channelAdapters.connectSlackPoster(notifier.function, signInParameters.slackTeamId.valueAsString);
      if (slackCompany !== undefined) {
        // The notifier: binding and token for each post; a ChatGPT fallback's workspace pointer row (ORG#<c>#WORKSPACE#<id>).
        // L2-2 PR 18d: the pointer row's key narrowed to a company id's exact shape (org_ + 20 characters), so the pattern cannot match another key that merely contains #WORKSPACE#.
        slackCompany.grant("DeveloperTaskNotifier", notifier.function.role!, [slackCompany.tokenRead(),
          slackCompany.stateReads(state, "ReadSlackWorkspaceBindings", [...SLACK_BINDING_READ_KEYS, "ORG#org_????????????????????#WORKSPACE#*"])]);
        notifier.function.addEnvironment(SLACK_COMPANY_WORKSPACES_VARIABLE, slackCompany.value);
        notifier.function.addEnvironment("AGENTX_ENV", Token.asString(Fn.conditionIf(slackCompany.isOn.logicalId, naming.env ?? "production", "")));
        // DeveloperIdentity already reads the token family (Add to Slack); its directory needs the team's binding, on the State table it otherwise never reads.
        slackCompany.grant("DeveloperIdentity", developerSignIn.function.role!, [slackCompany.stateReads(state, "ReadSlackWorkspaceBindings", SLACK_BINDING_READ_KEYS)]);
        developerSignIn.function.addEnvironment(SLACK_COMPANY_WORKSPACES_VARIABLE, slackCompany.value);
        // STATE_TABLE_NAME is the sign-in function's own, always the real State table (developer-signin.ts: the company audit write needs it with CompanySignIn on, Slack company mode on or off). The Slack company switch is SLACK_COMPANY_WORKSPACES above, never this variable.
        // The Slack Lambda and the channel API resolve the linked person's company membership on the sign-in table (company-check.ts membershipKey), reads only.
        for (const [id, fn] of [["SlackIngressMembers", slackIngress], ["ChannelApiMembers", channelAdapters.ingress]] as const) {
          slackCompany.grant(id, fn.role!, [slackCompany.stateReads(developerSignIn.table, "ReadCompanyMemberships", ["COMPANY_MEMBER#*"])]);
          fn.addEnvironment("DEVELOPER_SIGNIN_TABLE_NAME", Token.asString(Fn.conditionIf(slackCompany.isOn.logicalId, developerSignIn.table.tableName, "")));
        }
      }
      // Phase 7c1b: sign-in's Slack directory reads (task access, channel names, the health check).
      channelAdapters.connectSlackPoster(developerSignIn.function, signInParameters.slackTeamId.valueAsString);
      // Phase 7c2: the channel API's Slack router posts through the adapter too.
      channelAdapters.connectSlackPoster(channelAdapters.ingress, signInParameters.slackTeamId.valueAsString, { readsAdapterSecrets: true });
      // L4-HW8b (DEC 254zzz42 (a)): the broker's hosted lessons source sends Slack `thread_messages` commands through the adapter (aws/hosted-slack-thread.ts). Environment as the other posters have it;
      // the secret read is in the SECRET's policy (the broker's role policy has no room), so the identity grant is skipped here. Named environments only: the legacy (production) template does not change.
      if (naming.env !== undefined) {
        channelAdapters.connectSlackPoster(broker, signInParameters.slackTeamId.valueAsString, { readsAdapterSecrets: true });
        channelAdapters.allowBrokerToReadSlackAdapterSecret(broker.role!);
      }

      // Preserve the health probe's existing five-queue inventory. Channel request failures remain alarm-only.
      const deadLetterQueues = {
        dispatch: deadLetterQueue, "slack-requests": slackDeadLetterQueue, "developer-notices": notifier.deadLetters, "developer-notice-stream": notifier.streamFailures,
        "channel-events": channelAdapters.eventDeadLetters,
      };
      addBrokerDeadLetterQueues(broker, naming, [
        ["dispatchDeadLetters", deadLetterQueues.dispatch], ["slackRequestDeadLetters", deadLetterQueues["slack-requests"]], ["developerNoticeDeadLetters", deadLetterQueues["developer-notices"]],
        ["developerNoticeStreamFailures", deadLetterQueues["developer-notice-stream"]], ["channelEventDeadLetters", deadLetterQueues["channel-events"]],
      ]);
      // Named environments only: the legacy (production) template keeps one statement on the broker's role, as mainline deploys it.
      if (naming.env !== undefined) {
        for (const queue of Object.values(deadLetterQueues)) queue.addToResourcePolicy(new iam.PolicyStatement({
          principals: [new iam.ArnPrincipal(broker.role!.roleArn)],
          actions: ["sqs:GetQueueAttributes"],
          resources: [queue.queueArn],
        }));
      } else {
        broker.addToRolePolicy(new iam.PolicyStatement({
          actions: ["sqs:GetQueueAttributes"],
          resources: Object.values(deadLetterQueues).map((queue) => queue.queueArn),
        }));
      }
      // C10: the ingress reads shared thread records by key; its SLACK_BINDING# statement is unchanged.
      slackIngress.addEnvironment("SHARED_TASKS", "enabled");
      slackIngress.addToRolePolicy(new iam.PolicyStatement({
        actions: ["dynamodb:GetItem"],
        resources: [state.tableArn],
        conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["SHARED_TASK#*"] } },
      }));
      // Slack plan buttons read only the task owner, share binding, and saved workflow policy by key. Spec 062 Phase
      // 7c3: so does the channel API, which runs those buttons for the built-in Slack adapter.
      const taskButtonRead = () => new iam.PolicyStatement({
        actions: ["dynamodb:GetItem"],
        resources: [state.tableArn],
        conditions: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DEVTASK#*"] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": ["pk", "sk", "slackUserId", "share", "workflow"] },
          StringEqualsIfExists: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
          Null: { "dynamodb:Attributes": "false" },
        },
      });
      slackIngress.addToRolePolicy(taskButtonRead());
      channelAdapters.ingress.addToRolePolicy(taskButtonRead());
      // Task 19 (gap 10h): a Quick or Full button takes the choice while Slack waits, then starts the task in an
      // asynchronous invoke of this same Lambda. A policy of its own, so the function does not wait on it (no cycle).
      new iam.Policy(this, "SlackIngressSelfInvoke", {
        roles: [slackIngress.role!],
        statements: [new iam.PolicyStatement({ actions: ["lambda:InvokeFunction"], resources: [slackIngress.functionArn] })],
      });
      // Task 19: an asynchronous invoke Lambda could not run (throttled past its retries, too old, or a crash) lands here,
      // and the operator is told: a Slack press handed to the broker or this Lambda's own Quick or Full start, and also
      // any other asynchronous broker invoke (a scheduled retry sweep). The handlers answer every expected refusal
      // themselves, so anything here is a lost request.
      const handOffFailures = new sqs.Queue(this, "SlackHandOffFailureQueue", {
        encryption: sqs.QueueEncryption.SQS_MANAGED,
        retentionPeriod: Duration.days(14),
      });
      // Lambda validates destination permissions when creating EventInvokeConfig. Keep this
      // grant on the execution role, and explicitly order both grant and any queue policy first.
      // SqsDestination repeats the identical grant; CDK deduplicates it in DefaultPolicy.
      // #1131: every deployment (the legacy template had the destination's own grant, without this ordering).
      const handOffGrant = handOffFailures.grantSendMessages(broker);
      broker.configureAsyncInvoke({ onFailure: new lambdaDestinations.SqsDestination(handOffFailures) });
      if (handOffGrant !== undefined) {
        const brokerInvokeConfig = broker.node.findChild("EventInvokeConfig");
        handOffGrant.applyBefore(brokerInvokeConfig);
        const handOffQueuePolicy = handOffFailures.node.tryFindChild("Policy");
        if (handOffQueuePolicy) brokerInvokeConfig.node.addDependency(handOffQueuePolicy);
      }
      slackIngress.configureAsyncInvoke({ onFailure: new lambdaDestinations.SqsDestination(handOffFailures) });
      new cloudwatch.Alarm(this, "SlackHandOffFailuresAlarm", {
        alarmName: naming.alarmName("SlackHandOffFailures"),
        alarmDescription: "An AgentX background request (a Slack button press or a scheduled retry) was lost: Lambda could not run it, and it is in the Slack hand-off failure queue. Check the queue, and the broker and Slack ingress logs for its task or request ID.",
        // Each lost request alarms on its own: the count sent in five minutes, not the queue's depth (which stays up until
        // the queue is purged and would hide a later loss).
        metric: handOffFailures.metricNumberOfMessagesSent({ statistic: "Sum", period: Duration.minutes(5) }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(notifyOperator);
      // Spec 025 E14 (C14): the interactivity route hands Slack Confirm and Cancel presses to the broker.
      slackIngress.addEnvironment("ADMIN_CHANGES", "enabled");
      // Spec 062 Phase 7c3b: the channel API takes Slack's presses and forms for the built-in adapter: admin change
      // presses, the Details view (the same field-limited read of one turn record) and a ChatGPT connection finished in
      // an asynchronous invoke of itself (a policy of its own, so the function does not wait on it).
      channelAdapters.ingress.addEnvironment("ADMIN_CHANGES", "enabled");
      // Spec 025 E14, FR-052: the interactivity route logs a press with its change's trace ID; it may
      // read only that attribute and the keys, by key.
      slackIngress.addToRolePolicy(new iam.PolicyStatement({
        actions: ["dynamodb:GetItem"],
        resources: [state.tableArn],
        conditions: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["ADMIN_CHANGE#*"] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": ["pk", "sk", "traceId"] },
          StringEqualsIfExists: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
          // ForAllValues passes when dynamodb:Attributes is absent, and GetItem has no Select, so a read
          // without a ProjectionExpression (which returns every attribute) must be refused outright.
          Null: { "dynamodb:Attributes": "false" },
        },
      }));
      // C14: TASK_BUSY counts the shared thread's waiting messages.
      addBrokerName(broker, naming, "slackThreadsTable", slackThreads.tableName, slackThreads.tableName);
      broker.addToRolePolicy(new iam.PolicyStatement({
        actions: ["dynamodb:GetItem"],
        resources: [slackThreads.tableArn],
        conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["THREAD#*"] } },
      }));
    }

    const sessions = new SessionLifecycle(this, "Sessions", { naming, state, invokeSigningKey, notifyOperator });
    // Spec 065b: a project a sign-in client creates runs on the foundation's workers: the broker builds its binding from
    // the zone=subnet pairs and the launch template, with no AWS call.
    const foundationParameter = (name: string) => (this.node.findChild(name) as CfnParameter).valueAsString;
    // DEC 254z-amend3: the session steps read the test services switch whole (named environments, where CoreEngine declares it): on, a launch's boot configuration carries `testServices`.
    // DEC 254zm: and whether the starter copies are in place; only with both does a launch carry `testServices` (aws/hosted-test-services.ts).
    // #1148: the legacy install too, now that CoreEngine declares these there.
    {
      sessions.steps.addEnvironment(TEST_SERVICES_SETTING_VARIABLE, foundationParameter(TEST_SERVICES_PARAMETER));
      sessions.steps.addEnvironment(TEST_SERVICE_IMAGES_SETTING_VARIABLE, foundationParameter(TEST_SERVICE_IMAGES_PARAMETER));
      // L4-NETG (DEC 254zzz77): how a worker host's sandboxes and devcontainers reach the internet. `bridge` (the default) is today's behaviour; `gateway` walls them behind the host's egress gateway and a launch carries
      // AGENTX_SANDBOX_EGRESS=gateway (the boot fails closed if the gateway cannot start). Only the session steps build the boot configuration, so only they read it: a plain variable, no packed setting, no IAM. A stack parameter,
      // so an upgrade keeps it (OPERATOR_PARAMETERS); `agentx config set workerSandboxEgress gateway|bridge`.
      const workerSandboxEgress = new CfnParameter(this, "WorkerSandboxEgress", {
        type: "String", default: WORKER_SANDBOX_EGRESS_DEFAULT, allowedValues: [...WORKER_SANDBOX_EGRESS_VALUES],
        description: "How a worker host's task sandboxes and devcontainers reach the internet: bridge (the default, today's behaviour) or gateway (an internal network whose only exit is the host's egress gateway; the worker boot fails if the gateway cannot start)",
      });
      sessions.steps.addEnvironment(WORKER_SANDBOX_EGRESS_SETTING_VARIABLE, workerSandboxEgress.valueAsString);
    }
    // L4-EGR: Rovara's fixed outbound addresses (the foundation's NatEgressAddresses output, which the release and `agentx deploy` pass when the foundation has it), shown to a company's owners
    // and admins (aws/company-egress-routes.ts). Empty until then. A plain variable, not a packed setting: a packed value cannot hold the commas, and the broker has the room.
    if (naming.env !== undefined) {
      const natEgressAddresses = new CfnParameter(this, NAT_EGRESS_ADDRESSES_OUTPUT, {
        type: "String", default: "", allowedPattern: EGRESS_ADDRESSES_PARAMETER_PATTERN, maxLength: 64,
        description: "The foundation's NAT gateway Elastic IPs, comma-separated: the addresses Rovara's machines connect from. Empty on an install whose foundation does not output them yet.",
      });
      broker.addEnvironment(EGRESS_ADDRESSES_VARIABLE, natEgressAddresses.valueAsString);
    }
    broker.addEnvironment("EC2_WORKER_SUBNETS", foundationParameter("Ec2WorkerSubnets"));
    broker.addEnvironment("EC2_WORKER_LAUNCH_TEMPLATE_ID", foundationParameter("Ec2WorkerLaunchTemplateId"));
    // A6: where the State table expires index items itself, the reconciler's legacy sweep is off.
    if (naming.env !== undefined) sessions.reconciler.addEnvironment("INDEX_EXPIRY", "ttl");
    // Issue 195: the alarm for stuck cancels. A stuck cancel on a live worker is queued again with the
    // signing key the backstop below gives the reconciler. #1131: every deployment, production included.
    sessions.connectStuckCancelAlarm();
    // Issue 173: the backstop for idle Slack tasks nobody waits on. #1131: every deployment.
    sessions.connectUnwaitedTaskBackstop(slackThreads, slackSecret, callbackSigningKeySecretName);
    channelAdapters.connectSlackPoster(sessions.reconciler, signInParameters.slackTeamId.valueAsString);
    if (slackCompany !== undefined) {
      // The reconciler already reads and writes the State table; it needs only the company's token for its thread notes.
      slackCompany.grant("SessionReconciler", sessions.reconciler.role!, [slackCompany.tokenRead()]);
      sessions.reconciler.addEnvironment(SLACK_COMPANY_WORKSPACES_VARIABLE, slackCompany.value);
      sessions.reconciler.addEnvironment("AGENTX_ENV", Token.asString(Fn.conditionIf(slackCompany.isOn.logicalId, naming.env ?? "production", "")));
      // The hosted Slack service (ECS): the team's binding and the company's token for its posts. Its container gets the switch from the slack stack.
      slackCompany.grant("SlackOrchestrator", slackOrchestratorRole, [slackCompany.tokenRead(), slackCompany.stateReads(state, "ReadSlackWorkspaceBindings", SLACK_BINDING_READ_KEYS)]);
      // L2-2 PR 18d: the Slack service's inputs, handed to the slack stack by the deploy (parameters.ts optionalOutputs). DEC 254zk: always there, so that agentx config set
      // slack.companyWorkspaces, which sets the slack stack's own switch (SlackCompanyWorkspacesState), finds them in place from the last deploy.
      for (const [id, value] of [["SlackCompanyStateTableName", state.tableName], ["SlackCompanyTeamId", signInParameters.slackTeamId.valueAsString]] as const) new CfnOutput(this, id, { value });
    }
    if (companySignIn !== undefined) companySignIn.addTo(sessions.reconciler);
    // Own both attachments in this releasable stack. Secret changes must never mutate the
    // protected foundation template or require a separate foundation change set.
    grantProviderKeySecrets(this, [slackOrchestratorRole.roleName, sessions.instanceRoleName]);
    // Optional standing transport for the EC2 E2E qualification runner (CDK context
    // agentx:e2eQualificationTransport=enabled, off by default; `-c key=value` always delivers a
    // string, so only the exact string "enabled" turns it on, like agentxInstaller and agentxEval,
    // and boolean true or "true" stay off): it reads its challenge and writes its
    // proposal, ready and status files in the artifact bucket, so no run needs temporary grants.
    // The keys are scoped by the IAM policy variable ${aws:userid}, which for an EC2 instance role
    // session is <role unique ID>:<instance ID>: of the instances sharing the worker role, each can
    // reach only e2e-runtime/<its own ID>/, so a worker running other code cannot read or plant
    // another instance's files. The variable is plain text in the resource ARN (CDK treats only
    // its own ${Token[...]} markers as tokens; the test pins the synthesized text). Exact object keys
    // only: no List, Delete or wildcard object access. Attached from this stack, like the provider
    // secrets above, because the bucket lives here and the foundation template stays untouched.
    if (this.node.tryGetContext("agentx:e2eQualificationTransport") === "enabled") {
      const ownPrefix = "e2e-runtime/${aws:userid}";
      new iam.CfnPolicy(this, "E2eQualificationTransport", {
        policyName: "E2eQualificationTransport",
        roles: [sessions.instanceRoleName],
        policyDocument: {
          Version: "2012-10-17",
          Statement: [
            { Sid: "ReadQualificationChallenge", Effect: "Allow", Action: "s3:GetObject", Resource: artifacts.arnForObjects(`${ownPrefix}/challenge.json`) },
            {
              Sid: "WriteQualificationProposalReadyAndStatus", Effect: "Allow", Action: "s3:PutObject",
              Resource: [artifacts.arnForObjects(`${ownPrefix}/proposal.json`), artifacts.arnForObjects(`${ownPrefix}/ready.json`), artifacts.arnForObjects(`${ownPrefix}/status.json`)],
            },
          ],
        },
      });
      // M1.4 Task 4.9: the model canary's request and result, exact keys under the same prefix. A policy of its own, so the guarded add-only change set of the
      // qualification-transport deploy unit adds it beside the deployed grant without modifying that grant.
      new iam.CfnPolicy(this, "E2eQualificationTransportCanary", {
        policyName: "E2eQualificationTransportCanary",
        roles: [sessions.instanceRoleName],
        policyDocument: {
          Version: "2012-10-17",
          Statement: [
            { Sid: "ReadModelCanaryRequest", Effect: "Allow", Action: "s3:GetObject", Resource: artifacts.arnForObjects(`${ownPrefix}/canary-request.json`) },
            { Sid: "WriteModelCanaryResult", Effect: "Allow", Action: "s3:PutObject", Resource: artifacts.arnForObjects(`${ownPrefix}/canary-result.json`) },
          ],
        },
      });
      // M1.4 Task 4.10C, read-only model discovery for the runner's worker (what the model check lists: Bedrock models and profiles, availability, and the tokens-per-minute quotas).
      // No invoke grant is added: the driving test uses BedrockModelInvocation, which already covers the foundation models and this account's inference profiles (global. included).
      // `bedrock:GetFoundationModelAvailability` is `*` because the action has no resource type in the Service Authorization Reference. The broker needs no grant of its own for the check keys: its role already reads and writes the artifact bucket. Named like the transport policies so the
      // qualification-transport unit adds it (prefix E2eQualificationTransport); its policy name is E2eModelDiscovery.
      new iam.CfnPolicy(this, "E2eQualificationTransportDiscovery", {
        policyName: "E2eModelDiscovery",
        roles: [sessions.instanceRoleName],
        policyDocument: {
          Version: "2012-10-17",
          Statement: [
            { Sid: "ListBedrockModels", Effect: "Allow", Action: ["bedrock:ListFoundationModels", "bedrock:ListInferenceProfiles"], Resource: "*" },
            { Sid: "ReadBedrockModelAvailability", Effect: "Allow", Action: "bedrock:GetFoundationModelAvailability", Resource: "*" },
            { Sid: "ReadBedrockInferenceProfiles", Effect: "Allow", Action: "bedrock:GetInferenceProfile", Resource: `arn:${Aws.PARTITION}:bedrock:${Aws.REGION}:${Aws.ACCOUNT_ID}:inference-profile/*` },
            // DEC 432: the worker's quota read (e2e-model-discovery-aws.ts) calls ListServiceQuotas only; the runtime boundary allows exactly that action (it was never allowed before, so the
            // check was AccessDenied on named environments). GetServiceQuota is never called and stays out of the grant and the boundary.
            { Sid: "ListBedrockQuotas", Effect: "Allow", Action: "servicequotas:ListServiceQuotas", Resource: "*" },
          ],
        },
      });
    }
    // AUTOREQUALIFY (AR-2): the machine that renews the browser and API test machine by itself. CDK context agentx:autoRequalify=enabled, off by default
    // (only the exact string "enabled" turns it on); #1131: in every deployment, production included. Its resources all carry the logical-ID prefix RuntimeRequalify, so the
    // requalify-infra deploy unit adds them to a live stack with an Add-only change set. The foundation's values are the stack parameters SessionLifecycle declared.
    if (this.node.tryGetContext(REQUALIFY_CONTEXT_KEY) === "enabled") {
      const foundationValue = (name: string): string => (this.node.findChild(name) as CfnParameter).valueAsString;
      const hour = Number(this.node.tryGetContext("agentx:autoRequalifyHourUtc") ?? REQUALIFY_DEFAULT_HOUR_UTC);
      new RuntimeRequalify(this, "RuntimeRequalify", {
        naming, state, artifacts, invokeSigningKey, operatorTopic: operatorAlerts, notifyOperator,
        catalogIds: { setup: projectSetupRuntimeCatalogId, feature: e2eFeatureRuntimeCatalogId }, controlPlaneUrl: api.attrApiEndpoint,
        foundation: {
          privateSubnetIds: foundationValue("PrivateSubnetIds"), launchTemplateId: foundationValue("Ec2WorkerLaunchTemplateId"), workerRoleArn: foundationValue("Ec2WorkerInstanceRoleArn"),
          workspaceKmsKeyArn: foundationValue("WorkspaceKmsKeyArn"), logGroupName: naming.ec2.workerLogGroupName,
        },
        ...(Number.isInteger(hour) && hour >= 0 && hour <= 23 ? { checkHourUtc: hour } : {}),
        scheduleEnabled: this.node.tryGetContext("agentx:autoRequalifySchedule") === "enabled",
      });
    }
    sessions.steps.addEnvironment("CONTROL_PLANE_URL", api.attrApiEndpoint);
    sessions.connectDispatcher(dispatcher);
    sessions.connectBroker(broker);
    if (naming.env !== undefined) broker.addToRolePolicy(new iam.PolicyStatement({ actions: ["states:StartExecution"], resources: [sessions.deleter.stateMachineArn, swebenchStateMachineArn] }));
    // Lane E2 step 4: the dispatcher is the core dispatch queue's consumer (#1148: in the legacy install too).
    const coreEngine = this.node.tryFindChild("CoreEngineJobs");
    if (coreEngine instanceof CoreEngine) {
      coreEngine.connectDispatcher(dispatcher, {
        deleterArn: sessions.deleter.stateMachineArn, callbackSigningKeySecret: { secretName: callbackSigningKeySecretName, secretArn: callbackSigningKeySecret.secretArn },
        workerSubnets: foundationParameter("Ec2WorkerSubnets"), workerLaunchTemplateId: foundationParameter("Ec2WorkerLaunchTemplateId"),
      });
    }

    // Spec 052 FR-006, FR-011: the eval batch tick. Every 2 minutes it records run ends the broker
    // missed, reconciles the eval slot counter, fills free slots through the broker's own run path
    // (startSwebenchRun: launch.json, then the eval state machine) and writes ended batches'
    // results. It also ends runs whose execution died without ending them (Ruling 13). The schedule
    // stays on: with no batch active a tick is three small DynamoDB reads (and a slot repair when a
    // slot is held), and nothing has to switch it off. Overlapping ticks are safe: every change is a conditional write.
    // Its 90-second timeout, like the broker's 30, must stay well below EVAL_BATCH_STALE_CLAIM_MS (5 minutes,
    // eval-batch.ts): a stale claim is recovered only once the top-up that made it is dead.
    const evalBatchTick = packagedFunction(this, "EvalBatchTick", "packages/broker/src/aws/eval-batch-tick.ts", {
      STATE_TABLE_NAME: state.tableName,
      ARTIFACT_BUCKET_NAME: artifacts.bucketName,
      CALLBACK_SIGNING_KEY_SECRET_ID: callbackSigningKeySecretName,
      SWEBENCH_SETTINGS_PREFIX: naming.ec2.workerSettingsPrefix,
    }, Duration.seconds(90));
    state.grantReadWriteData(evalBatchTick);
    callbackSigningKeyReaders.push(evalBatchTick.role!);
    // #1131: the reconciler signs stuck-cancel retries and the idle backstop's cancels, in every deployment.
    callbackSigningKeyReaders.push(sessions.reconciler.role!);
    callbackSigningKeySecret.addToResourcePolicy(new iam.PolicyStatement({
      sid: "ReadCallbackSigningKey",
      principals: callbackSigningKeyReaders.map((role) => new iam.ArnPrincipal(role.roleArn)),
      actions: ["secretsmanager:GetSecretValue"],
      // In a secret's own policy, "*" is this secret.
      resources: ["*"],
    }));
    // A run's launch.json (evals/<runId>/) and a batch's results (evals/batches/<id>/); it reads nothing there.
    evalBatchTick.addToRolePolicy(new iam.PolicyStatement({ sid: "WriteEvalObjects", actions: ["s3:PutObject"], resources: [artifacts.arnForObjects("evals/*")] }));
    evalBatchTick.addToRolePolicy(new iam.PolicyStatement({ sid: "ReadEvalSettings", actions: ["ssm:GetParameters"], resources: evalSettingArns }));
    evalBatchTick.addToRolePolicy(new iam.PolicyStatement({ sid: "StartEvalRuns", actions: ["states:StartExecution"], resources: [swebenchStateMachineArn] }));
    // Ruling 16: a dead run's instance, ended before the run is charged; this environment's eval instances only.
    evalBatchTick.addToRolePolicy(new iam.PolicyStatement({
      sid: "TerminateDeadEvalInstances",
      actions: ["ec2:TerminateInstances"],
      resources: [`arn:${Aws.PARTITION}:ec2:${Aws.REGION}:${Aws.ACCOUNT_ID}:instance/*`],
      conditions: { StringEquals: { "aws:ResourceTag/DeploymentMode": SWEBENCH_DEPLOYMENT_MODE, "aws:ResourceTag/Environment": naming.environmentTagValue } },
    }));
    // Ruling 13: whether a stuck run's execution is still alive; the eval state machine's executions only.
    evalBatchTick.addToRolePolicy(new iam.PolicyStatement({
      sid: "DescribeEvalRuns",
      actions: ["states:DescribeExecution"],
      resources: [this.formatArn({ service: "states", resource: "execution", resourceName: `${swebenchNames(naming).stateMachineName}:*`, arnFormat: ArnFormat.COLON_RESOURCE_NAME })],
    }));
    new scheduler.Schedule(this, "EvalBatchTickSchedule", {
      description: "Runs the AgentX eval batch tick",
      schedule: scheduler.ScheduleExpression.rate(Duration.minutes(2)),
      target: new schedulerTargets.LambdaInvoke(evalBatchTick, {}),
    });
    new cloudwatch.Alarm(this, "EvalBatchTickErrorsAlarm", {
      alarmName: naming.alarmName("EvalBatchTickErrors"),
      alarmDescription: "The eval batch tick failed in each of the last three 5-minute periods; batches may not start runs, record ends or write results. Check the tick's logs.",
      metric: evalBatchTick.metricErrors({ period: Duration.minutes(5), statistic: "Sum" }),
      threshold: 1,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(notifyOperator);
    // Spec 052 Ruling 31 (review M-2): the eval state machine fails an execution only at its
    // SlotReleaseFailed state, a run it could not end with its slot released. The alarm lives here,
    // where the release deploys it, rather than in the eval stack, which is deployed by hand.
    new cloudwatch.Alarm(this, "EvalExecutionsFailedAlarm", {
      alarmName: naming.alarmName("EvalExecutionsFailed"),
      alarmDescription: "An eval run's execution failed (SlotReleaseFailed): the state machine could not end the run and release its eval slot. The batch tick repairs the slot within minutes; check the execution's cause and the run's record.",
      metric: new cloudwatch.Metric({
        namespace: "AWS/States",
        metricName: "ExecutionsFailed",
        dimensionsMap: { StateMachineArn: this.formatArn({ service: "states", resource: "stateMachine", resourceName: swebenchNames(naming).stateMachineName, arnFormat: ArnFormat.COLON_RESOURCE_NAME }) },
        statistic: "Sum",
        period: Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(notifyOperator);
    // Spec 052 Ruling 31 (review M-1): the Slack service's batch watcher logs each failure as an
    // eval_batch_watch.* error line, which its log group's filter counts (slack-orchestrator.ts).
    // The broker's watch list logs its own (a running batch whose channel is unbound or rebound, a
    // dropped or unreadable batch) the same way, counted here into the same metric (R-1).
    broker.logGroup.addMetricFilter("EvalBatchWatcherFailedMetric", {
      filterPattern: logs.FilterPattern.all(
        logs.FilterPattern.stringValue("$.event", "=", "eval_batch_watch.*"),
        logs.FilterPattern.stringValue("$.level", "=", "error"),
      ),
      metricNamespace: naming.metricsNamespace,
      metricName: "EvalBatchWatcherFailed",
      metricValue: "1",
    });
    new cloudwatch.Alarm(this, "EvalBatchWatcherErrorsAlarm", {
      alarmName: naming.alarmName("EvalBatchWatcherErrors"),
      alarmDescription: "The Slack service's eval batch watcher failed: a batch's thread may miss its progress or summary, or a batch was dropped. Check the Slack orchestrator and broker logs for eval_batch_watch.* errors.",
      metric: agentxSum("EvalBatchWatcherFailed", Duration.minutes(5)),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(notifyOperator);

    // This certifies the installed broker, including installs awaiting their first gateway.
    // Gateway admission is checked separately before configuration or worker activation.
    new CfnOutput(this, "ModelRunPriceVersion", { value: "1", description: "Broker signs task run-price ceilings; deploy gateway before broker before workers" });
    new CfnOutput(this, "ApiEndpoint", { value: api.attrApiEndpoint });
    new CfnOutput(this, "StateTableName", { value: state.tableName });
    new CfnOutput(this, "ArtifactBucketName", { value: artifacts.bucketName });
    new CfnOutput(this, "DispatchDeadLetterQueueUrl", { value: deadLetterQueue.queueUrl });
    new CfnOutput(this, "SlackEventsUrl", { value: `${api.attrApiEndpoint}/v1/slack/events` });
    new CfnOutput(this, "GithubWebhookUrl", { value: `${api.attrApiEndpoint}/v1/github/webhooks` });
    new CfnOutput(this, "SlackInteractivityUrl", { value: `${api.attrApiEndpoint}/v1/slack/interactions` });
    new CfnOutput(this, "SlackSecretArn", { value: slackSecret.secretArn });
    new CfnOutput(this, "SlackRequestQueueUrl", { value: slackRequestQueue.queueUrl });
    new CfnOutput(this, "SlackRequestDeadLetterQueueUrl", { value: slackDeadLetterQueue.queueUrl });
    new CfnOutput(this, "SlackThreadsTableName", { value: slackThreads.tableName });
    new CfnOutput(this, "SlackThreadSessionBucketName", { value: threadSessions.bucketName });
    new CfnOutput(this, "SlackOrchestratorTaskRoleArn", { value: slackOrchestratorRole.roleArn });
    new CfnOutput(this, "TurnRecordsTableName", { value: turnRecords.tableName });
    new CfnOutput(this, "OperatorAlertsTopicArn", { value: operatorAlerts.topicArn });
  }
}

/** A named environment's broker role name. */
export function brokerRoleName(naming: AgentXNaming): string {
  return `${naming.resourcePrefix}-broker-role`;
}

/** A named environment's broker function name. */
export function brokerFunctionName(naming: AgentXNaming): string {
  return `${naming.resourcePrefix}-broker`;
}

export function packagedFunction(
  scope: Construct,
  id: string,
  entry: string,
  environment: Record<string, string>,
  timeout = Duration.seconds(30),
  /** Files copied beside the bundled handler, as [absolute source, name in the bundle]. */
  extraFiles: ReadonlyArray<readonly [string, string]> = [],
  memorySize = 512,
): lambdaNodejs.NodejsFunction {
  return new lambdaNodejs.NodejsFunction(scope, id, {
    runtime: lambda.Runtime.NODEJS_22_X,
    entry: resolve(process.cwd(), entry),
    handler: "handler",
    timeout,
    memorySize,
    tracing: lambda.Tracing.ACTIVE,
    environment,
    logGroup: new logs.LogGroup(scope, `${id}Logs`, {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    }),
    bundling: {
      externalModules: [],
      minify: true,
      sourceMap: true,
      target: "node22",
      ...(extraFiles.length === 0 ? {} : {
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (_inputDir: string, outputDir: string) => extraFiles.map(([source, name]) => `cp "${source}" "${outputDir}/${name}"`),
        },
      }),
    },
  });
}
