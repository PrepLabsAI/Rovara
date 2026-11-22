import { quiesceCritic, settleQuiescedCritic, recoverCriticHold } from "./quiesce.js";
// Lifecycle failures are advisory reports on existing OPERATION records, never invented worker success.
import { WorkflowFeedbackReviewReportSchema, WorkflowFeedbackReviewRefSchema, completeWorkflowFeedbackReview, when, type WorkflowFeedbackReviewReport, type WorkflowFeedbackReviewRef } from "@agentx/contracts";
import { buildOperation } from "../task-flow/accept.js";
import { dispatchRowItem, resolveRowItem } from "../task-flow/dispatch-rows.js";
import { dispatchRowKey } from "../task-flow/keys.js";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import type { OperationRecord, TaskRecord } from "../task-flow/records.js";
import { toDocument } from "../task-flow/records.js";
import { readTask, workspaceOperations } from "../task-flow/reads.js";
import { isTerminalStatus, readOperation } from "../task-flow/results.js";
import { commitWorkflow, readWorkspace } from "../task-flow/stage-machine.js";
import { iso } from "../task-flow/support.js";
import { feedbackDigest, feedbackReportPrefix, writeFeedbackBytes } from "./artifacts.js";

export const PR_FEEDBACK_REVIEW_DEADLINE_MS = 12 * 60_000;

export async function saveFeedbackReport(deps: TaskFlowDeps, task: TaskRecord, report: WorkflowFeedbackReviewReport): Promise<WorkflowFeedbackReviewRef> {
  const checked = WorkflowFeedbackReviewReportSchema.parse(report);
  const text = JSON.stringify(checked);
  const sha256 = feedbackDigest(text);
  const objectKey = `${feedbackReportPrefix(task)}${sha256}.json`;
  if (deps.feedbackArtifacts !== undefined) await writeFeedbackBytes(deps.feedbackArtifacts, objectKey, Buffer.from(text), sha256);
  const { findings: _findings, ...metadata } = checked;
  void _findings;
  return WorkflowFeedbackReviewRefSchema.parse({ ...metadata, sha256, objectKey });
}

export function lifecycleReport(task: TaskRecord, operation: Pick<OperationRecord, "id" | "workflowRevision">, now: string, reason: string): WorkflowFeedbackReviewReport {
  const refs = task.workflow!.feedbackReview!.bundleRefs;
  const candidateBindings = refs.map(ref => ({ repositoryId: ref.repositoryId, number: ref.number, headSha: ref.headSha,
    candidateDigest: ref.candidateDigest, commentSetDigest: ref.commentSetDigest, bundleDigest: ref.sha256 }));
  const taskRequirementsDigest = feedbackDigest("broker lifecycle failure");
  const findings: [] = [];
  return WorkflowFeedbackReviewReportSchema.parse({ schemaVersion: 1, taskId: task.taskId, operationId: operation.id,
    workflowRevision: operation.workflowRevision, operationMode: "FEEDBACK_REVIEW", qualification: "AI_GENERATED_ADVISORY", provider: "broker-lifecycle", version: "1",
    status: "BLOCKED", blockReason: reason, taskRequirementsDigest, candidateBindings, bundleDigests: refs.map(ref => ref.sha256), findingRefs: [], findings,
    proposalDigest: feedbackDigest(JSON.stringify({ taskRequirementsDigest, candidateBindings, findings })), recordedAt: now });
}

export async function failQueuedReview(deps: TaskFlowDeps, task: TaskRecord, reason: string): Promise<boolean> {
  const wf = task.workflow;
  if (task.companyId !== deps.companyId || task.closedAt !== undefined || wf?.stage !== "WAIT_FOR_MERGE" || (wf.state !== "WAITING" && wf.state !== "BLOCKED") || wf.feedbackReview?.status !== "COLLECTING") return false;
  const workspace = await readWorkspace(deps, task.workspaceId);
  if (workspace === undefined) return false;
  const now = iso(deps);
  const built = buildOperation(deps, { workspace, kind: "task", workflowMode: "FEEDBACK_REVIEW", requestId: crypto.randomUUID(), workflowRevision: wf.revision,
    dispatch: { kind: "task", projectRevision: task.startingRevision, payload: {} } });
  const ref = await saveFeedbackReport(deps, task, lifecycleReport(task, built.operation, now, reason));
  const next = completeWorkflowFeedbackReview({ ...wf, state: "RUNNING", blockReason: undefined }, { expectedRevision: wf.revision, taskId: task.taskId,
    candidateDigest: wf.candidate!.digest, operationId: built.operation.id, bundleRefs: wf.feedbackReview.bundleRefs, reviewRef: ref }, now);
  return commitWorkflow(deps, task, next, [{ kind: "put", item: toDocument({ ...built.operation, status: "FAILED" }), condition: when.absent() }, resolveRowItem(deps, task.taskId, wf.revision)], [], when.eq("companyId", deps.companyId));
}

async function recoverQueued(deps: TaskFlowDeps, task: TaskRecord, now: string): Promise<void> {
  const wf = task.workflow!;
    const key = dispatchRowKey(deps.companyId, task.taskId, wf.revision);
    const row = await deps.store.get(key);
    if (row !== undefined && (Number(row["attempts"]) >= 8 || Date.parse(now) - Date.parse(typeof row["createdAt"] === "string" ? row["createdAt"] : "") >= PR_FEEDBACK_REVIEW_DEADLINE_MS)) {
      await failQueuedReview(deps, task, "The feedback review did not start before its deadline. Retry, keep the pull request, or close the task.");
    } else if (row === undefined) {
      await deps.store.transact([{ kind: "check", key: { pk: task.pk, sk: task.sk }, condition: when.and(when.eq("companyId", deps.companyId), when.eq(["workflow", "revision"], wf.revision), when.notExists("closedAt")) }, dispatchRowItem(deps, task.taskId, wf.revision, "REVIEW", now)]);
    }
}

async function endedCritic(deps: TaskFlowDeps, task: TaskRecord): Promise<OperationRecord | undefined> {
  const operations = (await workspaceOperations(deps, task.workspaceId)).filter(op => op.workflowMode === "FEEDBACK_REVIEW" && op.workflowRevision === task.workflow!.revision && isTerminalStatus(op.status));
  return operations.length === 1 ? operations[0] : undefined;
}

async function currentCritic(deps: TaskFlowDeps, task: TaskRecord): Promise<OperationRecord | undefined> {
  const workspace = await readWorkspace(deps, task.workspaceId);
  const active = workspace?.activeOperationId == null ? undefined : await readOperation(deps, task.workspaceId, workspace.activeOperationId);
  return active ?? await endedCritic(deps, task);
}

/** Tracking checks the overall deadline even when the worker machine is healthy. */
export async function recoverPrFeedback(deps: TaskFlowDeps, task: TaskRecord): Promise<void> {
  if (task.companyId !== deps.companyId || task.closedAt !== undefined) return;
  await recoverCriticHold(deps, task);
  task = (await readTask(deps, task.taskId)) ?? task;
  const wf = task.workflow;
  if (wf?.stage !== "WAIT_FOR_MERGE" || wf.feedbackReview?.status !== "COLLECTING") return;
  const now = iso(deps);
  if (wf.state === "BLOCKED") {
    await failQueuedReview(deps, task, "The feedback review could not start. Retry review, keep the pull request, or close the task.");
    return;
  }
  if (wf.state === "WAITING") {
    await recoverQueued(deps, task, now);
    return;
  }
  const operation = await currentCritic(deps, task);
  if (operation === undefined || operation.workflowMode !== "FEEDBACK_REVIEW" || operation.workflowRevision !== wf.revision) return;
  if (isTerminalStatus(operation.status)) {
    const { recordPrFeedbackReview } = await import("./review.js");
    await recordPrFeedbackReview(deps, task, operation, { status: "INTERRUPTED" });
    return;
  }
  if (Date.parse(now) - Date.parse(operation.createdAt) < PR_FEEDBACK_REVIEW_DEADLINE_MS) return;
  const stopped = await quiesceCritic(deps, task, operation);
  if (!stopped.confirmed) return;
  await settleQuiescedCritic(deps, operation);
  const current = await readTask(deps, task.taskId);
  if (current !== undefined && current.workflow?.revision === wf.revision) {
    const { recordPrFeedbackReview } = await import("./review.js");
    await recordPrFeedbackReview(deps, current, operation, { status: "INTERRUPTED" });
  }
}
