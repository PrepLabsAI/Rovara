// The retired developer action schemas over the core's existing steps. Authority and the round's money are checked before writes.
import {
  AgentXError, ContinueDeveloperTaskRequestSchema, WorkflowPublishRetryRequestSchema, agentXError, when, workflowPublicationRetryable, workflowReadmitsApplicationRound, workflowSelectedChecks,
  type ContinueDeveloperTaskRequest, type DocumentStore, type TransactItem, type WorkflowSnapshot,
} from "@agentx/contracts";
import { reviewTaskOnRequest } from "../core/task-flow/manual-review.js";
import { startPublication } from "../core/build-step/publish.js";
import { startChecksRerun, startImplementation } from "../core/build-step/start.js";
import type { TaskRecord } from "../core/task-flow/records.js";
import type { TaskCaller, TaskFlowDeps } from "../core/task-flow/deps.js";
import { CLOSED_TASK, WAITING_FOR_SPEND, admitRound, loadTaskAsOwner, parseBody, requireMayStartWork, waitingForSpend, type TaskActionsOptions } from "../core/task-flow/owner-round.js";
import { acceptStepWithNotes, readWorkspace } from "../core/task-flow/stage-machine.js";
import { workspaceOperations } from "../core/task-flow/reads.js";
import { iso } from "../core/task-flow/support.js";
import { retryBlockedStep, NOTHING_TO_RETRY_STEP } from "../core/task-flow/retry.js";

/** Keep the live People fence in the core step's own transaction, including a blocked planning retry. */
function fencedFlow(deps: TaskFlowDeps, fence: readonly TransactItem[]): TaskFlowDeps {
  const store = deps.store;
  const guarded: DocumentStore = {
    indexes: store.indexes, ...(store.ttlAttribute === undefined ? {} : { ttlAttribute: store.ttlAttribute }), ...(store.changes === undefined ? {} : { changes: store.changes }),
    get: (key) => store.get(key), getMany: (keys) => store.getMany(keys), put: (input) => store.put(input), update: (input) => store.update(input), delete: (input) => store.delete(input),
    query: (input) => store.query(input), queryIndex: (input) => store.queryIndex(input),
    transact: (items) => store.transact(withFence(items, fence)),
  };
  return { ...deps, store: guarded };
}

function withFence(items: readonly TransactItem[], fence: readonly TransactItem[]): TransactItem[] {
  const result = [...items];
  for (const guard of fence) {
    if (guard.kind !== "check") throw agentXError("CONFIG_INVALID", "the task's access fence could not be checked");
    const same = result.findIndex((item) => item.kind === "check" && item.key.pk === guard.key.pk && item.key.sk === guard.key.sk);
    const prior = result[same];
    if (prior?.kind === "check") result[same] = { ...prior, condition: when.and(prior.condition, guard.condition) };
    else result.push(guard);
  }
  return result;
}

const stale = (message: string): never => { throw agentXError("IDEMPOTENCY_CONFLICT", message); };
const started = (result: string, message: string): void => {
  if (result === "STALE") stale(message);
  if (result === "WAITING") throw agentXError("WORKSPACE_NOT_READY", "The workspace is not ready yet. Try again in a moment.");
};

export async function runParityTaskAction(deps: TaskFlowDeps, options: TaskActionsOptions, caller: TaskCaller, taskId: string, action: string, value: unknown): Promise<void> {
  const request = action === "workflow/publish-retry" ? parseBody(WorkflowPublishRetryRequestSchema, value) : parseBody(ContinueDeveloperTaskRequestSchema, value);
  const { task, acting } = await loadTaskAsOwner(deps, caller, taskId);
  if (task.closedAt !== undefined) throw agentXError("CONFIG_INVALID", CLOSED_TASK);
  const workflow = task.workflow;
  if (workflow === undefined) throw agentXError("NOT_FOUND", "this task does not have a workflow record");
  if (action !== "workflow/publish-retry" && await replayedStep(deps, task, request.requestId, action)) return;
  if (waitingForSpend(workflow)) throw agentXError("CONFIG_INVALID", WAITING_FOR_SPEND);
  const flow = fencedFlow(deps, acting.items ?? []);
  if (action === "workflow/publish-retry") {
    await publishRetry(flow, task, request.expectedRevision);
    return;
  }
  if (!("instructions" in request)) throw agentXError("CONFIG_INVALID", "instructions: required");
  if (workflow.stage === "REVIEW") {
    await reviewTaskOnRequest(deps, options, caller, taskId, value).catch((error: unknown) => {
      // Keep workflow/retry's stale refusal while using the owner's single review implementation.
      if (error instanceof AgentXError && error.code === "WORKSPACE_BUSY") stale("the review retry is stale; refresh the task and try again");
      throw error;
    });
    return;
  }
  await retryStep(flow, options, caller, task, request, acting.actorId);
}

async function publishRetry(deps: TaskFlowDeps, task: TaskRecord, expectedRevision: number | undefined): Promise<void> {
  const workflow = task.workflow!;
  if (!workflowPublicationRetryable(workflow) || workflow.candidate === undefined) throw agentXError("CONFIG_INVALID", "Rovara can retry opening the pull request only after the checks and reviews passed and before it is open");
  if (expectedRevision !== workflow.revision) stale("this retry is out of date; refresh the task and try again");
  await requireMayStartWork(deps, task);
  started(await startPublication(deps, { taskId: task.taskId, workflowRevision: workflow.revision }, { ownerRetry: true }), "this retry is out of date; refresh the task and try again");
}

async function retryStep(deps: TaskFlowDeps, options: TaskActionsOptions, caller: TaskCaller, task: TaskRecord, request: ContinueDeveloperTaskRequest, actorId: string): Promise<void> {
  const workflow = task.workflow!;
  if (workflow.state !== "BLOCKED" && !verificationRetryOffered(workflow)) throw agentXError("CONFIG_INVALID", NOTHING_TO_RETRY_STEP);
  if (request.expectedRevision !== undefined && request.expectedRevision !== workflow.revision) stale("this retry is out of date; refresh the task and try again");
  if (verificationRetryOffered(workflow)) {
    if (request.expectedRevision === undefined) throw agentXError("CONFIG_INVALID", "refresh the task and include its current revision before retrying verification");
    const selection = checkSelection(workflow, request);
    await admitRound(deps, options, { task, caller, requestId: request.requestId });
    started(await startChecksRerun(deps, { taskId: task.taskId, workflowRevision: workflow.revision }, { requestId: request.requestId, actorId, ...selection, manual: request }), "the verification retry is stale; refresh the task and choose checks again");
    return;
  }
  await admitRound(deps, options, { task, caller, requestId: request.requestId });
  const row = { taskId: task.taskId, workflowRevision: workflow.revision };
  if (workflow.stage === "IMPLEMENT") {
    started(await startImplementation(deps, row, request), "this retry is out of date; refresh the task and try again");
  } else if (workflow.stage === "PLAN") {
    await retryPlanning(deps, task, request);
  } else await retryBlockedStep(deps, task.taskId, request.expectedRevision);
}

function verificationRetryOffered(workflow: WorkflowSnapshot): boolean {
  return workflow.stage === "VERIFY" && workflow.state === "BLOCKED" || workflowPublicationRetryable(workflow) && (workflow.pullRequests?.length ?? 0) === 0;
}

async function replayedStep(deps: TaskFlowDeps, task: TaskRecord, requestId: string, action: string): Promise<boolean> {
  const prior = (await workspaceOperations(deps, task.workspaceId)).find((operation) => operation.requestId === requestId);
  if (prior === undefined) return false;
  if (action === "workflow/retry" && ["PLAN", "IMPLEMENT", "CHECKS", "REVIEW"].includes(prior.workflowMode ?? "")) return true;
  throw agentXError("IDEMPOTENCY_CONFLICT", "this request ID was already used for another action on this task");
}

async function retryPlanning(deps: TaskFlowDeps, task: TaskRecord, request: ContinueDeveloperTaskRequest): Promise<void> {
  const workspace = await readWorkspace(deps, task.workspaceId);
  if (workspace === undefined) throw agentXError("WORKSPACE_NOT_READY", "The workspace is not ready yet. Try again in a moment.");
  const workflow = task.workflow!;
  const { blockReason: _reason, ...base } = workflow;
  void _reason;
  started((await acceptStepWithNotes(deps, { task, workspace, requestId: request.requestId, prompt: request.instructions, workflowMode: "PLAN", workflow: { current: workflow, next: { ...base, revision: workflow.revision + 1, state: "RUNNING", updatedAt: iso(deps) } }, payload: { planFormat: "structured", ...(workflow.reviewPhase === undefined ? {} : { workflowPhase: workflow.reviewPhase }) }, requires: ["task.workflowMode", "task.structuredPlans"] })).result, "this retry is out of date; refresh the task and try again");
}

function checkSelection(workflow: WorkflowSnapshot, request: { selectedOptionalCheckIds?: string[] | undefined; selectedProposedCheckIds?: string[] | undefined }): { policy: NonNullable<WorkflowSnapshot["checkPolicy"]> } {
  const policy = workflow.checkPolicy;
  const selectedOptionalIds = request.selectedOptionalCheckIds ?? policy?.selectedOptionalIds ?? [];
  if (policy === undefined || selectedOptionalIds.some((id) => !policy.optional.some((check) => check.id === id))) throw agentXError("CONFIG_INVALID", "choose checks that are approved for this project");
  const selectedProposedIds = request.selectedProposedCheckIds ?? policy.selectedProposedIds ?? policy.proposed.map((check) => check.id);
  if (selectedProposedIds.some((id) => !policy.proposed.some((check) => check.id === id))) throw agentXError("CONFIG_INVALID", "choose checks proposed by the approved plan");
  const selected = { ...policy, selectedOptionalIds, selectedProposedIds };
  if (workflowSelectedChecks(selected).length === 0 && !workflowReadmitsApplicationRound(workflow)) throw agentXError("CONFIG_INVALID", "keep at least one approved check before retrying verification");
  return { policy: selected };
}
