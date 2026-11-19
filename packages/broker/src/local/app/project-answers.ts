// Lead 4 J1: the answer route on `rovara up`. The same route and the same answer service as the hosted core (core-host/answer-routes.ts):
//
//   POST /v1/app/projects/{project}/answers    { requestId, question, threadId?, channel?, context? }  ->  the answer object
//
// Who: the owner of this install, on the API session (a script token never reaches it). The model is the Ask model path (local/ask-model.ts through local/answer-model.ts): the install's own key, one request
// with no tools per turn, made by the broker. The code is the project's repositories on the code hosts the registry holds, at their default-branch heads.
import { ANSWER_WORDS, AgentXError, IMPLICIT_COMPANY_ID, codeRepositoriesOf, type AdapterRegistry, type DocumentStore, type OrgId } from "@agentx/contracts";
import type { BrokerRequest, BrokerResponse } from "../../handler.js";
import type { TaskCaller, TaskFlowDeps } from "../../core/task-flow/deps.js";
import { createAnswerCodeSource, type AnswerRepositoryHandle } from "../../core/answers/code-source.js";
import type { AnswerModel } from "../../core/answers/ports.js";
import { createAnswerService, type AnswerServiceDeps } from "../../core/answers/service.js";
import { developerIdOf } from "../../core/sessions/create.js";
import { createWikiStore } from "../../core/wiki/store.js";
import { codeHostForRecord } from "../../plugins/routing.js";
import { createLocalAskModel, type LocalAskModelOptions } from "../ask-model.js";
import { createLocalAnswerModel } from "../answer-model.js";
import type { ModelPrices } from "../../core/cost/price-table.js";

const ROUTE = /^\/v1\/app\/projects\/([A-Za-z0-9][A-Za-z0-9_.-]{0,127})\/answers$/u;
const json = (statusCode: number, value: unknown): BrokerResponse => ({ statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(value) });

export interface LocalProjectAnswersOptions {
  flow: TaskFlowDeps;
  registry: AdapterRegistry;
  store: DocumentStore;
  companyId?: OrgId | undefined;
  model: AnswerModel;
  /** Lead 4 L4-AK2b: this install's team knowledge briefing for an answer (`LocalLessons.answerBriefing`). Absent: none. */
  briefing?: AnswerServiceDeps["briefing"] | undefined;
  now: () => number;
  log?: ((entry: Record<string, unknown>) => void) | undefined;
}

export interface LocalProjectAnswers { routes(request: BrokerRequest, caller: TaskCaller): Promise<BrokerResponse | undefined> }

export function createLocalProjectAnswers(options: LocalProjectAnswersOptions): LocalProjectAnswers {
  const companyId = options.companyId ?? IMPLICIT_COMPANY_ID;
  const isOwner = (caller: TaskCaller): boolean => caller.scriptToken === undefined && caller.principal.roles.includes("owner");
  return {
    async routes(request, caller) {
      const match = request.method === "POST" ? ROUTE.exec(request.path.split("?")[0] ?? request.path) : null;
      if (match === null) return undefined;
      try {
        // A script token, or anyone who is not this install's owner, reads the same as a project that is not there.
        const project = match[1]!;
        let body: unknown;
        try { body = request.body === undefined || request.body === "" ? {} : JSON.parse(request.body) as unknown; } catch { body = undefined; }
        const service = createAnswerService({
          companyId, store: options.store, wiki: createWikiStore({ store: options.store, companyId, now: options.now }), now: options.now, log: options.log, model: options.model, briefing: options.briefing,
          access: { mayAsk: async () => isOwner(caller) },
          async code(name) {
            const latest = await options.flow.projects.latest(name);
            if (latest === undefined) return undefined;
            const handles: AnswerRepositoryHandle[] = [];
            for (const repository of codeRepositoriesOf(latest.definition)) {
              try {
                handles.push({
                  name: repository.name, defaultBranch: repository.defaultBranch, repository: { url: repository.url }, scope: { orgId: companyId },
                  host: codeHostForRecord(options.registry, repository.host === undefined ? {} : { host: { kind: repository.host.kind } }),
                });
              } catch { /* a repository whose code host is not registered is not readable: left out */ }
            }
            // The project's repositories are all of them, readable or not: a repository whose code host is not registered here is not read, and is still the project's.
            return createAnswerCodeSource(handles, latest.definition.repositories.map((repository) => repository.name));
          },
        });
        return json(200, await service.ask({ personId: developerIdOf(caller.principal), project, body }));
      } catch (error) {
        if (error instanceof AgentXError) return json(error.statusCode, { error: { code: error.code, message: error.message.slice(error.code.length + 2) } });
        return json(503, { error: { code: "RUNTIME_UNAVAILABLE", message: ANSWER_WORDS.unavailable } });
      }
    },
  };
}

/**
 * `rovara up`: the answer route in front of the owner's routes. The model is the Ask model path (a second instance of it, so the Ask's own wiring is untouched) behind the answer model seam.
 * Everything that is not the answer route goes to `next`.
 */
export function withLocalAnswers(
  input: Omit<LocalProjectAnswersOptions, "model" | "store"> & { store: DocumentStore; ask: LocalAskModelOptions; prices: Pick<ModelPrices, "findCap"> },
  next: (request: BrokerRequest, caller: TaskCaller) => Promise<BrokerResponse | undefined>,
): (request: BrokerRequest, caller: TaskCaller) => Promise<BrokerResponse | undefined> {
  const { ask, prices, ...rest } = input;
  const answers = createLocalProjectAnswers({
    ...rest,
    model: createLocalAnswerModel({ answerer: createLocalAskModel(ask), choice: async () => { const picked = await ask.choice(); return picked === undefined ? undefined : { provider: picked.provider, model: picked.model }; }, prices }),
  });
  return async (request, caller) => (await answers.routes(request, caller)) ?? (await next(request, caller));
}
