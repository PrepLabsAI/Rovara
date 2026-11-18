// Core task web routes (Cloud #188 item 3): which of the old task routes the core serves for a task it owns, with the old routes' own access rules (aws/core-task-rule-routes.ts). Paths and methods only:
// the methods are exactly the old route table's (aws/dev-route-scopes.ts), so nothing new is reachable here.

/** `/v1/dev/tasks/<id>/<rest>` for the People routes, the readers, the events timeline and the plan comments. */
const RULE_PATH = /^\/v1\/dev\/tasks\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(people|people\/candidates|people\/add|people\/role|people\/take-ownership|people\/requests\/[^/]+|readers|readers\/[^/]+|events|comments)$/u;

/** The task id and the rest of a served path with its method, or undefined: not one of these routes. */
export function coreTaskRuleOf(path: string, method: string): { taskId: string; rest: string } | undefined {
  const match = RULE_PATH.exec(path);
  if (match === null) return undefined;
  const taskId = match[1]!, rest = match[2]!;
  const served = rest === "people" || rest === "people/candidates" || rest === "events" || rest === "comments" || rest === "readers" || rest.startsWith("people/requests/") ? method === "GET"
    : rest === "people/add" || rest === "people/role" || rest === "people/take-ownership" ? method === "POST"
      : method === "PUT" || method === "DELETE";
  return served ? { taskId, rest } : undefined;
}
