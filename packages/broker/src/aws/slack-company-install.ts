// Guided onboarding PR 4 (designs-2026-10-30/guided-onboarding-design.md section 3b; DEC 254l items 2 and 4): "Add to Slack" installs Rovara's bot into ONE
// Slack workspace for the company, and one workspace belongs to one company.
//
//   POST /v1/dev/company/slack/install           { redirectUri }            owner/admin: a single-use state and Slack's OAuth v2 address (bot scopes only)
//   POST /v1/dev/company/slack/install/complete  { state, code } | { state, error }  owner/admin: spend the state, exchange the code, bind, store the token
//   POST /v1/dev/company/slack/disconnect        {}                         OWNER + fresh step-up: revoke, drop the token, unbind, unlink channels
//   GET  /v1/dev/company/slack                                              any member: the company's workspace (no token)
//   event agentx.slack-workspace-removed (from the Slack ingress after Slack's signature check): app_uninstalled / tokens_revoked mark it disconnected
//
// Rules (design section 3, the common brief's shared security rules):
//   - The company and role are the caller's LIVE membership (sign-in table), read at every call; never a body, query, header or token claim.
//   - State: 32 random bytes, stored only as sha256 with company, person, session, provider "slack-install", the redirect address and a 10-minute expiry; spent once,
//     conditionally on all of those. Cloud also binds it to its own cookie.
//   - The workspace, the bot token, the bot user and the installing Slack user come from SLACK's oauth.v2.access answer only, never from the browser.
//   - Every refusal before Slack's answer is ONE answer (403 "Start again from Rovara."). After it: fixed sentences, no echo of input or cause.
//   - First binder wins (one conditional transaction over the team's binding, the company's view row and the company's one-workspace record).
//   - Tokens live only in the existing per-company store (agentx/<env>/slack-workspaces/<company>/<team>, slack-workspace-tokens.ts); never answered or logged.
//   - Revoking (auth.revoke) a bot token deactivates the app's bot user in that workspace (https://docs.slack.dev/reference/methods/auth.revoke). A token Slack issues
//     for a workspace bound to ANOTHER company belongs to that same bot user, so revoking it would cut that company off: it is dropped unstored, not revoked.
//     A token for a workspace no company holds (an Enterprise Grid org install, or this company already holding a different workspace) is revoked.
import { createHash, randomBytes } from "node:crypto";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { agentXError, channelBindingPartition, companyLog, OrgIdSchema, SLACK_CHANNEL, SlackTeamIdSchema, SlackUserIdSchema } from "@agentx/contracts";
import { Membership, membershipKey } from "./company-check.js";
import type { DeveloperCaller } from "./developer-routes.js";
import type { AdaptedHttpRequest } from "./lambda.js";
import type { CallerStepUp } from "./step-up-check.js";
import { requireFreshStepUp } from "./step-up-check.js";
import { companyWorkspaceKey, companyWorkspaceView, markerKey, parseBinding, slackWorkspaceTeam, teamKey, type BindingRow } from "./slack-workspace-binding.js";
import type { SlackExchange, SlackInstallGrant } from "./slack-install-identity.js";
import type { SlackWorkspaceRemovedEvent } from "./slack-workspace-removal.js";

export const SLACK_INSTALL_PATH = "/v1/dev/company/slack";
const START = `${SLACK_INSTALL_PATH}/install`;
const COMPLETE = `${SLACK_INSTALL_PATH}/install/complete`;
const DISCONNECT = `${SLACK_INSTALL_PATH}/disconnect`;

export const START_AGAIN = "Start again from Rovara.";
export const SLACK_ADMIN_ONLY = "Only a company owner or admin can add Rovara to Slack.";
export const SLACK_OWNER_ONLY = "Only a company owner can disconnect Slack.";
export const SLACK_DISCONNECT_STEP_UP = "Disconnecting Slack needs a fresh sign-in check; sign in again and retry.";
export const SLACK_NOT_SET_UP = "Adding Rovara to Slack isn't set up on this Rovara yet. Ask the Rovara team.";
export const SLACK_UNAVAILABLE = "Slack could not be connected just now. Start again from Rovara.";
export const SLACK_READ_UNAVAILABLE = "The company's Slack connection could not be read just now; try again.";
export const SLACK_DISCONNECT_UNAVAILABLE = "Slack could not be disconnected just now; try again.";
export const SLACK_WORKSPACE_TAKEN = "This Slack workspace is already connected to a different Rovara company.";
export const SLACK_COMPANY_HAS_WORKSPACE = "This company is already connected to a different Slack workspace. A company owner can disconnect it first.";
export const SLACK_ENTERPRISE_REFUSED = "Rovara can be added to one Slack workspace, not to a whole Enterprise Grid organization. Add it to a single workspace.";
export const SLACK_NOT_CONNECTED = "This company has no Slack workspace connected.";
const SIGN_IN_AGAIN = "your AgentX sign-in has ended; run agentx login <url> again";

/** How long a state lives. */
export const SLACK_INSTALL_TTL_SECONDS = 600;
const STATE_PROVIDER = "slack-install";
/** The bot scopes Code's bot already uses (cli init/slack-app.ts SLACK_BOT_SCOPES, a test holds them equal) plus `commands` for /rovara (PR 5). No user scopes. */
export const SLACK_INSTALL_BOT_SCOPES: readonly string[] = ["app_mentions:read", "canvases:write", "channels:history", "channels:join", "channels:read", "chat:write", "files:read",
  "groups:history", "groups:read", "im:write", "users:read", "users:read.email", "commands"];
/** The only path Cloud's callback may have (Cloud PR 11). Slack itself refuses a redirect address the app's settings don't list. */
export const SLACK_INSTALL_CALLBACK_PATH = "/api/connect/slack/callback";
/** At most this many channel links are removed with one disconnect; more refuses before anything changes. */
export const SLACK_DISCONNECT_LINKS_MAX = 500;

const Secret = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const PersonId = z.string().regex(/^[a-f0-9]{64}$/);
const RedirectUri = z.string().max(512).refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "" && url.search === "" && url.hash === "" && url.pathname === SLACK_INSTALL_CALLBACK_PATH
      && url.href === value && /^[a-z0-9.-]{1,253}(?::[0-9]{1,5})?$/.test(url.host);
  } catch { return false; }
});
const StartBody = z.object({ redirectUri: RedirectUri }).strict();
const CompleteBody = z.union([
  z.object({ state: Secret, code: z.string().regex(/^[A-Za-z0-9._-]{1,256}$/) }).strict(),
  z.object({ state: Secret, error: z.string().regex(/^[a-z_]{1,64}$/) }).strict(),
]);
const DisconnectBody = z.object({}).strict();
const StoredState = z.object({
  entityType: z.literal("SLACK_INSTALL_STATE"), provider: z.literal(STATE_PROVIDER), status: z.literal("live"),
  companyId: OrgIdSchema, personId: PersonId, sessionId: z.string().min(1).max(256), redirectUri: RedirectUri,
  createdAt: z.iso.datetime(), expiresAt: z.number().int().positive(),
});
const TeamName = z.string().min(1).max(200);
/** The company's one Slack workspace (DEC 254l item 4), beside the team's binding. */
const CompanyWorkspace = z.object({
  entityType: z.literal("SLACK_COMPANY_WORKSPACE"), companyId: OrgIdSchema, teamId: SlackTeamIdSchema, teamName: TeamName.optional(),
  botUserId: SlackUserIdSchema.optional(), installerSlackUserId: SlackUserIdSchema.optional(),
  status: z.enum(["connected", "disconnected"]), connectedAt: z.iso.datetime(), connectedBy: PersonId,
  disconnectedAt: z.iso.datetime().optional(), disconnectedBy: z.literal("slack").optional(),
});
type CompanyWorkspaceRow = z.infer<typeof CompanyWorkspace>;
export const companyInstallKey = (companyId: string) => ({ pk: `ORG#${companyId}#SLACK_INSTALL`, sk: "WORKSPACE" });
const auditKey = (teamId: string, action: "CONNECT" | "DISCONNECT" | "REMOVED", at: string, actor: string) => ({ pk: `SLACK_TEAM#${teamId}`, sk: `AUDIT#${action}#${at}#${actor}` });
const stateKey = (secret: string) => ({ pk: `SLACK_INSTALL_STATE#${createHash("sha256").update(secret, "utf8").digest("hex")}`, sk: "META" });

/** What the routes ask of the Slack app's side: slack-install-identity.ts, in the sign-in Lambda that holds the app's client secret (the broker never reads it). */
export interface SlackInstallSlack {
  /** The Slack app's client id (not a secret), or undefined while the app's client is not stored. */
  clientId(): Promise<string | undefined>;
  exchange(code: string, redirectUri: string): Promise<SlackExchange | "not_set_up">;
  /** auth.revoke; true when Slack says it is revoked (or was already). */
  revoke(botToken: string): Promise<boolean>;
  /** Writes the company's bot token at agentx/<env>/slack-workspaces/<company>/<team>. Throws when it could not. */
  store(companyId: string, teamId: string, botToken: string): Promise<void>;
  /** Revokes the company's stored token (none: nothing to revoke) and drops it. Throws when it could not. */
  revokeStored(companyId: string, teamId: string): Promise<void>;
  /** Drops the company's stored token (none: fine). Throws when it could not. */
  drop(companyId: string, teamId: string): Promise<void>;
}

export interface SlackInstallWiring {
  slack: SlackInstallSlack;
  /** The broker's log sink; every line goes through companyLog. Event names and ids only. */
  log: (entry: Record<string, unknown>) => void;
  /** Tests only: the 32 random bytes of a state. */
  random?: () => Buffer;
}

export interface SlackInstallContext {
  documentClient: { send(command: unknown): Promise<unknown> };
  /** The State table (states, bindings, records, channel links). */
  tableName: string;
  /** The sign-in table (memberships, people). */
  signInTableName: string;
  now: () => number;
  wiring: SlackInstallWiring;
}

/** Whether this module answers the path (the dispatcher sends it here before anything is read). */
export function isSlackInstallPath(path: string): boolean {
  return path === SLACK_INSTALL_PATH || path === START || path === COMPLETE || path === DISCONNECT;
}

const startAgain = () => agentXError("FORBIDDEN", START_AGAIN);
function body(request: AdaptedHttpRequest): unknown {
  if (request.body === undefined || request.body === "") return {};
  try { return JSON.parse(request.body) as unknown; } catch { return undefined; }
}

async function liveMembership(ctx: SlackInstallContext, caller: DeveloperCaller, companyId: string): Promise<z.infer<typeof Membership>> {
  try {
    const response = await ctx.documentClient.send(new GetCommand({ TableName: ctx.signInTableName, Key: membershipKey(caller.developerId), ConsistentRead: true })) as { Item?: unknown };
    const member = Membership.parse(response.Item);
    if (member.personId !== caller.developerId || member.companyId !== companyId || member.revokedAt !== undefined || !OrgIdSchema.safeParse(companyId).success) throw new Error("membership");
    return member;
  } catch { throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN); }
}
const isAdmin = (member: z.infer<typeof Membership>) => member.role === "admin" || member.role === "owner";

/** The Slack workspace the person signed in with (#827 records it on their profile); absent for any other sign-in. */
async function signedInWorkspace(ctx: SlackInstallContext, personId: string): Promise<{ teamId: string; teamName?: string } | undefined> {
  try {
    const response = await ctx.documentClient.send(new GetCommand({ TableName: ctx.signInTableName, Key: { pk: `DEVELOPER#${personId}`, sk: "META" }, ConsistentRead: true })) as { Item?: { slackTeamId?: unknown; slackTeamName?: unknown } };
    const team = response.Item?.slackTeamId;
    if (!slackWorkspaceTeam(team)) return undefined;
    const name = TeamName.safeParse(response.Item?.slackTeamName);
    return { teamId: team, ...(name.success ? { teamName: name.data } : {}) };
  } catch { return undefined; }
}

async function mint(ctx: SlackInstallContext, who: { companyId: string; personId: string; sessionId: string }, redirectUri: string): Promise<{ secret: string; expiresAt: number }> {
  const bytes = ctx.wiring.random?.() ?? randomBytes(32);
  if (bytes.length !== 32) throw new Error("random");
  const secret = bytes.toString("base64url");
  const nowMs = ctx.now();
  const expiresAt = Math.floor(nowMs / 1000) + SLACK_INSTALL_TTL_SECONDS;
  await ctx.documentClient.send(new PutCommand({ TableName: ctx.tableName, Item: { ...stateKey(secret), entityType: "SLACK_INSTALL_STATE", provider: STATE_PROVIDER, status: "live",
    ...who, redirectUri, createdAt: new Date(nowMs).toISOString(), expiresAt }, ConditionExpression: "attribute_not_exists(pk)" }));
  return { secret, expiresAt };
}

/** Spends a live state once, only for the same company, person, session and provider, before its expiry. Undefined for anything else. */
async function spend(ctx: SlackInstallContext, secret: string, who: { companyId: string; personId: string; sessionId: string }): Promise<z.infer<typeof StoredState> | undefined> {
  try {
    const key = stateKey(secret);
    const nowSeconds = Math.floor(ctx.now() / 1000);
    const response = await ctx.documentClient.send(new GetCommand({ TableName: ctx.tableName, Key: key, ConsistentRead: true })) as { Item?: unknown };
    const row = StoredState.parse(response.Item);
    if (row.companyId !== who.companyId || row.personId !== who.personId || row.sessionId !== who.sessionId || row.expiresAt <= nowSeconds) return undefined;
    await ctx.documentClient.send(new UpdateCommand({ TableName: ctx.tableName, Key: key,
      UpdateExpression: "SET #status = :used, usedAt = :at",
      ConditionExpression: "#status = :live AND #provider = :provider AND companyId = :company AND personId = :person AND sessionId = :session AND expiresAt > :now",
      ExpressionAttributeNames: { "#status": "status", "#provider": "provider" },
      ExpressionAttributeValues: { ":used": "used", ":live": "live", ":at": new Date(ctx.now()).toISOString(), ":provider": STATE_PROVIDER,
        ":company": who.companyId, ":person": who.personId, ":session": who.sessionId, ":now": nowSeconds } }));
    return row;
  } catch { return undefined; }
}

type Send = (command: unknown) => Promise<unknown>;
async function readBinding(send: Send, tableName: string, teamId: string): Promise<BindingRow | undefined> {
  const response = await send(new GetCommand({ TableName: tableName, Key: teamKey(teamId), ConsistentRead: true })) as { Item?: unknown };
  if (response.Item === undefined) return undefined;
  const row = parseBinding(response.Item);
  if (row.teamId !== teamId) throw new Error("binding");
  return row;
}
async function readCompanyWorkspace(send: Send, tableName: string, companyId: string): Promise<CompanyWorkspaceRow | undefined> {
  const response = await send(new GetCommand({ TableName: tableName, Key: companyInstallKey(companyId), ConsistentRead: true })) as { Item?: unknown };
  if (response.Item === undefined) return undefined;
  const row = CompanyWorkspace.parse(response.Item);
  if (row.companyId !== companyId) throw new Error("record");
  return row;
}
/** The teams this company's view rows name (an operator-bound workspace has no SLACK_COMPANY_WORKSPACE record), each backed by its binding. At most 32. */
async function companyTeams(send: Send, tableName: string, companyId: string): Promise<string[]> {
  const pk = companyWorkspaceKey(companyId, "").pk;
  const response = await send(new QueryCommand({ TableName: tableName, ConsistentRead: true, Limit: 33, KeyConditionExpression: "pk = :pk AND begins_with(sk, :team)",
    ExpressionAttributeValues: { ":pk": pk, ":team": "TEAM#" } })) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: unknown };
  const items = response.Items ?? [];
  if (items.length > 32 || response.LastEvaluatedKey !== undefined) throw new Error("too many");
  const teams: string[] = [];
  for (const item of items) {
    if (!slackWorkspaceTeam(item.teamId) || item.companyId !== companyId || item.sk !== `TEAM#${item.teamId}`) throw new Error("view");
    if ((await readBinding(send, tableName, item.teamId))?.companyId === companyId) teams.push(item.teamId);
  }
  return teams;
}

type BindOutcome = "bound" | "already_bound" | "team_taken" | "company_has_other";

/**
 * First binder wins, for both directions of DEC 254l item 4: the team's binding (absent, or already this company's) and the company's one-workspace record (absent, or
 * naming this team) in one conditional transaction with the backfill marker (present) and an audit row naming the person. Nothing is overwritten on a refusal.
 */
async function bindTeam(ctx: SlackInstallContext, companyId: string, personId: string, grant: SlackInstallGrant): Promise<BindOutcome> {
  const send: Send = (command) => ctx.documentClient.send(command);
  const decide = async (): Promise<BindOutcome | undefined> => {
    const binding = await readBinding(send, ctx.tableName, grant.teamId);
    if (binding !== undefined && binding.companyId !== companyId) return "team_taken";
    const record = await readCompanyWorkspace(send, ctx.tableName, companyId);
    if (record !== undefined && record.teamId !== grant.teamId) return "company_has_other";
    if ((await companyTeams(send, ctx.tableName, companyId)).some((team) => team !== grant.teamId)) return "company_has_other";
    return undefined;
  };
  const refused = await decide();
  if (refused !== undefined) return refused;
  const at = new Date(ctx.now()).toISOString();
  const existing = await readBinding(send, ctx.tableName, grant.teamId);
  const binding: BindingRow = existing ?? { ...teamKey(grant.teamId), sk: "BINDING", entityType: "SLACK_WORKSPACE_BINDING", teamId: grant.teamId, companyId, boundAt: at, boundBy: personId };
  const record: CompanyWorkspaceRow = { entityType: "SLACK_COMPANY_WORKSPACE", companyId, teamId: grant.teamId, ...(grant.teamName === undefined ? {} : { teamName: grant.teamName }),
    botUserId: grant.botUserId, installerSlackUserId: grant.installerSlackUserId, status: "connected", connectedAt: at, connectedBy: personId };
  try {
    await send(new TransactWriteCommand({ TransactItems: [
      { ConditionCheck: { TableName: ctx.tableName, Key: markerKey, ConditionExpression: "attribute_exists(pk)" } },
      existing === undefined
        ? { Put: { TableName: ctx.tableName, Item: binding, ConditionExpression: "attribute_not_exists(pk)" } }
        : { ConditionCheck: { TableName: ctx.tableName, Key: teamKey(grant.teamId), ConditionExpression: "companyId = :company", ExpressionAttributeValues: { ":company": companyId } } },
      { Put: { TableName: ctx.tableName, Item: companyWorkspaceView(binding) } },
      { Put: { TableName: ctx.tableName, Item: { ...companyInstallKey(companyId), ...record }, ConditionExpression: "attribute_not_exists(pk) OR teamId = :team", ExpressionAttributeValues: { ":team": grant.teamId } } },
      { Put: { TableName: ctx.tableName, Item: { ...auditKey(grant.teamId, "CONNECT", at, personId), entityType: "SLACK_WORKSPACE_AUDIT", action: "connect", teamId: grant.teamId, companyId, at, actor: personId },
        ConditionExpression: "attribute_not_exists(pk)" } },
    ] }));
    return existing === undefined ? "bound" : "already_bound";
  } catch (error) {
    // Lost a race (or the marker is absent): the stored rows decide; nothing was written.
    const after = await decide();
    if (after !== undefined) return after;
    throw error;
  }
}

/** The connect answer's view of the workspace and the sign-in workspace, so Cloud can say "You signed in from A but added Rovara to B". */
function workspaceAnswer(grant: SlackInstallGrant, signedIn: { teamId: string; teamName?: string } | undefined) {
  return {
    workspace: { teamId: grant.teamId, ...(grant.teamName === undefined ? {} : { teamName: grant.teamName }) },
    ...(signedIn === undefined ? {} : { signedInWorkspace: signedIn, matchesSignIn: signedIn.teamId === grant.teamId }),
  };
}

async function complete(ctx: SlackInstallContext, member: z.infer<typeof Membership>, caller: DeveloperCaller, request: AdaptedHttpRequest): Promise<unknown> {
  const parsed = CompleteBody.safeParse(body(request));
  if (!parsed.success) throw startAgain();
  const who = { companyId: member.companyId, personId: caller.developerId, sessionId: caller.sessionId };
  const state = await spend(ctx, parsed.data.state, who);
  if (state === undefined) throw startAgain();
  // Slack sends the person back with ?error=access_denied when they press Cancel: nothing was installed.
  if ("error" in parsed.data) {
    if (parsed.data.error === "access_denied") return { status: "cancelled" as const };
    throw startAgain();
  }
  let exchanged: SlackExchange | "not_set_up";
  try { exchanged = await ctx.wiring.slack.exchange(parsed.data.code, state.redirectUri); }
  catch { throw agentXError("RUNTIME_UNAVAILABLE", SLACK_UNAVAILABLE); }
  if (exchanged === "not_set_up") throw agentXError("RUNTIME_UNAVAILABLE", SLACK_NOT_SET_UP);
  const log = companyLog(member.companyId, ctx.wiring.log);
  if (exchanged.kind === "refused") throw startAgain();
  if (exchanged.kind === "enterprise") {
    if (exchanged.botToken !== undefined) await ctx.wiring.slack.revoke(exchanged.botToken).catch(() => false);
    log({ event: "slack.install_refused", reason: "enterprise", actor: caller.developerId });
    throw agentXError("FORBIDDEN", SLACK_ENTERPRISE_REFUSED);
  }
  const grant = exchanged.grant;
  let outcome: BindOutcome;
  try { outcome = await bindTeam(ctx, member.companyId, caller.developerId, grant); }
  catch { throw agentXError("RUNTIME_UNAVAILABLE", SLACK_UNAVAILABLE); }
  if (outcome === "team_taken") {
    // The workspace's bot user is the other company's; revoking would deactivate it there. Dropped unstored.
    log({ event: "slack.install_refused", reason: "workspace_taken", teamId: grant.teamId, actor: caller.developerId });
    throw agentXError("SLACK_WORKSPACE_TAKEN", SLACK_WORKSPACE_TAKEN);
  }
  if (outcome === "company_has_other") {
    // Nothing is stored. The just-issued token is revoked only while a fresh read shows NO company holds this workspace: revoking deactivates the workspace's bot user,
    // which may be this company's own (an operator-bound second workspace) or another's that bound it meanwhile; then it is dropped unstored, as for a taken workspace.
    const unheld = await readBinding((command) => ctx.documentClient.send(command), ctx.tableName, grant.teamId).then((row) => row === undefined, () => false);
    if (unheld) await ctx.wiring.slack.revoke(grant.botToken).catch(() => false);
    log({ event: "slack.install_refused", reason: "company_has_workspace", teamId: grant.teamId, actor: caller.developerId });
    throw agentXError("SLACK_COMPANY_HAS_WORKSPACE", SLACK_COMPANY_HAS_WORKSPACE);
  }
  // Bound (new) or already this company's: the token is written only under this company and this team, the path the token store derives from the binding.
  try { await ctx.wiring.slack.store(member.companyId, grant.teamId, grant.botToken); }
  catch { throw agentXError("RUNTIME_UNAVAILABLE", SLACK_UNAVAILABLE); }
  log({ event: outcome === "bound" ? "slack.workspace_connected" : "slack.workspace_reconnected", teamId: grant.teamId, actor: caller.developerId });
  return { status: "connected" as const, alreadyConnected: outcome === "already_bound", ...workspaceAnswer(grant, await signedInWorkspace(ctx, caller.developerId)) };
}

/** The company's channel links in its workspace (SLACK_BINDING#<team> / CHANNEL#<channel>), bounded; more than the bound refuses. */
async function channelLinks(ctx: SlackInstallContext, teamId: string): Promise<Array<{ key: { pk: string; sk: string }; projectName?: string }>> {
  const pk = channelBindingPartition(SLACK_CHANNEL, teamId);
  const links: Array<{ key: { pk: string; sk: string }; projectName?: string }> = [];
  let cursor: Record<string, unknown> | undefined;
  let pages = 0;
  do {
    if (++pages > 10) throw new Error("too many");
    const response = await ctx.documentClient.send(new QueryCommand({ TableName: ctx.tableName, ConsistentRead: true, Limit: 100, KeyConditionExpression: "pk = :pk AND begins_with(sk, :channel)",
      ExpressionAttributeValues: { ":pk": pk, ":channel": "CHANNEL#" }, ...(cursor === undefined ? {} : { ExclusiveStartKey: cursor }) })) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of response.Items ?? []) {
      if (item.pk !== pk || typeof item.sk !== "string" || !item.sk.startsWith("CHANNEL#")) throw new Error("link");
      links.push({ key: { pk, sk: item.sk }, ...(typeof item.projectName === "string" && item.projectName.length <= 128 ? { projectName: item.projectName } : {}) });
      if (links.length > SLACK_DISCONNECT_LINKS_MAX) throw new Error("too many");
    }
    cursor = response.LastEvaluatedKey;
  } while (cursor !== undefined);
  return links;
}

async function disconnect(ctx: SlackInstallContext, member: z.infer<typeof Membership>, caller: DeveloperCaller, stepUp: CallerStepUp | undefined, request: AdaptedHttpRequest): Promise<unknown> {
  if (member.role !== "owner") throw agentXError("FORBIDDEN", SLACK_OWNER_ONLY);
  requireFreshStepUp(stepUp, ctx.now(), SLACK_DISCONNECT_STEP_UP);
  if (!DisconnectBody.safeParse(body(request)).success) throw agentXError("CONFIG_INVALID", "disconnecting Slack takes no body");
  const companyId = member.companyId;
  const send: Send = (command) => ctx.documentClient.send(command);
  let teamId: string; let record: CompanyWorkspaceRow | undefined; let links: Awaited<ReturnType<typeof channelLinks>>; let bound: boolean;
  try {
    record = await readCompanyWorkspace(send, ctx.tableName, companyId);
    const teams = record === undefined ? await companyTeams(send, ctx.tableName, companyId) : [record.teamId];
    if (teams.length === 0) throw agentXError("NOT_FOUND", SLACK_NOT_CONNECTED);
    if (teams.length > 1) throw new Error("several");
    teamId = teams[0]!;
    bound = (await readBinding(send, ctx.tableName, teamId))?.companyId === companyId;
    if (!bound && record === undefined) throw agentXError("NOT_FOUND", SLACK_NOT_CONNECTED);
    // A record whose team's binding is not this company's holds nothing of this company's in Slack: no token is revoked and no channel link is touched (they are
    // keyed by team, not company); only the stale record goes.
    links = bound ? await channelLinks(ctx, teamId) : [];
  } catch (error) {
    if (error instanceof Error && error.name === "AgentXError") throw error;
    throw agentXError("RUNTIME_UNAVAILABLE", SLACK_DISCONNECT_UNAVAILABLE);
  }
  // Clean up first, unbind last: a failure leaves the binding, so pressing Disconnect again finishes the job.
  try {
    if (bound) {
      await ctx.wiring.slack.revokeStored(companyId, teamId);
      for (const link of links) await send(new DeleteCommand({ TableName: ctx.tableName, Key: link.key }));
    }
    const at = new Date(ctx.now()).toISOString();
    // The record must still be the one read above: a reconnect that landed meanwhile (new connectedAt) fails this, nothing is unbound, and pressing again revokes
    // its token too. Unbinding only while the binding is still this company's.
    await send(new TransactWriteCommand({ TransactItems: [
      ...(bound ? [{ Delete: { TableName: ctx.tableName, Key: teamKey(teamId), ConditionExpression: "companyId = :company", ExpressionAttributeValues: { ":company": companyId } } }] : []),
      { Delete: { TableName: ctx.tableName, Key: companyWorkspaceKey(companyId, teamId) } },
      record === undefined
        ? { ConditionCheck: { TableName: ctx.tableName, Key: companyInstallKey(companyId), ConditionExpression: "attribute_not_exists(pk)" } }
        : { Delete: { TableName: ctx.tableName, Key: companyInstallKey(companyId), ConditionExpression: "teamId = :team AND connectedAt = :connectedAt", ExpressionAttributeValues: { ":team": teamId, ":connectedAt": record.connectedAt } } },
      { Put: { TableName: ctx.tableName, Item: { ...auditKey(teamId, "DISCONNECT", at, caller.developerId), entityType: "SLACK_WORKSPACE_AUDIT", action: "disconnect", teamId, companyId, at, actor: caller.developerId },
        ConditionExpression: "attribute_not_exists(pk)" } },
    ] }));
  } catch { throw agentXError("RUNTIME_UNAVAILABLE", SLACK_DISCONNECT_UNAVAILABLE); }
  companyLog(companyId, ctx.wiring.log)({ event: "slack.workspace_disconnected", teamId, channelLinks: links.length, actor: caller.developerId });
  const projects = [...new Set(links.flatMap((link) => link.projectName === undefined ? [] : [link.projectName]))].sort();
  return { status: "disconnected" as const, workspace: { teamId, ...(record?.teamName === undefined ? {} : { teamName: record.teamName }) }, projectsLosingChannel: projects };
}

/** Any member: the company's workspace, who connected it and when, and whether it is connected. Never a token. */
async function readConnection(ctx: SlackInstallContext, companyId: string): Promise<unknown> {
  const send: Send = (command) => ctx.documentClient.send(command);
  try {
    const record = await readCompanyWorkspace(send, ctx.tableName, companyId);
    if (record === undefined) {
      const teams = await companyTeams(send, ctx.tableName, companyId);
      if (teams.length === 0) return { workspace: null };
      const binding = await readBinding(send, ctx.tableName, teams[0]!);
      return { workspace: { teamId: teams[0]!, state: "connected" as const, connectedAt: binding!.boundAt, connectedBy: { kind: "operator" as const } } };
    }
    if ((await readBinding(send, ctx.tableName, record.teamId))?.companyId !== companyId) return { workspace: null };
    let name: string | undefined;
    // A name only while that person is still in this company; someone who left shows as an id.
    const membership = await send(new GetCommand({ TableName: ctx.signInTableName, Key: membershipKey(record.connectedBy), ConsistentRead: true })) as { Item?: unknown };
    const row = Membership.safeParse(membership.Item);
    if (row.success && row.data.personId === record.connectedBy && row.data.companyId === companyId && row.data.revokedAt === undefined) {
      const person = await send(new GetCommand({ TableName: ctx.signInTableName, Key: { pk: `DEVELOPER#${record.connectedBy}`, sk: "META" }, ConsistentRead: true })) as { Item?: { displayName?: unknown } };
      const displayName = person.Item?.displayName;
      if (typeof displayName === "string" && displayName.length > 0 && displayName.length <= 200) name = displayName;
    }
    return { workspace: {
      teamId: record.teamId, ...(record.teamName === undefined ? {} : { teamName: record.teamName }), state: record.status, connectedAt: record.connectedAt,
      connectedBy: { kind: "person" as const, personId: record.connectedBy, ...(name === undefined ? {} : { name }) },
      ...(record.disconnectedAt === undefined ? {} : { disconnectedAt: record.disconnectedAt, disconnectedBy: record.disconnectedBy }),
    } };
  } catch { throw agentXError("RUNTIME_UNAVAILABLE", SLACK_READ_UNAVAILABLE); }
}

/**
 * The routes. The caller is authenticated and its route row (`full`) applied; `companyId` is its live membership's company (resolveCompany). The membership row is read again
 * here, so a role or company that changed since is what counts. `stepUp` is the verified token's step-up (disconnect only).
 */
export async function routeSlackInstall(ctx: SlackInstallContext, caller: DeveloperCaller, stepUp: CallerStepUp | undefined, companyId: string, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  const member = await liveMembership(ctx, caller, companyId);
  if (url.pathname === SLACK_INSTALL_PATH) {
    if (request.method !== "GET") throw agentXError("NOT_FOUND", "not found");
    return readConnection(ctx, member.companyId);
  }
  if (request.method !== "POST") throw agentXError("NOT_FOUND", "not found");
  if (url.pathname === START) {
    if (!isAdmin(member)) throw agentXError("FORBIDDEN", SLACK_ADMIN_ONLY);
    const parsed = StartBody.safeParse(body(request));
    if (!parsed.success) throw agentXError("CONFIG_INVALID", `adding Rovara to Slack needs the https address of Rovara's ${SLACK_INSTALL_CALLBACK_PATH} page`);
    let clientId: string | undefined;
    try { clientId = await ctx.wiring.slack.clientId(); } catch { clientId = undefined; }
    if (clientId === undefined || !/^[0-9]{1,24}\.[0-9]{1,24}$/.test(clientId)) throw agentXError("RUNTIME_UNAVAILABLE", SLACK_NOT_SET_UP);
    let minted: { secret: string; expiresAt: number };
    try { minted = await mint(ctx, { companyId: member.companyId, personId: caller.developerId, sessionId: caller.sessionId }, parsed.data.redirectUri); }
    catch { throw agentXError("RUNTIME_UNAVAILABLE", SLACK_UNAVAILABLE); }
    const authorize = new URL("https://slack.com/oauth/v2/authorize");
    for (const [key, value] of Object.entries({ client_id: clientId, scope: SLACK_INSTALL_BOT_SCOPES.join(","), redirect_uri: parsed.data.redirectUri, state: minted.secret })) authorize.searchParams.set(key, value);
    const signedIn = await signedInWorkspace(ctx, caller.developerId);
    return { state: minted.secret, expiresAt: new Date(minted.expiresAt * 1000).toISOString(), authorizeUrl: authorize.toString(), ...(signedIn === undefined ? {} : { signedInWorkspace: signedIn }) };
  }
  if (url.pathname === COMPLETE) {
    // Every refusal before Slack's answer is the one answer.
    if (!isAdmin(member)) throw startAgain();
    return complete(ctx, member, caller, request);
  }
  if (url.pathname === DISCONNECT) return disconnect(ctx, member, caller, stepUp, request);
  throw agentXError("NOT_FOUND", "not found");
}

// ---- Slack's app_uninstalled / tokens_revoked (https://docs.slack.dev/reference/events/app_uninstalled, .../tokens_revoked) -------------------------------------------

/**
 * The broker's half: the company bound to the team (the binding, never the event) gets its record marked disconnected (actor "slack") and its token dropped. The binding
 * stays, so the workspace is still this company's when someone presses Add to Slack again; channel links stay too. Unbound teams and stale events change nothing.
 */
/** Drops the token unless a reconnect replaced the record since it was read (its token is new and must stay). True when it dropped. */
async function dropUnlessReconnected(ctx: Omit<SlackInstallContext, "signInTableName">, companyId: string, teamId: string, connectedAt: string): Promise<boolean> {
  const now = await readCompanyWorkspace((command) => ctx.documentClient.send(command), ctx.tableName, companyId);
  if (now === undefined || now.teamId !== teamId || now.connectedAt !== connectedAt || now.status !== "disconnected") return false;
  await ctx.wiring.slack.drop(companyId, teamId);
  return true;
}

export async function handleSlackWorkspaceRemoved(ctx: Omit<SlackInstallContext, "signInTableName">, input: SlackWorkspaceRemovedEvent): Promise<{ outcome: "disconnected" | "ignored" }> {
  const send: Send = (command) => ctx.documentClient.send(command);
  const binding = await readBinding(send, ctx.tableName, input.teamId);
  if (binding === undefined) return { outcome: "ignored" };
  const companyId = binding.companyId;
  const record = await readCompanyWorkspace(send, ctx.tableName, companyId);
  const eventAt = new Date(input.eventTime * 1000).toISOString();
  if (record !== undefined && (record.teamId !== input.teamId || Date.parse(record.connectedAt) > input.eventTime * 1000)) return { outcome: "ignored" };
  // Already marked (Slack's retry after a failed drop, or tokens_revoked after app_uninstalled): drop again (idempotent), no second audit row.
  if (record?.status === "disconnected") {
    await dropUnlessReconnected(ctx, companyId, input.teamId, record.connectedAt);
    return { outcome: "ignored" };
  }
  const at = new Date(ctx.now()).toISOString();
  if (record !== undefined && record.status === "connected") {
    try {
      await send(new UpdateCommand({ TableName: ctx.tableName, Key: companyInstallKey(companyId),
        UpdateExpression: "SET #status = :disconnected, disconnectedAt = :at, disconnectedBy = :slack",
        ConditionExpression: "teamId = :team AND connectedAt = :connectedAt AND connectedAt <= :eventAt",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":disconnected": "disconnected", ":at": at, ":slack": "slack", ":team": input.teamId, ":connectedAt": record.connectedAt, ":eventAt": eventAt } }));
    } catch (error) {
      // A reconnect landed meanwhile: it holds a new token, which must not be dropped.
      if (!(error instanceof Error) || error.name !== "ConditionalCheckFailedException") throw error;
      return { outcome: "ignored" };
    }
  }
  // Marked first, dropped second: a failure here is retried by Slack (the ingress answers 500), and the drop is idempotent.
  if (record === undefined) await ctx.wiring.slack.drop(companyId, input.teamId);
  else if (!await dropUnlessReconnected(ctx, companyId, input.teamId, record.connectedAt)) return { outcome: "ignored" };
  try {
    await send(new PutCommand({ TableName: ctx.tableName, Item: { ...auditKey(input.teamId, "REMOVED", at, "slack"), entityType: "SLACK_WORKSPACE_AUDIT", action: input.reason, teamId: input.teamId, companyId, at, actor: "slack" },
      ConditionExpression: "attribute_not_exists(pk)" }));
  } catch (error) { if (!(error instanceof Error) || error.name !== "ConditionalCheckFailedException") throw error; }
  companyLog(companyId, ctx.wiring.log)({ event: "slack.workspace_removed", teamId: input.teamId, reason: input.reason, actor: "slack" });
  return { outcome: "disconnected" };
}

