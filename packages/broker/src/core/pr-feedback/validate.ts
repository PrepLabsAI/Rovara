import { WorkflowFeedbackReviewReportSchema, WorkflowFeedbackReviewRefSchema, agentXError, type WorkflowFeedbackReviewReport, type WorkflowFeedbackReviewRef } from "@agentx/contracts";
import { createReadBudget, createRepositoryResolver } from "../../services/merge-tracking.js";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import type { TaskRecord } from "../task-flow/records.js";
import { feedbackDigest, feedbackReportPrefix, readFeedbackBundles } from "./artifacts.js";
import { readCurrentFeedback, feedbackUnchanged, FeedbackHeadMoved } from "./collect.js";

export async function readFeedbackReportArtifact(deps: TaskFlowDeps, task: TaskRecord, ref: WorkflowFeedbackReviewRef | undefined): Promise<WorkflowFeedbackReviewReport> {
  if (task.companyId !== deps.companyId || ref === undefined || ref.taskId !== task.taskId || ref.objectKey !== `${feedbackReportPrefix(task)}${ref.sha256}.json`) throw agentXError("RUNTIME_UNAVAILABLE", "The feedback report does not belong to this task.");
  const bytes = await deps.artifacts?.get(ref.objectKey, 1_000_000);
  if (bytes === undefined || bytes.byteLength > 1_000_000 || feedbackDigest(bytes) !== ref.sha256) throw agentXError("RUNTIME_UNAVAILABLE", "The feedback report could not be verified.");
  const report = WorkflowFeedbackReviewReportSchema.parse(JSON.parse(Buffer.from(bytes).toString("utf8")));
  const { findings: _findings, ...metadata } = report;
  void _findings;
  const projected = WorkflowFeedbackReviewRefSchema.parse({ ...metadata, objectKey: ref.objectKey, sha256: ref.sha256 });
  if (JSON.stringify(projected) !== JSON.stringify(WorkflowFeedbackReviewRefSchema.parse(ref))) throw agentXError("RUNTIME_UNAVAILABLE", "The feedback report metadata changed.");
  return report;
}

export async function readFeedbackReport(deps: TaskFlowDeps, task: TaskRecord): Promise<WorkflowFeedbackReviewReport> {
  const report = await readFeedbackReportArtifact(deps, task, task.workflow?.feedbackReview?.reviewRef);
  await readFeedbackBundles(deps.feedbackArtifacts!, task);
  return report;
}

/** Fresh host content is read immediately before an owner decision and again at dispatch. */
export async function refreshFeedback(deps: TaskFlowDeps, task: TaskRecord, allowHeadMove = false): Promise<void> {
  if (deps.codeHosts === undefined || deps.feedbackArtifacts === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "The feedback inputs are unavailable.");
  const now = () => (deps.now?.() ?? new Date()).getTime();
  const { budget, stop } = createReadBudget(now);
  try {
    const result = await readCurrentFeedback({ flow: deps, blobs: deps.feedbackArtifacts, repository: createRepositoryResolver(deps, deps.codeHosts), now }, task, budget);
    if (!feedbackUnchanged(task.workflow!, result.bundles, result.reopened)) throw agentXError("IDEMPOTENCY_CONFLICT", "The pull request feedback changed. Refresh the task.");
  } catch (error) {
    // Keeping existing work spends nothing; approval and execution still require the pinned head.
    if (!(allowHeadMove && error instanceof FeedbackHeadMoved)) throw error;
  } finally { stop(); }
}
