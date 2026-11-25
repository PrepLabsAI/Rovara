// Guided onboarding PR 7 (design section 3d; DEC 254l items 2 and 5): a company connects Linear by OAuth, Rovara acting as the app, and picks a Linear team per project.
//
//   POST   /v1/dev/company/linear/connect               {}                owner/admin: a single-use state and Linear's consent address (PKCE S256, actor=app)
//   POST   /v1/dev/company/linear/complete              { state, code }   owner/admin: spend the state, exchange the code, read the workspace, bind it, store the tokens
//   GET    /v1/dev/company/linear                                         any member: the connection's status, workspace, who connected it and when (never a token)
//   DELETE /v1/dev/company/linear                                         owner: revoke, unbind, clear every team pick, remove every member's own Linear link, name the projects that had one
//   GET    /v1/dev/company/linear/projects/{project}                      owner/admin or the project's admin: the project's team and the teams the company's token can see
//   PUT    /v1/dev/company/linear/projects/{project}    { teamId }        owner/admin or the project's admin: set the project's team (one the company's token can see)
//   DELETE /v1/dev/company/linear/projects/{project}                      owner/admin or the project's admin: clear the project's team
//
// Rules (design section 3, the common brief's shared security rules), as the GitHub connect routes (github-connect-routes.ts):
//   - Company and role are the caller's LIVE membership, read at every call (start AND complete); never a body, query, header or token claim.
//   - State: 32 random bytes, stored only as sha256 with company, person, session, provider "linear" and a 10-minute expiry; spent once, conditionally on all of those.
//     The PKCE verifier is kept beside it, sealed; it never leaves Code.
//   - Everything before the code exchange succeeds is ONE answer (403 "Start again from Rovara."). After it: 409 when the workspace is another company's, or the company is
//     already connected to another workspace; in both cases the tokens just issued are revoked and nothing is stored.
//   - Only this company's connection (and so its token) is ever used for this company's projects: the company is the caller's, never named by the request.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { agentXError, AgentXError, AgentXNameSchema, ON_THE_WEBSITE_MESSAGE, OrgIdSchema, type DocumentStore } from "@agentx/contracts";
import { Membership, membershipKey } from "./company-check.js";
import type { DeveloperCaller } from "./developer-routes.js";
import type { AdaptedHttpRequest } from "./lambda.js";
import { LINEAR_LINK_PROVIDER } from "./linear-account-links.js";
import { isLinearAccountLinkPath } from "./linear-account-link-routes.js";
import { unlinkProviderForCompany } from "../core/people/account-links.js";
import { exchangeLinearCode, linearAuthorizeUrl, linearTeamsOf, linearWorkspaceOf, revokeLinearToken, type LinearTokens, type LinearWorkspace } from "./linear-oauth-client.js";
import { LINEAR_NEEDS_RECONNECT, LINEAR_NOT_CONNECTED, type LinearAppSettings, type LinearConnections } from "./linear-connections.js";

export const LINEAR_CONNECT_PATH = "/v1/dev/company/linear";
export const START_AGAIN = "Start again from Rovara.";
export const LINEAR_TAKEN = "This Linear workspace is already connected to a different Rovara company.";
export const LINEAR_OTHER_WORKSPACE = "This company is already connected to another Linear workspace. A company owner can disconnect it first, then connect again.";
export const CONNECT_ADMIN_ONLY = "Only a company owner or admin can connect Linear.";
export const CONNECT_NOT_SET_UP = "Connecting Linear isn't set up on this Rovara yet. Ask the Rovara team.";
export const CONNECT_UNAVAILABLE = "Linear could not be connected just now. Start again from Rovara.";
export const STATUS_UNAVAILABLE = "The company's Linear connection could not be read just now; try again.";
export const DISCONNECT_OWNER_ONLY = "Only a company owner can disconnect Linear.";
export const DISCONNECT_UNAVAILABLE = "Linear could not be disconnected just now; try again.";
export const TEAM_ADMIN_ONLY = "Only a company owner or admin, or the project's admin, can choose its Linear team.";
export const PROJECT_NOT_FOUND = "project not found";
/** A team starts work in one project: another project of the company already picked it. */
async function refuseTeamOfAnotherProject(connections: Pick<LinearConnectWiring["connections"], "teamPicks">, companyId: string, project: string, teamId: string): Promise<void> {
  let picks: Awaited<ReturnType<LinearConnectWiring["connections"]["teamPicks"]>>;
  try { picks = await connections.teamPicks(companyId); } catch { throw agentXError("RUNTIME_UNAVAILABLE", STATUS_UNAVAILABLE); }
  if (picks.some((other) => other.project !== project && other.teamId.toLowerCase() === teamId.toLowerCase())) throw agentXError("LINEAR_TEAM_TAKEN", TEAM_TAKEN);
}

/** The team is another project's. */
export const TEAM_TAKEN = "That Linear team is already used by another project. A team can start work in one project only.";
export const TEAM_NOT_FOUND = "That Linear team was not found in the company's Linear workspace.";
export const TEAMS_UNAVAILABLE = "Linear's teams could not be read just now; try again.";
const SIGN_IN_AGAIN = "your AgentX sign-in has ended; run agentx login <url> again";

export interface LinearConnectWiring {
  connections: Pick<LinearConnections, "mintState" | "spendState" | "connection" | "bindAndStore" | "accessToken" | "teamPick" | "teamPicks" | "setTeam" | "clearTeam" | "disconnect">;
  /** The app's settings (client id and secret, redirect, webhook secret), or undefined when not set up. */
  app: () => Promise<LinearAppSettings | undefined>;
  /** The Linear HTTP seam (tests: a fake Linear). */
  fetch: typeof fetch;
  log: (entry: Record<string, unknown>) => void;
  /** R1 + L1: where the members' own Linear links live (the core's own store). With it, a disconnect removes every link of the company. Absent: the install has none. */
  links?: Pick<DocumentStore, "get" | "delete" | "transact" | "query">;
}

export interface LinearConnectContext {
  documentClient: { send(command: unknown): Promise<unknown> };
  /** The sign-in table (memberships, people). */
  signInTableName: string;
  now: () => number;
  wiring: LinearConnectWiring;
  /** Whether the project exists AND is this company's (its latest revision's company). */
  projectInCompany: (project: string, companyId: string) => Promise<boolean>;
  /** The person's grant on the project, read only within the company. */
  projectRole: (project: string, personId: string, companyId: string) => Promise<"administrator" | "developer" | undefined>;
  /**
   * Called once a project got its FIRST Linear team (it had none before), for the company's own project: the host saves the new-hosted-project ticket-updates default if none is saved. Best effort: a failure is logged by
   * name and the project stays on the default of every existing project (status only).
   */
  onFirstTeam?: ((companyId: string, project: string, personId: string) => Promise<void>) | undefined;
}

const CONNECT = `${LINEAR_CONNECT_PATH}/connect`;
const COMPLETE = `${LINEAR_CONNECT_PATH}/complete`;
const PROJECT_PATH = /^\/v1\/dev\/company\/linear\/projects\/([^/]+)$/;

/** Whether this module answers the path (the dispatcher sends it here before anything is read). */
export function isLinearConnectPath(path: string): boolean {
  // R1 + L1: the member's own link routes and the admin's list of links are the same family; the developer dispatcher's Linear branch splits them off (linearConnectRoute).
  return path === LINEAR_CONNECT_PATH || path === CONNECT || path === COMPLETE || PROJECT_PATH.test(path) || isLinearAccountLinkPath(path);
}

const Secret = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const ConnectBody = z.object({}).strict();
const CompleteBody = z.object({ state: Secret, code: z.string().regex(/^[A-Za-z0-9._~-]{1,512}$/) }).strict();
const TeamBody = z.object({ teamId: z.string().regex(/^[A-Za-z0-9-]{1,100}$/) }).strict();

const startAgain = () => agentXError("FORBIDDEN", START_AGAIN);

function body(request: AdaptedHttpRequest): unknown {
  if (request.body === undefined || request.body === "") return {};
  try { return JSON.parse(request.body) as unknown; } catch { return undefined; }
}

/** The caller's live membership in `companyId`, or 401. */
async function liveMembership(ctx: LinearConnectContext, caller: DeveloperCaller, companyId: string): Promise<z.infer<typeof Membership>> {
  try {
    const response = await ctx.documentClient.send(new GetCommand({ TableName: ctx.signInTableName, Key: membershipKey(caller.developerId), ConsistentRead: true })) as { Item?: unknown };
    const member = Membership.parse(response.Item);
    if (member.personId !== caller.developerId || member.companyId !== companyId || member.revokedAt !== undefined || !OrgIdSchema.safeParse(companyId).success) throw new Error("membership");
    return member;
  } catch { throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN); }
}

const isAdmin = (member: z.infer<typeof Membership>) => member.role === "admin" || member.role === "owner";

/**
 * R1 + L1: removes every member link of the company's Linear workspace (a stale link that revived on a later reconnect would be a hidden identity grant). `throws`: the caller decides whether the
 * failure stops what it is doing (a disconnect, before it changes anything) or is only logged by name (a sweep after the fact).
 */
async function sweepLinks(ctx: LinearConnectContext, companyId: string): Promise<void> {
  if (ctx.wiring.links === undefined) return;
  await unlinkProviderForCompany(ctx.wiring.links, companyId, LINEAR_LINK_PROVIDER);
}

/** The same sweep after the fact: a failure is one fixed log line (names only) and never undoes or blocks what already happened. */
async function sweepLinksQuietly(ctx: LinearConnectContext, companyId: string): Promise<void> {
  try { await sweepLinks(ctx, companyId); } catch { ctx.wiring.log({ companyId, event: "linear.account_links_not_removed" }); }
}

/** A disconnect's first step: if the links cannot be removed nothing else changes (the owner tries again). */
async function sweepLinksBeforeDisconnect(ctx: LinearConnectContext, companyId: string): Promise<void> {
  try { await sweepLinks(ctx, companyId); } catch { throw agentXError("RUNTIME_UNAVAILABLE", DISCONNECT_UNAVAILABLE); }
}

/** A FIRST connection starts with no member link: whatever an earlier workspace's links left (a failed sweep at its disconnect) goes now. A reconnect keeps them. */
async function sweepLinksOnFirstConnect(ctx: LinearConnectContext, companyId: string, outcome: "connected" | "reconnected"): Promise<void> {
  if (outcome === "connected") await sweepLinksQuietly(ctx, companyId);
}

/** Revokes tokens Linear just issued that Rovara will not keep (best effort; logged by name only). */
async function discard(ctx: LinearConnectContext, companyId: string, tokens: LinearTokens): Promise<void> {
  for (const [token, hint] of [[tokens.refresh, "refresh_token"], [tokens.access, "access_token"]] as const) {
    if (!await revokeLinearToken({ fetch: ctx.wiring.fetch, token, hint })) ctx.wiring.log({ companyId, event: "linear.revoke_failed" });
  }
}

/**
 * The routes. The caller is authenticated and its route row (`full`) applied; `companyId` is its live membership's company (resolveCompany). The membership row is read again
 * here, so a role or company that changed since is what counts.
 */
export async function routeLinearConnect(ctx: LinearConnectContext, caller: DeveloperCaller, companyId: string, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  const member = await liveMembership(ctx, caller, companyId);
  const who = { companyId: member.companyId, personId: caller.developerId, sessionId: caller.sessionId };

  const project = PROJECT_PATH.exec(url.pathname);
  if (project !== null) return projectRoute(ctx, member, caller.developerId, project[1]!, request);

  if (url.pathname === LINEAR_CONNECT_PATH) {
    if (request.method === "GET") return readStatus(ctx, member.companyId);
    if (request.method === "DELETE") return disconnect(ctx, member, caller.developerId, caller.webApp === true);
    throw agentXError("NOT_FOUND", "not found");
  }
  if (request.method !== "POST") throw agentXError("NOT_FOUND", "not found");

  if (url.pathname === CONNECT) {
    if (!isAdmin(member)) throw agentXError("FORBIDDEN", CONNECT_ADMIN_ONLY);
    if (!ConnectBody.safeParse(body(request)).success) throw agentXError("CONFIG_INVALID", "connecting Linear takes no body");
    const app = await ctx.wiring.app().catch(() => undefined);
    if (app === undefined) throw agentXError("RUNTIME_UNAVAILABLE", CONNECT_NOT_SET_UP);
    let minted: { state: string; verifier: string; expiresAt: number };
    try { minted = await ctx.wiring.connections.mintState(who); } catch { throw agentXError("RUNTIME_UNAVAILABLE", CONNECT_UNAVAILABLE); }
    return { state: minted.state, expiresAt: new Date(minted.expiresAt * 1000).toISOString(), authorizeUrl: linearAuthorizeUrl(app, minted.state, minted.verifier) };
  }

  if (url.pathname === COMPLETE) {
    // Every refusal before the code exchange succeeds is the one answer.
    if (!isAdmin(member)) throw startAgain();
    const parsed = CompleteBody.safeParse(body(request));
    if (!parsed.success) throw startAgain();
    const verifier = await ctx.wiring.connections.spendState(parsed.data.state, who);
    if (verifier === undefined) throw startAgain();
    const app = await ctx.wiring.app().catch(() => undefined);
    if (app === undefined) throw agentXError("RUNTIME_UNAVAILABLE", CONNECT_NOT_SET_UP);
    let tokens: LinearTokens;
    try { tokens = await exchangeLinearCode({ fetch: ctx.wiring.fetch, app, code: parsed.data.code, verifier, now: ctx.now() }); } catch { throw startAgain(); }
    let workspace: LinearWorkspace;
    try { workspace = await linearWorkspaceOf({ fetch: ctx.wiring.fetch, access: tokens.access }); }
    catch { await discard(ctx, member.companyId, tokens); throw agentXError("RUNTIME_UNAVAILABLE", CONNECT_UNAVAILABLE); }
    let outcome: Awaited<ReturnType<LinearConnectWiring["connections"]["bindAndStore"]>>;
    try { outcome = await ctx.wiring.connections.bindAndStore(member.companyId, caller.developerId, workspace, tokens); }
    catch { await discard(ctx, member.companyId, tokens); throw agentXError("RUNTIME_UNAVAILABLE", CONNECT_UNAVAILABLE); }
    if (outcome.outcome === "taken") { await discard(ctx, member.companyId, tokens); throw agentXError("LINEAR_WORKSPACE_TAKEN", LINEAR_TAKEN); }
    if (outcome.outcome === "other_workspace") { await discard(ctx, member.companyId, tokens); throw agentXError("LINEAR_WORKSPACE_TAKEN", LINEAR_OTHER_WORKSPACE); }
    await sweepLinksOnFirstConnect(ctx, member.companyId, outcome.outcome);
    return { status: "connected" as const, reconnected: outcome.outcome === "reconnected", workspace: { id: workspace.id, name: workspace.name, urlKey: workspace.urlKey } };
  }
  throw agentXError("NOT_FOUND", "not found");
}

/** Any member: the company's connection, who connected it and when. No token, ever; a name only of someone still in the company. */
async function readStatus(ctx: LinearConnectContext, companyId: string): Promise<unknown> {
  let row: Awaited<ReturnType<LinearConnectWiring["connections"]["connection"]>>;
  try { row = await ctx.wiring.connections.connection(companyId); } catch { throw agentXError("RUNTIME_UNAVAILABLE", STATUS_UNAVAILABLE); }
  if (row === undefined) return { status: "disconnected" as const };
  let name: string | undefined;
  try {
    const membership = await ctx.documentClient.send(new GetCommand({ TableName: ctx.signInTableName, Key: membershipKey(row.connectedBy), ConsistentRead: true })) as { Item?: unknown };
    const still = Membership.safeParse(membership.Item);
    if (still.success && still.data.personId === row.connectedBy && still.data.companyId === companyId && still.data.revokedAt === undefined) {
      const person = await ctx.documentClient.send(new GetCommand({ TableName: ctx.signInTableName, Key: { pk: `DEVELOPER#${row.connectedBy}`, sk: "META" }, ConsistentRead: true })) as { Item?: { displayName?: unknown } };
      const display = person.Item?.displayName;
      if (typeof display === "string" && display.length > 0 && display.length <= 200) name = display;
    }
  } catch { throw agentXError("RUNTIME_UNAVAILABLE", STATUS_UNAVAILABLE); }
  return {
    status: row.status, statusAt: row.statusAt,
    workspace: { id: row.organizationId, name: row.workspaceName, urlKey: row.urlKey },
    connectedAt: row.connectedAt, connectedBy: { personId: row.connectedBy, ...(name === undefined ? {} : { name }) },
  };
}

/** A live owner, before anything is read; then the store's conditional disconnect (revoke, unbind, clear picks). */
async function disconnect(ctx: LinearConnectContext, member: z.infer<typeof Membership>, personId: string, webApp: boolean): Promise<unknown> {
  if (member.role !== "owner") throw agentXError("FORBIDDEN", DISCONNECT_OWNER_ONLY);
  // Owner DEC 254zzz99: a disconnect is made only from the Rovara website's own client (never the CLI's or an AI tool's token), after the owner rule.
  if (!webApp) throw agentXError("FORBIDDEN", ON_THE_WEBSITE_MESSAGE);
  // R1 + L1: the members' links go FIRST: if they cannot be removed nothing else changes (the owner tries again), so a disconnected company never keeps a link that a later reconnect would revive.
  await sweepLinksBeforeDisconnect(ctx, member.companyId);
  let outcome: Awaited<ReturnType<LinearConnectWiring["connections"]["disconnect"]>>;
  try { outcome = await ctx.wiring.connections.disconnect(member.companyId, personId); } catch { throw agentXError("RUNTIME_UNAVAILABLE", DISCONNECT_UNAVAILABLE); }
  if (outcome.outcome === "not_found") throw agentXError("LINEAR_NOT_CONNECTED", LINEAR_NOT_CONNECTED);
  // A link claimed while the disconnect ran is swept again once the connection is gone.
  await sweepLinksQuietly(ctx, member.companyId);
  return { status: "disconnected" as const, workspaceName: outcome.workspaceName, projects: outcome.projects };
}

/** The teams the company's own token can see (a missing or refused connection says so; Linear unavailable is a 503). */
async function companyTeams(ctx: LinearConnectContext, companyId: string) {
  let access: string;
  try { access = await ctx.wiring.connections.accessToken(companyId); }
  catch (error) {
    if (error instanceof AgentXError && error.code === "LINEAR_NOT_CONNECTED") throw error;
    throw agentXError("RUNTIME_UNAVAILABLE", TEAMS_UNAVAILABLE);
  }
  try { return await linearTeamsOf({ fetch: ctx.wiring.fetch, access }); } catch { throw agentXError("RUNTIME_UNAVAILABLE", TEAMS_UNAVAILABLE); }
}

/**
 * A project's Linear team. Company owner/admin, or the project's own admin (a grant read within the company). The project must be this company's: another company's and
 * a missing one are the same 404; a project member who is not its admin gets the fixed 403.
 */
async function projectRoute(ctx: LinearConnectContext, member: z.infer<typeof Membership>, personId: string, rawProject: string, request: AdaptedHttpRequest): Promise<unknown> {
  if (request.method !== "GET" && request.method !== "PUT" && request.method !== "DELETE") throw agentXError("NOT_FOUND", "not found");
  let project: string;
  try { project = decodeURIComponent(rawProject); } catch { throw agentXError("NOT_FOUND", PROJECT_NOT_FOUND); }
  if (!AgentXNameSchema.safeParse(project).success) throw agentXError("NOT_FOUND", PROJECT_NOT_FOUND);
  const companyId = member.companyId;
  let inCompany: boolean; let role: "administrator" | "developer" | undefined;
  try { [inCompany, role] = await Promise.all([ctx.projectInCompany(project, companyId), isAdmin(member) ? Promise.resolve(undefined) : ctx.projectRole(project, personId, companyId)]); }
  catch { throw agentXError("RUNTIME_UNAVAILABLE", STATUS_UNAVAILABLE); }
  if (!inCompany) throw agentXError("NOT_FOUND", PROJECT_NOT_FOUND);
  if (!isAdmin(member)) {
    if (role === undefined) throw agentXError("NOT_FOUND", PROJECT_NOT_FOUND);
    if (role !== "administrator") throw agentXError("FORBIDDEN", TEAM_ADMIN_ONLY);
  }
  const { connections } = ctx.wiring;
  if (request.method === "DELETE") {
    let cleared: boolean;
    try { cleared = await connections.clearTeam(companyId, project, personId); } catch { throw agentXError("RUNTIME_UNAVAILABLE", STATUS_UNAVAILABLE); }
    return { project, team: null, cleared };
  }
  if (request.method === "GET") {
    const teams = await companyTeams(ctx, companyId);
    let pick: Awaited<ReturnType<LinearConnectWiring["connections"]["teamPick"]>>;
    try { pick = await connections.teamPick(companyId, project); } catch { throw agentXError("RUNTIME_UNAVAILABLE", STATUS_UNAVAILABLE); }
    return { project, team: pick === undefined ? null : { id: pick.teamId, key: pick.teamKey, name: pick.teamName }, teams };
  }
  const parsed = TeamBody.safeParse(body(request));
  if (!parsed.success) throw agentXError("CONFIG_INVALID", "choosing a Linear team takes { teamId }");
  let connection: Awaited<ReturnType<LinearConnectWiring["connections"]["connection"]>>;
  try { connection = await connections.connection(companyId); } catch { throw agentXError("RUNTIME_UNAVAILABLE", STATUS_UNAVAILABLE); }
  if (connection === undefined || connection.status === "disconnected") throw agentXError("LINEAR_NOT_CONNECTED", LINEAR_NOT_CONNECTED);
  if (connection.status !== "connected") throw agentXError("LINEAR_NOT_CONNECTED", LINEAR_NEEDS_RECONNECT);
  // The team must be one the company's OWN token sees now: a team id from anywhere else (another company's workspace) is not found.
  const team = (await companyTeams(ctx, companyId)).find((candidate) => candidate.id === parsed.data.teamId);
  if (team === undefined) throw agentXError("NOT_FOUND", TEAM_NOT_FOUND);
  // A team starts work in ONE project: a ticket in a team two projects pick would start (and be paid for) twice.
  await refuseTeamOfAnotherProject(connections, companyId, project, team.id);
  // Whether this is the project's first team (a read that fails counts as "had one": nothing is seeded).
  const hadTeam = ctx.onFirstTeam === undefined ? true : await connections.teamPick(companyId, project).then((pick) => pick !== undefined, () => true);
  try { await connections.setTeam(companyId, project, team, personId, connection); }
  catch (error) {
    if (error instanceof AgentXError && error.code === "LINEAR_NOT_CONNECTED") throw error;
    throw agentXError("RUNTIME_UNAVAILABLE", STATUS_UNAVAILABLE);
  }
  if (!hadTeam) await ctx.onFirstTeam!(companyId, project, personId).catch(() => { ctx.wiring.log({ event: "linear.ticket_updates_default_failed", companyId }); });
  return { project, team: { id: team.id, key: team.key, name: team.name } };
}
