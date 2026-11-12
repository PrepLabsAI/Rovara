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
import { fromDocument } from "./records.js";
import { iso, log } from "./support.js";

/** How long a machine stays lost or unhealthy before the operation on it is ended: a machine restarting or a health check failing once is not a lost run. */
export const RUN_LOST_GRACE_SECONDS = 120;
/** The words the task page and the owner read for such an end. */
export const RUN_LOST_MESSAGE = "the worker machine running this step was lost";

/** The machine states in which the worker that was running the operation is not there to finish it. */
const LOST_STATES: ReadonlySet<MachineState> = new Set<MachineState>(["terminated", "stopped", "stopping", "unhealthy"]);
/** The operation statuses a worker is running (a cancel has its own end). */
const RUNNING_STATUSES: ReadonlySet<string> = new Set(["DISPATCHING", "RUNNING"]);

export interface LostRunReport {
  /** Rows read. */
  watched: number;
  /** Operations ended INTERRUPTED. */
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
  return report;
}

async function settleRow(deps: TaskFlowDeps, row: RunWatchRecord, graceMs: number): Promise<"interrupted" | "waiting" | "cleared"> {
  const operation = await readOperation(deps, row.workspaceId, row.operationId);
  // Nothing to watch any more: the operation ended (a result, a cancel, a close), is gone, or was handed to another machine or another hold of the workspace. The row goes, and no other operation is read.
  if (operation === undefined || operation.companyId !== deps.companyId || isTerminalStatus(operation.status) || operation.fence !== row.fence || operation.machineId !== row.machineId) {
    await deps.store.delete({ key: runWatchKey(deps.companyId, row.workspaceId, row.operationId) });
    return "cleared";
  }
  // A cancel asked for ends the operation on its own path.
  if (!RUNNING_STATUSES.has(operation.status)) return "waiting";
  const health = await deps.machines.health(row.machineId).catch(() => undefined);
  // A health check that fails says nothing about the machine: no clock starts and none stops.
  if (health === undefined) return "waiting";
  const key = runWatchKey(deps.companyId, row.workspaceId, row.operationId);
  if (!LOST_STATES.has(health.state)) {
    if (row.unhealthySince !== undefined) await deps.store.update({ key, ops: [change.remove("unhealthySince")], condition: when.eq("unhealthySince", row.unhealthySince) });
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
  await deps.store.delete({ key });
  // It ended some other way between the read and the write (a result got in first): the row goes, and the sweep ended nothing.
  return after.status === "INTERRUPTED" && after.error === RUN_LOST_MESSAGE ? "interrupted" : "cleared";
}
