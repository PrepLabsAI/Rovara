// Spec 025 FR-034, C7: the DeveloperTaskNotifier. Named environments only (D14). It is the only new
// reader of the Slack secret; the broker still cannot read it (D11).
import { Duration, aws_cloudwatch as cloudwatch, type aws_dynamodb as dynamodb, aws_iam as iam, aws_lambda as lambda, aws_lambda_event_sources as eventSources, type aws_lambda_nodejs as lambdaNodejs, type aws_s3 as s3, type aws_secretsmanager as secretsmanager, aws_sqs as sqs } from "aws-cdk-lib";
import { Construct } from "constructs";
import { packagedFunction } from "./control-plane.js";
import type { AgentXNaming } from "./naming.js";

export interface DeveloperTaskNotifierProps {
  naming: AgentXNaming;
  /** Same-origin AgentX control plane, used only to construct authenticated review links. */
  controlPlaneUrl: string;
  /** The concrete Table: its stream ARN is read here. */
  state: dynamodb.Table;
  /** Task plan artifacts are read only to create a Slack detail page after digest verification. */
  artifactBucket: s3.Bucket;
  slackSecret: secretsmanager.Secret;
  /** The operator alerts topic's action: a dead-lettered notice or stream batch is never silent. */
  notifyOperator: cloudwatch.IAlarmAction;
}

const TERMINAL = ["SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"];
/** FilterRule's helpers are typed `any`; each answers a JSON array of matchers. */
const equals = (value: string) => lambda.FilterRule.isEqual(value) as unknown;
const oneOf = (values: string[]) => lambda.FilterRule.or(...values) as unknown;

export class DeveloperTaskNotifier extends Construct {
  readonly function: lambdaNodejs.NodejsFunction;
  readonly queue: sqs.Queue;
  readonly deadLetters: sqs.Queue;
  readonly streamFailures: sqs.Queue;

  constructor(scope: Construct, id: string, props: DeveloperTaskNotifierProps) {
    super(scope, id);
    this.deadLetters = new sqs.Queue(this, "NoticeDeadLetterQueue", {
      encryption: sqs.QueueEncryption.SQS_MANAGED, enforceSSL: true, retentionPeriod: Duration.days(14),
    });
    // C9: a notice is retried for one hour, then counted and dropped; one day of retention is ample,
    // and the dead-letter queue only catches a notice the function itself cannot handle.
    this.queue = new sqs.Queue(this, "NoticeQueue", {
      encryption: sqs.QueueEncryption.SQS_MANAGED, enforceSSL: true,
      retentionPeriod: Duration.days(1),
      // Six times the function's timeout, as AWS advises for an SQS event source.
      visibilityTimeout: Duration.seconds(180),
      deadLetterQueue: { queue: this.deadLetters, maxReceiveCount: 100 },
    });
    // A stream batch that still fails after its retries (the notice queue refusing sends, say) is
    // recorded here: shard and sequence numbers only, never an item's images.
    this.streamFailures = new sqs.Queue(this, "StreamFailureQueue", {
      encryption: sqs.QueueEncryption.SQS_MANAGED, enforceSSL: true, retentionPeriod: Duration.days(14),
    });
    const deadLetterAlarm = (id: string, suffix: string, queue: sqs.Queue, description: string) => new cloudwatch.Alarm(this, id, {
      alarmName: props.naming.alarmName(suffix),
      alarmDescription: description,
      metric: queue.metricApproximateNumberOfMessagesVisible({ statistic: "Maximum", period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(props.notifyOperator);
    deadLetterAlarm("NoticeDeadLettersAlarm", "DeveloperNoticeDeadLetters", this.deadLetters,
      "A shared task's notice exhausted its receives and is in the notice dead-letter queue. Check the developer task notifier logs for its message ID.");
    deadLetterAlarm("StreamFailuresAlarm", "DeveloperNoticeStreamFailures", this.streamFailures,
      "A batch of state table changes could not be turned into shared task notices, so a thread may have missed updates. Check the developer task notifier logs, and the failure queue for the shard and sequence numbers.");
    this.function = packagedFunction(this, "Function", "packages/broker/src/aws/developer-task-notifier.ts", {
      STATE_TABLE_NAME: props.state.tableName,
      CONTROL_PLANE_URL: props.controlPlaneUrl,
      ARTIFACT_BUCKET_NAME: props.artifactBucket.bucketName,
      NOTICE_QUEUE_URL: this.queue.queueUrl,
      SLACK_SECRET_ARN: props.slackSecret.secretArn,
      AGENTX_METRICS_NAMESPACE: props.naming.metricsNamespace,
    }, Duration.seconds(30));
    props.slackSecret.grantRead(this.function);
    this.function.addToRolePolicy(new iam.PolicyStatement({
      actions: ["s3:GetObject"],
      resources: [props.artifactBucket.arnForObjects("private/*/*/*/*")],
    }));
    props.artifactBucket.encryptionKey?.grantDecrypt(this.function);
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
      conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DEVTASK#*"] } },
    }));
    // A shared thread's record is only ever put, once, with the thread (C2).
    this.function.addToRolePolicy(new iam.PolicyStatement({
      actions: ["dynamodb:PutItem"],
      resources: [props.state.tableArn],
      conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["SHARED_TASK#*"] } },
    }));
    // Spec 025 E13: the notifier reads a change and records its message (dm, dmClaimedAt), by key.
    this.function.addToRolePolicy(new iam.PolicyStatement({
      actions: ["dynamodb:GetItem", "dynamodb:UpdateItem"],
      resources: [props.state.tableArn],
      conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["ADMIN_CHANGE#*"] } },
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
      onFailure: new eventSources.SqsDlq(this.streamFailures),
      filters: [
        lambda.FilterCriteria.filter({ dynamodb: { NewImage: { entityType: { S: equals("DEVELOPER_TASK") } } } }),
        lambda.FilterCriteria.filter({ dynamodb: { NewImage: { entityType: { S: equals("DEVELOPER_TASK_POINTER") } } } }),
        lambda.FilterCriteria.filter({ dynamodb: { NewImage: {
          entityType: { S: equals("OPERATION") },
          requestedBy: { M: { kind: { S: equals("developer") } } },
          status: { S: oneOf(TERMINAL) },
        } } }),
        // Spec 025 E13: admin changes whose Slack step started, and changes with a message that ended.
        lambda.FilterCriteria.filter({ dynamodb: { NewImage: { entityType: { S: equals("ADMIN_CHANGE") } } } }),
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
