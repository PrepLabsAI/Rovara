// Shared fakes for the developer sign-in (spec 025 phase 25a). Nothing here reaches AWS, Slack or
// any identity provider.
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import { GetPublicKeyCommand, SignCommand } from "@aws-sdk/client-kms";
import { SignJWT, createLocalJWKSet, type JWTVerifyGetKey } from "jose";
import type { PublicSigningJwk, TokenSigner } from "../../packages/broker/src/developer/tokens.js";
import { kmsTokenSigner } from "../../packages/broker/src/developer/tokens.js";

export const T0 = Date.parse("2026-09-27T12:00:00.000Z");
export const API = "https://abc123.execute-api.us-east-1.amazonaws.com";
export const ISSUER = `${API}/v1/auth`;

export function rsaKeyPair(): { privateKey: KeyObject; publicKey: KeyObject } {
  return generateKeyPairSync("rsa", { modulusLength: 2048 });
}

/** A KMS client that signs with a local RSA key, and records every command it received. */
export function fakeKms(keys = rsaKeyPair()) {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  return {
    calls,
    publicKey: keys.publicKey,
    async send(command: unknown): Promise<unknown> {
      const name = (command as { constructor: { name: string } }).constructor.name;
      const input = (command as { input: Record<string, unknown> }).input;
      calls.push({ name, input });
      if (command instanceof GetPublicKeyCommand) {
        return { KeySpec: "RSA_2048", KeyUsage: "SIGN_VERIFY", PublicKey: new Uint8Array(keys.publicKey.export({ format: "der", type: "spki" })) };
      }
      if (command instanceof SignCommand) {
        if (input.MessageType !== "RAW" || input.SigningAlgorithm !== "RSASSA_PKCS1_V1_5_SHA_256") throw new Error("unexpected signing request");
        return { Signature: new Uint8Array(cryptoSign("sha256", Buffer.from(input.Message as Uint8Array), keys.privateKey)) };
      }
      throw new Error(`fakeKms does not support ${name}`);
    },
  };
}

/** The signer every server test uses: the real KMS signer over the fake KMS. */
export function localSigner(): TokenSigner & { jwks(): Promise<{ keys: PublicSigningJwk[] }> } {
  const signer = kmsTokenSigner({ kms: fakeKms(), keyId: "arn:aws:kms:us-east-1:123456789012:key/test" });
  return { ...signer, jwks: async () => ({ keys: [await signer.publicJwk()] }) };
}

export const TEAM = "T0TEAM1";
export const SLACK_CLIENT_ID = "1111111111.2222222222222";
export const SLACK_CLIENT_SECRET = "0123456789abcdef0123456789abcdef";
export const BOT_TOKEN = "xoxb-1111-2222-plantedbottoken";
export const OIDC_ISSUER = "https://idp.example.test";
export const OIDC_CLIENT_ID = "agentx-developers";
export const OIDC_CLIENT_SECRET = "planted-oidc-client-secret-value";

type Handler = (url: URL, init: RequestInit | undefined) => Promise<Response | undefined>;

/** One fetch for several fakes: the first handler that answers wins; anything else throws. */
export function routeFetch(...handlers: Handler[]): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push(`${init?.method ?? "GET"} ${url.origin}${url.pathname}`);
    for (const handler of handlers) {
      const response = await handler(url, init);
      if (response !== undefined) return response;
    }
    throw new Error(`test setup: unexpected fetch ${url.href}`);
  }) as typeof fetch & { calls: string[] };
  fn.calls = calls;
  return fn;
}

function signingKey() {
  const keys = rsaKeyPair();
  const kid = `k${Math.random().toString(36).slice(2, 8)}`;
  const jwk = { ...keys.publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };
  return { keys, kid, jwks: createLocalJWKSet({ keys: [jwk] }), jwk };
}

const form = (init: RequestInit | undefined) => new URLSearchParams(typeof init?.body === "string" ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : "");

export interface FakeSlackUser { userId: string; teamId?: string; name: string; email?: string; emailVerified?: boolean; deleted?: boolean; isBot?: boolean; enterpriseTeams?: string[] }

/** Slack's OpenID Connect and Web API, as far as the sign-in uses them. */
export function fakeSlack(options: { users: FakeSlackUser[]; channels?: Record<string, string[]>; scopes?: string[] }) {
  const signer = signingKey();
  const codes = new Map<string, { user: FakeSlackUser; nonce: string; redirectUri: string; teamId: string }>();
  const state = { down: false, rateLimited: false, secretSeen: [] as string[] };
  const user = (id: string) => options.users.find((candidate) => candidate.userId === id);
  const userJson = (u: FakeSlackUser) => ({
    id: u.userId, team_id: u.teamId ?? TEAM, deleted: u.deleted === true, is_bot: u.isBot === true, real_name: u.name,
    ...(u.enterpriseTeams ? { enterprise_user: { teams: u.enterpriseTeams } } : {}),
  });
  const handler: Handler = async (url, init) => {
    if (url.hostname !== "slack.com") return undefined;
    if (state.down) throw new TypeError("fetch failed");
    if (state.rateLimited) return Response.json({ ok: false, error: "ratelimited" }, { status: 429 });
    const bearer = new Headers(init?.headers).get("authorization");
    if (url.pathname === "/api/openid.connect.token") {
      const body = form(init);
      state.secretSeen.push(body.get("client_secret") ?? "");
      if (body.get("client_id") !== SLACK_CLIENT_ID || body.get("client_secret") !== SLACK_CLIENT_SECRET) return Response.json({ ok: false, error: "invalid_client" });
      const grant = codes.get(body.get("code") ?? "");
      if (grant === undefined || grant.redirectUri !== body.get("redirect_uri")) return Response.json({ ok: false, error: "invalid_code" });
      codes.delete(body.get("code") ?? "");
      const idToken = await new SignJWT({
        nonce: grant.nonce, name: grant.user.name,
        ...(grant.user.email === undefined ? {} : { email: grant.user.email, email_verified: grant.user.emailVerified ?? true }),
        "https://slack.com/user_id": grant.user.userId, "https://slack.com/team_id": grant.teamId,
      }).setProtectedHeader({ alg: "RS256", kid: signer.kid }).setIssuer("https://slack.com").setAudience(SLACK_CLIENT_ID)
        .setSubject(grant.user.userId).setIssuedAt().setExpirationTime("5m").sign(signer.keys.privateKey);
      return Response.json({ ok: true, access_token: "xoxp-user-token-unused", id_token: idToken });
    }
    if (bearer !== `Bearer ${BOT_TOKEN}`) return Response.json({ ok: false, error: "invalid_auth" });
    if (url.pathname === "/api/auth.test") {
      return Response.json({ ok: true, team_id: TEAM, team: "Acme", user_id: "U0BOT0001", bot_id: "B0BOT0001" }, { headers: { "x-oauth-scopes": (options.scopes ?? []).join(",") } });
    }
    if (url.pathname === "/api/users.info") {
      const found = user(url.searchParams.get("user") ?? "");
      return Response.json(found ? { ok: true, user: userJson(found) } : { ok: false, error: "user_not_found" });
    }
    if (url.pathname === "/api/users.lookupByEmail") {
      const found = options.users.find((candidate) => candidate.email === url.searchParams.get("email"));
      return Response.json(found ? { ok: true, user: userJson(found) } : { ok: false, error: "users_not_found" });
    }
    if (url.pathname === "/api/conversations.members") {
      const members = options.channels?.[url.searchParams.get("channel") ?? ""];
      if (members === undefined) return Response.json({ ok: false, error: "channel_not_found" });
      const start = Number(url.searchParams.get("cursor") || "0");
      const page = members.slice(start, start + 2);
      const next = start + 2 < members.length ? String(start + 2) : "";
      return Response.json({ ok: true, members: page, response_metadata: { next_cursor: next } });
    }
    return undefined;
  };
  return {
    state,
    handler,
    jwks: signer.jwks as JWTVerifyGetKey,
    /** What the browser does at Slack: `userId` approves the authorize URL; returns the callback URL. */
    approve(authorizeUrl: string, userId: string, overrides: { teamId?: string } = {}): string {
      const url = new URL(authorizeUrl);
      if (url.origin + url.pathname !== "https://slack.com/openid/connect/authorize") throw new Error(`test setup: not a Slack authorize URL: ${authorizeUrl}`);
      if (url.searchParams.get("client_id") !== SLACK_CLIENT_ID) throw new Error("test setup: wrong client_id");
      const found = user(userId);
      if (found === undefined) throw new Error(`test setup: no Slack user ${userId}`);
      const code = `slack-code-${Math.random().toString(36).slice(2)}`;
      const redirectUri = url.searchParams.get("redirect_uri") ?? "";
      codes.set(code, { user: found, nonce: url.searchParams.get("nonce") ?? "", redirectUri, teamId: overrides.teamId ?? found.teamId ?? TEAM });
      return `${redirectUri}?code=${code}&state=${url.searchParams.get("state") ?? ""}`;
    },
  };
}

export interface FakeOidcUser { sub: string; name?: string; email?: string; email_verified?: boolean; groups?: string[] }

/** A company OIDC provider with discovery, a token endpoint (client_secret_basic) and keys. */
export function fakeOidc(options: { users: FakeOidcUser[] }) {
  const signer = signingKey();
  const codes = new Map<string, { user: FakeOidcUser; nonce: string; redirectUri: string }>();
  const state = { down: false };
  const handler: Handler = async (url, init) => {
    if (url.origin !== OIDC_ISSUER) return undefined;
    if (state.down) throw new TypeError("fetch failed");
    if (url.pathname === "/.well-known/openid-configuration") {
      return Response.json({ issuer: OIDC_ISSUER, authorization_endpoint: `${OIDC_ISSUER}/authorize`, token_endpoint: `${OIDC_ISSUER}/token`, jwks_uri: `${OIDC_ISSUER}/jwks` });
    }
    if (url.pathname === "/token") {
      const expected = `Basic ${Buffer.from(`${encodeURIComponent(OIDC_CLIENT_ID)}:${encodeURIComponent(OIDC_CLIENT_SECRET)}`).toString("base64")}`;
      if (new Headers(init?.headers).get("authorization") !== expected) return Response.json({ error: "invalid_client" }, { status: 401 });
      const body = form(init);
      const grant = codes.get(body.get("code") ?? "");
      if (grant === undefined || grant.redirectUri !== body.get("redirect_uri")) return Response.json({ error: "invalid_grant" }, { status: 400 });
      codes.delete(body.get("code") ?? "");
      const { sub, ...claims } = grant.user;
      const idToken = await new SignJWT({ ...claims, nonce: grant.nonce }).setProtectedHeader({ alg: "RS256", kid: signer.kid })
        .setIssuer(OIDC_ISSUER).setAudience(OIDC_CLIENT_ID).setSubject(sub).setIssuedAt().setExpirationTime("5m").sign(signer.keys.privateKey);
      return Response.json({ access_token: "unused", token_type: "Bearer", id_token: idToken });
    }
    return undefined;
  };
  return {
    state,
    handler,
    jwks: signer.jwks as JWTVerifyGetKey,
    approve(authorizeUrl: string, sub: string): string {
      const url = new URL(authorizeUrl);
      if (url.origin + url.pathname !== `${OIDC_ISSUER}/authorize`) throw new Error(`test setup: not the OIDC authorize URL: ${authorizeUrl}`);
      const found = options.users.find((candidate) => candidate.sub === sub);
      if (found === undefined) throw new Error(`test setup: no OIDC user ${sub}`);
      const code = `oidc-code-${Math.random().toString(36).slice(2)}`;
      const redirectUri = url.searchParams.get("redirect_uri") ?? "";
      codes.set(code, { user: found, nonce: url.searchParams.get("nonce") ?? "", redirectUri });
      return `${redirectUri}?code=${code}&state=${url.searchParams.get("state") ?? ""}`;
    },
  };
}
