// Guided onboarding PR 1 (designs-2026-10-30/guided-onboarding-design.md section 3a; DEC 254l item 3): a company owner or admin connects the company's
// GitHub App installation, and Code binds it only after the person proved, with a GitHub user authorization, that they control that installation.
//
//   POST /v1/dev/company/github/connect   {}                                              owner/admin: a single-use state and the two GitHub addresses
//   POST /v1/dev/company/github/claim     { state, code?, installationId?, setupAction? }  owner/admin: spend the state, check GitHub, bind or list
//   POST /v1/dev/company/github/choose    { ticket, installationId }                      owner/admin: bind one installation from a claim's checked list
//   GET  /v1/dev/company/github                                                           any member: the company's bound installations (no tokens), each with its status
//   DELETE /v1/dev/company/github/{installationId}                                        owner + fresh step-up: unbind (guided onboarding PR 3)
//
// Rules (design section 3, the common brief's shared security rules):
//   - The company and role are the caller's LIVE membership (sign-in table), read at every call; never a body, query, header or token claim.
//   - State and ticket: 32 random bytes, stored only as sha256 with company, person, session, provider and a 10-minute expiry; spent once, conditionally
//     on all of those. Cloud also binds the state to its own cookie.
//   - The installation id GitHub's redirect carries is NOT trusted: the GitHub user token from `code` must show the person controls it
//     (plugins/code-host/github/user-authorization.ts: their own User account, or an Organization where they are an active admin) and that it is this App's.
//     The user token is never stored, logged or returned.
//   - Everything before that check passes is ONE answer (403 "Start again from Rovara."), so nothing tells whether an id exists or is bound.
//     After it: 409 when the installation is another company's; idempotent 200 when it is already this company's.
//   - Binding: GithubInstallationBindings.claimPerson (conditional, first binder wins, audit row naming the person) plus a company log line.
//   - Guided onboarding PR 3 (design section 3a "Wrong org", "Uninstalled or suspended"; DEC 254l item 2): each installation's status (active, suspended, uninstalled: GitHub's
//     webhook marks it, github-lifecycle.ts); a claim of this company's uninstalled or suspended installation reconnects it. Disconnect: a LIVE owner with a fresh step-up
//     (step-up-check.ts, as the member routes), refused (409, naming only this company's projects) while any of the company's projects uses a repository on it; another
//     company's installation and an unknown one are the same 404; otherwise one conditional transaction unbinds it with an audit row naming the person, and the answer carries
//     GitHub's page where the installation itself is removed.
import { createHash, randomBytes } from "node:crypto";
import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { agentXError, companyLog, OrgIdSchema, CLI_COMMAND_NAME } from "@agentx/contracts";
import { Membership, membershipKey } from "./company-check.js";
import { githubUninstallUrl, projectsUsingInstallation } from "./github-lifecycle.js";
import { requireFreshStepUp, type CallerStepUp } from "./step-up-check.js";
import type { DeveloperCaller } from "./developer-routes.js";
import type { AdaptedHttpRequest } from "./lambda.js";
import type { ControlledInstallation } from "../plugins/code-host/github/user-authorization.js";
import type { GithubInstallationBindings, PersonClaimOutcome } from "./github-credentials.js";

export const GITHUB_CONNECT_PATH = "/v1/dev/company/github";
export const START_AGAIN = "Start again from Rovara.";
export const GITHUB_TAKEN = "This GitHub account is already connected to a different Rovara company.";
export const CONNECT_ADMIN_ONLY = "Only a company owner or admin can connect GitHub.";
export const CONNECT_NOT_SET_UP = "Connecting GitHub isn't set up on this Rovara yet. Ask the Rovara team.";
export const CONNECT_UNAVAILABLE = "GitHub could not be connected just now. Start again from Rovara.";
export const CONNECTIONS_UNAVAILABLE = "The company's GitHub connections could not be read just now; try again.";
export const DISCONNECT_OWNER_ONLY = "Only a company owner can disconnect GitHub.";
export const DISCONNECT_STEP_UP = "Disconnecting GitHub needs a fresh sign-in check; sign in again and retry.";
export const CONNECTION_NOT_FOUND = "That GitHub connection was not found.";
export const DISCONNECT_UNAVAILABLE = "GitHub could not be disconnected just now; try again.";
/** The 409 when projects still use the installation: their names (this company's only; project names are lowercase letters, digits and hyphens). */
export const githubInUseMessage = (projects: readonly string[]) => `Projects still use this GitHub connection: ${projects.join(", ")}. Remove its repositories from them first.`;
const SIGN_IN_AGAIN = `your Rovara sign-in has ended; run ${CLI_COMMAND_NAME} login <url> again`;

/** How long a state or a ticket lives. */
export const GITHUB_CONNECT_TTL_SECONDS = 600;
const STATE_PROVIDER = "github-install";
const TICKET_PROVIDER = "github-install-ticket";

export interface GithubConnectWiring {
  bindings: Pick<GithubInstallationBindings, "claimPerson" | "companyInstallations" | "ownersOf" | "disconnect">;
  github: {
    appSlug(): Promise<string>;
    oauthClient(): Promise<{ clientId: string; clientSecret: string } | undefined>;
    userControlledInstallations(code: string): Promise<{ user: { id: number; login: string }; installations: ControlledInstallation[] }>;
  };
  /** The broker's log sink; every line goes through companyLog. Event names and ids only. */
  log: (entry: Record<string, unknown>) => void;
  /** Tests only: the 32 random bytes of a state or ticket. */
  random?: () => Buffer;
}

export interface GithubConnectContext {
  documentClient: { send(command: unknown): Promise<unknown> };
  /** The State table (states, tickets, bindings). */
  tableName: string;
  /** The sign-in table (memberships, people). */
  signInTableName: string;
  now: () => number;
  wiring: GithubConnectWiring;
}

const CONNECT = `${GITHUB_CONNECT_PATH}/connect`;
const CLAIM = `${GITHUB_CONNECT_PATH}/claim`;
const CHOOSE = `${GITHUB_CONNECT_PATH}/choose`;

/** One installation's path (DELETE); anything after the prefix that is not one path segment is not this module's. */
const INSTALLATION_PATH = /^\/v1\/dev\/company\/github\/([^/]+)$/;

/** Whether this module answers the path (the dispatcher sends it here before anything is read). */
export function isGithubConnectPath(path: string): boolean {
  return path === GITHUB_CONNECT_PATH || INSTALLATION_PATH.test(path);
}

const Secret = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const InstallationId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const ConnectBody = z.object({}).strict();
const ClaimBody = z.object({
  state: Secret,
  code: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
  installationId: InstallationId.optional(),
  setupAction: z.enum(["install", "update", "request"]).optional(),
}).strict();
const ChooseBody = z.object({ ticket: Secret, installationId: InstallationId }).strict();
const Stored = z.object({
  entityType: z.literal("GITHUB_CONNECT_STATE"), provider: z.enum([STATE_PROVIDER, TICKET_PROVIDER]), status: z.literal("live"),
  companyId: OrgIdSchema, personId: z.string().regex(/^[a-f0-9]{64}$/), sessionId: z.string().min(1).max(256),
  createdAt: z.iso.datetime(), expiresAt: z.number().int().positive(),
  githubUser: z.object({ id: InstallationId, login: z.string().min(1).max(39) }).strict().optional(),
  installations: z.array(z.object({ installationId: InstallationId, accountLogin: z.string().min(1).max(39), accountType: z.enum(["User", "Organization"]), suspended: z.boolean() }).strict()).max(100).optional(),
});

const startAgain = () => agentXError("FORBIDDEN", START_AGAIN);
const hashOf = (secret: string) => createHash("sha256").update(secret, "utf8").digest("hex");
const keyOf = (secret: string) => ({ pk: `GITHUB_CONNECT#${hashOf(secret)}`, sk: "META" });

function body(request: AdaptedHttpRequest): unknown {
  if (request.body === undefined || request.body === "") return {};
  try { return JSON.parse(request.body) as unknown; } catch { return undefined; }
}

/** The caller's live membership in `companyId`, or 401. */
async function liveMembership(ctx: GithubConnectContext, caller: DeveloperCaller, companyId: string): Promise<z.infer<typeof Membership>> {
  try {
    const response = await ctx.documentClient.send(new GetCommand({ TableName: ctx.signInTableName, Key: membershipKey(caller.developerId), ConsistentRead: true })) as { Item?: unknown };
    const member = Membership.parse(response.Item);
    if (member.personId !== caller.developerId || member.companyId !== companyId || member.revokedAt !== undefined || !OrgIdSchema.safeParse(companyId).success) throw new Error("membership");
    return member;
  } catch { throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN); }
}

const isAdmin = (member: z.infer<typeof Membership>) => member.role === "admin" || member.role === "owner";

/** Mints and stores (hashed) a state or a ticket for this company, person and session. */
async function mint(ctx: GithubConnectContext, who: { companyId: string; personId: string; sessionId: string }, provider: typeof STATE_PROVIDER | typeof TICKET_PROVIDER,
  extra: Record<string, unknown> = {}): Promise<{ secret: string; expiresAt: number }> {
  const bytes = ctx.wiring.random?.() ?? randomBytes(32);
  if (bytes.length !== 32) throw new Error("random");
  const secret = bytes.toString("base64url");
  const nowMs = ctx.now();
  const expiresAt = Math.floor(nowMs / 1000) + GITHUB_CONNECT_TTL_SECONDS;
  await ctx.documentClient.send(new PutCommand({ TableName: ctx.tableName, Item: { ...keyOf(secret), entityType: "GITHUB_CONNECT_STATE", provider, status: "live",
    ...who, createdAt: new Date(nowMs).toISOString(), expiresAt, ...extra }, ConditionExpression: "attribute_not_exists(pk)" }));
  return { secret, expiresAt };
}

/** Spends a live state or ticket once, only for the same company, person, session and provider, before its expiry. Undefined for anything else. */
async function spend(ctx: GithubConnectContext, secret: string, who: { companyId: string; personId: string; sessionId: string }, provider: typeof STATE_PROVIDER | typeof TICKET_PROVIDER): Promise<z.infer<typeof Stored> | undefined> {
  try {
    const key = keyOf(secret);
    const nowSeconds = Math.floor(ctx.now() / 1000);
    const response = await ctx.documentClient.send(new GetCommand({ TableName: ctx.tableName, Key: key, ConsistentRead: true })) as { Item?: unknown };
    const row = Stored.parse(response.Item);
    if (row.provider !== provider || row.companyId !== who.companyId || row.personId !== who.personId || row.sessionId !== who.sessionId || row.expiresAt <= nowSeconds) return undefined;
    await ctx.documentClient.send(new UpdateCommand({ TableName: ctx.tableName, Key: key,
      UpdateExpression: "SET #status = :used, usedAt = :at",
      ConditionExpression: "#status = :live AND #provider = :provider AND companyId = :company AND personId = :person AND sessionId = :session AND expiresAt > :now",
      ExpressionAttributeNames: { "#status": "status", "#provider": "provider" },
      ExpressionAttributeValues: { ":used": "used", ":live": "live", ":at": new Date(ctx.now()).toISOString(), ":provider": provider,
        ":company": who.companyId, ":person": who.personId, ":session": who.sessionId, ":now": nowSeconds } }));
    return row;
  } catch { return undefined; }
}

/** Binds one checked installation, as the person. The answers after the GitHub check: connected (new or already this company's) or 409 taken. */
async function bind(ctx: GithubConnectContext, companyId: string, personId: string, installation: { installationId: number; accountLogin: string; accountType: string; suspended?: boolean }, githubUser: { id: number; login: string }) {
  let outcome: PersonClaimOutcome;
  try {
    outcome = await ctx.wiring.bindings.claimPerson(companyId, { installationId: installation.installationId, accountLogin: installation.accountLogin }, personId,
      { ...(installation.accountType === "User" || installation.accountType === "Organization" ? { accountType: installation.accountType } : {}), ...(installation.suspended === true ? { suspended: true } : {}) });
  }
  catch { throw agentXError("RUNTIME_UNAVAILABLE", CONNECT_UNAVAILABLE); }
  if (outcome === "taken") throw agentXError("GITHUB_INSTALLATION_TAKEN", GITHUB_TAKEN);
  if (outcome === "bound") companyLog(companyId, ctx.wiring.log)({ event: "github.binding_claimed", installationId: installation.installationId, actor: personId });
  if (outcome === "reconnected") companyLog(companyId, ctx.wiring.log)({ event: "github.binding_reconnected", installationId: installation.installationId, actor: personId });
  return {
    status: "connected" as const, alreadyConnected: outcome === "already_bound",
    installation: { installationId: installation.installationId, accountLogin: installation.accountLogin, accountType: installation.accountType },
    githubUser,
  };
}

/**
 * The routes. The caller is authenticated and its route row (`full`) applied; `companyId` is its live membership's company (resolveCompany). The membership
 * row is read again here, so a role or company that changed since is what counts.
 */
export async function routeGithubConnect(ctx: GithubConnectContext, caller: DeveloperCaller, companyId: string, request: AdaptedHttpRequest, url: URL, stepUp?: CallerStepUp): Promise<unknown> {
  const member = await liveMembership(ctx, caller, companyId);
  const who = { companyId: member.companyId, personId: caller.developerId, sessionId: caller.sessionId };

  const one = INSTALLATION_PATH.exec(url.pathname);
  if (one !== null && url.pathname !== CONNECT && url.pathname !== CLAIM && url.pathname !== CHOOSE) {
    if (request.method !== "DELETE") throw agentXError("NOT_FOUND", "not found");
    return disconnect(ctx, member, caller.developerId, one[1]!, stepUp);
  }

  if (url.pathname === GITHUB_CONNECT_PATH) {
    if (request.method !== "GET") throw agentXError("NOT_FOUND", "not found");
    return readConnections(ctx, member.companyId);
  }
  if (request.method !== "POST") throw agentXError("NOT_FOUND", "not found");

  if (url.pathname === CONNECT) {
    if (!isAdmin(member)) throw agentXError("FORBIDDEN", CONNECT_ADMIN_ONLY);
    if (!ConnectBody.safeParse(body(request)).success) throw agentXError("CONFIG_INVALID", "connecting GitHub takes no body");
    let slug: string; let client: { clientId: string } | undefined;
    try { [slug, client] = await Promise.all([ctx.wiring.github.appSlug(), ctx.wiring.github.oauthClient()]); }
    catch { throw agentXError("RUNTIME_UNAVAILABLE", CONNECT_NOT_SET_UP); }
    if (client === undefined || !/^[A-Za-z0-9.]{1,64}$/.test(client.clientId)) throw agentXError("RUNTIME_UNAVAILABLE", CONNECT_NOT_SET_UP);
    let minted: { secret: string; expiresAt: number };
    try { minted = await mint(ctx, who, STATE_PROVIDER); } catch { throw agentXError("RUNTIME_UNAVAILABLE", CONNECT_UNAVAILABLE); }
    const state = encodeURIComponent(minted.secret);
    return {
      state: minted.secret, expiresAt: new Date(minted.expiresAt * 1000).toISOString(),
      installUrl: `https://github.com/apps/${encodeURIComponent(slug)}/installations/new?state=${state}`,
      authorizeUrl: `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(client.clientId)}&state=${state}`,
    };
  }

  // Claim and choose: every refusal before the GitHub check passes is the one answer.
  if (!isAdmin(member)) throw startAgain();

  if (url.pathname === CLAIM) {
    const parsed = ClaimBody.safeParse(body(request));
    if (!parsed.success) throw startAgain();
    const input = parsed.data;
    const requested = input.setupAction === "request";
    if (requested ? input.installationId !== undefined : input.code === undefined) throw startAgain();
    if (await spend(ctx, input.state, who, STATE_PROVIDER) === undefined) throw startAgain();
    // GitHub sends "request" when the person asked their GitHub admin to install: nothing is installed yet, so nothing binds.
    if (requested) return { status: "requested" as const };
    let checked: Awaited<ReturnType<GithubConnectWiring["github"]["userControlledInstallations"]>>;
    try { checked = await ctx.wiring.github.userControlledInstallations(input.code!); } catch { throw startAgain(); }
    if (input.installationId !== undefined) {
      const installation = checked.installations.find((row) => row.installationId === input.installationId);
      if (installation === undefined) throw startAgain();
      return bind(ctx, member.companyId, caller.developerId, installation, checked.user);
    }
    // No id (already installed, installed from GitHub directly, or approved after a request): the person's installations, bound to nothing new.
    let owners: Array<string | undefined>;
    try { owners = checked.installations.length === 0 ? [] : await ctx.wiring.bindings.ownersOf(checked.installations.map((row) => row.installationId)); }
    catch { throw agentXError("RUNTIME_UNAVAILABLE", CONNECT_UNAVAILABLE); }
    const installations = checked.installations.map((row, index) => ({ ...row,
      connection: owners[index] === member.companyId ? "this_company" as const : owners[index] === undefined ? "unbound" as const : "another_company" as const }));
    let ticket: { secret: string; expiresAt: number };
    try { ticket = await mint(ctx, who, TICKET_PROVIDER, { githubUser: checked.user, installations: checked.installations }); }
    catch { throw agentXError("RUNTIME_UNAVAILABLE", CONNECT_UNAVAILABLE); }
    return { status: "choose" as const, ticket: ticket.secret, expiresAt: new Date(ticket.expiresAt * 1000).toISOString(), githubUser: checked.user, installations };
  }

  if (url.pathname === CHOOSE) {
    const parsed = ChooseBody.safeParse(body(request));
    if (!parsed.success) throw startAgain();
    const ticket = await spend(ctx, parsed.data.ticket, who, TICKET_PROVIDER);
    const installation = ticket?.installations?.find((row) => row.installationId === parsed.data.installationId);
    if (ticket?.githubUser === undefined || installation === undefined) throw startAgain();
    return bind(ctx, member.companyId, caller.developerId, installation, ticket.githubUser);
  }
  throw agentXError("NOT_FOUND", "not found");
}

/** Any member: the company's bound installations, who connected each and when. No tokens; names only of the company's own people. */
async function readConnections(ctx: GithubConnectContext, companyId: string): Promise<unknown> {
  try {
    const rows = await ctx.wiring.bindings.companyInstallations(companyId);
    const people = [...new Set(rows.map((row) => row.boundBy).filter((by) => /^[a-f0-9]{64}$/.test(by)))];
    const names = new Map<string, string>();
    for (const personId of people) {
      // A name only while that person is still in this company; someone who left shows as an id.
      const membership = await ctx.documentClient.send(new GetCommand({ TableName: ctx.signInTableName, Key: membershipKey(personId), ConsistentRead: true })) as { Item?: unknown };
      const row = Membership.safeParse(membership.Item);
      if (!row.success || row.data.personId !== personId || row.data.companyId !== companyId || row.data.revokedAt !== undefined) continue;
      const response = await ctx.documentClient.send(new GetCommand({ TableName: ctx.signInTableName, Key: { pk: `DEVELOPER#${personId}`, sk: "META" }, ConsistentRead: true })) as { Item?: { displayName?: unknown } };
      const name = response.Item?.displayName;
      if (typeof name === "string" && name.length > 0 && name.length <= 200) names.set(personId, name);
    }
    return { installations: rows.map((row) => ({
      installationId: row.installationId, accountLogin: row.accountLogin, status: row.state, ...(row.accountType === undefined ? {} : { accountType: row.accountType }), connectedAt: row.boundAt,
      connectedBy: /^[a-f0-9]{64}$/.test(row.boundBy) ? { kind: "person" as const, personId: row.boundBy, ...(names.has(row.boundBy) ? { name: names.get(row.boundBy)! } : {}) } : { kind: "operator" as const },
    })) };
  } catch { throw agentXError("RUNTIME_UNAVAILABLE", CONNECTIONS_UNAVAILABLE); }
}

/**
 * Guided onboarding PR 3: an owner disconnects one of the company's installations. In order, so nothing is read for anyone who may not do it: a live owner (403), a fresh step-up
 * (403 REAUTH_REQUIRED), the installation is this company's (else the one 404, the same for another company's and for none), no project of this company uses it (409 naming
 * them), then the conditional unbind with its audit row. The answer: GitHub's page where the installation itself is removed.
 */
async function disconnect(ctx: GithubConnectContext, member: z.infer<typeof Membership>, personId: string, rawId: string, stepUp: CallerStepUp | undefined): Promise<unknown> {
  if (member.role !== "owner") throw agentXError("FORBIDDEN", DISCONNECT_OWNER_ONLY);
  requireFreshStepUp(stepUp, ctx.now(), DISCONNECT_STEP_UP);
  const parsed = /^[1-9][0-9]{0,15}$/.test(rawId) ? InstallationId.safeParse(Number(rawId)) : undefined;
  if (parsed?.success !== true) throw agentXError("NOT_FOUND", CONNECTION_NOT_FOUND);
  const installationId = parsed.data;
  let rows: Awaited<ReturnType<GithubConnectWiring["bindings"]["companyInstallations"]>>;
  try { rows = await ctx.wiring.bindings.companyInstallations(member.companyId); } catch { throw agentXError("RUNTIME_UNAVAILABLE", DISCONNECT_UNAVAILABLE); }
  const row = rows.find((candidate) => candidate.installationId === installationId);
  if (row === undefined) throw agentXError("NOT_FOUND", CONNECTION_NOT_FOUND);
  let using: string[];
  // Unpinned repositories of an account the company also reaches through another, active installation are that one's.
  const ownerElsewhere = rows.some((other) => other.installationId !== installationId && other.state === "active" && other.accountLogin.toLowerCase() === row.accountLogin.toLowerCase());
  try { using = await projectsUsingInstallation({ documentClient: ctx.documentClient, tableName: ctx.tableName, now: ctx.now }, member.companyId, { installationId, accountLogin: row.accountLogin, ownerElsewhere }); }
  catch { throw agentXError("RUNTIME_UNAVAILABLE", DISCONNECT_UNAVAILABLE); }
  if (using.length > 0) throw agentXError("GITHUB_IN_USE", githubInUseMessage(using));
  let outcome: Awaited<ReturnType<GithubConnectWiring["bindings"]["disconnect"]>>;
  try { outcome = await ctx.wiring.bindings.disconnect(member.companyId, installationId, personId); } catch { throw agentXError("RUNTIME_UNAVAILABLE", DISCONNECT_UNAVAILABLE); }
  if (outcome.outcome === "not_found") throw agentXError("NOT_FOUND", CONNECTION_NOT_FOUND);
  companyLog(member.companyId, ctx.wiring.log)({ event: "github.binding_disconnected", installationId, actor: personId });
  return { status: "disconnected" as const, installationId, accountLogin: outcome.accountLogin, uninstallUrl: githubUninstallUrl(installationId, outcome.accountLogin, outcome.accountType) };
}
