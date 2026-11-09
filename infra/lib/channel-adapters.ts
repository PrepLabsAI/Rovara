import {
  ArnFormat, CfnParameter, Duration, RemovalPolicy, Stack, aws_apigatewayv2 as apigwv2, aws_cloudwatch as cloudwatch, aws_dynamodb as dynamodb,
  aws_iam as iam, aws_lambda_event_sources as eventSources, aws_sqs as sqs, type aws_cloudwatch_actions as cloudwatchActions, type aws_lambda_nodejs as lambdaNodejs,
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
}

/**
 * Spec 062 Phase 3: the channel API (signed adapter requests in), the event sender (signed events out), the short-lived
 * channel state and the two queues. Named environments only, where developer sign-in exists to link actors to. Off
 * unless the `ChannelAdapters` parameter is `enabled`: until then the broker serves no adapter routes and the channel
 * API answers 404 to everything, so no adapter can be registered or reached.
 */
export class ChannelAdapters extends Construct {
  readonly eventDeadLetters: sqs.Queue;
  readonly requestDeadLetters: sqs.Queue;
  readonly requests: sqs.Queue;
  readonly events: sqs.Queue;

  constructor(scope: Construct, id: string, props: ChannelAdaptersProps) {
    super(scope, id);
    const stack = Stack.of(this);
    const enabled = new CfnParameter(stack, "ChannelAdapters", {
      type: "String",
      default: "disabled",
      allowedValues: ["enabled", "disabled"],
      description: "enabled: administrators can register channel adapters (spec 062) and the channel API accepts their signed requests",
    }).valueAsString;
    // Adapter signing secrets, apart from connector secrets, which the broker can also read.
    const secretPrefix = `agentx/${props.env}/`;
    const adapterSecrets = stack.formatArn({ service: "secretsmanager", resource: "secret", resourceName: `${secretPrefix}channel-adapter/*`, arnFormat: ArnFormat.COLON_RESOURCE_NAME });

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

    // Events to adapters: retried with a growing delay that the sender sets, then dead-lettered.
    this.eventDeadLetters = new sqs.Queue(this, "EventDeadLetters", { retentionPeriod: Duration.days(14), enforceSSL: true, encryption: sqs.QueueEncryption.SQS_MANAGED });
    const events = this.events = new sqs.Queue(this, "Events", {
      retentionPeriod: Duration.days(1),
      visibilityTimeout: Duration.seconds(180),
      deadLetterQueue: { queue: this.eventDeadLetters, maxReceiveCount: 8 },
      enforceSSL: true,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    const ingress = packagedFunction(this, "Ingress", "packages/broker/src/aws/channel-ingress.ts", {
      CHANNEL_ADAPTERS: enabled,
      STATE_TABLE_NAME: props.state.tableName,
      CHANNEL_STATE_TABLE_NAME: channelState.tableName,
      CHANNEL_REQUEST_QUEUE_URL: requests.queueUrl,
      CHANNEL_EVENT_QUEUE_URL: events.queueUrl,
      CHANNEL_LINK_ORIGIN: props.api.attrApiEndpoint,
    }, Duration.seconds(10));
    // By key only: an adapter, a binding, a link; and it writes a new link code. Never a query, nothing else.
    ingress.addToRolePolicy(new iam.PolicyStatement({
      actions: ["dynamodb:GetItem"],
      resources: [props.state.tableArn],
      conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["CHANNEL_ADAPTERS", "BINDING#*", "CHANNEL_LINK#*"] } },
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
    // The orchestrator runs what was queued and queues the conversation's replies; the broker checks each call again.
    requests.grantConsumeMessages(props.orchestratorRole);
    events.grantSendMessages(props.orchestratorRole);

    const integration = new apigwv2.CfnIntegration(this, "Integration", {
      apiId: props.api.ref, integrationType: "AWS_PROXY", integrationUri: ingress.functionArn, payloadFormatVersion: "2.0",
    });
    // The adapter signs each request itself (Standard Webhooks); the Lambda verifies it, as Slack ingress does Slack's.
    for (const [routeId, kind] of [["MessagesRoute", "messages"], ["DecisionsRoute", "decisions"]] as const) {
      new apigwv2.CfnRoute(this, routeId, {
        apiId: props.api.ref, routeKey: `POST /v1/channels/{channel}/${kind}`, target: `integrations/${integration.ref}`, authorizationType: "NONE",
      });
    }
    ingress.addPermission("ApiInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      sourceArn: `arn:${stack.partition}:execute-api:${stack.region}:${stack.account}:${props.api.ref}/*/POST/v1/channels/*`,
    });

    const sender = packagedFunction(this, "EventSender", "packages/broker/src/aws/channel-events.ts", {
      STATE_TABLE_NAME: props.state.tableName,
      CHANNEL_EVENT_QUEUE_URL: events.queueUrl,
    }, Duration.seconds(30));
    sender.addToRolePolicy(new iam.PolicyStatement({
      actions: ["dynamodb:GetItem"],
      resources: [props.state.tableArn],
      conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["CHANNEL_ADAPTERS"] } },
    }));
    sender.addToRolePolicy(new iam.PolicyStatement({ actions: ["secretsmanager:GetSecretValue"], resources: [adapterSecrets] }));
    sender.addEventSource(new eventSources.SqsEventSource(events, { batchSize: 10, reportBatchItemFailures: true }));

    // The broker registers adapters and writes their secrets. Links and link codes are in the state table, which it
    // already reads and writes; one statement only, since the broker role's policy is near IAM's size limit.
    props.broker.addEnvironment("CHANNEL_ADAPTERS", enabled);
    props.broker.addEnvironment("CHANNEL_ADAPTER_SECRET_PREFIX", secretPrefix);
    props.broker.addToRolePolicy(new iam.PolicyStatement({ actions: ["secretsmanager:CreateSecret", "secretsmanager:PutSecretValue"], resources: [adapterSecrets] }));

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
}
