// Owner selection is mandatory at every autonomy level. No model or repository writer decides paid work.
import {
  WorkflowFeedbackFindingsDecisionRequestSchema, WorkflowFeedbackReviewRetryRequestSchema, WorkflowFeedbackApprovalBindingSchema,
  decideWorkflowFeedbackFindings, retryWorkflowFeedbackReview, applyWorkflowFeedbackCheckChanges, workflowFeedbackCheckChanges,
  agentXError, when, type WorkflowSnapshot, type WorkflowFeedbackFinding,
} from "@agentx/contracts";
import type { TaskCaller, TaskFlowDeps } from "../task-flow/deps.js";
import { taskNotFound } from "../task-flow/access.js";
import { stageAudit } from "../task-flow/admission.js";
import { pressedRowItem } from "../task-flow/dispatch-rows.js";
import { admitRound, loadTaskAsOwner, parseBody } from "../task-flow/owner-round.js";
import { readTask } from "../task-flow/reads.js";
import { commitWorkflow } from "../task-flow/stage-machine.js";
import { toDocument, type TaskRecord } from "../task-flow/records.js";
import { iso } from "../task-flow/support.js";
import { isCoreFeedbackTask } from "./ownership.js";
import { assertPromptFits } from "../task-flow/accept.js";
import { feedbackDigest, readFeedbackBundles } from "./artifacts.js";
import { feedbackRoundOptions } from "./money.js";
import { requireSafeFeedbackSelection, feedbackFixPrompt, reviewFeedbackContext } from "./fix-context.js";
import { readFeedbackReport, refreshFeedback } from "./validate.js";

export const feedbackDecisionKey = (taskId: string, requestId: string) => ({ pk: `DEVTASK#${taskId}`, sk: `REQUEST#${requestId}` });

export async function feedbackOwner(deps: TaskFlowDeps, caller: TaskCaller, taskId: string) {
  const owned = await loadTaskAsOwner(deps, caller, taskId);
  if (!await isCoreFeedbackTask(deps, owned.task)) throw taskNotFound();
  return owned;
}

async function priorDecision(deps: TaskFlowDeps, key: ReturnType<typeof feedbackDecisionKey>, payloadHash: string, actorId: string): Promise<boolean> {
  const prior = await deps.store.get(key);
  if (prior === undefined) return false;
  if (prior["payloadHash"] !== payloadHash || prior["actorId"] !== actorId) throw agentXError("IDEMPOTENCY_CONFLICT", "This request was used for another feedback decision.");
  return true;
}

function decisionDispatch(deps: TaskFlowDeps, taskId: string, revision: number, decision: string, by: string) {
  const due = decision === "APPROVE" ? "IMPLEMENT" : decision === "REQUEST_CHANGES" ? "REVIEW" : undefined;
  return due === undefined ? [] : [pressedRowItem(deps, taskId, revision, due, iso(deps), by)];
}

async function approvedCheckChanges(deps: TaskFlowDeps, task: TaskRecord, selected: WorkflowFeedbackFinding[]) {
  const project = await deps.projects.revision(task.project, task.startingRevision);
  if (project === undefined) throw agentXError("CONFIG_INVALID", "The pinned project is unavailable.");
  const changes = workflowFeedbackCheckChanges(task.workflow!.checkPolicy, selected, project.definition.repositories.map(r => r.path));
  if (changes.problems.length > 0) throw agentXError("CONFIG_INVALID", "The selected feedback proposes an unsafe check change. Request changes or choose other findings.");
  return changes;
}

export async function decidePrFeedback(deps: TaskFlowDeps, caller: TaskCaller, taskId: string, value: unknown) {
  const { task, acting } = await feedbackOwner(deps, caller, taskId);
  const body = parseBody(WorkflowFeedbackFindingsDecisionRequestSchema, value);
  const payloadHash = feedbackDigest(JSON.stringify(body));
  const key = feedbackDecisionKey(taskId, body.requestId);
  if (await priorDecision(deps, key, payloadHash, acting.actorId)) return task;
  const current = task.workflow;
  if (task.closedAt !== undefined || current === undefined) throw agentXError("CONFIG_INVALID", "This task cannot accept feedback decisions.");
  await refreshFeedback(deps, task, body.decision === "DISMISS");
  const { ownerNote, ...request } = body;
  let next = decideWorkflowFeedbackFindings(current, { ...request, ...(ownerNote === undefined ? {} : { ownerNote }) }, { actorId: acting.actorId, role: "TASK_OWNER" }, iso(deps), acting.authority);
  if (body.decision === "APPROVE") {
    const report = await readFeedbackReport(deps, task);
    const selected = report.findings.filter(f => body.selectedFindingIds.includes(f.id));
    requireSafeFeedbackSelection(task, selected, body.ownerNote);
    reviewFeedbackContext(selected, body.ownerNote);
    const inputs = await readFeedbackBundles(deps.feedbackArtifacts!, task);
    const comments = inputs.flatMap(input => input.bundle.comments.filter(c => selected.some(f => f.bundleDigest === input.ref.sha256 && f.commentIds.includes(c.id))));
    assertPromptFits(feedbackFixPrompt(selected, comments, body.ownerNote, current.feedbackCiFailures?.checks ?? []));
    const decision = next.feedbackDecisions!.at(-1)!;
    WorkflowFeedbackApprovalBindingSchema.parse({ taskId, requestId: body.requestId, ownerId: task.ownerKey,
      decisionWorkflowRevision: current.revision, activeWorkflowRevision: next.revision, reviewDigest: body.reviewDigest, proposalDigest: body.proposalDigest,
      bundleDigests: body.bundleDigests, candidateDigest: current.candidate!.digest, selectedFindingIds: decision.selectedFindingIds, selectedCommentIds: decision.selectedCommentIds });
    next = applyWorkflowFeedbackCheckChanges(next, await approvedCheckChanges(deps, task, selected));
    next = { ...next, fixSource: "feedback" };
    await admitRound(deps, feedbackRoundOptions(deps), { task, caller, requestId: body.requestId });
  }
  if (body.decision === "REQUEST_CHANGES") {
    next = { ...next, feedbackReview: { status: "COLLECTING", bundleRefs: current.feedbackReview!.bundleRefs,
      threadObservations: current.feedbackReview!.threadObservations ?? [] },
      feedbackReviewHistory: [...(current.feedbackReviewHistory ?? []), current.feedbackReview!.reviewRef!] };
    await admitRound(deps, feedbackRoundOptions(deps), { task, caller, requestId: body.requestId });
  }
  // Live ownership and its conditional access proof are obtained again after host and artifact reads.
  const latest = await feedbackOwner(deps, caller, taskId);
  if (latest.task.workflow?.revision !== current.revision || latest.acting.actorId !== acting.actorId) throw agentXError("IDEMPOTENCY_CONFLICT", "The feedback card changed. Refresh the task.", { reason: "stale", writes: "none" });
  const committed = await commitWorkflow(deps, task, next, [
    ...(latest.acting.items ?? []),
    { kind: "put", item: toDocument({ ...key, entityType: "IDEMPOTENCY", payloadHash, actorId: acting.actorId, requester: caller.principal }), condition: when.absent() },
    ...decisionDispatch(deps, taskId, next.revision, body.decision, caller.principal.personId),
    ...stageAudit(deps, { eventId: `task.feedback_decided:${taskId}:${body.requestId}`, actor: { type: "person", id: caller.principal.personId },
      action: "task.feedback_decided", subject: { type: "task", id: taskId }, details: { decision: body.decision, revision: current.revision, selected: body.selectedFindingIds.length } }),
  ], [], when.eq("companyId", deps.companyId));
  if (!committed) throw agentXError("IDEMPOTENCY_CONFLICT", "The feedback decision did not commit. Check the task before trying again.");
  return (await readTask(deps, taskId))!;
}

export async function retryPrFeedback(deps: TaskFlowDeps, caller: TaskCaller, taskId: string, value: unknown) {
  const { task, acting } = await feedbackOwner(deps, caller, taskId);
  const body = parseBody(WorkflowFeedbackReviewRetryRequestSchema, value);
  const current = task.workflow;
  if (current?.feedbackReview?.status === "COLLECTING" && current.feedbackReviewHistory?.some(r => r.sha256 === body.reviewDigest && r.status !== "COMPLETE")) return { task, started: false };
  const next: WorkflowSnapshot = retryWorkflowFeedbackReview(current, { reviewDigest: body.reviewDigest, actor: { actorId: acting.actorId, role: "TASK_OWNER" }, now: iso(deps) }, acting.authority);
  await admitRound(deps, feedbackRoundOptions(deps), { task, caller, requestId: body.reviewDigest });
  const latest = await feedbackOwner(deps, caller, taskId);
  const committed = await commitWorkflow(deps, task, next, [...(latest.acting.items ?? []), pressedRowItem(deps, taskId, next.revision, "REVIEW", iso(deps), caller.principal.personId)], [], when.eq("companyId", deps.companyId));
  if (!committed) {
    const fresh = (await feedbackOwner(deps, caller, taskId)).task;
    if (fresh.workflow?.feedbackReviewHistory?.some(r => r.sha256 === body.reviewDigest)) return { task: fresh, started: false };
    throw agentXError("IDEMPOTENCY_CONFLICT", "The feedback retry changed. Refresh the task.");
  }
  return { task: (await readTask(deps, taskId))!, started: true };
}
