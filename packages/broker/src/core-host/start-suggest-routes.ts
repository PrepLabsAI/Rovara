// Lead 4 J3 (DEC 173): the web start box's path suggestion on the deployed developer API, AS the signed-in person:
//
//   POST /v1/app/projects/{project}/code/suggest    { requestId, text }  ->  { kind, classifier, pick, smallTalk? }   (contracts/start-suggest.ts)
//
// Rules:
//  - The company is the caller's LIVE membership (the dev routes check it and mount that company's runtime). Who asks: any role on the project, read live (a viewer too: a suggestion changes nothing). Anyone else, a
//    project the company does not have, a malformed name and another company's project all get the same 404 "project not found". The role is read BEFORE the body is.
//  - Nothing is stored, nothing is started, nothing the caller sent is echoed. A script token never reaches this route (APP_ROUTES `requires: "full"`).
//  - The classifier is a seam (`route`). Until the gateway's answers purpose is wired the deployment passes none, and the suggestion says `unavailable` (asked nothing, spent nothing); small talk is answered without it.
import { START_SUGGEST_WORDS, START_SUGGESTS_PER_PERSON_PER_HOUR, AgentXError, agentXError, type OrgId } from "@agentx/contracts";
import type { BrokerRequest, BrokerResponse } from "../handler.js";
import { createStartSuggest, createStartSuggestLimiter, type StartRouter } from "../core/answers/start-suggest.js";
import type { SetupRunStanding } from "./setup-run-routes.js";

export interface HostedStartSuggestWiring {
  /** The person's standing on the project in THIS company, read live. Throws when it cannot be read. */
  standing(personId: string, companyId: OrgId, project: string): Promise<SetupRunStanding>;
  /** The classifier for this company's suggestions. Absent: none is set up here (`unavailable`). */
  route?: ((companyId: OrgId) => StartRouter | undefined) | undefined;
}

export interface HostedStartSuggestInput {
  request: BrokerRequest;
  /** The request's path without its query. */
  path: string;
  personId: string;
  /** The member company the dev routes mounted. */
  companyId: OrgId;
  wiring: HostedStartSuggestWiring;
  now: () => number;
  log?: ((entry: Record<string, unknown>) => void) | undefined;
}

const SUGGEST_PATH = /^\/v1\/app\/projects\/([^/]+)\/code\/suggest$/u;

/** Whether this method and path is the suggest route. */
export function isStartSuggestPath(path: string, method: string): boolean {
  return method === "POST" && SUGGEST_PATH.test(path);
}

const json = (statusCode: number, value: unknown): BrokerResponse => ({ statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(value) });
const errorAnswer = (error: AgentXError): BrokerResponse => json(error.statusCode, { error: { code: error.code, message: error.message.slice(error.code.length + 2) } });

/** One counter per company and person, in this process (only a classifier call takes a place). The clock is the caller's: the first request's clock is kept, and every later one reads its own. */
let hourly: { limit: (key: string) => boolean; now: { current: () => number } } | undefined;
const limiterFor = (now: () => number): ((key: string) => boolean) => {
  if (hourly === undefined) { const clock = { current: now }; hourly = { now: clock, limit: createStartSuggestLimiter(() => clock.current(), START_SUGGESTS_PER_PERSON_PER_HOUR) }; }
  hourly.now.current = now;
  return hourly.limit;
};

/** One request on the suggest path (`isStartSuggestPath`), after the dev routes checked the company from membership. Always answers. */
export async function routeHostedStartSuggest(input: HostedStartSuggestInput): Promise<BrokerResponse> {
  try {
    const match = input.request.method === "POST" ? SUGGEST_PATH.exec(input.path) : null;
    if (match === null) throw agentXError("NOT_FOUND", "route not found");
    let project: string;
    try { project = decodeURIComponent(match[1]!); } catch { throw agentXError("NOT_FOUND", START_SUGGEST_WORDS.projectNotFound); }
    let body: unknown;
    try { body = input.request.body === undefined || input.request.body === "" ? {} : JSON.parse(input.request.body) as unknown; } catch { body = undefined; }
    const companyLimiter = limiterFor(input.now);
    const service = createStartSuggest({
      async mayAsk(personId, name) {
        const standing = await input.wiring.standing(personId, input.companyId, name);
        return standing?.access === "manage" || standing?.access === "view";
      },
      route: input.wiring.route?.(input.companyId), now: input.now, log: input.log,
    }, (personId) => companyLimiter(`${input.companyId}/${personId}`));
    return json(200, await service.suggest({ personId: input.personId, project, body }));
  } catch (error) {
    if (error instanceof AgentXError) return errorAnswer(error);
    return errorAnswer(agentXError("RUNTIME_UNAVAILABLE", START_SUGGEST_WORDS.unavailable));
  }
}
