// The limit a task's model calls are held to when the install holds a run limit (held by default on a laptop, `ROVARA_RUN_LIMIT=0` turns it off; the hosted product always holds it). Planning (understand, plan, plan check) has an allowance of its own before any plan
// is approved; once a plan carries its estimate, the task may spend the planning allowance plus the run limit in all. What it has spent comes from the cost ledger, so the model proxy is given only what is left.
import { cleanUsd } from "./estimate.js";

/** What planning may spend before a plan has an estimate, by path (a quick task is small). */
export const DEFAULT_PLANNING_LIMIT_USD = { QUICK: 2, FULL: 6 } as const;

export interface LimitedTask {
  runEstimate?: { runLimitUsd: number; stopAtUsd: number } | undefined;
  workflow?: { path?: string } | undefined;
  /** The start asked for a lower run limit: it may only lower. */
  requestedRunLimitUsd?: number | undefined;
}

/** The most the task may spend in all, in dollars. */
export function taskLimitUsd(task: LimitedTask): number {
  const planning = DEFAULT_PLANNING_LIMIT_USD[task.workflow?.path === "QUICK" ? "QUICK" : "FULL"];
  if (task.runEstimate === undefined) return planning;
  const run = task.requestedRunLimitUsd === undefined ? task.runEstimate.stopAtUsd : Math.min(task.runEstimate.stopAtUsd, task.requestedRunLimitUsd);
  return cleanUsd(planning + run);
}

/** What is left of the limit after `spentUsd` (never below nothing). `spentUsd` undefined (the spend is in another currency): nothing is left, so the proxy refuses rather than guess. */
export const remainingUsd = (limitUsd: number, spentUsd: number | undefined): number => (spentUsd === undefined ? 0 : Math.max(0, cleanUsd(limitUsd - spentUsd)));
