// SPEND-UNREPORTED-RUN (item 1): the broker SETTLES an ended model run that sent no usage report, so a task's spend can always be read.
//
// Why it is needed: a run's spend reaches the broker only through its worker's usage events. A run that ends (any ended status) with no usage booked left its task's spend unknown for good
// (`run_unreported` in core-host/company-task-spend.ts): every plan Approve was refused and no pass ever settled it. The live case (A1-10, journey 13b): every model call failed with no HTTP status, the old
// worker sent nothing, and Approve was answered "This isn't ready to be decided yet" for ever.
//
// The rule, one run at a time, in this order (the three cases the money review decides):
//   (i)   `gateway_record`: the gateway's own record of the run's calls is in the task's ledger (`ENTRY#usage-charge:<run>:...`, the authenticated charge receipts). What the run spent is those entries, which the total
//         already holds: a $0 marker entry (`usage:<run>:settled`) makes the run count as booked and adds nothing. No hold is touched.
//   (ii)  `no_call`: zero ONLY when the run never reached a worker machine (`!reportsUsage`): then no model was ever called for it. Nothing else proves "no call": an event log does not (a SETUP_AGENT, FEEDBACK_REVIEW, REVIEW or
//         WIKI_BUILD run calls models yet logs only plain notes, usage and result, and a refused usage batch stays at the front of the worker's queue so nothing after it is stored while the row count still matches).
//         A proven $0 marker.
//   (iii) `estimate` (LOST-RUN-ACTUAL-SPEND: first `lost-run-actual.ts` asks the gateway for the ACTUAL figure and books it (`gateway_actual`), or waits for it; this is the fallback past the wait, or with no gateway to ask):
//         neither is knowable. ONLY the task's hold room is booked as a MARKED estimate (`keepHoldAsEstimate`: entry `usage:<run>:settled`, the one id every settlement of a run uses, in the task's total, drawn from the hold; the hold then
//         closed) (arch ruling: count what was actually spent, and what admission judged enough for the run; NOT topped up to a fixed estimate, so an estimate alone never reaches the cap). Marked, so
//         LOST-RUN-ACTUAL-SPEND can replace it with the gateway's figure. A task with no hold of its own books a marked $0. A lost run (`usageUnflushed`) takes this same path: nothing is booked for it when it is lost.
//
// When: on the next read of the task's spend (the Approve check, automatic fixing), through `createCompanyTaskSpend`'s `settle`, and only for a run that ended more than a short grace ago (`UNREPORTED_SETTLE_GRACE_MS`):
// a worker whose flush was refused may still send its report after its result, and that report, booked later, is counted exactly on top of a settled $0, and on top of an estimate (which then over-counts, marked as an estimate, never under-counts).
// Idempotent: each case books once per run (the company's once-guard on the entry id, the `usageUnflushed` mark), so a repeat pass does nothing more.
import type { DocumentStore, OrgId } from "@agentx/contracts";
import { costPartition } from "../core/cost/ledger.js";
import { reportsUsage, type MoneyStop, type UnreportedSettlement } from "../core/task-flow/money-stop.js";
import type { OperationRecord, TaskRecord } from "../core/task-flow/records.js";
import { readRunLedger } from "./company-task-spend.js";
import { settleActualFigure, type ActualFigureDeps } from "./lost-run-actual.js";

/** How long after its end a run with no usage report waits before it is settled: a worker that retries its flush may still report. */
export const UNREPORTED_SETTLE_GRACE_MS = 120_000;
export type UnreportedRunCase = UnreportedSettlement | "estimate" | "gateway_actual";
export interface SettledRun { operationId: string; case: UnreportedRunCase }

export interface UnreportedRunSettlerDeps {
  store: DocumentStore;
  companyId: OrgId;
  moneyStop: MoneyStop;
  now: () => Date;
  graceMs?: number;
  /** LOST-RUN-ACTUAL-SPEND: where the actual figure comes from (`lost-run-actual.ts`); both absent: an estimate at once, as before. */
  gatewayCharges?: ActualFigureDeps["gatewayCharges"];
  deferEstimate?: ActualFigureDeps["deferEstimate"];
  log?: (entry: Record<string, unknown>) => void;
}

/** The gateway's own record of the run's calls, as the task's ledger holds it (the charge receipts the gateway authenticated). */
async function hasGatewayRecord(store: DocumentStore, companyId: OrgId, taskId: string, runId: string): Promise<boolean> {
  return (await store.query({ pk: costPartition(companyId, taskId), sk: { op: "beginsWith", prefix: `ENTRY#usage-charge:${runId}:` }, limit: 1 })).items.length > 0;
}

/** What the rule decides for one ended run that owes a usage report: the two known $0 cases, or the estimate (which `settleActualFigure` may turn into the gateway's actual, or a wait). Reads only. */
export async function classifyUnreportedRun(store: DocumentStore, companyId: OrgId, taskId: string, run: OperationRecord): Promise<UnreportedSettlement | "estimate"> {
  if (!reportsUsage(run)) return "no_call";
  if (await hasGatewayRecord(store, companyId, taskId, run.id)) return "gateway_record";
  return "estimate";
}

/** The READ-ONLY count of the tasks the sweep would settle (item 4): per task, whether it is still running, unreadable, or owes reports, and which case each owed run would get. Writes nothing. */
export interface UnreportedCount {
  tasks: number; running: number; unreadable: number; clean: number; stuck: number;
  runs: { gateway_record: number; no_call: number; estimate: number };
}
export async function countUnreportedRuns(store: DocumentStore, companyId: OrgId, taskIds: Iterable<string>): Promise<UnreportedCount> {
  const count: UnreportedCount = { tasks: 0, running: 0, unreadable: 0, clean: 0, stuck: 0, runs: { gateway_record: 0, no_call: 0, estimate: 0 } };
  for (const taskId of taskIds) {
    count.tasks += 1;
    const ledger = await readRunLedger(store, companyId, taskId).catch(() => undefined);
    if (ledger === undefined || !ledger.readable) { count.unreadable += 1; continue; }
    if (ledger.running) { count.running += 1; continue; }
    if (ledger.owing.length === 0) { count.clean += 1; continue; }
    count.stuck += 1;
    for (const run of ledger.owing) count.runs[await classifyUnreportedRun(store, companyId, taskId, run)] += 1;
  }
  return count;
}

/** Whether the run ended long enough ago to be settled. An end time that cannot be read is "not yet": the grace is never skipped for it. */
function pastGrace(run: OperationRecord, now: () => Date, graceMs: number): boolean {
  const endedAt = Date.parse(run.updatedAt);
  return Number.isFinite(endedAt) && now().getTime() - endedAt >= graceMs;
}

/** Settles one ended run that owes a usage report, by the case `classifyUnreportedRun` decides. Answers the case settled, or undefined when this money stop cannot settle it (the next call tries again). */
async function settleOneRun(deps: UnreportedRunSettlerDeps, task: TaskRecord, run: OperationRecord): Promise<UnreportedRunCase | undefined> {
  const taskId = task.taskId;
  const mark = { operationId: run.id, taskId };
  const decided = await classifyUnreportedRun(deps.store, deps.companyId, taskId, run);
  if (decided === "estimate") {
    // The gateway's actual figure when it can be had (a lost run and an unreported run alike), else a wait, else (iii): the hold's room, and only that, booked as a marked estimate.
    const figure = await settleActualFigure({ companyId: deps.companyId, moneyStop: deps.moneyStop, now: deps.now, gatewayCharges: deps.gatewayCharges, deferEstimate: deps.deferEstimate }, task, run);
    if (figure === "wait" || (figure === "estimate" && deps.moneyStop.keepHoldAsEstimate === undefined)) return undefined;
    if (figure === "estimate") await deps.moneyStop.keepHoldAsEstimate!(task.admissionReservationId, mark);
    return figure === "settled" ? "gateway_actual" : "estimate";
  }
  // (i) the gateway's record is in the total already, or (ii) it is provable no call was made: a $0 marker, no hold touched.
  if (deps.moneyStop.settleUnreported === undefined) return undefined;
  await deps.moneyStop.settleUnreported(mark, decided);
  return decided;
}

/**
 * The settler of one company. `settle(taskId)` settles every ended run of the task that owes a usage report and is past the grace, and answers what it settled. A fault is the caller's: nothing is swallowed
 * here (the spend reader turns it into its fixed refusal), and a run not settled this time is settled by the next call.
 */
export function createUnreportedRunSettler(deps: UnreportedRunSettlerDeps): (taskId: string) => Promise<SettledRun[]> {
  const { store, companyId } = deps;
  const graceMs = deps.graceMs ?? UNREPORTED_SETTLE_GRACE_MS;
  const note = (entry: Record<string, unknown>): void => { try { deps.log?.({ component: "task-flow", ...entry }); } catch { /* a log never changes a settlement */ } };
  return async (taskId) => {
    const ledger = await readRunLedger(store, companyId, taskId);
    // A task still running, or one that cannot be read, is settled by nothing here: its spend is still moving or unknown for a reason that is not a missing report.
    if (!ledger.readable || ledger.running || ledger.owing.length === 0 || ledger.task === undefined || ledger.task.companyId !== companyId) return [];
    const task = ledger.task;
    const settled: SettledRun[] = [];
    for (const run of ledger.owing) {
      if (run.companyId !== companyId) continue;
      if (!pastGrace(run, deps.now, graceMs)) continue;
      const outcome = await settleOneRun(deps, task, run);
      if (outcome === undefined) continue;
      note({ event: "task_flow.unreported_run_settled", case: outcome, taskId });
      settled.push({ operationId: run.id, case: outcome });
    }
    return settled;
  };
}
