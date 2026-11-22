import { refreshSessionSummary } from "../sessions/summary.js";
import { developerIdOf } from "../sessions/create.js";
import { costPartition } from "../cost/ledger.js";
import type { TaskFlowDeps } from "./deps.js";
import type { TaskRecord } from "./records.js";

/** Closed facts only: no workflow/follower hooks run during recovery. The ordinary projector can catch up cost later. */
export async function projectClosedSession(deps: TaskFlowDeps, task: TaskRecord): Promise<void> {
  if (task.sessionId === undefined || task.closedAt === undefined) return;
  await refreshSessionSummary({
    store: deps.store,
    facts: { async read(companyId, taskId) {
      if (companyId !== deps.companyId || taskId !== task.taskId) return undefined;
      return { companyId, taskId, project: task.project, ownerDeveloperId: developerIdOf({ provider: task.provider, personId: task.developerId }), closedAt: task.closedAt, endedAt: task.closedAt, ...(task.workflow === undefined ? {} : { workflow: task.workflow }), runStatus: "IDLE", updatedAt: task.updatedAt };
    } },
    cost: { async costUsd(companyId, taskId) {
      const total = await deps.store.get({ pk: costPartition(companyId, taskId), sk: "TOTAL" });
      return typeof total?.["micros"] === "number" ? total["micros"] / 1_000_000 : 0;
    } },
    ...(deps.now === undefined ? {} : { now: deps.now }),
  }, deps.companyId, task.sessionId);
}
