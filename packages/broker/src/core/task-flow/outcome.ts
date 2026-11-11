// Lane L6a, task flow core: what the worker's terminal result meant, already read. The callback layer reads the worker's artifacts and checks them
// (Cloud's `aws/broker/terminal-result.ts`, not ported here: there is no object-storage port yet) and hands the flow one of these.
import type { PlanUnreadableCategory } from "../../developer/plan-check-summary.js";
import type { PlanSelfCheckState } from "../../developer/plan-self-check.js";
import type { PlanDocument, WorkflowArtifact, WorkflowCheckProposal, WorkflowReviewBase } from "@agentx/contracts";

export type StepOutcome =
  /** The workspace is prepared; `base` is the commit each repository was checked out at. */
  | { kind: "prepared"; base?: WorkflowReviewBase; /** The meta repository's commit the worker materialized, when it reports one. Kept only if it is the one the broker chose for this preparation. */ knowledgeCommit?: string }
  /** Understand's assessment as the broker checked it; an answer also names the file it was read from. */
  | { kind: "understood"; assessment: unknown; answerArtifact?: { id: string; objectKey: string; createdAt: string } }
  /**
   * A planning run's document. A structured plan (`core/plan`) also says where it was stored and, when it cites code, hands the plan on so the cited code is read once the plan is committed
   * (`cites`), and tells the planner's replies to the comments the owner sent (none yet).
   */
  | { kind: "planned"; artifact: WorkflowArtifact; proposal?: WorkflowCheckProposal; noChangeNeeded?: boolean; cites?: { plan: PlanDocument; prefix: string } }
  /** A planning run whose answer could not be read as the plan document it was asked for: the problems found (the document reader's own words, at most five). Retry planning tells the planner. */
  | { kind: "plan_unreadable"; errors: string[]; category: PlanUnreadableCategory; autoRetried?: true }
  /** A planning run's answer was not shown: the planner is asked again by itself, once, with `prompt` (what was unreadable, or the plan's findings). `selfCheck` is the budget this spent. */
  | { kind: "plan_again"; prompt: string; selfCheck: PlanSelfCheckState }
  /**
   * A coding run, or a rerun of the checks: what the worker reported (the code it ended on, the code its checks ran on, the check report). It is the worker's word, so the build step
   * reads it against its schemas and the task's recorded start before it believes any of it (Cloud's `completedWorkflowItems`).
   */
  | { kind: "built"; result: unknown }
  /** The reviews: the code the reviewers read and their reports, read the same way. */
  | { kind: "reviewed"; result: unknown }
  /** A publication: the pull request the worker says it opened. Held to the operation's recorded expectation and checked at the host. */
  | { kind: "published"; result: unknown }
  /**
   * A setup run's answer (`core/setup-agent`): the worker's word, read again by the setup agent's end before any of it is kept (the proposal by `sanitizeSetupProposal`, the summary by its schema). A failed run's partial
   * answer is carried the same way.
   */
  | { kind: "setup-run"; result: unknown }
  /** A run that needs no workflow move. */
  | { kind: "ended" };

export interface OperationResult {
  workspaceId: string;
  operationId: string;
  /** The fence on the worker's capability; a result for another fence is refused. */
  fence: number;
  status: "SUCCEEDED" | "FAILED" | "CANCELLED" | "INTERRUPTED";
  error?: string;
  outcome?: StepOutcome;
}
