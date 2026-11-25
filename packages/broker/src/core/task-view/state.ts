// F2-A: `stateOf`, the person-free half of the standing of a task (A2): from the facts the core holds about it (its workflow, whether it is closed, paused for money, waiting on the system, and the few facts that need a read of the
// store: merge tracking and the plan's self-check) it says which phase and step the task is at, how each step of its strip stands, what the pill is when no person is looking, and the person-free status line. The rule shared with the
// stored session summary's status (`status.ts`); it knows nothing of who is reading, so it can never say "Needs you" (it says `decision`: someone is needed, and `taskStandingFor` turns that into the reader's pill).
// Every word comes from the words table (`@agentx/contracts` `task-words.ts`). "Failed" and "Blocked" are never a pill: a blocked step is a decision (a person may retry) or Stopped (nobody can: the budget or the run limit);
// any round the facts do not name is `working`, never a guess.
import {
  CI_FIX_ROUNDS_MAX, CONFLICT_ROUNDS_MAX, FEEDBACK_AUTO_ROUNDS_MAX, PHASES, REASON_WORDS, STATUS_LINES, STEPS, WORKFLOW_BLOCK_REASONS, isRunLimitBlockReason, roundWords, workflowFixRounds,
  type PhaseKey, type PillKey, type RoleKey, type StepRow, type StepStateKey, type TaskStatus, type WorkflowSnapshot,
} from "@agentx/contracts";
import { statusOfTask } from "./status.js";

/** A wait the system makes, not a person: no machine was free, the AI provider limits requests, the day's allowance is used, the Slack access check is down. One pill, `waiting`; the reason says which. */
export type SystemWait = "no_machine" | "rate_limit" | "allowance" | "slack_check" | "start_reviews" | "start_step";

/** The part of the workflow snapshot the rule reads. */
export type StandingWorkflow = Pick<WorkflowSnapshot, "stage" | "state" | "path" | "definitionVersion" | "revision">
  & Partial<Pick<WorkflowSnapshot, "outcome" | "blockReason" | "reviewPhase" | "fixSource" | "fixRounds" | "designReview" | "critique" | "accessCheckWaitSince">>;

export interface StandingFacts {
  workflow?: StandingWorkflow | undefined;
  /** The owner closed the task (or its run ended). */
  closed: boolean;
  /** The task waits for money (the budget pause). */
  budgetPaused: boolean;
  failedPrepare: boolean;
  /** A decision waits: a plan to approve, questions to answer, findings, a feedback card, a stopped step a person may retry. Read from the stored task (`needsPersonOf`). */
  needsPerson: boolean;
  /** Who the decision waits on when the reader is not that person. Absent: the task owner. */
  askedRole?: RoleKey | undefined;
  /** The automatic revisions spent on the plan being written: more than none means Rovara asked the planner for a fuller plan. */
  planRevisionsUsed: number;
  /** The review round whose problems are being fixed, when a host serves it (the v2 view's `reviewRound`). */
  reviewRound?: { round: number; max: number } | undefined;
  /** The pull request that waits is ready for a person to merge (merge tracking: open, not a draft, checks passing, reviews as asked, branch not conflicted). Absent: nothing is read (no pull request), and the line says "Ready to merge" as it always did. */
  pullRequestReady?: boolean | undefined;
  /** Why a blocked review needs a person: the reviewers found problems with the change, or the review could not finish (unreadable, timed out). Absent at any other step. */
  reviewBlock?: "findings" | "unfinished" | "not_started" | undefined;
  /** A check failed: an open pull request whose checks fail (merge tracking, read from the store) or a failing result on the current candidate. */
  failedChecks: boolean;
  /** A wait the host knows of beyond the workflow's own note. */
  wait?: SystemWait | undefined;
  /** A person pressed Stop and nothing has started the work again: the pill is `Stopped` (the work is kept, a retry resumes it). F2-B reads it from the task row's `personStop` mark (`facts.ts`), so every surface sees it; a host may also pass it. Absent: a stopped step reads as a blocked one does. */
  stoppedByPerson?: boolean | undefined;
}

export interface StripStep { key: string; title: string; phase: PhaseKey; state: StepStateKey }

/** What the rule says, for no person in particular. `pill: "decision"` is "someone is needed": the reader's pill is `needs_you` or `needs_role`. */
export interface TaskState {
  status: TaskStatus;
  pill: PillKey | "decision";
  role: RoleKey;
  phase?: { key: PhaseKey; words: string } | undefined;
  step?: StripStep | undefined;
  steps?: StripStep[] | undefined;
}

// ---- what is ended, stopped for money, waiting

const isMerged = (workflow: StandingWorkflow | undefined): boolean => workflow?.stage === "MERGED" || workflow?.outcome === "MERGED";
const isClosed = (facts: StandingFacts): boolean => facts.closed || facts.workflow?.stage === "CLOSED" || facts.workflow?.outcome === "CLOSED" || facts.workflow?.outcome === "ANSWERED";

/** A blocked step nobody's retry lifts: the budget pause, or a run limit waiting for its own approval. */
export const blockedOnSpend = (workflow: Pick<StandingWorkflow, "state" | "blockReason"> | undefined): boolean =>
  workflow?.state === "BLOCKED" && (workflow.blockReason === WORKFLOW_BLOCK_REASONS.budgetPaused || isRunLimitBlockReason(workflow.blockReason));

function waitOf(facts: StandingFacts): SystemWait | undefined {
  const workflow = facts.workflow;
  if (facts.wait !== undefined) return facts.wait;
  return workflow?.accessCheckWaitSince?.revision === workflow?.revision && workflow?.accessCheckWaitSince !== undefined ? "slack_check" : undefined;
}

const WAIT_REASONS: Record<SystemWait, string> = { no_machine: REASON_WORDS.waitMachine, rate_limit: REASON_WORDS.waitRateLimit, allowance: REASON_WORDS.waitAllowance, slack_check: REASON_WORDS.waitSlack, start_reviews: REASON_WORDS.waitStartReviews, start_step: REASON_WORDS.waitStartStep };

const FIX_STAGES: readonly string[] = ["IMPLEMENT", "VERIFY", "REVIEW", "PULL_REQUEST"];
const REVIEW_FIX_STAGES: readonly string[] = ["IMPLEMENT", "VERIFY", "REVIEW"];

/** The fix round now running, in words (with its round when the snapshot counts it), or undefined when no fix runs. */
function fixOf(facts: StandingFacts): string | undefined {
  const workflow = facts.workflow;
  if (workflow === undefined || workflow.state === "BLOCKED") return undefined;
  if (workflow.fixSource !== undefined && FIX_STAGES.includes(workflow.stage)) {
    const rounds = workflowFixRounds(workflow);
    switch (workflow.fixSource) {
      case "ci": return roundWords(REASON_WORDS.fixCi, Math.max(1, rounds.ci), CI_FIX_ROUNDS_MAX);
      case "conflict": return roundWords(REASON_WORDS.fixConflict, Math.max(1, rounds.conflict), CONFLICT_ROUNDS_MAX);
      case "feedback": return rounds.feedbackAuto > 0 ? roundWords(REASON_WORDS.fixFeedback, rounds.feedbackAuto, FEEDBACK_AUTO_ROUNDS_MAX) : REASON_WORDS.fixFeedback;
    }
  }
  if (facts.reviewRound !== undefined && REVIEW_FIX_STAGES.includes(workflow.stage)) return roundWords(REASON_WORDS.fixReview, facts.reviewRound.round, facts.reviewRound.max);
  return undefined;
}

// ---- the strip

/** The strip's order. `approve_spec` is the gate, so a layer's position is compared with the approval's frontier, not with the gate's own position. */
const ORDER = ["understand", "spec1", "spec2", "design", "spec3", "approve_spec", "build", "tests", "review", "pull_request"] as const;
const rowOf = (key: string): StepRow => STEPS.find((row) => row.key === key)!;

function keysOf(workflow: StandingWorkflow): string[] {
  const keys: string[] = [];
  if (workflow.definitionVersion === "1.1.0") keys.push("understand");
  if (workflow.path === "FULL") keys.push("spec1", "spec2");
  if (workflow.stage === "PLAN_CRITIQUE" || workflow.designReview !== undefined || workflow.critique !== undefined) keys.push("design");
  keys.push("spec3", "approve_spec", "build", "tests", "review", "pull_request");
  return keys.sort((left, right) => ORDER.indexOf(left as (typeof ORDER)[number]) - ORDER.indexOf(right as (typeof ORDER)[number]));
}

const LAYER_OF_PHASE = { REQUIREMENTS: "spec1", DESIGN: "spec2", IMPLEMENTATION_PLAN: "spec3" } as const;
/** The last position the spec approval at hand has settled: the layer it approves, and the design review before it. */
const FRONTIER_OF_PHASE = { REQUIREMENTS: 1, DESIGN: 3, IMPLEMENTATION_PLAN: 4 } as const;

function currentKeyOf(workflow: StandingWorkflow, keys: readonly string[]): string {
  const pick = (key: string): string => (keys.includes(key) ? key : "spec3");
  switch (workflow.stage) {
    case "UNDERSTAND": return pick("understand");
    case "PLAN": return workflow.path === "FULL" ? pick(LAYER_OF_PHASE[workflow.reviewPhase ?? "REQUIREMENTS"]) : "spec3";
    case "PLAN_CRITIQUE": return pick("design");
    case "PLAN_REVIEW": return "approve_spec";
    case "IMPLEMENT": return "build";
    case "VERIFY": return "tests";
    case "REVIEW": return "review";
    default: return "pull_request";
  }
}

function stripOf(facts: StandingFacts, workflow: StandingWorkflow, spent: boolean): StripStep[] {
  const keys = keysOf(workflow);
  const merged = isMerged(workflow);
  const currentKey = currentKeyOf(workflow, keys);
  const position = (key: string): number => ORDER.indexOf(key as (typeof ORDER)[number]);
  const approving = workflow.stage === "PLAN_REVIEW";
  const frontier = workflow.path === "FULL" && workflow.reviewPhase !== undefined ? FRONTIER_OF_PHASE[workflow.reviewPhase] : 4;
  const currentState = (): StepStateKey => {
    if (spent || facts.stoppedByPerson === true) return "stopped";
    if (workflow.state === "COMPLETE") return "done";
    if (workflow.state === "BLOCKED") return currentKey === "tests" && facts.failedChecks ? "failed" : "needs";
    if (workflow.stage === "WAIT_FOR_MERGE") return facts.needsPerson ? "needs" : "done";
    return workflow.state === "WAITING" && facts.needsPerson ? "needs" : "doing";
  };
  return keys.map((key): StripStep => {
    const row = rowOf(key);
    const title = workflow.path === "QUICK" && row.quickTitle !== undefined ? row.quickTitle : row.title;
    let state: StepStateKey;
    if (merged) state = "done";
    else if (key === currentKey) state = currentState();
    else if (approving && position(key) < position("approve_spec")) state = position(key) <= frontier ? "done" : "todo";
    else state = position(key) < position(currentKey) ? "done" : "todo";
    if (key === "tests" && facts.failedChecks && (state === "done" || state === "doing" || state === "needs") && !merged) state = "failed";
    return { key, title, phase: row.phase, state };
  });
}

// ---- the rule

function pillOfFacts(facts: StandingFacts, status: TaskStatus, spent: boolean): PillKey | "decision" {
  const workflow = facts.workflow;
  if (isMerged(workflow)) return "merged";
  if (isClosed(facts)) return "closed";
  if (facts.failedPrepare || facts.budgetPaused || spent || facts.stoppedByPerson === true) return "stopped";
  if (workflow === undefined) {
    switch (status.state) {
      case "needs_you": return "decision";
      case "paused_budget": case "failed": case "finished_run": return "stopped";
      default: return "working";
    }
  }
  if (waitOf(facts) !== undefined) return "waiting";
  if (workflow.state === "BLOCKED" || facts.needsPerson) return "decision";
  if (workflow.stage === "WAIT_FOR_MERGE") return "in_review";
  return fixOf(facts) === undefined ? "working" : "fixing";
}

/** What a person is needed for at a blocked review: its problems or its failure to finish (never the one "blocked" sentence). */
function reviewBlockWords(facts: StandingFacts, base: TaskStatus, pill: PillKey | "decision"): { reason: string; next: string; nextOthers: string } | undefined {
  if (pill !== "decision" || base.state !== "needs_you" || facts.reviewBlock === undefined) return undefined;
  if (facts.reviewBlock === "not_started") return STATUS_LINES.reviewsCouldNotStart;
  return facts.reviewBlock === "findings" ? STATUS_LINES.reviewFoundProblems : STATUS_LINES.reviewCouldNotFinish;
}

/** The person-free status line, with the reason this rule adds to the K4 sentences: a fix round, a wait, a fuller plan. */
function refinedStatus(facts: StandingFacts, base: TaskStatus, pill: PillKey | "decision", spent: boolean): TaskStatus {
  const workflow = facts.workflow;
  if (facts.stoppedByPerson === true && !spent && !facts.budgetPaused && !facts.failedPrepare && base.state !== "merged" && base.state !== "closed") return { state: "finished_run", ...STATUS_LINES.stoppedByPerson };
  const blockWords = reviewBlockWords(facts, base, pill);
  if (blockWords !== undefined) return { state: "needs_you", ...blockWords };
  if (workflow?.stage === "WAIT_FOR_MERGE" && base.state === "ready_to_merge" && pill === "in_review" && facts.pullRequestReady === false) return { state: "checking", ...(facts.failedChecks ? STATUS_LINES.pullRequestChecksFailing : STATUS_LINES.pullRequestChecking) };
  // The status line and the pill agree: a task that waits on a person says so even where the old switch read the stage (review findings, a feedback card on the pull request).
  if (pill === "decision" && base.state !== "needs_you") return { state: "needs_you", ...STATUS_LINES.decisionWaiting };
  if (spent && !facts.budgetPaused && workflow !== undefined) return { state: "paused_budget", ...STATUS_LINES.spendStopped };
  if (pill === "waiting") return { ...base, reason: WAIT_REASONS[waitOf(facts)!] };
  if (pill === "fixing") return { ...base, reason: fixOf(facts)! };
  if (pill === "working" && workflow?.stage === "PLAN" && facts.planRevisionsUsed > 0) return { ...base, reason: REASON_WORDS.fullerPlan };
  return base;
}

export function stateOf(facts: StandingFacts): TaskState {
  const workflow = facts.workflow;
  const spent = blockedOnSpend(workflow);
  const base = statusOfTask({ workflow, ...(facts.failedPrepare ? { failedPrepare: {} } : {}), budgetPaused: facts.budgetPaused }, "running", { ended: isClosed(facts) });
  const pill = pillOfFacts(facts, base, spent);
  const status = refinedStatus(facts, base, pill, spent);
  const role = facts.askedRole ?? "task_owner";
  if (workflow === undefined || (isClosed(facts) && !isMerged(workflow))) return { status, pill, role };
  const steps = stripOf(facts, workflow, spent || facts.budgetPaused);
  if (isMerged(workflow)) return { status, pill, role, steps };
  const currentKey = currentKeyOf(workflow, steps.map((step) => step.key));
  const step = steps.find((entry) => entry.key === currentKey);
  return { status, pill, role, steps, ...(step === undefined ? {} : { step, phase: { key: step.phase, words: PHASES[step.phase] } }) };
}
