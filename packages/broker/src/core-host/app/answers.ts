// The owner's answers to Understand's questions: the workflow takes them and Understand runs again with them, in the same commit. One function for the API (`POST /v1/app/sessions/<id>/answers`)
// and the local page's form (lane L12), so both say the same thing and refuse the same things.
import { agentXError, answerIntentQuestions } from "@agentx/contracts";
import type { TaskFlowDeps } from "../../core/task-flow/deps.js";
import { dispatchRowItem } from "../../core/task-flow/dispatch-rows.js";
import { readTask } from "../../core/task-flow/reads.js";
import { commitWorkflow, runDispatchRow } from "../../core/task-flow/stage-machine.js";
import { iso } from "../../core/task-flow/support.js";
import { SURFACE_OF_ANSWER_SOURCE, answerEntriesOf } from "../../core/task-log/entries.js";
import { taskLogItems } from "../../core/task-log/store.js";

export async function answerUnderstandQuestions(
  deps: TaskFlowDeps, input: { taskId: string; round: number; answers: unknown; by: { name: string; personId?: string }; source: "app" | "cli" | "mcp"; expectedRevision?: number },
): Promise<void> {
  const task = await readTask(deps, input.taskId);
  const workflow = task?.workflow;
  if (task === undefined || workflow === undefined) throw agentXError("NOT_FOUND", "There is no such session.");
  if (task.closedAt !== undefined) throw agentXError("CONFIG_INVALID", "This task is closed, so it takes no more answers.");
  const now = iso(deps);
  const next = answerIntentQuestions(workflow, {
    expectedRevision: input.expectedRevision ?? workflow.revision, round: input.round, by: { actorId: workflow.ownerId, name: input.by.name }, source: input.source, answers: input.answers, now,
  });
  // The answers go in the task log in the same commit: what was answered, by whom, from where (the person the broker authenticated and the surface it was given, never a body's word).
  const given = next.intent?.answers.at(-1);
  // The log never stands in the way of the owner's own change: an entry that cannot be made is left out.
  const logged = (() => {
    try {
      return given === undefined ? [] : taskLogItems({
        orgId: task.companyId, taskId: task.taskId,
        entries: answerEntriesOf({ round: given.round, at: now, by: given.by.name, surface: SURFACE_OF_ANSWER_SOURCE[given.source] ?? "web", questions: given.questions ?? [], answers: given.answers }),
      });
    } catch { return []; }
  })();
  if (!(await commitWorkflow(deps, task, next, [dispatchRowItem(deps, task.taskId, next.revision, "UNDERSTAND", now, now, undefined, undefined, undefined, input.by.personId), ...logged]))) throw agentXError("CONFIG_INVALID", "The task changed while you were answering. Read it again.");
  await deps.taskLog?.changed(task.taskId);
  await runDispatchRow(deps, { taskId: task.taskId, workflowRevision: next.revision, kind: "UNDERSTAND" });
}
