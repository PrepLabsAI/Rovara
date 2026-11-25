// RD-2a: the task page's spec read (`GET /v1/dev/tasks/{taskId}/spec`; the answer is `TaskSpecReadSchema` in packages/code-api, built by core/task-view/spec.ts).
// The task is read with the task read's OWN rule first (`loadReadableTask`: the company, then the company's access rule, owner, co-owner and the People list's readers): a task that is missing, another company's, or one this person
// may not read answers the one "no such task" refusal, before anything of the task is read. The reads stay out of F2-E's reduced admin view because that rule is the only gate here.
// NOT served: the old "shared with this person" fallback of the task read (`sharedReaderTask` in dev-routes.ts is private to that file). A reader only that rule admits gets the missing task's answer here (fails closed); widening it is
// one change in the mount, not in this file.
import { textReaderOf } from "../core/build-step/plan-input.js";
import { specOf } from "../core/task-view/spec.js";
import { loadReadableTask } from "../core/task-flow/reads.js";
import type { BrokerResponse } from "../handler.js";
import type { TaskScreenContext } from "./task-screen-routes.js";

export async function readTaskSpec(context: TaskScreenContext): Promise<BrokerResponse> {
  const task = await loadReadableTask(context.flow.deps, context.caller, context.taskId);
  const answer = await specOf({ store: context.flow.deps.store, read: textReaderOf(context.blobs) }, task);
  return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(answer) };
}
