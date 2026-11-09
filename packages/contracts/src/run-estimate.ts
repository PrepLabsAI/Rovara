// What one task costs, as Rovara Code needs to say it (inventory 2.4, decision 41 "per-task cost"): the estimate a task shows before it starts, the run limit
// that follows from it and the words a blocked plan uses. This is the part of Cloud's spend.ts that the task flow reads. Budgets, approval thresholds, top-ups,
// payers, spend requests and the pause and counter keys stay in Cloud's spend.ts (decision 41), which imports from here.
import { z } from "zod";

/** A run's limit is its estimate's high end times this. */
export const RUN_LIMIT_MULTIPLIER = 2;
/** The most a single run may be limited to, whoever approves it. */
export const MAX_RUN_LIMIT_USD = 1000;
export interface RunEstimateRange {
  lowUsd: number;
  highUsd: number;
}

/** What a run is expected to cost before the org has history to estimate from. */
export const DEFAULT_RUN_ESTIMATE_USD = {
  QUICK: { lowUsd: 1, highUsd: 3 },
  FULL: { lowUsd: 4, highUsd: 10 },
  TASK: { lowUsd: 2, highUsd: 5 },
  AGENT: { lowUsd: 0.5, highUsd: 2 },
} as const satisfies Record<"QUICK" | "FULL" | "TASK" | "AGENT", RunEstimateRange>;

/** The longest time an estimate of a task's duration may show, in minutes: a task that sat waiting for a person is counted as no more than this. */
export const RUN_MINUTES_MAX = 480;

/**
 * Rovara Code version 2 (Plan 6 Task 7): the expected time from the task's start to its pull request, in minutes, from the project's recent tasks or, with too little
 * history, the defaults (`basis`). An estimate for a person to read, never a limit.
 */
export const RunMinutesSchema = z.object({
  low: z.number().int().min(1).max(RUN_MINUTES_MAX),
  high: z.number().int().min(1).max(RUN_MINUTES_MAX),
  basis: z.enum(["history", "default"]),
  samples: z.number().int().min(0),
}).strict().refine((minutes) => minutes.low <= minutes.high, { error: "the low end comes after the high end" });
export type RunMinutes = z.infer<typeof RunMinutesSchema>;

/** A run's expected cost and the limits that follow from it (Task 34); `basis` says whether the range came from the org's own runs or the default. `minutes` is Plan 6's time estimate, on version 2 tasks only. */
export const RunEstimateSchema = z.object({
  lowUsd: z.number().finite().min(0),
  highUsd: z.number().finite().min(0),
  runLimitUsd: z.number().finite().min(0),
  stopAtUsd: z.number().finite().min(0),
  basis: z.enum(["history", "default"]),
  samples: z.number().int().min(0),
  minutes: RunMinutesSchema.optional(),
}).strict();
export type RunEstimate = z.infer<typeof RunEstimateSchema>;

/** Decision journey slice 2: whether approving a coding plan sets a higher run limit than the task has (or its first one). Such an approval is taken only with the limit acknowledged. */
export const runLimitRaises = (currentUsd: number | undefined, proposedUsd: number): boolean => currentUsd === undefined || proposedUsd > currentUsd;

/**
 * An amount of US dollars as a person reads it in a run limit: whole dollars without cents ("$12"), cents with two places ("$2.50"), and any finer amount exactly as it is
 * ("$2.125"), so the figure shown is never a rounded version of the one that is set. A run limit is whole dollars unless the start asked for a lower, fractional one.
 */
export const formatRunLimitUsd = (usd: number): string => {
  if (Number.isInteger(usd)) return `$${String(usd)}`;
  const cents = Math.round(usd * 100);
  return Math.abs(usd * 100 - cents) < 1e-9 ? `$${(cents / 100).toFixed(2)}` : `$${String(usd)}`;
};

/**
 * 0.5.11 (QA6-12b): the words every surface that is not the web page shows before a coding plan's approval raises the run limit, exactly: "This raises the run limit from $A to $B".
 * This replaces slice 2's rule that Slack and tools could not show the limit and so were sent to the card: they show it, and the approval carries it.
 */
export const runLimitRaiseText = (currentUsd: number, proposedUsd: number): string =>
  `This raises the run limit from ${formatRunLimitUsd(currentUsd)} to ${formatRunLimitUsd(proposedUsd)}`;

/** How the words a workflow blocks with begin when approving its plan needs a higher tier to accept the run limit (Task 34). */
export const RUN_LIMIT_BLOCK_PREFIX = "This plan's run limit is $";
/**
 * Owner decision 3 (option E): when the project or an agent's owner pays, the plan waits for the person who may accept the run limit, in these words. The block
 * is still a run-limit block (`isRunLimitBlockReason`), which only that person's approval of the request lifts.
 */
export const RUN_LIMIT_WAITING_PREFIXES = ["Waiting for a project maintainer to accept the $", "Waiting for the agent's owner to accept the $"] as const;
export const runLimitWaitingText = (runLimitUsd: number, waitingFor: "project_maintainer" | "agent_owner"): string =>
  `${RUN_LIMIT_WAITING_PREFIXES[waitingFor === "project_maintainer" ? 0 : 1]}${String(runLimitUsd)} run limit.`;
/** Whether a workflow's block reason is the wait for a run limit's acceptance, in either set of words. */
export const isRunLimitBlockReason = (reason: string | undefined): boolean =>
  reason !== undefined && (reason.startsWith(RUN_LIMIT_BLOCK_PREFIX) || RUN_LIMIT_WAITING_PREFIXES.some((prefix) => reason.startsWith(prefix)));
/**
 * The words the workflow blocks with when the approver may not accept the run limit: who has to approve and, only when a request was actually made, that it
 * has been asked for.
 */
export const runLimitBlockText = (runLimitUsd: number, needs: "maintainer" | "admin", asked = true): string =>
  `${RUN_LIMIT_BLOCK_PREFIX}${String(runLimitUsd)}, which needs ${needs === "maintainer" ? "a project maintainer's" : "an admin's"} approval.${asked ? " I've asked for it." : ""}`;

/**
 * The subject a plan's `run_limit` request (the one that resumes coding) keeps its one-open-request slot under: apart from the task's other `run_limit`
 * request, which resumes nothing. The broker makes it, and the task view looks for the open one by it.
 */
export const planRunLimitSubject = (taskId: string): string => `TASK#${taskId}#IMPLEMENT`;


/** The limit on a workflow task's planning phase, before a plan is approved. */
export const DEFAULT_PLANNING_LIMIT_USD = { QUICK: 2, FULL: 6 } as const;


/** Estimates come from the last `ESTIMATE_HISTORY_SIZE` runs once there are `ESTIMATE_MIN_SAMPLES` of them. */
export const ESTIMATE_HISTORY_SIZE = 20;
export const ESTIMATE_MIN_SAMPLES = 5;

