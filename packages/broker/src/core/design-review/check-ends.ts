// Design review stage: the plan check's other ends, answered for a design review. The plan check closes with `closePlanCritique` when it cannot start, or its run was lost, or its run was stopped, and the
// plan check's moves REFUSE a workflow that is reviewing a design (`runningPlanCheck`). Each of those places calls one of these instead: for a plan check they return exactly what the call they replace returned; for a
// design review they make the design review's own move (`closeDesignReview`), with what the round's keys already cost, and release the round (stored packets removed). Pure for a plan check; the design form reads the table.
import { DesignReviewBindingSchema, closeDesignReview, closePlanCritique, queryAll, resumeBlockedDesignReview, workflowIsDesignReviewing, type DocumentStore, type WorkflowSnapshot } from "@agentx/contracts";
import { releaseDesignReviewRound } from "./round-record.js";

const text = (value: unknown): string => (typeof value === "string" ? value : "");
type RoundTable = Pick<DocumentStore, "get" | "put" | "update" | "query" | "transact">;

/** The operation fields the release reads: an `OperationRecord`, a stopped run and an item read from the table all fit. */
export interface EndedCheckOperation { id: string; orgId?: string | undefined; designReview?: unknown }

/**
 * The plan check cannot be started (its start was given up, or no model can serve it): for a plan check, `closePlanCritique` "done" (the plan goes to the person as not checked); for a design review the design goes to the
 * person with the review marked not run (`no_model_source`). Nothing was stored for a round that never started, so nothing is released.
 */
export function closeUnstartedCheck(workflow: WorkflowSnapshot, now: string, reason: "no_model_source" | "worker_failed" = "worker_failed"): WorkflowSnapshot {
  if (!workflowIsDesignReviewing(workflow)) return closePlanCritique(workflow, { expectedRevision: workflow.revision, status: "done", now });
  // a start that was given up is a start that failed (the workspace stayed busy, the machine never came up); `no_model_source` is said only by a caller that knows no model can serve it.
  return closeDesignReview(workflow, { expectedRevision: workflow.revision, outcome: "not_run", notRunReason: reason, now });
}

/**
 * The plan check's run was lost or stopped while RUNNING (the worker's machine was lost, an owner's stop, a reconciler's end): for a plan check, `closePlanCritique` "done"; for a design review the review did not run
 * (`worker_failed`), what its keys cost is added to the total (the proxy is not asked from here, so each slot that had a key is charged its key's whole budget: never under-counted), and the stored packets are removed. The
 * operation's keys are blocked by the operation's own end, which every ended task operation has.
 */
export async function closeEndedCheck(table: RoundTable, workflow: WorkflowSnapshot, operation: EndedCheckOperation, now: string): Promise<WorkflowSnapshot> {
  if (!workflowIsDesignReviewing(workflow)) return closePlanCritique(workflow, { expectedRevision: workflow.revision, status: "done", now });
  const binding = DesignReviewBindingSchema.safeParse(operation.designReview);
  const { spentUsd } = !binding.success || operation.orgId === undefined ? { spentUsd: 0 }
    : await releaseDesignReviewRound({ table, keySpend: async () => undefined, closeKeys: async () => undefined }, { id: operation.id, orgId: operation.orgId, designReview: binding.data });
  return closeDesignReview(workflow, { expectedRevision: workflow.revision, outcome: "not_run", notRunReason: "worker_failed", addedSpendUsd: spentUsd, now });
}

/**
 * The owner's Retry of a design review that BLOCKED (a rule file that could not be verified, a leftover program): BLOCKED goes back to READY with the cost cap checked again when it starts (`resumeBlockedDesignReview`). What the
 * blocked round's keys cost is added (a round blocked before its reviewers ran asks for no key and adds nothing; one that did is charged each key's budget): the total only goes up. `workflow` is the blocked design review.
 */
export async function resumeBlockedCheck(table: RoundTable, workspaceId: string, workflow: WorkflowSnapshot, now: string): Promise<WorkflowSnapshot> {
  const latest = (await queryAll(table, { pk: `WORKSPACE#${workspaceId}`, sk: { op: "beginsWith", prefix: "OPERATION#" } }))
    .filter((item) => item.entityType === "OPERATION" && item.kind === "task" && item.workflowMode === "PLAN_CRITIQUE" && item.designReview !== undefined)
    .sort((left, right) => text(left["createdAt"]).localeCompare(text(right["createdAt"]))).at(-1);
  const binding = DesignReviewBindingSchema.safeParse(latest?.designReview);
  // the blocked round's measured spend was added when it blocked (`designReviewOutcome`), so the Retry adds nothing; it only removes what the round left stored.
  if (latest !== undefined && binding.success && typeof latest.orgId === "string") {
    await releaseDesignReviewRound({ table, keySpend: async () => undefined, closeKeys: async () => undefined }, { id: text(latest["id"]), orgId: latest.orgId, designReview: binding.data });
  }
  return resumeBlockedDesignReview(workflow, { expectedRevision: workflow.revision, now });
}
