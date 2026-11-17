// Wiki W4 (DEC 254zh, 254zi): the wiki build controls on the hosted core. The same route family as the setup run (`/v1/app/projects/{project}/...`), served AS the signed-in person:
//
//   GET  /v1/app/projects/{project}/wiki-build            where the build stands, what the controls show (AI key, agents switch, pages) and `canManage`
//   POST /v1/app/projects/{project}/wiki-build            Build the wiki ({ requestId, notes?, chipsOn? }); 202 started, 200 a repeat of the same request id
//   POST /v1/app/projects/{project}/wiki-build/continue   continue a stopped build ({ requestId })
//   POST /v1/app/projects/{project}/wiki-build/stop       stop the running build ({ requestId })
//   POST /v1/app/projects/{project}/wiki-build/refresh    Refresh now ({ requestId }): a new build run over the changed, the marked wrong and the not yet written pages
//   POST /v1/app/projects/{project}/wiki-build/agents     "Give the wiki to agents" ({ requestId, on })
//   POST /v1/app/projects/{project}/wiki-build/delete     Delete wiki ({ requestId }): pages, notes, flags, build records, answers, the agents switch and the build's own rows
//
// Rules (the setup run's and the file map's, reused: `standing` is the one live read of a person's standing):
//   - The company is the caller's LIVE membership (the dev routes' `companyOf`), never a header, query, body or token claim; the project is read in that company only; a script token never reaches
//     these routes (the dev routes refuse it first). Every key is built from that company AND the project.
//   - Who: a live company owner or admin, or an administrator of the project, builds, continues, stops, refreshes, switches and deletes; any person with a role on the project reads the state. Anyone
//     else, another company's project, a project of this company the person has no role on, a missing one and a malformed name all answer the same 404 "project not found". A reader's change is 403 in fixed words.
//   - Money: the build is a task paid by the PROJECT with its own cap (run.ts). A start needs the company's new tasks on the core and a model gateway; no AI key is "Connect an AI key" and nothing is written.
//   - Every act (and every request for one) leaves an audit record naming the person and why they were allowed, written BEFORE the act: nothing is done when the record cannot be written.
//   - A repository removed from the project leaves nothing behind: its pages are pruned before the state is read (`pruneRepositories`), as on the wiki read routes.
//   - Refusals are fixed words; nothing a caller sent is echoed, and a store or host fault is a fixed 503.
import {
  AgentXError, WIKI_CONTROLS_WORDS, WikiProjectSchema, agentXError, type AuditEvent, type AuditSink, type OrgId, type PluginKind, type WikiAiKeyState, type WikiFileMap,
} from "@agentx/contracts";
import type { BrokerRequest, BrokerResponse } from "../handler.js";
import type { TaskFlowDeps, TaskStartCaller } from "../core/task-flow/deps.js";
import { cancelTask } from "../core/task-flow/cancel.js";
import { createWikiStore } from "../core/wiki/store.js";
import { unregisteredHost, type FileMapRepository } from "../core/wiki/file-map.js";
import { repositoryKeyOf } from "../core/wiki/map-service.js";
import {
  agentsSwitchControl, continueWikiControl, deleteWikiControl, refreshWikiControl, startWikiControl, stopWikiControl, wikiControlsView, type WikiControlAction, type WikiControlsDeps,
} from "../core/wiki-build/controls.js";
import type { WikiBuildStarter } from "../core/wiki-build/run.js";
import type { WikiBuildStarterInput } from "../core/wiki-build/starter.js";
import { ensureCoreInUse } from "./engine-stamp.js";
import type { SetupRunBasis, SetupRunStanding } from "./setup-run-routes.js";
import { hostOf, wikiMapServiceOf, type HostedWikiMapWiring } from "./wiki-map-routes.js";

export type { WikiBuildStarterInput };

/** What the deployment wires for the wiki build controls (aws/core-engine-root.ts). */
export interface HostedWikiBuildWiring {
  /** The person's standing on the project in THIS company, read live (the setup run's own read). Throws when it cannot be read: the route then refuses in fixed words. */
  standing(personId: string, companyId: OrgId, project: string): Promise<SetupRunStanding>;
  /** Whether the install's model gateway is configured (it meters and prices the run). False: a start is "Connect an AI key". */
  modelAccessConfigured(): boolean;
  /** Whether the company has an AI key connected, when the install can tell. Absent: `unknown` (the gateway says at the first call, and the run ends "needs an AI key"). */
  aiKey?: ((companyId: OrgId) => Promise<WikiAiKeyState>) | undefined;
  /** The file map's wiring: the SAME object the wiki-map route has, so a map made there is the one a build plans from, and the code host is the company's own. */
  map: HostedWikiMapWiring;
  /**
   * The task flow's wiki build starter (W3b's `createWikiBuildStarter`). Absent: building is "not set up in this deployment" (404) and every other control still works (state, the agents
   * switch, delete).
   */
  starter?: ((input: WikiBuildStarterInput) => WikiBuildStarter) | undefined;
  /** The project's own build-limit setting (any shape) and the company's lock. Absent: the defaults. */
  limitSetting?: ((project: string) => Promise<unknown>) | undefined;
  limitLock?: (() => Promise<unknown>) | undefined;
  /** A person's display name, for "stopped by". Absent or unknown: "Unknown". */
  displayName?: ((personId: string) => Promise<string | undefined>) | undefined;
}

export interface HostedWikiBuildInput {
  request: BrokerRequest;
  /** The request's path without its query. */
  path: string;
  principal: TaskStartCaller["principal"];
  client?: string | undefined;
  companyId: OrgId;
  flow: TaskFlowDeps;
  wiring: HostedWikiBuildWiring;
  /** The audit sink for this request (the dev routes' `auditFor`, else the runtime's). */
  audit: AuditSink;
  /** Whether the switch sends this company's NEW tasks to the core. False: a build, a continue and a refresh are refused. */
  startsNewTasks: boolean;
  now: () => number;
  log?: ((entry: Record<string, unknown>) => void) | undefined;
}

const WIKI_BUILD_PATH = /^\/v1\/app\/projects\/([^/]+)\/wiki-build(?:\/(continue|stop|refresh|agents|delete))?$/u;
const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;

/** Whether this method and path is one of the wiki build controls. */
export function isWikiBuildPath(path: string, method: string): boolean {
  const match = WIKI_BUILD_PATH.exec(path);
  if (match === null) return false;
  return match[2] === undefined ? method === "GET" || method === "POST" : method === "POST";
}

const json = (statusCode: number, value: unknown): BrokerResponse => ({ statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(value) });
const errorAnswer = (error: AgentXError): BrokerResponse => json(error.statusCode, { error: { code: error.code, message: error.message.slice(error.code.length + 2) } });
const notFound = (): AgentXError => agentXError("NOT_FOUND", WIKI_CONTROLS_WORDS.projectNotFound);
const unavailable = (): AgentXError => agentXError("RUNTIME_UNAVAILABLE", WIKI_CONTROLS_WORDS.unreadable);

function bodyOf(request: BrokerRequest): unknown {
  if (request.body === undefined || request.body === "") return {};
  try { return JSON.parse(request.body) as unknown; } catch { throw agentXError("CONFIG_INVALID", "the request is not valid"); }
}

const isManage = (standing: SetupRunStanding): standing is Extract<SetupRunStanding, { access: "manage" }> =>
  standing?.access === "manage" && (standing.basis === "company-owner" || standing.basis === "company-admin" || standing.basis === "project-admin");

/** The file map as the build plans from it: the kept one (what the person saw), or a new one; `fresh` makes a new one (Refresh now reads the branches again). */
function mapReader(input: HostedWikiBuildInput, repositories: ReadonlyArray<{ name: string; url: string; defaultBranch: string; host?: { kind: PluginKind } | undefined }>, fresh: () => boolean) {
  const service = wikiMapServiceOf(input.wiring.map, input.now, input.log);
  return async (project: string): Promise<WikiFileMap | undefined> => {
    if (!fresh()) {
      const kept = service.read(input.companyId, project, repositories.map(repositoryKeyOf));
      if (kept !== undefined) return kept;
    }
    const targets: FileMapRepository[] = repositories.map((repository) => ({ name: repository.name, url: repository.url, defaultBranch: repository.defaultBranch, host: hostOf(input.wiring.map, repository) }));
    return await service.make(input.companyId, project, targets, { orgId: input.companyId });
  };
}

/** One request on a hosted wiki build path (`isWikiBuildPath`), after the dev routes checked the company from membership. Always answers. */
export async function routeHostedWikiBuild(input: HostedWikiBuildInput): Promise<BrokerResponse> {
  try {
    const match = WIKI_BUILD_PATH.exec(input.path);
    if (match === null) throw agentXError("NOT_FOUND", "route not found");
    let project: string;
    try { project = decodeURIComponent(match[1]!); } catch { throw notFound(); }
    if (!PROJECT_NAME.test(project) || !WikiProjectSchema.safeParse(project).success) throw notFound();
    const tail = match[2];
    const { flow, companyId, wiring } = input;
    let standing: SetupRunStanding;
    try { standing = await wiring.standing(input.principal.personId, companyId, project); } catch { throw unavailable(); }
    // Anything but the two answers is no answer: read as none (never as manage).
    if (!isManage(standing) && standing?.access !== "view") throw notFound();
    // The project is read in the caller's company only.
    let latest;
    try { latest = await flow.projects.latest(project); } catch { throw unavailable(); }
    if (latest === undefined) throw notFound();
    const repositories = latest.definition.repositories;
    const personId = input.principal.personId;
    const wiki = createWikiStore({ store: flow.store, companyId, now: input.now });
    // A repository removed from the project leaves nothing behind: its pages go before anything is read.
    try { await wiki.pruneRepositories(project, repositories.map((repository) => repository.name)); } catch { throw unavailable(); }

    const live = async (person: string, name: string) => {
      let now: SetupRunStanding;
      try { now = await wiring.standing(person, companyId, name); } catch { return { access: "none" as const }; }
      return isManage(now) ? { access: "manage" as const } : now?.access === "view" ? { access: "view" as const } : { access: "none" as const };
    };
    let freshMap = false;
    const starter = (): WikiBuildStarter | undefined => {
      if (wiring.starter === undefined) return undefined;
      // The core's start, with the wiki build's own access rule in place of the task rule (the setup run's way), read live again inside the start.
      const flowForStart: TaskFlowDeps = {
        ...flow,
        access: {
          ...flow.access,
          async checkStart(principal, name) {
            if (principal.companyId !== companyId) return { allowed: false, code: "FORBIDDEN", message: WIKI_CONTROLS_WORDS.notAllowed };
            return (await live(principal.personId, name)).access === "manage" ? { allowed: true } : { allowed: false, code: "FORBIDDEN", message: WIKI_CONTROLS_WORDS.notAllowed };
          },
        },
      };
      const caller: TaskStartCaller = { principal: input.principal, client: input.client ?? "app", origin: "app" };
      const base = wiring.starter({ flow: flowForStart, caller, cancel: async (request) => { await cancelTask(flow, request.taskId); } });
      return { start: async (request) => { await ensureCoreInUse(flow.store, companyId); return await base.start(request); }, cancel: (request) => base.cancel(request) };
    };
    const readMap = mapReader(input, repositories, () => freshMap);
    const controls: WikiControlsDeps = {
      build: {
        store: flow.store, companyId, now: input.now, limitSetting: wiring.limitSetting, limitLock: wiring.limitLock, displayName: wiring.displayName,
        starter: starter(), standing: (person, name) => live(person, name), modelAccessConfigured: wiring.modelAccessConfigured(),
        aiKey: async () => (wiring.aiKey === undefined ? "unknown" : await wiring.aiKey(companyId)),
        fileMap: readMap,
        // The commits a build pins are the ones the map was read at, so the plan and the pins describe the same tree.
        defaultBranchHeads: async (name) => (await readMap(name))?.repositories.flatMap((repository) => (repository.status === "unavailable" || repository.commit === undefined ? [] : [{ repo: repository.name, commit: repository.commit }])) ?? [],
        async requireNewWork(name) {
          const found = await flow.projects.latest(name);
          if (found?.archived === true) throw agentXError("PROJECT_ARCHIVED", "This project is archived. Restore it to start new work.");
        },
        recordBuild: (record) => wiki.writeBuild(project, record),
      },
      wiki,
      agents: { store: flow.store, companyId, now: input.now },
      record: async (action: WikiControlAction, name, details) => {
        const basis: SetupRunBasis | undefined = isManage(standing) ? standing.basis : undefined;
        const event: AuditEvent = {
          eventId: `wiki_build.${action}:${companyId}:${name}:${personId}:${details.requestId}`, companyId, at: new Date(input.now()).toISOString(), actor: { type: "person", id: personId },
          action: `wiki_build.${action}`, subject: { type: "project", id: name },
          details: { project: name, ...(basis === undefined ? {} : { basis }), requestId: details.requestId, ...(details.on === undefined ? {} : { on: details.on }) },
        };
        await input.audit.record(event);
      },
    };

    if (input.request.method === "GET" && tail === undefined) return json(200, await wikiControlsView(controls, personId, project));
    if (input.request.method !== "POST") throw agentXError("NOT_FOUND", "route not found");
    // Every change: only a person who manages the project's wiki (the control re-reads the standing too).
    if (!isManage(standing)) throw agentXError("FORBIDDEN", WIKI_CONTROLS_WORDS.notAllowed);
    const raw = bodyOf(input.request);
    // A build, a continue and a refresh start a task: only where this company's new tasks run on the core. Nothing is written otherwise.
    if ((tail === undefined || tail === "continue" || tail === "refresh") && !input.startsNewTasks) throw agentXError("RUNTIME_UNAVAILABLE", WIKI_CONTROLS_WORDS.unavailable);
    if (tail === "refresh") freshMap = true;
    if (tail === undefined) { const done = await startWikiControl(controls, personId, project, raw); return json(done.status, done.view); }
    if (tail === "continue") { const done = await continueWikiControl(controls, personId, project, raw); return json(done.status, done.view); }
    if (tail === "stop") { const done = await stopWikiControl(controls, personId, project, raw); return json(done.status, done.view); }
    if (tail === "refresh") { const done = await refreshWikiControl(controls, personId, project, raw); return json(done.status, done.view); }
    if (tail === "agents") { const done = await agentsSwitchControl(controls, personId, project, raw); return json(done.status, done.view); }
    const done = await deleteWikiControl(controls, personId, project, raw, { store: flow.store, now: input.now });
    return json(done.status, { deleted: true, message: done.message, view: done.view });
  } catch (error) {
    if (error instanceof AgentXError) {
      // The core names a missing project with its name; here every missing or unseen project reads the same.
      if (error.code === "PROJECT_NOT_FOUND") return errorAnswer(notFound());
      return errorAnswer(error);
    }
    return errorAnswer(unavailable());
  }
}
