// The nightly run's result route, broker side: `POST /v1/internal/workspaces/{w}/operations/{o}/nightly-result`, the ONE action a nightly run's worker has to report with.
//
// The slot id is not a secret (the scheduler's input names it), so nothing about WHO may record is read from the body. The caller is authenticated the way every operation callback is, and then held to the
// same rules the setup run's callback is held to:
//   - the capability (`nightly-result`) was granted by the broker to the verification operation of a nightly task, and carries the operation's fence (a stale fence is refused before this runs);
//   - the operation is RUNNING, is a task operation in verification mode, and its workspace's task is a `nightly_run` task of the operation's company that is still open: the org and the project come
//     from that task, never from the body;
//   - the result is accepted only for what that task was started to run: the same slot, environment revision, branch and commit, all four. A result for another slot, another revision or another commit,
//     from a worker that holds a valid capability for its own run, is refused and changes nothing.
// Everything else (the lock the slot holds, the clock, the coverage map's digest, the classification and the project's health) is `recordNightlyResultWithHealth`'s own. With `nh` or the test environment
// off, the route answers CALLBACK_FORBIDDEN and nothing is read.
import { NIGHTLY_RUN_PURPOSE, NightlyResultCallbackBodySchema, NightlyResultSchema, agentXError, type NightFailedReason, type OrgId } from "@agentx/contracts";
import { taskKey, taskPointerKey } from "../../developer/task-records.js";
import type { StoreOnly, TestEnvDeps } from "./deps.js";
import { nightlyRunsOn } from "./health-switch.js";
import { recordNightlyResult, releaseNightly, type MapStore, type NightlyRecorded } from "./nightly.js";
import { nightFailedItem } from "./night-status.js";
import type { NightlyTaskFacts } from "./nightly-run.js";

/** The authenticated operation, as the callback route read it. */
export interface NightlyOperation { kind: string; workflowMode?: string | undefined; status: string; workspaceId: string; orgId?: string | undefined }

/** The run an operation belongs to: its task, which must be a nightly task of the operation's company, still open. Undefined for anything else. */
export async function nightlyRunOfOperation(deps: StoreOnly, operation: NightlyOperation): Promise<{ orgId: OrgId; project: string; taskId: string; started: NonNullable<NightlyTaskFacts["nightlyRun"]> } | undefined> {
  if (operation.kind !== "task" || operation.workflowMode !== "CHECKS" || operation.status !== "RUNNING") return undefined;
  const pointer = (await deps.store.get(taskPointerKey(operation.workspaceId))) as { taskId?: unknown } | undefined;
  if (typeof pointer?.taskId !== "string") return undefined;
  const task = (await deps.store.get(taskKey(pointer.taskId))) as (NightlyTaskFacts & { companyId?: string }) | undefined;
  if (task === undefined) return undefined;
  // The hosted product's task rows say `orgId`; this install's say `companyId`: one of them names the company.
  const company = task.orgId ?? task.companyId;
  if (task.purpose !== NIGHTLY_RUN_PURPOSE || task.nightlyRun === undefined || company === undefined || task.workspaceId !== operation.workspaceId || task.closedAt !== undefined) return undefined;
  if (operation.orgId !== undefined && operation.orgId !== company) return undefined;
  return { orgId: company, project: task.project, taskId: task.taskId, started: task.nightlyRun };
}

/** Handles one nightly result. Throws CALLBACK_FORBIDDEN for an operation that is not a running nightly run (or while the nightly switch is off) or a result for anything else than what the run was started to run, CONFIG_INVALID for a body that is not the shape. */
export async function handleNightlyResultCallback(
  deps: TestEnvDeps & { maps: MapStore; /** Told once the baseline is stored (the project health, where it is wired). */ onRecorded?: ((recorded: NightlyRecorded) => Promise<void>) | undefined },
  operation: NightlyOperation,
  rawBody: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ recorded: true; flakyCount: number; failingCount: number } | { recorded: false; failed: NightFailedReason }> {
  if (!nightlyRunsOn(env)) throw agentXError("CALLBACK_FORBIDDEN", "nightly runs are not on");
  const run = await nightlyRunOfOperation(deps, operation);
  if (run === undefined) throw agentXError("CALLBACK_FORBIDDEN", "the nightly callback is limited to a running nightly run");
  const body = NightlyResultCallbackBodySchema.safeParse(rawBody);
  if (!body.success) throw agentXError("CONFIG_INVALID", "the nightly callback body is not the shape");
  if ("failed" in body.data) {
    // The worker says why the night did not finish. It names no slot: the run's own slot, from its task. The row is the same one the operation's end would write (`infra`), and the first word stands. The lock is
    // given back (the day's claim stays: the same-day retry rule decides about a second run). Nothing about the project's health changes.
    const reason = body.data.failed.reason;
    await deps.store.transact([nightFailedItem({ orgId: run.orgId, project: run.project, slotId: run.started.slotId, reason, nowIso: new Date(deps.now()).toISOString() })]);
    await releaseNightly(deps, run.orgId, run.project, run.started.slotId, false);
    return { recorded: false, failed: reason };
  }
  if (!("result" in body.data)) throw agentXError("CONFIG_INVALID", "the nightly callback body is not the shape");
  const result = NightlyResultSchema.safeParse(body.data.result);
  if (!result.success) throw agentXError("CONFIG_INVALID", "the nightly result could not be read");
  const { slotId, envRevision, branch, headSha } = result.data;
  if (slotId !== run.started.slotId || envRevision !== run.started.envRevision || branch !== run.started.branch || headSha !== run.started.headSha) {
    throw agentXError("CALLBACK_FORBIDDEN", "this result is not for what this run was started to run");
  }
  return recordNightlyResult(deps, deps.maps, { orgId: run.orgId, project: run.project, result: result.data, ...(body.data.coverageMap === undefined ? {} : { coverageMap: body.data.coverageMap }) }, deps.onRecorded);
}
