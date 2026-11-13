// Task actions (owner decision 198): the owner's moves on a task already running that Code did not have, as one service over the task flow's deps. The laptop's routes (`local/app/routes.ts`) and Cloud's call the
// same functions, so a task of the shared engine can offer them. Each answers the task's view, or throws the refusal (an `AgentXError`) before anything is written.
import type { TaskCaller, TaskFlowDeps } from "./deps.js";
import type { FindingAcceptMethod } from "./finding-accept.js";
import type { TaskActionsOptions } from "./owner-round.js";
import type { TaskView } from "./reads.js";
import { resolveReviewFindings } from "./review-findings.js";
import { sendBackToCoding } from "./send-back.js";

export function createTaskActions(deps: TaskFlowDeps, options: TaskActionsOptions = {}) {
  return {
    /** Send the change back to coding with the owner's instructions (`POST /v1/dev/tasks/{id}/workflow/send-back`). */
    sendBack: (caller: TaskCaller, taskId: string, request: unknown): Promise<TaskView> => sendBackToCoding(deps, options, caller, taskId, request),
    /** Accept (with a reason) or fix each blocking review finding; only the fixes go back to coding (`POST /v1/dev/tasks/{id}/workflow/review-findings`). `via` is how it reached Rovara, recorded with the person for each accept (default `api-token`). */
    resolveFindings: (caller: TaskCaller, taskId: string, request: unknown, via?: FindingAcceptMethod): Promise<TaskView> => resolveReviewFindings(deps, options, caller, taskId, request, via),
  };
}

export type TaskActions = ReturnType<typeof createTaskActions>;
