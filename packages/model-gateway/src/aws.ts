import { createHash, createHmac } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { record } from "./model-gateway-token.js";

/**
 * A small AWS JSON-protocol client on node: built-ins only (the gateway image holds no node_modules, see
 * environments/model-gateway/Dockerfile): Signature Version 4, credentials from the ECS task role (or the environment for a
 * local run), one POST per call. It never logs, and its errors carry a fixed message and the AWS error name only, never the
 * service's message text, a request body or a credential.
 */

export interface AwsCredentials { accessKeyId: string; secretAccessKey: string; sessionToken?: string; expiresAt?: number }
export type CredentialSource = () => Promise<AwsCredentials>;
export interface WireRequest { url: string; headers: Readonly<Record<string, string>>; body: Buffer; timeoutMs: number; maxBytes: number; signal?: AbortSignal }
export interface WireResponse { status: number; body: Buffer }
/** The HTTP exchange, injectable so tests answer at the wire (signed headers and JSON bytes) with no socket. */
export type WireTransport = (request: WireRequest) => Promise<WireResponse>;

/** The service answered with an error: nothing was applied (DynamoDB and Secrets Manager apply a call whole or not at all). */
export class AwsError extends Error {
  constructor(readonly code: string, readonly status: number, readonly reasons: readonly string[] = []) { super("aws request refused"); this.name = "AwsError"; }
}
/** The outcome is not known: the request may or may not have been applied (timeout, cut connection, 5xx). */
export class AwsUnknownError extends Error {
  constructor() { super("aws request outcome unknown"); this.name = "AwsUnknownError"; }
}
/** Not sent: no credentials, a bad endpoint, or the caller stopped before the request left. */
export class AwsNotSentError extends Error {
  constructor() { super("aws request not sent"); this.name = "AwsNotSentError"; }
}

export const AWS_CALL_TIMEOUT_MS = 5_000;
export const AWS_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const CREDENTIAL_REFRESH_MARGIN_MS = 5 * 60_000;
const ECS_CREDENTIALS_HOST = "169.254.170.2";

const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string): Buffer => createHmac("sha256", key).update(data).digest();

/**
 * AWS Signature Version 4 for a POST to "/" (every JSON-protocol call has no query string). `query`, when given, must already
 * be canonical (sorted, encoded): the Vertex subject token signs `Action=GetCallerIdentity&Version=2011-06-15`. `path`, when
 * given, is the request path exactly as sent (already URI-encoded, e.g. a Bedrock model id's ":" as %3A); as for every service
 * but S3, each segment is encoded once more in the canonical path (the SDK signers' uriEscapePath). Returns the headers to send.
 */
export function signRequest(input: { method: "POST"; host: string; region: string; service: string; headers: Readonly<Record<string, string>>; body: Buffer; credentials: AwsCredentials; now: Date; query?: string; path?: string }): Record<string, string> {
  const amzDate = input.now.toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}/u, "");
  const date = amzDate.slice(0, 8);
  const headers: Record<string, string> = { ...Object.fromEntries(Object.entries(input.headers).map(([k, v]) => [k.toLowerCase(), v])), host: input.host, "x-amz-date": amzDate };
  if (input.credentials.sessionToken !== undefined) headers["x-amz-security-token"] = input.credentials.sessionToken;
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((name) => `${name}:${headers[name]!.trim().replace(/\s+/gu, " ")}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalPath = input.path === undefined ? "/" : input.path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  const canonical = [input.method, canonicalPath, input.query ?? "", canonicalHeaders, signedHeaders, sha256(input.body)].join("\n");
  const scope = `${date}/${input.region}/${input.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${input.credentials.secretAccessKey}`, date), input.region), input.service), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}

function validCredentials(value: unknown): AwsCredentials | undefined {
  const v = record(value);
  if (v === undefined || typeof v.AccessKeyId !== "string" || typeof v.SecretAccessKey !== "string" || v.AccessKeyId.length === 0 || v.SecretAccessKey.length === 0) return undefined;
  if (v.AccessKeyId.length > 256 || v.SecretAccessKey.length > 256 || (v.Token !== undefined && (typeof v.Token !== "string" || v.Token.length > 8192))) return undefined;
  const expiresAt = typeof v.Expiration === "string" ? Date.parse(v.Expiration) : NaN;
  if (!Number.isFinite(expiresAt)) return undefined;
  return { accessKeyId: v.AccessKeyId, secretAccessKey: v.SecretAccessKey, ...(typeof v.Token === "string" ? { sessionToken: v.Token } : {}), expiresAt };
}

/** One bounded GET to the ECS agent's link-local credentials address. No redirects, no retries here. */
export type CredentialsFetch = (path: string, timeoutMs: number) => Promise<{ status: number; body: Buffer }>;
export const ecsCredentialsFetch = (request: typeof http.request = http.request): CredentialsFetch => (path, timeoutMs) => new Promise((resolve, reject) => {
  const call = request({ host: ECS_CREDENTIALS_HOST, port: 80, path, method: "GET", agent: false, timeout: timeoutMs }, (response) => {
    const chunks: Buffer[] = []; let size = 0;
    response.on("data", (chunk: Buffer) => { size += chunk.byteLength; if (size > 65536) { response.destroy(); reject(new AwsNotSentError()); return; } chunks.push(chunk); });
    response.once("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) }));
    response.once("error", () => reject(new AwsNotSentError()));
  });
  call.once("timeout", () => call.destroy());
  call.once("error", () => reject(new AwsNotSentError()));
  call.end();
});

/**
 * The task role's credentials (AWS_CONTAINER_CREDENTIALS_RELATIVE_URI, set by ECS), refreshed five minutes before they
 * expire and fetched once at a time; or, for a local run only, the static AWS_ACCESS_KEY_ID pair from the environment.
 */
export function credentialsFromEnvironment(env: Readonly<Record<string, string | undefined>>, options: { fetch?: CredentialsFetch; now?: () => number } = {}): CredentialSource {
  const now = options.now ?? Date.now;
  const relative = env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
  if (relative !== undefined && relative !== "") {
    if (!/^\/[A-Za-z0-9/_.?=&-]{1,512}$/u.test(relative)) return () => Promise.reject(new AwsNotSentError());
    const fetchCredentials = options.fetch ?? ecsCredentialsFetch();
    let cached: AwsCredentials | undefined; let pending: Promise<AwsCredentials> | undefined;
    return async () => {
      if (cached !== undefined && (cached.expiresAt ?? 0) - CREDENTIAL_REFRESH_MARGIN_MS > now()) return cached;
      pending ??= (async () => {
        try {
          const response = await fetchCredentials(relative, 2_000);
          let parsed: unknown; try { parsed = JSON.parse(response.body.toString("utf8")) as unknown; } catch { throw new AwsNotSentError(); }
          const credentials = response.status === 200 ? validCredentials(parsed) : undefined;
          if (credentials === undefined) throw new AwsNotSentError();
          cached = credentials; return credentials;
        } catch { throw new AwsNotSentError(); }
        finally { pending = undefined; }
      })();
      return pending;
    };
  }
  const id = env.AWS_ACCESS_KEY_ID; const secret = env.AWS_SECRET_ACCESS_KEY; const token = env.AWS_SESSION_TOKEN;
  if (id === undefined || secret === undefined || id === "" || secret === "") return () => Promise.reject(new AwsNotSentError());
  const credentials: AwsCredentials = { accessKeyId: id, secretAccessKey: secret, ...(token === undefined || token === "" ? {} : { sessionToken: token }) };
  return () => Promise.resolve(credentials);
}

/** The production transport: TLS (or plain HTTP to a loopback endpoint, for DynamoDB Local), one attempt, bounded body and time. */
export function nodeWireTransport(): WireTransport {
  const agents = { "https:": new https.Agent({ keepAlive: true, maxSockets: 128 }), "http:": new http.Agent({ keepAlive: true, maxSockets: 32 }) };
  return (input) => new Promise<WireResponse>((resolve, reject) => {
    let url: URL;
    try { url = new URL(input.url); } catch { reject(new AwsNotSentError()); return; }
    const secure = url.protocol === "https:";
    if (!secure && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) { reject(new AwsNotSentError()); return; }
    if (input.signal?.aborted) { reject(new AwsNotSentError()); return; }
    let written = false; let settled = false;
    const fail = (error: Error) => { if (!settled) { settled = true; cleanup(); reject(error); } };
    const unknownOrNotSent = () => fail(written ? new AwsUnknownError() : new AwsNotSentError());
    const send = secure ? https.request : http.request;
    const call = send({ protocol: url.protocol, hostname: url.hostname.replace(/^\[|\]$/gu, ""), port: url.port === "" ? undefined : Number(url.port), path: "/", method: "POST", agent: agents[secure ? "https:" : "http:"], headers: { ...input.headers, "content-length": String(input.body.byteLength) }, ...(secure ? { rejectUnauthorized: true } : {}) }, (response) => {
      const chunks: Buffer[] = []; let size = 0;
      response.on("data", (chunk: Buffer) => { size += chunk.byteLength; if (size > input.maxBytes) { response.destroy(); fail(new AwsUnknownError()); return; } chunks.push(chunk); });
      response.once("end", () => { if (!settled) { settled = true; cleanup(); resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) }); } });
      response.once("error", () => fail(new AwsUnknownError()));
    });
    const timer = setTimeout(() => { call.destroy(); unknownOrNotSent(); }, input.timeoutMs);
    const abort = () => { call.destroy(); unknownOrNotSent(); };
    const cleanup = () => { clearTimeout(timer); input.signal?.removeEventListener("abort", abort); };
    input.signal?.addEventListener("abort", abort, { once: true });
    call.once("error", unknownOrNotSent);
    call.end(input.body, () => { written = true; });
  });
}

export interface AwsJsonClientOptions {
  region: string; service: "dynamodb" | "secretsmanager" | "kms"; targetPrefix: string; contentType: string;
  credentials: CredentialSource; transport?: WireTransport; endpoint?: string; now?: () => number;
}
export interface AwsCallOptions { signal?: AbortSignal; timeoutMs?: number; maxBytes?: number }

/** One service, one region. A call returns the parsed JSON answer or throws AwsError / AwsUnknownError / AwsNotSentError. */
export class AwsJsonClient {
  readonly #options: AwsJsonClientOptions;
  readonly #transport: WireTransport;
  readonly #url: URL;
  constructor(options: AwsJsonClientOptions) {
    if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u.test(options.region)) throw new Error("invalid aws region");
    this.#options = options; this.#transport = options.transport ?? nodeWireTransport();
    this.#url = new URL(options.endpoint ?? `https://${options.service}.${options.region}.amazonaws.com/`);
  }
  async call(operation: string, input: unknown, options: AwsCallOptions = {}): Promise<Record<string, unknown>> {
    if (!/^[A-Za-z]{1,64}$/u.test(operation)) throw new AwsNotSentError();
    if (options.signal?.aborted) throw new AwsNotSentError();
    let credentials: AwsCredentials;
    try { credentials = await this.#options.credentials(); } catch { throw new AwsNotSentError(); }
    const body = Buffer.from(JSON.stringify(input));
    const headers = signRequest({
      method: "POST", host: this.#url.host, region: this.#options.region, service: this.#options.service, body, credentials,
      headers: { "content-type": this.#options.contentType, "x-amz-target": `${this.#options.targetPrefix}.${operation}` },
      now: new Date((this.#options.now ?? Date.now)()),
    });
    const response = await this.#transport({ url: this.#url.href, headers, body, timeoutMs: options.timeoutMs ?? AWS_CALL_TIMEOUT_MS, maxBytes: options.maxBytes ?? AWS_MAX_RESPONSE_BYTES, ...(options.signal === undefined ? {} : { signal: options.signal }) });
    let parsed: unknown;
    try { parsed = response.body.byteLength === 0 ? {} : JSON.parse(response.body.toString("utf8")) as unknown; } catch { parsed = undefined; }
    const answer = record(parsed);
    if (response.status === 200) { if (answer === undefined) throw new AwsUnknownError(); return answer; }
    // A 5xx (or an unreadable answer) may follow an applied write: its outcome is unknown.
    if (response.status >= 500 || answer === undefined) throw new AwsUnknownError();
    const rawType = typeof answer.__type === "string" ? answer.__type : "";
    const code = (rawType.split("#").at(-1) ?? "").replace(/[^A-Za-z]/gu, "").slice(0, 64) || "UnknownError";
    const reasons = Array.isArray(answer.CancellationReasons) ? answer.CancellationReasons.slice(0, 100).map((reason) => { const c = record(reason)?.Code; return typeof c === "string" ? c.replace(/[^A-Za-z]/gu, "").slice(0, 64) : "None"; }) : [];
    throw new AwsError(code, response.status, reasons);
  }
}

/** Retryable without changing the result: throttling and capacity refusals apply nothing. */
export function throttled(error: unknown): boolean {
  return error instanceof AwsError && ["ThrottlingException", "ProvisionedThroughputExceededException", "RequestLimitExceeded", "LimitExceededException", "InternalServerError"].includes(error.code);
}
