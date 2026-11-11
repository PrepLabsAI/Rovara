// What the task flow does when a setup run's operation ends: the broker reads the worker's answer again, keeps the run's result on the task (once), and gives the run's workspace, machine and slot back.
// Idempotent: a repeat of the worker's result runs this again and finds the result kept.
import { change, metaRepositoryOf, when } from "@agentx/contracts";
import { closeLoadedTask } from "../task-flow/close.js";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import type { StepOutcome } from "../task-flow/outcome.js";
import type { OperationRecord, TaskRecord } from "../task-flow/records.js";
import { readTask } from "../task-flow/reads.js";
import { iso, log } from "../task-flow/support.js";
import { taskKey } from "../task-flow/keys.js";
import { recordSetupAgentEnd, type SetupRepositories } from "./agent.js";

/** The project's repositories as the proposal is read against them, from the revision the run started on. */
export async function setupRepositoriesOf(deps: Pick<TaskFlowDeps, "projects">, task: Pick<TaskRecord, "project" | "startingRevision">): Promise<SetupRepositories | undefined> {
  const project = await deps.projects.revision(task.project, task.startingRevision);
  if (project === undefined) return undefined;
  const meta = metaRepositoryOf(project.definition);
  return {
    names: project.definition.repositories.map((repository) => repository.name),
    urls: Object.fromEntries(project.definition.repositories.map((repository) => [repository.name, repository.url])),
    ...(meta === undefined ? {} : { meta: meta.name }),
  };
}

export async function endSetupAgentTask(
  deps: TaskFlowDeps, task: TaskRecord, operation: OperationRecord,
  ended: { status: "SUCCEEDED" | "FAILED" | "CANCELLED" | "INTERRUPTED"; error?: string | undefined; outcome?: StepOutcome | undefined },
): Promise<void> {
  const now = iso(deps);
  // The task is read again: a Stop pressed after the caller read it is on the record, and the stop decides how the run ended.
  const fresh = (await readTask(deps, task.taskId)) ?? task;
  const repositories = (await setupRepositoriesOf(deps, fresh)) ?? { names: [], urls: {} };
  const result = ended.outcome?.kind === "setup-run" ? ended.outcome.result : undefined;
  await recordSetupAgentEnd(deps, fresh, operation, { status: ended.status, result, error: ended.error, repositories }, now);
  // The run is over: its workspace, machine and slot go back. The record of what it learned stays.
  await closeLoadedTask(deps, fresh, fresh.developerId).catch((error: unknown) => log(deps, { event: "setup_agent.close_failed", taskId: task.taskId, error: error instanceof Error ? error.name : "unknown" }));
  await deps.store.update({ key: taskKey(task.taskId), ops: [change.set("updatedAt", iso(deps))], condition: when.present() }).catch(() => undefined);
}
