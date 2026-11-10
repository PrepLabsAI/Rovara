// Lane L8: who may talk to a local page, and what a form must carry. The pages take approvals, so every request has to pass these checks before it
// is routed, and a write passes more:
//
//   1. `Host` is exactly this listener's own `127.0.0.1:<port>`. A name an attacker controls can resolve to 127.0.0.1 (DNS rebinding), but the
//      browser then sends that name as Host, which is refused here before anything is looked at.
//   2. The connection comes from a loopback address.
//   3. `Sec-Fetch-Site`, when the browser sends one, is `same-origin` or `none`. Another loopback port is `same-site`, and is refused.
//   4. `Origin` and `Referer`, when present, are this listener's own origin. A write must carry an `Origin`, and it must be this one.
//   5. The path starts with a session token (`/s/<token>/...`) that this run minted and has not expired. There is no cookie: a cookie is sent to
//      every port of 127.0.0.1, so another local program could receive it. A wrong token answers exactly like a path that does not exist.
//   6. A write also carries a form token that binds the session, the action and the exact content (task, request, revision, digest) the page
//      showed, and has not expired. A form drawn for one revision cannot approve another.
//
// No response carries a CORS header. Nothing here logs a path, because the path holds the token.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** What an approval proof is bound to: exactly the request, revision and content the person decided. */
export interface ProofBinding { requestId: string; revision: number; artifactDigest: string }

/** How long a session lasts when its creator does not say. */
export const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
/** How long a drawn form stays good. */
export const FORM_TOKEN_TTL_MS = 60 * 60 * 1000;
/** The most sessions alive at once; the oldest is dropped for a new one (a fresh session is dropped first). */
export const MAX_SESSIONS = 16;
/** The most fresh sessions alive at once: a new one drops the oldest fresh one, so repeated opens can never fill the cap or push the owner's own session out. */
export const MAX_FRESH_SESSIONS = 3;
/** How long a fresh session lives: long enough to read the page and make one token. */
export const FRESH_SESSION_TTL_MS = 15 * 60 * 1000;

export interface LocalPageSession {
  /** A name that is safe to log; not the token. */
  id: string;
  /** When the session was opened (ms): a page that makes a long-lived credential asks for a session opened a few minutes ago. */
  createdAt: number;
  /** A short-lived session opened for the script tokens page (`rovara token create`): dropped before any other session when the cap is reached, and few at a time. */
  fresh: boolean;
  expiresAt: number;
  label: string;
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

/**
 * The sessions of one running server. A token is 256 random bits; only its hash is kept. `isValidSecret` is the check the identity adapter's
 * `local-session` credential and the approvers' `local-session` proof use, so a proof is good only while the page session it came from is.
 */
export class LocalPageSessions {
  private readonly sessions = new Map<string, LocalPageSession>();
  private readonly byId = new Map<string, string>();
  /** Signs approval proofs. It never leaves this object, so a proof cannot be made without it. */
  private readonly proofKey = randomBytes(32);

  constructor(private readonly now: () => number = Date.now, private readonly random: (bytes: number) => Buffer = randomBytes) {}

  /** Opens a session and returns the secret once. */
  mint(options: { ttlMs?: number; label?: string; fresh?: boolean } = {}): { token: string; session: LocalPageSession } {
    this.sweep();
    const fresh = options.fresh === true;
    const oldestFresh = (): string | undefined => [...this.sessions].find(([, session]) => session.fresh)?.[0];
    // A fresh session replaces the oldest fresh one once there are enough of them.
    while (fresh && [...this.sessions.values()].filter((session) => session.fresh).length >= MAX_FRESH_SESSIONS) {
      const key = oldestFresh();
      if (key === undefined) break;
      this.drop(key);
    }
    while (this.sessions.size >= MAX_SESSIONS) {
      // Fresh sessions go before the owner's own, whichever is older.
      const oldest = oldestFresh() ?? this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.drop(oldest);
    }
    const token = this.random(32).toString("base64url");
    const key = sha256(token);
    const session: LocalPageSession = { id: key.slice(0, 12), createdAt: this.now(), fresh, expiresAt: this.now() + (options.ttlMs ?? (fresh ? FRESH_SESSION_TTL_MS : DEFAULT_SESSION_TTL_MS)), label: options.label ?? "" };
    this.sessions.set(key, session);
    this.byId.set(session.id, key);
    return { token, session };
  }

  /** The session a token opens, or undefined for an unknown, expired or malformed token. */
  find(token: string | undefined): LocalPageSession | undefined {
    if (token === undefined || !/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    const key = sha256(token);
    const session = this.sessions.get(key);
    if (session === undefined) return undefined;
    if (session.expiresAt <= this.now()) {
      this.drop(key);
      return undefined;
    }
    return session;
  }

  isValidSecret(token: string | undefined): boolean {
    return this.find(token) !== undefined;
  }

  revoke(token: string): void {
    this.drop(sha256(token));
  }

  revokeAll(): void {
    this.sessions.clear();
    this.byId.clear();
  }

  /**
   * The proof token an approval carries: it names the session and is signed over that session and exactly this request, revision and digest. The page
   * session's secret never leaves the server, and a proof for one approval is no use for another. Single use is the approvers' (`approvalProofKey`).
   */
  issueProof(sessionId: string, binding: ProofBinding): string {
    return `p1.${sessionId}.${this.proofMac(sessionId, binding)}`;
  }

  /** True when the token is a proof issued here for exactly this binding, and its session is still alive. */
  verifyProof(token: string, binding: ProofBinding): boolean {
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== "p1" || parts[1] === undefined || parts[2] === undefined) return false;
    const key = this.byId.get(parts[1]);
    const session = key === undefined ? undefined : this.sessions.get(key);
    if (session === undefined || session.expiresAt <= this.now()) return false;
    const given = Buffer.from(parts[2], "utf8");
    const want = Buffer.from(this.proofMac(parts[1], binding), "utf8");
    return given.length === want.length && timingSafeEqual(given, want);
  }

  private proofMac(sessionId: string, binding: ProofBinding): string {
    return createHmac("sha256", this.proofKey).update(JSON.stringify(["local-session", sessionId, binding.requestId, binding.revision, binding.artifactDigest])).digest("base64url");
  }

  private drop(key: string): void {
    const session = this.sessions.get(key);
    if (session !== undefined) this.byId.delete(session.id);
    this.sessions.delete(key);
  }

  private sweep(): void {
    const now = this.now();
    for (const [key, session] of this.sessions) if (session.expiresAt <= now) this.drop(key);
  }
}

// ---- the request checks

export interface RequestFacts {
  method: string | undefined;
  host: string | undefined;
  origin: string | undefined;
  referer: string | undefined;
  secFetchSite: string | undefined;
  remoteAddress: string | undefined;
  contentType: string | undefined;
  expectedOrigin: string;
}

export interface Refusal {
  status: number;
  /** For a test or a debug line; never sent to the browser with the token or path in it. */
  reason: string;
}

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::ffff:127.0.0.1", "::1"]);

/** Checks 1 to 4, in the order that makes the cheapest refusal first. Writes are the methods other than GET and HEAD. */
export function refuseRequest(facts: RequestFacts): Refusal | undefined {
  if (facts.method !== "GET" && facts.method !== "HEAD" && facts.method !== "POST") return { status: 405, reason: "method" };
  const expectedHost = facts.expectedOrigin.slice("http://".length);
  if (facts.host !== expectedHost) return { status: 421, reason: "wrong Host" };
  if (facts.remoteAddress === undefined || !LOOPBACK_ADDRESSES.has(facts.remoteAddress)) return { status: 403, reason: "not loopback" };
  if (facts.secFetchSite !== undefined && facts.secFetchSite !== "same-origin" && facts.secFetchSite !== "none") return { status: 403, reason: "cross-site request" };
  if (facts.origin !== undefined && facts.origin !== facts.expectedOrigin) return { status: 403, reason: "wrong Origin" };
  if (facts.referer !== undefined) {
    let refererOrigin: string;
    try {
      refererOrigin = new URL(facts.referer).origin;
    } catch {
      return { status: 403, reason: "unreadable Referer" };
    }
    if (refererOrigin !== facts.expectedOrigin) return { status: 403, reason: "wrong Referer" };
  }
  if (facts.method === "POST") {
    if (facts.origin !== facts.expectedOrigin) return { status: 403, reason: "a write needs this Origin" };
    if ((facts.contentType ?? "").split(";")[0]?.trim().toLowerCase() !== "application/x-www-form-urlencoded") return { status: 415, reason: "content type" };
  }
  return undefined;
}

// ---- form tokens

/** What a form token binds. Every field is exactly what the page showed. */
export interface FormBinding {
  sessionId: string;
  action: string;
  taskId?: string;
  requestId?: string;
  revision?: number;
  artifactDigest?: string;
  /** A lesson, a mockup or a comment target the action names. */
  subject?: string;
}

const bindingText = (binding: FormBinding, expiresAt: number): string =>
  JSON.stringify([binding.sessionId, binding.action, binding.taskId ?? "", binding.requestId ?? "", binding.revision ?? -1, binding.artifactDigest ?? "", binding.subject ?? "", expiresAt]);

export class FormTokens {
  /** Tokens already used, with the time each stops being good anyway. A form is answered once: a second click or a replay is refused. */
  private readonly used = new Map<string, number>();

  constructor(private readonly key: Buffer = randomBytes(32), private readonly now: () => number = Date.now) {}

  /** Marks a verified token as used. False when it was already used. */
  consume(token: string): boolean {
    const now = this.now();
    for (const [used, expiresAt] of this.used) if (expiresAt <= now) this.used.delete(used);
    if (this.used.has(token)) return false;
    const dot = token.indexOf(".");
    this.used.set(token, Number(token.slice(0, dot)));
    return true;
  }

  issue(binding: FormBinding): string {
    const expiresAt = this.now() + FORM_TOKEN_TTL_MS;
    // Each form is its own: the nonce makes two forms for the same content different tokens, so one being used does not use the other.
    const nonce = randomBytes(9).toString("base64url");
    return `${expiresAt}.${nonce}.${this.mac(binding, expiresAt, nonce)}`;
  }

  /** True only when the token was issued for exactly this binding and has not expired. */
  verify(token: string | undefined, binding: FormBinding): boolean {
    if (token === undefined) return false;
    const [expires, nonce, mac, ...extra] = token.split(".");
    if (expires === undefined || nonce === undefined || mac === undefined || extra.length > 0) return false;
    const expiresAt = Number(expires);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= this.now()) return false;
    const given = Buffer.from(mac, "utf8");
    const want = Buffer.from(this.mac(binding, expiresAt, nonce), "utf8");
    return given.length === want.length && timingSafeEqual(given, want);
  }

  private mac(binding: FormBinding, expiresAt: number, nonce: string): string {
    return createHmac("sha256", this.key).update(`${bindingText(binding, expiresAt)}\0${nonce}`).digest("base64url");
  }
}

// ---- failed attempts

/** Counts requests that named a session that does not exist. Past the limit each such request is answered 429 until the window ends; a good token is never affected. */
export class FailureLimiter {
  private count = 0;
  private windowStart = 0;

  constructor(private readonly limit = 60, private readonly windowMs = 60_000, private readonly now: () => number = Date.now) {}

  /** Records a failure and says whether further requests should now be refused for a while. */
  failed(): boolean {
    const now = this.now();
    if (now - this.windowStart >= this.windowMs) {
      this.windowStart = now;
      this.count = 0;
    }
    this.count += 1;
    return this.count > this.limit;
  }

}
