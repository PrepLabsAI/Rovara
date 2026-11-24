// The retired SETUP_WATCH, on the core store and result path. Watches include prepares that never reached a machine.
import { companyScoped, when, type TransactItem } from "@agentx/contracts";
import type { TaskFlowDeps } from "./deps.js";
import { readWorkspace } from "./stage-machine.js";
import { readOperation, recordOperationResult, isTerminalStatus } from "./results.js";
import { iso } from "./support.js";
import { workspaceKeys } from "./workspace-location.js";

/** The longest a preparation may run, task or setup check: the same 50 minutes the check's own status reads as failed at (`SETUP_CHECK_STUCK_MS`, setup-agent/check.ts), so the page and the watch agree. */
export const PREPARATION_TIMEOUT_MS = 50 * 60_000;
const DEAD_MESSAGE = "Rovara couldn't start this task: the start request couldn't be queued. Try again.";
const MESSAGE = "setup did not finish within 50 minutes; close this task and start a new one";
/** What a setup check's preparation reads when the watch ends it (a check has no task, so the words are the check's own). */
export const CHECK_STALLED_MESSAGE = "the setup check didn't finish within 50 minutes, so Rovara stopped it";
const CHECK_DEAD_MESSAGE = "Rovara couldn't start this setup check: the start request couldn't be queued. Check again.";
export const prepareWatchKey = (companyId: string, createdAt: string, workspaceId: string) => ({ pk: companyScoped(companyId, "SETUP_WATCH"), sk: `${createdAt}#${workspaceId}` });

/** What a long-limit preparation (the eval health run) reads when the watch ends it. */
const LONG_RUN_MESSAGE = "the run didn't finish within its time limit, so Rovara stopped it";

/**
 * The watch row of a preparation. A task's row names its task; a setup check has none (`taskId` absent), which is how the sweep picks the check's own words. `limitMs` is for a preparation whose own contract
 * runs longer than the default (the eval health run, which measures inside its preparation): the row is ended after that limit instead. A limit under the default is ignored, never shortens the watch.
 */
export function prepareWatchItem(companyId: string, createdAt: string, workspaceId: string, operationId: string, taskId?: string, limitMs?: number): TransactItem {
  return { kind: "put", item: { ...prepareWatchKey(companyId, createdAt, workspaceId), companyId, workspaceId, operationId, ...(taskId === undefined ? {} : { taskId }), ...(limitMs === undefined ? {} : { limitMs }) }, condition: when.absent() };
}

/** How long this row's preparation may run: its own `limitMs` when longer than the default, else the default. */
const limitOf = (row: { [attribute: string]: unknown }): number => (typeof row["limitMs"] === "number" && Number.isFinite(row["limitMs"]) && row["limitMs"] > PREPARATION_TIMEOUT_MS ? row["limitMs"] : PREPARATION_TIMEOUT_MS);

/** The words a watch ends a preparation with: a task's, a check's, or a long-limit run's, for a message that could not be queued or one that never finished. */
function endWords(row: { [attribute: string]: unknown }, dead: boolean): string {
  if (typeof row["taskId"] === "string") return dead ? DEAD_MESSAGE : MESSAGE;
  if (dead) return CHECK_DEAD_MESSAGE;
  return limitOf(row) > PREPARATION_TIMEOUT_MS ? LONG_RUN_MESSAGE : CHECK_STALLED_MESSAGE;
}

export async function sweepPreparations(deps: TaskFlowDeps, options: { limit?: number }): Promise<void> {
  const nowMs = Date.parse(iso(deps));
  const page = await deps.store.query({ pk: companyScoped(deps.companyId, "SETUP_WATCH"), limit: options.limit ?? 50 });
  for (const row of page.items) {
    if (row["companyId"] !== deps.companyId || typeof row["workspaceId"] !== "string" || typeof row["operationId"] !== "string") continue;
    const outbox = await deps.store.get({ pk: companyScoped(deps.companyId, `OUTBOX#${row["operationId"]}`), sk: "OUTBOX" });
    const dead = outbox?.status === "DEAD";
    // The row's key starts with the preparation's creation time; it is overdue only once strictly older than its limit.
    if (!dead && !(Date.parse(row.sk.split("#")[0]!) < nowMs - limitOf(row))) continue;
    if (!await failPreparation(deps, row["workspaceId"], row["operationId"], endWords(row, dead))) {
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

/**
 * A setup check that has no watch row (one started before checks were watched) and was created more than `PREPARATION_TIMEOUT_MS` ago is ended the way the watch ends one. A workspace that is not a check's (no
 * SETUP_CHECK record), or one that is not stuck, is left alone. Returns whether this call ended it.
 */
export async function expireStalledCheck(deps: TaskFlowDeps, workspaceId: string, operationId: string, createdAt: string): Promise<boolean> {
  if (Date.parse(iso(deps)) - Date.parse(createdAt) <= PREPARATION_TIMEOUT_MS) return false;
  const record = await deps.store.get((await workspaceKeys(deps, workspaceId)).row("SETUP_CHECK"));
  if (record === undefined || record["companyId"] !== deps.companyId) return false;
  return failPreparation(deps, workspaceId, operationId, CHECK_STALLED_MESSAGE);
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
