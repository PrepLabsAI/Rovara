// The task flow's start and cancel, as a wiki build run uses them (W3b): `WikiBuildStarter` over `startTask` with a wiki build request. The task is the caller's own (so the person's access, the admission seam and the open-workspace
// limits apply as for any task), its purpose is `wiki_build`, it is paid by the PROJECT, and the build's pointer and notes are written in the start's own transaction. Nothing of a body reaches the limits or the pins.
import { UPKEEP_ORIGIN, WIKI_BUILD_PAYER_KIND, agentXError, isSystemOwnerId, systemOwnerIdOf } from "@agentx/contracts";
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

/**
 * A PERSON's wiki build starter (Build, Continue, Refresh now). The work origin `nightly` marks upkeep AI for the gateway's upkeep cap (lead 4 N1), so a person's start never carries it: a caller whose origin is
 * `nightly` is refused here, at creation and at every start. The nightly refresh has its own starter, `createUpkeepWikiStarter`.
 */
export function createWikiBuildStarter(input: WikiBuildStarterInput): WikiBuildStarter {
  if (input.caller.origin === UPKEEP_ORIGIN) throw agentXError("CONFIG_INVALID", "the request is not valid");
  return makeStarter(input);
}

/**
 * The nightly refresh's starter (lead 4 N1): the project's SYSTEM OWNER starts it, with the work origin `nightly` set here and nowhere else, so the task's TC-1 token says `src: "nightly"` and the gateway holds its model
 * calls to the project's upkeep cap. The caller must be the system owner of exactly the project it starts (derived from the company and the project, so another project's or a person's id is refused). Everything else
 * is the person's starter's: the project pays, the pointer and notes are written in the start's own transaction.
 */
export function createUpkeepWikiStarter(input: WikiBuildStarterInput): WikiBuildStarter {
  const forced: WikiBuildStarterInput = { ...input, caller: { ...input.caller, origin: UPKEEP_ORIGIN } };
  const inner = makeStarter(forced);
  return {
    start: async (request) => {
      const personId = forced.caller.principal.personId;
      if (!isSystemOwnerId(personId) || personId !== systemOwnerIdOf(forced.caller.principal.companyId, request.project)) throw agentXError("FORBIDDEN", "only a project's own system owner starts its nightly refresh");
      return inner.start(request);
    },
    cancel: (request) => inner.cancel(request),
  };
}

function makeStarter(input: WikiBuildStarterInput): WikiBuildStarter {
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
