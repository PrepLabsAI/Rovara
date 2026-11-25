// L4-TSU: what one task has cost, for the flow's `taskSpendUsd` on a hosted root (the broker's and the dispatcher's runtime). Automatic fixing (core/build-step/autofix.ts) reads it before every send back or
// retry and holds it against its per-task dollar cap. Without it the hosted flow read "nothing spent" (`deps.taskSpendUsd === undefined` is 0 there) and the cap never bound.
//
// The figure is the settled cost in this company's own cost ledger (`ORG#<company>#COST#<task>` / `TOTAL`, the row usage booking and the start hold write; admission, the per-run stop and the owner's round cap read
// the same row). Read fresh on every call (a strongly consistent get, nothing kept between calls), for ONE company and ONE task: the key names both, and the row must name both again.
//
// Unknown is never zero. Anything that leaves the figure unreadable or short throws one fixed sentence, which `runAutofix` turns into an ask ("I could not read what this task has spent so far, so I did not act"):
//   no row (every hosted task has one from its start hold, so a missing one says nothing was recorded, not that nothing was spent), a row of another company or task, figures that are not whole numbers,
//   a call with no price (`unpricedEntries`: the total is a floor), a currency other than USD, a task id that is not an id, any fault of the store, and a run of the task whose usage the total does not hold yet:
//   a model run that has not ended or ended without its usage booked, a run kept as an estimate whose estimate is not booked, and a run that SUCCEEDED with no end report booked (the worker may post its
//   result although the flush of its usage was refused; the next attempt would report it). Autofix reads this right after a run's result, which is exactly when a lost or refused usage report leaves the total short.
//
// SPEND-UNREPORTED-RUN: an ENDED run with no usage report is no longer unreadable for good. With a `settle` (the broker's, `unreported-run-settle.ts`) the read first asks it to settle the ended runs that owe
// a report (the gateway's own record, a provable no-call, or an estimate), then reads again; without one (the laptop, a test) such a run still refuses. A run kept as an estimate (`usageUnflushed`) whose estimate is booked
// reads: its hold's room is kept outside the total, so the figure ADDS what the hold kept as an estimate (`keptEstimateMicros`), and a hold that cannot be read refuses (never a silent zero).
import { companyScoped, type DocumentStore, type OrgId, type StoredDocument } from "@agentx/contracts";
import { costPartition } from "../core/cost/ledger.js";
import { companyOfReservation, holdKey } from "../core/cost/holds.js";
import { readTask, workspaceOperations } from "../core/task-flow/reads.js";
import type { OperationRecord, TaskRecord } from "../core/task-flow/records.js";
import { reportsUsage } from "../core/task-flow/money-stop.js";
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
  refused?: (reason: TaskSpendRefusal) => void | Promise<void>;
  /** SPEND-UNREPORTED-RUN: settles the task's ended runs that owe a usage report (`createUnreportedRunSettler`). A fault in it is a refusal like any other, never a thrown raw error. Absent: nothing is settled here. */
  settle?: (taskId: string) => Promise<void>;
}

/** A task id as the engine mints it (a UUID); never a '#', a space or an empty string, which the partition key could not hold apart. */
const TASK_ID = /^[A-Za-z0-9_-]{1,200}$/u;
const whole = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
/** The most runs read for one answer; a task with more is taken as not reported (never a partial read). */
const RUNS_MAX = 50;
/** A run that has ended; one that has not is still spending. */
const ENDED: ReadonlySet<string> = new Set(["SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"]);

/** What a read of the task's runs found: whether it could be read, whether any run is still going, the ended runs that owe a usage report, and whether a run is kept as an estimate. */
export interface RunLedger { readable: boolean; running: boolean; owing: OperationRecord[]; estimated: boolean; task?: TaskRecord }

/**
 * What the task's model runs owe the total. Read BEFORE the total (a usage and the total it adds to are written in one transaction, so a total read after this holds every usage seen here; read the
 * other way round, a usage booked in between would pass with a total that lacks it). `owing`: every ended run (any ended status) that must have an end report booked and has none (a run kept as an estimate
 * owes its estimate entry). Residual, stated plainly: a run that sent several usage events (a review with two reviewers) counts as reported once any of them is booked; the broker holds no count of how many it should have.
 */
export async function readRunLedger(store: DocumentStore, companyId: OrgId, taskId: string): Promise<RunLedger> {
  const unreadable: RunLedger = { readable: false, running: false, owing: [], estimated: false };
  const task = await readTask({ store }, taskId);
  if (task === undefined || task.companyId !== companyId || typeof task.workspaceId !== "string") return unreadable;
  // A workspace that is not this company's (or not there) leaves the runs unknown, not none.
  if (await locateWorkspace({ store, companyId }, task.workspaceId) === undefined) return unreadable;
  const runs = (await workspaceOperations({ store, companyId }, task.workspaceId)).filter((operation) => operation.kind === "task" && operation.workflowMode !== "CHECKS");
  if (runs.length > RUNS_MAX) return unreadable;
  const found: RunLedger = { readable: true, running: false, owing: [], estimated: false, task };
  for (const run of runs) {
    // Still going: it is spending, and a part of its usage may already be booked.
    if (!ENDED.has(run.status)) { found.running = true; continue; }
    // A run that never reached a worker machine spent nothing (the same test as the money stop's `reportsUsage`); every other model run, whatever it ended as and in whatever step, must have its end
    // report booked. A succeeded run is no exception: the worker posts its result even when the broker refused the flush of its usage. A checkpoint is not an end report.
    if (run.status !== "SUCCEEDED" && !reportsUsage(run)) continue;
    const booked = await store.query({ pk: costPartition(companyId, taskId), sk: { op: "beginsWith", prefix: `ENTRY#usage:${run.id}:` }, limit: 1 });
    if (booked.items.length === 0) found.owing.push(run);
    // Kept as an estimate: the hold's room is outside the total, so the figure adds it (`keptEstimateMicros`).
    else if (run.usageUnflushed === true) found.estimated = true;
  }
  return found;
}

/**
 * What the task's own hold kept as an estimate for a run whose usage never arrived (core/cost/holds.ts `closeHold` with `estimated`): in the day, not in the task's total, so a figure for the task adds it.
 * Zero for a task with no hold of this company (nothing was kept for it) and for a hold that was not closed as an estimate. Undefined when the hold cannot be read (gone, or its figure is not a whole number):
 * the figure is then not known, and a read refuses.
 */
async function keptEstimateMicros(store: DocumentStore, companyId: OrgId, task: TaskRecord): Promise<number | undefined> {
  const reservationId = task.admissionReservationId;
  if (reservationId === undefined || companyOfReservation(reservationId) !== companyId) return 0;
  const row = await store.get(holdKey(companyId, reservationId));
  if (row === undefined || row["companyId"] !== companyId || row["reservationId"] !== reservationId) return undefined;
  if (row["estimated"] !== true) return 0;
  const kept = row["keptMicros"];
  return typeof kept === "number" && Number.isSafeInteger(kept) && kept >= 0 ? kept : undefined;
}

/**
 * The task's runs as a read of its spend needs them: read, then (when a `settle` is wired and ended runs owe a report) settled and read once more. A fault is the caller's (`refuse` words it).
 * What it adds on top of the total (`kept`): what the task's own hold kept as an estimate for a run kept as one; undefined when that cannot be read.
 */
async function readyRuns(options: CompanyTaskSpendOptions, taskId: string): Promise<{ ready: false } | { ready: true; kept: number | undefined }> {
  const { store, companyId } = options;
  // Throws for a company id the key scheme cannot hold (a '#' or a space): the same refusal as any fault.
  companyScoped(companyId, "COST");
  let ledger = await readRunLedger(store, companyId, taskId);
  // Ended runs that owe a report are settled (the gateway's own record, a provable no-call, or an estimate), then read again once. A run still going is not settled: it is still spending.
  if (ledger.readable && !ledger.running && ledger.owing.length > 0 && options.settle !== undefined) {
    await options.settle(taskId);
    ledger = await readRunLedger(store, companyId, taskId);
  }
  if (!ledger.readable || ledger.running || ledger.owing.length > 0) return { ready: false };
  return { ready: true, kept: ledger.estimated ? await keptEstimateMicros(store, companyId, ledger.task!) : 0 };
}

/** The figure of a TOTAL row plus what a hold kept as an estimate, in dollars; or the reason it is no figure. */
function figureOf(row: StoredDocument | undefined, companyId: OrgId, taskId: string, kept: number): number | TaskSpendRefusal {
  if (row === undefined) return "not_recorded";
  if (row["companyId"] !== companyId || row["taskId"] !== taskId) return "other_owner";
  const { micros, entries, unpricedEntries, currency } = row as { micros?: unknown; entries?: unknown; unpricedEntries?: unknown; currency?: unknown };
  if (!whole(micros) || !whole(entries) || !whole(unpricedEntries)) return "unreadable_figures";
  // A call with no price (or one in another currency) is not in the total: it is a floor, and a floor under a cap is not a figure.
  if (unpricedEntries > 0) return "unpriced_usage";
  if (currency !== undefined && currency !== "USD") return "other_currency";
  // The ledger sets the currency with the first priced entry: dollars with no currency are a row it did not write.
  if (currency === undefined && micros > 0) return "unreadable_figures";
  return (micros + kept) / 1_000_000;
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
    // The runs first, then the total (see `readRunLedger`). Both throw nothing out: a fault is a refusal.
    let ready: Awaited<ReturnType<typeof readyRuns>>;
    try { ready = await readyRuns(options, taskId); } catch { return refuse("storage_unavailable"); }
    if (!ready.ready) return refuse("run_unreported");
    if (ready.kept === undefined) return refuse("unreadable_figures");
    let row: StoredDocument | undefined;
    try { row = await store.get({ pk: costPartition(companyId, taskId), sk: "TOTAL" }); } catch { return refuse("storage_unavailable"); }
    const figure = figureOf(row, companyId, taskId, ready.kept);
    return typeof figure === "number" ? figure : refuse(figure);
  };
}
