// Spec 025 FR-034, C7: the DeveloperTaskNotifier. Named environments only (D14). It is the only new
// reader of the Slack secret; the broker still cannot read it (D11).
import { Duration, type aws_dynamodb as dynamodb, aws_iam as iam, aws_lambda as lambda, type aws_lambda_nodejs as lambdaNodejs, type aws_secretsmanager as secretsmanager, aws_sqs as sqs } from "aws-cdk-lib";
import { Construct } from "constructs";
import { packagedFunction } from "./control-plane.js";
import type { AgentXNaming } from "./naming.js";

export interface DeveloperTaskNotifierProps {
  naming: AgentXNaming;
  /** The concrete Table: its stream ARN is read here. */
  state: dynamodb.Table;
  slackSecret: secretsmanager.Secret;
}

const TERMINAL = ["SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"];
/** FilterRule's helpers are typed `any`; each answers a JSON array of matchers. */
const equals = (value: string) => lambda.FilterRule.isEqual(value) as unknown;
const oneOf = (values: string[]) => lambda.FilterRule.or(...values) as unknown;

export class DeveloperTaskNotifier extends Construct {
  readonly function: lambdaNodejs.NodejsFunction;
  readonly queue: sqs.Queue;

  constructor(scope: Construct, id: string, props: DeveloperTaskNotifierProps) {
    super(scope, id);
    const deadLetters = new sqs.Queue(this, "NoticeDeadLetterQueue", {
      encryption: sqs.QueueEncryption.SQS_MANAGED, enforceSSL: true, retentionPeriod: Duration.days(14),
    });
    // C9: a notice is retried for one hour, then counted and dropped; one day of retention is ample,
    // and the dead-letter queue only catches a notice the function itself cannot handle.
    this.queue = new sqs.Queue(this, "NoticeQueue", {
      encryption: sqs.QueueEncryption.SQS_MANAGED, enforceSSL: true,
      retentionPeriod: Duration.days(1),
      // Six times the function's timeout, as AWS advises for an SQS event source.
      visibilityTimeout: Duration.seconds(180),
      deadLetterQueue: { queue: deadLetters, maxReceiveCount: 100 },
    });
    this.function = packagedFunction(this, "Function", "packages/broker/src/aws/developer-task-notifier.ts", {
      STATE_TABLE_NAME: props.state.tableName,
      NOTICE_QUEUE_URL: this.queue.queueUrl,
      SLACK_SECRET_ARN: props.slackSecret.secretArn,
      AGENTX_METRICS_NAMESPACE: props.naming.metricsNamespace,
    }, Duration.seconds(30));
    props.slackSecret.grantRead(this.function);
    props.state.grantStreamRead(this.function);
    this.queue.grantSendMessages(this.function);
    this.queue.grantConsumeMessages(this.function);
    // Exactly the items the notifier reads and writes (Task 7), by key: no scan, no delete.
    this.function.addToRolePolicy(new iam.PolicyStatement({
      actions: ["dynamodb:GetItem", "dynamodb:Query"],
      resources: [props.state.tableArn],
      conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DEVTASK#*", "WORKSPACE#*", "OPERATION#*"] } },
    }));
    this.function.addToRolePolicy(new iam.PolicyStatement({
      actions: ["dynamodb:PutItem", "dynamodb:UpdateItem"],
      resources: [props.state.tableArn],
      conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DEVTASK#*", "SHARED_TASK#*"] } },
    }));
    // C7: the State table's stream has two readers, the outbox publisher (control-plane.ts,
    // OutboxStreamMapping) and this notifier: the per-shard maximum AWS recommends. Later phases
    // (such as 25e's Slack Confirm DMs) add filters to an existing trigger, never a third reader.
    new lambda.EventSourceMapping(this, "StateStreamMapping", {
      target: this.function,
      eventSourceArn: props.state.tableStreamArn!,
      startingPosition: lambda.StartingPosition.LATEST,
      batchSize: 100,
      retryAttempts: 10,
      bisectBatchOnError: true,
      maxRecordAge: Duration.hours(1),
      filters: [
        lambda.FilterCriteria.filter({ dynamodb: { NewImage: { entityType: { S: equals("DEVELOPER_TASK") } } } }),
        lambda.FilterCriteria.filter({ dynamodb: { NewImage: { entityType: { S: equals("DEVELOPER_TASK_POINTER") } } } }),
        lambda.FilterCriteria.filter({ dynamodb: { NewImage: {
          entityType: { S: equals("OPERATION") },
          requestedBy: { M: { kind: { S: equals("developer") } } },
          status: { S: oneOf(TERMINAL) },
        } } }),
      ],
    });
    new lambda.EventSourceMapping(this, "NoticeQueueMapping", {
      target: this.function,
      eventSourceArn: this.queue.queueArn,
      // Ruling F15: one notice per invocation. A batch of 10 with 10 s Slack calls can pass the 30 s
      // timeout between a post and its marker, and the notice would be posted again.
      batchSize: 1,
      reportBatchItemFailures: true,
    });
  }
}
