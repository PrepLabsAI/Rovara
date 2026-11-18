// Wiki W0 (DEC 254zh): the free file map on `rovara up`. The same two routes as the hosted core (core-host/wiki-map-routes.ts):
//
//   GET  /v1/app/projects/{project}/wiki-map   the map last made (kept ten minutes) or `{ status: "none" }`
//   POST /v1/app/projects/{project}/wiki-map   make it now: the project's repositories read through the code host the registry holds; no model, no key, nothing spent or stored
//
// Who: the owner of this install, on the API session. A script token never reaches these routes (the setup page's rule). A project that does not exist answers `PROJECT_NOT_FOUND`.
import { AgentXError, IMPLICIT_COMPANY_ID, agentXError, type AdapterRegistry, type OrgId, type PluginKind, type WikiFileMap } from "@agentx/contracts";
import type { BrokerRequest, BrokerResponse } from "../../handler.js";
import type { TaskCaller, TaskFlowDeps } from "../../core/task-flow/deps.js";
import { unregisteredHost, type FileMapRepository } from "../../core/wiki/file-map.js";
import { createWikiMapService, repositoryKeyOf } from "../../core/wiki/map-service.js";
import { codeHostForRecord } from "../../plugins/routing.js";

const ROUTE = /^\/v1\/app\/projects\/([A-Za-z0-9][A-Za-z0-9_.-]{0,127})\/wiki-map$/u;
const json = (statusCode: number, value: unknown): BrokerResponse => ({ statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(value) });

export interface LocalWikiMapOptions {
  flow: TaskFlowDeps;
  registry: AdapterRegistry;
  companyId?: OrgId | undefined;
  now: () => number;
  log?: ((entry: Record<string, unknown>) => void) | undefined;
}

export interface LocalWikiMap {
  routes(request: BrokerRequest, caller: TaskCaller): Promise<BrokerResponse | undefined>;
  /** The map the wiki build (W4) plans from: the kept one (what the owner saw) or a new one; `fresh` always reads the branches again. The same kept map as the route's. */
  mapFor(project: string, repositories: ReadonlyArray<{ name: string; url: string; defaultBranch: string; host?: { kind: PluginKind } | undefined }>, options: { fresh: boolean }): Promise<WikiFileMap>;
}

export function createLocalWikiMap(options: LocalWikiMapOptions): LocalWikiMap {
  const companyId = options.companyId ?? IMPLICIT_COMPANY_ID;
  const service = createWikiMapService({ now: options.now, log: options.log });
  // A repository whose code host is not registered is unavailable in the map (fixed words), never a failure of the whole request.
  const hostOf = (repository: { host?: { kind: PluginKind } | undefined }): FileMapRepository["host"] => {
    try { return codeHostForRecord(options.registry, repository.host === undefined ? {} : { host: { kind: repository.host.kind } }); } catch { return unregisteredHost; }
  };
  return {
    async mapFor(project, repositories, options) {
      if (!options.fresh) {
        const kept = service.read(companyId, project, repositories.map(repositoryKeyOf));
        if (kept !== undefined) return kept;
      }
      return await service.make(companyId, project, repositories.map((repository) => ({ name: repository.name, url: repository.url, defaultBranch: repository.defaultBranch, host: hostOf(repository) })), { orgId: companyId });
    },
    async routes(request, caller) {
      const match = ROUTE.exec(request.path.split("?")[0] ?? request.path);
      if (match === null || (request.method !== "GET" && request.method !== "POST")) return undefined;
      try {
        if (caller.scriptToken !== undefined || !caller.principal.roles.includes("owner")) throw agentXError("FORBIDDEN", "only the owner of this install can map a project's files");
        const project = match[1]!;
        const latest = await options.flow.projects.latest(project);
        if (latest === undefined) throw agentXError("PROJECT_NOT_FOUND", `project \`${project}\` doesn't exist`);
        const repositories = latest.definition.repositories;
        if (request.method === "GET") {
          const map = service.read(companyId, project, repositories.map(repositoryKeyOf));
          return json(200, map === undefined ? { status: "none", canManage: true } : { status: "ready", canManage: true, map });
        }
        const targets: FileMapRepository[] = repositories.map((repository) => ({
          name: repository.name, url: repository.url, defaultBranch: repository.defaultBranch,
          host: hostOf(repository),
        }));
        const map = await service.make(companyId, project, targets, { orgId: companyId });
        return json(200, { status: "ready", canManage: true, map });
      } catch (error) {
        if (error instanceof AgentXError) return json(error.statusCode, { error: { code: error.code, message: error.message.slice(error.code.length + 2) } });
        throw error;
      }
    },
  };
}
