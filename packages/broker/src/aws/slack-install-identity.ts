// Guided onboarding PR 4: the Slack app's side of Add to Slack, run in the sign-in Lambda (DeveloperIdentity), the one Code function that holds the Slack app's client
// secret (agentx/<env>/slack; the broker never reads it, R2). The broker's routes (slack-company-install.ts) decide everything about companies; this side only talks to
// slack.com and to the per-company token store, by one direct invoke kind, "slack-install":
//   client-id                         -> the app's client id (not a secret)
//   exchange { code, redirectUri }    -> oauth.v2.access, checked (the bot token comes back to the broker in memory, for it to store or revoke after its binding check)
//   revoke { botToken }               -> auth.revoke
//   store { companyId, teamId, botToken } / revoke-stored { companyId, teamId } / drop { companyId, teamId } -> the token store's writer
// Nothing here logs an invoke's payload or Slack's answer.
import { CreateSecretCommand, GetSecretValueCommand, PutSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { z } from "zod";
import { OrgIdSchema, SlackUserIdSchema } from "@agentx/contracts";
import { slackWorkspaceTeam } from "./slack-workspace-binding.js";
import { slackWebFetch } from "./slack-web.js";

const TIMEOUT_MS = 8_000;
const TeamName = z.string().min(1).max(200);
const validToken = (value: unknown): value is string => typeof value === "string" && value.length <= 4096 && /^xoxb-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(value);

/** What Slack's oauth.v2.access answered, already checked (https://docs.slack.dev/reference/methods/oauth.v2.access). */
export interface SlackInstallGrant { teamId: string; teamName?: string; botToken: string; botUserId: string; installerSlackUserId: string }
export type SlackExchange = { kind: "granted"; grant: SlackInstallGrant } | { kind: "enterprise"; botToken?: string } | { kind: "refused" };

export interface SlackInstallSecrets {
  /** Writes the company's bot token at agentx/<env>/slack-workspaces/<company>/<team> (creates it, or puts a new value). */
  putToken(companyId: string, teamId: string, botToken: string): Promise<void>;
  /** The stored bot token, or undefined (none, or dropped). A failed read throws. */
  readToken(companyId: string, teamId: string): Promise<string | undefined>;
  /** Overwrites the stored token with a value that holds none (the token store then finds none). Missing is fine. */
  dropToken(companyId: string, teamId: string): Promise<void>;
}

/** RFC 6749 2.3.1: client id and secret form-encoded inside the Basic header (Slack recommends Basic for oauth.v2.access). */
const formEncode = (value: string): string => new URLSearchParams([["v", value]]).toString().slice(2);

/** oauth.v2.access, checked. Any shape but a bot grant for one workspace (or an Enterprise Grid org install) is "refused". Never logs or echoes the answer. */
export async function exchangeSlackInstallCode(fetchFn: typeof fetch, client: { clientId: string; clientSecret: string }, code: string, redirectUri: string): Promise<SlackExchange> {
  let answer: unknown;
  try {
    const response = await fetchFn("https://slack.com/api/oauth.v2.access", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${Buffer.from(`${formEncode(client.clientId)}:${formEncode(client.clientSecret)}`).toString("base64")}` },
      body: new URLSearchParams({ code, redirect_uri: redirectUri }).toString(),
    });
    if (!response.ok) return { kind: "refused" };
    const text = await response.text();
    if (text.length > 65_536) return { kind: "refused" };
    answer = JSON.parse(text) as unknown;
  } catch { return { kind: "refused" }; }
  if (answer === null || typeof answer !== "object" || Array.isArray(answer)) return { kind: "refused" };
  const value = answer as { ok?: unknown; token_type?: unknown; access_token?: unknown; bot_user_id?: unknown; is_enterprise_install?: unknown; team?: unknown; authed_user?: unknown };
  if (value.ok !== true) return { kind: "refused" };
  const token = validToken(value.access_token) && value.token_type === "bot" ? value.access_token : undefined;
  if (value.is_enterprise_install === true) return token === undefined ? { kind: "enterprise" } : { kind: "enterprise", botToken: token };
  if (value.is_enterprise_install !== false && value.is_enterprise_install !== undefined) return { kind: "refused" };
  const team = (value.team ?? {}) as { id?: unknown; name?: unknown };
  const installer = (value.authed_user ?? {}) as { id?: unknown };
  const botUser = SlackUserIdSchema.safeParse(value.bot_user_id);
  const installerId = SlackUserIdSchema.safeParse(installer.id);
  if (token === undefined || !botUser.success || !installerId.success) return { kind: "refused" };
  // Team ids only, as today (slackWorkspaceTeam): an Enterprise Grid org (E...) is not a workspace.
  if (!slackWorkspaceTeam(team.id)) return { kind: "enterprise", botToken: token };
  const name = typeof team.name === "string" ? TeamName.safeParse([...team.name].filter((char) => char.charCodeAt(0) > 31 && char.charCodeAt(0) !== 127).join("").trim()) : undefined;
  return { kind: "granted", grant: { teamId: team.id, ...(name?.success === true ? { teamName: name.data } : {}), botToken: token, botUserId: botUser.data, installerSlackUserId: installerId.data } };
}

/** auth.revoke through the broker's Slack Web API transport (slack-web.ts). Best effort: true when Slack says it is revoked (or was already). */
export async function revokeSlackToken(fetchFn: typeof fetch, token: string): Promise<boolean> {
  try {
    const response = await slackWebFetch("auth.revoke", token, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" }, fetchFn);
    const answer = await response.json() as { ok?: unknown; revoked?: unknown; error?: unknown };
    return (answer.ok === true && answer.revoked === true) || answer.error === "token_revoked" || answer.error === "invalid_auth" || answer.error === "account_inactive";
  } catch { return false; }
}


// ---- The token store's writer (the reader is slack-workspace-tokens.ts) -----------------------------------------------------------------------------------------

/** The secret name the token store reads (slack-workspace-tokens.ts): company and team checked, never from a caller's text. */
export function slackWorkspaceSecretName(environment: string, companyId: string, teamId: string): string {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(environment) || !OrgIdSchema.safeParse(companyId).success || !slackWorkspaceTeam(teamId)) throw new Error("secret name");
  return `agentx/${environment}/slack-workspaces/${companyId}/${teamId}`;
}
/** What a dropped token leaves behind: a value with no botToken, which the token store reads as "none". */
export const DROPPED_TOKEN_VALUE = JSON.stringify({ removed: true });

export function slackInstallSecretsFromSecretsManager(client: { send(command: unknown): Promise<unknown> }, environment: string): SlackInstallSecrets {
  const named = (error: unknown, name: string) => error instanceof Error && error.name === name;
  return {
    async putToken(companyId, teamId, botToken) {
      if (!validToken(botToken)) throw new Error("token");
      const name = slackWorkspaceSecretName(environment, companyId, teamId);
      const value = JSON.stringify({ botToken });
      try { await client.send(new CreateSecretCommand({ Name: name, SecretString: value, Description: "Rovara bot token for one company's Slack workspace (Add to Slack)" })); }
      catch (error) {
        if (!named(error, "ResourceExistsException")) throw error;
        await client.send(new PutSecretValueCommand({ SecretId: name, SecretString: value }));
      }
    },
    async readToken(companyId, teamId) {
      try {
        const answer = await client.send(new GetSecretValueCommand({ SecretId: slackWorkspaceSecretName(environment, companyId, teamId) })) as { SecretString?: unknown };
        if (typeof answer.SecretString !== "string" || answer.SecretString.length > 8192) return undefined;
        const token = (JSON.parse(answer.SecretString) as { botToken?: unknown } | null)?.botToken;
        return validToken(token) ? token : undefined;
      } catch (error) {
        if (named(error, "ResourceNotFoundException")) return undefined;
        throw error;
      }
    },
    async dropToken(companyId, teamId) {
      try { await client.send(new PutSecretValueCommand({ SecretId: slackWorkspaceSecretName(environment, companyId, teamId), SecretString: DROPPED_TOKEN_VALUE })); }
      catch (error) { if (!named(error, "ResourceNotFoundException")) throw error; }
    },
  };
}

// ---- The invoke ---------------------------------------------------------------------------------------------------------------------------------------------------

const Team = z.string().max(32).refine(slackWorkspaceTeam);
const Token = z.string().refine(validToken);
export const SlackInstallRequestSchema = z.discriminatedUnion("op", [
  z.object({ kind: z.literal("slack-install"), op: z.literal("client-id") }).strict(),
  z.object({ kind: z.literal("slack-install"), op: z.literal("exchange"), code: z.string().regex(/^[A-Za-z0-9._-]{1,256}$/), redirectUri: z.string().url().max(512) }).strict(),
  z.object({ kind: z.literal("slack-install"), op: z.literal("revoke"), botToken: Token }).strict(),
  z.object({ kind: z.literal("slack-install"), op: z.literal("store"), companyId: OrgIdSchema, teamId: Team, botToken: Token }).strict(),
  z.object({ kind: z.literal("slack-install"), op: z.literal("revoke-stored"), companyId: OrgIdSchema, teamId: Team }).strict(),
  z.object({ kind: z.literal("slack-install"), op: z.literal("drop"), companyId: OrgIdSchema, teamId: Team }).strict(),
]);
export type SlackInstallRequest = z.infer<typeof SlackInstallRequestSchema>;

export interface SlackInstallIdentityDependencies {
  /** The Slack app's client id and secret (the sign-in Lambda's Slack secret); undefined while they are not stored. */
  appClient(): Promise<{ clientId?: string | undefined; clientSecret?: string | undefined }>;
  secrets: SlackInstallSecrets;
  fetch: typeof fetch;
}

const clientOf = async (deps: SlackInstallIdentityDependencies) => {
  const { clientId, clientSecret } = await deps.appClient();
  return typeof clientId === "string" && /^[0-9]{1,24}\.[0-9]{1,24}$/.test(clientId) && typeof clientSecret === "string" && /^[A-Za-z0-9]{16,128}$/.test(clientSecret)
    ? { clientId, clientSecret } : undefined;
};

/** The sign-in Lambda's answer to one "slack-install" invoke. A malformed request is refused before anything is called. */
export async function handleSlackInstallRequest(deps: SlackInstallIdentityDependencies, event: unknown): Promise<Record<string, unknown>> {
  const parsed = SlackInstallRequestSchema.safeParse(event);
  if (!parsed.success) return { ok: false, error: "invalid_request" };
  const request = parsed.data;
  try {
    switch (request.op) {
      case "client-id": { const client = await clientOf(deps); return client === undefined ? { ok: false, error: "not_set_up" } : { ok: true, clientId: client.clientId }; }
      case "exchange": {
        const client = await clientOf(deps);
        if (client === undefined) return { ok: false, error: "not_set_up" };
        return { ok: true, exchange: await exchangeSlackInstallCode(deps.fetch, client, request.code, request.redirectUri) };
      }
      case "revoke": return { ok: true, revoked: await revokeSlackToken(deps.fetch, request.botToken) };
      case "store": await deps.secrets.putToken(request.companyId, request.teamId, request.botToken); return { ok: true };
      case "revoke-stored": {
        const token = await deps.secrets.readToken(request.companyId, request.teamId);
        if (token !== undefined && !await revokeSlackToken(deps.fetch, token)) return { ok: false, error: "failed" };
        await deps.secrets.dropToken(request.companyId, request.teamId);
        return { ok: true };
      }
      case "drop": await deps.secrets.dropToken(request.companyId, request.teamId); return { ok: true };
    }
  } catch { return { ok: false, error: "failed" }; }
}

const ExchangeReply = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("granted"), grant: z.object({ teamId: Team, teamName: TeamName.optional(), botToken: Token, botUserId: SlackUserIdSchema, installerSlackUserId: SlackUserIdSchema }).strict() }).strict(),
  z.object({ kind: z.literal("enterprise"), botToken: Token.optional() }).strict(),
  z.object({ kind: z.literal("refused") }).strict(),
]);

/** The broker's half: the Slack side through the sign-in Lambda (the broker already invokes it). Every reply is checked again; anything else throws. */
export function slackInstallThroughLambda(invoke: (payload: Uint8Array) => Promise<{ FunctionError?: string | undefined; Payload?: Uint8Array | undefined }>) {
  const call = async (request: SlackInstallRequest): Promise<Record<string, unknown>> => {
    const response = await invoke(Buffer.from(JSON.stringify(request)));
    if (response.FunctionError !== undefined || response.Payload === undefined) throw new Error("slack install invoke failed");
    const reply = JSON.parse(Buffer.from(response.Payload).toString("utf8")) as unknown;
    if (reply === null || typeof reply !== "object" || Array.isArray(reply)) throw new Error("slack install invoke failed");
    return reply as Record<string, unknown>;
  };
  const done = async (request: SlackInstallRequest) => { if ((await call(request)).ok !== true) throw new Error("slack install failed"); };
  return {
    async clientId() { const reply = await call({ kind: "slack-install", op: "client-id" }); return reply.ok === true && typeof reply.clientId === "string" ? reply.clientId : undefined; },
    async exchange(code: string, redirectUri: string): Promise<SlackExchange | "not_set_up"> {
      const reply = await call({ kind: "slack-install", op: "exchange", code, redirectUri });
      if (reply.ok === false && reply.error === "not_set_up") return "not_set_up";
      if (reply.ok !== true) throw new Error("slack install failed");
      return ExchangeReply.parse(reply.exchange) as SlackExchange;
    },
    async revoke(botToken: string) { const reply = await call({ kind: "slack-install", op: "revoke", botToken }); return reply.ok === true && reply.revoked === true; },
    store: (companyId: string, teamId: string, botToken: string) => done({ kind: "slack-install", op: "store", companyId, teamId, botToken }),
    revokeStored: (companyId: string, teamId: string) => done({ kind: "slack-install", op: "revoke-stored", companyId, teamId }),
    drop: (companyId: string, teamId: string) => done({ kind: "slack-install", op: "drop", companyId, teamId }),
  };
}
