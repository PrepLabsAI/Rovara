// Design review stage: the stage machine's seam for the review (`DesignReviewSteps`, core/task-flow/deps.ts), on the task flow's ports. It joins what Cloud spread over the Understand handler, the plan
// check's start and result, the sweeps and the dispatch rows:
//   Understand answers `ready`      -> `afterUnderstand`: the mode (understand-mode.ts) may switch the review on, which forces the Full path;
//   the design is submitted         -> the `CRITIQUE` row is due: `startDesignReviewRound` (round-start.ts) prepares the round and starts its operation (plan-check mode, with the binding);
//   the round's operation ended     -> `designReviewOutcome` records it: findings, runs, measured spend; the planner next (`CRITIC_REPLAN`), or the person (the approve-design card);
//   the planner's answer ended      -> `designResolveOutcome`: the revised design is stored and the next round, or the person.
// Nothing here approves anything: every path ends at PLAN_REVIEW/WAITING, where the approval gate needs a person.
import { WorkflowSnapshotSchema, WorkflowTransitionError, blockWorkflow, workflowIsDesignReviewing, type IntentAssessment, type TransactItem, type WorkflowSnapshot } from "@agentx/contracts";
import type { DesignReviewSteps, TaskFlowDeps } from "../task-flow/deps.js";
import { dispatchRowItem } from "../task-flow/dispatch-rows.js";
import { dispatchRowKey } from "../task-flow/keys.js";
import { readTask } from "../task-flow/reads.js";
import { fromDocument, type DispatchRowRecord, type TaskRecord } from "../task-flow/records.js";
import { commitWorkflow, runDispatchRow } from "../task-flow/stage-machine.js";
import { resolveRowItem } from "../task-flow/dispatch-rows.js";
import { iso, log } from "../task-flow/support.js";
import { designReviewOutcome } from "./outcome.js";
import { designProofContextOf } from "./design-proof.js";
import { designWaitArmItems } from "./wait.js";
import { designResolveDue, designResolveOutcome, designResolveRunning, startDesignResolveRun } from "./resolve-run.js";
import { startDesignReviewRound } from "./round-start.js";
import type { DesignReviewRuntime } from "./round-ports.js";
import { ROVARA_CODE_PROGRAM } from "../plan/program.js";
import { designTemplateInstructions } from "./template.js";
import { designReviewEnabled } from "./switch.js";
import { withDesignReviewMode } from "./understand-mode.js";

/** The row a workflow's state makes due in the plan-check stage, or undefined: a design handed to its reviewers (CRITIQUE), the planner's turn to answer their findings (CRITIC_REPLAN), or a plan the stage has no check for (CRITIQUE, which hands it to the person as not checked). */
export function designRowFor(workflow: WorkflowSnapshot): "CRITIQUE" | "CRITIC_REPLAN" | undefined {
  if (designResolveDue(workflow)) return "CRITIC_REPLAN";
  if (workflow.stage === "PLAN_CRITIQUE" && workflow.state === "READY" && workflowIsDesignReviewing(workflow) && workflow.designReview?.status === "estimating") return "CRITIQUE";
  return undefined;
}

/** A CRITIQUE row for a round a person approved to run without a price: carries who approved, which is the only way a round starts from the cost hold. */
export function designRowItem(deps: Pick<TaskFlowDeps, "companyId">, taskId: string, revision: number, kind: "CRITIQUE" | "CRITIC_REPLAN", now: string, costApprovedBy?: string): Extract<TransactItem, { kind: "put" }> {
  const row = dispatchRowItem(deps, taskId, revision, kind, now);
  return costApprovedBy === undefined ? row : { ...row, item: { ...row.item, costApprovedBy } };
}

export function createDesignReviewSteps(runtime: DesignReviewRuntime): Omit<DesignReviewSteps, "retryBlocked" | "designFirst"> {
  const withWorkflow = (task: TaskRecord): (TaskRecord & { workflow: WorkflowSnapshot }) | undefined => (task.workflow === undefined ? undefined : task as TaskRecord & { workflow: WorkflowSnapshot });

  /** Commits the move an end made, with the row it makes due, and runs that row. A task that moved on is left alone. */
  async function commitEnd(deps: TaskFlowDeps, task: TaskRecord & { workflow: WorkflowSnapshot }, next: WorkflowSnapshot, extra: readonly TransactItem[]): Promise<void> {
    if (next === task.workflow) return;
    const row = designRowFor(next);
    const committed = await commitWorkflow(deps, task, next, [...extra, ...(row === undefined ? [] : [designRowItem(deps, task.taskId, next.revision, row, iso(deps))]), ...designWaitArmItems(deps, task.taskId, next, Date.parse(iso(deps)))]);
    if (committed && row !== undefined) await runDispatchRow(deps, { taskId: task.taskId, workflowRevision: next.revision, kind: row }).catch((error: unknown) => log(deps, { event: "design_review.row_not_run", error: error instanceof Error ? error.name : "unknown" }));
  }

  return {
    async runRow(deps, row) {
      const task = await readTask(deps, row.taskId);
      const workflow = task?.workflow;
      const resolve = (): TransactItem => resolveRowItem(deps, row.taskId, row.workflowRevision);
      const stale = async (): Promise<"STALE"> => { await deps.store.transact([resolve()]); return "STALE"; };
      if (task === undefined || task.closedAt !== undefined || workflow === undefined || workflow.revision !== row.workflowRevision) return stale();
      // The plan check of a coding plan is the plan check's own step (it never reaches this one): a row for a workflow that is not reviewing a design is stale.
      if (!workflowIsDesignReviewing(workflow)) return stale();
      if (row.kind === "CRITIQUE") {
        const stored = fromDocument<DispatchRowRecord>(await deps.store.get(dispatchRowKey(deps.companyId, row.taskId, row.workflowRevision)));
        const costApprovedBy = stored?.costApprovedBy;
        const answer = await startDesignReviewRound(deps, runtime, { task, workflow, ...(costApprovedBy === undefined ? {} : { costApprovedBy }) });
        return answer === "STALE" ? stale() : answer;
      }
      const answer = await startDesignResolveRun(deps, runtime, { task, workflow });
      return answer === "STALE" ? stale() : answer;
    },

    proofContext: (deps, task, workflow) => designProofContextOf({ store: deps.store, artifacts: deps.artifacts }, task.taskId, workflow),

    async onEnded(deps, task, operation, ended) {
      const full = withWorkflow(task);
      if (full === undefined) return false;
      const now = iso(deps);
      try {
        if (operation.workflowMode === "PLAN_CRITIQUE") {
          if (operation.designReview === undefined) return false;
          // A result for a revision the task has moved past, or for a workflow that is not running this round, changes nothing.
          if (operation.workflowRevision !== undefined && full.workflow.revision !== operation.workflowRevision) return true;
          const release: TransactItem[] = [];
          const next = await designReviewOutcome(deps, runtime, full, operation, ended, now, release);
          await commitEnd(deps, full, next, release);
          return true;
        }
        if (operation.workflowMode === "PLAN" && designResolveRunning(full.workflow)) {
          if (operation.workflowRevision !== undefined && full.workflow.revision !== operation.workflowRevision) return true;
          const next = await designResolveOutcome(deps, runtime, full, operation, ended, now);
          await commitEnd(deps, full, next, []);
          return true;
        }
      } catch (error) {
        if (!(error instanceof WorkflowTransitionError)) throw error;
        await commitWorkflow(deps, full, blockWorkflow(full.workflow, "Rovara could not read the result of this step; retry it.", now)).catch(() => false);
        return true;
      }
      return false;
    },

    async afterUnderstand(deps, task, workflow, assessment, now) {
      // With the switch off nothing is read and nothing is parsed: the workflow is returned as it came.
      if (!designReviewEnabled(runtime.env)) return workflow;
      const parsed = assessment as IntentAssessment;
      try {
        // The review runs in the plan-check step of the workflow's sequence: a task that started without one is given Rovara Code's, for the decision, and keeps it only when the review was switched on.
        const withProgram: WorkflowSnapshot = workflow.program === undefined ? WorkflowSnapshotSchema.parse({ ...workflow, program: ROVARA_CODE_PROGRAM, programStepId: "plan" }) : workflow;
        const decided = await withDesignReviewMode(runtime.reader, {
          orgId: deps.companyId, project: task.project, workflow: withProgram, assessment: parsed, now, env: runtime.env, ...(task.designFirst === undefined ? {} : { designFirst: { by: task.designFirst.by } }),
        });
        return decided.designReview === undefined ? workflow : decided;
      } catch (error) {
        // The setting could not be read: the review stays off (Off is the default in the worst case), and the task is not held up for it.
        log(deps, { event: "design_review.mode_not_read", error: error instanceof Error ? error.name : "unknown" });
        return workflow;
      }
    },

    rowFor: designRowFor,

    planInstructions: (workflow) => (workflow.designReview !== undefined && workflow.reviewPhase === "DESIGN" ? designTemplateInstructions({ resolving: false }) : undefined),

    isResolveRun: (workflow, operation) => workflow !== undefined && operation.workflowMode === "PLAN" && designResolveRunning(workflow),
  };
}
