// A normal STOP for a setup check. A check is a workspace with no task: every task stop (`POST /v1/dev/tasks/{id}/cancel`, the app's session stop, the admin workspace cancel on a task) reads the task pointer first and
// finds none, so a check that was stuck had no way to be ended by a person. This ends one: its preparation is asked to stop (CANCEL_REQUESTED, so the end reads as a stop the flow asked for), the preparation is
// recorded CANCELLED with plain words, and the flow's own end of a check follows (`closeSetupCheck`: the workspace is CLOSED, its machine is terminated, its machine allowance is given back).
// What the check recorded stays: the operation, its events and the proposal's own rows are not touched; the workspace's volume goes with every closed check's (the reconciler reaps closed volumes).
//
// Who may stop is the CALLER's check (an install administrator with a grant on the project, or a person who MANAGES the project's setup), never this module's. It never touches a workspace that is not a check's
// (no SETUP_CHECK record of this company) or that has a task (a setup RUN, or any task, is stopped by the task routes), and it is idempotent: a check already ended or closed answers `nothingRunning`.
import { change, projectMetaKey, when } from "@agentx/contracts";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import { fromDocument, type OperationRecord, type WorkspaceRecord } from "../task-flow/records.js";
import { isTerminalStatus, recordOperationResult } from "../task-flow/results.js";
import { iso, log } from "../task-flow/support.js";
import { locateWorkspace, workspaceKeys } from "../task-flow/workspace-location.js";
import { setupCheckRecordKey, closeSetupCheck, type SetupCheckMark } from "./check.js";
import { setupApplyKey } from "./apply.js";

/** The words a stopped check's preparation records (and the project page reads as the failing step). */
export const SETUP_CHECK_STOPPED_MESSAGE = "the setup check was stopped before it finished";

/** What is known of a check from its record: the project it belongs to. */
export interface SetupCheckFacts { project: string; workspace: WorkspaceRecord }

/** The check this workspace is, in this company: its record and its workspace, and no task. Undefined for anything else (a task's workspace, another company's, a missing one). */
export async function readSetupCheck(deps: Pick<TaskFlowDeps, "store" | "companyId">, workspaceId: string): Promise<SetupCheckFacts | undefined> {
  const location = await locateWorkspace(deps, workspaceId);
  if (location === undefined) return undefined;
  const record = await deps.store.get(setupCheckRecordKey(deps.companyId, workspaceId));
  if (record === undefined || record["companyId"] !== deps.companyId || typeof record["project"] !== "string") return undefined;
  if (await deps.store.get(location.taskPointerKey()) !== undefined) return undefined;
  const workspace = fromDocument<WorkspaceRecord>(location.workspace);
  return workspace === undefined ? undefined : { project: record["project"], workspace };
}

/**
 * Stops one check. `found: false`: this workspace is not a check (nothing was touched). Otherwise `nothingRunning` says whether there was anything to stop: a check already ended or closed (a repeat) is
 * `true`, and a workspace that was left unclosed after its end is closed here too (the flow's close, idempotent).
 */
export async function stopSetupCheck(deps: TaskFlowDeps, workspaceId: string): Promise<{ found: boolean; nothingRunning: boolean }> {
  const check = await readSetupCheck(deps, workspaceId);
  if (check === undefined) return { found: false, nothingRunning: true };
  const { workspace } = check;
  if (workspace.status === "CLOSED") return { found: true, nothingRunning: true };
  const location = await workspaceKeys(deps, workspaceId);
  const active = workspace.status === "PREPARING" && typeof workspace.activeOperationId === "string" ? fromDocument<OperationRecord>(await deps.store.get(location.operationKey(workspace.activeOperationId))) : undefined;
  if (active === undefined || isTerminalStatus(active.status)) {
    // Nothing runs: the check ended (or its operation is gone) and only its close is left.
    await closeSetupCheck(deps, workspaceId);
    return { found: true, nothingRunning: true };
  }
  // The stop is asked for first, so the result that follows reads as a stop the flow asked for and not as the worker giving up on its own (`normalizedResult`).
  const asked = await deps.store.update({
    key: location.operationKey(active.id),
    ops: [change.set("status", "CANCEL_REQUESTED"), change.set("updatedAt", iso(deps))],
    condition: when.and(when.eq("fence", active.fence), when.not(when.or(when.eq("status", "SUCCEEDED"), when.eq("status", "FAILED"), when.eq("status", "CANCELLED"), when.eq("status", "INTERRUPTED")))),
  });
  if (!asked.applied) {
    // It ended between the read and the ask (its own end closes the check).
    await closeSetupCheck(deps, workspaceId);
    return { found: true, nothingRunning: true };
  }
  // The preparation ends CANCELLED; the flow's end of a check (`onOperationEnded`) closes the workspace and terminates the machine. A close that did not happen there (it never throws into the flow) is tried again here.
  await recordOperationResult(deps, { workspaceId, operationId: active.id, fence: active.fence, status: "CANCELLED", error: SETUP_CHECK_STOPPED_MESSAGE });
  await closeSetupCheck(deps, workspaceId);
  log(deps, { event: "setup_check.stopped", workspaceId, operationId: active.id });
  return { found: true, nothingRunning: false };
}

/**
 * Stops the project's checks that are still running: its own check (the project's `setupCheck` mark) and the candidate check of a waiting proposal. A check of another project named by a stale mark is never stopped
 * (the record's own project must be this one).
 */
export async function stopProjectSetupChecks(deps: TaskFlowDeps, project: string): Promise<{ stopped: number; nothingRunning: boolean }> {
  const marks: Array<SetupCheckMark | undefined> = [
    (await deps.store.get(projectMetaKey(deps.companyId, project)))?.["setupCheck"] as SetupCheckMark | undefined,
    (await deps.store.get(setupApplyKey(deps.companyId, project)))?.["check"] as SetupCheckMark | undefined,
  ];
  const seen = new Set<string>();
  let stopped = 0;
  for (const mark of marks) {
    if (typeof mark?.workspaceId !== "string" || seen.has(mark.workspaceId)) continue;
    seen.add(mark.workspaceId);
    const facts = await readSetupCheck(deps, mark.workspaceId);
    if (facts?.project !== project) continue;
    const result = await stopSetupCheck(deps, mark.workspaceId);
    if (!result.nothingRunning) stopped += 1;
  }
  return { stopped, nothingRunning: stopped === 0 };
}
