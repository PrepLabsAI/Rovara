// Lane L9-wire: the retry of a blocked step. Lane L10 adds the steps after the plan (coding, the checks, the reviews, the pull request): each is the build step's own move, on the same plan and the same code.
// The retry of a blocked Understand or Plan step. L6a leaves "the retry entry point for a BLOCKED Understand/Plan" to the sessions (L6b): a blocked step becomes READY again at the next
// revision, with a dispatch row in the same commit, and the row is run at once (the recovery sweep does it otherwise).
import { WORKFLOW_BLOCK_REASONS, WorkflowSnapshotSchema, agentXError } from "@agentx/contracts";
import type { TaskFlowDeps } from "../../core/task-flow/deps.js";
import { dispatchRowItem } from "../../core/task-flow/dispatch-rows.js";
import { readTask } from "../../core/task-flow/reads.js";
import { commitWorkflow, runDispatchRow } from "../../core/task-flow/stage-machine.js";
import { iso } from "../../core/task-flow/support.js";
import { startPublication } from "../../core/build-step/publish.js";
import { startChecksRerun, startReview } from "../../core/build-step/start.js";

export const NOTHING_TO_RETRY_STEP = "There is nothing to retry: the task is not blocked at a step Rovara can run again.";

export async function retryBlockedStep(deps: TaskFlowDeps, taskId: string, expectedRevision?: number): Promise<void> {
  const task = await readTask(deps, taskId);
  const workflow = task?.workflow;
  if (task === undefined || task.closedAt !== undefined || workflow === undefined || workflow.state !== "BLOCKED") throw agentXError("CONFIG_INVALID", NOTHING_TO_RETRY_STEP);
  // The page the owner pressed Retry on was for one revision: a task that moved on since is not retried by a button that was for something else.
  if (expectedRevision !== undefined && workflow.revision !== expectedRevision) throw agentXError("CONFIG_INVALID", "This changed since you read it. Read the latest and try again.");
  // A blocked design review (a round, or the planner's answer to its findings) resumes through the review's own move; its blocked round's spend is already counted.
  if (await deps.designReview?.retryBlocked(deps, task, expectedRevision)) return;
  const ref = { taskId, workflowRevision: workflow.revision };
  const now = iso(deps);
  /** What the owner's Retry started: "STALE" means the step is not one that can be run again from where the task is. */
  const started = async (): Promise<string> => {
    switch (workflow.stage) {
      case "VERIFY": return startChecksRerun(deps, ref, { requestId: `retry-${taskId}-${String(workflow.revision)}`, actorId: workflow.ownerId });
      case "REVIEW": return startReview(deps, ref, { retry: true });
      case "PULL_REQUEST": return startPublication(deps, ref, { ownerRetry: true });
      default: return "STALE";
    }
  };
  if (workflow.stage === "VERIFY" || workflow.stage === "REVIEW" || workflow.stage === "PULL_REQUEST") {
    const result = await started();
    if (result === "STALE" || result === "WAITING") throw agentXError("CONFIG_INVALID", result === "WAITING" ? "The workspace is not ready yet. Try again in a moment." : NOTHING_TO_RETRY_STEP);
    return;
  }
  // The push of an approved fix to the open pull request stopped (its head moved, the push was refused): the fix is still the reviewed one, so it is due again, and the push checks the head again first.
  if (workflow.stage === "WAIT_FOR_MERGE" && workflow.blockReason === WORKFLOW_BLOCK_REASONS.pullRequestUpdateFailed) {
    const { blockReason: _reason, pullRequestUpdateFailure: _failure, ...open } = workflow;
    void _reason; void _failure;
    const due = WorkflowSnapshotSchema.parse({ ...open, revision: workflow.revision + 1, stage: "PULL_REQUEST", state: "READY", updatedAt: now });
    if (!(await commitWorkflow(deps, task, due, [dispatchRowItem(deps, taskId, due.revision, "PUBLISH", now)]))) throw agentXError("CONFIG_INVALID", "The task changed while you were retrying. Read it again.");
    await runDispatchRow(deps, { taskId, workflowRevision: due.revision, kind: "PUBLISH" });
    return;
  }
  if (workflow.stage !== "UNDERSTAND" && workflow.stage !== "PLAN" && workflow.stage !== "PLAN_CRITIQUE" && workflow.stage !== "IMPLEMENT") throw agentXError("CONFIG_INVALID", NOTHING_TO_RETRY_STEP);
  const { blockReason: _blockReason, ...rest } = workflow;
  void _blockReason;
  const next = WorkflowSnapshotSchema.parse({ ...rest, revision: workflow.revision + 1, state: "READY", updatedAt: now });
  // The plan check is run again (the critiques kept so far stay): Cloud's Retry plan check.
  const kind = workflow.stage === "UNDERSTAND" ? "UNDERSTAND" as const : workflow.stage === "PLAN" ? "PLAN" as const : workflow.stage === "PLAN_CRITIQUE" ? "CRITIQUE" as const : "IMPLEMENT" as const;
  if (!(await commitWorkflow(deps, task, next, [dispatchRowItem(deps, taskId, next.revision, kind, now)]))) throw agentXError("CONFIG_INVALID", "The task changed while you were retrying. Read it again.");
  await runDispatchRow(deps, { taskId, workflowRevision: next.revision, kind });
}
