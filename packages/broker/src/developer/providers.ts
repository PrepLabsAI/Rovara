// Spec 025 FR-002 to FR-004: the Slack and company OIDC providers. The code exchange runs here,
// server side, with the client secret; the laptop never sees it.
import { createHash } from "node:crypto";
import { jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { claimValues } from "../aws/lambda.js";
import { GITHUB_ISSUER_URL, githubDisplayName } from "./github-profile.js";
import { SLACK_OIDC_ISSUER, SlackTeamIdSchema, SlackUserIdSchema, cleanDisplayName, type DeveloperSignInMethod, CLI_COMMAND_NAME } from "@agentx/contracts";

/** `administrator` (spec 063 FR-005): the company sign-in's ID token carried the administrator claim. Slack never sets it. */
/** `authTime` (lane ID part 2, company sign-in only): the ID token's `auth_time`, epoch seconds, when it carried a whole number. Slack's is never read: a Slack round trip never counts as a step-up. */
/**
 * `slackTeam` (DEC 254e, only with `anyWorkspace`): the Slack workspace the person signed in with. `slackUserId` is set only for the install's own
 * workspace (the one its bot and directory serve); a person from another workspace has none, and their subject carries the team.
 */
export interface ProviderIdentity { method: DeveloperSignInMethod; issuer: string; subject: string; displayName: string; email?: string; slackUserId?: string; slackTeam?: { id: string; name?: string }; administrator?: true; authTime?: number }
/** `wrongAccount`: the person signed in fine but is not one AgentX accepts (another Slack workspace,
 * or without the required claim), so signing in as someone else may help. */
export type ProviderResult = { ok: true; identity: ProviderIdentity } | { ok: false; reason: string; wrongAccount?: true };
/** The provider could not be reached; try again. */
export class ProviderUnavailableError extends Error { override name = "ProviderUnavailableError"; }
/** An admin must finish setting the provider up. */
export class ProviderNotConfiguredError extends Error { override name = "ProviderNotConfiguredError"; }

export interface SignInProvider {
  readonly method: DeveloperSignInMethod;
  /** `reauthenticate` (lane ID part 2): a step-up; a company sign-in is asked to sign the person in again (`prompt=login`, `max_age`). Slack ignores it. */
  authorizeUrl(input: { state: string; nonce: string; redirectUri: string; reauthenticate?: { maxAgeSeconds: number } }): Promise<string>;
  complete(input: { code: string; nonce: string; redirectUri: string }): Promise<ProviderResult>;
}

const SCOPES = "openid email profile";
const TIMEOUT_MS = 8_000;

async function call(fetchFn: typeof fetch, url: string, init: RequestInit, what: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchFn(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new ProviderUnavailableError(`${what} could not be reached; try again in a minute`);
  }
  if (response.status === 429 || response.status >= 500) throw new ProviderUnavailableError(`${what} answered HTTP ${response.status}; try again in a minute`);
  try {
    return await response.json();
  } catch {
    throw new ProviderUnavailableError(`${what} answered with something other than JSON; try again in a minute`);
  }
}

/** Only the provider's short error code, never anything else it echoed back. */
const errorCode = (error: unknown): string => (typeof error === "string" ? error.replace(/[^a-z_]/g, "").slice(0, 64) : "") || "no reason given";

/**
 * RFC 6749 section 2.3.1: the client ID and secret are form-encoded before they go in the Basic
 * header. This is the WHATWG application/x-www-form-urlencoded serializer (space becomes "+", and
 * everything but letters, digits and `*-._` is percent-encoded).
 */
const formEncode = (value: string): string => new URLSearchParams([["v", value]]).toString().slice(2);

const NOT_VERIFIED = `the identity token could not be verified; run ${CLI_COMMAND_NAME} login again`;

async function verifyIdToken(idToken: string, jwks: JWTVerifyGetKey, options: { issuer: string; audience: string; nonce: string; now: number }): Promise<{ ok: true; payload: JWTPayload } | { ok: false; reason: string }> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(idToken, jwks, {
      issuer: options.issuer, audience: options.audience, currentDate: new Date(options.now), algorithms: ["RS256", "ES256"],
      requiredClaims: ["exp", "iat"], clockTolerance: 60, maxTokenAge: "10m",
    }));
  } catch {
    return { ok: false, reason: NOT_VERIFIED };
  }
  // OIDC Core 3.1.3.7: with several audiences azp is required, and when present it must be us.
  if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp === undefined) return { ok: false, reason: NOT_VERIFIED };
  if (payload.azp !== undefined && payload.azp !== options.audience) return { ok: false, reason: NOT_VERIFIED };
  if (payload.nonce !== options.nonce) return { ok: false, reason: `the identity token's nonce does not match this sign-in; run ${CLI_COMMAND_NAME} login again` };
  return { ok: true, payload };
}

const verifiedEmail = (payload: JWTPayload): string | undefined =>
  typeof payload.email === "string" && (payload.email_verified === true || payload.email_verified === "true") ? payload.email : undefined;

/**
 * `anyWorkspace` (DEC 254e, Code's company layer only): any Slack workspace may sign in, not just the install's. The authorize link names no team;
 * a person from another workspace gets the subject `<team id>:<user id>` (Slack user ids are only unique inside a workspace, and an install-workspace
 * subject has no colon, so the two never collide) and no `slackUserId`. Off: exactly as before (the install's workspace only).
 */
export function slackSignInProvider(input: {
  anyWorkspace?: boolean; teamId: string | undefined; credentials: () => Promise<{ clientId?: string; clientSecret?: string }>; fetch: typeof fetch; jwks: JWTVerifyGetKey; now: () => number;
}): SignInProvider {
  const configured = async () => {
    if (input.teamId === undefined) throw new ProviderNotConfiguredError(`this Rovara environment has no Slack team ID yet; ask an admin to run ${CLI_COMMAND_NAME} signin enable slack`);
    const { clientId, clientSecret } = await input.credentials();
    if (clientId === undefined || clientSecret === undefined) throw new ProviderNotConfiguredError(`the Slack app's client ID and client secret are not stored yet; ask an admin to run ${CLI_COMMAND_NAME} signin enable slack`);
    return { teamId: input.teamId, clientId, clientSecret };
  };
  return {
    method: "slack",
    async authorizeUrl({ state, nonce, redirectUri }) {
      const { teamId, clientId } = await configured();
      const url = new URL("https://slack.com/openid/connect/authorize");
      for (const [key, value] of Object.entries({ response_type: "code", scope: SCOPES, client_id: clientId, state, nonce, redirect_uri: redirectUri, ...(input.anyWorkspace === true ? {} : { team: teamId }) })) url.searchParams.set(key, value);
      return url.toString();
    },
    async complete({ code, nonce, redirectUri }) {
      const { teamId, clientId, clientSecret } = await configured();
      const body = await call(input.fetch, "https://slack.com/api/openid.connect.token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }).toString(),
      }, "Slack") as { ok?: boolean; error?: unknown; id_token?: unknown };
      if (body.error === "ratelimited") throw new ProviderUnavailableError("Slack is rate limiting sign-ins; try again in a minute");
      if (body.ok !== true || typeof body.id_token !== "string") {
        return { ok: false, reason: `Slack refused the sign-in (${errorCode(body.error)}); run ${CLI_COMMAND_NAME} login again` };
      }
      const verified = await verifyIdToken(body.id_token, input.jwks, { issuer: SLACK_OIDC_ISSUER, audience: clientId, nonce, now: input.now() });
      if (!verified.ok) return verified;
      const team = verified.payload["https://slack.com/team_id"];
      if (input.anyWorkspace === true) return slackAnyWorkspaceIdentity(verified.payload, teamId);
      if (team !== teamId) return { ok: false, wrongAccount: true, reason: `you signed in to Slack workspace ${SlackTeamIdSchema.safeParse(team).data ?? "unknown"}, but this AgentX serves ${teamId}` };
      const userId = SlackUserIdSchema.safeParse(verified.payload["https://slack.com/user_id"]);
      if (!userId.success) return { ok: false, reason: `Slack's identity token names no Slack user; run ${CLI_COMMAND_NAME} login again` };
      const email = verifiedEmail(verified.payload);
      return {
        ok: true,
        identity: {
          method: "slack", issuer: SLACK_OIDC_ISSUER, subject: userId.data,
          displayName: (typeof verified.payload.name === "string" ? cleanDisplayName(verified.payload.name) : undefined) ?? userId.data,
          ...(email === undefined ? {} : { email }),
          slackUserId: userId.data,
        },
      };
    },
  };
}

/** DEC 254e: a verified Slack identity from any workspace. Anything unreadable refuses; nothing is guessed. */
function slackAnyWorkspaceIdentity(payload: JWTPayload, installTeam: string): ProviderResult {
  const team = SlackTeamIdSchema.safeParse(payload["https://slack.com/team_id"]);
  const userId = SlackUserIdSchema.safeParse(payload["https://slack.com/user_id"]);
  if (!team.success || !userId.success) return { ok: false, reason: `Slack's identity token names no Slack workspace or user; run ${CLI_COMMAND_NAME} login again` };
  const own = team.data === installTeam;
  const email = verifiedEmail(payload);
  const rawName = payload["https://slack.com/team_name"];
  const teamName = typeof rawName === "string" ? cleanDisplayName(rawName)?.slice(0, 80) : undefined;
  return {
    ok: true,
    identity: {
      method: "slack", issuer: SLACK_OIDC_ISSUER, subject: own ? userId.data : `${team.data}:${userId.data}`,
      displayName: (typeof payload.name === "string" ? cleanDisplayName(payload.name) : undefined) ?? userId.data,
      // Another workspace's admins control its members' emails (they can edit them, or assert any address through their own SSO), so an email
      // from there proves nothing to Rovara: it spends no invite, enters no email index and never becomes a factor email.
      ...(own && email !== undefined ? { email } : {}),
      ...(own ? { slackUserId: userId.data } : {}),
      slackTeam: { id: team.data, ...(teamName === undefined || teamName === "" ? {} : { name: teamName }) },
    },
  };
}

/** Read as the admin client reads it (identityFromJwtClaims): any of the values in the claim. */
function isAdministrator(payload: JWTPayload, administrator: { claim: string; values: readonly string[] } | undefined): boolean {
  if (administrator === undefined || administrator.values.length === 0) return false;
  return claimValues(payload[administrator.claim]).some((value) => administrator.values.includes(value));
}

interface Discovery { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string }

export function oidcSignInProvider(input: {
  issuer: string; clientId: string; clientSecret: () => Promise<string>; requiredClaim?: string; requiredValues: readonly string[];
  /** Spec 063 FR-005: the claim and values that make an administrator, as the admin client reads them; absent, nobody is one. */
  administrator?: { claim: string; values: readonly string[] };
  fetch: typeof fetch; jwksFor: (jwksUri: string) => JWTVerifyGetKey; now: () => number;
}): SignInProvider {
  const issuer = input.issuer.replace(/\/+$/, "");
  let discovery: Promise<Discovery> | undefined;
  const discover = () => {
    if (input.requiredClaim === undefined && input.requiredValues.length > 0) {
      return Promise.reject(new ProviderNotConfiguredError("company sign-in lists required values but no claim to check them against; ask an admin to set DeveloperOidcRequiredClaim"));
    }
    discovery ??= call(input.fetch, `${issuer}/.well-known/openid-configuration`, {}, "the company sign-in provider").then((value) => {
      const doc = value as Partial<Discovery>;
      if (typeof doc.issuer !== "string" || doc.issuer.replace(/\/+$/, "") !== issuer) {
        throw new ProviderNotConfiguredError(`the company sign-in provider's discovery document names a different issuer than ${issuer}; ask an admin to check DeveloperOidcIssuer`);
      }
      for (const key of ["authorization_endpoint", "token_endpoint", "jwks_uri"] as const) {
        const endpoint = doc[key];
        if (typeof endpoint !== "string" || !endpoint.startsWith("https://")) throw new ProviderNotConfiguredError(`the company sign-in provider's discovery document has no HTTPS ${key}; ask an admin to check the provider`);
      }
      return doc as Discovery;
    }).catch((error: unknown) => {
      discovery = undefined;
      throw error;
    });
    return discovery;
  };
  return {
    method: "oidc",
    async authorizeUrl({ state, nonce, redirectUri, reauthenticate }) {
      const doc = await discover();
      const url = new URL(doc.authorization_endpoint);
      for (const [key, value] of Object.entries({ response_type: "code", scope: SCOPES, client_id: input.clientId, state, nonce, redirect_uri: redirectUri })) url.searchParams.set(key, value);
      // OpenID Connect Core 3.1.2.1: ask the company's sign-in to authenticate again and to say when (auth_time).
      if (reauthenticate !== undefined) {
        url.searchParams.set("prompt", "login");
        url.searchParams.set("max_age", String(reauthenticate.maxAgeSeconds));
      }
      return url.toString();
    },
    async complete({ code, nonce, redirectUri }) {
      const doc = await discover();
      const secret = await input.clientSecret();
      const basic = Buffer.from(`${formEncode(input.clientId)}:${formEncode(secret)}`).toString("base64");
      const body = await call(input.fetch, doc.token_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${basic}` },
        body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri }).toString(),
      }, "the company sign-in provider") as { id_token?: unknown; error?: unknown };
      if (typeof body.id_token !== "string") {
        return { ok: false, reason: `the company sign-in provider refused the sign-in (${errorCode(body.error)}); run ${CLI_COMMAND_NAME} login again` };
      }
      const verified = await verifyIdToken(body.id_token, input.jwksFor(doc.jwks_uri), { issuer: doc.issuer, audience: input.clientId, nonce, now: input.now() });
      if (!verified.ok) return verified;
      const payload = verified.payload;
      if (input.requiredClaim !== undefined && input.requiredValues.length > 0) {
        const raw = payload[input.requiredClaim];
        const values = Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === "string") : typeof raw === "string" ? raw.split(/[\s,]+/) : [];
        if (!input.requiredValues.some((value) => values.includes(value))) {
          return { ok: false, wrongAccount: true, reason: `this AgentX requires the ${input.requiredClaim} claim to include ${input.requiredValues.join(" or ")}` };
        }
      }
      if (typeof payload.sub !== "string" || payload.sub === "") return { ok: false, reason: "the identity token has no subject; ask an admin to check the company sign-in app" };
      const email = verifiedEmail(payload);
      const name = [payload.name, payload.preferred_username, email].find((value): value is string => typeof value === "string" && value !== "");
      return {
        ok: true,
        identity: {
          method: "oidc", issuer, subject: payload.sub,
          displayName: (name === undefined ? undefined : cleanDisplayName(name)) ?? payload.sub,
          ...(email === undefined ? {} : { email }),
          ...(isAdministrator(payload, input.administrator) ? { administrator: true as const } : {}),
          ...(typeof payload.auth_time === "number" && Number.isSafeInteger(payload.auth_time) && payload.auth_time > 0 ? { authTime: payload.auth_time } : {}),
        },
      };
    },
  };
}

/** DEC 254h: GitHub's issuer, as Code records it (GitHub is OAuth 2, not OpenID Connect: there is no ID token and no discovery). */
export const GITHUB_ISSUER = GITHUB_ISSUER_URL;
/** What Code asks GitHub for: the profile (the stable numeric id and a name) and the email addresses, to find the primary verified one. */
export const GITHUB_SCOPES = "read:user user:email";
const GITHUB_API = "https://api.github.com";
/** GitHub's user ids are positive whole numbers; the login can be renamed and reused, so it is never the subject. */
const GITHUB_ID_MAX = Number.MAX_SAFE_INTEGER;
/** At most this many email rows are read; a longer answer is read only this far (the primary one is never missing from a real answer of this size). */
const GITHUB_EMAILS_MAX = 100;

/** One GitHub call through the injected fetch, with its HTTP status. 429 and 5xx: try again. Anything not JSON: unavailable. */
async function githubCall(fetchFn: typeof fetch, url: string, init: RequestInit): Promise<{ status: number; body: unknown }> {
  let response: Response;
  try {
    response = await fetchFn(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new ProviderUnavailableError("GitHub could not be reached; try again in a minute");
  }
  if (response.status === 429 || response.status >= 500) throw new ProviderUnavailableError(`GitHub answered HTTP ${response.status}; try again in a minute`);
  try {
    return { status: response.status, body: await response.json() };
  } catch {
    throw new ProviderUnavailableError("GitHub answered with something other than JSON; try again in a minute");
  }
}

/**
 * DEC 254h: sign-in with GitHub (an OAuth app). Authorize with PKCE S256 (the verifier is this sign-in's own single-use nonce, so a code is only
 * redeemable by the request that asked for it), exchange the code server side with the client secret, then read the user (subject = GitHub's
 * stable numeric id, never the login) and their emails. Only the primary AND verified email is used; none such: no email (the person can still
 * join with an invite secret). GitHub's access token is used for those two reads and then dropped: it is never stored, logged or returned.
 */
export function githubSignInProvider(input: { clientId: string; clientSecret: () => Promise<string>; fetch: typeof fetch; now: () => number }): SignInProvider {
  const challenge = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");
  const refused = (reason: string): ProviderResult => ({ ok: false, reason: `GitHub refused the sign-in (${reason}); run ${CLI_COMMAND_NAME} login again` });
  return {
    method: "github",
    async authorizeUrl({ state, nonce, redirectUri }) {
      const url = new URL("https://github.com/login/oauth/authorize");
      for (const [key, value] of Object.entries({ client_id: input.clientId, redirect_uri: redirectUri, scope: GITHUB_SCOPES, state, code_challenge: challenge(nonce), code_challenge_method: "S256", allow_signup: "true" })) url.searchParams.set(key, value);
      return url.toString();
    },
    async complete({ code, nonce, redirectUri }) {
      const secret = await input.clientSecret();
      const token = await githubCall(input.fetch, "https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: input.clientId, client_secret: secret, code, redirect_uri: redirectUri, code_verifier: nonce }).toString(),
      });
      const grant = token.body as { access_token?: unknown; token_type?: unknown; error?: unknown } | null;
      if (token.status !== 200 || grant === null || typeof grant !== "object") return refused("no token");
      if (typeof grant.access_token !== "string" || grant.access_token === "" || grant.access_token.length > 4096 || typeof grant.token_type !== "string" || grant.token_type.toLowerCase() !== "bearer") {
        return refused(errorCode(grant.error));
      }
      const headers = { accept: "application/vnd.github+json", authorization: `Bearer ${grant.access_token}`, "user-agent": "Rovara-sign-in", "x-github-api-version": "2022-11-28" };
      const user = await githubCall(input.fetch, `${GITHUB_API}/user`, { headers });
      const profile = user.body as { id?: unknown; login?: unknown; name?: unknown } | null;
      if (user.status !== 200 || profile === null || typeof profile !== "object" || typeof profile.id !== "number" || !Number.isSafeInteger(profile.id) || profile.id <= 0 || profile.id > GITHUB_ID_MAX
        || typeof profile.login !== "string" || !/^[A-Za-z0-9-]{1,39}$/.test(profile.login)) {
        return { ok: false, reason: `GitHub's answer names no GitHub user; run ${CLI_COMMAND_NAME} login again` };
      }
      // A failed or unreadable email list is no email (never a guess): the person can still sign in, and join only with an invite secret.
      const emails = await githubCall(input.fetch, `${GITHUB_API}/user/emails?per_page=${GITHUB_EMAILS_MAX}`, { headers });
      const rows = emails.status === 200 && Array.isArray(emails.body) ? emails.body.slice(0, GITHUB_EMAILS_MAX) : [];
      const chosen = rows.filter((row): row is { email: string } => typeof row === "object" && row !== null && (row as { primary?: unknown }).primary === true
        && (row as { verified?: unknown }).verified === true && typeof (row as { email?: unknown }).email === "string");
      const email = chosen.length === 1 && chosen[0]!.email.length <= 320 && /^[^\s@]+@[^\s@]+$/.test(chosen[0]!.email) ? chosen[0]!.email : undefined;
      const subject = String(profile.id);
      return {
        ok: true,
        identity: {
          method: "github", issuer: GITHUB_ISSUER, subject,
          // DEC 254p (a): the GitHub name, or the login when none is set; untrusted text, cut and stripped of markup (github-profile.ts).
          displayName: githubDisplayName(profile.name, profile.login),
          ...(email === undefined ? {} : { email }),
        },
      };
    },
  };
}
