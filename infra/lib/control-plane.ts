import { grantOpenRouterSecret } from "./openrouter.js";
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
  aws_lambda_nodejs as lambdaNodejs,
  aws_logs as logs,
  aws_s3 as s3,
  aws_secretsmanager as secretsmanager,
  aws_sns as sns,
  aws_sqs as sqs,
} from "aws-cdk-lib";
import type { Construct } from "constructs";
import { INDEX_EXPIRY_ATTRIBUTE, WORKER_SETTING_PARAMETERS, WORKSPACE_PROJECT_INDEX, WORKSPACE_SESSION_STATE_INDEX } from "@agentx/contracts";
import { type AgentXNaming, legacyNaming } from "./naming.js";
import { DeveloperSignIn, developerSignInParameters } from "./developer-signin.js";
import { DeveloperTaskNotifier } from "./developer-task-notifier.js";
import { SessionLifecycle } from "./session-lifecycle.js";
import { swebenchNames } from "./swebench-eval.js";

const MAX_DISPATCH_ATTEMPTS = 5;
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

export class ControlPlaneStack extends Stack {
  constructor(scope: Construct, id: string, props?: ControlPlaneStackProps) {
    super(scope, id, props);
    const naming = props?.naming ?? legacyNaming();

    const oidcIssuer = new CfnParameter(this, "OidcIssuer", { type: "String" });
    const oidcAudience = new CfnParameter(this, "OidcAudience", { type: "String" });
    const callbackSigningKey = new CfnParameter(this, "CallbackSigningKey", {
      type: "String",
      noEcho: true,
      minLength: 32,
      description: "Random secret used to scope and authenticate worker callbacks",
    });
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
    const githubAppId = new CfnParameter(this, "GitHubAppId", { type: "String" });
    const githubAppPrivateKeySecretArn = new CfnParameter(this, "GitHubAppPrivateKeySecretArn", {
      type: "String",
      description: "Complete Secrets Manager ARN containing the GitHub App private key PEM",
    });
    // Spec 025 phase 25a: declared on the stack itself so the names are exact; named environments only (R3).
    const signInParameters = naming.env === undefined ? undefined : developerSignInParameters(this);

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

    const broker = packagedFunction(this, "Broker", "packages/broker/src/aws/broker.ts", {
      STATE_TABLE_NAME: state.tableName,
      ARTIFACT_BUCKET_NAME: artifacts.bucketName,
      OIDC_ISSUER: oidcIssuer.valueAsString,
      ADMIN_CLAIM: adminClaim.valueAsString,
      ADMIN_VALUES: adminValues.valueAsString,
      CALLBACK_SIGNING_KEY: callbackSigningKey.valueAsString,
      GITHUB_APP_CREDENTIAL_REF: githubAppCredentialRef.valueAsString,
      GITHUB_APP_ID: githubAppId.valueAsString,
      GITHUB_APP_PRIVATE_KEY_SECRET_ARN: githubAppPrivateKeySecretArn.valueAsString,
    });
    state.grantReadWriteData(broker);
    artifacts.grantReadWrite(broker);
    broker.addToRolePolicy(new iam.PolicyStatement({
      actions: ["secretsmanager:GetSecretValue"],
      resources: [githubAppPrivateKeySecretArn.valueAsString],
    }));
    broker.addToRolePolicy(new iam.PolicyStatement({
      actions: ["secretsmanager:GetSecretValue"],
      resources: [this.formatArn({ service: "secretsmanager", resource: "secret", resourceName: `${naming.connectorSecretPrefix}*`, arnFormat: ArnFormat.COLON_RESOURCE_NAME })],
    }));
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
    if (naming.env !== undefined) broker.addEnvironment("CONNECTOR_SECRET_PREFIX", naming.connectorSecretPrefix);
    // Spec 043: SWE-bench runs. The broker reads the optional eval stack's settings, the runner image
    // and the worker model per request, and starts the eval state machine by its fixed name; both
    // exist only once the eval stack is deployed, and until then a run is refused as not installed.
    broker.addEnvironment("SWEBENCH_SETTINGS_PREFIX", naming.ec2.workerSettingsPrefix);
    broker.addToRolePolicy(new iam.PolicyStatement({
      actions: ["ssm:GetParameters"],
      resources: [
        swebenchNames(naming).settingsParameterName,
        swebenchNames(naming).runnerImageParameterName,
        ...Object.values(WORKER_SETTING_PARAMETERS).map((name) => `${naming.ec2.workerSettingsPrefix}${name}`),
      ].map((name) => `arn:${Aws.PARTITION}:ssm:${Aws.REGION}:${Aws.ACCOUNT_ID}:parameter${name}`),
    }));
    broker.addToRolePolicy(new iam.PolicyStatement({
      actions: ["states:StartExecution"],
      resources: [this.formatArn({ service: "states", resource: "stateMachine", resourceName: swebenchNames(naming).stateMachineName, arnFormat: ArnFormat.COLON_RESOURCE_NAME })],
    }));

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
        MAX_DISPATCH_ATTEMPTS: String(MAX_DISPATCH_ATTEMPTS),
      },
      Duration.seconds(60),
    );
    dispatchQueue.grantConsumeMessages(dispatcher);
    state.grantReadWriteData(dispatcher);
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
    broker.addEnvironment("TURN_RECORDS_TABLE_NAME", turnRecords.tableName);

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
    if (naming.env !== undefined) broker.addEnvironment("AGENTX_METRICS_NAMESPACE", naming.metricsNamespace);
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
    // Issue #46, named environments only: a dispatch job that exhausts its receives lands here and
    // nothing else reports it. The legacy AgentXControlPlane template stays as it is.
    if (naming.env !== undefined) {
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

    broker.addEnvironment("SLACK_ORCHESTRATOR_ROLE_ARN", slackOrchestratorRole.roleArn);
    broker.addEnvironment("SLACK_MEMBER_WORKSPACE_LIMIT", memberWorkspaceLimit.valueAsString);
    broker.addEnvironment("SLACK_ORGANIZATION_WORKSPACE_LIMIT", organizationWorkspaceLimit.valueAsString);

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
    const defaultStage = new apigwv2.CfnStage(this, "DefaultStage", {
      apiId: api.ref,
      stageName: "$default",
      autoDeploy: true,
    });
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

    // Spec 025 phase 25a: developer sign-in, named environments only (R3).
    if (naming.env !== undefined && signInParameters !== undefined) {
      new DeveloperSignIn(this, "DeveloperSignIn", {
        naming, env: naming.env, api, stage: defaultStage, brokerIntegration: integration, broker, slackSecret, parameters: signInParameters, turnRecords,
      });
      // Spec 025 phase 25c: sharing, named environments only (D14).
      const notifier = new DeveloperTaskNotifier(this, "DeveloperTaskNotifier", { naming, state, slackSecret, notifyOperator });
      // Spec 025 A13: the admin health route reads the environment's alarms, by name prefix, and
      // the depths of its dead-letter queues. Read-only, and on exactly these resources.
      const alarmPrefix = naming.alarmName("");
      broker.addEnvironment("AGENTX_ALARM_PREFIX", alarmPrefix);
      broker.addToRolePolicy(new iam.PolicyStatement({
        actions: ["cloudwatch:DescribeAlarms"],
        resources: [`arn:${this.partition}:cloudwatch:${this.region}:${this.account}:alarm:${alarmPrefix}*`],
      }));
      const deadLetterQueues = { dispatch: deadLetterQueue, "slack-requests": slackDeadLetterQueue, "developer-notices": notifier.deadLetters, "developer-notice-stream": notifier.streamFailures };
      broker.addEnvironment("HEALTH_DEAD_LETTER_QUEUES", this.toJsonString(Object.fromEntries(Object.entries(deadLetterQueues).map(([name, queue]) => [name, queue.queueUrl]))));
      broker.addToRolePolicy(new iam.PolicyStatement({
        actions: ["sqs:GetQueueAttributes"],
        resources: Object.values(deadLetterQueues).map((queue) => queue.queueArn),
      }));
      // C10: the ingress reads shared thread records by key; its SLACK_BINDING# statement is unchanged.
      slackIngress.addEnvironment("SHARED_TASKS", "enabled");
      slackIngress.addToRolePolicy(new iam.PolicyStatement({
        actions: ["dynamodb:GetItem"],
        resources: [state.tableArn],
        conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["SHARED_TASK#*"] } },
      }));
      // Spec 025 E14 (C14): the interactivity route hands Slack Confirm and Cancel presses to the broker.
      slackIngress.addEnvironment("ADMIN_CHANGES", "enabled");
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
      broker.addEnvironment("SLACK_THREADS_TABLE_NAME", slackThreads.tableName);
      broker.addToRolePolicy(new iam.PolicyStatement({
        actions: ["dynamodb:GetItem"],
        resources: [slackThreads.tableArn],
        conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["THREAD#*"] } },
      }));
    }

    const sessions = new SessionLifecycle(this, "Sessions", { naming, state, invokeSigningKey, notifyOperator });
    // A6: where the State table expires index items itself, the reconciler's legacy sweep is off.
    if (naming.env !== undefined) sessions.reconciler.addEnvironment("INDEX_EXPIRY", "ttl");
    // Issue 195: a stuck cancel on a live worker is queued again through the broker. Named
    // environments only: the legacy template is unchanged, and its reconciler only logs and counts.
    if (naming.env !== undefined) sessions.connectStuckCancelRetry(broker);
    // Issue 173: the backstop for idle Slack tasks nobody waits on. Named environments only: the
    // legacy template is unchanged.
    if (naming.env !== undefined) sessions.connectUnwaitedTaskBackstop(slackThreads, slackSecret, callbackSigningKey.valueAsString);
    // Own both attachments in this releasable stack. Secret changes must never mutate the
    // protected foundation template or require a separate foundation change set.
    grantOpenRouterSecret(this, [slackOrchestratorRole.roleName, sessions.instanceRoleName]);
    sessions.steps.addEnvironment("CONTROL_PLANE_URL", api.attrApiEndpoint);
    sessions.connectDispatcher(dispatcher);
    sessions.connectBroker(broker);

    new CfnOutput(this, "ApiEndpoint", { value: api.attrApiEndpoint });
    new CfnOutput(this, "StateTableName", { value: state.tableName });
    new CfnOutput(this, "ArtifactBucketName", { value: artifacts.bucketName });
    new CfnOutput(this, "DispatchDeadLetterQueueUrl", { value: deadLetterQueue.queueUrl });
    new CfnOutput(this, "SlackEventsUrl", { value: `${api.attrApiEndpoint}/v1/slack/events` });
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

export function packagedFunction(
  scope: Construct,
  id: string,
  entry: string,
  environment: Record<string, string>,
  timeout = Duration.seconds(30),
  /** Files copied beside the bundled handler, as [absolute source, name in the bundle]. */
  extraFiles: ReadonlyArray<readonly [string, string]> = [],
): lambdaNodejs.NodejsFunction {
  return new lambdaNodejs.NodejsFunction(scope, id, {
    runtime: lambda.Runtime.NODEJS_22_X,
    entry: resolve(process.cwd(), entry),
    handler: "handler",
    timeout,
    memorySize: 512,
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
