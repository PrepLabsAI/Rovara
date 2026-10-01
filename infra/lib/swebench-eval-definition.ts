// Amazon States Language (JSONata) for one SWE-bench run (spec 043 FR-006). The broker starts it with
// { runId, subnetId } once the run record, the deployment's lock and the run's launch file exist.
// It launches the eval instance, records it, polls the run until the runner reports or a limit ends
// it, and always terminates the instance. A run it ends (cancelled, over its ceiling, or an instance
// that stopped without reporting) it marks terminal and releases the lock, as the broker does for a
// reported result; a run already terminal is left as it is.
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
const ACTIVE = ["STARTING", "RUNNING", "CANCEL_REQUESTED"];

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
      // Marks the run terminal and releases the lock in one transaction, only while the run is active.
      EndRun: {
        Type: "Task",
        Resource: "arn:aws:states:::aws-sdk:dynamodb:transactWriteItems",
        Arguments: {
          TransactItems: [
            {
              Update: {
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
              },
            },
            {
              Delete: {
                TableName: props.stateTableName,
                Key: { pk: { S: "SWEBENCH#ACTIVE" }, sk: { S: "LOCK" } },
                ConditionExpression: "attribute_not_exists(pk) OR runId = :runId",
                ExpressionAttributeValues: { ":runId": { S: "{% $runId %}" } },
              },
            },
          ],
        },
        Retry: [{ ErrorEquals: ["DynamoDb.TransactionConflictException", "DynamoDb.ProvisionedThroughputExceededException", "DynamoDb.InternalServerErrorException"], IntervalSeconds: 2, MaxAttempts: 3, BackoffRate: 2 }],
        // Cancelled by its condition: the runner's result arrived first, and the run is terminal.
        Catch: [{ ErrorEquals: ["States.ALL"], Next: "Terminate" }],
        Next: "Terminate",
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
