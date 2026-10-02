// Amazon States Language (JSONata) for one SWE-bench run (spec 043 FR-006). The broker starts it with
// { runId, subnetId } once the run record, the run's slot (spec 052) and the run's launch file exist.
// It launches the eval instance, records it, polls the run until the runner reports or a limit ends
// it, and always terminates the instance. A run it ends (cancelled, over its ceiling, or an instance
// that stopped without reporting) it marks terminal and releases its slot, in the same transaction
// as the broker's finishRun for a reported result; a run already terminal is left as it is. A
// release that fails for any other reason still terminates the instance, then fails the execution,
// so the failure is seen rather than leaking a slot.
import { SWEBENCH_RUN_TIME_LIMIT_SECONDS } from "@agentx/contracts";

type State = Record<string, unknown>;

export interface SwebenchEvalDefinitionProps {
  launchTemplateId: string;
  stateTableName: string;
  environmentTag: string;
  env?: string;
  resourcePrefix: string;
}

/** The runner reports within seconds of stopping; an ended instance gets this many more polls first. */
const GRACE_POLLS = 2;
export const SWEBENCH_POLL_SECONDS = 30;
/** Instances and volumes the eval machine creates carry this deployment mode, never ec2-ebs's. */
export const SWEBENCH_DEPLOYMENT_MODE = "swebench-eval";
/** The instance tag the boot script reads the run ID from, through instance metadata. */
export const SWEBENCH_RUN_TAG = "agentx-eval-run";

const RETRY = [{ ErrorEquals: ["States.ALL"], IntervalSeconds: 2, MaxAttempts: 3, BackoffRate: 2 }];
const ec2 = (action: string) => `arn:aws:states:::aws-sdk:ec2:${action}`;
const runKey = { pk: { S: "{% 'SWEBENCH_RUN#' & $runId %}" }, sk: { S: "META" } };
/** Spec 052: the run's slot item and the deployment's counter of slots held (swebench.ts in the broker). */
const slotKey = { pk: { S: "SWEBENCH#SLOT" }, sk: { S: "{% 'RUN#' & $runId %}" } };
const COUNTER_KEY = { pk: { S: "SWEBENCH#SLOTS" }, sk: { S: "COUNTER" } };
const ACTIVE = ["STARTING", "RUNNING", "CANCEL_REQUESTED"];
/** A release refused while the run is active and its slot held (a conflict on the counter) is tried this many times. */
const RELEASE_ATTEMPTS = 3;
const DYNAMODB_RETRY = [{ ErrorEquals: ["DynamoDb.TransactionConflictException", "DynamoDb.ProvisionedThroughputExceededException", "DynamoDb.InternalServerErrorException"], IntervalSeconds: 2, MaxAttempts: 3, BackoffRate: 2 }];

export function swebenchEvalDefinition(props: SwebenchEvalDefinitionProps): State {
  const tags = (name: string) => [
    { Key: "Name", Value: name },
    { Key: "Application", Value: "AgentX" },
    { Key: "DeploymentMode", Value: SWEBENCH_DEPLOYMENT_MODE },
    { Key: "Environment", Value: props.environmentTag },
    ...(props.env === undefined ? [] : [{ Key: "agentx:env", Value: props.env }]),
    { Key: SWEBENCH_RUN_TAG, Value: "{% $runId %}" },
  ];
  const toEnd = (failure: string) => ({ ErrorEquals: ["States.ALL"], Next: "EndRun", Assign: { endStatus: "FAILED", failure } });
  const toReleaseFailed = { ErrorEquals: ["States.ALL"], Next: "ReleaseFailed", Assign: { releaseError: "{% $states.errorOutput %}" } };
  // Marks the run terminal, only while it is active.
  const endRun = {
    TableName: props.stateTableName,
    Key: runKey,
    UpdateExpression: "SET #status = :status, #error = :error, updatedAt = :now, finishedAt = :now",
    ConditionExpression: ACTIVE.map((_, index) => `#status = :active${index}`).join(" OR "),
    ExpressionAttributeNames: { "#status": "status", "#error": "error" },
    ExpressionAttributeValues: {
      ":status": { S: "{% $endStatus %}" },
      ":error": { S: "{% $failure %}" },
      ":now": { S: "{% $now() %}" },
      ...Object.fromEntries(ACTIVE.map((status, index) => [`:active${index}`, { S: status }])),
    },
  };
  return {
    Comment: "Runs one SWE-bench task on its own x86 instance (spec 043)",
    QueryLanguage: "JSONata",
    StartAt: "Start",
    States: {
      Start: {
        Type: "Pass",
        Assign: {
          runId: "{% $states.input.runId %}",
          subnetId: "{% $states.input.subnetId %}",
          startedAt: "{% $toMillis($states.context.Execution.StartTime) %}",
          instanceId: null,
          graceLeft: GRACE_POLLS,
          endStatus: "FAILED",
          failure: null,
          releaseAttempts: 1,
          releaseError: null,
        },
        Next: "RunInstance",
      },
      RunInstance: {
        Type: "Task",
        Resource: ec2("runInstances"),
        Arguments: {
          LaunchTemplate: { LaunchTemplateId: props.launchTemplateId, Version: "$Default" },
          MinCount: 1,
          MaxCount: 1,
          SubnetId: "{% $subnetId %}",
          // One instance per run, however often this step is retried.
          ClientToken: "{% $runId %}",
          TagSpecifications: [
            { ResourceType: "instance", Tags: tags(`${props.resourcePrefix}-swebench`) },
            { ResourceType: "volume", Tags: tags(`${props.resourcePrefix}-swebench-root`) },
          ],
        },
        Assign: { instanceId: "{% $states.result.Instances[0].InstanceId %}" },
        Retry: RETRY,
        Catch: [toEnd("{% 'the eval instance could not be launched: ' & $states.errorOutput.Cause %}")],
        Next: "RecordInstance",
      },
      RecordInstance: {
        Type: "Task",
        Resource: "arn:aws:states:::dynamodb:updateItem",
        Arguments: {
          TableName: props.stateTableName,
          Key: runKey,
          UpdateExpression: "SET ec2InstanceId = :instance",
          ExpressionAttributeValues: { ":instance": { S: "{% $instanceId %}" } },
        },
        Retry: RETRY,
        Catch: [toEnd("{% 'the eval instance could not be recorded: ' & $states.errorOutput.Cause %}")],
        Next: "Wait",
      },
      Wait: { Type: "Wait", Seconds: SWEBENCH_POLL_SECONDS, Next: "ReadRun" },
      ReadRun: {
        Type: "Task",
        Resource: "arn:aws:states:::dynamodb:getItem",
        Arguments: { TableName: props.stateTableName, Key: runKey, ConsistentRead: true },
        Assign: { status: "{% $states.result.Item.status.S %}" },
        Retry: RETRY,
        Catch: [toEnd("{% 'the run record could not be read: ' & $states.errorOutput.Cause %}")],
        Next: "Decide",
      },
      Decide: {
        Type: "Choice",
        Choices: [
          { Condition: "{% $status in ['SUCCEEDED', 'FAILED', 'CANCELLED'] %}", Next: "Terminate" },
          { Condition: "{% $status = 'CANCEL_REQUESTED' %}", Next: "EndRun", Assign: { endStatus: "CANCELLED", failure: "cancelled from Slack" } },
          {
            Condition: `{% $toMillis($now()) - $startedAt > ${SWEBENCH_RUN_TIME_LIMIT_SECONDS * 1_000} %}`,
            Next: "EndRun",
            Assign: { endStatus: "FAILED", failure: `the run did not finish within its ${SWEBENCH_RUN_TIME_LIMIT_SECONDS / 3_600}-hour limit` },
          },
        ],
        Default: "DescribeInstance",
      },
      DescribeInstance: {
        Type: "Task",
        Resource: ec2("describeInstances"),
        Arguments: { InstanceIds: ["{% $instanceId %}"] },
        Assign: { instanceState: "{% $states.result.Reservations[0].Instances[0].State.Name %}" },
        Retry: RETRY,
        Catch: [{ ErrorEquals: ["States.ALL"], Next: "Wait" }],
        Next: "InstanceAlive",
      },
      InstanceAlive: {
        Type: "Choice",
        Choices: [
          { Condition: "{% $instanceState in ['pending', 'running'] %}", Next: "Wait" },
          { Condition: "{% $graceLeft > 0 %}", Next: "Wait", Assign: { graceLeft: "{% $graceLeft - 1 %}" } },
        ],
        Default: "EndRun",
        Assign: { endStatus: "FAILED", failure: "{% 'the eval instance stopped (' & $instanceState & ') without reporting a result; see its log stream' %}" },
      },
      // Marks the run terminal and releases its slot in one transaction, only while the run is active
      // and holds the slot, as the broker's finishRun does: between them the slot is released once.
      EndRun: {
        Type: "Task",
        Resource: "arn:aws:states:::aws-sdk:dynamodb:transactWriteItems",
        Arguments: {
          TransactItems: [
            { Update: endRun },
            { Delete: { TableName: props.stateTableName, Key: slotKey, ConditionExpression: "attribute_exists(pk)" } },
            {
              Update: {
                TableName: props.stateTableName,
                Key: COUNTER_KEY,
                UpdateExpression: "SET #count = #count - :one",
                ConditionExpression: "#count > :zero",
                ExpressionAttributeNames: { "#count": "count" },
                ExpressionAttributeValues: { ":one": { N: "1" }, ":zero": { N: "0" } },
              },
            },
          ],
        },
        Retry: DYNAMODB_RETRY,
        Catch: [
          // Cancelled: read back why rather than parse the error's message.
          { ErrorEquals: ["DynamoDb.TransactionCanceledException"], Next: "ReadEnded", Assign: { releaseError: "{% $states.errorOutput %}" } },
          toReleaseFailed,
        ],
        Next: "Terminate",
      },
      ReadEnded: {
        Type: "Task",
        Resource: "arn:aws:states:::aws-sdk:dynamodb:transactGetItems",
        Arguments: {
          TransactItems: [
            { Get: { TableName: props.stateTableName, Key: runKey } },
            { Get: { TableName: props.stateTableName, Key: slotKey } },
          ],
        },
        Assign: {
          endedStatus: "{% $exists($states.result.Responses[0].Item) ? $states.result.Responses[0].Item.status.S : 'MISSING' %}",
          slotHeld: "{% $exists($states.result.Responses[1].Item) %}",
        },
        Retry: RETRY,
        Catch: [toReleaseFailed],
        Next: "Released",
      },
      Released: {
        Type: "Choice",
        Choices: [
          // The runner's result arrived first: the broker ended the run and released its slot.
          { Condition: "{% $endedStatus in ['SUCCEEDED', 'FAILED', 'CANCELLED'] %}", Next: "Terminate" },
          // The run started under the one-run lock, before spec 052, and holds no slot.
          { Condition: "{% $endedStatus in ['STARTING', 'RUNNING', 'CANCEL_REQUESTED'] and $not($slotHeld) %}", Next: "EndRunWithoutSlot" },
          // Active and holding its slot: a conflict on the counter, tried again.
          {
            Condition: `{% $endedStatus in ['STARTING', 'RUNNING', 'CANCEL_REQUESTED'] and $releaseAttempts < ${RELEASE_ATTEMPTS} %}`,
            Next: "EndRunAgain",
            Assign: { releaseAttempts: "{% $releaseAttempts + 1 %}" },
          },
        ],
        Default: "ReleaseFailed",
      },
      EndRunAgain: { Type: "Wait", Seconds: 2, Next: "EndRun" },
      // The migration case: the run is ended alone, and the counter is left as it is.
      EndRunWithoutSlot: {
        Type: "Task",
        Resource: "arn:aws:states:::aws-sdk:dynamodb:updateItem",
        Arguments: endRun,
        Retry: DYNAMODB_RETRY,
        Catch: [
          // The runner's result arrived since the read: the run is terminal.
          { ErrorEquals: ["DynamoDb.ConditionalCheckFailedException", "DynamoDB.ConditionalCheckFailedException"], Next: "Terminate" },
          toReleaseFailed,
        ],
        Next: "Terminate",
      },
      // A release that failed: the instance is still terminated, then the execution fails.
      ReleaseFailed: {
        Type: "Choice",
        Choices: [{ Condition: "{% $instanceId = null %}", Next: "SlotReleaseFailed" }],
        Default: "TerminateBeforeFailing",
      },
      TerminateBeforeFailing: {
        Type: "Task",
        Resource: ec2("terminateInstances"),
        Arguments: { InstanceIds: ["{% $instanceId %}"] },
        Retry: RETRY,
        Catch: [{ ErrorEquals: ["States.ALL"], Next: "SlotReleaseFailed" }],
        Next: "SlotReleaseFailed",
      },
      SlotReleaseFailed: {
        Type: "Fail",
        Error: "SlotReleaseFailed",
        Cause: "{% 'the run ' & $runId & ' could not be ended and its eval slot released: ' & $string($releaseError) %}",
      },
      Terminate: {
        Type: "Choice",
        Choices: [{ Condition: "{% $instanceId = null %}", Next: "Done" }],
        Default: "TerminateInstance",
      },
      TerminateInstance: {
        Type: "Task",
        Resource: ec2("terminateInstances"),
        Arguments: { InstanceIds: ["{% $instanceId %}"] },
        Retry: RETRY,
        Next: "Done",
      },
      Done: { Type: "Succeed" },
    },
  };
}
