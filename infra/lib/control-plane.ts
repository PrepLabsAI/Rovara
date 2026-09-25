import { resolve } from "node:path";
import {
  ArnFormat,
  CfnOutput,
  CfnParameter,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
  aws_apigatewayv2 as apigwv2,
  aws_cloudwatch as cloudwatch,
  aws_cloudwatch_actions as cloudwatchActions,
  aws_dynamodb as dynamodb,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_lambda_nodejs as lambdaNodejs,
  aws_logs as logs,
  aws_s3 as s3,
  aws_secretsmanager as secretsmanager,
  aws_sns as sns,
  aws_sqs as sqs,
} from "aws-cdk-lib";
import type { Construct } from "constructs";

const MAX_DISPATCH_ATTEMPTS = 5;
// Matches MAX_RECEIVE_COUNT in packages/slack-service, which reports the final attempt in the thread.
export const SLACK_MAX_RECEIVE_COUNT = 5;

export class ControlPlaneStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

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
    const githubAppAccount = new CfnParameter(this, "GitHubAppAccount", { type: "String" });
    const githubAppId = new CfnParameter(this, "GitHubAppId", { type: "String" });
    const githubAppInstallationId = new CfnParameter(this, "GitHubAppInstallationId", {
      type: "String",
    });
    const githubAppPrivateKeySecretArn = new CfnParameter(this, "GitHubAppPrivateKeySecretArn", {
      type: "String",
      description: "Complete Secrets Manager ARN containing the GitHub App private key PEM",
    });

    const state = new dynamodb.Table(this, "State", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const artifacts = new s3.Bucket(this, "Artifacts", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
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
      GITHUB_APP_ACCOUNT: githubAppAccount.valueAsString,
      GITHUB_APP_ID: githubAppId.valueAsString,
      GITHUB_APP_INSTALLATION_ID: githubAppInstallationId.valueAsString,
      GITHUB_APP_PRIVATE_KEY_SECRET_ARN: githubAppPrivateKeySecretArn.valueAsString,
    });
    state.grantReadWriteData(broker);
    artifacts.grantReadWrite(broker);
    broker.addToRolePolicy(new iam.PolicyStatement({
      actions: ["bedrock-agentcore:StopRuntimeSession"],
      resources: [runtimeArn(this)],
    }));
    broker.addToRolePolicy(new iam.PolicyStatement({
      actions: ["bedrock-agentcore:DeleteCapacityProviderSession"],
      resources: [this.formatArn({ service: "bedrock-agentcore", resource: "capacity-provider", resourceName: "*" })],
    }));
    broker.addToRolePolicy(new iam.PolicyStatement({
      actions: ["secretsmanager:GetSecretValue"],
      resources: [githubAppPrivateKeySecretArn.valueAsString],
    }));
    broker.addToRolePolicy(new iam.PolicyStatement({
      actions: ["secretsmanager:GetSecretValue"],
      resources: [this.formatArn({ service: "secretsmanager", resource: "secret", resourceName: "agentx/connectors/*", arnFormat: ArnFormat.COLON_RESOURCE_NAME })],
    }));
    broker.addToRolePolicy(new iam.PolicyStatement({
      actions: ["codebuild:StartBuild", "codebuild:BatchGetBuilds"],
      resources: [this.formatArn({ service: "codebuild", resource: "project", resourceName: "agentx-*" })],
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
    dispatcher.addToRolePolicy(new iam.PolicyStatement({
      actions: ["bedrock-agentcore:InvokeAgentRuntime"],
      resources: [runtimeArn(this)],
    }));
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
      description: "AgentX Slack app credentials as JSON: {\"signingSecret\":\"...\",\"botToken\":\"xoxb-...\"}",
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ botToken: "unset" }),
        generateStringKey: "signingSecret",
        excludePunctuation: true,
      },
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const slackThreads = new dynamodb.Table(this, "SlackThreads", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      timeToLiveAttribute: "expiresAt",
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
    // Admin-only: the broker reads it for the admin export and nothing else can.
    const turnRecords = new dynamodb.Table(this, "TurnRecords", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      timeToLiveAttribute: "expiresAt",
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
      topicName: "AgentXOperatorAlerts",
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
    const notifyOperator = new cloudwatchActions.SnsAction(operatorAlerts);
    // The broker publishes these in embedded metric format with a dimensionless series as well as a
    // per-connector one; the alarms read the dimensionless series, so they cover every connector.
    const agentxSum = (metricName: string, period: Duration) =>
      new cloudwatch.Metric({ namespace: "AgentX", metricName, statistic: "Sum", period });
    new cloudwatch.Alarm(this, "ConnectorBrokenAlarm", {
      alarmName: "AgentXConnectorBroken",
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
      alarmName: "AgentXConnectorNotConnected",
      alarmDescription: "A connector's vendor credential is missing, revoked or rejected. Check the broker logs for the connector, then reconnect it with agentx connectors.",
      metric: agentxSum("ConnectorNotConnected", Duration.minutes(5)),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(notifyOperator);
    new cloudwatch.Alarm(this, "EmptyResponsesAlarm", {
      alarmName: "AgentXEmptyResponses",
      alarmDescription: "More than three orchestrator turns in an hour ended without text. Export recent turns with agentx admin turns export.",
      metric: agentxSum("TurnEmptyResponse", Duration.hours(1)),
      threshold: 3,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(notifyOperator);
    new cloudwatch.Alarm(this, "RecordingFailuresAlarm", {
      alarmName: "AgentXRecordingFailures",
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
      alarmName: "AgentXSlackDeadLetters",
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
    slackSecret.grantRead(slackIngress);

    const api = new apigwv2.CfnApi(this, "HttpApi", {
      name: "agentx-control-plane",
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
    new apigwv2.CfnStage(this, "DefaultStage", {
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
    slackOrchestratorRole.addToPolicy(new iam.PolicyStatement({
      actions: ["execute-api:Invoke"],
      resources: [`arn:${this.partition}:execute-api:${this.region}:${this.account}:${api.ref}/*/*/v1/service/*`],
    }));

    new CfnOutput(this, "ApiEndpoint", { value: api.attrApiEndpoint });
    new CfnOutput(this, "StateTableName", { value: state.tableName });
    new CfnOutput(this, "ArtifactBucketName", { value: artifacts.bucketName });
    new CfnOutput(this, "DispatchDeadLetterQueueUrl", { value: deadLetterQueue.queueUrl });
    new CfnOutput(this, "SlackEventsUrl", { value: `${api.attrApiEndpoint}/v1/slack/events` });
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

function packagedFunction(
  scope: Construct,
  id: string,
  entry: string,
  environment: Record<string, string>,
  timeout = Duration.seconds(30),
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
    },
  });
}

function runtimeArn(stack: Stack): string {
  return `arn:${stack.partition}:bedrock-agentcore:${stack.region}:${stack.account}:runtime/*`;
}
