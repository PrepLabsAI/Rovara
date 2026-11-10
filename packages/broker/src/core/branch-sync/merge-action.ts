// The shapes a merge-tracking pass hands to the deciders of its action slots (a conflict, failing CI, feedback, a branch sync), and what a decider hands back.
//
// In Cloud these deciders returned DynamoDB transaction items (the workflow's dispatch row, the milestone and its session line, the CI evidence), written in the tracking pass's
// one transaction. Here a decider returns DATA: the next workflow, the rows it owns itself (as document-store steps), the dispatch the new workflow state is due for and the
// milestones to record. The pass (merge tracking, lane L7a) turns the dispatch into a row through the task-flow core (L6a) and the milestones into rows and session lines through the
// notifications module (L6b), and commits all of it with the tracking item in one `DocumentStore.transact`. No decider names a table, a queue or a provider.
import type { Autonomy, CodeMilestone, MergeTrackingItem, OrgId, TransactItem, WorkflowSnapshot } from "@agentx/contracts";

/** The slots, in the order the pass tries them: a conflict, then failing CI, then feedback, then a branch sync. */
export const MERGE_ACTION_ORDER = ["conflict", "ci_fix", "feedback", "sync"] as const;
export type MergeActionSlot = typeof MERGE_ACTION_ORDER[number];

/** A failing check that counts, as a CI fix is told of it. */
export interface FailingCheck {
  name: string;
  conclusion: string;
  url: string;
  /** The runner's id for the check run (the job id, where the host's runner has jobs). */
  jobId?: string;
  /** The system that made the check, as the host words it (an opaque word the core does not read). */
  source?: string;
  /** The host can hand out this run's log through the check runner (the host decides; the core never reads `source` for it). */
  logReadable?: boolean;
}

/** The kinds of dispatch a decider can ask for: a coding run (a CI fix round), or the merge of the base branch into the task's branch (or its restack). */
export type MergeDispatchKind = "IMPLEMENT" | "SYNC";

/** The work the new workflow state is due for. The task-flow core writes the dispatch row for it, in the same commit. */
export interface MergeDispatchRequest {
  kind: MergeDispatchKind;
  workflowRevision: number;
  /** The candidate's digest, or the all-zero digest where no candidate exists yet (`WORKFLOW_NO_CANDIDATE_DIGEST`). */
  candidateDigest: string;
  /** When it is due (ISO time). */
  at: string;
}

/** A milestone to record with the change that caused it; `n` is the workflow revision it belongs to (so a repeat writes nothing new). */
export interface MergeMilestoneRequest {
  milestone: CodeMilestone;
  n: number;
}

/** What a decider asks for. All of it is committed together with the tracking item, or none of it is. */
export interface MergeActionRequest {
  slot: MergeActionSlot;
  workflow: WorkflowSnapshot;
  /** Rows the decider owns itself, to commit in the pass's transaction (the CI evidence of a fix round). */
  steps: TransactItem[];
  dispatch?: MergeDispatchRequest | undefined;
  milestones: MergeMilestoneRequest[];
  /** The pull request's day count of merges of the base, when the action uses one: written to the tracking item in the same transaction, which keeps the count from being used twice. */
  syncs?: MergeTrackingItem["syncs"] | undefined;
}

/** What a decider may read beside the tracking item: where the pull request is, which checks fail and how to read a failing job's log. Every host read counts against the pass's allowance. */
export interface MergeActionContext {
  orgId: OrgId;
  taskId: string;
  sessionId?: string | undefined;
  repositoryId: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
  headSha: string;
  /** The failing checks that count (at most ten). */
  failing: readonly FailingCheck[];
  /** The end of a job's log, or undefined where there is none or this host cannot read logs. Throws what the host's failure throws; a rate limit and a spent allowance are the sweep's to handle. */
  readJobLog?: ((jobId: string) => Promise<string | undefined>) | undefined;
  /** The host itself calls the branch `behind`, which it does only for a base that requires up-to-date branches: a branch a commit behind a base that does not care is not. */
  behindRequired?: boolean | undefined;
  log?: ((event: string, fields: Record<string, unknown>) => void) | undefined;
  /** The attribute the document store sweeps for expiry (`DocumentStore.ttlAttribute`); the rows a decider writes carry their expiry under it. Absent: the scheme default. */
  ttlAttribute?: string | undefined;
}

export interface MergeActionInput {
  item: MergeTrackingItem;
  workflow: WorkflowSnapshot;
  autonomy: Autonomy;
  now: number;
  context?: MergeActionContext | undefined;
}

export type MergeActionDecider = (input: MergeActionInput) => MergeActionRequest | undefined | Promise<MergeActionRequest | undefined>;

/** Fills a slot and returns the function that empties it again (merge tracking's `registerMergeActionDecider`; one decider per slot). */
export type RegisterMergeActionDecider = (slot: MergeActionSlot, decide: MergeActionDecider) => () => void;

/** The error a pass throws when it runs out of its request allowance; deciders do not swallow it (the pass is tried again). Named, so a decider tells it without importing the pass. */
export const TRACKING_REQUEST_CAP_ERROR_NAME = "TrackingRequestCapError";
/** The error a host read throws when the pass's read budget is spent. */
export const HOST_BUDGET_EXHAUSTED_ERROR_NAME = "GithubBudgetExhaustedError";

/** The candidate digest of a dispatch due before the task has a candidate. */
export const WORKFLOW_NO_CANDIDATE_DIGEST = "0".repeat(64);
