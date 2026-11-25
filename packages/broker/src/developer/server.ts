// packages/broker/src/developer/server.ts
// Spec 025 FR-001 to FR-008: the control plane as the developers' sign-in server. Behind
// ANY /v1/auth/{proxy+} with no authorizer, plus direct-invoke operations for the broker
// (channel members, channel names for R10, 25d's email lookup and bot token check, and 25e's
// admin-ended sessions and channel by name).
// Nothing here logs or echoes a secret, a code, a token or a caught error's message.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { CompanyJoin } from "./company-membership.js";
import type { CompanySignInAuditInput, CompanySignInCause, CompanySignInMethod } from "./company-signin-audit.js";
import {
  AGENTX_CLI_CLIENT_ID,
  COMPANY_INVITE_LINK_MAX,
  IMPLICIT_COMPANY_ID,
  OrgIdSchema,
  ChannelInfoRequestSchema,
  ChannelByNameRequestSchema,
  ChannelMembersRequestSchema,
  TaskPersonProofRequestSchema,
  TaskChannelPeopleRequestSchema,
  TaskPeopleDisplayReadRequestSchema,
  ADMIN_API_VERSION,
  DEVELOPER_API_VERSION,
  EndDeveloperSessionsRequestSchema,
  SetDisplayNameRequestSchema,
  SetMyNameBodySchema,
  ListSignInClientsRequestSchema,
  PutSignInClientRequestSchema,
  RemoveSignInClientRequestSchema,
  SignInClientIdSchema,
  signInClientView,
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
  type TaskPersonProofRequest,
  type TaskPersonProofResponse,
  type TaskChannelPeopleRequest,
  type TaskChannelPeopleResponse,
  type TaskPeopleDisplayReadRequest,
  type TaskPeopleDisplayReadResponse,
  type DeveloperSignInMethod,
  type EndDeveloperSessionsRequest,
  type SetDisplayNameRequest,
  type SetDisplayNameResponse,
  type ListSignInClientsRequest,
  type PutSignInClientRequest,
  type RemoveSignInClientRequest,
  type ClientScope,
  type SignInClientRecord,
  type SignInClientsResponse,
  type EndDeveloperSessionsResponse,
  type SlackAuthCheckRequest,
  type SlackAuthCheckResponse,
  type SlackUserByEmailRequest,
  type SlackUserByEmailResponse,
  type SignInLinkStartRequest, type SignInLinkFinishRequest, type SignInLinksListRequest, type SignInUnlinkRequest,
  type SignInLinkStartResponse, type SignInLinkFinishResponse, type SignInLinksListResponse, type SignInUnlinkResponse,
} from "@agentx/contracts";
import { adaptHttpApiEvent, ownerKeyForSubject, type HttpApiV2Event } from "../aws/lambda.js";
import { SESSION_MAX_AGE_SECONDS } from "../aws/web-session.js";
import { mergeSurvivor } from "../aws/install-company.js";
import { ProviderNotConfiguredError, ProviderUnavailableError, slackWorkspaceHint, type ProviderIdentity, type ProviderResult, type SignInProvider } from "./providers.js";
import type { SlackDirectory } from "./slack-directory.js";
import { createSignInLinks } from "./sign-in-links.js";
import { companyMayMint as mayMint, mintSession } from "./session-mint.js";
import { endedByAdmin, startedBeforeMethodOn, type AuthRequestRecord, type CodeGrant, type DeveloperRecord, type DeveloperSignInStore, type SessionRecord } from "./store.js";
import { issueAccessToken, pkceChallengeMatches, type TokenSigner, type PublicSigningJwk, type SigningKeyPurpose } from "./tokens.js";
import type { CompanySignInStore } from "./company-membership.js";
import type { CompanyInviteStore } from "./company-invites.js";
import type { SelectedCompanyIssuer } from "./company-issuer.js";
import { companyOperator, type CompanyOperatorRequest, type CompanyOperatorResponse } from "./company-operator.js";
import { companyImportOperator, type CompanyImportEventInput, type CompanyImportReplyValue, type CompanyImportStore } from "./company-import.js";

/** `since` (epoch seconds, FR-045): when the method was last turned on. A session started before it
 * was ended by the disable in between, so it never comes back when the method is on again. */
export interface DeveloperIdentityConfig { env: string; issuer: string; slack: { enabled: boolean; teamId?: string; since?: number }; oidc?: { displayName: string; since?: number };
  /** DEC 254h: GitHub sign-in is on (offered only with Code's company layer, `company`). */
  github?: { since?: number }; confirmElicitation?: boolean }
export interface DeveloperIdentityDependencies {
  config: DeveloperIdentityConfig;
  store: DeveloperSignInStore;
  signer: TokenSigner;
  /** Other keys the JWKS publishes, each with its purpose (absent: `task`, as before). A key whose public half cannot be read is left out with a fixed log line; sign-in stays up. */
  extraPublicKeys?: ReadonlyArray<{ purpose?: Exclude<SigningKeyPurpose, "developer">; publicJwk(): Promise<PublicSigningJwk> }>;
  providers: Partial<Record<DeveloperSignInMethod, SignInProvider>>;
  directory: SlackDirectory;
  directoryForWorkspace?: (workspace: unknown) => Promise<SlackDirectory>;
  now: () => number;
  log: (entry: Record<string, unknown>) => void;
  company?: CompanySignInStore;
  /** Sign-in-only company audit exception; company attribution is always resolved from membership. */
  signInAudit?: (input: CompanySignInAuditInput) => Promise<void>;
  /** DEC 254a, 253z: invite codes and self-serve create (with `company` only). Absent: those events answer unavailable, and nobody signs in with no company. */
  companyInvites?: CompanyInviteStore;
  /** DEC 254b (b): an operator's import of the install's old company layout, and its undo, with Code's company layer on or off. */
  companyImport?: CompanyImportStore;
  companyIssuer?: (companyId: string) => Promise<SelectedCompanyIssuer | undefined>;
  companyDirectory?: (companyId: string) => SlackDirectory | undefined;
  slackTeamCompany?: (teamId: string) => string | undefined | Promise<string | undefined>;
  /** Guided onboarding PR 4: the broker's "slack-install" invokes (aws/slack-install-identity.ts). Absent: refused as not set up. */
  slackInstall?: (event: unknown) => Promise<Record<string, unknown>>;
}
/** Guided onboarding PR 4: a "slack-install" invoke (its schema is aws/slack-install-identity.ts SlackInstallRequestSchema). */
export interface SlackInstallInvoke { kind: "slack-install"; op: string }
export interface HttpResult { statusCode: number; headers: Record<string, string>; body: string; cookies?: string[] }
/** The invoke's answer: the broker's contract, plus a refusal for a request that is not one. */
export type ChannelMembersResult = ChannelMembersResponse | { ok: false; error: "invalid_request" };

const CHALLENGE = /^[A-Za-z0-9_-]{43,128}$/;
// The PR-feedback review page, or the read-only task page, which may name one document and the earlier version it came from.
// Spec 062 FR-031: also a channel link page, /review/link/<32-character code>.
const REVIEW_RETURN_TO = /^\/review\/(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\/task(?:\?doc=(?:requirements|design|coding-plan)(?:&from=[1-9][0-9]{0,2})?)?)?|link\/[A-Za-z0-9_-]{32})$/i;
const REVIEW_PKCE_COOKIE = "__Host-agentx_review_pkce";
const REVIEW_SESSION_COOKIE = "__Host-agentx_review_session";
/** Cloud sign-out, issue 314: where a sign-out returns once the provider's session ended (the provider's sign-out redirect carries no state of its own). */
const END_SESSION_COOKIE = "__Host-rovara_end_session";
const END_SESSION_MAX_AGE_SECONDS = 600;
const RETURN_ADDRESS_MAX = 2048;
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

export function enabledMethods(deps: Pick<DeveloperIdentityDependencies, "config" | "providers" | "company">): DeveloperSignInMethod[] {
  const methods: DeveloperSignInMethod[] = [];
  if (deps.config.slack.enabled && deps.config.slack.teamId !== undefined && deps.providers.slack !== undefined) methods.push("slack");
  if (deps.config.oidc !== undefined && deps.providers.oidc !== undefined) methods.push("oidc");
  // DEC 254h: GitHub only with Code's company layer, where the company comes only from membership (or an invite). Without it, any GitHub user
  // would be admitted, so it is never offered there.
  if (deps.config.github !== undefined && deps.providers.github !== undefined && deps.company !== undefined) methods.push("github");
  return methods;
}
/** FR-045: when a method was last turned on (a session started before it stays ended). */
const methodSince = (config: DeveloperIdentityConfig, method: DeveloperSignInMethod): number | undefined =>
  method === "slack" ? config.slack.since : method === "github" ? config.github?.since : config.oidc?.since;

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

/**
 * Cloud sign-out, issue 314: a registered client's sign-out may return only to an HTTPS address on the origin of one of its own registered redirect
 * URLs (with no credentials or fragment), so the end-session endpoint is never an open redirect.
 */
function postLogoutReturnAllowed(client: SignInClientRecord, value: string): boolean {
  if (value.length > RETURN_ADDRESS_MAX) return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hash !== "") return false;
  return client.redirectUris.some((registered) => {
    try { return new URL(registered).origin === url.origin; } catch { return false; }
  });
}

const cookieValue = (header: string | undefined, name: string): string | undefined =>
  (header ?? "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);

function toClient(redirectUri: string, params: Record<string, string>): HttpResult {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return redirect(url.toString());
}

/** The CLI is public ("none"); a confidential registered client sends its secret either way (spec 063). */
const CLIENT_AUTH_METHODS = ["none", "client_secret_basic", "client_secret_post"];

/** Spec 065: the scopes a client asked for (space-separated) that its registration allows, unique and in order. */
function grantedScopes(requested: string | null, client: SignInClientRecord): { scopes?: string[] } {
  const scopes = [...new Set((requested ?? "").split(" "))].filter((scope) => client.scopes?.includes(scope as ClientScope) === true);
  return scopes.length === 0 ? {} : { scopes };
}

/** RFC 6749 2.3.1: HTTP Basic with the form-encoded client ID and secret; undefined without the header. */
function basicCredentials(authorization: string | undefined): { clientId: string; secret: string } | "malformed" | undefined {
  if (authorization === undefined) return undefined;
  const match = /^Basic ([A-Za-z0-9+/=]+)$/i.exec(authorization.trim());
  if (match === null) return "malformed";
  const decoded = Buffer.from(match[1]!, "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon < 1) return "malformed";
  try {
    const formDecode = (text: string) => decodeURIComponent(text.replace(/\+/g, " "));
    return { clientId: formDecode(decoded.slice(0, colon)), secret: formDecode(decoded.slice(colon + 1)) };
  } catch {
    return "malformed";
  }
}

/** Compares a presented secret with the kept SHA-256, in constant time. */
function secretMatches(secret: string, secretHash: string): boolean {
  if (secret === "") return false;
  const given = createHash("sha256").update(secret).digest();
  const kept = Buffer.from(secretHash, "hex");
  return kept.length === given.length && timingSafeEqual(given, kept);
}

const expired = () => page(400, "This sign-in link has expired", ["Start signing in again."]);
/** One answer for every code failure (unknown, used, expired, wrong verifier, wrong redirect URI). */
const INVALID_CODE = ["invalid_grant", "the sign-in code is invalid, used or expired; start signing in again"] as const;
const SIGN_IN_ENDED = ["invalid_grant", "your Rovara sign-in has ended; start signing in again"] as const;
/** DEC 254b (a): a member of a company with its own sign-in tried the install's. Fixed words, nothing echoed. */
const COMPANY_OWN_SIGNIN = "your company signs in with its own sign-in method";

/** Fixed invite guidance; the existing audit vocabulary records email proof failures as not invited. */
function joinRefusal(reason: Extract<CompanyJoin, { ok: false }>["reason"], byInvite: boolean): { cause: CompanySignInCause; params: Record<string, string> } {
  if (reason === "invite_email_mismatch") return { cause: "not_invited", params: { error: "access_denied", error_description: "This invite is for another email", invite_error: "mismatch" } };
  if (reason === "invite_email_unverified") return { cause: "not_invited", params: { error: "access_denied", error_description: "This sign-in has no verified email. Sign in with the invited email.", invite_error: "unverified" } };
  const text = byInvite ? "not invited" : { not_invited: "not invited", member_elsewhere: "already a member of another company", member_revoked: "access ended by a company admin" }[reason];
  return { cause: reason, params: { error: "access_denied", error_description: text } };
}

export function createDeveloperIdentityHandler(deps: DeveloperIdentityDependencies) {
  const { config, store } = deps;
  const endpoint = (path: string) => `${config.issuer}${path}`;
  const methodLabel = (method: DeveloperSignInMethod) => (method === "slack" ? "Slack" : method === "github" ? "GitHub" : config.oidc?.displayName ?? "company sign-in");
  const signInMethod = async (method: DeveloperSignInMethod, request: AuthRequestRecord): Promise<CompanySignInMethod> => {
    if (request.inviteHash !== undefined) return "invite";
    if (method === "slack" || method === "github") return method;
    if (request.browserReturnTo !== undefined) return "web";
    if (request.clientId !== undefined) {
      try { if ((await registeredClient(request.clientId))?.webApp === true) return "web"; } catch { /* a classification lookup never blocks a sign-in */ }
    }
    return "cli";
  };
  type SignInOutcome = {
    developerId?: string;
    companyId?: string;
    cause: CompanySignInCause;
    successLog?: Record<string, unknown>;
  };
  // One outcome per consumed callback, including unexpected failures. Only authenticated
  // identity and server-side membership may attribute it; request.companyId is never authority.
  const recordSignInOutcome = async (outcome: SignInOutcome, method: DeveloperSignInMethod, request: AuthRequestRecord): Promise<void> => {
    if (deps.signInAudit === undefined || deps.company === undefined || outcome.developerId === undefined) return;
    let companyId = outcome.companyId;
    if (companyId === undefined) {
      try { companyId = (await deps.company.membership(outcome.developerId))?.companyId; } catch { return; }
    }
    if (companyId === undefined || !OrgIdSchema.safeParse(companyId).success) return;
    try {
      await deps.signInAudit({ companyId, developerId: outcome.developerId, method: await signInMethod(method, request),
        ...(outcome.successLog === undefined ? { outcome: "refused", cause: outcome.cause } : { outcome: "succeeded" }),
      });
    } catch (error) {
      deps.log({ event: "signin.audit_failed", method, error: "sign_in_failed" });
      throw error; // The callback withholds the code/cookie even if it was already persisted.
    }
  };
  const provider = (method: DeveloperSignInMethod): SignInProvider => {
    const found = deps.providers[method];
    if (found === undefined) throw new ProviderNotConfiguredError(`${methodLabel(method)} sign-in is not set up in this environment`);
    return found;
  };
  const methodUnavailable = () => page(400, "Sign-in method not available", ["Start signing in again."]);
  const companyNotFinished = (request: AuthRequestRecord) => request.browserReturnTo === undefined
    ? toClient(request.clientRedirectUri, { error: "access_denied", error_description: "sign-in is not finished", state: request.clientState })
    : browserReturn(request.browserReturnTo, false);
  /**
   * Which provider completes a sign-in, and whether it is the install's own (`install`). DEC 254b (a): a company with no sign-in of its own (every
   * self-serve company) uses the install's methods, the shared sign-in method; a company with its own issuer only ever uses that issuer.
   */
  const providerChoice = async (method: DeveloperSignInMethod, companyId?: string): Promise<{ provider: SignInProvider; install: boolean }> => {
    // Slack and (DEC 254h) GitHub are only ever the install's: a company with its own issuer refuses them at the callback and at each mint.
    if (deps.company === undefined || companyId === undefined || method === "slack" || method === "github") return { provider: provider(method), install: true };
    if (companyId === IMPLICIT_COMPANY_ID) throw new ProviderNotConfiguredError("sign-in is not finished");
    if (!await deps.company.hasOwnIssuer(companyId)) return { provider: provider(method), install: true };
    const selected = await deps.companyIssuer?.(companyId);
    if (selected === undefined) throw new ProviderNotConfiguredError("sign-in is not finished");
    return { provider: selected.provider, install: false };
  };
  const providerFor = async (method: DeveloperSignInMethod, companyId?: string): Promise<SignInProvider> => (await providerChoice(method, companyId)).provider;
  const slackCompany = async (): Promise<string | undefined> => {
    if (config.slack.teamId === undefined) return undefined;
    return deps.slackTeamCompany === undefined ? IMPLICIT_COMPANY_ID : deps.slackTeamCompany(config.slack.teamId);
  };
  const methodsFor = async (companyId?: string): Promise<DeveloperSignInMethod[] | undefined> => {
    if (deps.company === undefined || companyId === undefined) return enabledMethods(deps);
    if (companyId === IMPLICIT_COMPANY_ID || !OrgIdSchema.safeParse(companyId).success || !await deps.company.companyExists(companyId)) return undefined;
    if (!await deps.company.hasOwnIssuer(companyId)) {
      // DEC 254b (a): the shared method. The install's OIDC, and the install's Slack only for the company its team is bound to. None on: unavailable.
      const shared: DeveloperSignInMethod[] = [];
      // DEC 254e: the install's Slack app serves every company (any workspace), as does the install's OIDC.
      for (const method of enabledMethods(deps)) shared.push(method);
      return shared.length === 0 ? undefined : shared;
    }
    const selected = await deps.companyIssuer?.(companyId);
    if (selected === undefined) return undefined;
    return [...enabledMethods(deps).filter((method) => method === "slack"), "oidc"];
  };
  /** Recheck live membership at each mint (session-mint.ts holds the check: the canary's session function runs the same code). */
  function companyMayMint(personId: string, amr: DeveloperSignInMethod, companyId: string | undefined, registered: SignInClientRecord | undefined, legacy = false, installMethod?: true): Promise<boolean> {
    return mayMint({ company: deps.company, slackCompany, companyless: companylessMayMint }, personId, amr, companyId, registered, legacy, installMethod);
  }
  /**
   * DEC 253z: a person with no company may hold a session only from the install's own OIDC sign-in, to the install-level web app with full access,
   * with no membership row (a removed member keeps theirs, and stays refused) and no sign-in record from before (a legacy person joins the built-in
   * company instead). Every company route still refuses such a session; only the access check and company create read it.
   */
  async function companylessMayMint(personId: string, amr: DeveloperSignInMethod, registered: SignInClientRecord | undefined): Promise<boolean> {
    // DEC 254e: Slack (any workspace) as well as the install's OIDC.
    if (deps.company === undefined || deps.companyInvites === undefined || (amr !== "oidc" && amr !== "slack" && amr !== "github")) return false;
    if (registered === undefined || registered.installLevel !== true || registered.fullAccess !== true || registered.webApp !== true) return false;
    return deps.companyInvites.companylessEligible(personId);
  }

  /** Spec 063 FR-002: a registered client's session gets tokens addressed to that client, which Rovara's API refuses. */
  // Spec 065 FR-002: the scopes asked for at sign-in that the client's registration still allows, so removing one from
  // the registration ends it at the next refresh.
  const accessToken = (session: SessionRecord, client?: SignInClientRecord) =>
    issueAccessToken(deps.signer, {
      issuer: config.issuer, subject: session.developerId, amr: session.amr, env: config.env, sessionId: session.sessionId, now: deps.now(),
      ...(client === undefined ? {} : { client: { clientId: client.clientId, audience: client.audience, scopes: (session.scopes ?? []).filter((scope) => client.scopes?.includes(scope as ClientScope) === true) } }),
    });
  // DEC 254w: connecting a second sign-in method to the signed-in person (sign-in-links.ts).
  const signInLinks = createSignInLinks({
    store, company: () => deps.company, provider, methodEnabled: (method) => enabledMethods(deps).includes(method),
    methodLive: (session) => enabledMethods(deps).includes(session.amr) && !startedBeforeMethodOn(session.startedAt, methodSince(config, session.amr)),
    registeredClient: (clientId) => registeredClient(clientId), installSlackCompany: () => slackCompany(),
    slackTeamCompany: async (teamId) => deps.slackTeamCompany === undefined ? undefined : deps.slackTeamCompany(teamId), endpoint, now: deps.now, log: deps.log,
  });

  /** The registered client a request names, or undefined for an unknown ID (an unreadable row reads as none). */
  const registeredClient = async (clientId: string): Promise<SignInClientRecord | undefined> =>
    SignInClientIdSchema.safeParse(clientId).success ? store.getClient(clientId, undefined, deps.company !== undefined) : undefined;

  type ClientCheck = { ok: true; client?: SignInClientRecord } | { ok: false; result: HttpResult };
  /**
   * Spec 063 FR-002: who is calling the token or revoke endpoint. The CLI is a public client, as before. A registered
   * client is named by client_id or HTTP Basic; a confidential one must present its secret, which is compared by hash.
   */
  async function authenticateClient(form: URLSearchParams, authorization: string | undefined, optional: boolean): Promise<ClientCheck> {
    const refuse = (description: string): ClientCheck => ({ ok: false, result: oauthError(401, "invalid_client", description) });
    const basic = basicCredentials(authorization);
    if (basic === "malformed") return refuse("the Authorization header is not HTTP Basic client credentials");
    const formId = form.get("client_id");
    if (basic !== undefined && formId !== null && formId !== basic.clientId) return refuse("client_id does not match the Authorization header");
    const clientId = basic?.clientId ?? formId;
    if (clientId === null) return optional ? { ok: true } : refuse("unknown service; start signing in again from the service");
    if (clientId === AGENTX_CLI_CLIENT_ID) return { ok: true };
    const client = await registeredClient(clientId);
    if (client === undefined) return refuse("unknown service; ask a Rovara administrator to register this service");
    if (client.secretHash !== undefined) {
      const secret = basic?.secret ?? form.get("client_secret") ?? "";
      if (!secretMatches(secret, client.secretHash)) return refuse("the client secret is missing or wrong");
    }
    return { ok: true, client };
  }
  const tokens = (access: { token: string; expiresIn: number }, refreshToken: string): HttpResult =>
    jsonResult(200, { access_token: access.token, token_type: "Bearer", expires_in: access.expiresIn, refresh_token: refreshToken });

  async function revoke(sessionId: string, reason: string): Promise<void> {
    await store.revokeSession(sessionId, reason);
    deps.log({ event: "signin.session_revoked", sessionId, reason });
  }

  async function authorize(query: URLSearchParams): Promise<HttpResult> {
    let methods = enabledMethods(deps);
    // L4-SIGNIN: the Slack workspace the browser remembers. A convenience only: it is read as a plain workspace id or dropped, goes to Slack alone as `team`,
    // and never reaches the callback, which reads the workspace from Slack's verified ID token.
    const workspaceHint = slackWorkspaceHint(query.get("slack_team"));
    const requestId = query.get("request");
    if (requestId !== null) {
      const method = query.get("method");
      if (deps.company !== undefined && (method === "slack" || method === "oidc" || method === "github")) {
        try {
          const pending = await store.getAuthRequest(requestId);
          if (pending === undefined) return expired();
          const selected = await methodsFor(pending.companyId);
          if (selected === undefined) return methodUnavailable();
          methods = selected;
        } catch { return methodUnavailable(); }
      }
      if ((method !== "slack" && method !== "oidc" && method !== "github") || !methods.includes(method)) return page(400, "Sign-in method not available", ["Start signing in again."]);
      const request = await store.chooseMethod(requestId, method);
      if (request === undefined) return expired();
      try {
        return await toProvider(request.id, request.nonce, method, request.clientRedirectUri, request.clientState, request.companyId, workspaceHint);
      } catch (error) {
        return serverError(error, "/v1/auth/authorize", request.clientRedirectUri, request.clientState);
      }
    }
    const redirectUri = query.get("redirect_uri") ?? "";
    const requestedClient = query.get("client_id") ?? "";
    // Spec 063 FR-002: a registered client returns only to one of its exact redirect URLs, or to loopback if allowed.
    let client: SignInClientRecord | undefined;
    if (requestedClient !== AGENTX_CLI_CLIENT_ID) {
      try {
        client = await registeredClient(requestedClient);
      } catch (error) {
        deps.log({ event: "signin.error", path: "/v1/auth/authorize", error: errorName(error) });
        return page(503, "Sign-in is unavailable", ["Try again in a moment."]);
      }
      const allowed = client !== undefined && (client.redirectUris.includes(redirectUri) || (client.loopback && isLoopbackRedirectUri(redirectUri)));
      if (!allowed) return page(400, "This sign-in link is not from a service registered with Rovara", ["Start signing in again from the service. If it keeps happening, ask a Rovara administrator to check how the service is registered."]);
    } else if (!isLoopbackRedirectUri(redirectUri)) {
      return page(400, "This sign-in link is not valid", ["Start signing in again from the app or service you want to use."]);
    }
    const clientState = query.get("state") ?? "";
    let selectedCompany = deps.company === undefined ? undefined : query.get("company") ?? undefined;
    if (deps.company !== undefined && client !== undefined && client.installLevel !== true) {
      const owner = client.companyId ?? IMPLICIT_COMPANY_ID;
      if (selectedCompany !== undefined && selectedCompany !== owner) return methodUnavailable();
      // An implicit legacy client retains the install provider and exact old response path.
      if (owner !== IMPLICIT_COMPANY_ID) selectedCompany = owner;
    }
    if (selectedCompany !== undefined) {
      try {
        const selected = await methodsFor(selectedCompany);
        if (selected === undefined) return methodUnavailable();
        methods = selected;
      } catch { return methodUnavailable(); }
    }
    // DEC 254h: an invite link's secret, read only with the company layer on, with a company named, from an install-level client (the CLI or a
    // registered install-level client such as the web app). Only its SHA-256 is kept; whether it is any good is decided at the callback, with the
    // one "not invited" answer for every failure.
    const invite = deps.company === undefined ? null : query.get("invite");
    if (invite !== null && (invite.length < 1 || invite.length > COMPANY_INVITE_LINK_MAX || selectedCompany === undefined || (client !== undefined && client.installLevel !== true))) return methodUnavailable();
    const challenge = query.get("code_challenge") ?? "";
    const invalid = (description: string) => toClient(redirectUri, { error: "invalid_request", error_description: description, ...(clientState === "" ? {} : { state: clientState }) });
    if (query.get("response_type") !== "code") return invalid("response_type must be code; start signing in again from the app or service");
    if (query.get("code_challenge_method") !== "S256" || !CHALLENGE.test(challenge)) return invalid("PKCE with S256 is required; start signing in again from the app or service");
    if (clientState.length < 1 || clientState.length > 512) return invalid("state is required; start signing in again from the app or service");
    if (methods.length === 0) {
      return toClient(redirectUri, { error: "access_denied", state: clientState, error_description: "sign-in is not enabled in this Rovara environment; ask a Rovara administrator to enable a sign-in method" });
    }
    // L4-SIGNIN: a sign-in page that already knows the method (its own "Sign in with Slack" / "Sign in with GitHub" button) names it, and skips the method page.
    // Only a method this sign-in offers counts; anything else is the one unavailable answer, never a redirect.
    const wanted = query.get("method");
    if (wanted !== null) {
      const chosen = methods.find((method) => method === wanted);
      if (chosen === undefined) return methodUnavailable();
      methods = [chosen];
    }
    // DEC 254zzz73: there is no step-up. `acr_values` (any value, `step-up` included) is not Code's and is ignored: the sign-in is an ordinary one.
    let request: AuthRequestRecord;
    try {
      request = await store.createAuthRequest({
        clientRedirectUri: redirectUri, clientState, codeChallenge: challenge, nonce: randomBytes(32).toString("base64url"),
        ...(client === undefined ? {} : { clientId: client.clientId }),
        // Spec 065 FR-002: a scope the registration does not allow is dropped, not refused.
        ...(client === undefined ? {} : grantedScopes(query.get("scope"), client)),
        ...(selectedCompany === undefined ? {} : { companyId: selectedCompany }),
        ...(invite === null ? {} : { inviteHash: createHash("sha256").update(invite, "utf8").digest("hex") }),
      });
      if (methods.length === 1) {
        const method = methods[0]!;
        if (await store.chooseMethod(request.id, method) === undefined) return expired();
        return await toProvider(request.id, request.nonce, method, redirectUri, clientState, request.companyId, workspaceHint);
      }
    } catch (error) {
      return serverError(error, "/v1/auth/authorize", redirectUri, clientState);
    }
    return page(200, "Sign in to Rovara", [`Environment: ${config.env}`], methods.map((method) => ({
      href: `${endpoint("/authorize")}?request=${encodeURIComponent(request.id)}&method=${method}${method === "slack" && workspaceHint !== undefined ? `&slack_team=${workspaceHint}` : ""}`,
      label: `Sign in with ${methodLabel(method)}`,
    })));
  }

  async function authorizeBrowser(query: URLSearchParams): Promise<HttpResult> {
    const returnTo = query.get("return_to") ?? "";
    if (!REVIEW_RETURN_TO.test(returnTo)) return page(400, "Invalid review link", ["Open the review from Slack and sign in again."]);
    // DEC 254h: the browser review page's session check reads Slack and company sign-in only, so GitHub is not offered there.
    const methods = enabledMethods(deps).filter((method) => method !== "github");
    if (methods.length === 0) return page(503, "Sign-in is unavailable", ["Ask a Rovara administrator to enable a sign-in method."]);
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
    return { ...page(200, "Sign in to Rovara", [`Environment: ${config.env}`], methods.map(method => ({
      href: `${endpoint("/authorize")}?request=${encodeURIComponent(auth.id)}&method=${method}`,
      label: `Sign in with ${methodLabel(method)}`,
    }))), cookies: [cookie] };
  }

  /** A registered client's sign-out return address, or undefined when the client or the address is not one this client may use. */
  async function signOutReturn(clientId: string, returnTo: string): Promise<string | undefined> {
    if (clientId === AGENTX_CLI_CLIENT_ID) return undefined;
    const client = await registeredClient(clientId);
    return client !== undefined && postLogoutReturnAllowed(client, returnTo) ? returnTo : undefined;
  }

  /**
   * Cloud sign-out, issue 314: OpenID Connect RP-Initiated Logout for a registered client (`client_id`, `post_logout_redirect_uri`). The client has already ended
   * its own session and revoked its tokens; this ends the browser's sessions behind them. Code's own review-page session cookie is cleared, and with
   * the install's company sign-in on, the browser goes through that provider's sign-out (for Cognito, its managed login's `/logout`), so the next
   * sign-in shows the login form instead of signing the same person straight back in. The provider returns to `/end-session/return`, which must be
   * registered with it as a sign-out URL; the return address waits in a short-lived cookie. A provider with no sign-out address, or one that can't
   * be read, returns the browser straight to the client: the person is signed out of Rovara either way.
   */
  async function endSession(query: URLSearchParams): Promise<HttpResult> {
    const clientId = query.get("client_id") ?? "";
    let returnTo: string | undefined;
    try {
      returnTo = await signOutReturn(clientId, query.get("post_logout_redirect_uri") ?? "");
    } catch (error) {
      deps.log({ event: "signin.error", path: "/v1/auth/end-session", error: errorName(error) });
      return page(503, "Sign-out is unavailable", ["You are signed out of the service. Close this tab, or try signing out again in a moment."]);
    }
    if (returnTo === undefined) return page(400, "This sign-out link is not valid", ["You are signed out of the service. Close this tab, or go back to the service to sign in again."]);
    const cookies = [`${REVIEW_SESSION_COOKIE}=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`];
    let target: string | undefined;
    if (enabledMethods(deps).includes("oidc")) {
      try {
        target = await deps.providers.oidc?.endSessionUrl?.({ postLogoutRedirectUri: endpoint("/end-session/return") });
      } catch (error) {
        deps.log({ event: "signin.end_session_provider_failed", error: errorName(error) });
      }
    }
    if (target === undefined) {
      deps.log({ event: "signin.session_ended", clientId, provider: false });
      return { ...redirect(returnTo), cookies };
    }
    const pending = Buffer.from(JSON.stringify({ clientId, returnTo })).toString("base64url");
    deps.log({ event: "signin.session_ended", clientId, provider: true });
    return { ...redirect(target), cookies: [...cookies, `${END_SESSION_COOKIE}=${pending}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${END_SESSION_MAX_AGE_SECONDS}`] };
  }

  /** Cloud sign-out, issue 314: back from the provider's sign-out. The waiting return address is checked again against the client's registration. */
  async function endSessionReturn(headers: Record<string, string | undefined>): Promise<HttpResult> {
    const cookies = [`${END_SESSION_COOKIE}=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`];
    const signedOut = () => ({ ...page(200, "You are signed out", ["Go back to the service to sign in again."]), cookies });
    const raw = cookieValue(headers.cookie, END_SESSION_COOKIE);
    if (raw === undefined || raw.length > RETURN_ADDRESS_MAX * 2) return signedOut();
    let pending: { clientId?: unknown; returnTo?: unknown };
    try { pending = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as typeof pending; } catch { return signedOut(); }
    if (pending === null || typeof pending !== "object" || typeof pending.clientId !== "string" || typeof pending.returnTo !== "string") return signedOut();
    const returnTo = await signOutReturn(pending.clientId, pending.returnTo);
    return returnTo === undefined ? signedOut() : { ...redirect(returnTo), cookies };
  }

  /** Once the CLI's redirect URI and state are known, any failure goes back to the CLI, so it never
   * waits out its timeout behind a 500 page. Company mode logs only a fixed code;
   * the legacy path retains its error-name log. */
  function serverError(error: unknown, path: string, clientRedirect: string, clientState: string): HttpResult {
    deps.log({ event: "signin.error", path, error: deps.company === undefined ? errorName(error) : "sign_in_failed" });
    return toClient(clientRedirect, { error: "server_error", error_description: "Rovara could not finish signing you in; start signing in again", state: clientState });
  }

  async function toProvider(requestId: string, nonce: string, method: DeveloperSignInMethod, clientRedirect: string, clientState: string, companyId?: string, workspaceHint?: string): Promise<HttpResult> {
    try {
      return redirect(await (await providerFor(method, companyId)).authorizeUrl({
        state: requestId, nonce, redirectUri: endpoint(`/callback/${method}`),
        ...(method === "slack" && workspaceHint !== undefined ? { workspaceHint } : {}),
      }));
    } catch (error) {
      if (deps.company !== undefined && companyId !== undefined) {
        deps.log({ event: "signin.error", path: "/v1/auth/authorize", error: "sign_in_failed" });
        return toClient(clientRedirect, { error: "access_denied", state: clientState, error_description: "sign-in is not finished" });
      }
      return providerFailure(error, method, clientRedirect, clientState);
    }
  }

  function providerFailure(error: unknown, method: DeveloperSignInMethod, clientRedirect: string, clientState: string): HttpResult {
    if (error instanceof ProviderUnavailableError) {
      deps.log({ event: "signin.provider_unavailable", method });
      return toClient(clientRedirect, { error: "temporarily_unavailable", state: clientState, error_description: `${methodLabel(method)} could not be reached; try signing in again in a minute` });
    }
    if (error instanceof ProviderNotConfiguredError) {
      // Keep operator setup details in the log; customers get fixed sign-in guidance.
      deps.log({ event: "signin.not_configured", method, detail: deps.company === undefined ? error.message : "sign_in_not_configured" });
      return toClient(clientRedirect, { error: "access_denied", state: clientState, error_description: `${methodLabel(method)} sign-in is not finished. Ask a Rovara administrator to check the sign-in settings.` });
    }
    throw error;
  }

  const browserReturn = (returnTo: string, signedIn: boolean, sessionId?: string): HttpResult => ({
    statusCode: 302,
    headers: { location: returnTo, "cache-control": "no-store", "referrer-policy": "no-referrer" },
    body: "",
    cookies: [
      `${REVIEW_PKCE_COOKIE}=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
      ...(signedIn && sessionId !== undefined ? [`${REVIEW_SESSION_COOKIE}=${sessionId}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}`] : []),
    ],
  });

  async function callback(method: DeveloperSignInMethod, query: URLSearchParams, headers: Record<string, string | undefined>): Promise<HttpResult> {
    // DEC 254w: a connect link's callback (its state is a link id, never a sign-in request's).
    if (deps.company !== undefined && signInLinks.isLinkState(query.get("state"))) {
      const answered = await signInLinks.callback(method, query);
      if (answered !== undefined) return answered;
    }
    const state = query.get("state") ?? "";
    const pending = state === "" ? undefined : await store.getAuthRequest(state);
    if (pending === undefined || pending.method !== method) return expired();
    // Single use: the state (and with it the nonce) is consumed before anything else happens.
    const request = await store.consumeAuthRequest(state, method);
    if (request === undefined) return page(400, "This sign-in link was already used", ["Start signing in again."]);
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
      if (deps.company !== undefined && request.companyId !== undefined && request.companyId !== IMPLICIT_COMPANY_ID) {
        deps.log({ event: "signin.error", path: `/v1/auth/callback/${method}`, error: "sign_in_failed" });
        return companyNotFinished(request);
      }
      if (request.browserReturnTo !== undefined) {
        deps.log({ event: "signin.browser_error", method, error: deps.company === undefined ? errorName(error) : "sign_in_failed" });
        return browserReturn(request.browserReturnTo, false);
      }
      return serverError(error, `/v1/auth/callback/${method}`, request.clientRedirectUri, request.clientState);
    }
  }

  async function completeSignIn(method: DeveloperSignInMethod, request: AuthRequestRecord, code: string | null): Promise<HttpResult> {
    const outcome: SignInOutcome = { cause: "sign_in_failed" };
    let response: HttpResult;
    try {
      response = await runSignIn(method, request, code, outcome);
    } finally {
      // Auditing is outside runSignIn's error handling: a failed audit is logged and
      // propagated once, never retried as a second outcome or allowed to grant access.
      await recordSignInOutcome(outcome, method, request);
    }
    if (outcome.successLog !== undefined) deps.log(outcome.successLog);
    return response;
  }

  /** A merged Slack sign-in refreshes only its own workspace hint; a failed hint never gates sign-in. */
  async function rememberMergedWorkspace(merged: boolean, method: DeveloperSignInMethod, identity: ProviderIdentity, signedInId: string, signedInRecord: DeveloperRecord | undefined): Promise<void> {
    if (merged && method === "slack" && identity.slackTeam !== undefined && signedInRecord?.mergedInto !== undefined) {
      try { await store.rememberMergedSlackWorkspace(signedInId, signedInRecord.mergedInto, identity.slackTeam); } catch { /* ignored: hint only */ }
    }
  }

  async function runSignIn(method: DeveloperSignInMethod, request: AuthRequestRecord, code: string | null, outcome: SignInOutcome): Promise<HttpResult> {
    const client = (params: Record<string, string>) => toClient(request.clientRedirectUri, { ...params, state: request.clientState });
    if (request.browserReturnTo !== undefined && !REVIEW_RETURN_TO.test(request.browserReturnTo)) return page(400, "Invalid review link", ["Open the review from Slack and sign in again."]);
    if (code === null) return request.browserReturnTo === undefined
      ? client({ error: "access_denied", error_description: `the sign-in was cancelled at ${methodLabel(method)}; start signing in again` })
      : browserReturn(request.browserReturnTo, false);
    let result: ProviderResult;
    // Whether the install's own provider completed this sign-in (DEC 254b (a): the shared method), as opposed to a company's own issuer.
    let installProvider: boolean;
    try {
      const chosen = await providerChoice(method, request.companyId);
      installProvider = chosen.install;
      result = await chosen.provider.complete({ code, nonce: request.nonce, redirectUri: endpoint(`/callback/${method}`) });
    } catch (error) {
      if (deps.company !== undefined && request.companyId !== undefined) {
        deps.log({ event: "signin.error", path: `/v1/auth/callback/${method}`, error: "sign_in_failed" });
        return companyNotFinished(request);
      }
      if (request.browserReturnTo !== undefined) throw error;
      return providerFailure(error, method, request.clientRedirectUri, request.clientState);
    }
    if (!result.ok) {
      if (result.verifiedIdentity !== undefined) {
        outcome.developerId = ownerKeyForSubject(result.verifiedIdentity.issuer, result.verifiedIdentity.subject);
      }
      if (deps.company !== undefined && request.companyId !== undefined) {
        deps.log({ event: "signin.refused", method, reason: "not_invited" });
        return request.browserReturnTo === undefined ? client({ error: "access_denied", error_description: "not invited" }) : browserReturn(request.browserReturnTo, false);
      }
      deps.log({ event: "signin.refused", method, reason: result.reason });
      if (request.browserReturnTo !== undefined) return browserReturn(request.browserReturnTo, false);
      // A provider may quietly reuse the refused account's session on the next try, so say how to switch.
      const reason = result.reason.replaceAll("AgentX", "Rovara").replaceAll("; run agentx login again", "; start signing in again");
      const hint = result.wrongAccount === true ? `. If you signed in with the wrong account, sign out of ${methodLabel(method)} or use a private window, then try again.` : "";
      return client({ error: "access_denied", error_description: `${reason}${hint}` });
    }
    const identity = result.identity;
    const signedInId = ownerKeyForSubject(identity.issuer, identity.subject);
    let developerId = signedInId;
    outcome.developerId = developerId;
    let existing = await store.getDeveloper(developerId);
    const signedInRecord = existing;
    // DEC 254b: with Code's company layer on, a sign-in an operator merged into another (`mergedInto`) is seated as its survivor: the session, the
    // membership and every check are the survivor's. Only the signed-in Slack identity's workspace metadata may be refreshed. The walk is #820's: at most 8 hops, no
    // loops, and a revoked or unreadable record anywhere refuses.
    let merged = false;
    if (deps.company !== undefined && existing !== undefined && (existing as { mergedInto?: unknown }).mergedInto !== undefined) {
      try {
        const walk = await mergeSurvivor((id) => store.getDeveloper(id), signedInId);
        developerId = walk.survivorId;
        outcome.developerId = developerId;
        existing = await store.getDeveloper(developerId);
        merged = existing !== undefined;
      } catch { merged = false; }
      if (!merged) {
        deps.log({ event: "signin.refused", method, reason: "merge_refused", developerId: signedInId });
        if (request.browserReturnTo !== undefined) return browserReturn(request.browserReturnTo, false);
        return client({ error: "access_denied", error_description: "your Rovara sign-in was turned off by an administrator; contact an administrator" });
      }
    }
    if (existing?.revoked === true) {
      outcome.cause = "person_revoked";
      deps.log({ event: "signin.refused", method, reason: "developer_revoked", developerId });
      if (request.browserReturnTo !== undefined) return browserReturn(request.browserReturnTo, false);
      return client({ error: "access_denied", error_description: "your Rovara sign-in was turned off by an administrator; contact an administrator" });
    }
    let companyId: string | undefined;
    let companyless = false;
    let installMethod = false;
    let joinedByInvite = false;
    if (deps.company !== undefined) {
      const registered = request.clientId === undefined ? undefined : await registeredClient(request.clientId);
      // DEC 254b (a): an install-level client (the CLI, the browser review page, a registered install-level client) that names no company signs the
      // person in to their LIVE membership's company, read now; no membership row: the built-in company (legacy join, preapproval) as before.
      const installLevel = request.clientId === undefined || registered?.installLevel === true;
      let candidate: string | undefined;
      let revokedMember = false;
      // DEC 254e: the same for Slack, from any workspace: the company comes only from live membership (or `company=`), never from the workspace.
      try {
        const member = request.companyId === undefined && installLevel ? await deps.company.membership(developerId) : undefined;
        if (member !== undefined) outcome.companyId = member.companyId;
        revokedMember = member?.revokedAt !== undefined;
        candidate = request.companyId ?? member?.companyId ?? IMPLICIT_COMPANY_ID;
      } catch { candidate = undefined; }
      const clientAllowed = request.clientId === undefined || (registered !== undefined && (registered.installLevel === true || (registered.companyId ?? IMPLICIT_COMPANY_ID) === candidate));
      // The install's methods (its OIDC, its Slack app) admit into a company other than the built-in one only when that company has no issuer of
      // its own (no downgrade). The one exception, as before: a company with an issuer whose install workspace is bound to it keeps that Slack.
      installMethod = installProvider && candidate !== undefined && candidate !== IMPLICIT_COMPANY_ID;
      let ownIssuer = false;
      // A removed member is told so by the join below, whatever their company's sign-in.
      if (installMethod && !revokedMember) { try { ownIssuer = await deps.company.hasOwnIssuer(candidate!); } catch { candidate = undefined; } }
      if (ownIssuer && method === "slack" && identity.slackUserId !== undefined) {
        let bound: boolean;
        try { bound = await slackCompany() === candidate; } catch { bound = false; }
        if (bound) { ownIssuer = false; installMethod = false; }
      }
      if (ownIssuer) {
        outcome.cause = "company_signin_mismatch";
        deps.log({ event: "signin.refused", reason: "company_own_signin", developerId });
        return request.browserReturnTo === undefined ? client({ error: "access_denied", error_description: COMPANY_OWN_SIGNIN }) : browserReturn(request.browserReturnTo, false);
      }
      // DEC 254zzz218: the current provider's verified identity email is mandatory for invite redemption; future methods must use this same guarded path.
      const byInvite = request.inviteHash !== undefined;
      const inviteProof = identity.email === undefined ? {} : { verifiedEmail: identity.email };
      const joined = candidate === undefined || !OrgIdSchema.safeParse(candidate).success || (request.companyId !== undefined && request.companyId !== candidate) || !clientAllowed
        || (byInvite && request.companyId === undefined)
        ? { ok: false as const, reason: "not_invited" as const }
        : byInvite ? await deps.company.joinByInvite({ personId: developerId, companyId: candidate, inviteHash: request.inviteHash!, ...inviteProof })
          : await deps.company.join({ personId: developerId, companyId: candidate, ...(identity.email === undefined ? {} : { email: identity.email }) });
      if (joined.ok) outcome.companyId = joined.membership.companyId;
      else if (joined.attributedCompanyId !== undefined) outcome.companyId = joined.attributedCompanyId;
      // DEC 253z: not invited anywhere, no company asked for, signing in to the web app: a session with no company (it can only create one).
      companyless = !joined.ok && joined.reason === "not_invited" && request.companyId === undefined && request.browserReturnTo === undefined
        && await companylessMayMint(developerId, method, registered);
      if (!joined.ok && !companyless) {
        const refusal = joinRefusal(joined.reason, byInvite);
        outcome.cause = refusal.cause;
        deps.log({ event: "signin.refused", reason: joined.reason, developerId });
        return request.browserReturnTo === undefined ? client(refusal.params) : browserReturn(request.browserReturnTo, false);
      }
      if (joined.ok) companyId = joined.membership.companyId;
      installMethod = installMethod && joined.ok && companyId === candidate;
      // DEC 254b (f): this sign-in's own join spent a live pre-approval for exactly the company the session is bound to.
      joinedByInvite = joined.ok && joined.viaPreapproval === true && companyId === candidate;
    }
    let slackUserId = identity.slackUserId;
    // ProviderIdentity.email is set only for a verified email (providers.ts), so only a verified
    // email is ever looked up in Slack. A person with no company is looked up in no company's Slack, and so is a person from another Slack
    // workspace (DEC 254e: no install or company directory speaks for their workspace).
    const foreignSlack = method === "slack" && identity.slackTeam !== undefined && identity.slackUserId === undefined;
    // DEC 254h: a GitHub email is never used to link a Slack user (GitHub verified it once; the Slack link grants task access by channel).
    const directory = companyless || foreignSlack || method === "github" ? undefined : companyId === undefined || companyId === IMPLICIT_COMPANY_ID ? deps.directory : deps.companyDirectory?.(companyId);
    if (slackUserId === undefined && identity.email !== undefined && directory !== undefined) {
      const link = await directory.lookupByEmail(identity.email);
      slackUserId = link === "unavailable" ? (companyId === undefined || companyId === IMPLICIT_COMPANY_ID ? existing?.slackUserId : undefined) : link === "none" ? undefined : link.userId;
    }
    // DEC 254w: a Slack user the person connected stays their Slack link whatever this sign-in's method or lookup says.
    if (existing?.linkedSlackUserId !== undefined) slackUserId = existing.linkedSlackUserId;
    // A merged sign-in updates only its own verified Slack workspace, keeping the survivor and all profile/index fields intact.
    await rememberMergedWorkspace(merged, method, identity, signedInId, signedInRecord);
    if (!merged) await store.upsertDeveloper({
      developerId, provider: method, issuer: identity.issuer, subject: identity.subject, displayName: identity.displayName,
      ...(identity.email === undefined ? {} : { email: identity.email }),
      ...(slackUserId === undefined ? {} : { slackUserId }),
      ...(identity.slackTeam === undefined ? {} : { slackTeamId: identity.slackTeam.id, ...(identity.slackTeam.name === undefined ? {} : { slackTeamName: identity.slackTeam.name }) }),
    }, companyId, { ...(companyless ? { companyless: true as const } : {}), ...(deps.company === undefined ? {} : { unmerged: true as const }) });
    if (request.browserReturnTo !== undefined) {
      if (!await companyMayMint(developerId, method, request.companyId ?? companyId, undefined, false, installMethod ? true : undefined)) {
        return browserReturn(request.browserReturnTo, false);
      }
      // A fixed 30 days from sign-in, with no renewal: the session record ends then, whatever the cookie says.
      const endsAt = Math.floor(deps.now() / 1000) + SESSION_MAX_AGE_SECONDS;
      const { session } = await store.createSession({ developerId, amr: method, ...(merged && signedInId !== developerId ? { signedInId } : {}),
        ...(slackUserId === undefined ? {} : { slackUserId }),
        reviewExpiresAt: endsAt, endsAt,
        ...(companyId === undefined || (companyId === IMPLICIT_COMPANY_ID && request.companyId === undefined) ? {} : { companyId }),
        ...(installMethod ? { installMethod: true as const } : {}),
      });
      const response = browserReturn(request.browserReturnTo, true, session.sessionId);
      outcome.successLog = { event: "signin.browser_succeeded", method, developerId };
      return response;
    }
    const grant: CodeGrant & { codeChallenge: string; redirectUri: string } = {
      developerId, amr: method, ...(merged && signedInId !== developerId ? { signedInId } : {}), ...(slackUserId === undefined ? {} : { slackUserId }), codeChallenge: request.codeChallenge, redirectUri: request.clientRedirectUri,
      ...(request.clientId === undefined ? {} : { clientId: request.clientId }),
      ...(request.scopes === undefined ? {} : { scopes: request.scopes }),
      ...(companyId === undefined || (companyId === IMPLICIT_COMPANY_ID && request.companyId === undefined) ? {} : { companyId }),
      ...(installMethod ? { installMethod: true as const } : {}),
      ...(joinedByInvite ? { joinedByInvite: true as const } : {}),
      // FR-005: only a company sign-in can make an administrator; only the install issuer can make an install-wide administrator (T3).
      // DEC 254b (a): and only into the built-in company, as before; a member of another company signed in through the shared method never is one.
      ...(method === "oidc" && request.companyId === undefined && identity.administrator === true && !companyless && (companyId === undefined || companyId === IMPLICIT_COMPANY_ID) ? { administrator: true as const } : {}),
    };
    const agentxCode = await store.issueCode(grant);
    const response = toClient(grant.redirectUri, { code: agentxCode, state: request.clientState });
    outcome.successLog = { event: "signin.succeeded", method: grant.amr, developerId: grant.developerId, linkedToSlack: grant.slackUserId !== undefined, ...(grant.clientId === undefined ? {} : { clientId: grant.clientId }) };
    return response;
  }

  /**
   * DEC 254w: a merged or connected sign-in still stands for its person: its identity's walk ends at that person now. Once a connected method is
   * removed (or a merge undone), a code or session it made before that is refused, whenever it is used.
   */
  async function stillSeated(signedInId: string | undefined, developerId: string): Promise<boolean> {
    if (signedInId === undefined) return true;
    try { return (await mergeSurvivor((id) => store.getDeveloper(id), signedInId)).survivorId === developerId; } catch { return false; }
  }

  async function authorizationCodeGrant(form: URLSearchParams, methods: DeveloperSignInMethod[], client: SignInClientRecord | undefined): Promise<HttpResult> {
    const redeemed = await store.redeemCode({ code: form.get("code") ?? "", verifier: form.get("code_verifier") ?? "", redirectUri: form.get("redirect_uri") ?? "" });
    if (redeemed === undefined) return oauthError(400, ...INVALID_CODE);
    // A code is redeemed only by the client it was issued to (it is burned either way).
    if (redeemed.clientId !== client?.clientId) return oauthError(400, ...INVALID_CODE);
    if (!await stillSeated(redeemed.signedInId, redeemed.developerId)) return oauthError(400, ...SIGN_IN_ENDED);
    if (!await companyMayMint(redeemed.developerId, redeemed.amr, redeemed.companyId, client, false, redeemed.installMethod)) return oauthError(400, ...SIGN_IN_ENDED);
    if (deps.company !== undefined && redeemed.companyId !== undefined && redeemed.companyId !== IMPLICIT_COMPANY_ID && redeemed.amr === "oidc") {
      try { methods = await methodsFor(redeemed.companyId) ?? []; } catch { return oauthError(400, ...SIGN_IN_ENDED); }
    }
    if (!methods.includes(redeemed.amr)) return oauthError(400, "invalid_grant", `${methodLabel(redeemed.amr)} sign-in was turned off in this environment; start signing in again`);
    const developer = await store.getDeveloper(redeemed.developerId);
    if (developer === undefined || developer.revoked) return oauthError(400, "invalid_grant", "your Rovara sign-in was turned off by an administrator; contact an administrator");
    const { refreshToken, access } = await mintSession(store, redeemed, (session) => accessToken(session, client),
      (session) => deps.log({ event: "signin.session_started", method: redeemed.amr, developerId: redeemed.developerId, sessionId: session.sessionId, ...(client === undefined ? {} : { clientId: client.clientId }) }));
    return tokens(access, refreshToken);
  }

  async function refreshTokenGrant(form: URLSearchParams, methods: DeveloperSignInMethod[], client: SignInClientRecord | undefined): Promise<HttpResult> {
    const lookup = await store.lookupRefresh(form.get("refresh_token") ?? "");
    const ended = oauthError(400, ...SIGN_IN_ENDED);
    if (lookup.kind === "unknown" || lookup.kind === "ended") return ended;
    if (lookup.kind === "reused") {
      await revoke(lookup.sessionId, "refresh_token_reused");
      return ended;
    }
    // "active", or "recently_rotated": the same token presented again inside the grace window.
    const { session } = lookup;
    // Spec 063: a refresh token works only for the client it was issued to, and not across a removal and re-registration.
    if (session.clientId !== client?.clientId) return ended;
    if (!await companyMayMint(session.developerId, session.amr, session.companyId, client, true, session.installMethod)) {
      await revoke(session.sessionId, "company_changed"); return ended;
    }
    let companySince: number | undefined;
    // A shared-method session (checked just above: its company still has no issuer) is held to the install's own methods, as the built-in company is.
    if (deps.company !== undefined && session.companyId !== undefined && session.companyId !== IMPLICIT_COMPANY_ID && session.amr === "oidc" && session.installMethod !== true) {
      try {
        const selected = await deps.companyIssuer?.(session.companyId);
        if (selected === undefined) { await revoke(session.sessionId, "method_disabled"); return ended; }
        methods = ["oidc", ...enabledMethods(deps).filter((method) => method === "slack")];
        companySince = selected.since;
        const person = await store.getDeveloper(session.developerId);
        if (session.amr === "oidc" && person?.issuer !== selected.issuer) { await revoke(session.sessionId, "method_disabled"); return ended; }
      } catch { return ended; }
    }
    if (client !== undefined && Date.parse(session.startedAt) < Date.parse(client.createdAt)) {
      await revoke(session.sessionId, "client_removed");
      return ended;
    }
    if (!methods.includes(session.amr)) {
      await revoke(session.sessionId, "method_disabled");
      return oauthError(400, "invalid_grant", `${methodLabel(session.amr)} sign-in was turned off in this environment; sign in another way`);
    }
    if (startedBeforeMethodOn(session.startedAt, session.amr === "oidc" ? companySince ?? config.oidc?.since : methodSince(config, session.amr))) {
      await revoke(session.sessionId, "method_disabled");
      return oauthError(400, "invalid_grant", `your sign-in ended when ${methodLabel(session.amr)} was turned off; sign in again`);
    }
    const developer = await store.getDeveloper(session.developerId);
    if (developer === undefined || developer.revoked) {
      await revoke(session.sessionId, "developer_revoked");
      return ended;
    }
    if (!await stillSeated(session.signedInId, session.developerId)) {
      await revoke(session.sessionId, "sign_in_unlinked");
      return ended;
    }
    if (endedByAdmin(session.startedAt, developer.sessionsEndedAt)) {
      await revoke(session.sessionId, "ended_by_admin");
      return oauthError(400, "invalid_grant", "a Rovara administrator ended your sign-in; sign in again");
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
    const access = await accessToken(session, client);
    const rotated = lookup.kind === "active" ? await store.rotateRefresh(lookup) : await store.rotateRecentlyUsed(lookup);
    if ("reused" in rotated) {
      await revoke(session.sessionId, "refresh_token_reused");
      return ended;
    }
    if ("ended" in rotated) return ended;
    if (lookup.kind === "recently_rotated") deps.log({ event: "signin.refresh_grace", sessionId: session.sessionId });
    return tokens(access, rotated.refreshToken);
  }

  async function token(form: URLSearchParams, authorization: string | undefined): Promise<HttpResult> {
    const caller = await retryableCheck("token", () => authenticateClient(form, authorization, false));
    if (!caller.ok) return caller.result;
    const methods = enabledMethods(deps);
    const grant = form.get("grant_type");
    if (grant === "authorization_code") return authorizationCodeGrant(form, methods, caller.client);
    if (grant === "refresh_token") return retryable("token", () => refreshTokenGrant(form, methods, caller.client));
    return oauthError(400, "unsupported_grant_type", "use authorization_code or refresh_token");
  }

  /** A client check that could not read the registry answers 503, as `retryable` does. */
  async function retryableCheck(operation: string, fn: () => Promise<ClientCheck>): Promise<ClientCheck> {
    let result: ClientCheck | undefined;
    const answered = await retryable(operation, async () => {
      result = await fn();
      return jsonResult(200, {});
    });
    return result ?? { ok: false, result: answered };
  }

  /** A retryable AWS error anywhere in fn answers 503 and changes nothing more; others propagate. */
  async function retryable(operation: string, fn: () => Promise<HttpResult>): Promise<HttpResult> {
    try {
      return await fn();
    } catch (error) {
      if (!isRetryableAwsError(error)) throw error;
      deps.log({ event: "signin.retry", operation, error: errorName(error) });
      return oauthError(503, "temporarily_unavailable", "Rovara could not finish this just now; your sign-in is kept, try again in a moment");
    }
  }

  /** RFC 7009. The CLI is a public client; a confidential registered client authenticates. A known refresh token of
   * the calling client ends its session; another client's token is left alone, with the same answer. */
  async function revokeToken(form: URLSearchParams, authorization: string | undefined): Promise<HttpResult> {
    const caller = await retryableCheck("revoke", () => authenticateClient(form, authorization, true));
    if (!caller.ok) return caller.result;
    const presented = form.get("token");
    if (presented === null || presented === "") return oauthError(400, "invalid_request", "token is required");
    return retryable("revoke", async () => {
      const lookup = await store.lookupRefresh(presented);
      if ((lookup.kind === "active" || lookup.kind === "recently_rotated") && lookup.session.clientId !== caller.client?.clientId) return jsonResult(200, {});
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
      methods: {
        slack: methods.includes("slack"), oidc: methods.includes("oidc") && config.oidc !== undefined ? { displayName: config.oidc.displayName } : null,
        // L4-SIGNIN: a sign-in page shows "Sign in with GitHub" only when this lists it (DEC 254h: only with Code's company layer).
        ...(methods.includes("github") ? { github: { displayName: "GitHub" } } : {}),
      },
      // FR-041, E16: the methods this environment allows; the MCP server adds the client's and the admin's own.
      // Slack needs the team set up, not Slack sign-in (controller ruling R5): each change checks the admin's own link.
      confirm: { elicitation: config.confirmElicitation !== false, slack: config.slack.teamId !== undefined } satisfies AgentXConfigurationConfirm,
    };
  };

  const discovery = () => ({
    issuer: config.issuer, authorization_endpoint: endpoint("/authorize"), token_endpoint: endpoint("/token"), revocation_endpoint: endpoint("/revoke"),
    jwks_uri: endpoint("/.well-known/jwks.json"), response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: CLIENT_AUTH_METHODS, revocation_endpoint_auth_methods_supported: CLIENT_AUTH_METHODS,
    subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"], scopes_supported: ["openid"],
  });

  async function route(method: string, pathname: string, url: URL, body: string | undefined, headers: Record<string, string | undefined>): Promise<HttpResult> {
    if (method === "GET") {
      switch (pathname) {
        case "/v1/auth/.well-known/openid-configuration":
          return publicJson(discovery());
        case "/v1/auth/.well-known/jwks.json": {
          const developerKey = await deps.signer.publicJwk();
          const extras = deps.extraPublicKeys ?? [];
          // Preserve legacy bytes when no task key is configured. In a dual-key JWKS,
          // purposes are symmetric and remain stable even if the task key read fails.
          if (extras.length === 0) return publicJson({ keys: [developerKey] });
          const keys = [{ ...developerKey, rovara_purpose: "developer" }];
          for (const extra of extras) {
            const purpose = extra.purpose ?? "task";
            try {
              keys.push({ ...await extra.publicJwk(), rovara_purpose: purpose });
            } catch {
              deps.log({ event: purpose === "task" ? "developer.jwks_task_key_failed" : "developer.jwks_policy_key_failed" });
            }
          }
          return publicJson({ keys });
        }
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
        // DEC 254h: GitHub's callback; with GitHub off (or the company layer off) the sign-in request never chose it, so this answers "expired".
        case "/v1/auth/callback/github":
          return callback("github", url.searchParams, headers);
        case "/v1/auth/end-session":
          return endSession(url.searchParams);
        case "/v1/auth/end-session/return":
          return endSessionReturn(headers);
      }
    }
    if (method === "POST" && pathname === "/v1/auth/token") return token(new URLSearchParams(body ?? ""), headers.authorization);
    if (method === "POST" && pathname === "/v1/auth/revoke") return revokeToken(new URLSearchParams(body ?? ""), headers.authorization);
    return jsonResult(404, { error: "not_found" });
  }

  const isPage = (pathname: string) => pathname === "/v1/auth/authorize" || pathname === "/v1/auth/browser/authorize" || pathname.startsWith("/v1/auth/callback/")
    || pathname.startsWith("/v1/auth/end-session");

  return async (
    event: HttpApiV2Event | ChannelMembersRequest | TaskPersonProofRequest | TaskChannelPeopleRequest | TaskPeopleDisplayReadRequest | ChannelInfoRequest | SlackUserByEmailRequest | SlackAuthCheckRequest | EndDeveloperSessionsRequest | ChannelByNameRequest
      | PutSignInClientRequest | RemoveSignInClientRequest | ListSignInClientsRequest | SetDisplayNameRequest
      | CompanyOperatorRequest | CompanyImportEventInput | SlackInstallInvoke
      | SignInLinkStartRequest | SignInLinkFinishRequest | SignInLinksListRequest | SignInUnlinkRequest,
  ): Promise<HttpResult | ChannelMembersResult | TaskPersonProofResponse | TaskChannelPeopleResponse | TaskPeopleDisplayReadResponse | ChannelInfoResponse | SlackUserByEmailResponse | SlackAuthCheckResponse | EndDeveloperSessionsResponse | ChannelByNameResponse | SignInClientsResponse | SetDisplayNameResponse
    | CompanyOperatorResponse | CompanyImportReplyValue
    | SignInLinkStartResponse | SignInLinkFinishResponse | SignInLinksListResponse | SignInUnlinkResponse | Record<string, unknown>> => {
    if (deps.company !== undefined && (event === null || typeof event !== "object" || Array.isArray(event))) return { ok: false, error: "invalid_request" };
    if ("kind" in event) {
      if (event.kind === "slack-install") return deps.slackInstall === undefined ? { ok: false, error: "not_set_up" } : deps.slackInstall(event);
      if (deps.companyImport !== undefined && (event.kind === "company-import" || event.kind === "company-import-undo")) return companyImportOperator({ store: deps.companyImport, log: deps.log }, event);
      if (deps.company !== undefined && typeof event.kind === "string" && event.kind.startsWith("company-")) return companyOperator({ store: deps.company, ...(deps.companyInvites === undefined ? {} : { invites: deps.companyInvites }), clients: store, now: deps.now, log: deps.log }, event);
      // DEC 254w: connected sign-ins. Each checks the caller's own live session in this table.
      if (event.kind === "sign-in-link-start") return signInLinks.start(event);
      if (event.kind === "sign-in-link-finish") return signInLinks.finish(event);
      if (event.kind === "sign-in-links-list") return signInLinks.list(event);
      if (event.kind === "sign-in-unlink") return signInLinks.unlink(event);
      // Spec 063 (FR-001): the registry of sign-in clients, changed only by the broker's applied admin changes.
      if (event.kind === "put-sign-in-client") {
        const parsed = PutSignInClientRequestSchema.safeParse(event);
        if (!parsed.success) return { ok: false, error: "invalid_request" };
        // DEC 236h: the web app marker is never set by an applied admin change; the operator or the install seeds it.
        if (parsed.data.client.webApp === true) return { ok: false, error: "invalid_request" };
        if (deps.company !== undefined) {
          try {
            await store.putClient(parsed.data.client, parsed.data.companyId ?? IMPLICIT_COMPANY_ID, { ...(parsed.data.keepSecret === true ? { keepSecret: true } : {}) });
            deps.log({ event: "signin.client_registered", clientId: parsed.data.client.clientId });
            return { ok: true };
          } catch { return { ok: false, error: "invalid_request" }; }
        }
        let client = parsed.data.client;
        // An update that keeps the secret: only this server holds the hash, so it carries it over.
        if (parsed.data.keepSecret === true) {
          const current = await store.getClient(client.clientId);
          if (current?.secretHash === undefined) return { ok: false, error: "no_secret" };
          client = { ...client, secretHash: current.secretHash };
        }
        // Spec 066: full access only for a client with a secret, so its tokens only ever reach the service itself.
        if (client.fullAccess === true && client.secretHash === undefined) return { ok: false, error: "invalid_request" };
        await store.putClient(client);
        deps.log({ event: "signin.client_registered", clientId: parsed.data.client.clientId, ...(client.fullAccess === true ? { fullAccess: true } : {}) });
        return { ok: true };
      }
      if (event.kind === "remove-sign-in-client") {
        const parsed = RemoveSignInClientRequestSchema.safeParse(event);
        if (!parsed.success) return { ok: false, error: "invalid_request" };
        if (deps.company !== undefined) {
          try { return { ok: true, removed: await store.removeClient(parsed.data.clientId, parsed.data.companyId ?? IMPLICIT_COMPANY_ID) }; }
          catch { return { ok: false, error: "invalid_request" }; }
        }
        const removed = await store.removeClient(parsed.data.clientId);
        deps.log({ event: "signin.client_removed", clientId: parsed.data.clientId, removed });
        return { ok: true, removed };
      }
      if (event.kind === "list-sign-in-clients") {
        const parsed = ListSignInClientsRequestSchema.safeParse(event);
        if (!parsed.success) return { ok: false, error: "invalid_request" };
        if (deps.company !== undefined) {
          try { return { ok: true, clients: (await store.listClients(parsed.data.companyId ?? IMPLICIT_COMPANY_ID)).map(signInClientView) }; }
          catch { return { ok: false, error: "unavailable" }; }
        }
        return { ok: true, clients: (await store.listClients()).map(signInClientView) };
      }
      if (event.kind === "end-developer-sessions") {
        const parsed = EndDeveloperSessionsRequestSchema.safeParse(event);
        if (!parsed.success) return { ok: false, error: "invalid_request" };
        const result = await store.endSessions(parsed.data.developerId, parsed.data.at);
        deps.log({ event: "signin.sessions_ended_by_admin", developerId: parsed.data.developerId, result });
        return result === "ended" ? { ok: true } : { ok: false, error: "not_found" };
      }
      if (event.kind === "set-display-name") {
        const parsed = SetDisplayNameRequestSchema.safeParse(event);
        // Checked again here, so no caller of this Lambda can store a name the route would refuse (an email address, a placeholder).
        const name = parsed.success ? SetMyNameBodySchema.safeParse({ name: parsed.data.name }) : undefined;
        if (!parsed.success || name?.success !== true || name.data.name !== parsed.data.name) return { ok: false, error: "invalid_request" };
        try {
          const stored = await store.setChosenDisplayName(parsed.data.developerId, name.data.name);
          // No name in the log: it is the person's choice, not an operational fact.
          deps.log({ event: "signin.display_name_chosen", developerId: parsed.data.developerId });
          return { ok: true, name: stored.displayName };
        } catch (error) {
          if ((error as { code?: unknown }).code === "NOT_FOUND") return { ok: false, error: "not_found" };
          throw error;
        }
      }
      if (deps.company !== undefined && deps.directoryForWorkspace === undefined) return { ok: false, error: "slack_unavailable" };
      let directory = deps.directory;
      if (deps.directoryForWorkspace !== undefined) {
        try {
          const scoped = event.kind === "task-people-display-read" ? event.request : event;
          directory = await deps.directoryForWorkspace((scoped as { workspace?: unknown }).workspace);
        } catch { return { ok: false, error: "slack_unavailable" }; }
      }
      if (event.kind === "channel-by-name") {
        const parsed = ChannelByNameRequestSchema.safeParse(event);
        if (!parsed.success) return { ok: false, error: "invalid_request" };
        return directory.channelByName(parsed.data.name);
      }
      if (event.kind === "slack-user-by-email") {
        const parsed = SlackUserByEmailRequestSchema.safeParse(event);
        if (!parsed.success) return { ok: false, error: "invalid_request" };
        const found = await directory.lookupByEmail(parsed.data.email);
        if (found === "unavailable") return { ok: false, error: "slack_unavailable" };
        return found === "none" ? { ok: true } : { ok: true, userId: found.userId };
      }
      if (event.kind === "slack-auth-check") {
        if (!SlackAuthCheckRequestSchema.safeParse(event).success) return { ok: false, error: "invalid_request" };
        return directory.authTest();
      }
      if (event.kind === "channel-info") {
        const parsed = ChannelInfoRequestSchema.safeParse(event);
        if (!parsed.success) return { ok: false, error: "invalid_request" };
        return directory.channelInfo(parsed.data.channelIds);
      }
      if (event.kind === "task-person-proof") {
        const parsed = TaskPersonProofRequestSchema.safeParse(event);
        if (!parsed.success) return { ok: false, error: "invalid_request" };
        return directory.taskPersonProof(parsed.data.slackUserId, parsed.data.channelIds);
      }
      if (event.kind === "task-channel-people") {
        const parsed = TaskChannelPeopleRequestSchema.safeParse(event);
        if (!parsed.success) return { ok: false, error: "invalid_request" };
        return directory.taskChannelPeople(parsed.data.channelIds);
      }
      if (event.kind === "task-people-display-read") {
        const parsed = TaskPeopleDisplayReadRequestSchema.safeParse(event);
        if (!parsed.success) return { ok: false, error: "invalid_request" };
        return directory.taskPeopleDisplayRead({
          ...parsed.data,
          admission: { ...parsed.data.admission, deadlineAt: Math.min(parsed.data.admission.deadlineAt, deps.now() + 20_000) },
        });
      }
      const parsed = ChannelMembersRequestSchema.safeParse(event);
      if (!parsed.success) return { ok: false, error: "invalid_request" };
      return directory.channelMembers(parsed.data.slackUserId, parsed.data.channelIds);
    }
    const request = adaptHttpApiEvent(event);
    const url = new URL(request.path, "https://agentx.invalid");
    try {
      return await route(request.method, url.pathname, url, request.body, request.headers);
    } catch (error) {
      // Only the error's name: a KMS or AWS message can carry a key ARN or other detail.
      deps.log({ event: "signin.error", path: url.pathname, error: errorName(error) });
      return isPage(url.pathname)
        ? page(500, "Sign-in failed", ["Something went wrong. Start signing in again."])
        : oauthError(500, "server_error", "sign-in failed on the server; try again");
    }
  };
}
