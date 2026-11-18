// Lead 4, step L4-AK1H: the HOSTED twin of the laptop's team knowledge routes. A tool OUTSIDE Rovara (`agentx mcp` with the engineer's own sign-in, or a script token) asks a hosted install what the team has taught Rovara:
//
//   POST /v1/dev/projects/{project}/lessons          { task?, files?, stage?, repo? }      at most 10 units and 2 KB: approved and live units the WHOLE project may read, for the repository named
//   POST /v1/dev/projects/{project}/knowledge/areas  { repo? }                              the table of contents: project > repository > top folder, counts only
//
// The request and the answer are the laptop's (`contracts/src/lessons-local-tools.ts`), and so is every rule, because the rules are not copied: both doors call ONE implementation (`lessons/knowledge-serve.ts` over the one
// gate in `lessons/local-tools.ts`): the per-minute rate, the project's existence, 300 reads a day per person (fail closed, counted before anything is read), no `all`, one audit record per answer with unit ids only (written BEFORE
// the answer), the once-a-day admin notice above 150 distinct units, the company's "knowledge stays in Rovara" switch, the project's own switch and the Regulated preset. What is HOSTED here is who is asking and for which company:
//   - A PERSON (their own sign-in, the CLI's token): the company comes ONLY from live membership (`companyOf`), never from a path, a query, a body or a claim; they must be on the project's roster NOW (`people.onProjectRoster`).
//   - A SCRIPT TOKEN (`Authorization: Bearer rvst_...`), authenticated by `authenticateToken` (the token's stored hash, not revoked or expired, its creator still holding the role it was made with, the route on the token list, the
//     `lessons` permission ("Team knowledge") and the project named in the token): the company is the TOKEN'S OWN (its id says where its record is), and its creator must be on the project's roster now. The token reaches only
//     these two reads here; a token on any other route is refused before anything is read.
//   - The answer is always the whole-project view (never the person's wider view): what a tool reads ends up in a model vendor's chat.
//   - The company comes first and isolates everything: the lessons, the limits, the audit and the notice are the member company's own (`lessonsOf(companyId)`, whose every key is under that company's partition). Another company's
//     project, a project the person is not on, and a project that does not exist all answer "No such project." (the same words, so project names cannot be probed).
//   - The switch (`ROVARA_CORE_LESSONS`) is read like the lessons API's: where it does not cover the company, the answer is the laptop's fixed "off" answer, and nothing is read.
//   - Refusals are fixed words; nothing a caller sent is echoed.
import { AgentXError, AgentXNameSchema, OrgIdSchema, OrgRoleSchema, agentXError, type AuditSink, type DocumentStore, type IdentityProvider, type OrgId, type OrgRole } from "@agentx/contracts";
import { queueAdminNotice } from "../core/notify/attention.js";
import { authenticateScriptToken } from "../core/script-tokens/authenticate.js";
import { parseScriptTokenHeader } from "../core/script-tokens/token-format.js";
import { createKnowledgeServer, knowledgeOffAnswer, type KnowledgeTool } from "../lessons/knowledge-serve.js";
import type { HostedLessonPeople } from "../lessons/hosted-people.js";
import { peopleOf, type Lesson } from "../lessons/types.js";
import type { ScopeKey } from "../lessons/store.js";
import { knowledgeReadStores } from "../local/app/lessons-routes.js";
import { switchCovers, type CoreSwitch } from "./flags.js";
import type { LessonsApiCompany } from "./lessons-api.js";

const SIGN_IN_AGAIN = "Sign in again.";
const UNAVAILABLE = "Rovara can't read lessons right now. Try again.";
const NO_SUCH_PROJECT = "No such project.";
const ROUTE_NOT_FOUND = "route not found";
/** At most this many people's names are looked up in one call (the laptop's limit): over it, nothing is returned. */
const MAX_NAME_LOOKUPS = 300;

/** The paths this API serves (one regex, so the route table's tests read the paths from it). */
const KNOWLEDGE_API = /^\/v1\/dev\/projects\/([^/]+)\/(?:lessons|knowledge\/areas)$/u;

/** The tool a method and path are, or undefined: not this API's. */
export function knowledgeToolOf(method: string, path: string): KnowledgeTool | undefined {
  if (method !== "POST") return undefined;
  const match = KNOWLEDGE_API.exec(path);
  return match === null ? undefined : path.endsWith("/knowledge/areas") ? "areas" : "lessons";
}

/** A script token that was authenticated: the company it belongs to, the person who made it (its limits are theirs) and what it may do. */
export interface KnowledgeTokenCaller {
  companyId: string;
  personId: string;
  token: { readonly tokenId: string; readonly permissions: readonly string[]; readonly projects: readonly string[] };
}

export interface KnowledgeRequest {
  method: string;
  path: string;
  /** The raw Authorization header: only a script token authentication reads it. */
  authorization?: string | undefined;
  body?: string | undefined;
}

/** Who is asking: a signed-in person (the broker's sign-in vouched for them), or a script token (checked here, by `authenticateToken`). */
export type KnowledgeCaller = { kind: "person"; personId: string } | { kind: "token" };

export interface KnowledgeApiOptions {
  /** The install's lessons switch (`readCoreLessonsSwitch`). */
  lessonsSwitch: CoreSwitch;
  /** The person's company and their live role in it, from membership. Undefined, malformed or a throw: sign in again. */
  companyOf(caller: { personId: string }): Promise<{ companyId: string; role: OrgRole } | undefined>;
  /** The lessons of a company the switch covers (built once per company by the deployment). Undefined: lessons are off for it. */
  lessonsOf(companyId: OrgId): Promise<LessonsApiCompany | undefined>;
  /** The same people port the company's lessons were built with (roster and names, for this company only). */
  people: Pick<HostedLessonPeople, "onProjectRoster" | "approvers" | "projectMembers">;
  /**
   * Authenticates a request that carries a script token: throws the token refusals (fixed words), or answers who it is. Absent: a script token is refused (script tokens are not served on this install).
   */
  authenticateToken?: ((request: KnowledgeRequest) => Promise<KnowledgeTokenCaller>) | undefined;
  /** The people to tell, once a day, that one person's tools were served an unusual amount (the company's owners and admins now, as the ids notices are addressed by). Absent or a throw: the audit record alone says it. */
  adminsOf?: ((companyId: OrgId) => Promise<readonly string[]>) | undefined;
  now: () => number;
  log?: ((entry: Record<string, unknown>) => void) | undefined;
}

export interface KnowledgeApi {
  /** The answer's body; refusals are thrown as `AgentXError` (fixed words). */
  answer(request: KnowledgeRequest, caller: KnowledgeCaller): Promise<unknown>;
}

/** The fixed "off" answer for a request to one of this API's paths, for a deployment that wires no knowledge API (the lessons are off there). Reads nothing. */
export function knowledgeSwitchedOff(request: Pick<KnowledgeRequest, "method" | "path">, now: number): unknown {
  const tool = knowledgeToolOf(request.method, request.path);
  const match = KNOWLEDGE_API.exec(request.path);
  if (tool === undefined || match === null) throw agentXError("NOT_FOUND", ROUTE_NOT_FOUND);
  let project: string;
  try { project = decodeURIComponent(match[1]!); } catch { throw agentXError("NOT_FOUND", NO_SUCH_PROJECT); }
  if (!AgentXNameSchema.safeParse(project).success) throw agentXError("NOT_FOUND", NO_SUCH_PROJECT);
  return knowledgeOffAnswer(tool, project, now);
}

/**
 * The script token authenticator the hosted install gives the knowledge API. The company is the TOKEN'S own (its id says where its record is), and only a company the lessons switch covers is looked up at all (a made-up company
 * id builds nothing). The token is then checked in full against that company's own token store and identity (`authenticateScriptToken`: its hash, not revoked or expired, its creator read live and still holding the role
 * it was made with, the route on the token list, the `lessons` permission and the project in the token's own list). Every refusal is fixed words.
 */
export function scriptTokenAuthenticator(options: {
  lessonsSwitch: CoreSwitch;
  /** One company's own store, audit sink and identity. Throws when the company has none here (the token is then refused like an unknown one). */
  companyOf(companyId: OrgId): Promise<{ store: DocumentStore; audit: AuditSink; identity: Pick<IdentityProvider, "getPrincipal"> }>;
  now: () => number;
  enabled?: (() => boolean) | undefined;
}): (request: KnowledgeRequest) => Promise<KnowledgeTokenCaller> {
  const refused = (): AgentXError => agentXError("AUTH_REQUIRED", "This script token isn't valid. Make a new one in Rovara's settings.");
  return async (request) => {
    const parsed = parseScriptTokenHeader(request.authorization);
    if (parsed === undefined || options.lessonsSwitch.mode === "off" || !switchCovers(options.lessonsSwitch, parsed.orgId)) throw refused();
    let company: Awaited<ReturnType<typeof options.companyOf>>;
    try { company = await options.companyOf(parsed.orgId); } catch { throw refused(); }
    const authenticated = await authenticateScriptToken(
      { store: company.store, audit: company.audit, now: options.now, companyId: parsed.orgId, identity: company.identity, ...(options.enabled === undefined ? {} : { enabled: options.enabled }) },
      { method: request.method, path: request.path, headers: { authorization: request.authorization }, ...(request.body === undefined ? {} : { body: request.body }) },
    );
    return { companyId: parsed.orgId, personId: authenticated.caller.principal.personId, token: authenticated.caller.scriptToken };
  };
}

const notFound = (message: string): AgentXError => agentXError("NOT_FOUND", message);

export function createKnowledgeApi(options: KnowledgeApiOptions): KnowledgeApi {
  const log = (event: string, fields: Record<string, unknown> = {}): void => options.log?.({ component: "knowledge-api", event, ...fields });
  /** One server per company, built on first use: its limits and counters are over that company's own store. */
  const servers = new Map<string, ReturnType<typeof createKnowledgeServer>>();

  async function membershipOf(personId: string): Promise<{ companyId: OrgId; role: OrgRole }> {
    let found: unknown;
    try { found = await options.companyOf({ personId }); } catch { found = undefined; }
    const record = found as { companyId?: unknown; role?: unknown } | undefined | null;
    const companyId = OrgIdSchema.safeParse(record?.companyId);
    const role = OrgRoleSchema.safeParse(record?.role);
    if (!companyId.success || !role.success) throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
    return { companyId: companyId.data, role: role.data };
  }

  function serverOf(lessons: LessonsApiCompany) {
    const have = servers.get(lessons.companyId);
    if (have !== undefined) return have;
    const runtime = lessons.runtime;
    const companyId = lessons.companyId;
    const { limits, counter } = knowledgeReadStores(runtime.documents, options.now);
    const made = createKnowledgeServer({
      companyId, store: runtime.documents, now: options.now, runtime, limits, counter,
      // The display names a unit that leaves Rovara must not hold: the person asking, the people of the units asked about, the project's approvers (its maintainers and the company's owners), and the whole roster where the port
      // lists it. A list that cannot be completed, a name that cannot be read, or too many people throws (nothing is returned).
      names: async (developerId: string, key: ScopeKey, found: readonly Lesson[]) => {
        const ids = new Set<string>([developerId]);
        for (const lesson of found) for (const id of peopleOf(lesson)) ids.add(id);
        const approvers = await options.people.approvers(companyId as OrgId, key.project);
        if (!approvers.complete) throw new Error("the project's approvers are not complete");
        for (const id of [...approvers.ownerIds, ...approvers.eligibleIds]) ids.add(id);
        if (options.people.projectMembers !== undefined) {
          const roster = await options.people.projectMembers(companyId as OrgId, key.project);
          if (!roster.complete) throw new Error("the project's roster is not complete");
          for (const id of roster.ids) ids.add(id);
        }
        if (ids.size > MAX_NAME_LOOKUPS) throw new Error("too many people to look up");
        const names: string[] = [];
        for (const id of ids) {
          const name = await runtime.routes.names.memberName(key.workspaceId, id);
          if (name !== undefined) names.push(name);
        }
        return names;
      },
      projectExists: lessons.projectExists,
      tellAdmins: async (notice) => {
        // The audit alert is already written (by the shared server); this only queues the notice for the company's admins now, in the company's own store. Fail closed: nobody known, nobody told.
        const admins = options.adminsOf === undefined ? [] : await options.adminsOf(companyId as OrgId);
        if (admins.length === 0) return;
        await queueAdminNotice({ store: runtime.documents, now: () => new Date(options.now()), log: (entry) => log("notice_log", { event: entry["event"] }) }, { orgId: companyId, developerIds: admins, noticeId: notice.noticeId, kind: "knowledge_read" });
      },
      log: (entry) => options.log?.(entry),
    });
    servers.set(companyId, made);
    return made;
  }

  async function answer(request: KnowledgeRequest, caller: KnowledgeCaller): Promise<unknown> {
    const tool = knowledgeToolOf(request.method, request.path);
    const match = KNOWLEDGE_API.exec(request.path);
    if (tool === undefined || match === null) throw notFound(ROUTE_NOT_FOUND);
    let project: string;
    try { project = decodeURIComponent(match[1]!); } catch { throw notFound(NO_SUCH_PROJECT); }
    if (!AgentXNameSchema.safeParse(project).success) throw notFound(NO_SUCH_PROJECT);

    // The switch first: off reads nothing at all, not even who is asking (a script token is not looked up either).
    if (options.lessonsSwitch.mode === "off") return knowledgeOffAnswer(tool, project, options.now());
    // Who is asking, and which company: a token is the token's own (checked in full by the authenticator); a person is their live membership.
    let companyId: OrgId;
    let personId: string;
    let token: KnowledgeTokenCaller["token"] | undefined;
    if (caller.kind === "token") {
      if (options.authenticateToken === undefined) throw agentXError("AUTH_REQUIRED", "Script tokens are turned off here.");
      const who = await options.authenticateToken(request);
      const company = OrgIdSchema.safeParse(who.companyId);
      if (!company.success || typeof who.personId !== "string" || who.personId === "") throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
      companyId = company.data;
      personId = who.personId;
      token = who.token;
    } else {
      personId = caller.personId;
      companyId = (await membershipOf(personId)).companyId;
    }
    if (!switchCovers(options.lessonsSwitch, companyId)) return knowledgeOffAnswer(tool, project, options.now());
    let lessons: LessonsApiCompany | undefined;
    try { lessons = await options.lessonsOf(companyId); } catch { throw agentXError("RUNTIME_UNAVAILABLE", UNAVAILABLE); }
    if (lessons === undefined) return knowledgeOffAnswer(tool, project, options.now());
    // The lessons handed back must be the company's own: anything else is a wiring fault, refused before any read.
    if (lessons.companyId !== companyId) throw agentXError("RUNTIME_UNAVAILABLE", UNAVAILABLE);

    // The project's roster, read live and for this person (a token's creator): a person who was removed from the project, or is not on it, is told what a missing project is told.
    let onRoster: boolean;
    try { onRoster = await options.people.onProjectRoster(companyId, project, personId); } catch { throw agentXError("RUNTIME_UNAVAILABLE", UNAVAILABLE); }
    if (!onRoster) throw notFound(NO_SUCH_PROJECT);

    try {
      return await serverOf(lessons).read({ project, developerId: personId, tool, body: request.body, ...(token === undefined ? {} : { token }) });
    } catch (error) {
      if (error instanceof AgentXError) throw error;
      log("failed", { error: error instanceof Error ? error.name : "unknown" });
      throw agentXError("RUNTIME_UNAVAILABLE", UNAVAILABLE);
    }
  }

  return {
    async answer(request, caller) {
      try { return await answer(request, caller); }
      catch (error) {
        if (error instanceof AgentXError) throw error;
        log("failed", { error: error instanceof Error ? error.name : "unknown" });
        throw agentXError("RUNTIME_UNAVAILABLE", UNAVAILABLE);
      }
    },
  };
}
