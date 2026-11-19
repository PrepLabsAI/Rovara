// Guided onboarding PR 7 (design section 3d; DEC 254l item 5): Linear's side of a company's connection, Rovara acting as the app (`actor=app`).
//
// Every call goes through the `fetch` seam the caller gives (tests: a fake Linear), to Linear's fixed addresses only, with no redirect followed, a timeout, and an answer read to a cap.
// No token, code, verifier or client secret is ever logged or put in an error: a failure is one of a few fixed kinds (`LinearOAuthFailure`), never Linear's words.
//
// Checked against Linear's developer docs on 2026-11-17 (briefs/guided-onboarding-build-20261117.md, "Pre-build checks"):
//   - authorize  https://linear.app/oauth/authorize  (client_id, redirect_uri, response_type=code, scope comma-separated, state, actor=app, prompt=consent, PKCE S256)
//   - token      POST https://api.linear.app/oauth/token  (form-encoded; authorization_code with the PKCE verifier, or refresh_token)
//   - revoke     POST https://api.linear.app/oauth/revoke  (form `token=` and `token_type_hint=`)
//   - access tokens last 24 hours; refresh tokens 30 days and ROTATE on every refresh (the old one is accepted again for 30 minutes)
//   - GraphQL    POST https://api.linear.app/graphql, `Authorization: Bearer <access token>`
import { createHash } from "node:crypto";
import { z } from "zod";

export const LINEAR_AUTHORIZE_URL = "https://linear.app/oauth/authorize";
export const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";
export const LINEAR_REVOKE_URL = "https://api.linear.app/oauth/revoke";
export const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

/**
 * The scopes Rovara asks for, and why each (the Linear tracker's own calls, plugins/tracker/linear/api.ts):
 *   read             read an issue, what is asked for now, the workspace and its teams (every app needs it);
 *   write            edit Rovara's own comment in the ticket thread (`commentUpdate`); Linear's comments:create is creation only;
 *   comments:create  post Rovara's answer on an issue (`commentCreate`);
 *   issues:create    move an issue to a named status (`issueUpdate`): Linear's issues:create covers creating AND updating issues;
 *   app:assignable   people can assign (delegate) an issue to Rovara, like a teammate (Linear agents; needs actor=app, as here);
 *   app:mentionable  people can @mention Rovara in issues, documents and comments (Linear agents; needs actor=app).
 *                    Owner 2026-11-19: asked for now, before workspaces connect, so a later assign/mention feature needs no re-authorization.
 *                    Assignments and mentions arrive as Linear "Agent session events" webhooks; until Rovara handles them they change nothing.
 * The targeted scopes stay beside `write` so the consent screen still says what Rovara does. Never `admin` (refused with actor=app, and nothing Rovara does needs it).
 * Linear takes the scopes comma-separated in the authorize address (`LINEAR_SCOPES.join(",")` below). Adding a scope later forces every connected workspace to authorize again, so it is added before workspaces connect.
 */
export const LINEAR_SCOPES = ["read", "write", "comments:create", "issues:create", "app:assignable", "app:mentionable"] as const;

const TIMEOUT_MS = 10_000;
const ANSWER_MAX_BYTES = 1_000_000;
/** The most teams one listing returns (one page; a workspace with more is refused rather than listed in part). */
export const LINEAR_TEAMS_MAX = 250;

/** Why a call to Linear did not give what was asked. `refused`: Linear answered that the code or token is not good (a 400/401 OAuth error); everything else is `unavailable`. */
export class LinearOAuthFailure extends Error {
  constructor(readonly kind: "refused" | "unavailable") {
    super(kind === "refused" ? "Linear refused the authorization" : "Linear could not be reached");
    this.name = "LinearOAuthFailure";
  }
}

export interface LinearApp {
  clientId: string;
  clientSecret: string;
  /** Where Linear sends the browser back: Cloud's `/api/connect/linear/callback` (Cloud PR 11). */
  redirectUri: string;
}

export interface LinearTokens {
  access: string;
  refresh: string;
  /** When the access token ends (ms since 1970). */
  accessExpiresAt: number;
  scope: string;
}

export interface LinearWorkspace { id: string; name: string; urlKey: string }
export interface LinearTeam { id: string; key: string; name: string }

const pkceChallenge = (verifier: string) => createHash("sha256").update(verifier, "ascii").digest("base64url");

/** The consent page's address: Rovara as the app, consent asked every time, PKCE S256. */
export function linearAuthorizeUrl(app: Pick<LinearApp, "clientId" | "redirectUri">, state: string, verifier: string): string {
  const url = new URL(LINEAR_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: app.clientId, redirect_uri: app.redirectUri, response_type: "code", scope: LINEAR_SCOPES.join(","), state,
    actor: "app", prompt: "consent", code_challenge: pkceChallenge(verifier), code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

const Token = z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/);
const TokenAnswer = z.object({
  access_token: Token, refresh_token: Token, expires_in: z.number().int().positive().max(31_536_000),
  token_type: z.string().regex(/^bearer$/i).optional(), scope: z.union([z.string().max(1000), z.array(z.string().max(100)).max(50)]).optional(),
}).passthrough();

type Fetch = typeof fetch;

async function post(fetchImpl: Fetch, url: string, headers: Record<string, string>, body: string): Promise<{ status: number; text: string }> {
  let response: Response;
  let text: string;
  try {
    response = await fetchImpl(url, { method: "POST", headers, body, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
    text = await response.text();
  } catch {
    // A network error can quote the request: only the fixed kind is thrown.
    throw new LinearOAuthFailure("unavailable");
  }
  if (Buffer.byteLength(text, "utf8") > ANSWER_MAX_BYTES) throw new LinearOAuthFailure("unavailable");
  return { status: response.status, text };
}

function tokensOf(status: number, text: string, now: number): LinearTokens {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = undefined; }
  // Only `invalid_grant` (the code or refresh token is no good) is Linear refusing the grant. Anything else (invalid_client: Rovara's app settings; a 5xx; an unreadable answer)
  // is Linear unavailable, so a misconfigured app never marks every company's connection "needs reconnect".
  const error = parsed !== null && typeof parsed === "object" ? (parsed as { error?: unknown }).error : undefined;
  if ((status === 400 || status === 401) && error === "invalid_grant") throw new LinearOAuthFailure("refused");
  if (status < 200 || status >= 300) throw new LinearOAuthFailure("unavailable");
  const answer = TokenAnswer.safeParse(parsed);
  if (!answer.success) throw new LinearOAuthFailure("unavailable");
  const scope = Array.isArray(answer.data.scope) ? answer.data.scope.join(",") : answer.data.scope ?? "";
  return { access: answer.data.access_token, refresh: answer.data.refresh_token, accessExpiresAt: now + answer.data.expires_in * 1000, scope };
}

const FORM = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };

/** Exchanges the code from the consent page (with the PKCE verifier only Code holds) for the workspace's tokens. */
export async function exchangeLinearCode(input: { fetch: Fetch; app: LinearApp; code: string; verifier: string; now: number }): Promise<LinearTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code", code: input.code, redirect_uri: input.app.redirectUri, client_id: input.app.clientId, client_secret: input.app.clientSecret, code_verifier: input.verifier,
  }).toString();
  const answer = await post(input.fetch, LINEAR_TOKEN_URL, FORM, body);
  return tokensOf(answer.status, answer.text, input.now);
}

/** Trades the refresh token for a new pair. Linear rotates the refresh token on every refresh: the answer's refresh token replaces the old one. */
export async function refreshLinearTokens(input: { fetch: Fetch; app: LinearApp; refresh: string; now: number }): Promise<LinearTokens> {
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: input.refresh, client_id: input.app.clientId, client_secret: input.app.clientSecret }).toString();
  const answer = await post(input.fetch, LINEAR_TOKEN_URL, FORM, body);
  return tokensOf(answer.status, answer.text, input.now);
}

/**
 * Revokes a token. Linear's docs do not say whether revoking one token ends the whole grant, so a disconnect revokes BOTH the refresh token and the access token, each with
 * its `token_type_hint`. Best effort: true when Linear said so (2xx) or answered 400 (the token is already revoked or no longer valid: nothing is left to revoke).
 */
export async function revokeLinearToken(input: { fetch: Fetch; token: string; hint?: "access_token" | "refresh_token" }): Promise<boolean> {
  try {
    const form = new URLSearchParams({ token: input.token });
    if (input.hint !== undefined) form.set("token_type_hint", input.hint);
    const answer = await post(input.fetch, LINEAR_REVOKE_URL, { ...FORM, authorization: `Bearer ${input.token}` }, form.toString());
    return (answer.status >= 200 && answer.status < 300) || answer.status === 400;
  } catch { return false; }
}

async function graphql(fetchImpl: Fetch, access: string, query: string): Promise<Record<string, unknown>> {
  const answer = await post(fetchImpl, LINEAR_GRAPHQL_URL, { authorization: `Bearer ${access}`, "content-type": "application/json", accept: "application/json" }, JSON.stringify({ query }));
  if (answer.status === 401 || answer.status === 403) throw new LinearOAuthFailure("refused");
  if (answer.status < 200 || answer.status >= 300) throw new LinearOAuthFailure("unavailable");
  let parsed: unknown;
  try { parsed = JSON.parse(answer.text); } catch { throw new LinearOAuthFailure("unavailable"); }
  const envelope = z.object({ data: z.record(z.string(), z.unknown()).nullish(), errors: z.array(z.unknown()).optional() }).passthrough().safeParse(parsed);
  if (!envelope.success || (envelope.data.errors !== undefined && envelope.data.errors.length > 0) || envelope.data.data === undefined || envelope.data.data === null) {
    throw new LinearOAuthFailure("unavailable");
  }
  return envelope.data.data;
}

const Id = z.string().regex(/^[A-Za-z0-9-]{1,100}$/);
const Name = z.string().min(1).max(256);
const Workspace = z.object({ id: Id, name: Name, urlKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/) }).passthrough();
const Team = z.object({ id: Id, key: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,9}$/), name: Name }).passthrough();

/** The workspace (Linear's organization) the new token belongs to, read with that token (`viewer { organization { id name urlKey } }`, as connections/store.ts reads it). */
export async function linearWorkspaceOf(input: { fetch: Fetch; access: string }): Promise<LinearWorkspace> {
  const data = await graphql(input.fetch, input.access, "query { viewer { organization { id name urlKey } } }");
  const viewer = data["viewer"];
  const organization = viewer !== null && typeof viewer === "object" ? (viewer as { organization?: unknown }).organization : undefined;
  const parsed = Workspace.safeParse(organization);
  if (!parsed.success) throw new LinearOAuthFailure("unavailable");
  return { id: parsed.data.id, name: parsed.data.name, urlKey: parsed.data.urlKey.toLowerCase() };
}

/** The teams the token can see (one page of at most LINEAR_TEAMS_MAX; more is refused whole, never listed in part). */
export async function linearTeamsOf(input: { fetch: Fetch; access: string }): Promise<LinearTeam[]> {
  const data = await graphql(input.fetch, input.access, `query { teams(first: ${String(LINEAR_TEAMS_MAX)}) { nodes { id key name } pageInfo { hasNextPage } } }`);
  const teams = z.object({ nodes: z.array(z.unknown()).max(LINEAR_TEAMS_MAX), pageInfo: z.object({ hasNextPage: z.boolean() }).passthrough().optional() }).passthrough().safeParse(data["teams"]);
  if (!teams.success || teams.data.pageInfo?.hasNextPage === true) throw new LinearOAuthFailure("unavailable");
  const found: LinearTeam[] = [];
  for (const node of teams.data.nodes) {
    const team = Team.safeParse(node);
    // A team that can't be read makes the whole answer unreadable: nothing is guessed.
    if (!team.success) throw new LinearOAuthFailure("unavailable");
    found.push({ id: team.data.id, key: team.data.key, name: team.data.name });
  }
  return found;
}
