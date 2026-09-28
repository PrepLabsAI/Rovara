// Spec 025 FR-002 to FR-004: the Slack and company OIDC providers. The code exchange runs here,
// server side, with the client secret; the laptop never sees it.
import { jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { SLACK_OIDC_ISSUER, SlackTeamIdSchema, SlackUserIdSchema, cleanDisplayName, type DeveloperSignInMethod } from "@agentx/contracts";

export interface ProviderIdentity { method: DeveloperSignInMethod; issuer: string; subject: string; displayName: string; email?: string; slackUserId?: string }
/** `wrongAccount`: the person signed in fine but is not one AgentX accepts (another Slack workspace,
 * or without the required claim), so signing in as someone else may help. */
export type ProviderResult = { ok: true; identity: ProviderIdentity } | { ok: false; reason: string; wrongAccount?: true };
/** The provider could not be reached; try again. */
export class ProviderUnavailableError extends Error { override name = "ProviderUnavailableError"; }
/** An admin must finish setting the provider up. */
export class ProviderNotConfiguredError extends Error { override name = "ProviderNotConfiguredError"; }

export interface SignInProvider {
  readonly method: DeveloperSignInMethod;
  authorizeUrl(input: { state: string; nonce: string; redirectUri: string }): Promise<string>;
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

const NOT_VERIFIED = "the identity token could not be verified; run agentx login again";

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
  if (payload.nonce !== options.nonce) return { ok: false, reason: "the identity token's nonce does not match this sign-in; run agentx login again" };
  return { ok: true, payload };
}

const verifiedEmail = (payload: JWTPayload): string | undefined =>
  typeof payload.email === "string" && (payload.email_verified === true || payload.email_verified === "true") ? payload.email : undefined;

export function slackSignInProvider(input: {
  teamId: string | undefined; credentials: () => Promise<{ clientId?: string; clientSecret?: string }>; fetch: typeof fetch; jwks: JWTVerifyGetKey; now: () => number;
}): SignInProvider {
  const configured = async () => {
    if (input.teamId === undefined) throw new ProviderNotConfiguredError("this AgentX environment has no Slack team ID yet; ask an admin to run agentx signin enable slack");
    const { clientId, clientSecret } = await input.credentials();
    if (clientId === undefined || clientSecret === undefined) throw new ProviderNotConfiguredError("the Slack app's client ID and client secret are not stored yet; ask an admin to run agentx signin enable slack");
    return { teamId: input.teamId, clientId, clientSecret };
  };
  return {
    method: "slack",
    async authorizeUrl({ state, nonce, redirectUri }) {
      const { teamId, clientId } = await configured();
      const url = new URL("https://slack.com/openid/connect/authorize");
      for (const [key, value] of Object.entries({ response_type: "code", scope: SCOPES, client_id: clientId, state, nonce, redirect_uri: redirectUri, team: teamId })) url.searchParams.set(key, value);
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
        return { ok: false, reason: `Slack refused the sign-in (${errorCode(body.error)}); run agentx login again` };
      }
      const verified = await verifyIdToken(body.id_token, input.jwks, { issuer: SLACK_OIDC_ISSUER, audience: clientId, nonce, now: input.now() });
      if (!verified.ok) return verified;
      const team = verified.payload["https://slack.com/team_id"];
      if (team !== teamId) return { ok: false, wrongAccount: true, reason: `you signed in to Slack workspace ${SlackTeamIdSchema.safeParse(team).data ?? "unknown"}, but this AgentX serves ${teamId}` };
      const userId = SlackUserIdSchema.safeParse(verified.payload["https://slack.com/user_id"]);
      if (!userId.success) return { ok: false, reason: "Slack's identity token names no Slack user; run agentx login again" };
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

interface Discovery { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string }

export function oidcSignInProvider(input: {
  issuer: string; clientId: string; clientSecret: () => Promise<string>; requiredClaim?: string; requiredValues: readonly string[];
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
    async authorizeUrl({ state, nonce, redirectUri }) {
      const doc = await discover();
      const url = new URL(doc.authorization_endpoint);
      for (const [key, value] of Object.entries({ response_type: "code", scope: SCOPES, client_id: input.clientId, state, nonce, redirect_uri: redirectUri })) url.searchParams.set(key, value);
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
        return { ok: false, reason: `the company sign-in provider refused the sign-in (${errorCode(body.error)}); run agentx login again` };
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
        },
      };
    },
  };
}
