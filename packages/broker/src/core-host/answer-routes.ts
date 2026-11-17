// Lead 4 J1 (DEC 254z-amend): the ONE route the doors (Slack, Linear, the web app, `agentx mcp`) call to get an answer, on the deployed developer API, AS the signed-in person:
//
//   POST /v1/app/projects/{project}/answers    { requestId, question, threadId?, channel?, context? }  ->  the answer object (contracts/answers.ts)
//
// Rules:
//  - The company is the caller's LIVE membership (the dev routes check it and mount that company's runtime); the wiki store, thread rows, counters and the code source are that company's and that project's only.
//  - Who asks: any role on the project (a company owner or admin, or a project grant, a viewer too), read live. Anyone else, a project the company does not have, a malformed name and another company's project
//    all get the same 404 "project not found". The role is read again before the answer is returned or stored.
//  - A script token never reaches this route (APP_ROUTES `requires: "full"`); `wiki_ask` for MCP (M1) brings its own permission.
//  - The model is the company's answers purpose through the gateway (L4-E). Until that is wired the deployment passes none, and the answer is the fixed "answers are not set up here yet" outcome.
//  - Refusals are fixed words; nothing a caller sent is echoed, and a fault is a fixed 503.
import { ANSWER_FEEDBACK_WORDS, ANSWER_WORDS, AgentXError, NotRightBodySchema, NotRightResponseSchema, WikiIdSchema, WikiProjectSchema, agentXError, type DocumentStore, type OrgId } from "@agentx/contracts";
import type { BrokerRequest, BrokerResponse } from "../handler.js";
import { pressNotRight } from "../core/answers/feedback.js";
import { createAnswerService } from "../core/answers/service.js";
import { createAnswerCodeSource, type AnswerRepositoryHandle } from "../core/answers/code-source.js";
import type { AnswerModel } from "../core/answers/ports.js";
import { createWikiStore } from "../core/wiki/store.js";
import type { SetupRunStanding } from "./setup-run-routes.js";

export interface HostedAnswersWiring {
  /** The person's standing on the project in THIS company, read live. Throws when it cannot be read. */
  standing(personId: string, companyId: OrgId, project: string): Promise<SetupRunStanding>;
  /**
   * The project's code repositories with the code host each lives on (`handles`), and the names of EVERY repository the project has (`names`, which decides what left the project), or undefined when the
   * company has no such project. Throws when it cannot be read, or when a repository's code host cannot be resolved (the whole answer is then unavailable, never a shorter list).
   */
  repositories(companyId: OrgId, project: string): Promise<{ handles: readonly AnswerRepositoryHandle[]; names: readonly string[] } | undefined>;
  /** The company's answers model through the gateway. Absent (L4-E not wired, or the company has none): answers are not set up here. */
  model?: ((companyId: OrgId) => AnswerModel | undefined) | undefined;
}

export interface HostedAnswersInput {
  request: BrokerRequest;
  /** The request's path without its query. */
  path: string;
  personId: string;
  /** The member company the dev routes mounted. */
  companyId: OrgId;
  store: DocumentStore;
  wiring: HostedAnswersWiring;
  now: () => number;
  log?: ((entry: Record<string, unknown>) => void) | undefined;
}

const ANSWERS_PATH = /^\/v1\/app\/projects\/([^/]+)\/answers$/u;
/** J5: the asker's "Not right" on one answer (a second POST row: `.../answers/{answerId}/not-right`). */
const NOT_RIGHT_PATH = /^\/v1\/app\/projects\/([^/]+)\/answers\/([^/]+)\/not-right$/u;

/** Whether this method and path is the answer route or "Not right". */
export function isAnswersPath(path: string, method: string): boolean {
  return method === "POST" && (ANSWERS_PATH.test(path) || NOT_RIGHT_PATH.test(path));
}

const json = (statusCode: number, value: unknown): BrokerResponse => ({ statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(value) });
const errorAnswer = (error: AgentXError): BrokerResponse => json(error.statusCode, { error: { code: error.code, message: error.message.slice(error.code.length + 2) } });

/** One request on the answer path (`isAnswersPath`), after the dev routes checked the company from membership. Always answers. */
export async function routeHostedAnswers(input: HostedAnswersInput): Promise<BrokerResponse> {
  const notRight = input.request.method === "POST" ? NOT_RIGHT_PATH.exec(input.path) : null;
  if (notRight !== null) return await routeNotRight(input, notRight[1]!, notRight[2]!);
  try {
    const match = input.request.method === "POST" ? ANSWERS_PATH.exec(input.path) : null;
    if (match === null) throw agentXError("NOT_FOUND", "route not found");
    let project: string;
    try { project = decodeURIComponent(match[1]!); } catch { throw agentXError("NOT_FOUND", ANSWER_WORDS.projectNotFound); }
    let body: unknown;
    try { body = input.request.body === undefined || input.request.body === "" ? {} : JSON.parse(input.request.body) as unknown; } catch { body = undefined; }
    const service = createAnswerService({
      companyId: input.companyId, store: input.store, wiki: createWikiStore({ store: input.store, companyId: input.companyId, now: input.now }), now: input.now, log: input.log,
      access: {
        async mayAsk(personId, name) {
          const standing = await input.wiring.standing(personId, input.companyId, name);
          return standing?.access === "manage" || standing?.access === "view";
        },
      },
      async code(name) {
        const found = await input.wiring.repositories(input.companyId, name);
        return found === undefined ? undefined : createAnswerCodeSource(found.handles, found.names);
      },
      model: input.wiring.model?.(input.companyId),
    });
    return json(200, await service.ask({ personId: input.personId, project, body }));
  } catch (error) {
    if (error instanceof AgentXError) return errorAnswer(error);
    return errorAnswer(agentXError("RUNTIME_UNAVAILABLE", ANSWER_WORDS.unavailable));
  }
}

/**
 * J5: "Not right". Who: the person who asked, with a role on the project NOW (read live, like the answer itself). Anyone else, a missing project, an answer that is another person's, expired or erased, and a
 * malformed name all get the same 404. The body is `{}` (who presses comes from the sign-in). The effect is the soft one the design names (core/answers/feedback.ts): it hides nothing.
 */
async function routeNotRight(input: HostedAnswersInput, rawProject: string, rawAnswer: string): Promise<BrokerResponse> {
  try {
    let project: string;
    let answerId: string;
    try { project = decodeURIComponent(rawProject); answerId = decodeURIComponent(rawAnswer); } catch { throw agentXError("NOT_FOUND", ANSWER_WORDS.projectNotFound); }
    if (!WikiProjectSchema.safeParse(project).success) throw agentXError("NOT_FOUND", ANSWER_WORDS.projectNotFound);
    let standing;
    try { standing = await input.wiring.standing(input.personId, input.companyId, project); } catch { throw agentXError("RUNTIME_UNAVAILABLE", ANSWER_FEEDBACK_WORDS.unavailable); }
    if (standing?.access !== "manage" && standing?.access !== "view") throw agentXError("NOT_FOUND", ANSWER_WORDS.projectNotFound);
    let body: unknown;
    try { body = input.request.body === undefined || input.request.body === "" ? {} : input.request.body.length > 1_024 ? undefined : JSON.parse(input.request.body) as unknown; } catch { body = undefined; }
    if (!NotRightBodySchema.safeParse(body).success) throw agentXError("CONFIG_INVALID", ANSWER_WORDS.badRequest);
    if (!WikiIdSchema.safeParse(answerId).success) throw agentXError("NOT_FOUND", ANSWER_FEEDBACK_WORDS.notYours);
    const wiki = createWikiStore({ store: input.store, companyId: input.companyId, now: input.now });
    let done;
    try { done = await pressNotRight(wiki, { project, answerId, personId: input.personId }); } catch { throw agentXError("RUNTIME_UNAVAILABLE", ANSWER_FEEDBACK_WORDS.unavailable); }
    if (done === undefined) throw agentXError("NOT_FOUND", ANSWER_FEEDBACK_WORDS.notYours);
    return json(200, NotRightResponseSchema.parse(done));
  } catch (error) {
    if (error instanceof AgentXError) return errorAnswer(error);
    return errorAnswer(agentXError("RUNTIME_UNAVAILABLE", ANSWER_FEEDBACK_WORDS.unavailable));
  }
}
