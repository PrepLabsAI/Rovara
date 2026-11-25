// RD-2.0: the task page's new reads (`GET /v1/dev/tasks/{taskId}/spec|checks|changes|timeline`), mounted ONCE. The route rows and their response schemas are in packages/code-api (task-spec.ts, task-checks.ts,
// task-changes.ts, task-timeline.ts); this file owns the path, the method and the table of handlers, and each lane fills its own handler in its own file (task-spec-routes.ts: RD-2a, task-checks-routes.ts: RD-2b1,
// task-changes-routes.ts: RD-2b2, task-timeline-routes.ts: RD-2c), so lanes never share a file.
//
// WHO MAY READ is decided HERE, once per request, by the one read rule (core/task-flow/read-rule.ts `decideTaskRead`, asked through `context.decide`); a handler is given the decision (`context.decision`: the task, how the
// person is admitted, and whether money and source code may be shown) and never decides access itself, so a handler cannot forget it, and the reads stay out of F2-E's reduced admin view.
//
// FAIL CLOSED until a lane fills its handler: a person the rule admits is answered by the stub with the fixed `ROUTE_NOT_SERVED` refusal (nothing about the task shown); a person the rule refuses gets the missing task's answer,
// and a person the task is shown to but not this part (a share) gets TASK_PART_NOT_SHOWN.
import type { ObjectStorage } from "@agentx/contracts";
import type { TaskCaller } from "../core/task-flow/deps.js";
import type { TaskReadDecision } from "../core/task-flow/read-rule.js";
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
  /** The one read rule's decision for this person and this read, made once by the mount. */
  decision: TaskReadDecision;
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

export async function routeTaskScreen(context: Omit<TaskScreenContext, "taskId" | "decision"> & { decide(read: TaskScreenRead): Promise<TaskReadDecision> }, route: { taskId: string; read: TaskScreenRead }): Promise<BrokerResponse> {
  const { flow, blobs, caller, request } = context;
  const decision = await context.decide(route.read);
  return TASK_SCREEN_HANDLERS[route.read]({ flow, blobs, caller, request, taskId: route.taskId, decision });
}
