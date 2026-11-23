// The existing feedback review view, over core-owned evidence and live owner access.
import { agentXError, WorkflowSnapshotSchema, workflowFeedbackCheckChanges, workflowSelectedChecks, type WorkflowFeedbackReviewReport, type WorkflowSnapshot } from "@agentx/contracts";
import type { TaskCaller, TaskFlowDeps } from "../core/task-flow/deps.js";
import { feedbackOwner } from "../core/pr-feedback/decide.js";
import { readFeedbackReportArtifact } from "../core/pr-feedback/validate.js";
import { readFeedbackBundles, feedbackPrefix, feedbackReportPrefix } from "../core/pr-feedback/artifacts.js";
import { locateWorkspace } from "../core/task-flow/workspace-location.js";
import { workspaceOperations } from "../core/task-flow/reads.js";

const FAILED_REVIEW_NEXT_ACTION = "The feedback review did not finish. Choose Retry review to run it again, or Keep the pull request as it is.";
const priorityOrder = { MUST_FIX: 0, SHOULD_FIX: 1, OPTIONAL: 2 } as const;

function operationAction(operation: Record<string, unknown> | undefined): string | undefined {
  if (operation === undefined || !["ACCEPTED", "DISPATCHING", "RUNNING", "CANCEL_REQUESTED"].includes(String(operation.status))) return undefined;
  if (operation.workflowMode === "IMPLEMENT") return operation.status === "ACCEPTED" ? "Implementation is queued to start." : "Implementation is in progress.";
  return `${typeof operation.kind === "string" ? operation.kind : "Task"} operation is in progress.`;
}
function stepAction(workflow: WorkflowSnapshot): string | undefined {
  if (workflow.stage === "IMPLEMENT" && workflow.state === "READY") return "Implementation is ready to start.";
  if (workflow.stage === "IMPLEMENT" && workflow.state === "RUNNING") return "Implementation is in progress.";
  if (workflow.stage === "WAIT_FOR_MERGE" && workflow.state === "WAITING") return "Waiting for GitHub to confirm every required pull request is merged.";
  const actions: Partial<Record<WorkflowSnapshot["stage"], string>> = { VERIFY: "Run the required checks for the current code version.", REVIEW: "Complete the required code and security reviews.", PULL_REQUEST: "Create the required pull requests for the verified code." };
  return actions[workflow.stage];
}
function nextAction(workflow: WorkflowSnapshot, operation: Record<string, unknown> | undefined): string {
  if (workflow.state === "BLOCKED") return "Resolve the blocker before continuing.";
  if (workflow.state === "COMPLETE" && workflow.stage === "MERGED") return "All required pull requests are merged.";
  const failed: Record<string, string> = { FAILED: "Review the failed operation before retrying.", INTERRUPTED: "Review the failed operation before retrying.", CANCELLED: "Restart the operation if the task still needs work." };
  const failure = failed[String(operation?.status)];
  if (failure !== undefined) return failure;
  if (workflow.feedbackReview?.status === "CHANGES_REQUESTED") return "Rovara is waiting for your updated instructions.";
  if (workflow.feedbackReview?.status === "DISMISSED") return "No code changes will start from this proposal.";
  return operationAction(operation) ?? stepAction(workflow) ?? (workflow.feedbackReview?.status === "PENDING" ? "Review this proposal and choose the next action." : "No code changes will start from this proposal.");
}

function checkChanges(workflow: WorkflowSnapshot, findings: WorkflowFeedbackReviewReport["findings"]) {
  return workflowFeedbackCheckChanges(workflow.checkPolicy, findings);
}

function workflowViewFields(workflow: WorkflowSnapshot, operation: Record<string, unknown> | undefined) {
  return { ...(workflow.outcome === undefined ? {} : { workflowOutcome: workflow.outcome }),
    ...(workflow.state === "COMPLETE" && (workflow.stage === "MERGED" || workflow.stage === "CLOSED") ? { canvasCleanupStatus: workflow.canvasCloseout?.status === "COMPLETE" ? "COMPLETE" : "RETRYING" } : {}),
    ...(workflow.blockReason === undefined ? {} : { blockReason: workflow.blockReason }), ...(operation === undefined ? {} : { activeOperation: operation }), nextAction: nextAction(workflow, operation) };
}

export async function readPrFeedbackView(deps: TaskFlowDeps, caller: TaskCaller, taskId: string): Promise<Record<string, unknown>> {
  const { task, acting } = await feedbackOwner(deps, caller, taskId);
  if (task.workflow === undefined) throw agentXError("NOT_FOUND", "PR feedback review not found");
  const parsed = WorkflowSnapshotSchema.safeParse(task.workflow);
  if (!parsed.success) throw agentXError("RUNTIME_UNAVAILABLE", "The feedback workflow could not be verified.");
  const workflow = parsed.data;
  const review = workflow?.feedbackReview;
  const decision = workflow?.feedbackDecisions?.find(item => item.reviewDigest === review?.reviewRef?.sha256);
  if (review?.reviewRef === undefined || (review.status !== "PENDING" && decision === undefined)) throw agentXError("NOT_FOUND", "PR feedback review not found");
  const ref = review.reviewRef;
  if (ref.taskId !== taskId || ref.objectKey !== `${feedbackReportPrefix(task)}${ref.sha256}.json`
    || review.bundleRefs.some(bundle => bundle.objectKey !== `${feedbackPrefix(task)}${bundle.sha256}.json`)) throw agentXError("RUNTIME_UNAVAILABLE", "The feedback references do not belong to this task.");
  const common = { taskId, title: task.title, revision: workflow.revision, status: review.status, workflowStatus: workflow.state, workflowStage: workflow.stage, reviewDigest: ref.sha256, bundleDigests: review.bundleRefs.map(bundle => bundle.sha256) };
  // Failed reviews deliberately need no report blob and expose no proposal or decision.
  if (ref.status !== "COMPLETE") return { ...common, reportStatus: ref.status, candidates: [], findings: [], recommendedFindingIds: [], checks: [], nextAction: FAILED_REVIEW_NEXT_ACTION };
  const report = await readFeedbackReportArtifact(deps, task, ref);
  const bundles = await readFeedbackBundles(deps.feedbackArtifacts!, task);
  const comments = new Map(bundles.map(input => [input.ref.sha256, new Map(input.bundle.comments.map(comment => [comment.id, comment]))]));
  const findings = report.findings.map(finding => {
    // The workflow schema and immutable artifact readers verified the full comment set.
    const found = finding.commentIds.map(id => comments.get(finding.bundleDigest)!.get(id)!);
    const changes = checkChanges(workflow, [finding]);
    return { ...finding, checkChanges: { obsolete: changes.obsolete.map(check => check.label), added: changes.added.map(check => ({ label: check.label, command: check.command })) }, comments: found };
  }).sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority] || Number(b.recommended) - Number(a.recommended) || a.id.localeCompare(b.id));
  const workspace = (await locateWorkspace(deps, task.workspaceId))?.workspace;
  const operations = await workspaceOperations(deps, task.workspaceId);
  const active = operations.find(operation => operation.id === workspace?.["activeOperationId"]);
  const operation = active === undefined ? undefined : { status: active.status, kind: active.kind, workflowMode: active.workflowMode };
  return { ...common, ...workflowViewFields(workflow, operation),
    ...(decision === undefined ? {} : { decision: { decision: decision.decision, at: decision.at, decidedByYou: decision.actorId === acting.actorId, selectedFindingIds: decision.selectedFindingIds, ...(decision.ownerNote === undefined ? {} : { ownerNote: decision.ownerNote }) } }),
    qualification: report.qualification, proposalDigest: report.proposalDigest, bundleDigests: report.bundleDigests,
    candidates: report.candidateBindings.map(binding => ({ repositoryId: binding.repositoryId, number: binding.number, headSha: binding.headSha })), findings,
    reportOrder: report.findings.map(finding => finding.id), recommendedFindingIds: findings.filter(finding => finding.recommended).map(finding => finding.id), checks: workflowSelectedChecks(workflow.checkPolicy).map(check => check.label),
    recommendedCheckChanges: checkChanges(workflow, report.findings.filter(finding => finding.recommended)).byFinding.filter(entry => entry.obsolete.length > 0 || entry.added.length > 0).map(entry => ({ obsolete: entry.obsolete.map(check => check.label), added: entry.added.map(check => ({ label: check.label, command: check.command })) })),
  };
}
