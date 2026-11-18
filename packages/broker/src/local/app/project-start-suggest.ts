// Lead 4 J3: the start box's path suggestion on `rovara up`. The same route and the same service as the hosted core (core-host/start-suggest-routes.ts):
//
//   POST /v1/app/projects/{project}/code/suggest    { requestId, text }  ->  { kind, classifier, pick, smallTalk? }
//
// Who: the owner of this install, on the API session (a script token never reaches it), for a project this install has. The classifier is the Ask model path (local/start-router.ts): the install's own key.
// Everything that is not the suggest route goes to `next`.
import { START_SUGGEST_WORDS, AgentXError, START_SUGGESTS_PER_PERSON_PER_HOUR } from "@agentx/contracts";
import type { BrokerRequest, BrokerResponse } from "../../handler.js";
import type { TaskCaller, TaskFlowDeps } from "../../core/task-flow/deps.js";
import { createStartSuggest, createStartSuggestLimiter, type StartRouter } from "../../core/answers/start-suggest.js";
import { developerIdOf } from "../../core/sessions/create.js";
import { createLocalAskModel, type LocalAskModelOptions } from "../ask-model.js";
import { createAskStartRouter } from "../start-router.js";

const ROUTE = /^\/v1\/app\/projects\/([A-Za-z0-9][A-Za-z0-9_.-]{0,127})\/code\/suggest$/u;
const json = (statusCode: number, value: unknown): BrokerResponse => ({ statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(value) });

export interface LocalStartSuggestOptions {
  flow: Pick<TaskFlowDeps, "projects">;
  route?: StartRouter | undefined;
  now: () => number;
  log?: ((entry: Record<string, unknown>) => void) | undefined;
}

export function createLocalStartSuggest(options: LocalStartSuggestOptions): { routes(request: BrokerRequest, caller: TaskCaller): Promise<BrokerResponse | undefined> } {
  const limiter = createStartSuggestLimiter(options.now, START_SUGGESTS_PER_PERSON_PER_HOUR);
  const isOwner = (caller: TaskCaller): boolean => caller.scriptToken === undefined && caller.principal.roles.includes("owner");
  return {
    async routes(request, caller) {
      const match = request.method === "POST" ? ROUTE.exec(request.path.split("?")[0] ?? request.path) : null;
      if (match === null) return undefined;
      try {
        const project = match[1]!;
        let body: unknown;
        try { body = request.body === undefined || request.body === "" ? {} : JSON.parse(request.body) as unknown; } catch { body = undefined; }
        const service = createStartSuggest({
          // A script token, anyone who is not this install's owner, and a project this install does not have all read the same.
          mayAsk: async (_person, name) => isOwner(caller) && (await options.flow.projects.latest(name)) !== undefined,
          route: options.route, now: options.now, log: options.log,
        }, limiter);
        return json(200, await service.suggest({ personId: developerIdOf(caller.principal), project, body }));
      } catch (error) {
        if (error instanceof AgentXError) return json(error.statusCode, { error: { code: error.code, message: error.message.slice(error.code.length + 2) } });
        return json(503, { error: { code: "RUNTIME_UNAVAILABLE", message: START_SUGGEST_WORDS.unavailable } });
      }
    },
  };
}

/** `rovara up`: the suggest route in front of the owner's routes, on the Ask model path (a further instance of it, so the Ask's own wiring is untouched). */
export function withLocalStartSuggest(
  input: Omit<LocalStartSuggestOptions, "route"> & { ask: LocalAskModelOptions },
  next: (request: BrokerRequest, caller: TaskCaller) => Promise<BrokerResponse | undefined>,
): (request: BrokerRequest, caller: TaskCaller) => Promise<BrokerResponse | undefined> {
  const { ask, ...rest } = input;
  const suggest = createLocalStartSuggest({ ...rest, route: createAskStartRouter(createLocalAskModel(ask)) });
  return async (request, caller) => (await suggest.routes(request, caller)) ?? (await next(request, caller));
}
