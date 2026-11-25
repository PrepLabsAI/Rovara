// F2-A: THE words table of Rovara Code. Every phase, step, pill, status and action word a surface shows for a task is here and nowhere else (pure data and plain functions, browser-safe, no engine import; Code only: it is never
// copied to Cloud, which draws the words Code serves). Keys come from the engine; words come from the pipeline mock (`mock/pipeline-and-task-mock.html` with its word appendix `MOCK-WORDS-AND-SETTINGS.md`, part 1) plus the
// owner's three additions (DEC 254zzz490): "Needs the task owner", "Merged" and "Closed". "Failed" and "Blocked" are never shown as a task's state (a step may be `failed` on the strip; a task is Stopped or Needs you).
// Plain exported constants: no registry, no hook. A new step is a row. The rule that picks a row for a task and a person is `taskStandingFor` (`broker/src/core/task-view`).

import type { TaskActionId } from "./task-actions.js";

// ---- phases and steps (the mock's PHN and step catalogue)

/** The five phases, in the order a task moves through them (DEC 462). The pipeline editor validates order with the same keys. */
export const PHASE_KEYS = ["prepare", "spec", "build", "verify", "deliver"] as const;
export type PhaseKey = (typeof PHASE_KEYS)[number];
export const PHASES: Readonly<Record<PhaseKey, string>> = { prepare: "Prepare", spec: "Spec", build: "Build", verify: "Verify", deliver: "Deliver" };

/** One step of the strip: its title, its phase and the engine stages it covers (none: the redesign's step the engine does not run yet). Team-added steps carry their own title from the pipeline config, not from here. */
export interface StepRow { key: string; title: string; phase: PhaseKey; stages: readonly string[]; /** The title on the Quick path, when it differs. */ quickTitle?: string }

/** The mock's built-in steps, in strip order within each phase. Today's engine runs the rows that name stages. */
export const STEPS: readonly StepRow[] = [
  { key: "sandbox", title: "Start the sandbox", phase: "prepare", stages: [] },
  { key: "understand", title: "Understand the request", phase: "prepare", stages: ["UNDERSTAND"] },
  { key: "spec1", title: "Spec layer 1: What and why", phase: "spec", stages: ["PLAN"] },
  { key: "spec2", title: "Spec layer 2: Approach", phase: "spec", stages: ["PLAN"] },
  { key: "design", title: "Design review", quickTitle: "Design review (lighter)", phase: "spec", stages: ["PLAN_CRITIQUE"] },
  { key: "spec3", title: "Spec layer 3: Steps", phase: "spec", stages: ["PLAN"] },
  { key: "approve_spec", title: "Approve the spec", phase: "spec", stages: ["PLAN_REVIEW"] },
  { key: "build", title: "Build", phase: "build", stages: ["IMPLEMENT"] },
  { key: "tests", title: "Run the tests", phase: "verify", stages: ["VERIFY"] },
  { key: "mutation", title: "Mutation spot-check", phase: "verify", stages: [] },
  { key: "ai_checks", title: "AI product checks", phase: "verify", stages: [] },
  { key: "browser", title: "Browser check", phase: "verify", stages: [] },
  { key: "review", title: "Code review", phase: "verify", stages: ["REVIEW"] },
  { key: "secret_scan", title: "Secret scan", phase: "verify", stages: [] },
  { key: "security_scan", title: "Security scan", phase: "verify", stages: [] },
  { key: "approve_pr", title: "Approval before the pull request", phase: "deliver", stages: [] },
  { key: "pull_request", title: "Open the pull request", phase: "deliver", stages: ["PULL_REQUEST", "WAIT_FOR_MERGE"] },
];
export const stepRowOf = (key: string): StepRow | undefined => STEPS.find((row) => row.key === key);

/** The state of a step on the strip (the mock's PSIC keys) and its screen-reader word. */
export const STEP_STATE_KEYS = ["done", "doing", "needs", "failed", "todo", "off", "stopped"] as const;
export type StepStateKey = (typeof STEP_STATE_KEYS)[number];
export const STEP_STATE_WORDS: Readonly<Record<StepStateKey, string>> = { done: "Done", doing: "In progress", needs: "Waiting for a person", failed: "Failed", todo: "Not started", off: "Turned off", stopped: "Stopped" };

// ---- the pill (the mock's STATUS and appendix 1.3, plus the owner's additions)

export const PILL_TONES = ["attention", "running", "ok", "idle"] as const;
export type PillTone = (typeof PILL_TONES)[number];
/** The pill keys. `needs_role` is the owner's addition: "Needs the task owner" for a person who cannot act, "Needs a company admin" when an admin is the one needed. There is no `retrying` key: a retry is `working`; every wait is `waiting`. */
export const PILL_KEYS = ["needs_you", "needs_role", "working", "fixing", "waiting", "in_review", "stopped", "merged", "closed"] as const;
export type PillKey = (typeof PILL_KEYS)[number];

/** Who a decision waits on, when the reader is not that person. The role words are the one fixed set. */
export const ROLE_KEYS = ["task_owner", "co_owner", "project_admin", "company_admin"] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];
export const ROLE_WORDS: Readonly<Record<RoleKey, string>> = { task_owner: "task owner", co_owner: "co-owner", project_admin: "project admin", company_admin: "company admin" };
/** The words of the `needs_role` pill, by the role that is needed. */
export const NEEDS_ROLE_WORDS: Readonly<Partial<Record<RoleKey, string>>> = { task_owner: "Needs the task owner", company_admin: "Needs a company admin" };

/** The pill rows: words (the `needs_role` row's are in `NEEDS_ROLE_WORDS`), the tone a surface colours it by and the icon key it draws. A surface never maps a key to words: it draws the words Code serves. */
export const PILLS: Readonly<Record<PillKey, { words: string; tone: PillTone; icon: string }>> = {
  needs_you: { words: "Needs you", tone: "attention", icon: "alert" },
  needs_role: { words: NEEDS_ROLE_WORDS.task_owner!, tone: "attention", icon: "alert" },
  working: { words: "Rovara is working", tone: "running", icon: "arc" },
  fixing: { words: "Rovara is fixing it", tone: "running", icon: "arc" },
  waiting: { words: "Waiting", tone: "running", icon: "clock" },
  in_review: { words: "In review", tone: "ok", icon: "ring" },
  stopped: { words: "Stopped", tone: "idle", icon: "dash" },
  merged: { words: "Merged", tone: "ok", icon: "tick" },
  closed: { words: "Closed", tone: "idle", icon: "dash" },
};

/** The one pill a surface draws: its key, its words and its tone. */
export interface PillView { key: PillKey; words: string; tone: PillTone; icon: string }
export function pillOf(key: PillKey, role?: RoleKey): PillView {
  const row = PILLS[key];
  return { key, words: key === "needs_role" ? NEEDS_ROLE_WORDS[role ?? "task_owner"] ?? row.words : row.words, tone: row.tone, icon: row.icon };
}

// ---- the reasons a status line gives (fixed sentences; never task content)

/** The one sentence a state's `reason` or `next` says, where the pill alone does not. Fixed words: never task content. */
export const REASON_WORDS = {
  fullerPlan: "Rovara is asking for a fuller plan",
  fixCi: "Rovara is fixing the failing checks",
  fixConflict: "Rovara is resolving a conflict with the base branch",
  fixFeedback: "Rovara is fixing the review comments",
  fixReview: "Rovara is fixing what the review found",
  waitMachine: "No machine is free; Rovara will try again",
  waitRateLimit: "The AI provider is limiting requests; Rovara will try again",
  waitAllowance: "The daily allowance is used up; the work goes on when it resets",
  waitSlack: "Rovara is waiting for Slack to answer the access check",
  stoppedFinished: "the run finished and nothing is running; the work is kept",
  unavailable: "Status unavailable",
  // SPEND-UNREPORTED-RUN case (iii): a run that sent no usage report and could not be measured otherwise is counted at what admission held for it, marked as an estimate until the exact figure is in.
  spendEstimated: "Part of this task's spend is an estimate until the exact figure is in",
} as const;

/** The reason and next lines of the person-free status (the old K4 sentences, moved here: one place). `nextOthers` is what anyone who is not the one needed reads. */
export const STATUS_LINES = {
  merged: { next: "Nothing; this task is complete." },
  answered: { reason: "Answered: no code change was needed", next: "Nothing; no code change was needed." },
  prepareFailed: { reason: "the repository could not be prepared for the task", next: "Close the task and start it again." },
  endedFailed: { next: "Start a new task." },
  endedClosed: { next: "Nothing; this task is closed." },
  spendStopped: { reason: "it reached its spending limit", next: "The work goes on once the limit is raised or the allowance changes." },
  // A person's own Stop: the legacy status has no "stopped" state and may not gain one (released readers parse it strictly), so it says the run finished and waits (`finished_run`: not "Needs you"), agreeing with the Stopped pill.
  stoppedByPerson: { reason: "it was stopped before it finished", next: "Retry it, or close the task." },
  decisionWaiting: { reason: "a decision is waiting", next: "Review it and decide.", nextOthers: "Waiting for the task owner." },
  blocked: { reason: "the task is blocked", next: "Retry it, or ask for changes.", nextOthers: "Waiting for the task owner." },
  planWaiting: { reason: "the plan is waiting for approval", next: "Review it and approve, or ask for changes.", nextOthers: "Waiting for the task owner." },
  questionsWaiting: { reason: "questions about the request need answers", next: "Answer them.", nextOthers: "Waiting for the task owner." },
  readyToMerge: { next: "Ready to merge: review the pull request and merge it.", nextOthers: "The pull request is in review." },
  understanding: { next: "A plan follows once the request is understood." },
  planning: { next: "You review the plan when it is ready." },
  building: { next: "Checks and a pull request follow." },
  checking: { next: "A pull request is opened once the checks pass." },
  // SPEND-UNREPORTED-RUN item 3: what a decision card says when the task's spend cannot be read yet (the stable code is `spend_unreadable`, in `DECISION_REFUSAL_REASONS`): the real reason and what happens next,
  // never "This isn't ready to be decided yet". Rovara settles an ended run that sent no usage report by itself, so the next step is waiting, not an action.
  spendUnreadable: { reason: "Rovara could not read this task's spend yet", next: "Rovara settles the spend on its own. Try again in a little while." },
} as const;

/** The one sentence a card refusal for the spend that could not be read says: the reason, then what happens next. Served by every surface that refuses on it (the decision card and, from F2-B, the task standing). */
export const spendUnreadableWords = (): string => `${STATUS_LINES.spendUnreadable.reason}, so it cannot start more work on this task. ${STATUS_LINES.spendUnreadable.next}`;

/** "<sentence> (round 2 of 3)". */
export const roundWords = (sentence: string, round: number, max: number): string => `${sentence} (round ${String(round)} of ${String(max)})`;

// ---- the decision moves

/** The action ids that make the pill "Needs you" for a person who is offered one. NOT `task.merge` (a pull request that waits is "In review"), `task.stop`, `task.close`, `task.continue`, `people.*` or `pull-request.keep`. */
export const DECISION_MOVES: readonly string[] = [
  "plan.approve", "plan.request-changes", "plan.reject", "task.answer", "step.retry", "task.review", "work.send-back", "findings.resolve",
  "feedback.fix", "feedback.dismiss", "feedback.answer", "feedback.retry-review", "pull-request.open",
];

// ---- the status model's words (legacy column: the old "one status model" keys stay until the CLI, MCP and inbox move, step 4)

/** The states, in the order a task moves through them. `needs_you` and `failed` always carry a reason sentence. */
export const TASK_STATUS_STATES = [
  "understanding", "planning", "reviewing_design", "building", "checking", "needs_you", "paused_budget", "ready_to_merge", "merged", "closed", "failed",
  // Review I4: a task with no workflow whose run finished waits for its owner's next request; that is not a block, so it is not "Needs you".
  "finished_run",
] as const;
export type TaskStatusState = (typeof TASK_STATUS_STATES)[number];

/** The one human word of each legacy state. `needs_you` and `failed` are followed by ": <reason>" (`taskStatusText`). The `failed` word is legacy: the pill never says it. */
export const TASK_STATUS_WORDS: Record<TaskStatusState, string> = {
  understanding: "Understanding the request",
  planning: "Planning",
  reviewing_design: "Reviewing the design",
  building: "Building",
  checking: "Checking",
  needs_you: "Needs you",
  paused_budget: "Paused: needs more budget",
  ready_to_merge: "Ready to merge",
  merged: "Merged",
  closed: "Closed",
  failed: "Failed",
  finished_run: "Finished its run",
};

// ---- the actions (moved from `task-actions.ts`: one place)

/**
 * One label per action id. The mock's where the mock has the action ("Approve", "Send back with instructions", "Stop here and keep the work", "Close task"), the registry's where it does not. `done` is the one line a card shows once
 * the move was taken ("Done in Slack: ..." is the surface's). No Slack or web markup. `label` may depend on the step (a retry's label names the step: `stepRetryLabel`).
 */
export const ACTION_WORDS: Readonly<Record<TaskActionId, { label: string; done: string }>> = {
  "plan.approve": { label: "Approve", done: "Approved." },
  "plan.request-changes": { label: "Request changes", done: "Changes requested." },
  "plan.reject": { label: "Reject", done: "Rejected." },
  "step.retry": { label: "Retry", done: "Retrying." },
  "work.send-back": { label: "Send back with instructions", done: "Sent back to coding." },
  "findings.resolve": { label: "Resolve findings", done: "Findings resolved." },
  "feedback.fix": { label: "Fix the recommended feedback", done: "Fixing the feedback." },
  "feedback.dismiss": { label: "Dismiss the comments", done: "Comments dismissed; the pull request stays as it is." },
  "feedback.answer": { label: "Answer in my own words", done: "Answer sent; the feedback is being reviewed again." },
  "feedback.retry-review": { label: "Retry review", done: "Retrying the feedback review." },
  "pull-request.keep": { label: "Keep the pull request, the fix changed nothing", done: "Kept the pull request as it is." },
  "task.close": { label: "Close task", done: "Closing the task." },
  "task.stop": { label: "Stop here and keep the work", done: "Stopping." },
  "task.merge": { label: "Merge", done: "Merged." },
  "task.continue": { label: "Send more instructions", done: "Instructions sent." },
  "task.review": { label: "Review again", done: "Reviewing again." },
  "pull-request.open": { label: "Open a pull request", done: "Opening the pull request." },
  "task.answer": { label: "Answer the questions", done: "Answers sent." },
  "people.view": { label: "People", done: "" },
  "people.add": { label: "Add person", done: "Person added." },
  "people.set-role": { label: "Change role", done: "Role changed." },
  "people.take-ownership": { label: "Take ownership", done: "You are now the owner." },
};

/** The retry's label, by the step that stopped. */
export function stepRetryLabel(stage: string): string {
  switch (stage) {
    case "PLAN": case "UNDERSTAND": case "PLAN_CRITIQUE": return "Retry planning";
    case "IMPLEMENT": return "Retry coding";
    case "VERIFY": return "Choose checks and retry";
    case "REVIEW": return "Retry reviews";
    case "PULL_REQUEST": return "Open the pull request again";
    case "WAIT_FOR_MERGE": return "Retry the push";
    default: return ACTION_WORDS["step.retry"].label;
  }
}
