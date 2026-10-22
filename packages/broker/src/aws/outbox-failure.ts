import { GetCommand, TransactWriteCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { WORKFLOW_BLOCK_REASONS, WORKFLOW_PULL_REQUEST_UPDATE_WORKER_OUTDATED, WorkflowSnapshotSchema, blockWorkflow, blockWorkflowPullRequestUpdate } from "@agentx/contracts";
import { releaseFailedPreparation } from "./failed-preparation.js";
import type { DurableOutboxRecord } from "./lambda.js";
import { taskKey, taskPointerKey } from "../developer/task-records.js";

/**
 * Fails an outbox record's operation for good: the operation becomes FAILED, the workspace is
 * released (PREPARATION_FAILED after a prepare, READY otherwise; a cancel holds no workspace), and
 * the outbox record becomes FAILED, all in one transaction fenced on the invocation's fence.
 * `whileOutbox` adds a condition on the outbox record's current status. A failed prepare's
 * workspace then stops counting toward the workspace limits (#213).
 */
export async function failOutboxOperation(
  documentClient: Pick<DynamoDBDocumentClient, "send">,
  tableName: string,
  record: DurableOutboxRecord,
  error: string,
  whileOutbox?: { status: DurableOutboxRecord["status"] },
): Promise<void> {
  const now = new Date().toISOString();
  const releaseWorkspace = record.invocation.kind !== "cancel";
  const workspaceStatus = record.invocation.kind === "prepare" ? "PREPARATION_FAILED" : "READY";
  await documentClient.send(new TransactWriteCommand({
    TransactItems: [
      { Update: {
        TableName: tableName,
        Key: { pk: `WORKSPACE#${record.workspaceId}`, sk: `OPERATION#${record.operationId}` },
        UpdateExpression: "SET #status = :failed, updatedAt = :now, #result = :result, #error = :error",
        ConditionExpression: "(#status = :accepted OR #status = :dispatching) AND fence = :fence",
        ExpressionAttributeNames: {
          "#status": "status",
          "#result": "result",
          "#error": "error",
        },
        ExpressionAttributeValues: {
          ":failed": "FAILED",
          ":accepted": "ACCEPTED",
          ":dispatching": "DISPATCHING",
          ":now": now,
          ":result": null,
          ":error": error,
          ":fence": record.invocation.fence,
        },
      } },
      ...(releaseWorkspace ? [{ Update: {
        TableName: tableName,
        Key: { pk: `WORKSPACE#${record.workspaceId}`, sk: "META" },
        UpdateExpression: "SET #status = :workspaceStatus, updatedAt = :now REMOVE activeOperationId",
        ConditionExpression: "activeOperationId = :operation AND fence = :fence",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":workspaceStatus": workspaceStatus,
          ":now": now,
          ":operation": record.operationId,
          ":fence": record.invocation.fence,
        },
      } }] : []),
      { Update: {
        TableName: tableName,
        Key: { pk: `OUTBOX#${record.id}`, sk: "OUTBOX" },
        UpdateExpression: "SET #status = :failed, failedAt = :now, #error = :error",
        ...(whileOutbox === undefined ? {} : { ConditionExpression: "#status = :expected" }),
        ExpressionAttributeNames: { "#status": "status", "#error": "error" },
        ExpressionAttributeValues: {
          ":failed": "FAILED",
          ":now": now,
          ":error": error,
          ...(whileOutbox === undefined ? {} : { ":expected": whileOutbox.status }),
        },
      } },
    ],
  }));
  if (record.invocation.kind === "prepare") await releaseFailedPreparation(documentClient, tableName, record.workspaceId);
  if (record.invocation.kind === "maintain") await blockFailedPullRequestUpdate(documentClient, tableName, record.workspaceId, record.operationId, error);
  if (record.invocation.kind === "task") await blockFailedWorkflowRun(documentClient, tableName, record.workspaceId, record.operationId);
}

/** Why a workflow step stopped when its run ended FAILED or INTERRUPTED: the reason a failed result records too. */
export function workflowRunEndedReason(workflowMode: "PLAN" | "IMPLEMENT" | "CHECKS" | "REVIEW", status: string): string {
  const step = workflowMode === "PLAN" ? "planning" : workflowMode === "CHECKS" ? "verification retry" : workflowMode === "REVIEW" ? "independent review" : "implementation";
  return `${step} operation ended ${status.toLowerCase()}`;
}

/**
 * A workflow task's step whose run ended without reaching the worker's result (the dispatcher gave up delivering it, or
 * the worker's compute was lost): the task stops with its retry, as a failed result would leave it, instead of showing
 * the step running for ever. Only a task still running that step is blocked; a failed write is logged, since the
 * operation itself is already failed.
 */
async function blockFailedWorkflowRun(documentClient: Pick<DynamoDBDocumentClient, "send">, tableName: string, workspaceId: string, operationId: string): Promise<void> {
  try {
    const read = async (key: { pk: string; sk: string }) => (await documentClient.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }))).Item;
    const operation = await read({ pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${operationId}` }) as {
      workflowMode?: string; workflowFeedbackReview?: { taskId?: string; workflowRevision?: number; candidateDigest?: string }; workflowE2EAdmission?: { purpose?: string };
    } | undefined;
    const mode = operation?.workflowMode;
    if (mode === undefined) return;
    // M1.3 Task 3.7b: a baseline round (the unchanged code, for information only) that is lost never blocks the workflow; its record says it could not be checked.
    if (operation?.workflowE2EAdmission?.purpose === "baseline") return;
    const pointer = await read(taskPointerKey(workspaceId)) as { taskId?: string } | undefined;
    if (typeof pointer?.taskId !== "string") return;
    const task = await read(taskKey(pointer.taskId)) as { closedAt?: string; workflow?: unknown } | undefined;
    const parsed = WorkflowSnapshotSchema.safeParse(task?.workflow);
    if (task === undefined || task.closedAt !== undefined || !parsed.success || parsed.data.state !== "RUNNING") return;
    const workflow = parsed.data;
    let reason: string;
    if (mode === "FEEDBACK_REVIEW") {
      const binding = operation?.workflowFeedbackReview;
      if (binding === undefined || workflow.stage !== "WAIT_FOR_MERGE" || workflow.revision !== binding.workflowRevision || workflow.taskId !== binding.taskId
        || workflow.candidate?.digest !== binding.candidateDigest || workflow.feedbackReview?.status !== "COLLECTING") return;
      reason = WORKFLOW_BLOCK_REASONS.feedbackReviewFailed;
    } else if (mode === "IMPLEMENT" || mode === "CHECKS" || mode === "REVIEW" || (mode === "PLAN" && workflow.stage === "PLAN")) {
      reason = workflowRunEndedReason(mode, "FAILED");
    } else {
      return;
    }
    const now = new Date().toISOString();
    await documentClient.send(new UpdateCommand({
      TableName: tableName, Key: taskKey(pointer.taskId),
      UpdateExpression: "SET workflow = :workflow, updatedAt = :now",
      ConditionExpression: "workflow.revision = :revision AND workflow.#stage = :stage AND workflow.#state = :running AND attribute_not_exists(closedAt)",
      ExpressionAttributeNames: { "#stage": "stage", "#state": "state" },
      ExpressionAttributeValues: { ":workflow": blockWorkflow(workflow, reason, now), ":now": now, ":revision": workflow.revision, ":stage": workflow.stage, ":running": "RUNNING" },
    }));
  } catch (failure) {
    console.log(JSON.stringify({ component: "broker", event: "workflow.lost_run_block_failed", operationId, error: failure instanceof Error ? failure.name : "unknown" }));
  }
}

/**
 * A workflow task's push of its reviewed fix that ended without reaching the worker's result (the worker refused it, or
 * could not be reached, or its compute was lost): the task waits for the merge, blocked, naming the pull request, as a
 * failed result would leave it. Only the push the task still waits on is blocked; a failed write is logged, since the
 * operation itself is already failed.
 */
async function blockFailedPullRequestUpdate(documentClient: Pick<DynamoDBDocumentClient, "send">, tableName: string, workspaceId: string, operationId: string, error: string): Promise<void> {
  try {
    const read = async (key: { pk: string; sk: string }) => (await documentClient.send(new GetCommand({ TableName: tableName, Key: key }))).Item;
    const operation = await read({ pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${operationId}` }) as { maintenance?: { repository?: string; pullRequestNumber?: number; workflowCandidate?: { candidateDigest?: string } } } | undefined;
    const binding = operation?.maintenance?.workflowCandidate;
    if (binding === undefined) return;
    const pointer = await read(taskPointerKey(workspaceId)) as { taskId?: string } | undefined;
    if (typeof pointer?.taskId !== "string") return;
    const task = await read(taskKey(pointer.taskId)) as { closedAt?: string; workflow?: unknown } | undefined;
    const workflow = WorkflowSnapshotSchema.safeParse(task?.workflow);
    if (task === undefined || task.closedAt !== undefined || !workflow.success || workflow.data.stage !== "PULL_REQUEST" || workflow.data.state !== "RUNNING"
      || workflow.data.candidate?.digest !== binding.candidateDigest || typeof operation?.maintenance?.pullRequestNumber !== "number") return;
    const now = new Date().toISOString();
    const next = blockWorkflowPullRequestUpdate(workflow.data, { numbers: [operation.maintenance.pullRequestNumber],
      ...(error.includes(WORKFLOW_PULL_REQUEST_UPDATE_WORKER_OUTDATED) ? { cause: "WORKER_OUTDATED" as const } : {}), now });
    await documentClient.send(new UpdateCommand({
      TableName: tableName, Key: taskKey(pointer.taskId),
      UpdateExpression: "SET workflow = :workflow, updatedAt = :now",
      ConditionExpression: "workflow.revision = :revision AND workflow.#stage = :stage AND workflow.#state = :running AND attribute_not_exists(closedAt)",
      ExpressionAttributeNames: { "#stage": "stage", "#state": "state" },
      ExpressionAttributeValues: { ":workflow": next, ":now": now, ":revision": workflow.data.revision, ":stage": "PULL_REQUEST", ":running": "RUNNING" },
    }));
  } catch (failure) {
    console.log(JSON.stringify({ component: "broker", event: "workflow.pull_request_update_block_failed", operationId, error: failure instanceof Error ? failure.name : "unknown" }));
  }
}

/**
 * Fails the workspace's active operation, whatever stage it reached, and releases the workspace:
 * for the reconciler when a worker's compute is lost mid-operation (#86). Fenced on the operation's
 * fence, so an operation that finished or was replaced meanwhile is left alone. A lost prepare's
 * workspace stops counting toward the workspace limits (#213). Returns the failed
 * operation's ID, or undefined when there was none to fail.
 */
export async function failActiveOperation(
  documentClient: Pick<DynamoDBDocumentClient, "send">,
  tableName: string,
  workspaceId: string,
  error: string,
): Promise<string | undefined> {
  const workspace = (await documentClient.send(new GetCommand({ TableName: tableName, Key: { pk: `WORKSPACE#${workspaceId}`, sk: "META" } }))).Item as { activeOperationId?: unknown } | undefined;
  const operationId = workspace?.activeOperationId;
  if (typeof operationId !== "string") return undefined;
  const operation = (await documentClient.send(new GetCommand({
    TableName: tableName,
    Key: { pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${operationId}` },
  }))).Item as { kind?: string; fence?: number; closePreviousStatus?: string } | undefined;
  if (operation?.fence === undefined) return undefined;
  const released = operation.kind === "prepare"
    ? "PREPARATION_FAILED"
    : operation.kind === "close" && typeof operation.closePreviousStatus === "string" ? operation.closePreviousStatus : "READY";
  const now = new Date().toISOString();
  try {
    await documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Update: {
        TableName: tableName,
        Key: { pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${operationId}` },
        UpdateExpression: "SET #status = :failed, updatedAt = :now, #result = :result, #error = :error",
        ConditionExpression: "(#status = :accepted OR #status = :dispatching OR #status = :running OR #status = :cancelRequested) AND fence = :fence",
        ExpressionAttributeNames: { "#status": "status", "#result": "result", "#error": "error" },
        ExpressionAttributeValues: {
          ":failed": "FAILED", ":now": now, ":result": null, ":error": error, ":fence": operation.fence,
          ":accepted": "ACCEPTED", ":dispatching": "DISPATCHING", ":running": "RUNNING", ":cancelRequested": "CANCEL_REQUESTED",
        },
      } },
      { Update: {
        TableName: tableName,
        Key: { pk: `WORKSPACE#${workspaceId}`, sk: "META" },
        UpdateExpression: "SET #status = :released, updatedAt = :now REMOVE activeOperationId",
        ConditionExpression: "activeOperationId = :operation AND fence = :fence",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":released": released, ":now": now, ":operation": operationId, ":fence": operation.fence },
      } },
    ] }));
    if (released === "PREPARATION_FAILED") await releaseFailedPreparation(documentClient, tableName, workspaceId);
    if (operation.kind === "maintain") await blockFailedPullRequestUpdate(documentClient, tableName, workspaceId, operationId, error);
    if (operation.kind === "task") await blockFailedWorkflowRun(documentClient, tableName, workspaceId, operationId);
    return operationId;
  } catch (failure) {
    if (failure instanceof Error && failure.name === "TransactionCanceledException") return undefined;
    throw failure;
  }
}
