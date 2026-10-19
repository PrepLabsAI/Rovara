import { createHash, randomUUID } from "node:crypto";
import { E2E_EXECUTOR_COMPILED_ORIGIN, E2ERuntimeAccountRefSchema, readE2EApplicationProjectContract, type E2EExecutorPlan, type E2ERuntimeAccountRef } from "@agentx/contracts";
import type { E2EApplicationOwnedSubject } from "../application-result-adapter.js";
import type { E2EApiRuntimeResponse } from "../api-runtime.js";
import type { ExecutorSessionFacts } from "./case-ledger.js";
import { resolveE2EExecutorSuite } from "./suite.js";

const MAX_BODY_BYTES = 1_048_576;
const COOKIE_NAME = "orders_session";
const SESSION_TOKEN = /^[A-Za-z0-9_-]{24,256}$/;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

type Session = {
  sessionRef: string; applicationId: string; profileId: string; accountRef: E2ERuntimeAccountRef; token: string;
  accountIdDigest: string; observedAt: string; login: ExecutorSessionFacts["login"]; identity: ExecutorSessionFacts["identity"];
  subject: E2EApplicationOwnedSubject | null; closed: boolean;
};

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
 * Owns the per-case synthetic account sessions. The only login in M1.1 is the built-in `orders-auth/v1` profile: POST the
 * seeded credentials to `/api/login`, keep the `orders_session` cookie in memory, and send it on API requests or add it to
 * the owned browser context. The cookie value and the credentials never leave this object.
 */
export function createExecutorSessionStore(input: { plan: E2EExecutorPlan; fetchImpl?: typeof fetch }) {
  const resolved = resolveE2EExecutorSuite(input.plan);
  const fetchImpl = input.fetchImpl ?? fetch;
  // Requests go to the compiled loopback origin, where the executor's forwarder serves the candidate.
  const origin: string = E2E_EXECUTOR_COMPILED_ORIGIN;
  const upstream = origin;
  const sessions = new Map<string, Session>();
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

  async function open(raw: { binding: unknown; applicationId: string; profileId: string; approvedAccountRef: unknown; origin: string }, signal: AbortSignal) {
    const accountRef = E2ERuntimeAccountRefSchema.parse(raw.approvedAccountRef);
    if (raw.origin !== origin || accountRef.applicationId !== raw.applicationId || accountRef.profileId !== raw.profileId) {
      throw new Error("account open is outside the exact admitted application origin and account");
    }
    const account = input.plan.accounts.find((candidate) => candidate.profileId === raw.profileId);
    if (!account) throw new Error("no seeded account exists for this account profile");
    const contract = readE2EApplicationProjectContract(sourceSnapshot, raw.applicationId);
    const profile = contract?.accountProfiles.find((candidate) => candidate.profileId === raw.profileId);
    if (!profile || profile.scope !== "synthetic-test" || profile.authProfileId !== "orders-auth/v1" || profile.identityProbeId !== "orders-identity/v1") {
      throw new Error("only the built-in orders-auth/v1 synthetic account profile is supported");
    }
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
      identity: { status: meResponse.status, subjectIdDigest: sha(me.subjectId), tenantId: me.tenantId, role: me.role }, subject: null, closed: false });
    return { sessionRef, accountIdDigest: sha(me.subjectId) };
  }

  async function close(sessionRef: string, signal: AbortSignal): Promise<{ confirmed: boolean }> {
    const session = sessions.get(sessionRef);
    if (!session) throw new Error("case session is unknown");
    if (session.closed) return { confirmed: true };
    const response = await fetchImpl(urlFor("/api/logout"), { method: "POST", redirect: "manual", signal,
      headers: { cookie: `${COOKIE_NAME}=${session.token}` } });
    await response.body?.cancel().catch(() => undefined);
    session.closed = response.status >= 200 && response.status < 300;
    return { confirmed: session.closed };
  }

  async function request(raw: { sessionRef: string; origin: string; method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; path: string; body?: unknown }, signal: AbortSignal): Promise<E2EApiRuntimeResponse> {
    const session = must(raw.sessionRef);
    if (raw.origin !== origin) throw new Error("API request origin differs from the only origin an executor run may reach");
    const body = raw.body === undefined || raw.method === "GET" ? undefined : JSON.stringify(raw.body);
    const response = await fetchImpl(urlFor(raw.path), { method: raw.method, redirect: "manual", signal: bounded(signal),
      headers: { cookie: `${COOKIE_NAME}=${session.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body }) });
    const bytes = await readBounded(response);
    return { requestId: `req-${randomUUID()}`, responseId: `res-${randomUUID()}`, method: raw.method, path: raw.path, status: response.status,
      body: bytes, contentType: response.headers.get("content-type") ?? "application/octet-stream", origin, observedAt: new Date().toISOString() };
  }

  return Object.freeze({
    open, close, request,
    /** Only the owned browser port may ask for the cookie; it goes straight into a BrowserContext. */
    cookieFor(sessionRef: string): { name: string; value: string; origin: string } {
      return { name: COOKIE_NAME, value: must(sessionRef).token, origin };
    },
    bindSubject(sessionRef: string, subject: E2EApplicationOwnedSubject): void { must(sessionRef).subject = subject; },
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
