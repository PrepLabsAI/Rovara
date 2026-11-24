// Historical preparations have no SETUP_WATCH. Walk one bounded project-index page per scheduled pass.
import { companyScoped, orgProjectCatalogPk, workspaceProjectIndexValue, WORKSPACE_PROJECT_INDEX, when, type Condition, type StoredDocument } from "@agentx/contracts";
import type { TaskFlowDeps } from "./deps.js";
import { expireStalledCheck, prepareWatchKey, recoverDeadPreparation } from "./prepare-watch.js";
import { readWorkspace } from "./stage-machine.js";
import { log } from "./support.js";

/** Existing SETUP_WATCH family; no workspaceId, so the timed watch sweep ignores this non-time key. */
const recoveryKey = (companyId: string) => ({ pk: companyScoped(companyId, "SETUP_WATCH"), sk: "~RECOVERY" });

/** A cold host resumes; concurrent passes may only repeat a page. Project identity rows remain untouched. */
export async function sweepHistoricalPreparations(deps: TaskFlowDeps, options: { limit?: number }): Promise<void> {
  const pk = orgProjectCatalogPk(deps.companyId);
  const anchor = (await deps.store.query({ pk, sk: { op: "beginsWith", prefix: "PROJECT#" }, limit: 1 })).items[0];
  if (anchor === undefined) return;
  const key = recoveryKey(deps.companyId);
  const checkpoint = await deps.store.get(key);
  const after = checkpoint?.["prepareRecoveryProject"];
  const cursor = checkpoint?.["prepareRecoveryCursor"];
  const projectSk = typeof after === "string" ? after : anchor.sk;
  const next = typeof after === "string" && typeof cursor !== "string"
    ? (await deps.store.query({ pk, sk: { op: "between", low: `${projectSk}\u0000`, high: "PROJECT#\uffff" }, limit: 1 })).items[0]
    : undefined;
  // A completed catalog walk starts at the first project on the next pass.
  if (typeof after === "string" && typeof cursor !== "string" && next === undefined) {
    await deps.store.delete({ key, condition: checkpointFence(checkpoint) });
    return;
  }
  const selected = next?.sk ?? projectSk;
  const page = await deps.store.queryIndex({ index: WORKSPACE_PROJECT_INDEX.name, partition: workspaceProjectIndexValue(deps.companyId, selected.slice("PROJECT#".length)), limit: Math.min(options.limit ?? 50, 50), ...(typeof cursor === "string" ? { cursor } : {}) });
  for (const row of page.items) {
    try { await recoverHistoricalWorkspace(deps, row); }
    catch { log(deps, { event: "task_flow.prepare_recovery_row_failed", workspaceId: row["id"] }); }
  }
  // A poison row is skipped. A losing concurrent pass cannot rewind a successor's checkpoint.
  await deps.store.put({ item: { ...key, companyId: deps.companyId, prepareRecoveryProject: selected, ...(page.cursor === undefined ? {} : { prepareRecoveryCursor: page.cursor }) }, condition: checkpointFence(checkpoint) });
}

function checkpointFence(row: StoredDocument | undefined): Condition {
  if (row === undefined) return when.absent();
  const after = row["prepareRecoveryProject"], cursor = row["prepareRecoveryCursor"];
  return when.and(when.present(), typeof after === "string" ? when.eq("prepareRecoveryProject", after) : when.notExists("prepareRecoveryProject"), typeof cursor === "string" ? when.eq("prepareRecoveryCursor", cursor) : when.notExists("prepareRecoveryCursor"));
}

async function recoverHistoricalWorkspace(deps: TaskFlowDeps, row: StoredDocument): Promise<void> {
  if (typeof row["id"] !== "string") return;
  // An index can lag; use the authoritative, company-bound META rather than its projected status.
  const workspace = await readWorkspace(deps, row["id"]);
  if (workspace?.status !== "PREPARING" || typeof workspace.activeOperationId !== "string") return;
  if (await deps.store.get(prepareWatchKey(deps.companyId, workspace.createdAt, workspace.id)) !== undefined) return;
  if (await recoverDeadPreparation(deps, workspace.id, workspace.activeOperationId)) return;
  // A setup check with no watch row whose machine took its preparation but never answered: past the check's limit it is ended, so it cannot run for ever.
  await expireStalledCheck(deps, workspace.id, workspace.activeOperationId, workspace.createdAt);
}
