// RD-2.0: the task page's new reads (`GET /v1/dev/tasks/{taskId}/spec|checks|changes|timeline`), mounted ONCE. The route rows and their response schemas are in packages/code-api (task-spec.ts, task-checks.ts,
// task-changes.ts, task-timeline.ts); this file owns the path, the method and the table of handlers, and each lane fills its own handler in its own file (task-spec-routes.ts: RD-2a, task-checks-routes.ts: RD-2b1,
// task-changes-routes.ts: RD-2b2, task-timeline-routes.ts: RD-2c), so lanes never share a file.
//
// FAIL CLOSED until a lane fills its handler: every stub answers the fixed `ROUTE_NOT_SERVED` refusal (the same words for every task, nothing read, nothing about the task shown). A lane that fills one MUST read the task with the
// task read's own rule first (`loadReadableTask`, as `GET /v1/dev/tasks/{taskId}` does) so a reader who may not see the task gets the missing task's answer, and the reads stay out of F2-E's reduced admin view.
import type { ObjectStorage } from "@agentx/contracts";
import type { TaskCaller } from "../core/task-flow/deps.js";
import type { TaskFlow } from "../core/task-flow/flow.js";
import type { BrokerRequest, BrokerResponse } from "../handler.js";
import { readTaskChanges } from "./task-changes-routes.js";
import { readTaskChecks } from "./task-checks-routes.js";
import { readTaskSpec } from "./task-spec-routes.js";
import { readTaskTimeline } from "./task-timeline-routes.js";

export type TaskScreenRead = "spec" | "checks" | "changes" | "timeline";

/** What a handler is given: the one company's flow and blob store (as the existing task routes get them), who is asking, and the task and request. */
export interface TaskScreenContext {
  flow: TaskFlow;
  blobs: ObjectStorage;
  caller: TaskCaller;
  taskId: string;
  request: BrokerRequest;
}
export type TaskScreenHandler = (context: TaskScreenContext) => Promise<BrokerResponse>;

const PATH = /^\/v1\/dev\/tasks\/([0-9a-f-]{36})\/(spec|checks|changes|timeline)$/u;

/** The task and which read, when the path and method are one of these reads (GET only); otherwise undefined. */
export function taskScreenRoute(path: string, method: string): { taskId: string; read: TaskScreenRead } | undefined {
  const match = PATH.exec(path);
  return match === null || method !== "GET" ? undefined : { taskId: match[1]!, read: match[2] as TaskScreenRead };
}

/** One handler for each read. A lane replaces its stub's body in its own file; this table does not change. */
export const TASK_SCREEN_HANDLERS: Readonly<Record<TaskScreenRead, TaskScreenHandler>> = {
  spec: readTaskSpec, checks: readTaskChecks, changes: readTaskChanges, timeline: readTaskTimeline,
};

export function routeTaskScreen(context: Omit<TaskScreenContext, "taskId">, route: { taskId: string; read: TaskScreenRead }): Promise<BrokerResponse> {
  return TASK_SCREEN_HANDLERS[route.read]({ ...context, taskId: route.taskId });
}
