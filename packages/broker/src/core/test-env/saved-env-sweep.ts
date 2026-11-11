// Saved project images: settling the end of a rebuild. Every start leaves a marker (`saved-env-rebuild.ts`) listed in the sparse due index; the sweep runs from the install's timer and, for each marker
// whose time has come, looks at what the build became:
//   - the operation made for the job ended (it succeeded, failed, was cancelled or lost), or the job's lease ran out, or the build is older than a day: the BUILD is over. A job that is still the project's current one
//     was never recorded, so it is ended now with a fixed word (`endBuildJob`: a failure with the backoff, or, if the repository moved since the queue, a new job for the heads now), and the build workspace is
//     retired: its machine is terminated through the worker-machines port, the workspace is marked CLOSED and given an expiry, and an operation that was still live is ended;
//   - otherwise the marker is looked at again in ten minutes.
// A workspace whose machine cannot be terminated just now is looked at again; nothing here throws into the sweep.
import { WORKFLOW_DISPATCH_DUE_INDEX, change, when, type DocumentStore, type WorkerMachines } from "@agentx/contracts";
import { operationKey, workspaceKey } from "../task-flow/keys.js";
import { isTerminalStatus } from "../task-flow/results.js";
import { endBuildJob, type SavedEnvDeps } from "./saved-env.js";
import { SAVED_ENV_BUILD_LOOK_MS, SAVED_ENV_BUILD_PARTITION, closeBuildWorkspaceOps, savedEnvBuildDueKey, startMarkerKey } from "./saved-env-markers.js";
import { savedEnvEnabled } from "./saved-env-switch.js";

/** The most markers one pass settles. */
export const SAVED_ENV_SWEEP_LIMIT = 10;
/** A build older than this is over whatever its operation says. */
export const SAVED_ENV_BUILD_MAX_AGE_MS = 24 * 3_600_000;

type Row = Record<string, unknown>;
const defaultLog = (event: string, extra: Record<string, unknown> = {}): void => { console.log(JSON.stringify({ component: "broker", event, ...extra })); };

export interface SavedEnvSweepDeps {
  store: DocumentStore;
  saved: SavedEnvDeps | undefined;
  /** Ends a build workspace's machine. Idempotent. */
  machines: Pick<WorkerMachines, "terminate">;
  log?: (event: string, extra?: Record<string, unknown>) => void;
}

export async function sweepSavedEnvBuilds(deps: SavedEnvSweepDeps, limit: number = SAVED_ENV_SWEEP_LIMIT, env: NodeJS.ProcessEnv = process.env): Promise<unknown> {
  const saved = deps.saved;
  if (saved === undefined || !savedEnvEnabled(env)) return "off";
  const log = deps.log ?? defaultLog;
  const store = deps.store;
  const nowMs = saved.now();
  let settled = 0;
  let waiting = 0;
  let failed = 0;
  const lookAgain = (jobId: string) => store.update({ key: startMarkerKey(jobId), ops: [change.set(WORKFLOW_DISPATCH_DUE_INDEX.sortKey, savedEnvBuildDueKey(nowMs + SAVED_ENV_BUILD_LOOK_MS, jobId))], condition: when.present() });
  try {
    const due = await store.queryIndex({ index: WORKFLOW_DISPATCH_DUE_INDEX.name, partition: SAVED_ENV_BUILD_PARTITION, sort: { op: "between", low: "0", high: `${String(nowMs).padStart(15, "0")}~` }, limit });
    for (const listed of due.items as Row[]) {
      try {
        if (typeof listed["jobId"] !== "string") continue;
        const jobId = listed["jobId"];
        // The index may lag: the marker itself says whether it is still open.
        const marker = (await store.get(startMarkerKey(jobId))) as Row | undefined;
        if (marker === undefined || marker["retiredAt"] !== undefined || typeof marker["orgId"] !== "string" || typeof marker["projectId"] !== "string" || typeof marker["workspaceId"] !== "string" || typeof marker["operationId"] !== "string" || typeof marker["createdAt"] !== "string") continue;
        const ids = { orgId: marker["orgId"], projectId: marker["projectId"] };
        const operation = (await store.get(operationKey(marker["workspaceId"], marker["operationId"]))) as Row | undefined;
        const state = await saved.store.get(ids.orgId, ids.projectId);
        const current = state?.job?.jobId === jobId ? state.job : undefined;
        const operationEnded = operation === undefined || isTerminalStatus(operation["status"] as never);
        const leaseExpired = current !== undefined && Date.parse(current.leaseUntil) <= nowMs;
        const tooOld = nowMs - Date.parse(marker["createdAt"]) > SAVED_ENV_BUILD_MAX_AGE_MS;
        if (!operationEnded && !leaseExpired && !tooOld) {
          await lookAgain(jobId);
          waiting += 1;
          continue;
        }
        // The build is over. The job, if it is still the project's, was never recorded.
        if (current !== undefined) await endBuildJob(saved, ids, jobId, operationEnded ? "operation_failed" : "lease_expired");
        const retired = await retireBuildWorkspace(deps, marker["workspaceId"], marker["operationId"], jobId, nowMs);
        if (retired === "foreign") {
          // The workspace is not the one this job made (its operation names another job, or none): it is left alone and the marker is dropped.
          log("saved_env.marker_dropped", { reason: "workspace_not_the_jobs" });
          await store.delete({ key: startMarkerKey(jobId) });
        } else if (retired === "retired") {
          await store.update({ key: startMarkerKey(jobId), ops: [change.set("retiredAt", new Date(nowMs).toISOString()), change.remove(WORKFLOW_DISPATCH_DUE_INDEX.partitionKey), change.remove(WORKFLOW_DISPATCH_DUE_INDEX.sortKey)], condition: when.present() });
          settled += 1;
        } else {
          await lookAgain(jobId);
          waiting += 1;
        }
      } catch (error) {
        failed += 1;
        log("saved_env.sweep_item_failed", { error: error instanceof Error ? error.name : "unknown" });
      }
    }
  } catch (error) {
    log("saved_env.sweep_failed", { error: error instanceof Error ? error.name : "unknown" });
    return "failed";
  }
  return { settled, waiting, failed };
}

/**
 * Terminates the build workspace's machine, then marks the workspace CLOSED (with an expiry) and ends an operation that was still live. "later" when the machine cannot be terminated just now (the sweep looks
 * again). A workspace that is not there, or already CLOSED, is done.
 * Before anything is touched the workspace's operation must name THIS job (`dispatch.payload.savedEnvBuild.jobId`): a workspace whose operation names another job, or none (or has no record), is not what the marker
 * says it is, and is left alone (`foreign`: the caller drops the marker).
 */
export async function retireBuildWorkspace(deps: Pick<SavedEnvSweepDeps, "store" | "machines" | "log">, workspaceId: string, operationId: string, jobId: string, nowMs: number): Promise<"retired" | "later" | "foreign"> {
  const store = deps.store;
  const log = deps.log ?? defaultLog;
  const item = (await store.get(workspaceKey(workspaceId))) as Row | undefined;
  if (item === undefined) return "retired";
  const linked = (await store.get(operationKey(workspaceId, operationId))) as Row | undefined;
  const linkedJob = ((linked?.["dispatch"] as { payload?: { savedEnvBuild?: { jobId?: unknown } } } | undefined)?.payload?.savedEnvBuild?.jobId);
  if (linkedJob !== jobId) return "foreign";
  if (item["status"] !== "CLOSED") {
    const machine = item["machine"] as { machineId?: unknown } | undefined;
    if (typeof machine?.machineId === "string") {
      try { await deps.machines.terminate(machine.machineId); } catch (error) {
        log("saved_env.workspace_delete_failed", { error: error instanceof Error ? error.name : "unknown" });
        return "later";
      }
    }
    await store.update({ key: workspaceKey(workspaceId), ops: closeBuildWorkspaceOps(nowMs), condition: when.present() });
  }
  // An operation that never reported (the worker was lost) is ended: nothing will report for it now.
  await store.update({
    key: operationKey(workspaceId, operationId),
    ops: [change.set("status", "FAILED"), change.set("updatedAt", new Date(nowMs).toISOString()), change.set("error", "the saved image rebuild ended")],
    condition: when.and(when.present(), when.or(when.eq("status", "ACCEPTED"), when.eq("status", "DISPATCHING"), when.eq("status", "RUNNING"))),
  });
  return "retired";
}
