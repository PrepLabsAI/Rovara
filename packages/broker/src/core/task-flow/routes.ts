// Lane L6a, task flow core: the task routes, as a pure function over the flow. The HTTP server that carries them (lane L4's `rovara up`)
// authenticates the request through the identity adapter first and passes the principal in; nothing here reads a header or a cookie, so a request
// body can never name who is acting.
import { AgentXError, agentXError } from "@agentx/contracts";
import type { TaskCaller } from "./deps.js";
import type { TaskFlow } from "./flow.js";

export interface TaskRouteRequest {
  method: string;
  path: string;
  body?: string | undefined;
  caller: TaskCaller;
}

export interface TaskRouteResponse {
  status: number;
  body: unknown;
}

const TASKS = "/v1/dev/tasks";

function jsonBody(body: string | undefined): unknown {
  if (body === undefined || body === "") return {};
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw agentXError("CONFIG_INVALID", "the request body is not JSON");
  }
}

/**
 * `POST /v1/dev/tasks` starts a task (201, or 200 for a repeat of an earlier request id), `GET /v1/dev/tasks` lists the caller's tasks,
 * `GET /v1/dev/tasks/<id>` reads one and `POST /v1/dev/tasks/<id>/close` closes one. Undefined for any other path, so a server can try its next router.
 * An error becomes `{ error: { code, message } }` with the error's own status; a fault that is not ours is not described.
 */
export async function handleTaskRoute(flow: TaskFlow, request: TaskRouteRequest): Promise<TaskRouteResponse | undefined> {
  const path = request.path.split("?")[0] ?? request.path;
  if (path !== TASKS && !path.startsWith(`${TASKS}/`)) return undefined;
  try {
    if (path === TASKS && request.method === "POST") {
      const started = await flow.start(request.caller, jsonBody(request.body));
      return { status: started.duplicate ? 200 : 201, body: { task: started.task } };
    }
    if (path === TASKS && request.method === "GET") return { status: 200, body: await flow.list(request.caller) };
    const match = /^\/v1\/dev\/tasks\/([0-9a-f-]{36})(\/close)?$/.exec(path);
    if (match !== null && request.method === "GET" && match[2] === undefined) return { status: 200, body: { task: await flow.get(request.caller, match[1]!) } };
    if (match !== null && request.method === "POST" && match[2] === "/close") return { status: 200, body: { task: await flow.close(request.caller, match[1]!) } };
    throw agentXError("NOT_FOUND", "route not found");
  } catch (error) {
    if (error instanceof AgentXError) return { status: error.statusCode, body: { error: { code: error.code, message: error.message.slice(error.code.length + 2) } } };
    throw error;
  }
}
