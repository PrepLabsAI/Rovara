// L4-resume: resume only the exact Build pause caused by a broken setup, after
// the same project's setup is approved or a person's setup check passes.
import { change, projectMetaKey, queryAll, when } from "@agentx/contracts";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import { readTask } from "../task-flow/reads.js";
import { retryBlockedStep } from "../task-flow/retry.js";
import { setupStateOf } from "./check.js";
import { log } from "../task-flow/support.js";
import { driftTaskKey, isRow, recheckRowKey, setupBrokenTaskWords, type DriftTaskRow, type RecheckRow } from "./recheck-rows.js";
import { setupPartition } from "./keys.js";

export type SetupResumeTrigger =
  | { kind: "approved"; revision: number }
  | { kind: "check_passed"; revision: number; workspaceId: string };

const FIRST_EVENT = "Setup fixed, continuing";

/** Resume eligible tasks in this company/project. The workflow, marker and dispatch intent commit together. */
export async function resumeSetupPausedTasks(deps: TaskFlowDeps, project: string, trigger: SetupResumeTrigger): Promise<number> {
  const latest = await deps.projects.latest(project);
  if (latest === undefined || latest.definition.revision !== trigger.revision) return 0;
  if (trigger.kind === "check_passed") {
    const meta = await deps.store.get(projectMetaKey(deps.companyId, project));
    if (meta?.["setupCheck"] === undefined || (meta["setupCheck"] as { workspaceId?: unknown }).workspaceId !== trigger.workspaceId) return 0;
    if ((await setupStateOf(deps, project, latest.definition)).status !== "ready") return 0;
  }

  const links = await queryAll(deps.store, { pk: setupPartition(deps.companyId, project), sk: { op: "beginsWith", prefix: "DRIFT_TASK#" } });
  let resumed = 0;
  for (const stored of links) {
    if (!isRow(stored, deps.companyId, project, "SETUP_DRIFT_TASK") || stored["state"] !== "pending" || typeof stored["taskId"] !== "string" || typeof stored["recheckKey"] !== "string") continue;
    const link = stored as unknown as DriftTaskRow & { resumedSetupRevision?: number };
    if (link.resumedSetupRevision === trigger.revision) continue;
    const broken = await deps.store.get(recheckRowKey(deps.companyId, project, link.recheckKey));
    if (broken === undefined || !isRow(broken, deps.companyId, project, "SETUP_RECHECK") || broken["state"] !== "broken") continue;
    const recheck = broken as unknown as RecheckRow;
    if (trigger.kind === "approved" ? trigger.revision <= recheck.setupRevision : trigger.revision !== recheck.setupRevision) continue;
    const task = await readTask(deps, link.taskId);
    const workflow = task?.workflow;
    if (task === undefined || task.companyId !== deps.companyId || task.project !== project || task.closedAt !== undefined || task.stopRequest !== undefined
      || workflow?.stage !== "IMPLEMENT" || workflow.state !== "BLOCKED" || workflow.blockReason !== setupBrokenTaskWords(recheck.failedStep ?? "setup")) continue;

    const marker = { kind: "update" as const, key: driftTaskKey(deps.companyId, project, task.taskId), ops: [change.set("resumedSetupRevision", trigger.revision)], condition: when.and(
      when.eq("state", "pending"), when.eq("recheckKey", link.recheckKey), when.not(when.eq("resumedSetupRevision", trigger.revision)),
    ) };
    try {
      await retryBlockedStep(deps, task.taskId, workflow.revision, { expectedBlockReason: workflow.blockReason, extra: [marker], firstEvent: FIRST_EVENT });
      resumed += 1;
    } catch (error) {
      // The committed dispatch row is the recovery path; a resume failure never changes the setup decision.
      log(deps, { event: "setup_resume.skipped", taskId: task.taskId, error: error instanceof Error ? error.name : "unknown" });
    }
  }
  return resumed;
}
