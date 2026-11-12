// Script tokens: who a request with `Authorization: Bearer rvst_...` is, and whether it may do what it asks. Runs before any route is matched, so a token reaches
// nothing but the closed list below: read the creator's own tasks on the token's projects, and start a task on one of them. Everything else, including every settings, token, decision, approval,
// merge and session route, is refused here with one fixed text, before any read. A token acts as its creator, with the creator's live role, and only while that role is the one it was made with
// and the creator is still the install's person: a token refused for a change in its creator's place is revoked at once, so it never comes back.
//
// A script token is NEVER an approval proof (owner decision L7A-1): no route on the list decides anything, and what this returns carries no page session, so it can neither ask a local page to
// open nor sign a proof. The core's approval gate is not reachable with one (a test walks the owner's routes with a token and expects the fixed refusal).
//
// Cloud checks more about the creator's sign-in (an admin's end of sign-ins, an unlinked method, a SAML cut-off, the edition's session cap). Those belong to Cloud's identity and edition and are not
// here: the identity port answers "is this person still here with this role", and an install with more to check says so by answering no.
import {
  SCRIPT_TOKEN_NOT_ALLOWED_MESSAGE, agentXError, companyScoped,
  type IdentityProvider, type OrgId, type OrgRole,
} from "@agentx/contracts";
import type { BrokerRequest } from "../../handler.js";
import { developerIdOf } from "../sessions/create.js";
import type { TaskCaller } from "../task-flow/deps.js";
import { startIdempotencyKey, taskKey } from "../task-flow/keys.js";
import { takeRate } from "./rate.js";
import { noteScriptTokenUse, readScriptToken, revokeForAccessChange, scriptTokenStatus, type ScriptTokenDependencies, type ScriptTokenRecord } from "./store.js";
import { scriptTokensEnabled } from "./switch.js";
import { parseScriptTokenHeader, scriptTokenMatches } from "./token-format.js";

/** Requests one token may make a minute, and task starts an hour. */
export const SCRIPT_TOKEN_REQUESTS_PER_MINUTE = 60;
export const SCRIPT_TOKEN_STARTS_PER_HOUR = 20;
/** The same limits across all of one person's tokens, so ten tokens are not ten times the rate. */
export const SCRIPT_TOKEN_CREATOR_REQUESTS_PER_MINUTE = 120;
export const SCRIPT_TOKEN_CREATOR_STARTS_PER_HOUR = 20;

const TASK_ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const TASK_READ = new RegExp(`^/v1/dev/tasks/(${TASK_ID})(?:/events)?$`, "u");
/** Decision 46b: a local coding tool reads the project-wide lessons of one project (`local/app/lessons-routes.ts`). The project is the path's. */
const LESSONS_READ = /^\/v1\/dev\/projects\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/lessons$/u;

/** What one allowed request is: the permission it needs and how its project is found. */
export type AllowedRoute =
  | { permission: "start"; project: "body" }
  | { permission: "read"; project: "query" }
  | { permission: "read"; project: "task"; taskId: string }
  | { permission: "lessons"; project: "path"; name: string };

/** The whole list of what a script token may call. Anything not here is refused. Exported for the test that pins it. */
export function scriptTokenRoute(method: string, pathname: string): AllowedRoute | undefined {
  if (pathname === "/v1/dev/tasks") {
    if (method === "POST") return { permission: "start", project: "body" };
    if (method === "GET") return { permission: "read", project: "query" };
    return undefined;
  }
  const lessons = method === "POST" ? LESSONS_READ.exec(pathname) : null;
  if (lessons !== null) return { permission: "lessons", project: "path", name: lessons[1]! };
  const read = method === "GET" ? TASK_READ.exec(pathname) : null;
  return read === null ? undefined : { permission: "read", project: "task", taskId: read[1]! };
}

/** What a script token's caller carries: the token, scoped. */
export interface ScriptTokenScope { tokenId: string; name: string; permissions: readonly ("read" | "start" | "lessons")[]; projects: readonly string[] }

export interface ScriptTokenAuthDependencies extends ScriptTokenDependencies {
  /** The install's company: a token of another company is refused as an unknown one. */
  companyId: OrgId;
  identity: Pick<IdentityProvider, "getPrincipal">;
  /** The install switch (`ROVARA_SCRIPT_TOKENS=0`). Default: `scriptTokensEnabled()`. */
  enabled?: () => boolean;
}

export interface AuthenticatedScriptToken {
  caller: TaskCaller & { scriptToken: ScriptTokenScope };
  /** The request as it will be served: a start's body names the one project that was checked. */
  request: BrokerRequest;
  /** For a list: the one project it may show. */
  listProject?: string;
}

const invalid = () => agentXError("AUTH_REQUIRED", "This script token isn't valid. Make a new one in Rovara's settings.");
const notAllowed = () => agentXError("FORBIDDEN", SCRIPT_TOKEN_NOT_ALLOWED_MESSAGE);

/** The role the identity port's person holds, in the closed set a record keeps. */
const roleOf = (roles: readonly string[]): OrgRole => (roles.includes("owner") ? "owner" : roles.includes("admin") ? "admin" : "member");

/** The body of a start as an object, or undefined. */
function bodyObject(request: BrokerRequest): Record<string, unknown> | undefined {
  if (request.body === undefined || request.body === "") return undefined;
  try {
    const value = JSON.parse(request.body) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

async function withinRate(deps: ScriptTokenAuthDependencies, name: string, sk: string, limit: number, windowMs: number, message: string, orgId: string): Promise<void> {
  if (!await takeRate(deps.store, { pk: companyScoped(orgId, name), sk }, limit, windowMs, deps.now)) throw agentXError("TOO_MANY_REQUESTS", message);
}

type CreatorCheck = { ok: true; principal: NonNullable<Awaited<ReturnType<IdentityProvider["getPrincipal"]>>> } | { ok: false; permanent: boolean };

/** Whether the creator still stands where they stood when they made the token. A refusal for a change in their place is permanent and revokes the token. */
async function creatorStillHolds(deps: ScriptTokenAuthDependencies, record: ScriptTokenRecord): Promise<CreatorCheck> {
  if (record.personId === undefined) return { ok: false, permanent: true };
  let principal;
  try {
    principal = await deps.identity.getPrincipal(record.orgId, record.personId);
  } catch {
    // The identity could not be read: this request is refused, the token is not judged.
    return { ok: false, permanent: false };
  }
  if (principal === undefined || developerIdOf(principal) !== record.developerId || roleOf(principal.roles) !== record.createdRole) return { ok: false, permanent: true };
  return { ok: true, principal };
}

/**
 * The caller a script token stands for, once every check passed: the switch is on, the token is well formed and matches its stored hash, it is not revoked or past its end, its creator still holds the
 * role they made it with, the request is on the list, the token has the permission and names the project, and the token is within its rate. Every refusal is final and fixed text: it never echoes the
 * token, the route or the project.
 */
export async function authenticateScriptToken(deps: ScriptTokenAuthDependencies, request: BrokerRequest): Promise<AuthenticatedScriptToken> {
  if (!(deps.enabled ?? scriptTokensEnabled)()) throw agentXError("AUTH_REQUIRED", "Script tokens are turned off here.");
  const parsed = parseScriptTokenHeader(request.headers.authorization);
  if (parsed === undefined || parsed.orgId !== deps.companyId) throw invalid();
  const record = await readScriptToken(deps, parsed.orgId, parsed.tokenId);
  if (record === undefined || !scriptTokenMatches(parsed.token, record.secretHash)) throw invalid();
  // The token's rate is taken as soon as it is known, so a revoked or refused token can't be replayed without limit.
  await withinRate(deps, "SCRIPT_TOKEN_RATE", record.tokenId, SCRIPT_TOKEN_REQUESTS_PER_MINUTE, 60_000, "This script token made too many requests. Try again in a minute.", record.orgId);
  const status = scriptTokenStatus(record, deps.now());
  if (status === "revoked") throw agentXError("AUTH_REQUIRED", "This script token was revoked.");
  if (status === "expired") throw agentXError("AUTH_REQUIRED", "This script token has expired. Make a new one in Rovara's settings.");
  const held = await creatorStillHolds(deps, record);
  if (!held.ok) {
    if (held.permanent) await revokeForAccessChange(deps, record);
    throw agentXError("AUTH_REQUIRED", "This script token stopped working because its creator's access changed. Make a new one in Rovara's settings.");
  }
  await withinRate(deps, "SCRIPT_TOKEN_CREATOR_RATE", record.developerId, SCRIPT_TOKEN_CREATOR_REQUESTS_PER_MINUTE, 60_000, "Your script tokens made too many requests. Try again in a minute.", record.orgId);

  const url = new URL(request.path, "http://local");
  // The router matches the raw path and this check reads the normalised one: a request whose two differ (`..`, `%2e`, a backslash, a tab, a fragment) is refused, so the two can never disagree about which route it is.
  if (request.path.split("?")[0] !== url.pathname || url.hash !== "") throw notAllowed();
  const route = scriptTokenRoute(request.method, url.pathname);
  if (route === undefined || !record.permissions.includes(route.permission)) throw notAllowed();
  const body = route.project === "body" ? bodyObject(request) : undefined;
  const named = route.project === "body" ? (typeof body?.["project"] === "string" ? body["project"] : undefined) : route.project === "query" ? url.searchParams.get("project") ?? undefined : route.project === "path" ? route.name : undefined;
  if (route.project !== "task" && (named === undefined || !record.projects.includes(named))) throw notAllowed();
  if (route.project === "task") {
    // A task outside the token's projects (or company) answers as a missing task does, so a token learns nothing about it.
    const task = await deps.store.get(taskKey(route.taskId));
    if (task === undefined || (task["companyId"] ?? task["orgId"]) !== record.orgId || typeof task["project"] !== "string" || !record.projects.includes(task["project"])) throw agentXError("NOT_FOUND", "task not found");
  }
  let served = request;
  if (route.permission === "start") {
    // A retry of a start already made (same request id, after a 503) starts nothing new, so it is not charged to the start limits again.
    const requestId = typeof body?.["requestId"] === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(body["requestId"]) ? body["requestId"] : undefined;
    const made = requestId !== undefined && record.personId !== undefined && await deps.store.get(startIdempotencyKey(record.personId, requestId)) !== undefined;
    if (!made) {
      await withinRate(deps, "SCRIPT_TOKEN_START_RATE", record.tokenId, SCRIPT_TOKEN_STARTS_PER_HOUR, 3_600_000, "This script token started too many tasks in the last hour. Try again later.", record.orgId);
      await withinRate(deps, "SCRIPT_TOKEN_CREATOR_START_RATE", record.developerId, SCRIPT_TOKEN_CREATOR_STARTS_PER_HOUR, 3_600_000, "Your script tokens started too many tasks in the last hour. Try again later.", record.orgId);
    }
    // The body names the one project that was checked (a body with two `project` keys starts where it was checked); the start's client is the token's own fixed one, set by the flow.
    served = { ...request, body: JSON.stringify({ ...body, project: named }) };
  }
  await noteScriptTokenUse(deps, record, route.permission);
  const scope: ScriptTokenScope = { tokenId: record.tokenId, name: record.name, permissions: record.permissions, projects: record.projects };
  return { caller: { principal: held.principal, scriptToken: scope }, request: served, ...(route.project === "query" && named !== undefined ? { listProject: named } : {}) };
}
