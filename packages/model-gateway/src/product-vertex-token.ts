// Short-lived Google access tokens for the Vertex product route (DEC 229b; DEC 174: Google's token hosts are not model hosts).
//
// Federation (no stored secret):
//   1. AWS STS AssumeRole on Rovara's federation role with RoleSessionName = the COMPANY id (from the key-store row, which the
//      route found from the verified task token; never from the request). The session ARN is
//      arn:aws:sts::<account>:assumed-role/<role>/<company>.
//   2. Sign (never send) an AWS GetCallerIdentity request with that session: the "subject token". Google sends it to AWS to
//      learn who is calling, and the customer's pool condition checks the ARN.
//   3. Exchange it at sts.googleapis.com/v1/token for a federated access token; optionally exchange that at
//      iamcredentials.googleapis.com for a service-account token (impersonation).
// Key file (fallback): sign an RS256 JWT with the stored service-account key and exchange it at oauth2.googleapis.com/token.
//
// Tokens are cached per key-store row (install, company, owner, source, version) until 5 minutes before they expire; AWS
// sessions per company the same way. The connect-time probe checks the pool refuses a canary company. Results carry fixed
// words only: no Google or AWS text, no key, no token in an error.
import { createSign, randomBytes } from "node:crypto";
import https from "node:https";
import type { ClientRequest } from "node:http";
import { signRequest, type AwsCredentials, type CredentialSource } from "./aws.js";
import { COMPANY, whole } from "./model-gateway-token.js";
import type { ProductKeyRow } from "./product-seal.js";
import { GOOGLE_TOKEN_URI, type VertexCredential } from "./product-vertex-credential.js";

export const VERTEX_TOKEN_MARGIN_MS = 5 * 60_000;
/** A token that lives less than this is not worth a call (Vertex checks it when the request arrives). */
export const VERTEX_TOKEN_MIN_LIFE_MS = 60_000;
export const VERTEX_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
export const GOOGLE_STS_HOST = "sts.googleapis.com";
export const GOOGLE_IAM_CREDENTIALS_HOST = "iamcredentials.googleapis.com";
export const GOOGLE_OAUTH_HOST = "oauth2.googleapis.com";
const TOKEN_TIMEOUT_MS = 5_000;
const TOKEN_MAX_BYTES = 64 * 1024;
const MAX_CACHED = 5_000;
const SESSION_SECONDS = 3600;
const AWS_STS_HOST = /^sts\.[a-z]{2}(?:-gov)?-[a-z]+-\d\.amazonaws\.com$/u;
const ROLE_ARN = /^arn:aws(?:-us-gov)?:iam::[0-9]{12}:role\/[\w+=,.@/-]{1,128}$/u;
const AWS_REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;
const GET_CALLER_IDENTITY = "Action=GetCallerIdentity&Version=2011-06-15";

export interface TokenHttpRequest { host: string; path: string; method: "POST"; headers: Readonly<Record<string, string>>; body: Buffer; signal?: AbortSignal }
/** One POST to a token host. Injectable so tests answer with a fake Google and AWS (no socket). */
export type TokenHttp = (request: TokenHttpRequest) => Promise<{ status: number; body: Buffer }>;
const allowedHost = (host: string): boolean => host === GOOGLE_STS_HOST || host === GOOGLE_IAM_CREDENTIALS_HOST || host === GOOGLE_OAUTH_HOST || AWS_STS_HOST.test(host);

/** Fixed token hosts only, TLS on 443, no connection reuse, one attempt, no redirect following, bounded answer and time. */
export function createTokenHttp(request?: typeof https.request): TokenHttp {
  return (input) => new Promise((resolve, reject) => {
    if (!allowedHost(input.host) || !input.path.startsWith("/") || input.signal?.aborted === true) { reject(new Error("token host refused")); return; }
    let settled = false;
    const done = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(timer); input.signal?.removeEventListener("abort", abort); fn(); } };
    const fail = () => done(() => reject(new Error("token request failed")));
    let call: ClientRequest;
    try {
      call = (request ?? https.request)({ hostname: input.host, port: 443, path: input.path, method: "POST", agent: false, rejectUnauthorized: true, headers: { ...input.headers, "content-length": String(input.body.byteLength) } }, (response) => {
        const chunks: Buffer[] = []; let size = 0;
        response.on("data", (chunk: Buffer) => { size += chunk.byteLength; if (size > TOKEN_MAX_BYTES) { response.destroy(); fail(); return; } chunks.push(chunk); });
        response.once("end", () => done(() => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) })));
        response.once("error", fail);
      });
    } catch { reject(new Error("token request failed")); return; }
    const abort = () => { call.destroy(); fail(); };
    const timer = setTimeout(abort, TOKEN_TIMEOUT_MS);
    input.signal?.addEventListener("abort", abort, { once: true });
    call.once("error", fail);
    try { call.end(input.body); } catch { abort(); }
  });
}

export type MintResult = { ok: true; token: string; expiresAt: number } | { ok: false; reason: "refused" | "unavailable" };
export type ProbeResult = "ok" | "too_open" | "refused" | "unavailable";
/** What the route needs (VertexTokens implements it). */
export interface VertexTokenSource {
  token(row: ProductKeyRow, credential: VertexCredential, signal?: AbortSignal): Promise<MintResult>;
  forget(row: ProductKeyRow): void;
}
export interface VertexTokensOptions {
  http: TokenHttp;
  /** The gateway's own AWS credentials (the task role), used only to assume the federation role. */
  aws: CredentialSource;
  /** Rovara's federation role. Its trust policy lets only the gateway's role assume it, with an `org_*` session name. */
  federationRoleArn: string;
  awsRegion: string;
  now?: () => number;
  /** The canary company for the probe (tests); default: a random, well-formed company id. */
  canaryCompany?: () => string;
}
const UNAVAILABLE: MintResult = { ok: false, reason: "unavailable" };
const REFUSED: MintResult = { ok: false, reason: "refused" };
/** A Google token host's refusal (bad audience, condition, grant, permission) is the customer's setup; anything else is an outage. */
const googleRefusal = (status: number): boolean => status === 400 || status === 401 || status === 403 || status === 404;
const form = (fields: Record<string, string>): Buffer => Buffer.from(new URLSearchParams(fields).toString());
const parse = (body: Buffer): Record<string, unknown> | undefined => { try { const v = JSON.parse(body.toString("utf8")) as unknown; return typeof v === "object" && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : undefined; } catch { return undefined; } };
const TOKEN_TEXT = /^[\x21-\x7e]{16,4096}$/u;
const b64url = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
function evict<K, V>(map: Map<K, V>): void { while (map.size >= MAX_CACHED) { const first = map.keys().next(); if (first.done === true) return; map.delete(first.value); } }
function xmlOnce(text: string, tag: string): string | undefined {
  const all = [...text.matchAll(new RegExp(`<${tag}>([^<]{1,8192})</${tag}>`, "gu"))];
  return all.length === 1 ? all[0]![1] : undefined;
}

export class VertexTokens implements VertexTokenSource {
  readonly #options: VertexTokensOptions;
  readonly #now: () => number;
  readonly #stsHost: string;
  readonly #tokens = new Map<string, { token: string; expiresAt: number }>();
  readonly #pending = new Map<string, Promise<MintResult>>();
  readonly #sessions = new Map<string, AwsCredentials>();
  readonly #sessionPending = new Map<string, Promise<AwsCredentials | undefined>>();
  constructor(options: VertexTokensOptions) {
    if (!ROLE_ARN.test(options.federationRoleArn) || !AWS_REGION.test(options.awsRegion)) throw new Error("invalid vertex token options");
    this.#options = options; this.#now = options.now ?? Date.now; this.#stsHost = `sts.${options.awsRegion}.amazonaws.com`;
  }

  /** A token for the key-store row's credential. Cached per row until 5 minutes before expiry; refusals are never cached. */
  async token(row: ProductKeyRow, credential: VertexCredential): Promise<MintResult> {
    if (!COMPANY.test(row.cid)) return UNAVAILABLE;
    const key = JSON.stringify([row.iss, row.cid, row.owner, row.sourceId, row.versionId]);
    const cached = this.#tokens.get(key);
    if (cached !== undefined && cached.expiresAt - VERTEX_TOKEN_MARGIN_MS > this.#now()) return { ok: true, ...cached };
    const running = this.#pending.get(key);
    if (running !== undefined) return running;
    const minting = (async () => {
      try {
        // Shared by every concurrent caller of this row, so no one caller's abort stops it (each token call has its own 5 s bound).
        const result = await this.#mint(row.cid, credential);
        if (result.ok && result.expiresAt - VERTEX_TOKEN_MARGIN_MS > this.#now()) { evict(this.#tokens); this.#tokens.set(key, { token: result.token, expiresAt: result.expiresAt }); }
        return result;
      } catch { return UNAVAILABLE; } finally { this.#pending.delete(key); }
    })();
    this.#pending.set(key, minting);
    return minting;
  }
  forget(row: ProductKeyRow): void { this.#tokens.delete(JSON.stringify([row.iss, row.cid, row.owner, row.sourceId, row.versionId])); }

  /**
   * The connection test, before a credential is saved. A key file must mint a token. A federation setup must mint one for the
   * company AND must refuse a canary company: a pool whose condition lets another Rovara company through is "too_open".
   * Nothing is cached.
   */
  async probe(cid: string, credential: VertexCredential, signal?: AbortSignal): Promise<ProbeResult> {
    if (!COMPANY.test(cid)) return "unavailable";
    try {
      const real = await this.#mint(cid, credential, signal);
      if (!real.ok) return real.reason;
      if (credential.scheme !== "federation") return "ok";
      let canary = this.#options.canaryCompany?.() ?? `org_${[...randomBytes(20)].map((b) => "0123456789abcdefghijklmnopqrstuvwxyz"[b % 36]).join("")}`;
      if (canary === cid || !COMPANY.test(canary)) canary = `org_${"0".repeat(19)}${cid.endsWith("0") ? "1" : "0"}`;
      // Only the exchange: the pool's condition is what must refuse another company.
      const session = await this.#session(canary, signal, false);
      if (session === undefined) return "unavailable";
      const exchanged = await this.#exchange(session, credential.audience, signal);
      return exchanged.ok ? "too_open" : exchanged.reason === "refused" ? "ok" : "unavailable";
    } catch { return "unavailable"; }
  }

  async #mint(cid: string, credential: VertexCredential, signal?: AbortSignal): Promise<MintResult> {
    if (credential.scheme === "service_account_key") return this.#keyFile(credential, signal);
    const session = await this.#session(cid, signal, true);
    if (session === undefined) return UNAVAILABLE;
    const federated = await this.#exchange(session, credential.audience, signal);
    if (!federated.ok || credential.serviceAccount === undefined) return federated;
    return this.#impersonate(federated.token, credential.serviceAccount, signal);
  }
  /** AssumeRole with the company as session name. Cached per company (never shared across companies) unless `cache` is false. */
  async #session(cid: string, signal: AbortSignal | undefined, cache: boolean): Promise<AwsCredentials | undefined> {
    if (!COMPANY.test(cid)) return undefined;
    if (cache) {
      const known = this.#sessions.get(cid);
      if (known !== undefined && (known.expiresAt ?? 0) - VERTEX_TOKEN_MARGIN_MS > this.#now()) return known;
      const running = this.#sessionPending.get(cid);
      if (running !== undefined) return running;
    }
    const assume = (async (): Promise<AwsCredentials | undefined> => {
      let base: AwsCredentials;
      try { base = await this.#options.aws(); } catch { return undefined; }
      const body = form({ Action: "AssumeRole", Version: "2011-06-15", RoleArn: this.#options.federationRoleArn, RoleSessionName: cid, DurationSeconds: String(SESSION_SECONDS) });
      const headers = signRequest({ method: "POST", host: this.#stsHost, region: this.#options.awsRegion, service: "sts", headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" }, body, credentials: base, now: new Date(this.#now()) });
      let answer: { status: number; body: Buffer };
      try { answer = await this.#options.http({ host: this.#stsHost, path: "/", method: "POST", headers, body, ...(signal === undefined ? {} : { signal }) }); } catch { return undefined; }
      if (answer.status !== 200 || answer.body.byteLength > TOKEN_MAX_BYTES) return undefined;
      const text = answer.body.toString("utf8");
      const accessKeyId = xmlOnce(text, "AccessKeyId"); const secretAccessKey = xmlOnce(text, "SecretAccessKey"); const sessionToken = xmlOnce(text, "SessionToken"); const expiration = xmlOnce(text, "Expiration");
      const expiresAt = expiration === undefined ? NaN : Date.parse(expiration);
      if (accessKeyId === undefined || secretAccessKey === undefined || sessionToken === undefined || !Number.isFinite(expiresAt) || !/^[A-Z0-9]{16,128}$/u.test(accessKeyId)) return undefined;
      const credentials: AwsCredentials = { accessKeyId, secretAccessKey, sessionToken, expiresAt };
      if (cache && expiresAt - VERTEX_TOKEN_MARGIN_MS > this.#now()) { evict(this.#sessions); this.#sessions.set(cid, credentials); }
      return credentials;
    })();
    if (!cache) return assume;
    const tracked = assume.finally(() => this.#sessionPending.delete(cid));
    this.#sessionPending.set(cid, tracked);
    return tracked;
  }
  /** The AWS subject token (Google: a serialized signed GetCallerIdentity request, URL-encoded JSON) exchanged at Google STS. */
  async #exchange(session: AwsCredentials, audience: string, signal?: AbortSignal): Promise<MintResult> {
    const signed = signRequest({ method: "POST", host: this.#stsHost, region: this.#options.awsRegion, service: "sts", query: GET_CALLER_IDENTITY, headers: { "x-goog-cloud-target-resource": audience }, body: Buffer.alloc(0), credentials: session, now: new Date(this.#now()) });
    const subject = encodeURIComponent(JSON.stringify({ url: `https://${this.#stsHost}?${GET_CALLER_IDENTITY}`, method: "POST", headers: Object.entries(signed).map(([key, value]) => ({ key: key === "authorization" ? "Authorization" : key, value })) }));
    const body = form({ grant_type: "urn:ietf:params:oauth:grant-type:token-exchange", audience, scope: VERTEX_SCOPE, requested_token_type: "urn:ietf:params:oauth:token-type:access_token", subject_token: subject, subject_token_type: "urn:ietf:params:aws:token-type:aws4_request" });
    return this.#tokenCall({ host: GOOGLE_STS_HOST, path: "/v1/token", headers: { "content-type": "application/x-www-form-urlencoded" }, body }, signal, (a) => (typeof a.access_token === "string" && a.token_type === "Bearer" && whole(a.expires_in) ? { token: a.access_token, lifeMs: a.expires_in * 1000 } : undefined));
  }
  async #impersonate(federated: string, serviceAccount: string, signal?: AbortSignal): Promise<MintResult> {
    const body = Buffer.from(JSON.stringify({ scope: [VERTEX_SCOPE], lifetime: "3600s" }));
    return this.#tokenCall({ host: GOOGLE_IAM_CREDENTIALS_HOST, path: `/v1/projects/-/serviceAccounts/${encodeURIComponent(serviceAccount)}:generateAccessToken`, headers: { "content-type": "application/json", authorization: `Bearer ${federated}` }, body }, signal, (a) => {
      const at = typeof a.expireTime === "string" ? Date.parse(a.expireTime) : NaN;
      return typeof a.accessToken === "string" && Number.isFinite(at) ? { token: a.accessToken, lifeMs: at - this.#now() } : undefined;
    });
  }
  async #keyFile(credential: Extract<VertexCredential, { scheme: "service_account_key" }>, signal?: AbortSignal): Promise<MintResult> {
    const iat = Math.floor(this.#now() / 1000);
    const unsigned = `${b64url({ alg: "RS256", typ: "JWT", kid: credential.privateKeyId })}.${b64url({ iss: credential.clientEmail, scope: VERTEX_SCOPE, aud: GOOGLE_TOKEN_URI, iat, exp: iat + 3600 })}`;
    let signature: string;
    try { signature = createSign("RSA-SHA256").update(unsigned).sign(credential.privateKey).toString("base64url"); } catch { return UNAVAILABLE; }
    const body = form({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` });
    return this.#tokenCall({ host: GOOGLE_OAUTH_HOST, path: "/token", headers: { "content-type": "application/x-www-form-urlencoded" }, body }, signal, (a) => (typeof a.access_token === "string" && whole(a.expires_in) ? { token: a.access_token, lifeMs: a.expires_in * 1000 } : undefined));
  }
  async #tokenCall(request: Omit<TokenHttpRequest, "method" | "signal">, signal: AbortSignal | undefined, read: (answer: Record<string, unknown>) => { token: string; lifeMs: number } | undefined): Promise<MintResult> {
    let answer: { status: number; body: Buffer };
    try { answer = await this.#options.http({ ...request, method: "POST", ...(signal === undefined ? {} : { signal }) }); } catch { return UNAVAILABLE; }
    if (answer.status !== 200) return googleRefusal(answer.status) ? REFUSED : UNAVAILABLE;
    const parsed = parse(answer.body); const got = parsed === undefined ? undefined : read(parsed);
    if (got === undefined || !TOKEN_TEXT.test(got.token) || !Number.isFinite(got.lifeMs) || got.lifeMs < VERTEX_TOKEN_MIN_LIFE_MS || got.lifeMs > 12 * 3600_000) return UNAVAILABLE;
    return { ok: true, token: got.token, expiresAt: this.#now() + got.lifeMs };
  }
}
