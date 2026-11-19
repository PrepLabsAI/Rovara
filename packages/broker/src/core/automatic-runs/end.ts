// Ending an automatic run Rovara itself stops. A system owner has no person to press Stop, so a run that cannot go on, or is stuck, must be ended by Rovara, or it keeps the project's automatic slot for ever.
// Every started run is WATCHED (a row sorted by when it started); the sweep ends a run older than `AUTOMATIC_RUN_MAX_MS` through the host's `AutomaticTasks` seam and records the end once.
import { AUTOMATIC_RUN_MAX_MS, AutomaticJobSchema, INDEX_EXPIRY_ATTRIBUTE, OrgIdSchema, projectPk, queryAll, type AutomaticRunEndReason } from "@agentx/contracts";
import { iso, putRow, deleteRow, type Table } from "../automation/kit.js";
import { eventIdOf, type AutomaticRunsDeps } from "./cap.js";

/** Where each started automatic run is watched until its slot is back: sorted by when it started. Install-wide, like Cloud's. */
export const AUTOMATIC_RUN_WATCH_PK = "AUTOMATIC_RUN_WATCH";
export const automaticRunWatchKey = (startedAt: string, taskId: string) => ({ pk: AUTOMATIC_RUN_WATCH_PK, sk: `${startedAt}#${taskId}` });
const WATCH_TTL_MS = 14 * 86_400_000;
const WATCH_PAGE = 100;
/** The most one pass of the sweep takes. */
export const AUTOMATIC_RUN_SWEEP_SLICE_MS = 5_000;

export interface AutomaticRunWatch { pk: string; sk: string; orgId: string; project: string; job: string; taskId: string; startedAt: string }

/** The watch of a run that started (a write that stands if it is there already). Throws on a fault; the caller logs it. */
export async function putAutomaticRunWatch(deps: Table, input: { orgId: string; project: string; job: string; taskId: string; startedAt: string }): Promise<void> {
  const { orgId, project, job, taskId, startedAt } = input;
  await deps.store.transact([putRow(automaticRunWatchKey(startedAt, taskId), "AUTOMATIC_RUN_WATCH", { orgId, project, job, taskId, startedAt, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor((deps.now() + WATCH_TTL_MS) / 1000) })]);
}

/** What the sweep needs of the host's tasks. */
export interface AutomaticTasks {
  /** Where a task stands: `ended` once it has an end; `released` once its workspace and slot are back; undefined when the task is gone. */
  read(taskId: string): Promise<{ ended: boolean; released: boolean } | undefined>;
  /** Ends the task (cancels what runs for it, best effort) so it releases. The first end stands. True when this call ended it. */
  end(taskId: string, reason: AutomaticRunEndReason): Promise<boolean>;
}

export interface AutomaticRunSweepDependencies extends AutomaticRunsDeps {
  tasks: AutomaticTasks;
  /** How long the pass may take in all (it stops between runs once this is used). */
  budgetMs?: number;
  log?: (entry: Record<string, unknown>) => void;
}

export interface AutomaticRunSweepReport { ended: number; audited: number; watching: number; dropped: number; stoppedForTime?: true }

/** The session sweep's job for automatic runs: ends a run past its time, drops the watch of a run whose slot is back, and writes the audit of an end Rovara made, once. */
export async function sweepAutomaticRuns(deps: AutomaticRunSweepDependencies): Promise<AutomaticRunSweepReport> {
  const log = deps.log ?? (() => undefined);
  const report: AutomaticRunSweepReport = { ended: 0, audited: 0, watching: 0, dropped: 0 };
  const startedAt = deps.now();
  const budgetMs = Math.min(deps.budgetMs ?? AUTOMATIC_RUN_SWEEP_SLICE_MS, AUTOMATIC_RUN_SWEEP_SLICE_MS);
  const page = (await queryAll(deps.store, { pk: AUTOMATIC_RUN_WATCH_PK, limit: WATCH_PAGE })).slice(0, WATCH_PAGE) as unknown as AutomaticRunWatch[];
  for (const watch of page) {
    if (deps.now() - startedAt >= budgetMs) { report.stoppedForTime = true; break; }
    try {
      const task = await deps.tasks.read(watch.taskId);
      if (task === undefined) { await dropWatch(deps, watch); report.dropped += 1; continue; }
      if (!task.ended && deps.now() - Date.parse(watch.startedAt) > AUTOMATIC_RUN_MAX_MS) {
        if (await deps.tasks.end(watch.taskId, "too_old")) {
          report.ended += 1;
          if (await auditEnd(deps, watch, "too_old")) report.audited += 1;
        }
      }
      const fresh = await deps.tasks.read(watch.taskId);
      // The slot is back when the task is released (or gone): the watch has done its job.
      if (fresh === undefined || fresh.released) { await dropWatch(deps, watch); report.dropped += 1; } else report.watching += 1;
    } catch (error) {
      log({ event: "automatic_run.sweep_item_failed", taskId: watch.taskId, error: error instanceof Error ? error.name : "unknown" });
      report.watching += 1;
    }
  }
  return report;
}

const dropWatch = async (deps: Table, watch: AutomaticRunWatch): Promise<void> => {
  await deps.store.transact([deleteRow({ pk: watch.pk, sk: watch.sk })]);
};

/** The audit of an end Rovara made, once per task (a marker in the project's partition). True when this call wrote it. */
async function auditEnd(deps: AutomaticRunSweepDependencies, watch: AutomaticRunWatch, reason: AutomaticRunEndReason): Promise<boolean> {
  const org = OrgIdSchema.safeParse(watch.orgId);
  const job = AutomaticJobSchema.safeParse(watch.job);
  if (!org.success || !job.success) return false;
  const at = iso(deps);
  const event = deps.audit.stage({ eventId: eventIdOf("automatic-run-ended", watch.taskId), companyId: deps.companyId, at, actor: { type: "system", id: "rovara" }, action: "automatic_run.ended", subject: { type: "project", id: watch.project }, details: { job: job.data, reason } });
  const marker = putRow({ pk: projectPk(org.data, watch.project), sk: `AUTOMATIC_RUNS#ENDED#${watch.taskId}` }, "AUTOMATIC_RUN_ENDED", { orgId: org.data, project: watch.project, job: job.data, reason, at, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor((deps.now() + 62 * 86_400_000) / 1000) });
  try {
    const result = await deps.store.transact([marker, ...event]);
    return result.applied;
  } catch (error) {
    deps.log?.({ event: "automatic_run.end_audit_failed", taskId: watch.taskId, error: error instanceof Error ? error.name : "unknown" });
    return false;
  }
}
