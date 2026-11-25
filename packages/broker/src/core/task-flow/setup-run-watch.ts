// The run-lost watchdog's rule for a SETUP run (setup-run-hang, prod P1): the page already reads a run whose worker went silent as stopped (`setupRunGone`, the one rule), but its operation stayed RUNNING, so the
// project stayed "running" and its hold stayed open. A setup run on a machine that is still up (so the machine-health rule never fires) is ended INTERRUPTED through the worker's own result path, and its unreported
// usage is marked unflushed like a lost run's (`endUnflushed`) and settled at its actual figure. Fenced and idempotent exactly as `settleRow`'s own end.
import { AgentXError, effectiveSetupAgentLimits } from "@agentx/contracts";
import type { TaskFlowDeps } from "./deps.js";
import type { OperationRecord } from "./records.js";
import { isTerminalStatus, readOperation, recordOperationResult } from "./results.js";
import { runWatchKey, type RunWatchRecord } from "./run-watch-rows.js";
import { endUnflushed } from "./money-stop.js";
import { iso, log } from "./support.js";
import { workspaceKeys } from "./workspace-location.js";
import { taskKey } from "./keys.js";
import { setupRunGone } from "../setup-agent/agent.js";
import { setupAgentKey } from "../setup-agent/keys.js";

/** The words the owner reads when a setup run's worker went silent on a machine that is still up (the page says "stopped before it finished" from the same rule). */
export const SETUP_RUN_SILENT_MESSAGE = "the setup run's worker stopped reporting";

/** Ends a running setup operation whose worker went silent; undefined for any other operation or a run that is still talking (the caller goes on to the machine's health). */
export async function endSilentSetupRun(deps: TaskFlowDeps, row: RunWatchRecord, operation: OperationRecord): Promise<"interrupted" | "cleared" | "waiting" | undefined> {
  if (operation.workflowMode !== "SETUP_AGENT" || !(await setupWorkerSilent(deps, operation))) return undefined;
  try {
    await recordOperationResult(deps, { workspaceId: row.workspaceId, operationId: row.operationId, fence: row.fence, status: "INTERRUPTED", error: SETUP_RUN_SILENT_MESSAGE });
  } catch (error) {
    if (!(error instanceof AgentXError)) throw error;
    log(deps, { event: "task_flow.run_lost_refused", code: error.code });
  }
  const after = await readOperation(deps, row.workspaceId, row.operationId);
  if (after === undefined || !isTerminalStatus(after.status)) return "waiting";
  const ended = after.status === "INTERRUPTED" && after.error === SETUP_RUN_SILENT_MESSAGE;
  if (ended) await endUnflushed(deps, after);
  await deps.store.delete({ key: runWatchKey(deps.companyId, row.workspaceId, row.operationId) });
  return ended ? "interrupted" : "cleared";
}

/** Whether the setup run this operation belongs to reads as gone (`setupRunGone`): its task's last word from the worker, its start (the delivery), and the limits the run began with. A row that cannot be read is not gone. */
async function setupWorkerSilent(deps: TaskFlowDeps, operation: OperationRecord): Promise<boolean> {
  const taskId = (await deps.store.get((await workspaceKeys({ store: deps.store, companyId: operation.companyId }, operation.workspaceId)).taskPointerKey()))?.["taskId"];
  if (typeof taskId !== "string") return false;
  const task = await deps.store.get(taskKey(taskId));
  if (task === undefined || task["purpose"] !== "setup_agent" || task["closedAt"] !== undefined || typeof task["project"] !== "string") return false;
  const pointer = await deps.store.get(setupAgentKey(deps.companyId, task["project"]));
  const startedAt = operation.deliveredAt ?? operation.createdAt;
  return setupRunGone({ startedAt: typeof startedAt === "string" ? startedAt : undefined, seenAt: task["setupAgentSeenAt"], now: Date.parse(iso(deps)), limits: effectiveSetupAgentLimits(pointer?.["taskId"] === taskId ? pointer["limits"] : undefined) });
}
