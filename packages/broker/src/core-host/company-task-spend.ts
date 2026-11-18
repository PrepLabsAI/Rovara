// L4-TSU: what one task has cost, for the flow's `taskSpendUsd` on a hosted root (the broker's and the dispatcher's runtime). Automatic fixing (core/build-step/autofix.ts) reads it before every send back or
// retry and holds it against its per-task dollar cap. Without it the hosted flow read "nothing spent" (`deps.taskSpendUsd === undefined` is 0 there) and the cap never bound.
//
// The figure is the settled cost in this company's own cost ledger (`ORG#<company>#COST#<task>` / `TOTAL`, the row usage booking and the start hold write; admission, the per-run stop and the owner's round cap read
// the same row). Read fresh on every call (a strongly consistent get, nothing kept between calls), for ONE company and ONE task: the key names both, and the row must name both again.
//
// Unknown is never zero. Anything that leaves the figure unreadable or short throws one fixed sentence, which `runAutofix` turns into an ask ("I could not read what this task has spent so far, so I did not act"):
//   no row (every hosted task has one from its start hold, so a missing one says nothing was recorded, not that nothing was spent), a row of another company or task, figures that are not whole numbers,
//   a call with no price (`unpricedEntries`: the total is a floor), a currency other than USD, a task id that is not an id, any fault of the store, and a run of the task whose usage the total does not hold yet:
//   a model run that has not ended or ended without its usage booked, a run kept as an estimate (`usageUnflushed`: its hold's room is kept outside the total), and a coding or review run that SUCCEEDED
//   with no end report booked (the worker may post its result although the flush of its usage was refused; the next attempt would report it). Autofix reads this right after a run's result, which is
//   exactly when a lost or refused usage report leaves the total short.
import { companyScoped, type DocumentStore, type OrgId } from "@agentx/contracts";
import { costPartition } from "../core/cost/ledger.js";
import { readTask, workspaceOperations } from "../core/task-flow/reads.js";
import { locateWorkspace } from "../core/task-flow/workspace-location.js";

/** The one sentence a refused read throws (fixed words: never the task, the company, the figures or the cause). */
export const TASK_SPEND_UNKNOWN = "the task's spend could not be read";

/** Why a read refused, in fixed words, for the host's log. */
export type TaskSpendRefusal = "bad_task_id" | "not_recorded" | "other_owner" | "unreadable_figures" | "unpriced_usage" | "other_currency" | "run_unreported" | "storage_unavailable";

export interface CompanyTaskSpendOptions {
  /** The company's own store (the registry's `storage`): the cost row, the task's record and its runs are read from it. */
  store: DocumentStore;
  companyId: OrgId;
  /** Told, best effort, why a read refused. Fixed words only; a fault in it never reaches the caller. */
  refused?: (reason: TaskSpendRefusal) => void;
}

/** A task id as the engine mints it (a UUID); never a '#', a space or an empty string, which the partition key could not hold apart. */
const TASK_ID = /^[A-Za-z0-9_-]{1,200}$/u;
const whole = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
/** The most runs read for one answer; a task with more is taken as not reported (never a partial read). */
const RUNS_MAX = 50;
/** The steps whose SUCCEEDED run always spent (a coding run and a review run): an end report of theirs must be booked. */
const SPENDING_MODES: ReadonlySet<string> = new Set(["IMPLEMENT", "REVIEW"]);

/** Whether every model run of the task has its usage in the total. False for anything that cannot be read. */
async function runsReported(store: DocumentStore, companyId: OrgId, taskId: string): Promise<boolean> {
  const task = await readTask({ store }, taskId);
  if (task === undefined || task.companyId !== companyId || typeof task.workspaceId !== "string") return false;
  // A workspace that is not this company's (or not there) leaves the runs unknown, not none.
  if (await locateWorkspace({ store, companyId }, task.workspaceId) === undefined) return false;
  const runs = (await workspaceOperations({ store, companyId }, task.workspaceId)).filter((operation) => operation.kind === "task" && operation.workflowMode !== "CHECKS");
  if (runs.length > RUNS_MAX) return false;
  for (const run of runs) {
    // Kept as an estimate: the hold's room is outside the total, so the total is short by it.
    if (run.usageUnflushed === true) return false;
    // A run that has not succeeded (running, lost, failed, stopped) must have its end report; so must a coding or review run that did. (A checkpoint is not an end report.)
    if (run.status === "SUCCEEDED" && !SPENDING_MODES.has(run.workflowMode ?? "")) continue;
    const booked = await store.query({ pk: costPartition(companyId, taskId), sk: { op: "beginsWith", prefix: `ENTRY#usage:${run.id}:` }, limit: 1 });
    if (booked.items.length === 0) return false;
  }
  return true;
}

/** The settled spend of one task of this company, in US dollars. Throws `TASK_SPEND_UNKNOWN` whenever the figure is not known to be complete. */
export function createCompanyTaskSpend(options: CompanyTaskSpendOptions): (taskId: string) => Promise<number> {
  const { store, companyId } = options;
  const refuse = (reason: TaskSpendRefusal): never => {
    // A log that fails (throws, or answers a promise that fails) changes nothing about the answer.
    try { void Promise.resolve(options.refused?.(reason)).catch(() => undefined); } catch { /* ignored */ }
    throw new Error(TASK_SPEND_UNKNOWN);
  };
  return async (taskId) => {
    if (typeof taskId !== "string" || !TASK_ID.test(taskId)) return refuse("bad_task_id");
    let row: Awaited<ReturnType<typeof store.get>>;
    try {
      // Throws for a company id the key scheme cannot hold (a '#' or a space): the same refusal as any fault.
      companyScoped(companyId, "COST");
      row = await store.get({ pk: costPartition(companyId, taskId), sk: "TOTAL" });
    } catch {
      return refuse("storage_unavailable");
    }
    if (row === undefined) return refuse("not_recorded");
    if (row["companyId"] !== companyId || row["taskId"] !== taskId) return refuse("other_owner");
    const { micros, entries, unpricedEntries, currency } = row as { micros?: unknown; entries?: unknown; unpricedEntries?: unknown; currency?: unknown };
    if (!whole(micros) || !whole(entries) || !whole(unpricedEntries)) return refuse("unreadable_figures");
    // A call with no price (or one in another currency) is not in the total: it is a floor, and a floor under a cap is not a figure.
    if (unpricedEntries > 0) return refuse("unpriced_usage");
    if (currency !== undefined && currency !== "USD") return refuse("other_currency");
    // The ledger sets the currency with the first priced entry: dollars with no currency are a row it did not write.
    if (currency === undefined && micros > 0) return refuse("unreadable_figures");
    let reported: boolean;
    try { reported = await runsReported(store, companyId, taskId); } catch { return refuse("storage_unavailable"); }
    if (!reported) return refuse("run_unreported");
    return micros / 1_000_000;
  };
}
