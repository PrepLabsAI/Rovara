// Saved project images: the two places a rebuild writes an expiry (the store's TTL attribute), kept in one file. Both rows are small bookkeeping, not records anyone needs for long:
//   - the start marker of a job (`SAVED_ENV_BUILD_START#<job>`): one start per job, the ids the sweep needs to settle the end; it expires 30 days after the start;
//   - the build workspace's own record once it is CLOSED: it expires 30 days after it was closed.
import { INDEX_EXPIRY_ATTRIBUTE, WORKFLOW_DISPATCH_DUE_INDEX, change, type DocumentKey, type StoredDocument, type UpdateOp } from "@agentx/contracts";
import { documentOf } from "./deps.js";

/** The partition of the sparse due index that lists the build workspaces whose end has not been settled (`saved-env-sweep.ts`). */
export const SAVED_ENV_BUILD_PARTITION = "SAVED_ENV_BUILD";
/** The first look at a started build, and the gap between looks. */
export const SAVED_ENV_BUILD_LOOK_MS = 10 * 60_000;
/** A start marker, and a closed build workspace, are kept this long (seconds), then the store's expiry removes them. */
export const SAVED_ENV_BOOKKEEPING_TTL_SECONDS = 30 * 86_400;

export const savedEnvBuildDueKey = (atMs: number, jobId: string): string => `${String(Math.max(0, Math.trunc(atMs))).padStart(15, "0")}#${jobId}`;

export const startMarkerKey = (jobId: string): DocumentKey => ({ pk: `SAVED_ENV_BUILD_START#${jobId}`, sk: "START" });

/** The start marker's item. */
export function startMarkerItem(input: { orgId: string; projectId: string; jobId: string; workspaceId: string; operationId: string; createdAt: string; nowMs: number }): StoredDocument {
  return documentOf({
    ...startMarkerKey(input.jobId), entityType: "SAVED_ENV_BUILD_START", orgId: input.orgId, projectId: input.projectId, jobId: input.jobId, workspaceId: input.workspaceId, operationId: input.operationId, createdAt: input.createdAt,
    [WORKFLOW_DISPATCH_DUE_INDEX.partitionKey]: SAVED_ENV_BUILD_PARTITION, [WORKFLOW_DISPATCH_DUE_INDEX.sortKey]: savedEnvBuildDueKey(input.nowMs + SAVED_ENV_BUILD_LOOK_MS, input.jobId),
    [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(input.nowMs / 1_000) + SAVED_ENV_BOOKKEEPING_TTL_SECONDS,
  });
}

export const closedWorkspaceExpiry = (nowMs: number): number => Math.floor(nowMs / 1_000) + SAVED_ENV_BOOKKEEPING_TTL_SECONDS;

/** The changes that close a build workspace and give its record an expiry. */
export function closeBuildWorkspaceOps(nowMs: number): UpdateOp[] {
  const at = new Date(nowMs).toISOString();
  return [change.set("status", "CLOSED"), change.set("closedAt", at), change.set("updatedAt", at), change.set(INDEX_EXPIRY_ATTRIBUTE, closedWorkspaceExpiry(nowMs)), change.remove("activeOperationId")];
}
