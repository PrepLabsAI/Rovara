import { quiesceCritic, settleQuiescedCritic } from "./quiesce.js";
import {
  WorkflowPublishRetryRequestSchema, WORKFLOW_KEEP_PULL_REQUESTS_NOTE, completeWorkflowFeedbackReview, decideWorkflowFeedbackFindings,
  keepWorkflowPullRequests, reviewCleared, agentXError, change, when, type TransactItem, type WorkflowSnapshot,
} from "@agentx/contracts";
import type { TaskCaller, TaskFlowDeps } from "../task-flow/deps.js";
import { stageAudit } from "../task-flow/admission.js";
import { buildOperation } from "../task-flow/accept.js";
import { resolveRowItem } from "../task-flow/dispatch-rows.js";
import { parseBody } from "../task-flow/owner-round.js";
import { readTask } from "../task-flow/reads.js";
import { readOperation } from "../task-flow/results.js";
import { commitWorkflow, readWorkspace } from "../task-flow/stage-machine.js";
import { toDocument, type TaskRecord, type OperationRecord } from "../task-flow/records.js";
import { iso } from "../task-flow/support.js";
import { feedbackDecisionKey, feedbackOwner } from "./decide.js";
import { feedbackDigest } from "./artifacts.js";
import { lifecycleReport, saveFeedbackReport } from "./recovery.js";
import { refreshFeedback } from "./validate.js";

async function collectingKeep(deps: TaskFlowDeps, task: TaskRecord, actorId: string, requestId: string, authority: Parameters<typeof decideWorkflowFeedbackFindings>[4]) {
  const wf = task.workflow!;
  const workspace = await readWorkspace(deps, task.workspaceId);
  if (workspace === undefined) throw agentXError("WORKSPACE_NOT_READY", "The feedback workspace is unavailable.");
  const now = iso(deps);
  const active = workspace.activeOperationId === null ? undefined : await readOperation(deps, task.workspaceId, workspace.activeOperationId);
  let operation: OperationRecord;
  const extra: TransactItem[] = [];
  if (wf.state === "RUNNING") {
    if (active?.workflowMode !== "FEEDBACK_REVIEW" || active.workflowRevision !== wf.revision || active.companyId !== deps.companyId) throw agentXError("WORKSPACE_BUSY", "A different operation holds the workspace.");
    const stopped = await quiesceCritic(deps, task, active);
    if (!stopped.confirmed) throw agentXError("WORKSPACE_BUSY", "The feedback worker is still stopping. Check the task or close it.");
    operation = active;
    extra.push({ kind: "update", key: active, ops: [change.set("status", "CANCELLED"), change.set("updatedAt", now)], condition: when.and(when.eq("fence", active.fence), when.eq("status", "CANCEL_REQUESTED")) },
      { kind: "update", key: workspace, ops: [change.set("activeOperationId", null), change.set("status", "READY")], condition: when.and(when.eq("activeOperationId", active.id), when.eq("fence", active.fence + 1)) });
  } else {
    const built = buildOperation(deps, { workspace, kind: "task", workflowMode: "FEEDBACK_REVIEW", requestId, workflowRevision: wf.revision,
      dispatch: { kind: "task", projectRevision: task.startingRevision, payload: {} } });
    operation = built.operation;
    extra.push({ kind: "put", item: toDocument({ ...operation, status: "FAILED" }), condition: when.absent() });
  }
  const ref = await saveFeedbackReport(deps, task, lifecycleReport(task, operation, now, "The owner kept the pull request before the feedback review completed."));
  const completed = completeWorkflowFeedbackReview({ ...wf, state: "RUNNING" }, { expectedRevision: wf.revision, taskId: task.taskId,
    candidateDigest: wf.candidate!.digest, operationId: operation.id, bundleRefs: wf.feedbackReview!.bundleRefs, reviewRef: ref }, now);
  // The report and dismissal are one workflow change. No intermediate review/card revision is persisted.
  const next = decideWorkflowFeedbackFindings({ ...completed, revision: wf.revision }, { requestId, expectedRevision: wf.revision,
    reviewDigest: ref.sha256, proposalDigest: ref.proposalDigest, bundleDigests: ref.bundleDigests, decision: "DISMISS", selectedFindingIds: [], ownerNote: WORKFLOW_KEEP_PULL_REQUESTS_NOTE },
  { actorId, role: "TASK_OWNER" }, now, authority);
  return { next, extra: [...extra, resolveRowItem(deps, task.taskId, wf.revision)], operation: wf.state === "RUNNING" ? operation : undefined };
}

async function keepReceipt(deps: TaskFlowDeps, key: ReturnType<typeof feedbackDecisionKey>, payloadHash: string, actorId: string) {
  const prior = await deps.store.get(key);
  if (prior !== undefined && (prior["payloadHash"] !== payloadHash || prior["actorId"] !== actorId)) throw agentXError("IDEMPOTENCY_CONFLICT", "This request belongs to another decision.");
  return prior;
}

export async function keepPrFeedback(deps: TaskFlowDeps, caller: TaskCaller, taskId: string, value: unknown) {
  const { task, acting } = await feedbackOwner(deps, caller, taskId);
  const body = parseBody(WorkflowPublishRetryRequestSchema, value);
  const key = feedbackDecisionKey(taskId, body.requestId);
  const payloadHash = feedbackDigest(JSON.stringify({ action: "keep", ...body }));
  const prior = await keepReceipt(deps, key, payloadHash, acting.actorId);
  if (task.workflow?.feedbackDecisions?.some(d => d.requestId === body.requestId && d.decision === "DISMISS" && d.actorId === acting.actorId)) return task;
  const wf = task.workflow;
  if (task.closedAt !== undefined || wf === undefined || wf.revision !== body.expectedRevision) throw agentXError("IDEMPOTENCY_CONFLICT", "The feedback card changed. Refresh the task.");
  // No paid fix or uncertain push is kept while it is running. The ordinary no-change transition also proves the original checked trees remain current.
  let next: WorkflowSnapshot;
  let extra: TransactItem[] = [];
  let stopped: OperationRecord | undefined;
  if (wf.stage === "WAIT_FOR_MERGE" && wf.feedbackReview?.status === "COLLECTING") {
    const claimed = prior !== undefined || (await deps.store.transact([
      { kind: "check", key: task, condition: when.and(when.eq("companyId", deps.companyId), when.eq(["workflow", "revision"], wf.revision), when.notExists("closedAt")) },
      ...(acting.items ?? []), { kind: "put", item: { ...key, entityType: "IDEMPOTENCY", payloadHash, actorId: acting.actorId }, condition: when.absent() },
    ])).applied;
    if (!claimed) throw agentXError("IDEMPOTENCY_CONFLICT", "The Keep request changed. Check the task.");
    const kept = await collectingKeep(deps, task, acting.actorId, body.requestId, acting.authority);
    ({ next, extra } = kept);
    stopped = kept.operation;
  } else {
    requireCheckedKeep(wf);
    await refreshFeedback(deps, task, true);
    const workspace = await readWorkspace(deps, task.workspaceId);
    if (workspace?.activeOperationId !== null) throw agentXError("WORKSPACE_BUSY", "Wait for the worker to stop, or close the task.");
    next = keepWorkflowPullRequests(wf, { requestId: body.requestId, actorId: acting.actorId, now: iso(deps) }, acting.authority);
    extra.push({ kind: "put", item: { ...key, entityType: "IDEMPOTENCY", payloadHash, actorId: acting.actorId }, condition: when.absent() });
  }
  const latest = await feedbackOwner(deps, caller, taskId);
  if (latest.acting.actorId !== acting.actorId) throw agentXError("IDEMPOTENCY_CONFLICT", "The owner authority changed. Check the task.");
  const committed = await commitWorkflow(deps, task, next, [...extra, ...(latest.acting.items ?? []), ...stageAudit(deps, {
    eventId: `task.feedback_kept:${taskId}:${body.requestId}`, actor: { type: "person", id: caller.principal.personId }, action: "task.feedback_kept",
    subject: { type: "task", id: taskId }, details: { revision: wf.revision },
  })], [], when.eq("companyId", deps.companyId));
  await requireKeepCommit(deps, committed, stopped);
  return (await readTask(deps, taskId))!;
}

async function requireKeepCommit(deps: TaskFlowDeps, committed: boolean, stopped: OperationRecord | undefined): Promise<void> {
  if (committed) return;
  if (stopped !== undefined) await settleQuiescedCritic(deps, stopped);
  throw agentXError("IDEMPOTENCY_CONFLICT", "The Keep outcome is unknown. Check the task.");
}

function requireCheckedKeep(workflow: WorkflowSnapshot): void {
  const candidate = workflow.candidate;
  const checked = candidate !== undefined && workflow.verification?.candidateDigest === candidate.digest
    && workflow.verification.results.every(r => r.status === "PASS") && (workflow.reviews?.length ?? 0) > 0
    && workflow.reviews!.every(r => r.candidateDigest === candidate.digest && reviewCleared(r, workflow.acceptedFindings));
  if (!checked) throw agentXError("CONFIG_INVALID", "The unchanged pull request's checked candidate could not be proven. Close the task or retry the fix.");
}
