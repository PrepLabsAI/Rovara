// R1 + L1 (6.1): "Connect your Linear account" on a member's own profile, and a company admin's list of who linked. A member links the Linear account that is theirs to THEMSELVES, so a ticket that
// account assigns to Rovara or labels `rovara` can start work as them (core/intake). The proof is Linear's own sign-in (the company's OAuth app, `actor=user`, scope `read`; the same callback as the
// company's connection), read for ONE fact: who the person is on Linear and which workspace they signed in to. The user token is held in memory for that one read and dropped; only the account id,
// the workspace id and the display text Linear showed are kept (core/people/account-links.ts), under the company.
//
//   GET    /v1/dev/me/tracker-accounts/linear                    the caller's own link: { connected, linked, display?, linkedAt? } (`connected`: the company has a connected Linear workspace)
//   POST   /v1/dev/me/tracker-accounts/linear/link   {}                       a single-use state and Linear's consent address
//   POST   /v1/dev/me/tracker-accounts/linear/link/claim  { state, code }     spend the state, check Linear, link the account to the caller
//   DELETE /v1/dev/me/tracker-accounts/linear                                 unlink the caller's own account
//   GET    /v1/dev/company/linear/people                         owner/admin: who linked (member, Linear display name, date)
//   DELETE /v1/dev/company/linear/people/{personId}              owner/admin: remove one member's link (audited; for an offboarding or a mistake)
//
// Rules (the common brief's shared security rules, as the GitHub link routes, github-account-link-routes.ts):
//   - The person's own routes need the Rovara web app's own sign-in client (`caller.webApp`): another full-access client could show Linear's page to someone else and pass the code back, which
//     would link that someone's account to this person. Cloud's cookie binding is the only tie between the browser at Linear and the person, and it is the web app's.
//   - The company and the person are the caller's LIVE membership (read at every call, start AND claim), never a body, query, header or token claim. NO route links or unlinks anyone else's account:
//     the admin can only REMOVE a link.
//   - The account is the one Linear's own answer for the person who completed the sign-in names (`viewer`), never an id the browser sends. The state is 32 random bytes stored only as sha256 with
//     company, person, session, its own key family and provider, and a 10-minute expiry, spent once conditionally on all of those; a state of the company's connection flow never works here and the
//     reverse. The PKCE verifier is sealed beside it and never leaves Code.
//   - Everything before the code exchange succeeds is ONE answer (403 LINK_START_AGAIN, "Start again from Rovara."), so nothing tells whether a state exists. After the Linear check: 409 when the
//     account is in another workspace than the company's connected one (EXTERNAL_ACCOUNT_OTHER_WORKSPACE), is another member's of this company (EXTERNAL_ACCOUNT_TAKEN, first link wins) or the caller
//     already holds a different one (EXTERNAL_ACCOUNT_LINK_EXISTS); idempotent 200 when it is already theirs.
//   - The company's own token is never used here, and the user's token is never stored, logged or returned. It is not revoked either, until the phase 0 revoke proof shows revoking a user token
//     leaves the company connected (plan change 6): it lives minutes and is dropped.
//   - Never logged or returned: the code, the state, the verifier, the user token. The claim's answer names the Linear display text to the person who just proved it is theirs; log lines carry event
//     names and person ids only; audit rows never carry the Linear id or name.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { AgentXError, agentXError, companyLog, OrgIdSchema, type DocumentStore } from "@agentx/contracts";
import { listAccountLinks, personAccountLink, linkAccount, unlinkAccount } from "../core/people/account-links.js";
import { Membership, membershipKey } from "./company-check.js";
import type { DeveloperCaller } from "./developer-routes.js";
import type { AdaptedHttpRequest } from "./lambda.js";
import { LINEAR_LINK_PROVIDER } from "./linear-account-links.js";
import { LINEAR_NEEDS_RECONNECT, LINEAR_NOT_CONNECTED, type LinearAppSettings, type LinearConnections } from "./linear-connections.js";
import { exchangeLinearCode, linearLinkAuthorizeUrl, linearViewerOf, type LinearTokens } from "./linear-oauth-client.js";

export const LINEAR_ME_PATH = "/v1/dev/me/tracker-accounts/linear";
export const LINEAR_PEOPLE_PATH = "/v1/dev/company/linear/people";
const LINK = `${LINEAR_ME_PATH}/link`;
const CLAIM = `${LINEAR_ME_PATH}/link/claim`;
const PERSON_PATH = /^\/v1\/dev\/company\/linear\/people\/([^/]+)$/u;

export const LINK_START_AGAIN = "Start again from Rovara.";
export const LINK_NOT_SET_UP = "Connecting your Linear account isn't set up on this Rovara yet. Ask the Rovara team.";
export const LINK_UNAVAILABLE = "Your Linear account could not be connected just now. Start again from Rovara.";
export const LINK_WEB_ONLY = "Connecting your Linear account is done in the Rovara web app.";
export const LINK_TAKEN = "This Linear account is already connected to another member of your company.";
export const LINK_HAS_ANOTHER = "You already have a Linear account connected. Disconnect it first.";
export const LINK_OTHER_WORKSPACE = "That Linear account is in a different workspace than your company's. Sign in to your company's Linear workspace and try again.";
export const LINK_READ_UNAVAILABLE = "Your Linear connection could not be read just now; try again.";
export const UNLINK_UNAVAILABLE = "Your Linear account could not be disconnected just now; try again.";
export const PEOPLE_ADMIN_ONLY = "Only a company owner or admin can see or remove Linear links.";
export const PEOPLE_UNAVAILABLE = "The company's Linear links could not be read just now; try again.";
const SIGN_IN_AGAIN = "your AgentX sign-in has ended; run agentx login <url> again";

export interface LinearLinkWiring {
  connections: Pick<LinearConnections, "connection" | "mintLinkState" | "spendLinkState">;
  /** The link rows (the core's own store, the State table). */
  links: Pick<DocumentStore, "get" | "delete" | "transact" | "query">;
  /** The app's settings (client id and secret, redirect), or undefined when not set up. */
  app: () => Promise<LinearAppSettings | undefined>;
  /** The Linear HTTP seam (tests: a fake Linear). */
  fetch: typeof fetch;
  log: (entry: Record<string, unknown>) => void;
}

export interface LinearLinkContext {
  documentClient: { send(command: unknown): Promise<unknown> };
  /** The sign-in table (memberships, people). */
  signInTableName: string;
  now: () => number;
  wiring: LinearLinkWiring;
}

/** Whether this module answers the path (the dispatcher sends it here before anything is read). */
export function isLinearAccountLinkPath(path: string): boolean {
  return path === LINEAR_ME_PATH || path === LINK || path === CLAIM || path === LINEAR_PEOPLE_PATH || PERSON_PATH.test(path);
}

const Secret = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const NoBody = z.object({}).strict();
const ClaimBody = z.object({ state: Secret, code: z.string().regex(/^[A-Za-z0-9._~-]{1,512}$/) }).strict();
const PersonId = z.string().regex(/^[a-f0-9]{64}$/);

const startAgain = () => agentXError("LINK_START_AGAIN", LINK_START_AGAIN);

function body(request: AdaptedHttpRequest): unknown {
  if (request.body === undefined || request.body === "") return {};
  try { return JSON.parse(request.body) as unknown; } catch { return undefined; }
}

/** The caller's live membership in `companyId`, or 401. Any role: linking one's own account is every member's. */
async function liveMembership(ctx: LinearLinkContext, caller: DeveloperCaller, companyId: string): Promise<z.infer<typeof Membership>> {
  try {
    const response = await ctx.documentClient.send(new GetCommand({ TableName: ctx.signInTableName, Key: membershipKey(caller.developerId), ConsistentRead: true })) as { Item?: unknown };
    const member = Membership.parse(response.Item);
    if (member.personId !== caller.developerId || member.companyId !== companyId || member.revokedAt !== undefined || !OrgIdSchema.safeParse(companyId).success) throw new Error("membership");
    return member;
  } catch { throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN); }
}

/** The company's connected workspace (its id), or the company's own not-connected refusal. A connection that needs reconnecting is the reconnect refusal. */
async function connectedWorkspace(ctx: LinearLinkContext, companyId: string): Promise<string> {
  let row: Awaited<ReturnType<LinearLinkWiring["connections"]["connection"]>>;
  try { row = await ctx.wiring.connections.connection(companyId); } catch { throw agentXError("RUNTIME_UNAVAILABLE", LINK_READ_UNAVAILABLE); }
  if (row === undefined || row.status === "disconnected") throw agentXError("LINEAR_NOT_CONNECTED", LINEAR_NOT_CONNECTED);
  if (row.status !== "connected") throw agentXError("LINEAR_NOT_CONNECTED", LINEAR_NEEDS_RECONNECT);
  return row.organizationId;
}

/**
 * The routes. The caller is authenticated and its route row (`full`) applied; `companyId` is its live membership's company (resolveCompany). The membership row is read again here, so a role or
 * company that changed since is what counts.
 */
export async function routeLinearAccountLink(ctx: LinearLinkContext, caller: DeveloperCaller, companyId: string, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  // A session that is not a sign-in session (a registered service's own token has none) is never a person acting for themselves.
  if (caller.sessionId === "") throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  const member = await liveMembership(ctx, caller, companyId);
  const person = PERSON_PATH.exec(url.pathname);
  if (person !== null || url.pathname === LINEAR_PEOPLE_PATH) return peopleRoute(ctx, member, caller.developerId, person?.[1], request);
  return ownRoute(ctx, member, caller, request, url);
}

interface Own {
  ctx: LinearLinkContext;
  who: { companyId: string; personId: string; sessionId: string };
  log: (entry: Record<string, unknown>) => void;
}

async function ownRoute(ctx: LinearLinkContext, member: z.infer<typeof Membership>, caller: DeveloperCaller, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  // Only the Rovara web app's own sign-in client (full access AND marked `webApp` by the operator).
  if (caller.webApp !== true) throw agentXError("FORBIDDEN", LINK_WEB_ONLY);
  const own: Own = { ctx, who: { companyId: member.companyId, personId: caller.developerId, sessionId: caller.sessionId }, log: companyLog(member.companyId, ctx.wiring.log) };
  if (url.pathname === LINEAR_ME_PATH && request.method === "GET") return readOwn(own);
  if (url.pathname === LINEAR_ME_PATH && request.method === "DELETE") return unlinkOwn(own, request);
  if (url.pathname === LINK && request.method === "POST") return startLink(own, request);
  if (url.pathname === CLAIM && request.method === "POST") return claimLink(own, request);
  throw agentXError("NOT_FOUND", "not found");
}

/** The caller's own link, only in the workspace the company is connected to now. */
async function readOwn({ ctx, who }: Own): Promise<unknown> {
  try {
    const connection = await ctx.wiring.connections.connection(who.companyId);
    if (connection === undefined) return { connected: false as const, linked: false as const };
    const connected = connection.status === "connected";
    const link = await personAccountLink(ctx.wiring.links, who.companyId, who.personId, LINEAR_LINK_PROVIDER);
    if (link === undefined || link.tenant !== connection.organizationId) return { connected, linked: false as const };
    return { connected, linked: true as const, display: link.display, linkedAt: link.linkedAt };
  } catch { throw agentXError("RUNTIME_UNAVAILABLE", LINK_READ_UNAVAILABLE); }
}

async function unlinkOwn({ ctx, who, log }: Own, request: AdaptedHttpRequest): Promise<unknown> {
  if (!NoBody.safeParse(body(request)).success) throw agentXError("CONFIG_INVALID", "disconnecting your Linear account takes no body");
  let removed: boolean;
  try {
    const at = new Date(ctx.now()).toISOString();
    removed = await unlinkAccount(ctx.wiring.links, who.companyId, who.personId, LINEAR_LINK_PROVIDER, { audit: { at, actor: who.personId, by: "self" } });
  } catch { throw agentXError("RUNTIME_UNAVAILABLE", UNLINK_UNAVAILABLE); }
  if (removed) log({ event: "tracker.account_unlinked", provider: LINEAR_LINK_PROVIDER, by: "self", actor: who.personId });
  return { unlinked: removed };
}

async function startLink({ ctx, who }: Own, request: AdaptedHttpRequest): Promise<unknown> {
  if (!NoBody.safeParse(body(request)).success) throw agentXError("CONFIG_INVALID", "connecting your Linear account takes no body");
  await connectedWorkspace(ctx, who.companyId);
  const app = await ctx.wiring.app().catch(() => undefined);
  if (app === undefined) throw agentXError("RUNTIME_UNAVAILABLE", LINK_NOT_SET_UP);
  let minted: { state: string; verifier: string; expiresAt: number };
  try { minted = await ctx.wiring.connections.mintLinkState(who); } catch { throw agentXError("RUNTIME_UNAVAILABLE", LINK_UNAVAILABLE); }
  return { state: minted.state, expiresAt: new Date(minted.expiresAt * 1000).toISOString(), authorizeUrl: linearLinkAuthorizeUrl(app, minted.state, minted.verifier) };
}

/** Spends the state, exchanges the code and reads who the person is on Linear. Every refusal before the exchange succeeds is the one answer. The user token is dropped when this returns. */
async function linearViewerOfClaim({ ctx, who }: Own, request: AdaptedHttpRequest): Promise<Awaited<ReturnType<typeof linearViewerOf>>> {
  const parsed = ClaimBody.safeParse(body(request));
  if (!parsed.success) throw startAgain();
  const verifier = await ctx.wiring.connections.spendLinkState(parsed.data.state, who);
  if (verifier === undefined) throw startAgain();
  const app = await ctx.wiring.app().catch(() => undefined);
  if (app === undefined) throw agentXError("RUNTIME_UNAVAILABLE", LINK_NOT_SET_UP);
  let tokens: LinearTokens;
  try { tokens = await exchangeLinearCode({ fetch: ctx.wiring.fetch, app, code: parsed.data.code, verifier, now: ctx.now() }); } catch { throw startAgain(); }
  // The user token is used for this one read and then dropped (never stored, logged or returned).
  try { return await linearViewerOf({ fetch: ctx.wiring.fetch, access: tokens.access }); } catch { throw agentXError("RUNTIME_UNAVAILABLE", LINK_UNAVAILABLE); }
}

async function claimLink(own: Own, request: AdaptedHttpRequest): Promise<unknown> {
  const { ctx, who, log } = own;
  const { connections, links } = ctx.wiring;
  const viewer = await linearViewerOfClaim(own, request);
  // The workspace the person signed in to must be the one the company is connected to NOW (read again here).
  const workspace = await connectedWorkspace(ctx, who.companyId);
  if (viewer.organizationId !== workspace) throw agentXError("EXTERNAL_ACCOUNT_OTHER_WORKSPACE", LINK_OTHER_WORKSPACE);
  let outcome: Awaited<ReturnType<typeof linkAccount>>;
  try {
    const at = new Date(ctx.now()).toISOString();
    outcome = await linkAccount(links, {
      companyId: who.companyId, provider: LINEAR_LINK_PROVIDER, tenant: workspace, accountId: viewer.id, personId: who.personId, display: viewer.name, linkedAt: at,
      audit: { at, actor: who.personId, by: "self" },
    });
  } catch { throw agentXError("RUNTIME_UNAVAILABLE", LINK_UNAVAILABLE); }
  if (outcome === "taken") throw agentXError("EXTERNAL_ACCOUNT_TAKEN", LINK_TAKEN);
  if (outcome === "person_has_another") throw agentXError("EXTERNAL_ACCOUNT_LINK_EXISTS", LINK_HAS_ANOTHER);
  if (outcome === "linked") {
    // An owner's disconnect that landed while the claim ran has already swept the links: a link written after it is removed again, so nothing outlives the connection it was made under.
    const after = await connections.connection(who.companyId).catch(() => undefined);
    if (after === undefined || after.organizationId !== workspace) {
      await unlinkAccount(links, who.companyId, who.personId, LINEAR_LINK_PROVIDER).catch(() => undefined);
      throw agentXError("LINEAR_NOT_CONNECTED", LINEAR_NOT_CONNECTED);
    }
    log({ event: "tracker.account_linked", provider: LINEAR_LINK_PROVIDER, by: "self", actor: who.personId });
  }
  return { status: "linked" as const, alreadyLinked: outcome === "same", account: { display: viewer.name } };
}

/** A person's name, only while they are still a member of the company (never the name of someone who left). */
async function memberName(ctx: LinearLinkContext, companyId: string, personId: string): Promise<string | undefined> {
  const membership = await ctx.documentClient.send(new GetCommand({ TableName: ctx.signInTableName, Key: membershipKey(personId), ConsistentRead: true })) as { Item?: unknown };
  const still = Membership.safeParse(membership.Item);
  if (!still.success || still.data.personId !== personId || still.data.companyId !== companyId || still.data.revokedAt !== undefined) return undefined;
  const row = await ctx.documentClient.send(new GetCommand({ TableName: ctx.signInTableName, Key: { pk: `DEVELOPER#${personId}`, sk: "META" }, ConsistentRead: true })) as { Item?: { displayName?: unknown } };
  const display = row.Item?.displayName;
  return typeof display === "string" && display.length > 0 && display.length <= 200 ? display : undefined;
}

/** The company's links: a live company owner or admin only. A list names who linked; a removal drops one member's link and writes an audit row naming the admin. */
async function peopleRoute(ctx: LinearLinkContext, member: z.infer<typeof Membership>, adminId: string, rawPerson: string | undefined, request: AdaptedHttpRequest): Promise<unknown> {
  if (member.role !== "owner" && member.role !== "admin") throw agentXError("FORBIDDEN", PEOPLE_ADMIN_ONLY);
  if (rawPerson === undefined && request.method === "GET") return listPeople(ctx, member.companyId);
  if (rawPerson !== undefined && request.method === "DELETE") return removePerson(ctx, member.companyId, adminId, rawPerson, request);
  throw agentXError("NOT_FOUND", "not found");
}

async function listPeople(ctx: LinearLinkContext, companyId: string): Promise<unknown> {
  try {
    const connection = await ctx.wiring.connections.connection(companyId);
    if (connection === undefined) return { connected: false as const, people: [] };
    // Only links made in the workspace the company is connected to now.
    const rows = (await listAccountLinks(ctx.wiring.links, companyId, LINEAR_LINK_PROVIDER)).filter((link) => link.tenant === connection.organizationId);
    const people = [];
    for (const link of rows) {
      const name = await memberName(ctx, companyId, link.personId);
      people.push({ personId: link.personId, ...(name === undefined ? {} : { name }), display: link.display, linkedAt: link.linkedAt });
    }
    return { connected: connection.status === "connected", people };
  } catch (error) {
    if (error instanceof AgentXError) throw error;
    throw agentXError("RUNTIME_UNAVAILABLE", PEOPLE_UNAVAILABLE);
  }
}

async function removePerson(ctx: LinearLinkContext, companyId: string, adminId: string, rawPerson: string, request: AdaptedHttpRequest): Promise<unknown> {
  const personId = PersonId.safeParse(rawPerson);
  if (!personId.success) throw agentXError("NOT_FOUND", "not found");
  if (!NoBody.safeParse(body(request)).success) throw agentXError("CONFIG_INVALID", "removing a Linear link takes no body");
  let removed: boolean;
  try {
    const at = new Date(ctx.now()).toISOString();
    removed = await unlinkAccount(ctx.wiring.links, companyId, personId.data, LINEAR_LINK_PROVIDER, { audit: { at, actor: adminId, by: "admin" } });
  } catch { throw agentXError("RUNTIME_UNAVAILABLE", UNLINK_UNAVAILABLE); }
  if (removed) companyLog(companyId, ctx.wiring.log)({ event: "tracker.account_unlinked", provider: LINEAR_LINK_PROVIDER, by: "admin", actor: adminId, person: personId.data });
  return { unlinked: removed };
}
