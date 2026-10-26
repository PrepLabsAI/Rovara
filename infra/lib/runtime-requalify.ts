import { resolve } from "node:path";
import {
  Aws,
  Duration,
  RemovalPolicy,
  Stack,
  aws_cloudwatch as cloudwatch,
  type aws_cloudwatch_actions as cloudwatchActions,
  type aws_dynamodb as dynamodb,
  aws_iam as iam,
  type aws_kms as kms,
  type aws_lambda as lambda,
  aws_logs as logs,
  type aws_s3 as s3,
  aws_scheduler as scheduler,
  aws_scheduler_targets as schedulerTargets,
  type aws_sns as sns,
  aws_stepfunctions as sfn,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import { QUALIFIED_AMI_SETTING_NAME, REQUALIFY_TAGS, WORKER_SETTING_PARAMETERS, WORKSPACE_SESSION_STATE_INDEX } from "@agentx/contracts";
import { packagedFunction } from "./control-plane.js";
import { EC2_WORKER_AMI_PARAMETER } from "./ec2-workers.js";
import type { AgentXNaming } from "./naming.js";

/**
 * AUTOREQUALIFY infrastructure (AR-2): the Step Functions machine that renews the browser and API test machine, the one Lambda it calls, the daily check
 * and the alarms. Mounted only where the CDK context `agentx:autoRequalify` is exactly "enabled" (TEST only until a release says otherwise); all of its
 * resources carry the logical-ID prefix `RuntimeRequalify`, so the `requalify-infra` deploy unit adds them to a live stack with an Add-only change set.
 *
 * The daily schedule is created DISABLED (AR-5 review I1): nothing renews by itself until the owner has deployed the code, tagged the current runner and run one renewal by hand.
 *
 * Authority (design section 4): the Lambda may launch only from this environment's launch template and only with the three renewal tags, and may terminate
 * an instance or delete a volume only if it carries all three tags. It has no `kms:Sign`, no Secrets Manager and no wildcard on a destructive action.
 */

export const REQUALIFY_CONTEXT_KEY = "agentx:autoRequalify";
export const REQUALIFY_LOGICAL_ID_PREFIX = "RuntimeRequalify";
/** Hour (UTC) of the daily check unless the context `agentx:autoRequalifyHourUtc` says otherwise. */
export const REQUALIFY_DEFAULT_HOUR_UTC = 6;
/** Whole-execution bound of the machine. */
export const REQUALIFY_MACHINE_TIMEOUT = Duration.hours(3);
const POLL_SECONDS = 30;
const RETIRE_GRACE_SECONDS = 600;

export interface RuntimeRequalifyProps {
  naming: AgentXNaming;
  state: dynamodb.Table;
  artifacts: s3.Bucket;
  invokeSigningKey: kms.IKey;
  operatorTopic: sns.ITopic;
  notifyOperator: cloudwatchActions.SnsAction;
  catalogIds: { setup: string; feature: string };
  controlPlaneUrl: string;
  /** The foundation's values the control plane already receives as stack parameters (resolved tokens). */
  foundation: { privateSubnetIds: string; launchTemplateId: string; workerRoleArn: string; workspaceKmsKeyArn: string; logGroupName: string };
  checkHourUtc?: number;
  /** The daily check is created disabled: infrastructure that exists must not start a renewal by itself. The owner enables it after the live check (test-deploy `requalify-schedule`, or this flag in CDK). */
  scheduleEnabled?: boolean;
}

type Task = { Type: "Task"; Resource: string; Parameters: object; OutputPath: string; Retry: object[]; Catch: object[]; Next: string };

/** The machine. Every Task passes the whole state (identifiers, times, fixed codes only: never the challenge secret) and gets it back with its phase filled in. */
export function requalifyDefinition(lambdaArn: string): object {
  const lambdaRetry = { ErrorEquals: ["Lambda.ServiceException", "Lambda.AWSLambdaException", "Lambda.SdkClientException", "Lambda.TooManyRequestsException"], IntervalSeconds: 2, MaxAttempts: 3, BackoffRate: 2 };
  const pollRetry = { ErrorEquals: ["States.TaskFailed"], IntervalSeconds: 15, MaxAttempts: 2, BackoffRate: 2 };
  const states: Record<string, object> = {};
  const task = (name: string, action: string, next: string, onError: string, retryTaskFailures = false): void => {
    const state: Task = {
      Type: "Task", Resource: "arn:aws:states:::lambda:invoke", Parameters: { FunctionName: lambdaArn, Payload: { action, "state.$": "$" } }, OutputPath: "$.Payload",
      Retry: retryTaskFailures ? [lambdaRetry, pollRetry] : [lambdaRetry], Catch: [{ ErrorEquals: ["States.ALL"], ResultPath: "$.error", Next: onError }], Next: next,
    };
    states[name] = state;
  };
  const reason = (name: string, code: string, next = "FailAlert"): void => { states[name] = { Type: "Pass", Result: code, ResultPath: "$.reason", Next: next }; };
  /** A polling phase: ask, then proceed, wait, or take the failure reasons. `statusPath` is where the action leaves its answer. */
  const poll = (name: string, action: string, statusPath: string, next: string, onFailed: string, onTimeout: string, onError: string, onUnexpected = "ReasonUnexpected"): void => {
    task(name, action, `${name}Choice`, onError, true);
    states[`${name}Choice`] = {
      Type: "Choice",
      Choices: [
        { Variable: statusPath, StringEquals: "ready", Next: next },
        { Variable: statusPath, StringEquals: "waiting", Next: `${name}Wait` },
        { Variable: statusPath, StringEquals: "failed", Next: onFailed },
        { Variable: statusPath, StringEquals: "timeout", Next: onTimeout },
      ],
      Default: onUnexpected,
    };
    states[`${name}Wait`] = { Type: "Wait", Seconds: POLL_SECONDS, Next: name };
  };

  task("Lock", "lock", "LockChoice", "ReasonUnexpected");
  states["LockChoice"] = { Type: "Choice", Choices: [{ Variable: "$.lock.acquired", BooleanEquals: true, Next: "Preflight" }], Default: "NotAcquired" };
  states["NotAcquired"] = { Type: "Succeed" };
  task("Preflight", "preflight", "PreflightChoice", "ReasonLaunchFailed");
  states["PreflightChoice"] = { Type: "Choice", Choices: [{ Variable: "$.preflight.refused", IsPresent: true, Next: "ReasonCostGuard" }], Default: "PinAmi" };
  task("PinAmi", "pinAmi", "CreateVolume", "ReasonLaunchFailed");
  task("CreateVolume", "createVolume", "AwaitVolume", "ReasonLaunchFailed");
  poll("AwaitVolume", "awaitVolume", "$.volume.status", "RunInstance", "ReasonLaunchFailed", "ReasonLaunchFailed", "ReasonLaunchFailed");
  task("RunInstance", "runInstance", "AttachVolume", "ReasonLaunchFailed");
  poll("AttachVolume", "attachVolume", "$.instance.attachStatus", "AwaitReady", "ReasonLaunchFailed", "ReasonLaunchFailed", "ReasonLaunchFailed");
  poll("AwaitReady", "awaitReady", "$.instance.readyStatus", "IssueChallenge", "ReasonNotReady", "ReasonNotReady", "ReasonNotReady");
  task("IssueChallenge", "issueChallenge", "AwaitQualification", "ReasonQualificationFailed");
  poll("AwaitQualification", "awaitQualification", "$.qualification.status", "PutHold", "ReasonQualificationFailed", "ReasonQualificationFailed", "ReasonQualificationFailed");
  task("PutHold", "putHold", "AwaitDrain", "ReasonDrainTimeout");
  poll("AwaitDrain", "awaitDrain", "$.drain.status", "Switch", "ReasonDrainTimeout", "ReasonDrainTimeout", "ReasonDrainTimeout");
  // The switch may have committed even though the step failed (a timeout, a lost answer): the recovery step finds out from the audit record.
  task("Switch", "switch", "SwitchChoice", "RecoverSwitch");
  task("RecoverSwitch", "recoverSwitch", "RecoverChoice", "ReasonUnexpected");
  states["RecoverChoice"] = { Type: "Choice", Choices: [{ Variable: "$.switch.switched", BooleanEquals: true, Next: "RecordAmi" }], Default: "ReasonUnexpected" };
  states["SwitchChoice"] = { Type: "Choice", Choices: [{ Variable: "$.switch.switched", BooleanEquals: true, Next: "RecordAmi" }], Default: "ReasonSettingsChanged" };
  // From here the new runner serves. A failure alerts and cleans up the old runner; it never ends the new one (the failure steps check the switch and the pointer).
  task("RecordAmi", "recordAmi", "RetireGrace", "ReasonRetireFailed");
  states["RetireGrace"] = { Type: "Wait", Seconds: RETIRE_GRACE_SECONDS, Next: "TerminatePrevious" };
  task("TerminatePrevious", "terminatePrevious", "AwaitTerminatedPrevious", "ReasonRetireFailed");
  poll("AwaitTerminatedPrevious", "awaitTerminatedPrevious", "$.previousTermination.status", "Complete", "ReasonRetireFailed", "ReasonRetireFailed", "ReasonRetireFailed");
  task("Complete", "complete", "Done", "ReasonRetireFailed");
  states["Done"] = { Type: "Succeed" };

  reason("ReasonUnexpected", "unexpected-error");
  reason("ReasonLaunchFailed", "launch-failed");
  reason("ReasonCostGuard", "cost-guard");
  reason("ReasonNotReady", "not-ready");
  reason("ReasonQualificationFailed", "qualification-failed");
  reason("ReasonDrainTimeout", "drain-timeout");
  reason("ReasonSettingsChanged", "settings-changed");
  reason("ReasonRetireFailed", "retire-failed");
  // The failure path: one alert, end the new runner (only if the switch did not commit), release the lock. The old runner and the registered rows are never touched.
  task("FailAlert", "failAlert", "TerminateNew", "TerminateNew");
  task("TerminateNew", "terminateNew", "TerminateNewChoice", "CleanupFailedReason");
  // Nothing was launched (a refusal before the launch): there is nothing to end.
  states["TerminateNewChoice"] = { Type: "Choice", Choices: [{ Variable: "$.newTermination", IsPresent: true, Next: "AwaitTerminatedNew" }], Default: "ReleaseLock" };
  poll("AwaitTerminatedNew", "awaitTerminatedNew", "$.newTermination.status", "ReleaseLock", "CleanupFailedReason", "CleanupFailedReason", "CleanupFailedReason", "CleanupFailedReason");
  reason("CleanupFailedReason", "retire-failed", "CleanupAlert");
  task("CleanupAlert", "failAlert", "ReleaseLock", "ReleaseLock");
  task("ReleaseLock", "releaseLock", "Failed", "LockStuck");
  // The run did not finish its job: the execution ends Succeeded because the alert above is the report; a lock that could not be released is the one real failure.
  states["Failed"] = { Type: "Succeed" };
  states["LockStuck"] = { Type: "Fail", Error: "RequalifyLockNotReleased", Cause: "The renewal lock could not be released; it expires on its own." };

  return { Comment: "AgentX test machine renewal", StartAt: "Lock", TimeoutSeconds: REQUALIFY_MACHINE_TIMEOUT.toSeconds(), States: states };
}

export class RuntimeRequalify extends Construct {
  readonly steps: lambda.Function;
  readonly machine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: RuntimeRequalifyProps) {
    super(scope, id);
    const stack = Stack.of(this);
    const { naming, foundation } = props;
    const environment = naming.environmentTagValue;
    const machineName = `${naming.resourcePrefix}-runtime-requalify`;
    // Spelled out rather than referenced: the Lambda starts the machine and the machine calls the Lambda, and a reference both ways would be a cycle.
    const machineArn = `arn:${Aws.PARTITION}:states:${Aws.REGION}:${Aws.ACCOUNT_ID}:stateMachine:${machineName}`;
    const ec2Arn = (resource: string) => `arn:${Aws.PARTITION}:ec2:${Aws.REGION}:${Aws.ACCOUNT_ID}:${resource}`;
    const templateArn = ec2Arn(`launch-template/${foundation.launchTemplateId}`);
    const tagged = (prefix: "aws:RequestTag" | "aws:ResourceTag") => ({
      [`${prefix}/${REQUALIFY_TAGS.deploymentModeKey}`]: REQUALIFY_TAGS.deploymentModeValue,
      [`${prefix}/${REQUALIFY_TAGS.environmentKey}`]: environment,
      [`${prefix}/${REQUALIFY_TAGS.managedKey}`]: REQUALIFY_TAGS.managedValue,
    });

    this.steps = packagedFunction(this, "Steps", "packages/broker/src/aws/runtime-requalify-handler.ts", {
      STATE_TABLE_NAME: props.state.tableName,
      ARTIFACT_BUCKET_NAME: props.artifacts.bucketName,
      AGENTX_PROJECT_SETUP_RUNTIME_CATALOG_ID: props.catalogIds.setup,
      AGENTX_E2E_FEATURE_RUNTIME_CATALOG_ID: props.catalogIds.feature,
      REQUALIFY_ENVIRONMENT: environment,
      REQUALIFY_STATE_MACHINE_ARN: machineArn,
      PRIVATE_SUBNET_IDS: foundation.privateSubnetIds,
      EC2_WORKER_LAUNCH_TEMPLATE_ID: foundation.launchTemplateId,
      EC2_WORKER_ROLE_ARN: foundation.workerRoleArn,
      WORKER_SETTINGS_PREFIX: naming.ec2.workerSettingsPrefix,
      AMI_PARAMETER_NAME: EC2_WORKER_AMI_PARAMETER,
      CONTROL_PLANE_URL: props.controlPlaneUrl,
      WORKER_LOG_GROUP_NAME: foundation.logGroupName,
      INVOKE_SIGNING_KEY_ARN: props.invokeSigningKey.keyArn,
      OPERATOR_TOPIC_ARN: props.operatorTopic.topicArn,
      AGENTX_METRICS_NAMESPACE: naming.metricsNamespace,
    }, Duration.minutes(5), [[resolve(process.cwd(), "packages/worker/ec2/boot.sh"), "boot.sh"]]);

    const grant = (statement: iam.PolicyStatementProps) => this.steps.addToRolePolicy(new iam.PolicyStatement(statement));
    // Launch: only from this environment's template, only with the three tags.
    grant({ sid: "LaunchFromTemplate", actions: ["ec2:RunInstances"], resources: [ec2Arn("instance/*")],
      conditions: { ArnEquals: { "ec2:LaunchTemplate": templateArn }, StringEquals: tagged("aws:RequestTag") } });
    grant({ sid: "LaunchResources", actions: ["ec2:RunInstances"], resources: [templateArn, ec2Arn("subnet/*"), ec2Arn("security-group/*"), ec2Arn("network-interface/*"), ec2Arn("volume/*")] });
    grant({ sid: "LaunchAmazonImages", actions: ["ec2:RunInstances"], resources: [`arn:${Aws.PARTITION}:ec2:${Aws.REGION}::image/*`], conditions: { StringEquals: { "ec2:Owner": "amazon" } } });
    grant({ sid: "CreateWorkspaceVolume", actions: ["ec2:CreateVolume"], resources: [ec2Arn("volume/*")], conditions: { StringEquals: tagged("aws:RequestTag") } });
    grant({ sid: "TagOnCreate", actions: ["ec2:CreateTags"], resources: [ec2Arn("volume/*"), ec2Arn("instance/*")], conditions: { StringEquals: { "ec2:CreateAction": ["CreateVolume", "RunInstances"] } } });
    // Attach, end and delete: only resources carrying all three tags for this environment. Nothing else is touchable.
    grant({ sid: "AttachOwn", actions: ["ec2:AttachVolume"], resources: [ec2Arn("instance/*"), ec2Arn("volume/*")], conditions: { StringEquals: tagged("aws:ResourceTag") } });
    grant({ sid: "TerminateOwn", actions: ["ec2:TerminateInstances"], resources: [ec2Arn("instance/*")], conditions: { StringEquals: tagged("aws:ResourceTag") } });
    grant({ sid: "DeleteOwnVolumes", actions: ["ec2:DeleteVolume"], resources: [ec2Arn("volume/*")], conditions: { StringEquals: tagged("aws:ResourceTag") } });
    grant({ sid: "Describe", actions: ["ec2:DescribeInstances", "ec2:DescribeVolumes", "ec2:DescribeLaunchTemplateVersions", "ec2:DescribeSubnets"], resources: ["*"] });
    // EBS encrypts the root and workspace volumes with the foundation's key on the caller's behalf.
    // Only through EC2 (EBS), and grants only for AWS resources: the role cannot use the workspace key for anything else.
    const viaEc2 = { "kms:ViaService": `ec2.${Aws.REGION}.amazonaws.com` };
    grant({ sid: "EncryptVolumes", actions: ["kms:Decrypt", "kms:DescribeKey", "kms:GenerateDataKeyWithoutPlaintext", "kms:ReEncrypt*"], resources: [foundation.workspaceKmsKeyArn], conditions: { StringEquals: viaEc2 } });
    grant({ sid: "GrantEbsAccess", actions: ["kms:CreateGrant"], resources: [foundation.workspaceKmsKeyArn], conditions: { StringEquals: viaEc2, Bool: { "kms:GrantIsForAWSResource": "true" } } });
    grant({ sid: "PassWorkerRole", actions: ["iam:PassRole"], resources: [foundation.workerRoleArn], conditions: { StringEquals: { "iam:PassedToService": "ec2.amazonaws.com" } } });
    grant({ sid: "ReadWorkerRole", actions: ["iam:GetRole"], resources: [foundation.workerRoleArn] });
    // Settings: read the AMI and the worker settings, write the one qualified-AMI setting. No decryption.
    const settingsArn = (name: string) => `arn:${Aws.PARTITION}:ssm:${Aws.REGION}:${Aws.ACCOUNT_ID}:parameter${naming.ec2.workerSettingsPrefix}${name}`;
    grant({ sid: "ReadAmiParameter", actions: ["ssm:GetParameter"], resources: [`arn:${Aws.PARTITION}:ssm:${Aws.REGION}::parameter${EC2_WORKER_AMI_PARAMETER}`] });
    grant({ sid: "ReadWorkerSettings", actions: ["ssm:GetParameters"], resources: Object.values(WORKER_SETTING_PARAMETERS).map(settingsArn) });
    grant({ sid: "WriteQualifiedAmi", actions: ["ssm:PutParameter"], resources: [settingsArn(QUALIFIED_AMI_SETTING_NAME)] });
    // The invoke public key goes into the runner's user data. Public key only: never kms:Sign.
    grant({ sid: "ReadInvokePublicKey", actions: ["kms:GetPublicKey"], resources: [props.invokeSigningKey.keyArn] });
    // The transport: the runner's objects, the content-addressed evidence, and a prefix-scoped listing so a missing object reads as missing.
    grant({ sid: "RunnerObjects", actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], resources: [props.artifacts.arnForObjects("e2e-runtime/*")] });
    grant({ sid: "RuntimeEvidence", actions: ["s3:GetObject", "s3:PutObject"], resources: [props.artifacts.arnForObjects("runtime-installations/sha256/*")] });
    grant({ sid: "ListRunnerObjects", actions: ["s3:ListBucket"], resources: [props.artifacts.bucketArn], conditions: { StringLike: { "s3:prefix": ["e2e-runtime/*"] } } });
    // The state table, by key: the catalog rows, challenges, evidence, the renewal's own rows and the model-check runner pointer.
    grant({
      sid: "RenewalState", actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:ConditionCheckItem"], resources: [props.state.tableArn],
      conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["E2E_FEATURE_VERIFIER#*", "RUNTIME_INSTALL_CHALLENGE#*", "RUNTIME_INSTALLATION_EVIDENCE#*", "RUNTIME_REQUALIFY*", "E2E_MODEL_ROUTES"] } },
    });
    // The drain (AR-3), read only: the READY sessions (index), their workspaces' operations, the setup-run markers and the setup executions' state.
    grant({
      sid: "DrainRead", actions: ["dynamodb:Query", "dynamodb:GetItem"], resources: [props.state.tableArn, `${props.state.tableArn}/index/${WORKSPACE_SESSION_STATE_INDEX.name}`],
      conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["READY", "WORKSPACE#*", "RUNTIME_REQUALIFY_WORK#*", "PROJECT_SETUP#*"] } },
    });
    grant({ sid: "AlertOperator", actions: ["sns:Publish"], resources: [props.operatorTopic.topicArn] });
    grant({ sid: "Metrics", actions: ["cloudwatch:PutMetricData"], resources: ["*"], conditions: { StringEquals: { "cloudwatch:namespace": naming.metricsNamespace } } });
    grant({ sid: "StartRenewal", actions: ["states:StartExecution"], resources: [machineArn] });

    const role = new iam.Role(this, "MachineRole", {
      assumedBy: new iam.ServicePrincipal("states.amazonaws.com", { conditions: { StringEquals: { "aws:SourceAccount": Aws.ACCOUNT_ID } } }),
      description: "AgentX test machine renewal",
    });
    this.steps.grantInvoke(role);
    this.machine = new sfn.StateMachine(this, "Machine", {
      stateMachineName: machineName,
      definitionBody: sfn.DefinitionBody.fromString(stack.toJsonString(requalifyDefinition(this.steps.functionArn))),
      role,
      timeout: REQUALIFY_MACHINE_TIMEOUT,
      logs: { destination: new logs.LogGroup(this, "MachineLogs", { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY }), level: sfn.LogLevel.ERROR, includeExecutionData: false },
    });

    // The schedule's own role, in this construct: the one the scheduler target would otherwise share is a stack-level resource outside the Add-only prefix.
    const scheduleRole = new iam.Role(this, "ScheduleRole", { assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com", { conditions: { StringEquals: { "aws:SourceAccount": Aws.ACCOUNT_ID } } }) });
    this.steps.grantInvoke(scheduleRole);
    new scheduler.Schedule(this, "DailyCheck", {
      description: "Starts the test machine renewal when the registered runtime is close to expiry or the deployed images changed",
      enabled: props.scheduleEnabled === true,
      schedule: scheduler.ScheduleExpression.cron({ minute: "0", hour: String(props.checkHourUtc ?? REQUALIFY_DEFAULT_HOUR_UTC) }),
      target: new schedulerTargets.LambdaInvoke(this.steps, { role: scheduleRole, input: scheduler.ScheduleTargetInput.fromObject({ action: "due" }) }),
    });

    const alarm = (alarmId: string, suffix: string, description: string, metric: cloudwatch.IMetric, periods: number, comparison: cloudwatch.ComparisonOperator, threshold: number, missing: cloudwatch.TreatMissingData) =>
      new cloudwatch.Alarm(this, alarmId, {
        alarmName: naming.alarmName(suffix), alarmDescription: description, metric, threshold, evaluationPeriods: periods, comparisonOperator: comparison, treatMissingData: missing,
      }).addAlarmAction(props.notifyOperator);
    alarm("StepErrorsAlarm", "RuntimeRequalifyStepErrors", "A step of the automatic test machine renewal raised an error twice in a row. Check the renewal Lambda's logs and the failed execution.",
      this.steps.metricErrors({ period: Duration.minutes(15), statistic: "Sum" }), 2, cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD, 1, cloudwatch.TreatMissingData.NOT_BREACHING);
    alarm("MachineFailuresAlarm", "RuntimeRequalifyMachineFailures", "A test machine renewal execution failed or timed out without cleaning up. Open it in Step Functions.",
      new cloudwatch.MathExpression({ expression: "FILL(failed, 0) + FILL(timedOut, 0)", usingMetrics: { failed: this.machine.metricFailed({ period: Duration.minutes(5) }), timedOut: this.machine.metricTimedOut({ period: Duration.minutes(5) }) }, period: Duration.minutes(5) }),
      1, cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD, 1, cloudwatch.TreatMissingData.NOT_BREACHING);
    // No success for six days. Missing data is NOT breaching: until the owner enables the schedule (or a first renewal ran) the metric does not exist and the owner must not be mailed; the runtime-expiry check covers a renewal nobody started.
    alarm("StaleAlarm", "RuntimeRequalifyStale", "The browser and API test machine has not been renewed for six days; its registration expires after seven. Run test-deploy --only requalify-now or qualify by hand.",
      new cloudwatch.Metric({ namespace: naming.metricsNamespace, metricName: "RequalifySucceeded", statistic: "Sum", period: Duration.days(1) }), 6, cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD, 1, cloudwatch.TreatMissingData.NOT_BREACHING);
  }
}
