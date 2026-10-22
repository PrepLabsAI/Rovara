import { createHash, randomUUID } from "node:crypto";
import { E2E_ANONYMOUS_ACCOUNT_PROFILE_ID, E2E_ANONYMOUS_SESSION_REF_PREFIX, E2E_EXECUTOR_COMPILED_ORIGIN, E2E_FORM_LOGIN_AUTH_PROFILE, E2ERuntimeAccountRefSchema, canonicalJson, e2eAnonymousAccountIdDigest,
  e2eAnonymousRuntimeAccountRef, readE2EApplicationProjectContract, type E2EExecutorPlan, type E2ERuntimeAccountRef } from "@agentx/contracts";
import type { E2EApplicationOwnedSubject } from "../application-result-adapter.js";
import type { E2EApiRuntimeResponse } from "../api-runtime.js";
import type { ExecutorSessionFacts } from "./case-ledger.js";
import { FormLoginError, isSessionCookieSecret, isSessionStorageSecret, parseSetCookie, type FormLoginDriver, type FormLoginStorageState, type FormRequestContext, type StorageCookie } from "./form-login.js";
import { resolveE2EExecutorSuite } from "./suite.js";

const MAX_BODY_BYTES = 1_048_576;
const COOKIE_NAME = "orders_session";
const SESSION_TOKEN = /^[A-Za-z0-9_-]{24,256}$/;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

type Session = {
  sessionRef: string; applicationId: string; profileId: string; accountRef: E2ERuntimeAccountRef; token: string;
  accountIdDigest: string; observedAt: string; login: ExecutorSessionFacts["login"]; identity: ExecutorSessionFacts["identity"];
  subject: E2EApplicationOwnedSubject | null; closed: boolean;
  /** The signed-out visitor (`rovara-anonymous`): no login was made, no cookie exists, and nothing is signed out when the case closes. */
  anonymous: boolean;
  /** Only for a `rovara-form-login/v1` account: what the signed-in context kept, and the request context that carries it. The state is secret. */
  form: { state: FormLoginStorageState; requests: FormRequestContext } | null;
};
/** What a case's browser context is given: the cookies of the account's session and the local storage of the origins the sign-in visited. */
export type BrowserSessionState = Readonly<{ cookies: readonly StorageCookie[]; localStorage: readonly Readonly<{ origin: string; entries: readonly Readonly<{ name: string; value: string }>[] }>[] }>;

async function readBounded(response: Response): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) { await response.body?.cancel().catch(() => undefined); throw new Error("application response exceeds the fixed bound"); }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const value = next.value as Uint8Array;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) { await reader.cancel().catch(() => undefined); throw new Error("application response exceeds the fixed bound"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, total);
}

/** The one session cookie the fixed orders-auth/v1 profile issues; anything else about it is a refusal, not a guess. */
function sessionToken(response: Response): string {
  const cookies = response.headers.getSetCookie();
  if (cookies.length !== 1 || cookies[0]!.length > 4096) throw new Error("orders-auth/v1 returned no single bounded session cookie");
  const [head, ...attributes] = cookies[0]!.split(";").map((part) => part.trim());
  const separator = head!.indexOf("=");
  if (separator < 1 || head!.slice(0, separator) !== COOKIE_NAME) throw new Error("orders-auth/v1 returned a foreign cookie name");
  const value = head!.slice(separator + 1);
  const lower = attributes.map((item) => item.toLowerCase());
  if (!SESSION_TOKEN.test(value) || !lower.includes("httponly") || !lower.includes("samesite=strict") || !lower.includes("path=/")
    || lower.some((item) => item.startsWith("domain=") || item.startsWith("max-age=0") || item.startsWith("expires="))) {
    throw new Error("orders-auth/v1 cookie does not match the fixed private session profile");
  }
  return value;
}

function parseJsonObject(bytes: Uint8Array, label: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new Error(`${label} is not UTF-8 JSON`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is not a JSON object`);
  return value as Record<string, unknown>;
}

export type ExecutorSessionStore = ReturnType<typeof createExecutorSessionStore>;

/**
 * Refuses, before any case runs, a plan whose form-login configuration cannot be run as the approved source declares it: an account whose login form differs from its profile's (or is
 * missing, or is there although the profile has none), or one that signs in through a form when there is no browser to do it with. Names the profile and nothing the page or the
 * accounts hold.
 */
export function validateFormLogins(plan: E2EExecutorPlan, hasBrowser: boolean): void {
  const resolved = resolveE2EExecutorSuite(plan);
  const snapshot = resolved.suite.runtimeAdmissionContext.selectionInput.sourceSnapshot;
  for (const { applicationId } of resolved.suite.originByApplicationId) {
    const contract = readE2EApplicationProjectContract(snapshot, applicationId);
    for (const account of plan.accounts) {
      const profile = contract?.accountProfiles.find((candidate) => candidate.profileId === account.profileId);
      if (!profile) continue;
      if (canonicalJson(profile.login ?? null) !== canonicalJson(account.login ?? null)) {
        throw new Error(`the login form of account profile ${account.profileId} in the plan differs from the one the approved source declares for it`);
      }
      if (account.login !== undefined && !hasBrowser) throw new Error(`account profile ${account.profileId} signs in through a form, and this executor has no browser to sign in with`);
    }
  }
}

/**
 * Owns the per-case synthetic account sessions. Two logins exist. The built-in `orders-auth/v1` profile POSTs the seeded credentials to `/api/login`, keeps the
 * `orders_session` cookie in memory, and sends it on API requests or adds it to the owned browser context. `rovara-form-login/v1` (Task 3.2) signs in through the
 * application's own form in a fresh browser context, keeps that context's storage state for the case, and answers API requests through a request context that carries it.
 * The cookie values and the credentials never leave this object: `registerSecret` is told every session value so that nothing the executor writes can carry one.
 */
export function createExecutorSessionStore(input: { plan: E2EExecutorPlan; fetchImpl?: typeof fetch;
  /** The browser side of `rovara-form-login/v1`; without it an account that signs in through a form cannot be opened. */
  formLogin?: FormLoginDriver;
  /** Called with every secret a session creates (cookie values, token-like local storage values), before the session is used. */
  registerSecret?: (value: string) => void;
  /** Called with the profile of an account whose form login did not complete, whatever the cause. */
  onLoginFailed?: (profileId: string) => void }) {
  const resolved = resolveE2EExecutorSuite(input.plan);
  validateFormLogins(input.plan, input.formLogin !== undefined);
  const fetchImpl = input.fetchImpl ?? fetch;
  // Requests go to the compiled loopback origin, where the executor's forwarder serves the candidate.
  const origin: string = E2E_EXECUTOR_COMPILED_ORIGIN;
  const upstream = origin;
  const sessions = new Map<string, Session>();
  const registered = new Set<string>();
  const registerOnce = (value: string): void => { if (!registered.has(value)) { registered.add(value); input.registerSecret?.(value); } };
  const sourceSnapshot = resolved.suite.runtimeAdmissionContext.selectionInput.sourceSnapshot;

  const urlFor = (path: string): URL => {
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) throw new Error("application path must be a plain same-origin path");
    return new URL(path, upstream);
  };
  const bounded = (signal: AbortSignal) => AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, resolved.deadlineAtMs - Date.now()))]);
  const must = (sessionRef: string): Session => {
    const session = sessions.get(sessionRef);
    if (!session || session.closed) throw new Error("case session is unknown or already closed");
    return session;
  };

  /**
   * The signed-out visitor (Ruling AZ): the case runs in a fresh browser context with no cookie and no storage, or sends API requests with no cookie, and nobody is signed in. The
   * session is the sentinel one: its reference carries the anonymous prefix and a UUID of its own, its identity digest is the fixed one of the application, and it has no login and
   * no identity to report. The reference it runs under must be the one the application fixes; a registered account's is not.
   */
  function openAnonymous(raw: { applicationId: string }, accountRef: E2ERuntimeAccountRef) {
    if (canonicalJson(accountRef) !== canonicalJson(e2eAnonymousRuntimeAccountRef(raw.applicationId))) throw new Error("the anonymous profile runs under the fixed anonymous account reference only");
    const sessionRef = `${E2E_ANONYMOUS_SESSION_REF_PREFIX}${randomUUID()}`;
    const accountIdDigest = e2eAnonymousAccountIdDigest(raw.applicationId);
    sessions.set(sessionRef, { sessionRef, applicationId: raw.applicationId, profileId: E2E_ANONYMOUS_ACCOUNT_PROFILE_ID, accountRef, token: "", accountIdDigest,
      observedAt: new Date().toISOString(), login: null, identity: null, subject: null, closed: false, form: null, anonymous: true });
    return { sessionRef, accountIdDigest };
  }

  async function open(raw: { binding: unknown; applicationId: string; profileId: string; approvedAccountRef: unknown; origin: string }, signal: AbortSignal) {
    const accountRef = E2ERuntimeAccountRefSchema.parse(raw.approvedAccountRef);
    if (raw.origin !== origin || accountRef.applicationId !== raw.applicationId || accountRef.profileId !== raw.profileId) {
      throw new Error("account open is outside the exact admitted application origin and account");
    }
    if (raw.profileId === E2E_ANONYMOUS_ACCOUNT_PROFILE_ID) return openAnonymous(raw, accountRef);
    const account = input.plan.accounts.find((candidate) => candidate.profileId === raw.profileId);
    if (!account) throw new Error("no seeded account exists for this account profile");
    const contract = readE2EApplicationProjectContract(sourceSnapshot, raw.applicationId);
    const profile = contract?.accountProfiles.find((candidate) => candidate.profileId === raw.profileId);
    if (!profile || profile.scope !== "synthetic-test" || profile.identityProbeId !== "orders-identity/v1"
      || (profile.authProfileId !== "orders-auth/v1" && profile.authProfileId !== E2E_FORM_LOGIN_AUTH_PROFILE)) {
      throw new Error("only the built-in orders-auth/v1 and the rovara-form-login/v1 synthetic account profiles are supported");
    }
    if (profile.authProfileId === E2E_FORM_LOGIN_AUTH_PROFILE) return openForm({ ...raw, accountRef }, account, profile, signal);
    const operation = bounded(signal);
    const loginResponse = await fetchImpl(urlFor("/api/login"), { method: "POST", redirect: "manual", signal: operation,
      headers: { "content-type": "application/json" }, body: JSON.stringify({ email: account.email, password: account.password }) });
    const loginBody = await readBounded(loginResponse);
    if (loginResponse.status !== 200) throw new Error(`the application refused the seeded login (status ${loginResponse.status})`);
    const token = sessionToken(loginResponse);
    const loginRole = parseJsonObject(loginBody, "login response").role;
    const meResponse = await fetchImpl(urlFor("/api/me"), { method: "GET", redirect: "manual", signal: operation, headers: { cookie: `${COOKIE_NAME}=${token}` } });
    const me = parseJsonObject(await readBounded(meResponse), "identity response");
    if (meResponse.status !== 200 || typeof me.subjectId !== "string" || typeof me.tenantId !== "string" || typeof me.role !== "string") {
      throw new Error("the application did not return the seeded account identity");
    }
    if (loginRole !== me.role || me.role !== profile.roleRef || me.tenantId !== profile.tenantRef) {
      throw new Error("the logged-in identity differs from the account profile's declared role and tenant");
    }
    const sessionRef = `rovara-session-${randomUUID()}`;
    sessions.set(sessionRef, { sessionRef, applicationId: raw.applicationId, profileId: raw.profileId, accountRef, token,
      accountIdDigest: sha(me.subjectId), observedAt: new Date().toISOString(), login: { status: loginResponse.status, role: String(loginRole) },
      identity: { status: meResponse.status, subjectIdDigest: sha(me.subjectId), tenantId: me.tenantId, role: me.role }, subject: null, closed: false, form: null, anonymous: false });
    return { sessionRef, accountIdDigest: sha(me.subjectId) };
  }

  /**
   * `rovara-form-login/v1`: the form is the one the approved source declares for this profile (the plan carries the same, and a plan that differs is refused). The sign-in happens
   * in a fresh browser context; what it kept is checked against the profile by asking the application who the session belongs to (`/api/me`, the same identity probe as
   * `orders-auth/v1`), so a form that signs the viewer in as the owner, or in another tenant, gives no session. Any failure is a `FormLoginError` that names the profile and
   * nothing the page or the driver said, and is reported to the host, which ends the run as `login-failed`.
   */
  async function openForm(raw: { applicationId: string; profileId: string; accountRef: E2ERuntimeAccountRef },
    account: E2EExecutorPlan["accounts"][number], profile: { tenantRef: string; roleRef: string; login?: unknown }, signal: AbortSignal) {
    const formLogin = input.formLogin;
    const login = account.login;
    // Both were checked when the store was made (`validateFormLogins`); this is only for the types.
    if (formLogin === undefined || login === undefined) throw new Error("a form-login account needs its login and a browser");
    const fail = (): never => { input.onLoginFailed?.(raw.profileId); throw new FormLoginError(raw.profileId); };
    const operation = bounded(signal);
    let requests: FormRequestContext | null = null;
    try {
      const signedIn = await formLogin.signIn({ origin, login, email: account.email, password: account.password, signal: operation });
      // Told before anything else is done with them, so a failure further on cannot leave a cookie the executor does not know to scrub. Only what looks like a secret: a consent flag is not.
      for (const cookie of signedIn.state.cookies) if (isSessionCookieSecret(cookie)) registerOnce(cookie.value);
      for (const item of signedIn.state.origins) for (const entry of item.localStorage) if (isSessionStorageSecret(entry.value)) registerOnce(entry.value);
      requests = await formLogin.requestContext({ origin, state: signedIn.state });
      const meResponse = await requests.request({ method: "GET", path: "/api/me", signal: operation });
      const me = parseJsonObject(meResponse.body, "identity response");
      if (meResponse.status !== 200 || typeof me.subjectId !== "string" || typeof me.tenantId !== "string" || typeof me.role !== "string"
        || me.role !== profile.roleRef || me.tenantId !== profile.tenantRef) throw new Error("the signed-in identity is not the account profile's");
      const sessionRef = `rovara-session-${randomUUID()}`;
      sessions.set(sessionRef, { sessionRef, applicationId: raw.applicationId, profileId: raw.profileId, accountRef: raw.accountRef, token: "",
        accountIdDigest: sha(me.subjectId), observedAt: new Date().toISOString(), login: { status: signedIn.status, role: me.role },
        identity: { status: meResponse.status, subjectIdDigest: sha(me.subjectId), tenantId: me.tenantId, role: me.role }, subject: null, closed: false,
        form: { state: signedIn.state, requests }, anonymous: false });
      return { sessionRef, accountIdDigest: sha(me.subjectId) };
    } catch {
      await requests?.dispose().catch(() => undefined);
      return fail();
    }
  }

  async function close(sessionRef: string, signal: AbortSignal): Promise<{ confirmed: boolean }> {
    const session = sessions.get(sessionRef);
    if (!session) throw new Error("case session is unknown");
    if (session.closed) return { confirmed: true };
    if (session.anonymous) {
      // Nobody was signed in, so there is nothing to sign out.
      session.closed = true;
      return { confirmed: true };
    }
    if (session.form !== null) {
      // A form session has no logout the executor could know of: its cookies live in this request context and in the case's own context, both gone with the run's browser.
      await session.form.requests.dispose().catch(() => undefined);
      session.closed = true;
      return { confirmed: true };
    }
    const response = await fetchImpl(urlFor("/api/logout"), { method: "POST", redirect: "manual", signal,
      headers: { cookie: `${COOKIE_NAME}=${session.token}` } });
    await response.body?.cancel().catch(() => undefined);
    session.closed = response.status >= 200 && response.status < 300;
    return { confirmed: session.closed };
  }

  async function request(raw: { sessionRef: string; origin: string; method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; path: string; body?: unknown; requestId?: string }, signal: AbortSignal): Promise<E2EApiRuntimeResponse> {
    const session = must(raw.sessionRef);
    if (raw.origin !== origin) throw new Error("API request origin differs from the only origin an executor run may reach");
    if (session.anonymous) {
      // No cookie at all: the request is the visitor's.
      const body = raw.body === undefined || raw.method === "GET" ? undefined : JSON.stringify(raw.body);
      const response = await fetchImpl(urlFor(raw.path), { method: raw.method, redirect: "manual", signal: bounded(signal),
        ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body }) });
      const bytes = await readBounded(response);
      return { requestId: raw.requestId ?? `req-${randomUUID()}`, responseId: `res-${randomUUID()}`, method: raw.method, path: raw.path, status: response.status,
        body: bytes, contentType: response.headers.get("content-type") ?? "application/octet-stream", origin, observedAt: new Date().toISOString() };
    }
    if (session.form !== null) {
      urlFor(raw.path);
      const answered = await session.form.requests.request({ method: raw.method, path: raw.path, ...(raw.body === undefined ? {} : { body: raw.body }), signal: bounded(signal) });
      // A value the application issued to replace a cookie is a session secret from then on, like the one it replaced.
      for (const line of answered.setCookies) { const issued = parseSetCookie(line); if (issued !== null && isSessionCookieSecret(issued)) registerOnce(issued.value); }
      return { requestId: raw.requestId ?? `req-${randomUUID()}`, responseId: `res-${randomUUID()}`, method: raw.method, path: raw.path, status: answered.status,
        body: answered.body, contentType: answered.contentType, origin, observedAt: new Date().toISOString() };
    }
    const body = raw.body === undefined || raw.method === "GET" ? undefined : JSON.stringify(raw.body);
    const response = await fetchImpl(urlFor(raw.path), { method: raw.method, redirect: "manual", signal: bounded(signal),
      headers: { cookie: `${COOKIE_NAME}=${session.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body }) });
    const bytes = await readBounded(response);
    return { requestId: raw.requestId ?? `req-${randomUUID()}`, responseId: `res-${randomUUID()}`, method: raw.method, path: raw.path, status: response.status,
      body: bytes, contentType: response.headers.get("content-type") ?? "application/octet-stream", origin, observedAt: new Date().toISOString() };
  }

  return Object.freeze({
    open, close, request,
    /** Only the owned browser port may ask for the cookie; it goes straight into a BrowserContext. */
    cookieFor(sessionRef: string): { name: string; value: string; origin: string } {
      const session = must(sessionRef);
      if (session.anonymous) throw new Error("an anonymous session has no cookie");
      if (session.form !== null) throw new Error("a form-login session has a storage state, not the fixed orders cookie");
      return { name: COOKIE_NAME, value: session.token, origin };
    },
    /** Only the owned browser port may ask for it; it goes straight into a BrowserContext. For `orders-auth/v1` this is the one fixed cookie. */
    browserStateFor(sessionRef: string): BrowserSessionState {
      const session = must(sessionRef);
      if (session.anonymous) return { cookies: [], localStorage: [] };
      if (session.form === null) {
        return { cookies: [{ name: COOKIE_NAME, value: session.token, domain: new URL(origin).hostname, path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Strict" }], localStorage: [] };
      }
      return { cookies: session.form.state.cookies.map((cookie) => ({ ...cookie })),
        localStorage: session.form.state.origins.filter((item) => item.localStorage.length > 0).map((item) => ({ origin: item.origin, entries: item.localStorage.map((entry) => ({ ...entry })) })) };
    },
    bindSubject(sessionRef: string, subject: E2EApplicationOwnedSubject): void { must(sessionRef).subject = subject; },
    /** Whether the session is the signed-out visitor's. It holds no credential, so what the application itself sets for a visitor (a visitor id, a cart) is no session secret. */
    isAnonymous: (sessionRef: string): boolean => sessions.get(sessionRef)?.anonymous === true,
    fetchUrl: (path: string) => urlFor(path),
    fetchImpl,
    sessionFacts(ownedClientRef: string, kind: "browser" | "service"): ExecutorSessionFacts {
      const session = must(ownedClientRef);
      const subject: E2EApplicationOwnedSubject | null = kind === "browser" ? session.subject
        : { kind: "service", processId: "candidate-app-container", origin };
      if (!subject || subject.kind !== kind) throw new Error("the owned client has no recorded subject identity");
      return { sessionRef: session.sessionRef, accountIdDigest: session.accountIdDigest, observedAt: session.observedAt,
        login: session.login, identity: session.identity, subject };
    },
  });
}
