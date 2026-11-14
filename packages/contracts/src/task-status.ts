// UX2 slice 2 item 1: ONE status model. Every surface that says where a task or session stands (the task page header and pipeline strip, Home, Live, the sidebar, Slack, the MCP tools and
// the CLI) reads this one contract: a state, its one human word, a reason sentence where the state needs one, and the next step. No surface shows a raw code (STARTING, task_failed, CLOSED).
import { z } from "zod";

/** The states, in the order a task moves through them. `needs_you` and `failed` always carry a reason sentence. */
export const TASK_STATUS_STATES = [
  "understanding", "planning", "reviewing_design", "building", "checking", "needs_you", "paused_budget", "ready_to_merge", "merged", "closed", "failed",
  // Review I4: a task with no workflow whose run finished waits for its owner's next request; that is not a block, so it is not "Needs you".
  "finished_run",
] as const;
export type TaskStatusState = (typeof TASK_STATUS_STATES)[number];

/** The one human word of each state. `needs_you` and `failed` are followed by ": <reason>" (`taskStatusText`). */
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

/** The states that are over: nothing more happens on the task. */
export const TASK_STATUS_ENDED: readonly TaskStatusState[] = ["merged", "closed"];

export const TASK_STATUS_REASON_MAX = 200;
export const TASK_STATUS_NEXT_MAX = 400;

const line = (max: number) => z.string().min(1).refine((value) => [...value].length <= max, `must be at most ${String(max)} characters`)
  .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), "must not contain control characters");

/**
 * Where a task stands, as every surface says it. `reason` is a whole sentence (no codes) for `needs_you` and `failed`, and may say more for others; `next` is what happens next or what to do,
 * written for the task's owner; `nextOthers`, when present, is the same for anyone else reading (a teammate is not the one who approves). Fixed words from the broker, never task content.
 */
export const TaskStatusSchema = z.object({
  state: z.enum(TASK_STATUS_STATES),
  reason: line(TASK_STATUS_REASON_MAX).optional(),
  next: line(TASK_STATUS_NEXT_MAX).optional(),
  nextOthers: line(TASK_STATUS_NEXT_MAX).optional(),
  /** Set on a Closed that a run's own end made (a cancelled or failed run of an open task): the session can still be retried. Absent on a task its owner closed and on a merge. */
  retryable: z.literal(true).optional(),
}).strict();
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

/** A reader that keeps a state a newer server adds as "unknown" instead of failing the answer. */
export const TaskStatusReaderSchema = z.object({
  state: z.string().min(1).max(40),
  reason: z.string().max(TASK_STATUS_REASON_MAX * 2).optional(),
  next: z.string().max(TASK_STATUS_NEXT_MAX * 2).optional(),
  nextOthers: z.string().max(TASK_STATUS_NEXT_MAX * 2).optional(),
}).passthrough();

const DEFAULT_REASON: Partial<Record<TaskStatusState, string>> = { needs_you: "a person needs to decide what happens next", failed: "it stopped with an error" };

const lowerFirst = (value: string): string => (/^[A-Z][a-z]/u.test(value) ? value[0]!.toLowerCase() + value.slice(1) : value);
const noStop = (value: string): string => value.replace(/[.\s]+$/u, "");

/** "Needs you: the checks didn't pass", "Failed: the repository would not clone", "Building", ... The one line every surface shows. A state this build doesn't know reads "Status unavailable". */
export function taskStatusText(status: { state: string; reason?: string | undefined }): string {
  const word = (TASK_STATUS_WORDS as Record<string, string>)[status.state];
  if (word === undefined) return "Status unavailable";
  if (status.state !== "needs_you" && status.state !== "failed") return word;
  const reason = status.reason ?? DEFAULT_REASON[status.state as TaskStatusState]!;
  return `${word}: ${lowerFirst(noStop(reason))}`;
}

/** The next step for one reader: the owner's words, or `nextOthers` for anyone else when it is set. */
export function taskStatusNext(status: { next?: string | undefined; nextOthers?: string | undefined }, owner: boolean): string | undefined {
  return owner ? status.next : status.nextOthers ?? status.next;
}

/** What a failed run's category says to a person: a cause sentence, never the code. */
export const FAILURE_CAUSE_WORDS: Record<string, string> = {
  setup_failed: "the workspace could not be set up",
  worker_unavailable: "no worker was free to run it",
  task_failed: "the run stopped with an error",
  timed_out: "the run took too long and was stopped",
  interrupted: "the run was interrupted",
  publication_failed: "the pull request could not be opened",
  budget_exhausted: "it ran out of budget",
};
export const failureCause = (category: string | undefined): string => (category === undefined ? undefined : FAILURE_CAUSE_WORDS[category]) ?? FAILURE_CAUSE_WORDS["task_failed"]!;

/**
 * The status of a session from its plain session status, for a session whose summary was written before the status model (and for a chain or a Mac session, which have no task stage).
 * Every session status maps to one state; nothing reads as a raw code.
 */
export function taskStatusFromSession(summary: { status: string; lastRunFailed?: true | undefined; step?: string | undefined }, closed = false): TaskStatus {
  if (closed) return { state: "closed" };
  switch (summary.status) {
    case "starting": return { state: "understanding" };
    case "running": return { state: "building" };
    case "needs_person": return { state: "needs_you", reason: "a person needs to decide what happens next" };
    case "paused": return { state: "paused_budget", reason: "it reached its spending limit" };
    case "waiting": return summary.lastRunFailed === true ? { state: "failed", reason: "the last run stopped with an error", next: "Retry it, or close the task." } : { state: "finished_run", next: "Send more work, or close the task." };
    case "stopped": return { state: "needs_you", reason: "it was stopped before it finished", next: "Retry it, or close the task." };
    case "succeeded": return { state: "closed" };
    case "failed": return { state: "failed", reason: "the run stopped with an error" };
    case "cancelled": return { state: "closed" };
    default: return { state: "needs_you", reason: "its status could not be read" };
  }
}

/** The status a session shows: its summary's own (`display`) when it has one, else what its plain status says. */
export function sessionTaskStatus(summary: { status: string; lastRunFailed?: true | undefined; step?: string | undefined; display?: unknown }): TaskStatus {
  const parsed = TaskStatusSchema.safeParse(summary.display);
  return parsed.success ? parsed.data : taskStatusFromSession(summary);
}

/** Whether a status asks a person to act now (the one "needs you" list holds it). */
export const statusNeedsSomeone = (status: { state: string }): boolean => status.state === "needs_you" || status.state === "paused_budget" || status.state === "ready_to_merge" || status.state === "failed";

/** Who may raise the limit a budget pause reached, by the pause's scope kind: said to the person whose work waits (MoneyBanners, Home, notifications). Fixed words. */
const BUDGET_RAISERS: Record<string, string> = {
  task: "a project maintainer or an org admin", max_per_run: "a project maintainer or an org admin", planning: "a project maintainer or an org admin", test: "a project maintainer or an org admin",
  project: "a project maintainer or an org admin", agent: "the agent's owner or an org admin", chain: "the chain's owner or an org admin", org: "an org admin", member: "an org admin", testing: "an org admin",
};
export const budgetRaisers = (scopeKind: string | undefined): string => (scopeKind === undefined ? undefined : BUDGET_RAISERS[scopeKind]) ?? "an org admin";

/** What a budget pause's limit is called, by its scope kind (never the raw kind). */
const BUDGET_SCOPE_NAMES: Record<string, string> = {
  task: "this task's run limit", max_per_run: "the per-run limit", planning: "the planning limit", test: "the test run's cap", project: "the project's budget", agent: "the agent's budget",
  chain: "the chain's budget", org: "the organization's monthly budget", member: "your monthly limit", testing: "your testing budget",
};
export const budgetScopeName = (scopeKind: string | undefined): string => (scopeKind === undefined ? undefined : BUDGET_SCOPE_NAMES[scopeKind]) ?? "a spending limit";

/** The next step of a budget pause for the person reading: they may raise it themselves, or who can (and whether Rovara has asked them: a budget request is open). */
export const budgetPauseNext = (scopeKind: string | undefined, mayDecide: boolean, asked: boolean): string => (mayDecide
  ? "You can raise the limit: open the budget request and decide."
  : asked ? `Rovara asked ${budgetRaisers(scopeKind)} to raise the limit; the work goes on once they do.` : `Only ${budgetRaisers(scopeKind)} can raise the limit; the work goes on once they do.`);
