// script tokens on `rovara up`. A script token lets the owner's own scripts and CI (on this computer: the server listens on 127.0.0.1 only) read their tasks and start tasks on chosen
// projects without the owner's session token. The token is a scoped, revocable, expiring credential that is stored only as a hash and is shown once.
//
// Who may do what:
//  - A token reaches ONLY the closed list in `core/script-tokens/authenticate.ts` (read the creator's tasks on its projects, start a task on one of them). It is never an approval: no route on the
//    list decides anything, a token cannot open a page, make, list or revoke a token, and the model proxy and the worker callbacks have listeners and keys of their own.
//  - MAKING a token needs a local page the owner opened a few minutes ago (a form, one use): the API session token (which an AI tool may hold) is refused, as Cloud refuses everything but a fresh live
//    browser session. A long-lived credential must not be makeable by the credential that could be a program's.
//  - LISTING and REVOKING are open to the API session token: they show names and hints (never a secret) and revoking only ends a credential.
import { AgentXError, agentXError, type CreatedScriptToken, type IdentityProvider, type OrgId, type Principal, type ScriptTokenView } from "@agentx/contracts";
import {
  auditScriptTokenStart, authenticateScriptToken, createScriptToken, listScriptTokens, revokeAllScriptTokens, revokeScriptToken, scriptTokensEnabled,
  type ScriptTokenCaller, type ScriptTokenDependencies,
} from "../../core/script-tokens/index.js";
import { developerIdOf } from "../../core/sessions/create.js";
import type { TaskCaller } from "../../core/task-flow/deps.js";
import type { BrokerRequest, BrokerResponse } from "../../handler.js";
import { listProjects } from "./projects.js";

const json = (statusCode: number, value: unknown): BrokerResponse => ({ statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
const errorAnswer = (error: AgentXError): BrokerResponse => json(error.statusCode, { error: { code: error.code, message: error.message.slice(error.code.length + 2) } });

export const MAKE_ON_THE_PAGE = "A script token is made on its local page, in your browser (run `rovara token create`): it is a long-lived credential, so a tool that holds the API token cannot make one.";

export interface LocalScriptTokens {
  readonly enabled: () => boolean;
  /** Serves one request that carries a script token: checks the token and the closed list, runs the route as the token's creator, and audits a start. */
  serve(request: BrokerRequest, routes: (request: BrokerRequest, caller: TaskCaller) => Promise<BrokerResponse | undefined>): Promise<BrokerResponse>;
  /** The settings routes (`/v1/app/script-tokens...`) for the API session token. `undefined`: not one of ours (or the feature is off). */
  routes(request: BrokerRequest): Promise<BrokerResponse | undefined>;
  list(): Promise<ScriptTokenView[]>;
  /** The projects a token can be made for. */
  projects(): Promise<string[]>;
  create(body: unknown): Promise<CreatedScriptToken>;
  revoke(tokenId: string): Promise<ScriptTokenView>;
  /** Called at start with the switch off: ends every live token, so turning the switch back on never revives one. */
  revokeAllForSwitchOff(): Promise<number>;
}

export interface LocalScriptTokensOptions extends ScriptTokenDependencies {
  companyId: OrgId;
  owner: Principal;
  identity: Pick<IdentityProvider, "getPrincipal">;
  enabled?: () => boolean;
}

export function createLocalScriptTokens(options: LocalScriptTokensOptions): LocalScriptTokens {
  const enabled = options.enabled ?? (() => scriptTokensEnabled());
  const caller = (): ScriptTokenCaller => ({
    developerId: developerIdOf(options.owner), personId: options.owner.personId, orgId: options.companyId,
    orgRole: options.owner.roles.includes("owner") ? "owner" : options.owner.roles.includes("admin") ? "admin" : "member",
  });
  const deps: ScriptTokenDependencies = { store: options.store, audit: options.audit, now: options.now, ...(options.log === undefined ? {} : { log: options.log }) };
  const projects = async (): Promise<string[]> => (await listProjects(options.store, options.companyId)).map((project) => project.name).sort();
  const requireOn = (): void => { if (!enabled()) throw agentXError("NOT_FOUND", "route not found"); };
  const self: LocalScriptTokens = {
    enabled,
    projects,
    async list() {
      requireOn();
      return listScriptTokens(deps, caller(), async (developerId) => (developerId === developerIdOf(options.owner) ? options.owner.displayName : undefined));
    },
    async create(body) {
      requireOn();
      const known = new Set(await projects());
      // A token is made only for projects registered here; the project's own access rules are the install's (one owner, who reaches them all).
      return createScriptToken(deps, caller(), body, async (project) => { if (!known.has(project)) throw agentXError("NOT_FOUND", "project not found"); });
    },
    async revoke(tokenId) {
      requireOn();
      return revokeScriptToken(deps, caller(), tokenId);
    },
    async revokeAllForSwitchOff() {
      return enabled() ? 0 : revokeAllScriptTokens(deps, options.companyId);
    },
    async serve(request, routes) {
      try {
        const authenticated = await authenticateScriptToken({ ...deps, companyId: options.companyId, identity: options.identity, enabled }, request);
        const answer = await routes(authenticated.request, authenticated.caller);
        if (answer === undefined) return json(404, { error: { code: "NOT_FOUND", message: "route not found" } });
        // A start that answered is audited by itself, naming the token and the task. If that write fails the script retries with its request id and gets the same task back.
        if (request.method === "POST" && answer.statusCode >= 200 && answer.statusCode < 300) {
          const taskId = (JSON.parse(answer.body) as { task?: { taskId?: unknown } } | null)?.task?.taskId;
          if (typeof taskId === "string") await auditScriptTokenStart(deps, { orgId: options.companyId, tokenId: authenticated.caller.scriptToken.tokenId, developerId: developerIdOf(authenticated.caller.principal) }, taskId);
        }
        return answer;
      } catch (error) {
        if (error instanceof AgentXError) return errorAnswer(error);
        throw error;
      }
    },
    async routes(request) {
      const path = request.path.split("?")[0] ?? request.path;
      if (path !== "/v1/app/script-tokens" && !/^\/v1\/app\/script-tokens\/[^/]+\/revoke$/u.test(path)) return undefined;
      if (!enabled()) return undefined;
      try {
        if (path === "/v1/app/script-tokens" && request.method === "GET") return json(200, { tokens: await self.list() });
        // Making one is the page's, never this route's, even for a caller that holds the API token.
        if (path === "/v1/app/script-tokens" && request.method === "POST") throw agentXError("FORBIDDEN", MAKE_ON_THE_PAGE);
        const revoke = /^\/v1\/app\/script-tokens\/([^/]+)\/revoke$/u.exec(path);
        if (revoke !== null && request.method === "POST") return json(200, { token: await self.revoke(decodeURIComponent(revoke[1]!)) });
        throw agentXError("NOT_FOUND", "route not found");
      } catch (error) {
        if (error instanceof AgentXError) return errorAnswer(error);
        throw error;
      }
    },
  };
  return self;
}
