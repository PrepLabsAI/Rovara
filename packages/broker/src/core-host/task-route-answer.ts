// D1-1 (old-engine removal, permissions piece): the core's own answer to a developer task route for a task it owns, when it may not show the task to this caller.
//
// Until D1-1 the broker's developer route turned the core's 404 and 401, and a route the core does not serve, into "no task <id> of yours" with ITS OWN words (the old workflow
// route's `answerAsMissing`). The words were right and the owner of the answer was wrong: after the old routes go, the core must be the one that says them. This module is that
// answer. It holds the words (the one place: the old route's branch for a task that is not the core's reads them from here too) and the rule:
//   - the core's 404 or 401 (another company, a colleague who may not see the task, a person with no company, a caller its mapping does not know, a script token) is a missing task's answer;
//   - a route the core does not serve is `NOT_ON_THE_CORE_YET` for a person its own task read shows the task to, and a missing task's answer for anyone else;
//   - every other answer is the core's, untouched.
// Cloud matches these sentences exactly (404 TASK_NOT_FOUND, `NOT_ON_THE_CORE_YET`) and rewrites two phrases of Code's words by regex (`task-words.ts`, packages/ui in Cloud:
// " (in the task's Slack thread or on the task page)" and " in the thread."); none of the words here contains either, and `tests/unit/core-task-route-answer.test.ts` checks that.
import { agentXError } from "@agentx/contracts";
import type { BrokerRequest, BrokerResponse } from "../handler.js";
import { NOT_ON_THE_CORE_YET } from "./dev-routes.js";

const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** What a missing task is told, for every task route: the words `loadOwnedTask` of the old developer routes always used. A malformed ID is never echoed back (it could be long or carry markup). */
export function missingTaskWords(taskId: string): string {
  return TASK_ID.test(taskId) ? `no task ${taskId} of yours` : "that is not a task ID of yours";
}

const answerOf = (statusCode: number, code: string, message: string): BrokerResponse => ({ statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: { code, message } }) });

/** The answer for a task this caller may not see, or that does not exist: TASK_NOT_FOUND (404) in `missingTaskWords`. */
export function missingTaskAnswer(taskId: string): BrokerResponse {
  const words = missingTaskWords(taskId);
  return answerOf(agentXError("TASK_NOT_FOUND", words).statusCode, "TASK_NOT_FOUND", words);
}

/** The core's route as an entry holds it: its answer, or `undefined` for a request the core does not serve. */
export type CoreTaskRouteOf<Caller> = (request: BrokerRequest, caller: Caller) => Promise<BrokerResponse | undefined>;

/**
 * The answer to a developer task route for `taskId` (a task the core owns): always an answer, never `undefined`. `route` is the core's route for the deployment (everything wrapped
 * around it included), asked as this caller.
 */
export async function answerTaskRoute<Caller>(route: CoreTaskRouteOf<Caller>, request: BrokerRequest, caller: Caller, taskId: string): Promise<BrokerResponse> {
  const answer = await route(request, caller);
  // The broker has already signed the caller in: a 401 or 404 from the core means only "not the core's to show this caller", which is a missing task's answer.
  if (answer !== undefined) return answer.statusCode === 404 || answer.statusCode === 401 ? missingTaskAnswer(taskId) : answer;
  if (request.method === "GET" && request.path.split("?")[0] === `/v1/dev/tasks/${taskId}`) return missingTaskAnswer(taskId);
  // The core does not serve this route: someone its own task read shows the task to is told so; anyone else is told what a missing task is told.
  const read = await route({ method: "GET", path: `/v1/dev/tasks/${taskId}`, headers: {}, ...(request.requestId === undefined ? {} : { requestId: request.requestId }) }, caller);
  return read?.statusCode === 200 ? answerOf(404, "NOT_FOUND", NOT_ON_THE_CORE_YET) : missingTaskAnswer(taskId);
}
