// The task flow's start and cancel, as a wiki build run uses them (W3b): `WikiBuildStarter` over `startTask` with a wiki build request. The task is the caller's own (so the person's access, the admission seam and the open-workspace
// limits apply as for any task), its purpose is `wiki_build`, it is paid by the PROJECT, and the build's pointer and notes are written in the start's own transaction. Nothing of a body reaches the limits or the pins.
import { WIKI_BUILD_PAYER_KIND, agentXError } from "@agentx/contracts";
import type { TaskFlowDeps, TaskStartCaller } from "../task-flow/deps.js";
import { startTask } from "../task-flow/start.js";
import type { WikiBuildStarter } from "./run.js";

export interface WikiBuildStarterInput {
  flow: TaskFlowDeps;
  /** The person who pressed Build, as the routes verified them (the task is theirs). */
  caller: TaskStartCaller;
  /** The task flow's own cancel (a task that is already over is left as it is). */
  cancel(request: { taskId: string; requestId: string }): Promise<void>;
}

export function createWikiBuildStarter(input: WikiBuildStarterInput): WikiBuildStarter {
  return {
    async start(request) {
      // Money: a wiki build is paid by its project and no one else. A request that names another payer starts nothing.
      if (request.payer.kind !== WIKI_BUILD_PAYER_KIND || request.payer.project !== request.project) throw agentXError("CONFIG_INVALID", "the request is not valid");
      const started = await startTask(input.flow, input.caller, { requestId: request.requestId, project: request.project, instructions: request.text, title: `Build the wiki for ${request.project}` }, {
        wikiBuild: {
          wire: { limits: request.limits, pins: request.pins },
          itemsFor: (taskId) => [request.pointerItemFor(taskId), ...(request.notesItemFor(taskId) === undefined ? [] : [request.notesItemFor(taskId)!])],
        },
      });
      return { taskId: started.task.taskId, duplicate: started.duplicate };
    },
    cancel: (request) => input.cancel(request),
  };
}
