import { isCoreFeedbackTask } from "./ownership.js";
// Existing worker callback contracts, held to the current task, workspace holder, and exact operation.
import { agentXError, WorkflowFeedbackApprovalBindingSchema } from "@agentx/contracts";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import type { OperationRecord } from "../task-flow/records.js";
import { readTask } from "../task-flow/reads.js";
import { readWorkspace } from "../task-flow/stage-machine.js";
import { readFeedbackBundles } from "./artifacts.js";
import { feedbackRequirements } from "./inputs.js";

export async function feedbackCallback(deps: TaskFlowDeps, operation: OperationRecord, action: "feedback-bundles" | "feedback-approval", body: Record<string, unknown>): Promise<unknown> {
  const workspace = await readWorkspace(deps, operation.workspaceId);
  if (operation.companyId !== deps.companyId || workspace?.companyId !== deps.companyId || workspace.fence !== operation.fence
    || workspace.activeOperationId !== operation.id || workspace.status === "CLOSED" || workspace.status === "CLOSING") throw agentXError("STALE_FENCE", "The feedback operation no longer owns the workspace.");
  if (action === "feedback-approval") {
    const binding = WorkflowFeedbackApprovalBindingSchema.parse(body);
    const { validateFeedbackApproval } = await import("./fix-context.js");
    await validateFeedbackApproval(deps, operation, binding);
    return { authorized: true };
  }
  const binding = operation.workflowFeedbackReview;
  if (operation.workflowMode !== "FEEDBACK_REVIEW" || binding === undefined || Object.keys(body).length !== 3
    || body["taskId"] !== binding.taskId || body["workflowRevision"] !== binding.workflowRevision || body["candidateDigest"] !== binding.candidateDigest) throw agentXError("CALLBACK_FORBIDDEN", "The feedback request does not match this critic.");
  const task = await readTask(deps, binding.taskId);
  const wf = task?.workflow;
  if (task === undefined || task.companyId !== deps.companyId || task.closedAt !== undefined || task.workspaceId !== operation.workspaceId
    || wf?.revision !== binding.workflowRevision || wf.stage !== "WAIT_FOR_MERGE" || wf.state !== "RUNNING"
    || wf.candidate?.digest !== binding.candidateDigest || wf.feedbackReview?.status !== "COLLECTING") throw agentXError("STALE_FENCE", "The collected feedback is no longer current.");
  if (!await isCoreFeedbackTask(deps, task)) throw agentXError("CALLBACK_FORBIDDEN", "The feedback task is not owned by this engine.");
  const permitted = await deps.access.checkStep(task);
  if (!permitted.allowed || deps.feedbackArtifacts === undefined) throw agentXError("CALLBACK_FORBIDDEN", "The feedback inputs cannot be read.");
  const taskRequirements = await feedbackRequirements(deps, task);
  const inputs = await readFeedbackBundles(deps.feedbackArtifacts, task);
  return { taskRequirements, bundles: inputs.map(({ ref, bytes }) => ({ ref, bytesBase64: Buffer.from(bytes).toString("base64") })),
    taskChecks: { proposed: (wf.checkPolicy?.proposed ?? []).filter(c => wf.checkPolicy?.selectedProposedIds === undefined || wf.checkPolicy.selectedProposedIds.includes(c.id)), required: wf.checkPolicy?.required.map(c => ({ id: c.id, label: c.label })) ?? [],
      optional: wf.checkPolicy?.optional.map(c => ({ id: c.id, label: c.label })) ?? [],
      repositoryPaths: (await deps.projects.revision(task.project, task.startingRevision))?.definition.repositories.map(r => r.path) ?? [] } };
}
