// Wiki W0 (DEC 254zh): the project's free file map on the hosted core. The same route family as the setup run (`/v1/app/projects/{project}/...`), served AS the signed-in person:
//
//   GET  /v1/app/projects/{project}/wiki-map   the map last made for this project (kept ten minutes), or `{ status: "none" }`, plus `canManage`
//   POST /v1/app/projects/{project}/wiki-map   make the map now (a project's repositories, read through the code host: no model call, nothing spent, nothing stored); 200 with the map
//
// Rules (the setup run's, reused: `HostedSetupRunWiring.standing` is the one live read of a person's standing):
//   - The company is the caller's LIVE membership (the dev routes' `companyOf`), never a header, query, body or token claim; the project is read in that company only.
//   - Who: a live company owner or admin, or an administrator of the project, MAKES a map; any person with a role on the project READS a kept one. Anyone else, another company's project, a missing one and a
//     malformed name all answer the same 404 "project not found" (so a person with a role on project A learns nothing about project B).
//   - No AI key is needed and none is read: the map uses the code host only.
//   - Refusals are fixed words (the cause of a code host failure is never echoed; a repository that cannot be read is `unavailable` inside the map).
import { AgentXError, agentXError, WIKI_MAP_NOT_ALLOWED, WIKI_MAP_PROJECT_NOT_FOUND, WIKI_MAP_UNAVAILABLE, type OrgId, type PluginKind } from "@agentx/contracts";
import type { BrokerRequest, BrokerResponse } from "../handler.js";
import type { TaskFlowDeps, TaskStartCaller } from "../core/task-flow/deps.js";
import { unregisteredHost, type FileMapHost, type FileMapRepository } from "../core/wiki/file-map.js";
import { createWikiMapService, repositoryKeyOf, type WikiMapService } from "../core/wiki/map-service.js";
import type { SetupRunStanding } from "./setup-run-routes.js";

export const WIKI_MAP_UNREADABLE = "The project could not be read just now. Try again.";

export interface HostedWikiMapWiring {
  /** The person's standing on the project in THIS company, read live (the setup run's own read). Throws when it cannot be read: the route then refuses in fixed words. */
  standing(personId: string, companyId: OrgId, project: string): Promise<SetupRunStanding>;
  /** The company's code host for a repository record (the registry's, through the company-bound provider). */
  hostFor(repository: { host?: { kind: PluginKind } | undefined }): FileMapHost;
}

export interface HostedWikiMapInput {
  request: BrokerRequest;
  path: string;
  principal: TaskStartCaller["principal"];
  companyId: OrgId;
  flow: TaskFlowDeps;
  wiring: HostedWikiMapWiring;
  now: () => number;
  log?: ((entry: Record<string, unknown>) => void) | undefined;
}

const WIKI_MAP_PATH = /^\/v1\/app\/projects\/([^/]+)\/wiki-map$/u;
const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;

/** Whether this method and path is the file map's. */
export function isWikiMapPath(path: string, method: string): boolean { return WIKI_MAP_PATH.test(path) && (method === "GET" || method === "POST"); }

const json = (statusCode: number, value: unknown): BrokerResponse => ({ statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(value) });
const errorAnswer = (error: AgentXError): BrokerResponse => json(error.statusCode, { error: { code: error.code, message: error.message.slice(error.code.length + 2) } });
const notFound = (): AgentXError => agentXError("NOT_FOUND", WIKI_MAP_PROJECT_NOT_FOUND);

/** A repository whose code host is not registered is unavailable in the map (fixed words), never a failure of the whole request. */
export function hostOf(wiring: HostedWikiMapWiring, repository: { host?: { kind: PluginKind } | undefined }): FileMapHost {
  try { return wiring.hostFor(repository); } catch { return unregisteredHost; }
}

/** One service per wiring object (the wiring is built once per company), so the kept maps live as long as the company's wiring and are still keyed by company and project. */
const services = new WeakMap<object, WikiMapService>();
function serviceOf(wiring: HostedWikiMapWiring, now: () => number, log: HostedWikiMapInput["log"]): WikiMapService {
  let service = services.get(wiring);
  if (service === undefined) { service = createWikiMapService({ now, log }); services.set(wiring, service); }
  return service;
}

/** One request on a hosted file-map path (`isWikiMapPath`), after the dev routes checked the company from membership. Always answers. */
export async function routeHostedWikiMap(input: HostedWikiMapInput): Promise<BrokerResponse> {
  try {
    const match = WIKI_MAP_PATH.exec(input.path);
    if (match === null) throw agentXError("NOT_FOUND", "route not found");
    let project: string;
    try { project = decodeURIComponent(match[1]!); } catch { throw notFound(); }
    if (!PROJECT_NAME.test(project)) throw notFound();
    let standing: SetupRunStanding;
    try { standing = await input.wiring.standing(input.principal.personId, input.companyId, project); } catch { throw agentXError("RUNTIME_UNAVAILABLE", WIKI_MAP_UNREADABLE); }
    // Anything but the two answers is no answer: read as none (never as manage).
    const access = standing?.access === "manage" && (standing.basis === "company-owner" || standing.basis === "company-admin" || standing.basis === "project-admin") ? "manage" : standing?.access === "view" ? "view" : "none";
    if (access === "none") throw notFound();
    // The project is read in the caller's company only.
    let latest;
    try { latest = await input.flow.projects.latest(project); } catch { throw agentXError("RUNTIME_UNAVAILABLE", WIKI_MAP_UNREADABLE); }
    if (latest === undefined) throw notFound();
    const repositories = latest.definition.repositories;
    const service = serviceOf(input.wiring, input.now, input.log);
    const canManage = access === "manage";
    if (input.request.method === "GET") {
      const map = service.read(input.companyId, project, repositories.map(repositoryKeyOf));
      return json(200, map === undefined ? { status: "none", canManage } : { status: "ready", canManage, map });
    }
    if (input.request.method !== "POST") throw agentXError("NOT_FOUND", "route not found");
    if (!canManage) throw agentXError("FORBIDDEN", WIKI_MAP_NOT_ALLOWED);
    const targets: FileMapRepository[] = repositories.map((repository) => ({ name: repository.name, url: repository.url, defaultBranch: repository.defaultBranch, host: hostOf(input.wiring, repository) }));
    let map;
    try { map = await service.make(input.companyId, project, targets, { orgId: input.companyId }); } catch { throw agentXError("RUNTIME_UNAVAILABLE", WIKI_MAP_UNAVAILABLE); }
    return json(200, { status: "ready", canManage: true, map });
  } catch (error) {
    if (error instanceof AgentXError) return errorAnswer(error);
    throw error;
  }
}
