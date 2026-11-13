import {
  ArnFormat, CfnParameter, Duration, RemovalPolicy, Stack, aws_apigatewayv2 as apigwv2, aws_cloudwatch as cloudwatch, aws_dynamodb as dynamodb,
  aws_iam as iam, type aws_lambda as lambda, aws_lambda_event_sources as eventSources, aws_secretsmanager as secretsmanager, aws_sqs as sqs, type aws_cloudwatch_actions as cloudwatchActions,
  type aws_lambda_nodejs as lambdaNodejs,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import { packagedFunction } from "./control-plane.js";
import type { AgentXNaming } from "./naming.js";

export interface ChannelAdaptersProps {
  naming: AgentXNaming;
  env: string;
  api: apigwv2.CfnApi;
  state: dynamodb.Table;
  broker: lambdaNodejs.NodejsFunction;
  /** Spec 062 Phase 4: the hosted orchestrator, which runs the queued requests and sends their replies. */
  orchestratorRole: iam.IRole;
  notifyOperator: cloudwatchActions.SnsAction;
  /** Spec 062 Phase 7b: Slack's ingress, which becomes the built-in Slack adapter when `SlackViaChannel` is on. */
  slack: {
    ingress: lambdaNodejs.NodejsFunction;
    integration: apigwv2.CfnIntegration;
    /** Phase 7c2: what the channel API's Slack router reads and writes, and its settings, as Slack's ingress has them. */
    threads: dynamodb.Table;
    appPostedMessages: string;
    threadTurnsPerMinute: string;
  };
  /**
   * Phase 7d: whether administrators may register third-party adapters (named environments, where developer sign-in
   * links their actors). The legacy deployment has no sign-in: it gets the built-in Slack adapter only, no registry,
   * no `ChannelAdapters` parameter and nothing on the broker.
   */
  registry: boolean;
  /** Whether Slack-started tasks share their threads (named environments), as Slack's ingress is told. */
  sharedTasks: boolean;
  /** Phase 7c3b: the turn records the Details view reads, field-limited, as Slack's interactivity does. */
  turnRecords: { table: dynamodb.Table; detailsAttributes: readonly string[] };
}

/**
 * Spec 062 Phase 3: the channel API (signed adapter requests in), the event sender (signed events out), the short-lived
 * channel state and the two queues. Third-party adapters are registered in named environments only, where developer
 * sign-in exists to link actors to, and only while `ChannelAdapters` is `enabled`. Phase 7d: every deployment has the
 * built-in Slack adapter, off until `SlackViaChannel` is `enabled`; until either is on the channel API answers 404.
 */
export class ChannelAdapters extends Construct {
  readonly eventDeadLetters: sqs.Queue;
  readonly requestDeadLetters: sqs.Queue;
  readonly requests: sqs.Queue;
  readonly events: sqs.Queue;
  readonly ingress: lambdaNodejs.NodejsFunction;
  private readonly slackViaChannel: string;
  private readonly slackAdapterSecret: secretsmanager.Secret;
  private readonly builtInAdapter: Record<string, string>;

  constructor(scope: Construct, id: string, props: ChannelAdaptersProps) {
    super(scope, id);
    const stack = Stack.of(this);
    const enabled = props.registry ? new CfnParameter(stack, "ChannelAdapters", {
      type: "String",
      default: "disabled",
      allowedValues: ["enabled", "disabled"],
      description: "enabled: administrators can register channel adapters (spec 062) and the channel API accepts their signed requests",
    }).valueAsString : "disabled";
    // Adapter signing secrets, apart from connector secrets, which the broker can also read.
    const secretPrefix = `agentx/${props.env}/`;
    const adapterSecrets = stack.formatArn({ service: "secretsmanager", resource: "secret", resourceName: `${secretPrefix}channel-adapter/*`, arnFormat: ArnFormat.COLON_RESOURCE_NAME });

    // Spec 062 FR-073, FR-074: the built-in Slack adapter. The deployment registers it: its secret is generated here,
    // and Slack's ingress signs with it what it hands the channel API and checks with it what comes back.
    const slackViaChannel = new CfnParameter(stack, "SlackViaChannel", {
      type: "String",
      default: "disabled",
      allowedValues: ["enabled", "disabled"],
      description: "enabled: Slack conversations go through the channel API as the built-in Slack adapter (spec 062 Phase 7); disabled: Slack's own queue, as before",
    }).valueAsString;
    this.slackViaChannel = slackViaChannel;
    const slackAdapterSecretName = `${secretPrefix}channel-adapter/slack`;
    const slackAdapterSecret = this.slackAdapterSecret = new secretsmanager.Secret(this, "SlackAdapterSecret", {
      secretName: slackAdapterSecretName,
      description: "Signing secret of the built-in Slack channel adapter (spec 062 FR-073); 64 letters and digits, read as base64",
      generateSecretString: { passwordLength: 64, excludePunctuation: true, includeSpace: false },
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const builtInAdapter = this.builtInAdapter = {
      BUILT_IN_ADAPTER: slackViaChannel,
      BUILT_IN_ADAPTER_CHANNEL: "slack",
      BUILT_IN_ADAPTER_CALLBACK_URL: `${props.api.attrApiEndpoint}/v1/slack/channel-events`,
      // Phase 7c: posts the core must know the result of, and Canvases.
      BUILT_IN_ADAPTER_COMMANDS_URL: `${props.api.attrApiEndpoint}/v1/slack/channel-commands`,
      BUILT_IN_ADAPTER_SECRET_NAME: slackAdapterSecretName,
    };

    // The channel API's replay, duplicate and link-notice claims: short-lived, expired by expiresAt.
    const channelState = new dynamodb.Table(this, "State", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      timeToLiveAttribute: "expiresAt",
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Accepted messages and decisions, ordered per conversation, run by the hosted orchestrator.
    const requestDeadLetters = this.requestDeadLetters = new sqs.Queue(this, "RequestDeadLetters", {
      fifo: true, retentionPeriod: Duration.days(14), enforceSSL: true, encryption: sqs.QueueEncryption.SQS_MANAGED,
    });
    const requests = this.requests = new sqs.Queue(this, "Requests", {
      fifo: true,
      retentionPeriod: Duration.days(4),
      visibilityTimeout: Duration.minutes(15),
      deadLetterQueue: { queue: requestDeadLetters, maxReceiveCount: 5 },
      enforceSSL: true,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    // Events to adapters, in order per conversation (Phase 7b): retried with a growing delay that the sender sets, then
    // dead-lettered.
    this.eventDeadLetters = new sqs.Queue(this, "EventDeadLetters", { fifo: true, retentionPeriod: Duration.days(14), enforceSSL: true, encryption: sqs.QueueEncryption.SQS_MANAGED });
    const events = this.events = new sqs.Queue(this, "Events", {
      fifo: true,
      retentionPeriod: Duration.days(1),
      visibilityTimeout: Duration.seconds(180),
      deadLetterQueue: { queue: this.eventDeadLetters, maxReceiveCount: 8 },
      enforceSSL: true,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    // Phase 7c2: the neutral channel ingress with the built-in Slack adapter's router, which may call the broker and the
    // adapter's commands; Slack has its answer before the hand-off, so the API may take longer than Slack would wait.
    const ingress = this.ingress = packagedFunction(this, "Ingress", "packages/core/src/aws/channel-api-lambda.ts", {
      CHANNEL_ADAPTERS: enabled,
      STATE_TABLE_NAME: props.state.tableName,
      CHANNEL_STATE_TABLE_NAME: channelState.tableName,
      CHANNEL_REQUEST_QUEUE_URL: requests.queueUrl,
      CHANNEL_EVENT_QUEUE_URL: events.queueUrl,
      CHANNEL_LINK_ORIGIN: props.api.attrApiEndpoint,
      ...builtInAdapter,
      SLACK_THREADS_TABLE_NAME: props.slack.threads.tableName,
      BROKER_FUNCTION_NAME: props.broker.functionName,
      SHARED_TASKS: props.sharedTasks ? "enabled" : "disabled",
      // Phase 7c3b: the Details view, as Slack's interactivity reads it.
      TURN_RECORDS_TABLE_NAME: props.turnRecords.table.tableName,
      SLACK_APP_POSTED_MESSAGES: props.slack.appPostedMessages,
      SLACK_THREAD_TURNS_PER_MINUTE: props.slack.threadTurnsPerMinute,
    }, Duration.seconds(30));
    // By key only: an adapter, a binding, a link; and it writes a new link code. Never a query, nothing else.
    ingress.addToRolePolicy(new iam.PolicyStatement({
      actions: ["dynamodb:GetItem"],
      resources: [props.state.tableArn],
      // SLACK_BINDING: the built-in Slack adapter's spaces are Slack channels, bound as they always were; SHARED_TASK: its
      // router reads whether a thread is a shared task's, as Slack's ingress does.
      conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["CHANNEL_ADAPTERS", "BINDING#*", "CHANNEL_LINK#*", "SLACK_BINDING#*", ...(props.sharedTasks ? ["SHARED_TASK#*"] : [])] } },
    }));
    ingress.addToRolePolicy(new iam.PolicyStatement({
      actions: ["dynamodb:PutItem"],
      resources: [props.state.tableArn],
      conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["CHANNEL_LINK_CODE#*"] } },
    }));
    ingress.addToRolePolicy(new iam.PolicyStatement({
      actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"],
      resources: [channelState.tableArn],
    }));
    ingress.addToRolePolicy(new iam.PolicyStatement({ actions: ["secretsmanager:GetSecretValue"], resources: [adapterSecrets] }));
    requests.grantSendMessages(ingress);
    events.grantSendMessages(ingress);
    // The Slack router's own state (claims, turn counts, choices, pending counts) and the broker it asks.
    props.slack.threads.grantReadWriteData(ingress);
    props.broker.grantInvoke(ingress);
    // The orchestrator runs what was queued and queues the conversation's replies; the broker checks each call again.
    requests.grantConsumeMessages(props.orchestratorRole);
    events.grantSendMessages(props.orchestratorRole);

    const integration = new apigwv2.CfnIntegration(this, "Integration", {
      apiId: props.api.ref, integrationType: "AWS_PROXY", integrationUri: ingress.functionArn, payloadFormatVersion: "2.0",
    });
    // The adapter signs each request itself (Standard Webhooks); the Lambda verifies it, as Slack ingress does Slack's.
    for (const [routeId, kind] of [["MessagesRoute", "messages"], ["DecisionsRoute", "decisions"], ["ActionsRoute", "actions"]] as const) {
      new apigwv2.CfnRoute(this, routeId, {
        apiId: props.api.ref, routeKey: `POST /v1/channels/{channel}/${kind}`, target: `integrations/${integration.ref}`, authorizationType: "NONE",
      });
    }
    ingress.addPermission("ApiInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      sourceArn: `arn:${stack.partition}:execute-api:${stack.region}:${stack.account}:${props.api.ref}/*/POST/v1/channels/*`,
    });

    const sender = packagedFunction(this, "EventSender", "packages/core/src/aws/channel-events.ts", {
      CHANNEL_ADAPTERS: enabled,
      STATE_TABLE_NAME: props.state.tableName,
      CHANNEL_EVENT_QUEUE_URL: events.queueUrl,
      ...builtInAdapter,
    }, Duration.seconds(30));
    sender.addToRolePolicy(new iam.PolicyStatement({
      actions: ["dynamodb:GetItem"],
      resources: [props.state.tableArn],
      conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["CHANNEL_ADAPTERS"] } },
    }));
    sender.addToRolePolicy(new iam.PolicyStatement({ actions: ["secretsmanager:GetSecretValue"], resources: [adapterSecrets] }));
    // Phase 7d: at most two senders at once, so delivering replies never takes the account's few concurrent Lambdas
    // from Slack's ingress or the broker.
    sender.addEventSource(new eventSources.SqsEventSource(events, { batchSize: 10, reportBatchItemFailures: true, maxConcurrency: 2 }));

    // The built-in Slack adapter: Slack's ingress signs with the adapter's secret, hands requests to the channel API and
    // takes the core's events for Slack on its own route. The route answers 404 while SlackViaChannel is off.
    props.slack.ingress.addEnvironment("SLACK_VIA_CHANNEL", slackViaChannel);
    props.slack.ingress.addEnvironment("CHANNEL_API_URL", props.api.attrApiEndpoint);
    props.slack.ingress.addEnvironment("SLACK_ADAPTER_SECRET_NAME", slackAdapterSecretName);
    slackAdapterSecret.grantRead(props.slack.ingress);
    // Phase 7c2: the orchestrator posts a routing card and a private answer through the adapter's commands.
    slackAdapterSecret.grantRead(props.orchestratorRole);
    new apigwv2.CfnRoute(this, "SlackEventsRoute", {
      apiId: props.api.ref, routeKey: "POST /v1/slack/channel-events", target: `integrations/${props.slack.integration.ref}`, authorizationType: "NONE",
    });
    props.slack.ingress.addPermission("ChannelEventsInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      sourceArn: `arn:${stack.partition}:execute-api:${stack.region}:${stack.account}:${props.api.ref}/*/*/v1/slack/channel-events`,
    });
    new apigwv2.CfnRoute(this, "SlackCommandsRoute", {
      apiId: props.api.ref, routeKey: "POST /v1/slack/channel-commands", target: `integrations/${props.slack.integration.ref}`, authorizationType: "NONE",
    });
    props.slack.ingress.addPermission("ChannelCommandsInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      sourceArn: `arn:${stack.partition}:execute-api:${stack.region}:${stack.account}:${props.api.ref}/*/*/v1/slack/channel-commands`,
    });
    // A Canvas takes three Slack calls of up to 10 seconds each.
    (props.slack.ingress.node.defaultChild as lambda.CfnFunction).timeout = 30;

    // Phase 7c3b: the Details view reads the one turn record a button names, those fields only (spec 014 FR-024), and a
    // ChatGPT connection finishes in an asynchronous invoke of the channel API itself. Phase 7c2: Slack's ingress hands
    // each message to an asynchronous invoke of itself. Policies of their own, so a function never waits on its own.
    ingress.addToRolePolicy(new iam.PolicyStatement({
      actions: ["dynamodb:GetItem"],
      resources: [props.turnRecords.table.tableArn],
      conditions: {
        "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["THREAD#*"] },
        "ForAllValues:StringEquals": { "dynamodb:Attributes": [...props.turnRecords.detailsAttributes] },
        StringEqualsIfExists: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
        Null: { "dynamodb:Attributes": "false" },
      },
    }));
    new iam.Policy(this, "SelfInvoke", {
      roles: [ingress.role!],
      statements: [new iam.PolicyStatement({ actions: ["lambda:InvokeFunction"], resources: [ingress.functionArn] })],
    });
    new iam.Policy(this, "SlackAdapterSelfInvoke", {
      roles: [props.slack.ingress.role!],
      statements: [new iam.PolicyStatement({ actions: ["lambda:InvokeFunction"], resources: [props.slack.ingress.functionArn] })],
    });

    // The broker registers adapters and writes their secrets. Links and link codes are in the state table, which it
    // already reads and writes; one statement only, since the broker role's policy is near IAM's size limit.
    if (props.registry) {
      props.broker.addEnvironment("CHANNEL_ADAPTERS", enabled);
      props.broker.addEnvironment("CHANNEL_ADAPTER_SECRET_PREFIX", secretPrefix);
      props.broker.addToRolePolicy(new iam.PolicyStatement({ actions: ["secretsmanager:CreateSecret", "secretsmanager:PutSecretValue"], resources: [adapterSecrets] }));
    }

    new cloudwatch.Alarm(this, "RequestDeadLettersAlarm", {
      alarmName: props.naming.alarmName("ChannelRequestDeadLetters"),
      alarmDescription: "A channel adapter request failed every attempt and is in the channel request dead-letter queue. Check the Slack orchestrator logs for its event ID.",
      metric: requestDeadLetters.metricApproximateNumberOfMessagesVisible({ statistic: "Maximum", period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(props.notifyOperator);

    new cloudwatch.Alarm(this, "EventDeadLettersAlarm", {
      alarmName: props.naming.alarmName("ChannelEventDeadLetters"),
      alarmDescription: "A channel adapter event exhausted its deliveries and is in the channel event dead-letter queue. Check the channel event sender logs for its event ID.",
      metric: this.eventDeadLetters.metricApproximateNumberOfMessagesVisible({ statistic: "Maximum", period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(props.notifyOperator);
  }

  /**
   * Phase 7c: a function that posts to Slack for the core (the developer task notifier, the session reconciler) does it
   * through the Slack adapter's commands while SlackViaChannel is on, and may read the adapter's secret to sign them.
   */
  connectSlackPoster(fn: lambdaNodejs.NodejsFunction, slackTeamId: string, options: { readsAdapterSecrets?: true } = {}): void {
    fn.addEnvironment("SLACK_VIA_CHANNEL", this.slackViaChannel);
    // Its own name: the notifier gets none of developer sign-in's settings.
    fn.addEnvironment("SLACK_ADAPTER_TEAM_ID", slackTeamId);
    for (const [name, value] of Object.entries(this.builtInAdapter)) fn.addEnvironment(name, value);
    // The channel API already reads every adapter's secret, by name only.
    if (options.readsAdapterSecrets !== true) this.slackAdapterSecret.grantRead(fn);
  }
}
