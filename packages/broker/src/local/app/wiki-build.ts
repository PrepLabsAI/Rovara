// Wiki W4 (DEC 254zh, 254zi): the wiki build controls on `rovara up`. The same routes as the hosted core (core-host/wiki-build-routes.ts), over the same controls (core/wiki-build/controls.ts):
//
//   GET  /v1/app/projects/{project}/wiki-build            where the build stands and what the controls show
//   POST /v1/app/projects/{project}/wiki-build            Build the wiki;  .../continue  .../stop  .../refresh (Refresh now)  .../agents ("Give the wiki to agents")  .../delete (Delete wiki)
//
// Who: the owner of this install, on the API session (the owner manages every project of the install). A script token never reaches these routes. A project that does not exist answers
// `PROJECT_NOT_FOUND`. The install has one company (`IMPLICIT_COMPANY_ID`), and every row is still keyed by it AND the project. The build is the task flow's own (run.ts): the project pays, the build
// has its own cap, no model key is "Connect an AI key" with nothing written. The task flow's wiki build starter (W3b's `createWikiBuildStarter`) is the `starter` seam; without it Build says
// "not set up in this deployment" and the other controls (state, the agents switch, delete) work.
import { AgentXError, IMPLICIT_COMPANY_ID, WIKI_CONTROLS_WORDS, agentXError, type OrgId, type Principal } from "@agentx/contracts";
import type { BrokerRequest, BrokerResponse } from "../../handler.js";
import type { TaskCaller, TaskFlowDeps, TaskStartCaller } from "../../core/task-flow/deps.js";
import { createWikiStore } from "../../core/wiki/store.js";
import {
  agentsSwitchControl, continueWikiControl, deleteWikiControl, refreshWikiControl, startWikiControl, stopWikiControl, wikiControlsView, type WikiControlsDeps,
} from "../../core/wiki-build/controls.js";
import type { WikiBuildStarter } from "../../core/wiki-build/run.js";
import type { WikiBuildStarterInput } from "../../core-host/wiki-build-routes.js";
import { createSessionControlHost } from "./host.js";
import type { LocalWikiMap } from "./wiki-map.js";

const ROUTE = /^\/v1\/app\/projects\/([A-Za-z0-9][A-Za-z0-9_.-]{0,127})\/wiki-build(?:\/(continue|stop|refresh|agents|delete))?$/u;
const json = (statusCode: number, value: unknown): BrokerResponse => ({ statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(value) });
const bodyOf = (request: BrokerRequest): unknown => {
  if (request.body === undefined || request.body === "") return {};
  try { return JSON.parse(request.body) as unknown; } catch { throw agentXError("CONFIG_INVALID", "the request is not valid"); }
};

export interface LocalWikiBuildOptions {
  flow: TaskFlowDeps;
  wikiMap: LocalWikiMap;
  owner: Principal;
  companyId?: OrgId | undefined;
  now: () => number;
  /** Whether the install has a model the run can use (the chosen model has a route). */
  modelAccessConfigured: () => Promise<boolean>;
  /** The task flow's wiki build starter (W3b). Absent: Build is "not set up in this deployment". */
  starter?: ((input: WikiBuildStarterInput) => WikiBuildStarter) | undefined;
}

export interface LocalWikiBuild { routes(request: BrokerRequest, caller: TaskCaller): Promise<BrokerResponse | undefined> }

export function createLocalWikiBuild(options: LocalWikiBuildOptions): LocalWikiBuild {
  const companyId = options.companyId ?? IMPLICIT_COMPANY_ID;
  const { flow } = options;
  const control = createSessionControlHost(flow);
  const callerOf = (): TaskStartCaller => ({ principal: options.owner, client: "app", origin: "app" });
  return {
    async routes(request, caller) {
      const url = request.path.split("?")[0] ?? request.path;
      const match = ROUTE.exec(url);
      if (match === null) return undefined;
      const tail = match[2];
      if (tail === undefined ? request.method !== "GET" && request.method !== "POST" : request.method !== "POST") return undefined;
      try {
        if (caller.scriptToken !== undefined || !caller.principal.roles.includes("owner")) throw agentXError("FORBIDDEN", "only the owner of this install can build a project's wiki");
        const project = match[1]!;
        const latest = await flow.projects.latest(project);
        if (latest === undefined) throw agentXError("PROJECT_NOT_FOUND", WIKI_CONTROLS_WORDS.projectNotFound);
        const repositories = latest.definition.repositories;
        const wiki = createWikiStore({ store: flow.store, companyId, now: options.now });
        // A repository removed from the project leaves nothing behind: its pages go before anything is read.
        await wiki.pruneRepositories(project, repositories.map((repository) => repository.name));
        const personId = caller.principal.personId;
        let fresh = false;
        const readMap = (name: string) => options.wikiMap.mapFor(name, repositories, { fresh });
        const configured = await options.modelAccessConfigured();
        const controls: WikiControlsDeps = {
          build: {
            store: flow.store, companyId, now: options.now,
            starter: options.starter?.({ flow, caller: callerOf(), cancel: async (cancel) => { await control.cancelTask(cancel.taskId, cancel.requestId); } }),
            // The owner manages every project of this install.
            standing: async () => ({ access: "manage" }),
            modelAccessConfigured: configured, aiKey: async () => (configured ? "connected" : "missing"),
            fileMap: readMap,
            // The commits a build pins are the ones the map was read at, so the plan and the pins describe the same tree.
            defaultBranchHeads: async (name) => (await readMap(name)).repositories.flatMap((repository) => (repository.status === "unavailable" || repository.commit === undefined ? [] : [{ repo: repository.name, commit: repository.commit }])),
            async requireNewWork(name) {
              const found = await flow.projects.latest(name);
              if (found?.archived === true) throw agentXError("PROJECT_ARCHIVED", `project \`${name}\` is archived; unarchive it to start new work`);
            },
            recordBuild: (record) => wiki.writeBuild(project, record),
          },
          wiki,
          agents: { store: flow.store, companyId, now: options.now },
        };
        if (request.method === "GET") return json(200, await wikiControlsView(controls, personId, project));
        const raw = bodyOf(request);
        if (tail === "refresh") fresh = true;
        if (tail === undefined) { const done = await startWikiControl(controls, personId, project, raw); return json(done.status, done.view); }
        if (tail === "continue") { const done = await continueWikiControl(controls, personId, project, raw); return json(done.status, done.view); }
        if (tail === "stop") { const done = await stopWikiControl(controls, personId, project, raw); return json(done.status, done.view); }
        if (tail === "refresh") { const done = await refreshWikiControl(controls, personId, project, raw); return json(done.status, done.view); }
        if (tail === "agents") { const done = await agentsSwitchControl(controls, personId, project, raw); return json(done.status, done.view); }
        const done = await deleteWikiControl(controls, personId, project, raw, { store: flow.store, now: options.now });
        return json(done.status, { deleted: true, message: done.message, view: done.view });
      } catch (error) {
        if (error instanceof AgentXError) return json(error.statusCode, { error: { code: error.code, message: error.message.slice(error.code.length + 2) } });
        return json(503, { error: { code: "RUNTIME_UNAVAILABLE", message: WIKI_CONTROLS_WORDS.unreadable } });
      }
    },
  };
}
