// Engine host (lane E2): the core's own handlers, mountable on the deployed developer API behind the switch (`ROVARA_CORE_ENGINE`, default off).
//
// The controller decided that, once the host is deployed, these answers come from the core itself, not from adapters on the old broker:
//   - sessions (`/v1/app/sessions...`): a session's read (the task view with its evidence), the understanding answers (`POST .../answers`), stop, retry, follow;
//   - a task's read (`GET /v1/dev/tasks/<id>`), whose view carries the evidence kept for its checked code;
//   - decision cards (`GET /v1/app/decisions`): the list, through the deployment's sources (each checks the caller's live authority). Acting on a card needs a proof that a person
//     on a recently signed-in page acts; this API has none yet, so approve, reject, request changes and evidence-opened are refused (the same open question as script tokens);
//   - how we work (`GET /v1/app/projects/<p>/how-we-work`, `.../playbook`): read only, for a person the company lets read that project;
//   - script tokens (`/v1/app/script-tokens...`): list and revoke. MAKING one is refused here: the laptop's rule is that only a page the person signed in to a few minutes ago may make
//     one, and the deployed API has no such credential today (QUESTION R2-SCRIPT-TOKEN-CREDENTIAL). A token's own requests are not accepted here either (the broker's sign-in decides that).
//
// Rules:
//   - Off (the default) is byte-identical: `route` answers `undefined` for every request without reading anything, and the old broker answers as before.
//   - A path this module does not own is `undefined` too; `/v1/local/*` (the laptop's page routes) is never served.
//   - The caller's company comes from MEMBERSHIP (`companyOf`, R4's reader), never from a header, a query, a body or a token claim. A reader that throws or answers nothing refuses the
//     call with the sign-in refusal; there is no fallback to the install's company.
//   - A company the switch does not send to the core, and that holds no core task, is the old broker's (`undefined`).
//   - A handler the deployment has not wired answers a fixed "not on the core yet" (never a laptop default: the session levels, decision authority and the playbook's code host are the
//     deployment's).
import { AgentXError, OrgRoleSchema, agentXError, type ObjectStorage, type OrgRole, type Principal } from "@agentx/contracts";
import type { TaskCaller } from "../core/task-flow/deps.js";
import { loadOwnedTask, taskViewOf } from "../core/task-flow/reads.js";
import { routeDecisionCards, type DecisionCaller, type DecisionRouteDependencies } from "../core/decisions/routes.js";
import type { SessionMembers } from "../core/sessions/access.js";
import { developerIdOf } from "../core/sessions/create.js";
import type { PlaybookService } from "../core/playbook/service.js";
import { listScriptTokens, revokeScriptToken, scriptTokensEnabled, type ScriptTokenCaller } from "../core/script-tokens/index.js";
import type { BrokerRequest, BrokerResponse } from "../handler.js";
import { createSessionRoutes } from "../local/app/session-routes.js";
import { createLocalPlaybook } from "../local/app/playbook.js";
import { developerTaskView } from "../local/app/task-view.js";
import type { CoreHostApp } from "./app.js";
import type { CoreRuntime } from "./core-runtime.js";

/** The paths this module owns. Anything else is the old broker's. */
const SESSIONS = /^\/v1\/app\/sessions(?:\/|$)/u;
const TASK_READ = /^\/v1\/dev\/tasks\/([0-9a-f-]{36})$/u;
const DECISIONS = /^\/v1\/app\/decisions(?:\/|$)/u;
const PLAYBOOK = /^\/v1\/app\/projects\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/(?:how-we-work|playbook)$/u;
const SCRIPT_TOKENS = /^\/v1\/app\/script-tokens(?:\/([^/]+)\/revoke)?$/u;

export const NOT_ON_THE_CORE_YET = "That is not on the core engine on this install yet.";
export const MAKE_SCRIPT_TOKEN_ON_A_PAGE = "A script token is made on its page, in a browser you signed in to a few minutes ago: it is a long-lived credential, so a tool that holds an API token cannot make one.";
export const SIGN_IN_AGAIN = "Sign in again.";
export const DECIDE_ON_A_PAGE = "A decision is made on its page, in a browser you signed in to a few minutes ago: a tool that holds an API token cannot approve or reject.";
export const NOT_FOR_SCRIPT_TOKENS = "A script token cannot do that.";
const PROJECT_NOT_FOUND = "project not found";

/** The deployed caller, as the broker's sign-in vouches for it. */
export interface DeployedCaller {
  principal: Principal;
  client?: string | undefined;
  /** Set by the broker's sign-in when the request carries a script token (never from a body). Such a caller reaches only a task's read here. */
  scriptToken?: { tokenId: string } | undefined;
}

/** What membership says about the caller: the company and the live role in it (never a token claim). */
export interface CompanyMembership {
  companyId: string;
  role: OrgRole;
}

/** What the deployment wires for one company. Each part is optional; a missing one answers `NOT_ON_THE_CORE_YET`. */
export interface CoreDevWiring {
  /** The session levels from the company's own records (lanes ID and T). Without it the session routes are not served (the laptop's default is the sole owner). */
  members?: SessionMembers;
  /** The decision cards' sources and performer (each checks the caller's live authority). */
  decisions?: DecisionRouteDependencies<DecisionCaller>;
  /** How we work, read through the company's code host. Served only with `canReadProject`. */
  playbook?: PlaybookService;
  /** Whether this person may read this project (their project grant from the company's own records). A project they may not read answers exactly like a missing one. */
  canReadProject?: (personId: string, project: string) => Promise<boolean>;
  /** Script tokens' list and revoke (the token store is the core's; the audit sink is the registry's). */
  scriptTokens?: { enabled?: () => boolean };
  /** The URL clients reach the API at (a session's `link`). */
  origin: () => string;
}

export interface CoreDevRoutesOptions {
  app: CoreHostApp;
  /** The caller's company and live role from membership, never a claim. Undefined: not a member (refused). */
  companyOf(caller: DeployedCaller): Promise<CompanyMembership | undefined>;
  /** The company's wiring, built once per company. */
  wiring(runtime: CoreRuntime): CoreDevWiring;
  log?: (entry: Record<string, unknown>) => void;
}

const json = (statusCode: number, value: unknown): BrokerResponse => ({ statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
const errorAnswer = (error: AgentXError): BrokerResponse => json(error.statusCode, { error: { code: error.code, message: error.message.slice(error.code.length + 2) } });
const ORG_ID = /^org_[0-9a-z]{20}$/u;
/** A token id from the path; a malformed escape is a token that does not exist. */
function tokenIdOf(raw: string): string {
  try { return decodeURIComponent(raw); } catch { throw agentXError("NOT_FOUND", "route not found"); }
}

/** Only the methods the core's handlers serve: anything else under these paths stays the old broker's (a playbook PUT is its editor's). */
function owns(path: string, method: string): boolean {
  if (TASK_READ.test(path) || PLAYBOOK.test(path)) return method === "GET";
  return SESSIONS.test(path) || DECISIONS.test(path) || SCRIPT_TOKENS.test(path);
}
const unauthenticated = (): BrokerResponse => json(401, { error: { code: "UNAUTHENTICATED", message: SIGN_IN_AGAIN } });

interface Mounted {
  runtime: CoreRuntime;
  blobs: ObjectStorage;
  wiring: CoreDevWiring;
  sessions?: ReturnType<typeof createSessionRoutes>;
  playbook?: ReturnType<typeof createLocalPlaybook>;
}

export function createCoreDevRoutes(options: CoreDevRoutesOptions): { route(request: BrokerRequest, caller: DeployedCaller): Promise<BrokerResponse | undefined> } {
  const mounted = new Map<string, Promise<Mounted>>();
  const mount = (companyId: string): Promise<Mounted> => {
    let found = mounted.get(companyId);
    if (found === undefined) {
      found = options.app.runtimeFor(companyId).then(async (runtime) => {
        const wiring = options.wiring(runtime);
        const blobs = (await options.app.registry()).require("object-storage");
        return {
          runtime, wiring, blobs,
          ...(wiring.members === undefined ? {} : { sessions: createSessionRoutes({ flow: runtime.flow, blobs, companyId: runtime.companyId, origin: wiring.origin, members: wiring.members }) }),
          ...(wiring.playbook === undefined ? {} : { playbook: createLocalPlaybook({ playbook: wiring.playbook, store: runtime.flow.deps.store, companyId: runtime.companyId }) }),
        };
      });
      found.catch(() => mounted.delete(companyId));
      mounted.set(companyId, found);
    }
    return found;
  };

  return {
    async route(request, caller) {
      // Off: nothing is read and nothing answers here.
      if (!options.app.serving) return undefined;
      const path = request.path.split("?")[0] ?? request.path;
      if (!owns(path, request.method)) return undefined;
      let membership: CompanyMembership | undefined;
      try {
        membership = await options.companyOf(caller);
      } catch {
        membership = undefined;
      }
      // Fail closed: no member company, a malformed one or an unknown role is a sign-in refusal, never the install's company.
      if (membership === undefined || membership === null || typeof membership !== "object" || typeof membership.companyId !== "string" || !ORG_ID.test(membership.companyId) || !OrgRoleSchema.safeParse(membership.role).success) return unauthenticated();
      const companyId = membership.companyId;
      // The principal the identity point vouched for must be of the member company (checked before anything is built for it); the task flow checks it again on every task read.
      if (caller.principal.companyId !== companyId) return unauthenticated();
      // A script token reaches only a task's read here (its closed list: its own projects' tasks); never sessions, decisions, playbooks or tokens.
      if (caller.scriptToken !== undefined && !TASK_READ.test(path)) return errorAnswer(agentXError("FORBIDDEN", NOT_FOR_SCRIPT_TOKENS));
      let target: Mounted;
      try {
        target = await mount(companyId);
      } catch (error) {
        // A company the switch does not send to the core and that holds no core task stays on the old broker.
        if (error instanceof Error && error.name === "CoreEngineOffError") return undefined;
        throw error;
      }
      const taskCaller: TaskCaller = { principal: caller.principal, ...(caller.client === undefined ? {} : { client: caller.client }) };
      try {
        if (SESSIONS.test(path)) {
          if (target.sessions === undefined) throw agentXError("NOT_FOUND", NOT_ON_THE_CORE_YET);
          return (await target.sessions(request, taskCaller)) ?? errorAnswer(agentXError("NOT_FOUND", "route not found"));
        }
        const task = TASK_READ.exec(path);
        if (task !== null) {
          if (request.method !== "GET") return undefined;
          // Another company's task, or none, answers the same "not found" (the flow's owned read checks the company).
          const record = await loadOwnedTask(target.runtime.flow.deps, taskCaller, task[1]!);
          return json(200, { task: await developerTaskView(record, await taskViewOf(target.runtime.flow.deps, record), target.blobs) });
        }
        if (DECISIONS.test(path)) {
          if (target.wiring.decisions === undefined) throw agentXError("NOT_FOUND", NOT_ON_THE_CORE_YET);
          // Reading the cards only: approve, reject, request changes and evidence-opened need a proof that a person on a recently signed-in page acts, and this API has none yet.
          if (request.method !== "GET") throw agentXError("FORBIDDEN", DECIDE_ON_A_PAGE);
          const url = new URL(request.path, "http://core");
          const reply = await routeDecisionCards(target.wiring.decisions, { orgId: companyId, developerId: developerIdOf(caller.principal) }, { method: request.method, pathname: path, searchParams: url.searchParams, body: {} });
          if (reply === undefined) throw agentXError("NOT_FOUND", "route not found");
          return json(reply.statusCode, reply.body);
        }
        const playbook = PLAYBOOK.exec(path);
        if (playbook !== null) {
          if (target.playbook === undefined || target.wiring.canReadProject === undefined) throw agentXError("NOT_FOUND", NOT_ON_THE_CORE_YET);
          // A project the person may not read, and one that does not exist, answer the same words.
          if (!(await target.wiring.canReadProject(caller.principal.personId, playbook[1]!).catch(() => false))) throw agentXError("NOT_FOUND", PROJECT_NOT_FOUND);
          const answer = (await target.playbook.routes(request)) ?? errorAnswer(agentXError("NOT_FOUND", PROJECT_NOT_FOUND));
          return answer.statusCode === 404 ? errorAnswer(agentXError("NOT_FOUND", PROJECT_NOT_FOUND)) : answer;
        }
        const tokens = SCRIPT_TOKENS.exec(path);
        if (tokens !== null) {
          const enabled = target.wiring.scriptTokens?.enabled ?? (() => scriptTokensEnabled());
          if (target.wiring.scriptTokens === undefined || !enabled()) throw agentXError("NOT_FOUND", "route not found");
          // Making a token needs a recently signed-in page; this API has no such credential (the question is open), so it is refused for every caller.
          if (tokens[1] === undefined && request.method === "POST") throw agentXError("FORBIDDEN", MAKE_SCRIPT_TOKEN_ON_A_PAGE);
          const deps = { store: target.runtime.flow.deps.store, audit: target.runtime.flow.deps.audit, now: () => (target.runtime.flow.deps.now?.() ?? new Date()).getTime() };
          // The live role from membership decides whether the list and revoke reach every token of the company (an administrator) or only the caller's own.
          const scriptCaller: ScriptTokenCaller = { developerId: developerIdOf(caller.principal), personId: caller.principal.personId, orgId: companyId, orgRole: membership.role };
          if (tokens[1] === undefined && request.method === "GET") return json(200, { tokens: await listScriptTokens(deps, scriptCaller, async (developerId) => (developerId === scriptCaller.developerId ? caller.principal.displayName : undefined)) });
          if (tokens[1] !== undefined && request.method === "POST") return json(200, { token: await revokeScriptToken(deps, scriptCaller, tokenIdOf(tokens[1])) });
          throw agentXError("NOT_FOUND", "route not found");
        }
        return undefined;
      } catch (error) {
        if (error instanceof AgentXError) return errorAnswer(error);
        throw error;
      }
    },
  };
}
