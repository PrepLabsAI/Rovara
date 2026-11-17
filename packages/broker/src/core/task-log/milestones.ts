// What the milestone hook adds to the task log: a `status` entry for each of the task's moments (started, plan ready, pull request opened, merged, closed), the `pr` entry with the pull requests' links, and, when the
// plan waits for review, its `plan_summary`. The milestone rows are written in the transaction of the change that caused them, so this is the retry-safe listener of the same facts: it is told again after a failure,
// and an entry is written once (the key is made from the event). Questions, answers and approvals are not milestones: the code that records them adds their entries to its own transaction (`answers.ts`, the
// stage machine, the decision gate's workflow subject).
import { type CodeMilestone, type DocumentStore, type OrgId, type TaskLogEntry } from "@agentx/contracts";
import type { CodeMilestoneHandler } from "../milestones/milestones.js";
import { taskKey } from "../task-flow/keys.js";
import { planSummaryEntryOf, pullRequestEntryOf, statusEntryOf } from "./entries.js";
import { appendTaskLog } from "./store.js";

/** The handler's name on the milestone hook. */
export const TASK_LOG_HANDLER = "task_log";

/** What the decision card says of the plan waiting now: from the plan itself, never from a surface. */
export interface PlanSummaryFacts { revision: number; needed: string; lines: readonly string[]; risk: string; estimate?: string | undefined }

export interface TaskLogMilestoneDeps {
  store: Pick<DocumentStore, "get" | "put">;
  /** The summary of the plan waiting for review for this company's task, or undefined. Absent, or a failure: the log gets no `plan_summary` (the other entries are written). */
  planSummaryOf?: ((orgId: OrgId, taskId: string) => Promise<PlanSummaryFacts | undefined>) | undefined;
  log?: ((event: string, fields: Record<string, unknown>) => void) | undefined;
  /** The one company this handler serves (hosted: the company whose milestones it is registered on). A milestone that names another company writes nothing. Absent: the install's one company (a laptop). */
  companyId?: OrgId | undefined;
}

/** Writes the entries a milestone calls for. Returns the entries it made (written now or before). Never writes for a task of another company (the milestone names the company and the task's own record must agree). */
export async function recordMilestoneInLog(deps: TaskLogMilestoneDeps, milestone: CodeMilestone): Promise<TaskLogEntry[]> {
  const status = statusEntryOf(milestone);
  if (status === undefined || (deps.companyId !== undefined && milestone.orgId !== deps.companyId)) return [];
  const task = await deps.store.get(taskKey(milestone.taskId));
  if (task === undefined || (task["orgId"] ?? task["companyId"]) !== milestone.orgId) return [];
  const entries: TaskLogEntry[] = [status];
  const pr = milestone.kind === "pr_ready" ? pullRequestEntryOf(milestone) : undefined;
  if (pr !== undefined) entries.push(pr);
  if (milestone.kind === "plan_ready" && deps.planSummaryOf !== undefined) {
    try {
      const facts = await deps.planSummaryOf(milestone.orgId, milestone.taskId);
      const summary = facts === undefined ? undefined : planSummaryEntryOf({ ...facts, at: milestone.at });
      if (summary !== undefined) entries.push(summary);
    } catch (error) {
      deps.log?.("task_log.plan_summary_failed", { taskId: milestone.taskId, error: error instanceof Error ? error.name : "unknown" });
    }
  }
  await appendTaskLog(deps.store, { orgId: milestone.orgId, taskId: milestone.taskId, entries });
  return entries;
}

export function taskLogMilestoneHandler(deps: TaskLogMilestoneDeps): CodeMilestoneHandler {
  return { name: TASK_LOG_HANDLER, async on(milestone) { await recordMilestoneInLog(deps, milestone); } };
}
