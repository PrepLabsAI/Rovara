// packages/broker/src/developer/server.ts
// Spec 025 FR-001 to FR-008: the control plane as the developers' sign-in server. Behind
// ANY /v1/auth/{proxy+} with no authorizer, plus direct-invoke operations for the broker
// (channel members, channel names for R10, 25d's email lookup and bot token check, and 25e's
// admin-ended sessions and channel by name).
// Nothing here logs or echoes a secret, a code, a token or a caught error's message.
import { createHash, randomBytes } from "node:crypto";
import {
  AGENTX_CLI_CLIENT_ID,
  ChannelInfoRequestSchema,
  ChannelByNameRequestSchema,
  ChannelMembersRequestSchema,
  ADMIN_API_VERSION,
  DEVELOPER_API_VERSION,
  EndDeveloperSessionsRequestSchema,
  SlackAuthCheckRequestSchema,
  SlackUserByEmailRequestSchema,
  isLoopbackRedirectUri,
  type AgentXConfigurationConfirm,
  type ChannelByNameRequest,
  type ChannelByNameResponse,
  type ChannelInfoRequest,
  type ChannelInfoResponse,
  type ChannelMembersRequest,
  type ChannelMembersResponse,
  type DeveloperSignInMethod,
  type EndDeveloperSessionsRequest,
  type EndDeveloperSessionsResponse,
  type SlackAuthCheckRequest,
  type SlackAuthCheckResponse,
  type SlackUserByEmailRequest,
  type SlackUserByEmailResponse,
} from "@agentx/contracts";
import { adaptHttpApiEvent, ownerKeyForSubject, type HttpApiV2Event } from "../aws/lambda.js";
import { ProviderNotConfiguredError, ProviderUnavailableError, type ProviderResult, type SignInProvider } from "./providers.js";
import type { SlackDirectory } from "./slack-directory.js";
import { endedByAdmin, startedBeforeMethodOn, type AuthRequestRecord, type DeveloperSignInStore, type SessionRecord } from "./store.js";
import { issueAccessToken, pkceChallengeMatches, type TokenSigner } from "./tokens.js";

/** `since` (epoch seconds, FR-045): when the method was last turned on. A session started before it
 * was ended by the disable in between, so it never comes back when the method is on again. */
export interface DeveloperIdentityConfig { env: string; issuer: string; slack: { enabled: boolean; teamId?: string; since?: number }; oidc?: { displayName: string; since?: number }; confirmElicitation?: boolean }
export interface DeveloperIdentityDependencies {
  config: DeveloperIdentityConfig;
  store: DeveloperSignInStore;
  signer: TokenSigner;
  providers: Partial<Record<DeveloperSignInMethod, SignInProvider>>;
  directory: SlackDirectory;
  now: () => number;
  log: (entry: Record<string, unknown>) => void;
}
export interface HttpResult { statusCode: number; headers: Record<string, string>; body: string; cookies?: string[] }
/** The invoke's answer: the broker's contract, plus a refusal for a request that is not one. */
export type ChannelMembersResult = ChannelMembersResponse | { ok: false; error: "invalid_request" };

const CHALLENGE = /^[A-Za-z0-9_-]{43,128}$/;
const REVIEW_RETURN_TO = /^\/review\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REVIEW_PKCE_COOKIE = "__Host-agentx_review_pkce";
const REVIEW_SESSION_COOKIE = "__Host-agentx_review_session";
const REVIEW_SESSION_MAX_AGE_SECONDS = 900;
const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store", pragma: "no-cache" };
const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};
/** AWS errors that mean "try again": the store rethrows these instead of deciding reuse. */
const RETRYABLE_AWS_ERRORS = new Set([
  "TransactionCanceledException", "TransactionConflictException", "TransactionInProgressException", "ThrottlingException",
  "ProvisionedThroughputExceededException", "RequestLimitExceeded", "InternalServerError", "ServiceUnavailable", "TimeoutError",
]);

export function enabledMethods(deps: Pick<DeveloperIdentityDependencies, "config" | "providers">): DeveloperSignInMethod[] {
  const methods: DeveloperSignInMethod[] = [];
  if (deps.config.slack.enabled && deps.config.slack.teamId !== undefined && deps.providers.slack !== undefined) methods.push("slack");
  if (deps.config.oidc !== undefined && deps.providers.oidc !== undefined) methods.push("oidc");
  return methods;
}

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escape = (text: string) => text.replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c);

function page(statusCode: number, title: string, paragraphs: string[], links: Array<{ href: string; label: string }> = []): HttpResult {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title>`
    + `<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5}a.method{display:block;margin:.75rem 0;padding:.75rem 1rem;border:1px solid #888;border-radius:.5rem;text-decoration:none;color:inherit}</style></head>`
    + `<body><main><h1>${escape(title)}</h1>${paragraphs.map((p) => `<p>${escape(p)}</p>`).join("")}`
    + `${links.map((link) => `<a class="method" href="${escape(link.href)}">${escape(link.label)}</a>`).join("")}</main></body></html>`;
  return { statusCode, headers: { ...HTML_HEADERS }, body };
}

const jsonResult = (statusCode: number, body: unknown): HttpResult => ({ statusCode, headers: { ...JSON_HEADERS }, body: JSON.stringify(body) });
/** Public, cacheable documents (discovery, keys): no pragma, which belongs only beside no-store. */
const publicJson = (body: unknown): HttpResult =>
  ({ statusCode: 200, headers: { "content-type": "application/json", "cache-control": "public, max-age=300" }, body: JSON.stringify(body) });
const redirect = (location: string): HttpResult => ({ statusCode: 302, headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer" }, body: "" });
const oauthError = (status: number, error: string, description: string) => jsonResult(status, { error, error_description: description });
const errorName = (error: unknown) => (error instanceof Error ? error.name : "unknown");

function isRetryableAwsError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const meta = error as { $retryable?: unknown; $metadata?: { httpStatusCode?: number } };
  return RETRYABLE_AWS_ERRORS.has(error.name) || meta.$retryable !== undefined || (meta.$metadata?.httpStatusCode ?? 0) >= 500;
}

function toClient(redirectUri: string, params: Record<string, string>): HttpResult {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return redirect(url.toString());
}

const expired = () => page(400, "This sign-in link has expired", ["Run agentx login again."]);
/** One answer for every code failure (unknown, used, expired, wrong verifier, wrong redirect URI). */
const INVALID_CODE = ["invalid_grant", "the sign-in code is invalid, used or expired; run agentx login again"] as const;
const SIGN_IN_ENDED = ["invalid_grant", "your AgentX sign-in has ended; run agentx login again"] as const;

export function createDeveloperIdentityHandler(deps: DeveloperIdentityDependencies) {
  const { config, store } = deps;
  const endpoint = (path: string) => `${config.issuer}${path}`;
  const methodLabel = (method: DeveloperSignInMethod) => (method === "slack" ? "Slack" : config.oidc?.displayName ?? "company sign-in");
  const provider = (method: DeveloperSignInMethod): SignInProvider => {
    const found = deps.providers[method];
    if (found === undefined) throw new ProviderNotConfiguredError(`${methodLabel(method)} sign-in is not set up in this environment`);
    return found;
  };

  const accessToken = (session: SessionRecord) =>
    issueAccessToken(deps.signer, { issuer: config.issuer, subject: session.developerId, amr: session.amr, env: config.env, sessionId: session.sessionId, now: deps.now() });
  const tokens = (access: { token: string; expiresIn: number }, refreshToken: string): HttpResult =>
    jsonResult(200, { access_token: access.token, token_type: "Bearer", expires_in: access.expiresIn, refresh_token: refreshToken });

  async function revoke(sessionId: string, reason: string): Promise<void> {
    await store.revokeSession(sessionId, reason);
    deps.log({ event: "signin.session_revoked", sessionId, reason });
  }

  async function authorize(query: URLSearchParams): Promise<HttpResult> {
    const methods = enabledMethods(deps);
    const requestId = query.get("request");
    if (requestId !== null) {
      const method = query.get("method");
      if ((method !== "slack" && method !== "oidc") || !methods.includes(method)) return page(400, "Sign-in method not available", ["Run agentx login again."]);
      const request = await store.chooseMethod(requestId, method);
      if (request === undefined) return expired();
      try {
        return await toProvider(request.id, request.nonce, method, request.clientRedirectUri, request.clientState);
      } catch (error) {
        return serverError(error, "/v1/auth/authorize", request.clientRedirectUri, request.clientState);
      }
    }
    const redirectUri = query.get("redirect_uri") ?? "";
    if (query.get("client_id") !== AGENTX_CLI_CLIENT_ID || !isLoopbackRedirectUri(redirectUri)) {
      return page(400, "This sign-in link is not from the AgentX CLI", ["Start signing in from your terminal with agentx login <url>."]);
    }
    const clientState = query.get("state") ?? "";
    const challenge = query.get("code_challenge") ?? "";
    const invalid = (description: string) => toClient(redirectUri, { error: "invalid_request", error_description: description, ...(clientState === "" ? {} : { state: clientState }) });
    if (query.get("response_type") !== "code") return invalid("response_type must be code; update the AgentX CLI and run agentx login again");
    if (query.get("code_challenge_method") !== "S256" || !CHALLENGE.test(challenge)) return invalid("PKCE with S256 is required; update the AgentX CLI and run agentx login again");
    if (clientState.length < 1 || clientState.length > 512) return invalid("state is required; update the AgentX CLI and run agentx login again");
    if (methods.length === 0) {
      return toClient(redirectUri, { error: "access_denied", state: clientState, error_description: "developer sign-in is not enabled in this AgentX environment; ask an admin to run agentx signin enable slack" });
    }
    let request: AuthRequestRecord;
    try {
      request = await store.createAuthRequest({ clientRedirectUri: redirectUri, clientState, codeChallenge: challenge, nonce: randomBytes(32).toString("base64url") });
      if (methods.length === 1) {
        const method = methods[0]!;
        if (await store.chooseMethod(request.id, method) === undefined) return expired();
        return await toProvider(request.id, request.nonce, method, redirectUri, clientState);
      }
    } catch (error) {
      return serverError(error, "/v1/auth/authorize", redirectUri, clientState);
    }
    return page(200, "Sign in to AgentX", [`Environment: ${config.env}`], methods.map((method) => ({
      href: `${endpoint("/authorize")}?request=${encodeURIComponent(request.id)}&method=${method}`,
      label: `Sign in with ${methodLabel(method)}`,
    })));
  }

  async function authorizeBrowser(query: URLSearchParams): Promise<HttpResult> {
    const returnTo = query.get("return_to") ?? "";
    if (!REVIEW_RETURN_TO.test(returnTo)) return page(400, "Invalid review link", ["Open the review from Slack and sign in again."]);
    const methods = enabledMethods(deps);
    if (methods.length === 0) return page(503, "Sign-in is unavailable", ["Ask an AgentX administrator to enable a sign-in method."]);
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const auth = await store.createAuthRequest({
      clientRedirectUri: endpoint("/browser/callback"), clientState: randomBytes(24).toString("base64url"),
      codeChallenge: challenge, nonce: randomBytes(32).toString("base64url"), browserReturnTo: returnTo,
    });
    const cookie = `${REVIEW_PKCE_COOKIE}=${verifier}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=600`;
    if (methods.length === 1) {
      const selected = await store.chooseMethod(auth.id, methods[0]!);
      if (selected === undefined) return page(400, "This sign-in link expired", ["Open the review from Slack and try again."]);
      try {
        const target = await provider(methods[0]!).authorizeUrl({ state: auth.id, nonce: auth.nonce, redirectUri: endpoint(`/callback/${methods[0]}`) });
        return { ...redirect(target), cookies: [cookie] };
      } catch (error) {
        deps.log({ event: "signin.browser_authorize_failed", method: methods[0], error: errorName(error) });
        return { ...page(503, "Sign-in is unavailable", ["Try opening the review again in a moment."]), cookies: [cookie] };
      }
    }
    return { ...page(200, "Sign in to AgentX", [`Environment: ${config.env}`], methods.map(method => ({
      href: `${endpoint("/authorize")}?request=${encodeURIComponent(auth.id)}&method=${method}`,
      label: `Sign in with ${methodLabel(method)}`,
    }))), cookies: [cookie] };
  }

  /** Once the CLI's redirect URI and state are known, any failure goes back to the CLI, so it never
   * waits out its timeout behind a 500 page. Only the error's name is logged. */
  function serverError(error: unknown, path: string, clientRedirect: string, clientState: string): HttpResult {
    deps.log({ event: "signin.error", path, error: errorName(error) });
    return toClient(clientRedirect, { error: "server_error", error_description: "sign-in failed on the AgentX server; run agentx login again", state: clientState });
  }

  async function toProvider(requestId: string, nonce: string, method: DeveloperSignInMethod, clientRedirect: string, clientState: string): Promise<HttpResult> {
    try {
      return redirect(await provider(method).authorizeUrl({ state: requestId, nonce, redirectUri: endpoint(`/callback/${method}`) }));
    } catch (error) {
      return providerFailure(error, method, clientRedirect, clientState);
    }
  }

  function providerFailure(error: unknown, method: DeveloperSignInMethod, clientRedirect: string, clientState: string): HttpResult {
    if (error instanceof ProviderUnavailableError) {
      deps.log({ event: "signin.provider_unavailable", method });
      return toClient(clientRedirect, { error: "temporarily_unavailable", state: clientState, error_description: `${methodLabel(method)} could not be reached; run agentx login again in a minute` });
    }
    if (error instanceof ProviderNotConfiguredError) {
      // These messages are written by the providers and the Lambda entry, never copied from a
      // secret or a remote answer, so they are safe to show and log.
      deps.log({ event: "signin.not_configured", method, detail: error.message });
      return toClient(clientRedirect, { error: "access_denied", state: clientState, error_description: `${methodLabel(method)} sign-in is not finished: ${error.message}` });
    }
    throw error;
  }

  const browserReturn = (returnTo: string, signedIn: boolean, sessionId?: string): HttpResult => ({
    statusCode: 302,
    headers: { location: returnTo, "cache-control": "no-store", "referrer-policy": "no-referrer" },
    body: "",
    cookies: [
      `${REVIEW_PKCE_COOKIE}=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
      ...(signedIn && sessionId !== undefined ? [`${REVIEW_SESSION_COOKIE}=${sessionId}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${REVIEW_SESSION_MAX_AGE_SECONDS}`] : []),
    ],
  });

  async function callback(method: DeveloperSignInMethod, query: URLSearchParams, headers: Record<string, string | undefined>): Promise<HttpResult> {
    const state = query.get("state") ?? "";
    const pending = state === "" ? undefined : await store.getAuthRequest(state);
    if (pending === undefined || pending.method !== method) return expired();
    // Single use: the state (and with it the nonce) is consumed before anything else happens.
    const request = await store.consumeAuthRequest(state, method);
    if (request === undefined) return page(400, "This sign-in link was already used", ["Run agentx login again."]);
    if (request.browserReturnTo !== undefined) {
      const verifier = (headers.cookie ?? "").split(";").map(part => part.trim()).find(part => part.startsWith(`${REVIEW_PKCE_COOKIE}=`))?.slice(REVIEW_PKCE_COOKIE.length + 1);
      if (!REVIEW_RETURN_TO.test(request.browserReturnTo) || verifier === undefined || !pkceChallengeMatches(verifier, request.codeChallenge)) {
        return page(400, "This review sign-in link expired", ["Open the review from Slack and sign in again."]);
      }
    }
    try {
      return await completeSignIn(method, request, query.get("code"));
    } catch (error) {
      // The state is spent, so tell the CLI now rather than leave it waiting for its timeout.
      if (request.browserReturnTo !== undefined) {
        deps.log({ event: "signin.browser_error", method, error: errorName(error) });
        return browserReturn(request.browserReturnTo, false);
      }
      return serverError(error, `/v1/auth/callback/${method}`, request.clientRedirectUri, request.clientState);
    }
  }

  async function completeSignIn(method: DeveloperSignInMethod, request: AuthRequestRecord, code: string | null): Promise<HttpResult> {
    const client = (params: Record<string, string>) => toClient(request.clientRedirectUri, { ...params, state: request.clientState });
    if (request.browserReturnTo !== undefined && !REVIEW_RETURN_TO.test(request.browserReturnTo)) return page(400, "Invalid review link", ["Open the review from Slack and sign in again."]);
    if (code === null) return request.browserReturnTo === undefined
      ? client({ error: "access_denied", error_description: `the sign-in was cancelled at ${methodLabel(method)}; run agentx login again` })
      : browserReturn(request.browserReturnTo, false);
    let result: ProviderResult;
    try {
      result = await provider(method).complete({ code, nonce: request.nonce, redirectUri: endpoint(`/callback/${method}`) });
    } catch (error) {
      if (request.browserReturnTo !== undefined) throw error;
      return providerFailure(error, method, request.clientRedirectUri, request.clientState);
    }
    if (!result.ok) {
      deps.log({ event: "signin.refused", method, reason: result.reason });
      if (request.browserReturnTo !== undefined) return browserReturn(request.browserReturnTo, false);
      // A provider may quietly reuse the refused account's session on the next try, so say how to switch.
      const hint = result.wrongAccount === true ? `. If you signed in with the wrong account, sign out of ${methodLabel(method)} or use a private window, then try again.` : "";
      return client({ error: "access_denied", error_description: `${result.reason}${hint}` });
    }
    const identity = result.identity;
    const developerId = ownerKeyForSubject(identity.issuer, identity.subject);
    const existing = await store.getDeveloper(developerId);
    if (existing?.revoked === true) {
      deps.log({ event: "signin.refused", method, reason: "developer_revoked", developerId });
      if (request.browserReturnTo !== undefined) return browserReturn(request.browserReturnTo, false);
      return client({ error: "access_denied", error_description: "your AgentX sign-in was turned off by an admin; contact an admin" });
    }
    let slackUserId = identity.slackUserId;
    // ProviderIdentity.email is set only for a verified email (providers.ts), so only a verified
    // email is ever looked up in Slack.
    if (slackUserId === undefined && identity.email !== undefined) {
      const link = await deps.directory.lookupByEmail(identity.email);
      slackUserId = link === "unavailable" ? existing?.slackUserId : link === "none" ? undefined : link.userId;
    }
    await store.upsertDeveloper({
      developerId, provider: method, issuer: identity.issuer, subject: identity.subject, displayName: identity.displayName,
      ...(identity.email === undefined ? {} : { email: identity.email }),
      ...(slackUserId === undefined ? {} : { slackUserId }),
    });
    if (request.browserReturnTo !== undefined) {
      const { session } = await store.createSession({ developerId, amr: method, ...(slackUserId === undefined ? {} : { slackUserId }) });
      deps.log({ event: "signin.browser_succeeded", method, developerId });
      return browserReturn(request.browserReturnTo, true, session.sessionId);
    }
    const agentxCode = await store.issueCode({ developerId, amr: method, ...(slackUserId === undefined ? {} : { slackUserId }), codeChallenge: request.codeChallenge, redirectUri: request.clientRedirectUri });
    deps.log({ event: "signin.succeeded", method, developerId, linkedToSlack: slackUserId !== undefined });
    return client({ code: agentxCode });
  }

  async function authorizationCodeGrant(form: URLSearchParams, methods: DeveloperSignInMethod[]): Promise<HttpResult> {
    const redeemed = await store.redeemCode({ code: form.get("code") ?? "", verifier: form.get("code_verifier") ?? "", redirectUri: form.get("redirect_uri") ?? "" });
    if (redeemed === undefined) return oauthError(400, ...INVALID_CODE);
    if (!methods.includes(redeemed.amr)) return oauthError(400, "invalid_grant", `${methodLabel(redeemed.amr)} sign-in was turned off in this environment; run agentx login again`);
    const developer = await store.getDeveloper(redeemed.developerId);
    if (developer === undefined || developer.revoked) return oauthError(400, "invalid_grant", "your AgentX sign-in was turned off by an admin; contact an admin");
    const { session, refreshToken } = await store.createSession(redeemed);
    deps.log({ event: "signin.session_started", method: redeemed.amr, developerId: redeemed.developerId, sessionId: session.sessionId });
    return tokens(await accessToken(session), refreshToken);
  }

  async function refreshTokenGrant(form: URLSearchParams, methods: DeveloperSignInMethod[]): Promise<HttpResult> {
    const lookup = await store.lookupRefresh(form.get("refresh_token") ?? "");
    const ended = oauthError(400, ...SIGN_IN_ENDED);
    if (lookup.kind === "unknown" || lookup.kind === "ended") return ended;
    if (lookup.kind === "reused") {
      await revoke(lookup.sessionId, "refresh_token_reused");
      return ended;
    }
    // "active", or "recently_rotated": the same token presented again inside the grace window.
    const { session } = lookup;
    if (!methods.includes(session.amr)) {
      await revoke(session.sessionId, "method_disabled");
      return oauthError(400, "invalid_grant", `${methodLabel(session.amr)} sign-in was turned off in this environment; sign in another way with agentx login`);
    }
    if (startedBeforeMethodOn(session.startedAt, session.amr === "slack" ? config.slack.since : config.oidc?.since)) {
      await revoke(session.sessionId, "method_disabled");
      return oauthError(400, "invalid_grant", `your sign-in ended when ${methodLabel(session.amr)} was turned off; sign in again with agentx login`);
    }
    const developer = await store.getDeveloper(session.developerId);
    if (developer === undefined || developer.revoked) {
      await revoke(session.sessionId, "developer_revoked");
      return ended;
    }
    if (endedByAdmin(session.startedAt, developer.sessionsEndedAt)) {
      await revoke(session.sessionId, "ended_by_admin");
      return oauthError(400, "invalid_grant", "an AgentX admin ended your sign-in; sign in again with agentx login");
    }
    if (session.amr === "slack" && session.slackUserId !== undefined) {
      const status = await deps.directory.userStatus(session.slackUserId);
      if (status === "unavailable") return oauthError(503, "temporarily_unavailable", "Slack could not be reached to check your account; your sign-in is kept, try again in a few minutes");
      if (status === "gone") {
        await revoke(session.sessionId, "slack_user_inactive");
        return oauthError(400, "invalid_grant", "your Slack account is no longer active in this workspace; contact an admin");
      }
    }
    // Signed before the rotation: a signing failure then leaves the presented token untouched.
    const access = await accessToken(session);
    const rotated = lookup.kind === "active" ? await store.rotateRefresh(lookup) : await store.rotateRecentlyUsed(lookup);
    if ("reused" in rotated) {
      await revoke(session.sessionId, "refresh_token_reused");
      return ended;
    }
    if ("ended" in rotated) return ended;
    if (lookup.kind === "recently_rotated") deps.log({ event: "signin.refresh_grace", sessionId: session.sessionId });
    return tokens(access, rotated.refreshToken);
  }

  async function token(form: URLSearchParams): Promise<HttpResult> {
    if (form.get("client_id") !== AGENTX_CLI_CLIENT_ID) return oauthError(401, "invalid_client", "unknown client; use the AgentX CLI");
    const methods = enabledMethods(deps);
    const grant = form.get("grant_type");
    if (grant === "authorization_code") return authorizationCodeGrant(form, methods);
    if (grant === "refresh_token") return retryable("token", () => refreshTokenGrant(form, methods));
    return oauthError(400, "unsupported_grant_type", "use authorization_code or refresh_token");
  }

  /** A retryable AWS error anywhere in fn answers 503 and changes nothing more; others propagate. */
  async function retryable(operation: string, fn: () => Promise<HttpResult>): Promise<HttpResult> {
    try {
      return await fn();
    } catch (error) {
      if (!isRetryableAwsError(error)) throw error;
      deps.log({ event: "signin.retry", operation, error: errorName(error) });
      return oauthError(503, "temporarily_unavailable", "AgentX could not finish this just now; your sign-in is kept, try again in a moment");
    }
  }

  /** RFC 7009. A public client, so no client authentication; a known refresh token ends its session. */
  async function revokeToken(form: URLSearchParams): Promise<HttpResult> {
    const clientId = form.get("client_id");
    if (clientId !== null && clientId !== AGENTX_CLI_CLIENT_ID) return oauthError(401, "invalid_client", "unknown client; use the AgentX CLI");
    const presented = form.get("token");
    if (presented === null || presented === "") return oauthError(400, "invalid_request", "token is required");
    return retryable("revoke", async () => {
      const lookup = await store.lookupRefresh(presented);
      if (lookup.kind === "active" || lookup.kind === "recently_rotated") await revoke(lookup.session.sessionId, "signed_out");
      if (lookup.kind === "reused") await revoke(lookup.sessionId, "signed_out");
      return jsonResult(200, {});
    });
  }

  const configuration = () => {
    const methods = enabledMethods(deps);
    return {
      env: config.env,
      apiVersion: DEVELOPER_API_VERSION,
      adminApiVersion: ADMIN_API_VERSION,
      issuer: config.issuer,
      authorizationEndpoint: endpoint("/authorize"),
      tokenEndpoint: endpoint("/token"),
      revocationEndpoint: endpoint("/revoke"),
      clientId: AGENTX_CLI_CLIENT_ID,
      methods: { slack: methods.includes("slack"), oidc: methods.includes("oidc") && config.oidc !== undefined ? { displayName: config.oidc.displayName } : null },
      // FR-041, E16: the methods this environment allows; the MCP server adds the client's and the admin's own.
      // Slack needs the team set up, not Slack sign-in (controller ruling R5): each change checks the admin's own link.
      confirm: { elicitation: config.confirmElicitation !== false, slack: config.slack.teamId !== undefined } satisfies AgentXConfigurationConfirm,
    };
  };

  const discovery = () => ({
    issuer: config.issuer, authorization_endpoint: endpoint("/authorize"), token_endpoint: endpoint("/token"), revocation_endpoint: endpoint("/revoke"),
    jwks_uri: endpoint("/.well-known/jwks.json"), response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"], revocation_endpoint_auth_methods_supported: ["none"],
    subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"], scopes_supported: ["openid"],
  });

  async function route(method: string, pathname: string, url: URL, body: string | undefined, headers: Record<string, string | undefined>): Promise<HttpResult> {
    if (method === "GET") {
      switch (pathname) {
        case "/v1/auth/.well-known/openid-configuration":
          return publicJson(discovery());
        case "/v1/auth/.well-known/jwks.json":
          return publicJson({ keys: [await deps.signer.publicJwk()] });
        case "/v1/auth/.well-known/agentx-configuration":
          return jsonResult(200, configuration());
        case "/v1/auth/authorize":
          return authorize(url.searchParams);
        case "/v1/auth/browser/authorize":
          return authorizeBrowser(url.searchParams);
        case "/v1/auth/callback/slack":
          return callback("slack", url.searchParams, headers);
        case "/v1/auth/callback/oidc":
          return callback("oidc", url.searchParams, headers);
      }
    }
    if (method === "POST" && pathname === "/v1/auth/token") return token(new URLSearchParams(body ?? ""));
    if (method === "POST" && pathname === "/v1/auth/revoke") return revokeToken(new URLSearchParams(body ?? ""));
    return jsonResult(404, { error: "not_found" });
  }

  const isPage = (pathname: string) => pathname === "/v1/auth/authorize" || pathname === "/v1/auth/browser/authorize" || pathname.startsWith("/v1/auth/callback/");

  return async (
    event: HttpApiV2Event | ChannelMembersRequest | ChannelInfoRequest | SlackUserByEmailRequest | SlackAuthCheckRequest | EndDeveloperSessionsRequest | ChannelByNameRequest,
  ): Promise<HttpResult | ChannelMembersResult | ChannelInfoResponse | SlackUserByEmailResponse | SlackAuthCheckResponse | EndDeveloperSessionsResponse | ChannelByNameResponse> => {
    if ("kind" in event) {
      if (event.kind === "end-developer-sessions") {
        const parsed = EndDeveloperSessionsRequestSchema.safeParse(event);
        if (!parsed.success) return { ok: false, error: "invalid_request" };
        const result = await store.endSessions(parsed.data.developerId, parsed.data.at);
        deps.log({ event: "signin.sessions_ended_by_admin", developerId: parsed.data.developerId, result });
        return result === "ended" ? { ok: true } : { ok: false, error: "not_found" };
      }
      if (event.kind === "channel-by-name") {
        const parsed = ChannelByNameRequestSchema.safeParse(event);
        if (!parsed.success) return { ok: false, error: "invalid_request" };
        return deps.directory.channelByName(parsed.data.name);
      }
      if (event.kind === "slack-user-by-email") {
        const parsed = SlackUserByEmailRequestSchema.safeParse(event);
        if (!parsed.success) return { ok: false, error: "invalid_request" };
        const found = await deps.directory.lookupByEmail(parsed.data.email);
        if (found === "unavailable") return { ok: false, error: "slack_unavailable" };
        return found === "none" ? { ok: true } : { ok: true, userId: found.userId };
      }
      if (event.kind === "slack-auth-check") {
        if (!SlackAuthCheckRequestSchema.safeParse(event).success) return { ok: false, error: "invalid_request" };
        return deps.directory.authTest();
      }
      if (event.kind === "channel-info") {
        const parsed = ChannelInfoRequestSchema.safeParse(event);
        if (!parsed.success) return { ok: false, error: "invalid_request" };
        return deps.directory.channelInfo(parsed.data.channelIds);
      }
      const parsed = ChannelMembersRequestSchema.safeParse(event);
      if (!parsed.success) return { ok: false, error: "invalid_request" };
      return deps.directory.channelMembers(parsed.data.slackUserId, parsed.data.channelIds);
    }
    const request = adaptHttpApiEvent(event);
    const url = new URL(request.path, "https://agentx.invalid");
    try {
      return await route(request.method, url.pathname, url, request.body, request.headers);
    } catch (error) {
      // Only the error's name: a KMS or AWS message can carry a key ARN or other detail.
      deps.log({ event: "signin.error", path: url.pathname, error: errorName(error) });
      return isPage(url.pathname)
        ? page(500, "Sign-in failed", ["Something went wrong on the AgentX server. Run agentx login again."])
        : oauthError(500, "server_error", "sign-in failed on the server; try again");
    }
  };
}
