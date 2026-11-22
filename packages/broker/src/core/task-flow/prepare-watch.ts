// The retired SETUP_WATCH, on the core store and result path. Watches include prepares that never reached a machine.
import { companyScoped, when, type TransactItem } from "@agentx/contracts";
import type { TaskFlowDeps } from "./deps.js";
import { readWorkspace } from "./stage-machine.js";
import { readOperation, recordOperationResult, isTerminalStatus } from "./results.js";
import { iso } from "./support.js";

const PREPARATION_TIMEOUT_MS = 50 * 60_000;
const DEAD_MESSAGE = "Rovara couldn't start this task: the start request couldn't be queued. Try again.";
const MESSAGE = "setup did not finish within 50 minutes; close this task and start a new one";
export const prepareWatchKey = (companyId: string, createdAt: string, workspaceId: string) => ({ pk: companyScoped(companyId, "SETUP_WATCH"), sk: `${createdAt}#${workspaceId}` });

export function prepareWatchItem(companyId: string, createdAt: string, workspaceId: string, operationId: string, taskId: string): TransactItem {
  return { kind: "put", item: { ...prepareWatchKey(companyId, createdAt, workspaceId), companyId, workspaceId, operationId, taskId }, condition: when.absent() };
}

export async function sweepPreparations(deps: TaskFlowDeps, options: { limit?: number }): Promise<void> {
  const cutoff = new Date(Date.parse(iso(deps)) - PREPARATION_TIMEOUT_MS).toISOString();
  const page = await deps.store.query({ pk: companyScoped(deps.companyId, "SETUP_WATCH"), limit: options.limit ?? 50 });
  for (const row of page.items) {
    if (row["companyId"] !== deps.companyId || typeof row["workspaceId"] !== "string" || typeof row["operationId"] !== "string") continue;
    const outbox = await deps.store.get({ pk: companyScoped(deps.companyId, `OUTBOX#${row["operationId"]}`), sk: "OUTBOX" });
    const dead = outbox?.status === "DEAD";
    if (!dead && row.sk >= cutoff) continue;
    if (!await failPreparation(deps, row["workspaceId"], row["operationId"], dead ? DEAD_MESSAGE : MESSAGE)) {
      await deps.store.delete({ key: { pk: row.pk, sk: row.sk } });
    }
  }
}

/** Internal repair used by the scheduled pre-watch scan; no live outbox or delivered operation may be ended. */
export async function recoverDeadPreparation(deps: TaskFlowDeps, workspaceId: string, operationId: string): Promise<boolean> {
  const outbox = await deps.store.get({ pk: companyScoped(deps.companyId, `OUTBOX#${operationId}`), sk: "OUTBOX" });
  if (outbox !== undefined && outbox.status !== "DEAD") return false;
  const operation = await readOperation(deps, workspaceId, operationId);
  if (operation === undefined) return false;
  const before = outbox === undefined ? new Date(Date.parse(iso(deps)) - PREPARATION_TIMEOUT_MS).toISOString() : "9999-12-31T23:59:59.999Z";
  const result = await recordOperationResult(deps, { workspaceId, operationId, fence: operation.fence, status: "FAILED", error: DEAD_MESSAGE }, { before, outboxStatus: outbox === undefined ? "absent" : "DEAD" });
  return !result.duplicate;
}

async function failPreparation(deps: TaskFlowDeps, workspaceId: string, operationId: string, error: string): Promise<boolean> {
  const workspace = await readWorkspace(deps, workspaceId);
  const operation = await readOperation(deps, workspaceId, operationId);
  if (workspace?.status === "PREPARING" && workspace.activeOperationId === operationId && operation?.kind === "prepare" && operation.fence === workspace.fence && !isTerminalStatus(operation.status)) {
    await recordOperationResult(deps, { workspaceId: operation.workspaceId, operationId: operation.id, fence: operation.fence, status: "FAILED", error });
    return true;
  }
  return false;
}
