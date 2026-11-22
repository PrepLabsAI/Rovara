// The retired SETUP_WATCH, on the core store and result path. Watches include prepares that never reached a machine.
import { companyScoped, when, type TransactItem } from "@agentx/contracts";
import type { TaskFlowDeps } from "./deps.js";
import { readWorkspace } from "./stage-machine.js";
import { readOperation, recordOperationResult, isTerminalStatus } from "./results.js";
import { iso } from "./support.js";

const TIMEOUT_MS = 50 * 60_000;
const MESSAGE = "setup did not finish within 50 minutes; close this task and start a new one";
export const prepareWatchKey = (companyId: string, createdAt: string, workspaceId: string) => ({ pk: companyScoped(companyId, "SETUP_WATCH"), sk: `${createdAt}#${workspaceId}` });

export function prepareWatchItem(companyId: string, createdAt: string, workspaceId: string, operationId: string, taskId: string): TransactItem {
  return { kind: "put", item: { ...prepareWatchKey(companyId, createdAt, workspaceId), companyId, workspaceId, operationId, taskId }, condition: when.absent() };
}

export async function sweepPreparations(deps: TaskFlowDeps, options: { limit?: number }): Promise<void> {
  const cutoff = new Date(Date.parse(iso(deps)) - TIMEOUT_MS).toISOString();
  const page = await deps.store.query({ pk: companyScoped(deps.companyId, "SETUP_WATCH"), sk: { op: "lt", value: cutoff }, limit: options.limit ?? 50 });
  for (const row of page.items) {
    if (row["companyId"] !== deps.companyId || typeof row["workspaceId"] !== "string" || typeof row["operationId"] !== "string") continue;
    const workspace = await readWorkspace(deps, row["workspaceId"]);
    const operation = await readOperation(deps, row["workspaceId"], row["operationId"]);
    if (workspace?.status === "PREPARING" && workspace.activeOperationId === row["operationId"] && operation?.kind === "prepare" && operation.fence === workspace.fence && !isTerminalStatus(operation.status)) {
      await recordOperationResult(deps, { workspaceId: operation.workspaceId, operationId: operation.id, fence: operation.fence, status: "FAILED", error: MESSAGE });
    } else {
      await deps.store.delete({ key: { pk: row.pk, sk: row.sk } });
    }
  }
}
