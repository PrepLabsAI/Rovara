// Port of the retired workflow/review route: a person re-runs only the exact candidate's passing checks.
import { ContinueDeveloperTaskRequestSchema, agentXError, workflowIsReviewOnly, type ContinueDeveloperTaskRequest } from "@agentx/contracts";
import { startReview } from "../build-step/start.js";
import type { TaskCaller, TaskFlowDeps } from "./deps.js";
import { CLOSED_TASK, admitRound, loadTaskAsOwner, ownerWords, parseBody, type TaskActionsOptions } from "./owner-round.js";
import { readTask, taskViewOf, type TaskView } from "./reads.js";
import type { OperationRecord, TaskRecord } from "./records.js";
import { fromDocument } from "./records.js";
import { workspaceKeys } from "./workspace-location.js";

/** A repeat uses the existing operation request record; no additional record kind or request shape. */
async function repeatedReview(deps: TaskFlowDeps, task: TaskRecord, request: ContinueDeveloperTaskRequest): Promise<boolean> {
  const location = await workspaceKeys(deps, task.workspaceId);
  const prior = await deps.store.get(location.operationRequestKey(task.ownerKey, request.requestId));
  if (prior === undefined) return false;
  const operation = typeof prior["operationId"] === "string" ? fromDocument<OperationRecord>(await deps.store.get(location.operationKey(prior["operationId"]))) : undefined;
  if (operation?.workflowMode !== "REVIEW" || operation.dispatch.payload["workflowReviewNote"] !== ownerWords(request.instructions)
    || (request.expectedRevision !== undefined && operation.workflowRevision !== request.expectedRevision + 1)
    || (request.candidateDigest !== undefined && (typeof operation.dispatch.payload["prompt"] !== "string" || !operation.dispatch.payload["prompt"].includes(request.candidateDigest)))) {
    throw agentXError("IDEMPOTENCY_CONFLICT", "this request ID was already used for another review; use a new one");
  }
  return true;
}

export async function reviewTaskOnRequest(deps: TaskFlowDeps, options: TaskActionsOptions, caller: TaskCaller, taskId: string, value: unknown): Promise<TaskView> {
  const { task, acting } = await loadTaskAsOwner(deps, caller, taskId);
  const request = parseBody(ContinueDeveloperTaskRequestSchema, value);
  if (await repeatedReview(deps, task, request)) return taskViewOf(deps, task);
  if (task.closedAt !== undefined) throw agentXError("CONFIG_INVALID", CLOSED_TASK);
  const workflow = task.workflow;
  const retrying = requireReviewCandidate(workflow, request);
  await admitRound(deps, options, { task, caller, requestId: request.requestId });
  const result = await startReview(deps, { taskId, workflowRevision: workflow!.revision }, {
    retry: retrying, manual: { requestId: request.requestId, note: ownerWords(request.instructions), extra: acting.items ?? [] },
  });
  if (result !== "STARTED" && !(result === "DUPLICATE" && await repeatedReview(deps, task, request))) {
    throw agentXError("WORKSPACE_BUSY", "the task changed or its workspace is busy; refresh and try again");
  }
  return taskViewOf(deps, (await readTask(deps, taskId)) ?? task);
}

function requireReviewCandidate(workflow: TaskRecord["workflow"], request: ContinueDeveloperTaskRequest): boolean {
  const retrying = workflow?.stage === "REVIEW" && workflow.state === "BLOCKED";
  if (workflow === undefined || workflow.stage !== "REVIEW" || !(workflow.state === "WAITING" || retrying)
    || workflow.candidate === undefined || workflow.verification?.candidateDigest !== workflow.candidate.digest
    || (workflow.verification.results.length === 0 && !(workflow.verification.reviewOnly === true && workflowIsReviewOnly(workflow.checkPolicy)))
    || workflow.verification.results.some(result => result.status !== "PASS")) {
    throw agentXError("CONFIG_INVALID", "review can start or retry only when the exact candidate's checks passed and the review is waiting or blocked");
  }
  if ((retrying && (request.expectedRevision !== workflow.revision || request.candidateDigest !== workflow.candidate.digest))
    || (request.expectedRevision !== undefined && request.expectedRevision !== workflow.revision)) {
    throw agentXError("IDEMPOTENCY_CONFLICT", "the review retry is stale; refresh the task and use its current candidate and revision");
  }
  return retrying;
}
