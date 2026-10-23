// PLANINC-2: a run the owner stopped (or that was released after a failed stop) moves its workflow step to BLOCKED, so
// Retry is offered, instead of leaving the step RUNNING with nothing running.
//
// Three places use this, all conditional on the workflow row's revision, stage and RUNNING state, and on the workspace
// still being the one the run held:
// - the cancel's own terminal transaction (broker.ts builds the item with `completedWorkflowItems`; the predicate is here);
// - the stuck-cancel release, when the INTERRUPTED task's own late result arrives (`blockStoppedWorkflowRun`);
// - the owner's Retry planning on a row an earlier release already stranded (`strandedPlanningRun`, `recoverStrandedPlanning`).
// Nothing here adds an approval, queues a dispatch row, or starts an operation: the only change is RUNNING to BLOCKED.
import { GetCommand, TransactWriteCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { WORKFLOW_BLOCK_REASONS, WorkflowSnapshotSchema, blockWorkflow, type WorkflowSnapshot } from "@agentx/contracts";
import { taskKey, taskPointerKey, type DeveloperTaskRecord } from "../developer/task-records.js";
import { workflowRunEndedReason } from "./outbox-failure.js";

type WorkflowMode = "PLAN" | "IMPLEMENT" | "CHECKS" | "REVIEW" | "FEEDBACK_REVIEW";
type Client = Pick<DynamoDBDocumentClient, "send">;

/** The workflow stage a run of each mode occupies while it runs. */
export const WORKFLOW_STEP_STAGE: Readonly<Record<WorkflowMode, WorkflowSnapshot["stage"]>> = {
  PLAN: "PLAN", IMPLEMENT: "IMPLEMENT", CHECKS: "VERIFY", REVIEW: "REVIEW", FEEDBACK_REVIEW: "WAIT_FOR_MERGE",
};

/** The operation fields these rules read; an `OperationRecord` and the public `Operation` both fit. */
export interface StoppedRunOperation {
  id: string;
  workspaceId: string;
  kind: string;
  status: string;
  fence: number;
  createdAt: string;
  workflowMode?: WorkflowMode | undefined;
  workflowDependencies?: unknown;
  workflowE2EAdmission?: { purpose?: "baseline" | "replay" | undefined } | undefined;
  workflowFeedbackReview?: { taskId: string; workflowRevision: number; candidateDigest: string } | undefined;
}

/** The task fields these rules read; a `DeveloperTaskRecord` fits. */
export interface StoppedRunTask { closedAt?: string | undefined; workspaceId: string; workflow?: WorkflowSnapshot | undefined }

/** Why a step stopped when its run was stopped or released: fixed text, the same words a failed result records. */
export function stoppedStepReason(mode: WorkflowMode, endedAs: string): string {
  return mode === "FEEDBACK_REVIEW" ? WORKFLOW_BLOCK_REASONS.feedbackReviewFailed : workflowRunEndedReason(mode, endedAs);
}

/**
 * Whether the run that holds the workspace and was just stopped is the one the task's workflow is running, so the stop
 * should block that step. Runs with their own cancel handling are left to it: an ordered work breakdown (graph
 * IMPLEMENT keeps its checkpoint progress) and a native E2E round (its display record), and so are baseline and audit
 * replay rounds, which are never the workflow's own step.
 */
export function stopBlocksWorkflowStep(task: StoppedRunTask, run: StoppedRunOperation): boolean {
  const workflow = task.workflow;
  const mode = run.workflowMode;
  if (workflow === undefined || mode === undefined || run.kind !== "task") return false;
  if (task.closedAt !== undefined || task.workspaceId !== run.workspaceId) return false;
  if (workflow.state !== "RUNNING" || workflow.stage !== WORKFLOW_STEP_STAGE[mode]) return false;
  // A run that already ended settled its own step (or lost the race to something that did).
  if (run.status === "SUCCEEDED" || run.status === "FAILED" || run.status === "CANCELLED") return false;
  if (run.workflowDependencies !== undefined) return false;
  if (run.workflowE2EAdmission !== undefined && (mode === "CHECKS" || run.workflowE2EAdmission.purpose !== undefined)) return false;
  return true;
}

/**
 * Best effort, after the stuck-cancel release committed: the task's own late result proved its run ended, so its
 * workflow step stops being RUNNING. Never throws (the worker's callback must not fail for it), and does nothing unless
 * the task is still running that exact step. Returns whether the step was blocked.
 */
export async function blockStoppedWorkflowRun(client: Client, tableName: string, run: StoppedRunOperation, log: (entry: Record<string, unknown>) => void = (entry) => console.log(JSON.stringify(entry))): Promise<boolean> {
  try {
    const read = async (key: { pk: string; sk: string }) => (await client.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }))).Item;
    const pointer = await read(taskPointerKey(run.workspaceId)) as { taskId?: unknown } | undefined;
    if (typeof pointer?.taskId !== "string") return false;
    const task = await read(taskKey(pointer.taskId)) as (DeveloperTaskRecord & { workflow?: unknown }) | undefined;
    const parsed = WorkflowSnapshotSchema.safeParse(task?.workflow);
    if (task === undefined || !parsed.success) return false;
    const workflow = parsed.data;
    const mode = run.workflowMode;
    if (mode === undefined || !stopBlocksWorkflowStep({ closedAt: task.closedAt, workspaceId: task.workspaceId, workflow }, run)) return false;
    if (mode === "FEEDBACK_REVIEW") {
      const binding = run.workflowFeedbackReview;
      if (binding === undefined || workflow.revision !== binding.workflowRevision || workflow.taskId !== binding.taskId
        || workflow.candidate?.digest !== binding.candidateDigest || workflow.feedbackReview?.status !== "COLLECTING") return false;
    }
    const now = new Date().toISOString();
    // The workspace must still be free: a newer run that holds it now is the step's own, and is not for this result to block.
    await client.send(new TransactWriteCommand({ TransactItems: [
      { Update: {
        TableName: tableName, Key: taskKey(pointer.taskId),
        UpdateExpression: "SET workflow = :workflow, updatedAt = :now",
        ConditionExpression: "workflow.revision = :revision AND workflow.#stage = :stage AND workflow.#state = :running AND attribute_not_exists(closedAt)",
        ExpressionAttributeNames: { "#stage": "stage", "#state": "state" },
        ExpressionAttributeValues: { ":workflow": blockWorkflow(workflow, stoppedStepReason(mode, "INTERRUPTED"), now), ":now": now,
          ":revision": workflow.revision, ":stage": workflow.stage, ":running": "RUNNING" },
      } },
      { ConditionCheck: {
        TableName: tableName, Key: { pk: `WORKSPACE#${run.workspaceId}`, sk: "META" },
        ConditionExpression: "attribute_not_exists(activeOperationId) AND #status = :ready",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":ready": "READY" },
      } },
    ] }));
    log({ component: "broker", event: "workflow.released_run_blocked", operationId: run.id, workflowMode: mode });
    return true;
  } catch (failure) {
    // Names only: an error's own text could quote stored data. The owner's Retry recovers the row if this is lost.
    log({ component: "broker", event: "workflow.released_run_block_failed", operationId: run.id, error: failure instanceof Error ? failure.name : "unknown" });
    return false;
  }
}

/** The workspace fields the stranded-planning rules read (`WorkspaceInstance` fits). */
export interface StrandedWorkspace { id: string; status: string; fence: number; activeOperationId?: string | null | undefined }

/**
 * A planning step still RUNNING although its run ended and nothing holds the workspace: a stop recorded before this fix,
 * or one whose release never reached the workflow. Returns the planning run that ended, or undefined when the step is
 * really running (the workspace is held, or no planning run has ended) or the task is closed. An INTERRUPTED run only
 * counts once its workspace is free: a failed stop keeps the workspace held while the worker may still be running it.
 */
export function strandedPlanningRun<Run extends StoppedRunOperation>(
  task: StoppedRunTask,
  workspace: StrandedWorkspace,
  operations: readonly Run[],
): Run | undefined {
  const workflow = task.workflow;
  if (workflow === undefined || workflow.stage !== "PLAN" || workflow.state !== "RUNNING" || task.closedAt !== undefined) return undefined;
  if (workspace.id !== task.workspaceId || workspace.status !== "READY" || (workspace.activeOperationId !== undefined && workspace.activeOperationId !== null)) return undefined;
  const newest = operations
    .filter((operation) => operation.kind === "task" && operation.workflowMode === "PLAN" && operation.workflowE2EAdmission === undefined)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    .at(-1);
  return newest !== undefined && (newest.status === "CANCELLED" || newest.status === "FAILED" || newest.status === "INTERRUPTED") ? newest : undefined;
}

/**
 * Blocks a stranded planning step (see strandedPlanningRun) so the normal Retry planning can proceed, in one transaction:
 * the workflow row must still be this revision, PLAN and RUNNING; the workspace must still be free at the same fence;
 * the run must still have the status it was read with. True when it committed; false when any of those moved first
 * (the caller reads again). Idempotent: a second call finds the step BLOCKED and the conditions fail.
 */
export async function recoverStrandedPlanning(
  client: Client,
  tableName: string,
  task: Pick<DeveloperTaskRecord, "taskId"> & { workflow: WorkflowSnapshot },
  workspace: StrandedWorkspace,
  run: StoppedRunOperation,
  now: string,
): Promise<boolean> {
  const workflow = task.workflow;
  if (run.status !== "CANCELLED" && run.status !== "FAILED" && run.status !== "INTERRUPTED") return false;
  try {
    await client.send(new TransactWriteCommand({ TransactItems: [
      { Update: {
        TableName: tableName, Key: taskKey(task.taskId),
        UpdateExpression: "SET workflow = :workflow, updatedAt = :now",
        ConditionExpression: "workflow.revision = :revision AND workflow.#stage = :stage AND workflow.#state = :running AND attribute_not_exists(closedAt)",
        ExpressionAttributeNames: { "#stage": "stage", "#state": "state" },
        ExpressionAttributeValues: { ":workflow": blockWorkflow(workflow, stoppedStepReason("PLAN", run.status), now), ":now": now,
          ":revision": workflow.revision, ":stage": "PLAN", ":running": "RUNNING" },
      } },
      { ConditionCheck: {
        TableName: tableName, Key: { pk: `WORKSPACE#${workspace.id}`, sk: "META" },
        ConditionExpression: "attribute_not_exists(activeOperationId) AND fence = :fence AND #status = :ready",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":fence": workspace.fence, ":ready": "READY" },
      } },
      { ConditionCheck: {
        TableName: tableName, Key: { pk: `WORKSPACE#${workspace.id}`, sk: `OPERATION#${run.id}` },
        ConditionExpression: "#status = :status AND fence = :runFence",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":status": run.status, ":runFence": run.fence },
      } },
    ] }));
    return true;
  } catch (failure) {
    if (failure instanceof Error && failure.name === "TransactionCanceledException") return false;
    throw failure;
  }
}
