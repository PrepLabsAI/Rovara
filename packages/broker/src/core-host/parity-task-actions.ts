// The retired developer action schemas over the core's existing steps. Authority and the round's money are checked before writes.
import {
  AgentXError, ContinueDeveloperTaskRequestSchema, WorkflowPublishRetryRequestSchema, agentXError, when, workflowPublicationRetryable, workflowReadmitsApplicationRound, workflowSelectedChecks,
  type ContinueDeveloperTaskRequest, type DocumentStore, type TransactItem, type WorkflowSnapshot,
} from "@agentx/contracts";
import { reviewTaskOnRequest } from "../core/task-flow/manual-review.js";
import { startPublication } from "../core/build-step/publish.js";
import { startChecksRerun, startImplementation, uuidFrom } from "../core/build-step/start.js";
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
// One sentence, one meaning. "this retry is out of date; ..." is thrown ONLY before anything is written (a revision the owner did not see), and the developer-tasks.ts "the verification retry is stale; ..." likewise, so a
// client may treat them as "nothing happened". A REPLAY of a request that already committed is answered as a replay (replayedStep / publishRetryReplayed) before either of them can be reached, so they never fire for
// a request that wrote something. Every refusal after the round was admitted or the step started may follow a committed write (a block, a resolved dispatch row, a started run), so it
// has its own words and never claims nothing happened. Same code (no new public contract field): a client matches on code plus sentence, so these stay unknown to it.
const AFTER_START = {
  checks: "the verification retry may already have started; refresh the task and check its progress before choosing checks again",
  coding: "the coding retry may already have started; refresh the task and check its progress before trying again",
  planning: "the planning retry may already have started; refresh the task and check its progress before trying again",
  publication: "the publication retry may already have started; refresh the task and check its progress before trying again",
  review: "the review retry may already have started; refresh the task and check its progress before trying again",
} as const;
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
  if (action === "workflow/publish-retry" && await publishRetryReplayed(deps, task, request.expectedRevision)) return;
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
      if (error instanceof AgentXError && error.code === "WORKSPACE_BUSY") stale(AFTER_START.review);
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
  started(await startPublication(deps, { taskId: task.taskId, workflowRevision: workflow.revision }, { ownerRetry: true }), AFTER_START.publication);
}

async function retryStep(deps: TaskFlowDeps, options: TaskActionsOptions, caller: TaskCaller, task: TaskRecord, request: ContinueDeveloperTaskRequest, actorId: string): Promise<void> {
  const workflow = task.workflow!;
  if (workflow.state !== "BLOCKED" && !verificationRetryOffered(workflow)) throw agentXError("CONFIG_INVALID", NOTHING_TO_RETRY_STEP);
  if (request.expectedRevision !== undefined && request.expectedRevision !== workflow.revision) stale("this retry is out of date; refresh the task and try again");
  if (verificationRetryOffered(workflow)) {
    if (request.expectedRevision === undefined) throw agentXError("CONFIG_INVALID", "refresh the task and include its current revision before retrying verification");
    const selection = checkSelection(workflow, request);
    await admitRound(deps, options, { task, caller, requestId: request.requestId });
    started(await startChecksRerun(deps, { taskId: task.taskId, workflowRevision: workflow.revision }, { requestId: request.requestId, actorId, ...selection, manual: request }), AFTER_START.checks);
    return;
  }
  await admitRound(deps, options, { task, caller, requestId: request.requestId });
  const row = { taskId: task.taskId, workflowRevision: workflow.revision };
  if (workflow.stage === "IMPLEMENT") {
    started(await startImplementation(deps, row, request), AFTER_START.coding);
  } else if (workflow.stage === "PLAN") {
    await retryPlanning(deps, task, request);
  } else await retryBlockedStep(deps, task.taskId, request.expectedRevision);
}

/**
 * A publication retry has no operation under the client's request id (its operation id is made from the task, revision, candidate, repository and attempt), so a replay is recognised by what the
 * commit left: an owner-retry publish operation (it moved the revision by one) that started at the revision the client saw. Such a request already committed; answering it as stale would say "nothing was written".
 */
async function publishRetryReplayed(deps: TaskFlowDeps, task: TaskRecord, expectedRevision: number | undefined): Promise<boolean> {
  const digest = task.workflow?.candidate?.digest;
  if (expectedRevision === undefined || digest === undefined) return false;
  return (await workspaceOperations(deps, task.workspaceId)).some((operation) => operation.kind === "publish" && operation.publication?.workflowRevision === expectedRevision && operation.workflowRevision === expectedRevision + 1 && operation.publication.candidateDigest === digest);
}

function verificationRetryOffered(workflow: WorkflowSnapshot): boolean {
  return workflow.stage === "VERIFY" && workflow.state === "BLOCKED" || workflowPublicationRetryable(workflow) && (workflow.pullRequests?.length ?? 0) === 0;
}

async function replayedStep(deps: TaskFlowDeps, task: TaskRecord, requestId: string, action: string): Promise<boolean> {
  // A checks retry records its request id (made into a UUID) on the workflow when it commits: the e2e round runs under a DERIVED operation id, and a refused test plan writes a block and no operation at all.
  if (action === "workflow/retry" && task.workflow?.verificationRetries?.some((retry) => retry.requestId === uuidFrom(requestId)) === true) return true;
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
  started((await acceptStepWithNotes(deps, { task, workspace, requestId: request.requestId, prompt: request.instructions, workflowMode: "PLAN", workflow: { current: workflow, next: { ...base, revision: workflow.revision + 1, state: "RUNNING", updatedAt: iso(deps) } }, payload: { planFormat: "structured", ...(workflow.reviewPhase === undefined ? {} : { workflowPhase: workflow.reviewPhase }) }, requires: ["task.workflowMode", "task.structuredPlans"] })).result, AFTER_START.planning);
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
