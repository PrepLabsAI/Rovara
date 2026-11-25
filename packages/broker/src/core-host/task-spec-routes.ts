// RD-2a: the task page's spec read (`GET /v1/dev/tasks/{taskId}/spec`; the answer is `TaskSpecReadSchema` in packages/code-api, built by core/task-view/spec.ts).
// WHO MAY READ is decided by the mount, once per request, by the one read rule (core/task-flow/read-rule.ts `decideTaskRead`, see task-screen-routes.ts): this handler is given `context.decision` and does no access work.
// A task that is missing, another company's, or one this person may not read answers the one "no such task" refusal; a person the task is shown to as a share answers TASK_PART_NOT_SHOWN (the plan is not shown to
// them): both before this handler runs, so nothing of the task is read for them. The reads stay out of F2-E's reduced admin view because the rule is the only gate here.
import { textReaderOf } from "../core/build-step/plan-input.js";
import { specOf } from "../core/task-view/spec.js";
import type { BrokerResponse } from "../handler.js";
import type { TaskScreenContext } from "./task-screen-routes.js";

export async function readTaskSpec(context: TaskScreenContext): Promise<BrokerResponse> {
  const answer = await specOf({ store: context.flow.deps.store, read: textReaderOf(context.blobs) }, context.decision.task, { paths: context.decision.sourceCode });
  return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(answer) };
}
