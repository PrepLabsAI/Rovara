// The run-lost watchdog. Nothing reads a machine's health after the delivery of an operation to it, so a worker machine that is lost (reaped, stopped under the run, unhealthy for good) left the
// operation DISPATCHING or RUNNING for ever and the task with it. This sweep reads the watch rows of the operations in flight (`run-watch-rows.ts`), asks the machine port how each one's machine is, and
// ends an operation whose machine has been lost or unhealthy for longer than the grace period as INTERRUPTED. It ends it through `recordOperationResult`, the path a worker's own result takes, so the
// task then follows what it already does for an interrupted operation (the step's retry policy and its notices; the reason of such an end reads "run-lost", `build-step/results.ts`).
//
// Fenced and idempotent: an operation ends only at the fence the row names and only while it is DISPATCHING or RUNNING (the result's own condition holds that again at the write), so one that already finished
// is never touched, and neither is any other operation. A sweep repeated finds the row gone (the operation is terminal) and does nothing.
import { AgentXError, change, when, type MachineState } from "@agentx/contracts";
import type { TaskFlowDeps } from "./deps.js";
import { isTerminalStatus, readOperation, recordOperationResult } from "./results.js";
import { runWatchPartition, runWatchKey, type RunWatchRecord } from "./run-watch-rows.js";
import { fromDocument, type OperationRecord } from "./records.js";
import { acceptedCloseForRun } from "./close-recovery-state.js";
import { sweepHistoricalPreparations } from "./prepare-recovery.js";
import { sweepPreparations } from "./prepare-watch.js";
import { iso, log } from "./support.js";
import { endUnflushed, spendStopOverdue, spendStopReason, type SpendStopCode } from "./money-stop.js";
import { endSilentSetupRun } from "./setup-run-watch.js";

/** How long a machine stays lost or unhealthy before the operation on it is ended: a machine restarting or a health check failing once is not a lost run. */
export const RUN_LOST_GRACE_SECONDS = 120;
/** The words the task page and the owner read for such an end. */
export const RUN_LOST_MESSAGE = "the worker machine running this step was lost";

export { SETUP_RUN_SILENT_MESSAGE } from "./setup-run-watch.js";

/** The machine states in which the worker that was running the operation is not there to finish it. */
const LOST_STATES: ReadonlySet<MachineState> = new Set<MachineState>(["terminated", "stopped", "stopping", "unhealthy"]);
/** The operation statuses a worker is running (a cancel has its own end). */
const RUNNING_STATUSES: ReadonlySet<string> = new Set(["DISPATCHING", "RUNNING"]);

export interface LostRunReport {
  /** Rows read. */
  watched: number;
  /** Operations ended INTERRUPTED (and, with a money stop, a spend stop the worker never ended, ended CANCELLED). */
  interrupted: number;
  /** Operations whose machine is lost or unhealthy but not for long enough yet. */
  waiting: number;
  /** Rows removed because their operation ended, moved to another machine or fence, or is gone. */
  cleared: number;
  /** Rows that could not be settled this time (the next sweep tries again). */
  failed: number;
}

/** One pass. Safe to run from a timer and from two processes: every write is fenced on what was read. */
export async function sweepLostRuns(deps: TaskFlowDeps, options: { limit?: number; graceSeconds?: number } = {}): Promise<LostRunReport> {
  await sweepPreparations(deps, options);
  const report: LostRunReport = { watched: 0, interrupted: 0, waiting: 0, cleared: 0, failed: 0 };
  const graceMs = (options.graceSeconds ?? deps.runLostGraceSeconds ?? RUN_LOST_GRACE_SECONDS) * 1_000;
  const page = await deps.store.query({ pk: runWatchPartition(deps.companyId), limit: options.limit ?? 50 });
  for (const item of page.items) {
    const row = fromDocument<RunWatchRecord>(item);
    if (row === undefined || row.entityType !== "WORKFLOW_RUN_WATCH") continue;
    report.watched += 1;
    try {
      const settled = await settleRow(deps, row, graceMs);
      report[settled] += 1;
    } catch (error) {
      report.failed += 1;
      log(deps, { event: "task_flow.run_watch_failed", error: error instanceof AgentXError ? error.code : error instanceof Error ? error.name : "unknown" });
    }
  }
  // Historical repair is best-effort and must never preempt the lost-run / spend-stop backstop.
  await sweepHistoricalPreparations(deps, options).catch(() => { log(deps, { event: "task_flow.prepare_recovery_failed" }); });
  return report;
}

async function settleRow(deps: TaskFlowDeps, row: RunWatchRecord, graceMs: number): Promise<"interrupted" | "waiting" | "cleared"> {
  const operation = await readOperation(deps, row.workspaceId, row.operationId);
  // Nothing to watch any more: the operation ended (a result, a cancel, a close), is gone, or was handed to another machine or another hold of the workspace. The row goes, and no other operation is read.
  if (!matchingWatchedRun(operation, row, deps.companyId)) {
    await deps.store.delete({ key: runWatchKey(deps.companyId, row.workspaceId, row.operationId) });
    return "cleared";
  }
  // The accepted close exclusively owns this run's deadline and monetary decision.
  if (await acceptedCloseForRun(deps, operation) !== undefined) return "waiting";
  // A run stopped at its spending limit whose worker never ended it (money-stop.ts): past the flush wait, its machine is stopped, its usage is taken as lost (marked unflushed; nothing is booked, the hold stays open until the actual figure is in),
  // and its end is recorded CANCELLED, which blocks the step with the reason.
  if (spendStopOverdue(deps, operation)) {
    await deps.machines.stop(row.machineId).catch(() => undefined);
    await endUnflushed(deps, operation);
    await recordOperationResult(deps, { workspaceId: row.workspaceId, operationId: row.operationId, fence: row.fence, status: "CANCELLED", error: spendStopReason(operation.stopReason as SpendStopCode) });
    await deps.store.delete({ key: runWatchKey(deps.companyId, row.workspaceId, row.operationId) });
    return "interrupted";
  }
  // A cancel asked for ends the operation on its own path.
  if (!RUNNING_STATUSES.has(operation.status)) return "waiting";
  // A setup run whose worker is on a machine that is still up but went silent is ended here too (setup-run-watch.ts).
  const silent = await endSilentSetupRun(deps, row, operation);
  if (silent !== undefined) return silent;
  const health = await deps.machines.health(row.machineId).catch(() => undefined);
  // A health check that fails says nothing about the machine: no clock starts and none stops.
  if (health === undefined) return "waiting";
  const key = runWatchKey(deps.companyId, row.workspaceId, row.operationId);
  if (!LOST_STATES.has(health.state)) {
    await clearUnhealthySince(deps, key, row);
    return "waiting";
  }
  const now = iso(deps);
  if (row.unhealthySince === undefined) {
    await deps.store.update({ key, ops: [change.set("unhealthySince", now)], condition: when.and(when.present(), when.notExists("unhealthySince")) });
    return "waiting";
  }
  if (Date.parse(now) - Date.parse(row.unhealthySince) < graceMs) return "waiting";
  // The end, through the worker's own result path: fenced on the operation's fence and refused for one that is already terminal (the result's condition holds it at the write).
  try {
    await recordOperationResult(deps, { workspaceId: row.workspaceId, operationId: row.operationId, fence: row.fence, status: "INTERRUPTED", error: RUN_LOST_MESSAGE });
  } catch (error) {
    if (!(error instanceof AgentXError)) throw error;
    log(deps, { event: "task_flow.run_lost_refused", code: error.code });
  }
  const after = await readOperation(deps, row.workspaceId, row.operationId);
  if (after === undefined || !isTerminalStatus(after.status)) return "waiting";
  // A model run whose worker was lost never sent its usage: on a deployed install it is marked unflushed and settled at its actual figure on the next spend read (money-stop.ts).
  if (after.status === "INTERRUPTED" && after.error === RUN_LOST_MESSAGE) await endUnflushed(deps, after);
  await deps.store.delete({ key });
  // It ended some other way between the read and the write (a result got in first): the row goes, and the sweep ended nothing.
  return after.status === "INTERRUPTED" && after.error === RUN_LOST_MESSAGE ? "interrupted" : "cleared";
}

/** The machine is well again: the clock of its bad spell stops, and a new bad spell starts it from nothing. */
async function clearUnhealthySince(deps: TaskFlowDeps, key: ReturnType<typeof runWatchKey>, row: RunWatchRecord): Promise<void> {
  if (row.unhealthySince !== undefined) await deps.store.update({ key, ops: [change.remove("unhealthySince")], condition: when.eq("unhealthySince", row.unhealthySince) });
}

function matchingWatchedRun(operation: OperationRecord | undefined, row: RunWatchRecord, companyId: string): operation is OperationRecord {
  return operation !== undefined && operation.companyId === companyId && !isTerminalStatus(operation.status) && operation.fence === row.fence && operation.machineId === row.machineId;
}
