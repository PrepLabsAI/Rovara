// Design review stage: what a design-review operation's END does to the workflow (on the task flow's ports). The plan check's own moves refuse a workflow that is
// reviewing a design, so every end of the stage is answered here with the design review's own move:
//
//   a result that SUCCEEDED   -> the round is recorded (round-record.ts): findings, runs, measured spend, the planner next, or the person;
//   the budget ran out        -> the review stops at the cost cap, with what the keys spent;
//   rule files unverified, leftover programs -> BLOCKED with the plan check's own reasons (Retry resumes it: `resumeBlockedDesignReview`);
//   the model was refused     -> the review did not run (`no_model_source`). Cloud tries the next ranked model first; a laptop has the one model its owner chose, so there is no next one;
//   any other end             -> the review did not run (`worker_failed`), with what its keys already cost.
//
// Every end releases the round: the stored packets are removed and each slot key is blocked and finalized, so nothing a worker still holds can spend or be served. A late result for a workflow that is no longer running this
// round changes nothing.
import {
  BUDGET_EXHAUSTED_FAILURE_MESSAGE, DESIGN_REVIEW_ARTIFACT, WORKFLOW_BLOCK_REASONS, WORKFLOW_LEFTOVER_PROCESSES_MESSAGE, WORKFLOW_RULE_FILES_UNVERIFIED_MESSAGE, WorkflowSnapshotSchema, addDesignUsd, blockWorkflow, closeDesignReview,
  type TransactItem, type WorkflowSnapshot,
} from "@agentx/contracts";
import { loadWorkflowDocument } from "../../developer/plan-document-reader.js";
import { textReaderOf } from "../build-step/plan-input.js";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import type { OperationRecord, TaskRecord } from "../task-flow/records.js";
import type { DesignReviewRuntime } from "./round-ports.js";
import { recordDesignReviewRound, releaseDesignReviewRound, type RoundRecordPorts } from "./round-record.js";

/** The most of a design-review result the broker reads. The worker uploads at most this (reviewers' answers are bounded). */
export const DESIGN_REVIEW_RESULT_MAX_BYTES = 1_500_000;

/**
 * Whether an error says the model could not serve this account (Bedrock's 403, a provider's 401/403/404 for a model, a 402, an exhausted quota, the broker's own MODEL_NOT_ALLOWED). A rate limit, an outage, a spent budget or a stop
 * is not: another model would not change them. The same reading as the plan check's.
 */
export function modelUnusable(error: string | undefined): boolean {
  if (error === undefined) return false;
  return /\bthe model call failed: (?:key-rejected|model-not-found|not-in-catalog|request-rejected|unknown)\b/u.test(error)
    || /\bthe model call failed: [a-z-]+(?: [A-Za-z0-9_]+)? HTTP 402\b/u.test(error)
    || /\bthe model call failed: limit-or-rate-limited insufficient_quota\b/u.test(error)
    || /^MODEL_NOT_ALLOWED:/u.test(error)
    || /\bis not available on this install\b/u.test(error);
}

/** The ports a round is recorded with: the store, what the proxy knows of the keys, and the operation's saved result. */
export function roundRecordPortsOf(deps: TaskFlowDeps, runtime: DesignReviewRuntime): RoundRecordPorts {
  return {
    table: deps.store, keySpend: (ids) => runtime.keys.keySpend(ids), closeKeys: (orgId, ids) => runtime.keys.closeKeys(orgId, ids),
    readResult: (operation) => runtime.readArtifactText(operation, DESIGN_REVIEW_ARTIFACT, DESIGN_REVIEW_RESULT_MAX_BYTES),
  };
}

/** The step the blocked round reads as in the block's own words. */
const blockedWith = (workflow: WorkflowSnapshot, reason: string, spentUsd: number, now: string): WorkflowSnapshot => {
  const blocked = blockWorkflow(workflow, reason, now);
  return blocked.designReview === undefined ? blocked : WorkflowSnapshotSchema.parse({ ...blocked, designReview: { ...blocked.designReview, spentUsd: addDesignUsd(blocked.designReview.spentUsd, spentUsd) } });
};

/** The workflow after the design review's operation ended. Never throws for an end it cannot read. `release` collects the steps that remove the round's packets, for the commit that records the round . */
export async function designReviewOutcome(
  deps: TaskFlowDeps, runtime: DesignReviewRuntime, task: TaskRecord & { workflow: WorkflowSnapshot }, operation: OperationRecord,
  ended: { status: "SUCCEEDED" | "FAILED" | "CANCELLED" | "INTERRUPTED"; error?: string | undefined }, now: string, release?: TransactItem[],
): Promise<WorkflowSnapshot> {
  const ports = roundRecordPortsOf(deps, runtime);
  const workflow = task.workflow;
  const review = workflow.designReview;
  // A result counts only while the task waits for exactly this round (RUNNING, "running"); a late one changes nothing.
  if (review === undefined || workflow.state !== "RUNNING" || review.status !== "running") return workflow;
  const expectedRevision = workflow.revision;

  if (ended.status === "SUCCEEDED") {
    const read = textReaderOf(deps.artifacts);
    const designArtifact = workflow.artifacts.filter((artifact) => artifact.type === "design").at(-1);
    const requirementsArtifact = workflow.artifacts.filter((artifact) => artifact.type === "requirements").at(-1);
    const [design, requirements] = [designArtifact === undefined ? undefined : await loadWorkflowDocument(read, designArtifact, {}), requirementsArtifact === undefined ? undefined : await loadWorkflowDocument(read, requirementsArtifact, {})];
    if (designArtifact === undefined || design === undefined) {
      // The design that was reviewed cannot be read back: nothing can be checked against it.
      const released = await releaseDesignReviewRound(ports, operation);
      return closeDesignReview(workflow, { expectedRevision, outcome: "not_run", notRunReason: "inputs_unverified", addedSpendUsd: released.spentUsd, now });
    }
    return recordDesignReviewRound(ports, { workflow, operation, design: { text: design.markdown, sha256: designArtifact.sha256 }, requirementsText: requirements?.markdown ?? "", ...(release === undefined ? {} : { release }), now });
  }

  // The operation ended without a result to read: what its keys cost is added to the review's total either way (a lost run still spent it), and the round is released.
  const { spentUsd } = await releaseDesignReviewRound(ports, operation);
  if (ended.error === BUDGET_EXHAUSTED_FAILURE_MESSAGE) return closeDesignReview(workflow, { expectedRevision, outcome: "stopped_at_cap", addedSpendUsd: spentUsd, now });
  if (ended.error?.includes(WORKFLOW_RULE_FILES_UNVERIFIED_MESSAGE) === true) return blockedWith(workflow, WORKFLOW_BLOCK_REASONS.stepRuleFilesUnverified, spentUsd, now);
  if (ended.error?.includes(WORKFLOW_LEFTOVER_PROCESSES_MESSAGE) === true) return blockedWith(workflow, WORKFLOW_BLOCK_REASONS.leftoverProcesses, spentUsd, now);
  return closeDesignReview(workflow, { expectedRevision, outcome: "not_run", notRunReason: modelUnusable(ended.error) ? "no_model_source" : ended.status === "CANCELLED" ? "cancelled" : "worker_failed", addedSpendUsd: spentUsd, now });
}
