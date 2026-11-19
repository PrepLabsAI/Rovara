// What a session reads of the task it wraps (lane L6b, inventory B6). The task flow (lane L6a) owns the task record, the workspace and the runs; a session only shows where they stand. Everything the summary
// needs of them crosses this one seam as plain facts, so this lane does not import the task flow's code and the task flow can change how it keeps its records without touching sessions.
//
// The lane that owns the task record (L6a) fills the seam with a thin function over its records (about thirty lines: it already derives the run's status and the step words for its own task page). This lane
// ships no adapter of its own, because the run status is derived from operation records only the task flow knows. The tests use a fake source.
import type { TaskStatus } from "@agentx/contracts";

/** How the task's latest run stands, in the task flow's own derived words. */
export type TaskRunStatus = "STARTING" | "RUNNING" | "CANCELLED" | "FAILED" | "INTERRUPTED" | "SUCCEEDED" | "IDLE";

export interface SessionTaskFacts {
  companyId: string;
  taskId: string;
  project: string;
  /** The owner's person id as the session names them (64 hex), who a waiting task waits on. */
  ownerDeveloperId: string;
  /** The owner closed the task. */
  closedAt?: string | undefined;
  /** The task's workflow, as far as a summary reads it. A task with no workflow (a plain task) leaves it out. */
  workflow?: { stage: string; state: string; outcome?: string | undefined; blockReason?: string | undefined } | undefined;
  /** The latest run. */
  runStatus: TaskRunStatus;
  /** The category of the latest failure (`FAILURE_CAUSE_WORDS` names them). */
  failureCategory?: string | undefined;
  /** The workspace could not be prepared (the repository would not clone). */
  failedPrepare?: { at?: string | undefined } | undefined;
  /** The task waits for money (the Admission seam refused it, or the hosted product's budget paused it). */
  budgetPaused?: boolean | undefined;
  /** The one line that says what step the task is on ("Coding plan", "Waiting for approval"), from the task flow's own words. */
  step?: string | undefined;
  /** The newest readable line of the run's events (the caller has cut and redacted nothing; the summary does). */
  peek?: string | undefined;
  /** How many decisions wait (approvals, money requests). A plan waiting on its owner is not counted here: the owner is named in `needsPeople`. */
  pendingApprovals?: number | undefined;
  /** The extra people a waiting task names (the people who can decide). */
  waitingOn?: readonly string[] | undefined;
  runLimitUsd?: number | undefined;
  stopAtUsd?: number | undefined;
  /** The status model's words, when the task flow computes them (its own page words). Absent: readers use the plain status. */
  display?: TaskStatus | undefined;
  /** When the work ended or last changed, for an ended session's time. */
  endedAt?: string | undefined;
  updatedAt: string;
}

export interface TaskFactsSource {
  /** The task's facts, or undefined when the task is not there or belongs to another company. */
  read(companyId: string, taskId: string): Promise<SessionTaskFacts | undefined>;
}

/** What the session shows as cost: the cost ledger's total for the task, in dollars. */
export interface SessionCostSource {
  costUsd(companyId: string, taskId: string): Promise<number>;
}
