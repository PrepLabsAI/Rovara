// Port lane L9a, K1: the local model proxy (provisional, owner decision 58; see docs/ports.md).
//
// The coding worker runs in a container and must never hold a model key: it is code a repository can drive. This proxy runs inside the broker, on
// the callback listener a worker reaches only through its own egress gateway (callback-server.ts, isolation/egress-gateway-source.ts), and does what Cloud's
// model proxy does for Code's one company:
//   1. `GET /v1/internal/model-access` (the route the worker already calls): the worker shows its callback capability and gets a short-lived token
//      that is good for this one proxy, this one workspace and this one operation, and only for the models the broker chose for it. No key.
//   2. `POST /v1/internal/model-proxy/v1/{messages,responses,chat/completions}`: the worker's model calls, authenticated by that token. The proxy checks
//      the token, its workspace and that the operation still runs, the model and the request's fields (Cloud's guard rules), the task budget; then reads the
//      real key from the `model-keys` port, calls the provider with it, passes the answer back, and records what the call used through the `metering` port.
// The key is a `SecretValue` until the moment the provider's request header is built. It is not logged, not stored, not put in any answer, and an answer
// that contains it is cut off. A provider's error text is never passed on as it came (OpenAI's 401 repeats part of the key); it is shortened and scrubbed.
// Not here: Bedrock (it needs the computer's AWS sign-in; listed as a decision 51 gap) and design-review key slots.
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { TASK_BUDGET_EXCEEDED_PREFIX, type AgentXError, type Cost, type Metering, type ModelKeyStore } from "@agentx/contracts";
import type { BrokerResponse } from "../../handler.js";
import {
  DEFAULT_PROVIDER_ENDPOINTS, PROXY_PATH_API, RequestNotAllowed, checkRequestBody, checkRequestHeaders, upstreamUrl, type ProviderEndpoints,
} from "./providers.js";
import { ModelTokenBook } from "./tokens.js";
import type { ModelGrantSource, ModelProxyEvent, ProxyApi, ProxyProvider, ProxyRoute } from "./types.js";
import { UsageCollector } from "./usage.js";

export const MODEL_ACCESS_PATH = "/v1/internal/model-access";
export const MODEL_PROXY_PREFIX = "/v1/internal/model-proxy";
/** Stamped on every call by the worker's own egress gateway (and cleared of whatever the worker sent): the workspace the call really comes from. */
export const WORKSPACE_HEADER = "x-rovara-workspace";
export const CAPABILITY_HEADER = "x-agentx-callback-capability";
export const MODEL_PROXY_REQUEST_MAX_BYTES = 8 * 1_048_576;
const WHOLE_ANSWER_MAX_BYTES = 32 * 1_048_576;
const ERROR_BODY_MAX_BYTES = 65_536;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MAX_CONCURRENT = 8;
const ANTHROPIC_VERSION = "2023-06-01";

export interface LocalModelProxyOptions {
  /** Where the real keys are (the `model-keys` port). Read per call; never kept. */
  keys: ModelKeyStore;
  /** Prices and records what each call used (the `metering` port). */
  metering: Metering;
  companyId: string;
  grants: ModelGrantSource;
  /** The address the worker is told to call: its egress gateway's name for the broker, plus `MODEL_PROXY_PREFIX`. */
  workerUrl: string;
  /** Where each provider is. Absent: the providers' own addresses. Tests point these at a fake provider. */
  endpoints?: Partial<ProviderEndpoints> | undefined;
  fetch?: typeof fetch | undefined;
  now?: (() => number) | undefined;
  ttlSeconds?: number | undefined;
  /** Told, in fixed words, what happened. Never given a key, a token, a header or a body. */
  onEvent?: ((event: ModelProxyEvent) => void) | undefined;
  requestTimeoutMs?: number | undefined;
  /** Calls one operation may have running at once. Default 8. */
  maxConcurrentPerOperation?: number | undefined;
}

export interface LocalModelProxy {
  readonly tokens: ModelTokenBook;
  /** `GET /v1/internal/model-access`. */
  access(request: { path: string; headers: Readonly<Record<string, string | undefined>> }): Promise<BrokerResponse>;
  /** `POST /v1/internal/model-proxy/...`: writes the whole answer, streamed. Never throws. */
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>;
}

class Refusal extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly headers: Record<string, string> = {}) {
    super(message);
    this.name = "Refusal";
  }
}

const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" } as const;

/** The refusal body. It reads as an Anthropic error (`type: "error"`) and as an OpenAI one (`error.message/type/code`), so either client shows the words. */
function refusalBody(code: string, message: string, type = "invalid_request_error"): string {
  return JSON.stringify({ type: "error", error: { type, code, message } });
}

function budgetRefusal(): Refusal {
  // The shape the worker already reads as "the task's budget is spent" (budgetScopeOfProxyBody): 422, budget_exceeded, `Key=`.
  return new Refusal(422, "budget_exceeded", "Budget has been exceeded! Key=task");
}

function budgetAccessRefusal(): BrokerResponse {
  return { statusCode: 402, headers: { ...JSON_HEADERS }, body: JSON.stringify({ error: { code: "BUDGET_EXCEEDED", message: `${TASK_BUDGET_EXCEEDED_PREFIX}; raise the budget to continue.` } }) };
}

function notAllowed(message: string): BrokerResponse {
  return { statusCode: 403, headers: { ...JSON_HEADERS }, body: JSON.stringify({ error: { code: "MODEL_NOT_ALLOWED", message } }) };
}

/** Text from a provider's error that is safe to show: short, one line, with the key and anything shaped like a key removed. */
export function scrubProviderText(text: string, secret: string): string {
  let clean = text.replaceAll(/\p{Cc}+/gu, " ");
  // The key whole, then its first and last eight characters (a provider that masks a key still shows its ends), each to the end of the word.
  if (secret.length >= 6) clean = clean.split(secret).join("[secret]");
  if (secret.length >= 16) {
    const ends = [secret.slice(0, 8), secret.slice(-8)];
    clean = clean.split(/(\s+)/u).map((word) => (ends.some((end) => word.includes(end)) ? "[secret]" : word)).join("");
  }
  clean = clean.replaceAll(/\b(?:sk|rk|pk|key|rvm)[-_][A-Za-z0-9_-]{6,}/gu, "[secret]").replaceAll(/\bBearer\s+\S+/giu, "Bearer [secret]");
  return clean.trim().slice(0, 300);
}

function headerValue(headers: Readonly<Record<string, string | string[] | undefined>>, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value.join(", ") : value;
}

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) throw new Refusal(413, "request_too_large", "the request is too large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).byteLength;
    if (size > limit) throw new Refusal(413, "request_too_large", "the request is too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export function createLocalModelProxy(options: LocalModelProxyOptions): LocalModelProxy {
  const now = options.now ?? Date.now;
  const tokens = new ModelTokenBook({ now, ...(options.ttlSeconds === undefined ? {} : { ttlSeconds: options.ttlSeconds }) });
  const endpoints: ProviderEndpoints = { ...DEFAULT_PROVIDER_ENDPOINTS, ...options.endpoints };
  const transport = options.fetch ?? fetch;
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxConcurrent = options.maxConcurrentPerOperation ?? DEFAULT_MAX_CONCURRENT;
  const tell = (event: ModelProxyEvent): void => {
    try { options.onEvent?.(event); } catch { /* a listener failing changes nothing here */ }
  };

  /** Whether the cost of this route can be known, so a budget can be held. */
  async function priced(route: ProxyRoute): Promise<boolean> {
    return (await options.metering.price({ provider: route.provider, modelId: route.model, tokens: { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 } })) !== null;
  }

  async function access(request: { path: string; headers: Readonly<Record<string, string | undefined>> }): Promise<BrokerResponse> {
    const url = new URL(request.path, "http://local");
    const capability = request.headers[CAPABILITY_HEADER];
    if (url.pathname !== MODEL_ACCESS_PATH || capability === undefined || capability.length < 32 || capability.length > 8_192) {
      tell({ event: "token_refused", code: "CALLBACK_FORBIDDEN" });
      return { statusCode: 403, headers: { ...JSON_HEADERS }, body: JSON.stringify({ error: { code: "CALLBACK_FORBIDDEN", message: "a callback capability is required" } }) };
    }
    // The worker's own gateway stamps the workspace the call comes from; a capability is good only for its own workspace's worker.
    if (request.headers[WORKSPACE_HEADER] === undefined) {
      tell({ event: "token_refused", code: "other_workspace" });
      return { statusCode: 403, headers: { ...JSON_HEADERS }, body: JSON.stringify({ error: { code: "CALLBACK_FORBIDDEN", message: "the call carries no workspace" } }) };
    }
    if (url.searchParams.has("slot")) return notAllowed("design-review model slots are not served on this computer yet");
    let grant;
    try {
      grant = await options.grants.grant(capability);
    } catch (error) {
      const code = (error as Partial<AgentXError>).code === "STALE_FENCE" ? "STALE_FENCE" : "CALLBACK_FORBIDDEN";
      tell({ event: "token_refused", code });
      return { statusCode: code === "STALE_FENCE" ? 409 : 403, headers: { ...JSON_HEADERS }, body: JSON.stringify({ error: { code, message: code === "STALE_FENCE" ? "this operation no longer holds its workspace" : "the callback capability is not valid for model access" } }) };
    }
    if (request.headers[WORKSPACE_HEADER] !== grant.workspaceId) {
      tell({ event: "token_refused", code: "other_workspace" });
      return { statusCode: 403, headers: { ...JSON_HEADERS }, body: JSON.stringify({ error: { code: "CALLBACK_FORBIDDEN", message: "this capability belongs to another workspace" } }) };
    }
    if (grant.routes.length === 0) return notAllowed("this task has no model it may call");
    // At least one of its models must have a key now, so a task with none ends with words that say what to do, not with a failed call later.
    const providers = [...new Set(grant.routes.map((route) => route.provider))];
    let held: Array<{ provider: ProxyProvider; has: boolean }>;
    try {
      held = await Promise.all(providers.map(async (provider) => ({ provider, has: (await options.keys.get(options.companyId, provider)) !== undefined })));
    } catch {
      // The key file could not be read (wrong mode, not JSON). The words of that error can quote the file, so none are passed on.
      return { statusCode: 503, headers: { ...JSON_HEADERS }, body: JSON.stringify({ error: { code: "MODEL_PROXY_UNAVAILABLE", message: "the model keys on this computer could not be read; check ~/.rovara/keys.json" } }) };
    }
    if (!held.some((entry) => entry.has)) return notAllowed(`no ${providers.join(" or ")} key is set on this computer; put it in ~/.rovara/keys.json or the ${providers[0]!.toUpperCase()}_API_KEY variable and restart rovara up`);
    const ledger = tokens.ledger(grant.operationId);
    if (grant.budget !== undefined && ledger.spentMicros >= grant.budget.micros) return budgetAccessRefusal();
    let minted;
    try {
      minted = tokens.mint(grant);
    } catch {
      return { statusCode: 503, headers: { ...JSON_HEADERS }, body: JSON.stringify({ error: { code: "MODEL_PROXY_UNAVAILABLE", message: "the model proxy has too many live tokens" } }) };
    }
    tell({ event: "token_minted", operationId: grant.operationId });
    return { statusCode: 200, headers: { ...JSON_HEADERS }, body: JSON.stringify({ baseUrl: options.workerUrl, apiKey: minted.token, expiresAt: minted.expiresAt }) };
  }

  function sendRefusal(response: ServerResponse, refusal: Refusal): void {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response.writeHead(refusal.status, { ...JSON_HEADERS, connection: "close", ...refusal.headers });
    response.end(refusalBody(refusal.code, refusal.message, refusal.code === "budget_exceeded" ? "budget_exceeded" : undefined));
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let operationId: string | undefined;
    let provider: ProxyProvider | undefined;
    try {
      await forward(request, response, (value) => { operationId = value.operationId; provider = value.provider; });
    } catch (error) {
      const refusal = error instanceof Refusal ? error
        : error instanceof RequestNotAllowed ? new Refusal(400, "request_not_allowed", error.message)
        : new Refusal(502, "model_proxy_unavailable", "the model proxy could not complete the call");
      tell({ event: "call_refused", code: refusal.code, status: refusal.status, operationId, provider });
      sendRefusal(response, refusal);
    }
  }

  async function forward(request: IncomingMessage, response: ServerResponse, note: (value: { operationId: string; provider: ProxyProvider }) => void): Promise<void> {
    if (request.method !== "POST") throw new Refusal(405, "method_not_allowed", "only POST is served");
    const path = (request.url ?? "").split("?")[0] ?? "";
    const api: ProxyApi | undefined = path.startsWith(`${MODEL_PROXY_PREFIX}/`) ? PROXY_PATH_API[path.slice(MODEL_PROXY_PREFIX.length)] : undefined;
    if (api === undefined) throw new Refusal(404, "not_found", "no such model route");
    const headers: Record<string, string | undefined> = {};
    for (const name of Object.keys(request.headers)) headers[name.toLowerCase()] = headerValue(request.headers, name);
    checkRequestHeaders(headers);

    // ---- who is calling
    const bearer = /^Bearer (\S+)$/iu.exec(headers.authorization ?? "")?.[1];
    const apiKey = headers["x-api-key"];
    if (bearer !== undefined && apiKey !== undefined && bearer !== apiKey) throw new Refusal(401, "invalid_token", "the model token is not valid");
    const presented = apiKey ?? bearer;
    if (presented === undefined || presented.length > 256) throw new Refusal(401, "invalid_token", "the model token is not valid");
    const found = tokens.lookup(presented);
    if (!found.ok) throw new Refusal(401, found.reason === "expired" ? "token_expired" : "invalid_token", found.reason === "expired" ? "the model token has expired; ask for a new one" : "the model token is not valid");
    const token = found.record;
    // The gateway stamps the workspace; a token used from another workspace's worker (or with no stamp) is refused.
    if (headers[WORKSPACE_HEADER] !== token.workspaceId) throw new Refusal(403, "other_workspace", "this token belongs to another workspace");
    if (!(await options.grants.active({ workspaceId: token.workspaceId, operationId: token.operationId, fence: token.fence }))) {
      tokens.revokeOperation(token.operationId);
      throw new Refusal(403, "operation_ended", "this operation no longer runs");
    }

    // ---- what it asks for
    const raw = await readBody(request, MODEL_PROXY_REQUEST_MAX_BYTES);
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw.toString("utf8"));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      body = parsed as Record<string, unknown>;
    } catch {
      throw new Refusal(400, "invalid_json", "the request is not a JSON object");
    }
    checkRequestBody(api, body);
    const alias = body.model;
    const route = typeof alias === "string" ? token.routes.get(alias) : undefined;
    if (route === undefined) throw new Refusal(403, "model_not_allowed", "this task may not call that model");
    if (route.api !== api) throw new Refusal(400, "request_not_allowed", "request not allowed: that model speaks another route");
    const target = upstreamUrl(endpoints, route.provider, route.api);
    if (target === undefined) throw new Refusal(400, "request_not_allowed", "request not allowed: that provider does not serve this route");
    note({ operationId: token.operationId, provider: route.provider });

    // ---- the budget and the limits
    const ledger = tokens.ledger(token.operationId);
    if (token.budget !== undefined) {
      if (ledger.currency !== undefined && ledger.currency !== token.budget.currency) throw new Refusal(403, "model_not_allowed", "this task's budget is in another currency than its spend");
      if (ledger.spentMicros >= token.budget.micros) throw budgetRefusal();
      if (!(await priced(route))) throw new Refusal(403, "model_not_allowed", "this model has no price on this computer, so the task budget cannot be held");
    }
    if (ledger.inFlight >= maxConcurrent) throw new Refusal(429, "too_many_requests", "this task has too many model calls running", { "retry-after": "2" });

    // ---- the key, only now
    const secret = await options.keys.get(options.companyId, route.provider);
    if (secret === undefined) throw new Refusal(403, "model_not_allowed", `no ${route.provider} key is set on this computer`);
    const key = secret.reveal();

    const stream = body.stream === true;
    const forwarded: Record<string, unknown> = { ...body, model: route.model };
    if (stream && api === "openai-completions") {
      const asked = body.stream_options;
      forwarded.stream_options = { ...(asked !== null && typeof asked === "object" && !Array.isArray(asked) ? asked : {}), include_usage: true };
    }
    const upstreamHeaders: Record<string, string> = {
      "content-type": "application/json",
      accept: stream ? "text/event-stream" : "application/json",
      "user-agent": "rovara-local-model-proxy",
    };
    if (route.provider === "anthropic") {
      upstreamHeaders["x-api-key"] = key;
      upstreamHeaders["anthropic-version"] = /^\d{4}-\d{2}-\d{2}$/u.test(headers["anthropic-version"] ?? "") ? headers["anthropic-version"]! : ANTHROPIC_VERSION;
      if (headers["anthropic-beta"] !== undefined) upstreamHeaders["anthropic-beta"] = headers["anthropic-beta"].split(",").map((value) => value.trim()).join(",");
    } else {
      upstreamHeaders.authorization = `Bearer ${key}`;
    }

    const controller = new AbortController();
    const abortOnClose = (): void => { if (!response.writableEnded) controller.abort(); };
    response.once("close", abortOnClose);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const collector = new UsageCollector(api);
    ledger.inFlight += 1;
    let upstreamOk = false;
    let settled = false;
    // Recorded before the answer ends, so the next call from the worker sees this one's cost in the budget.
    const settle = async (): Promise<void> => {
      if (settled || !upstreamOk) return;
      settled = true;
      await record(token, route, collector.finish(), ledger).catch(() => tell({ event: "unmetered", code: "meter_failed", operationId: token.operationId, provider: route.provider }));
    };
    try {
      let upstream: Response;
      try {
        // redirect "manual": a redirect is never followed (the next address would get the key); it is an error.
        upstream = await transport(target, { method: "POST", headers: upstreamHeaders, body: JSON.stringify(forwarded), redirect: "manual", signal: controller.signal });
      } catch {
        throw new Refusal(controller.signal.aborted ? 504 : 502, "provider_unreachable", `the ${route.provider} provider could not be reached`);
      }
      tell({ event: "call_forwarded", operationId: token.operationId, provider: route.provider, status: upstream.status });
      if (upstream.status < 200 || upstream.status >= 300) {
        const text = await readBounded(upstream, ERROR_BODY_MAX_BYTES).catch(() => "");
        throw providerRefusal(upstream.status, upstream.headers.get("retry-after"), text, key);
      }
      const keyBytes = key.length >= 8 ? Buffer.from(key) : undefined;
      const contentType = upstream.headers.get("content-type") ?? "";
      if (stream && contentType.toLowerCase().startsWith("text/event-stream") && upstream.body !== null) {
        upstreamOk = true;
        response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
        const clean = await pump(upstream.body, response, (chunk) => collector.push(chunk), keyBytes);
        if (!clean) {
          tell({ event: "stream_stopped", code: "key_in_answer", operationId: token.operationId, provider: route.provider });
          response.destroy();
        } else {
          await settle();
          response.end();
        }
      } else {
        const whole = await readBounded(upstream, WHOLE_ANSWER_MAX_BYTES, keyBytes);
        let parsed: unknown;
        try { parsed = JSON.parse(whole); } catch { parsed = undefined; }
        if (parsed === undefined) throw new Refusal(502, "provider_answer_unreadable", `the ${route.provider} provider answered with something that is not JSON`);
        collector.whole(parsed);
        upstreamOk = true;
        await settle();
        response.writeHead(200, { ...JSON_HEADERS });
        response.end(whole);
      }
    } finally {
      clearTimeout(timer);
      response.off("close", abortOnClose);
      ledger.inFlight -= 1;
      await settle();
      tell({ event: "call_finished", operationId: token.operationId, provider: route.provider });
    }
  }

  /** Records what the call used and adds its cost to the operation's spend. Recording the same entry twice counts once (the port's rule). */
  async function record(token: { operationId: string; taskId: string | undefined; projectName: string | undefined; budget: Cost | undefined }, route: ProxyRoute, usage: ReturnType<UsageCollector["finish"]>, ledger: { currency: string | undefined; spentMicros: number; unpriced: number }): Promise<void> {
    if (usage === undefined) {
      tell({ event: "unmetered", code: "no_usage_reported", operationId: token.operationId, provider: route.provider });
      return;
    }
    const result = await options.metering.record({
      companyId: options.companyId,
      entryId: `${token.operationId}:${randomUUID()}`,
      at: new Date(now()).toISOString(),
      usage: { provider: route.provider, modelId: route.model, tokens: { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite } },
      ...(token.taskId === undefined ? {} : { taskId: token.taskId }),
      ...(token.projectName === undefined ? {} : { projectName: token.projectName }),
    });
    if (result.cost === null || (ledger.currency !== undefined && ledger.currency !== result.cost.currency)) {
      ledger.unpriced += 1;
      return;
    }
    ledger.currency = result.cost.currency;
    ledger.spentMicros += result.cost.micros;
  }

  /** A provider's refusal as the worker should see it: its status class, its words shortened and scrubbed, never its headers. */
  function providerRefusal(status: number, retryAfter: string | null, text: string, key: string): Refusal {
    let message = "";
    try {
      const error = (JSON.parse(text) as { error?: { message?: unknown } | string }).error;
      message = typeof error === "string" ? error : typeof error?.message === "string" ? error.message : "";
    } catch { /* not JSON */ }
    tell({ event: "provider_refused", status });
    const cleaned = scrubProviderText(message, key);
    const headers: Record<string, string> = retryAfter !== null && /^\d{1,5}$/u.test(retryAfter) ? { "retry-after": retryAfter } : {};
    if (status === 401 || status === 403) return new Refusal(502, "provider_refused_key", "the model provider refused the key on this computer; check it", headers);
    // 3xx is never followed, and anything else keeps its status class so the worker retries what is worth retrying (429, 5xx).
    const outgoing = status >= 300 && status < 400 ? 502 : status === 429 || status === 408 || status === 413 || status === 422 || status === 404 || status === 400 || status === 529 || (status >= 500 && status < 600) ? status : 502;
    return new Refusal(outgoing, "provider_error", cleaned === "" ? `the provider answered HTTP ${String(status)}` : `the provider answered HTTP ${String(status)}: ${cleaned}`, headers);
  }

  return { tokens, access, handle };
}

async function readBounded(upstream: Response, limit: number, keyBytes?: Buffer): Promise<string> {
  if (upstream.body === null) return "";
  const chunks: Buffer[] = [];
  let size = 0;
  let tail: Buffer = Buffer.alloc(0);
  const reader: ReadableStreamDefaultReader<Uint8Array> = upstream.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error("too large");
    }
    const chunk = Buffer.from(value);
    if (keyBytes !== undefined) {
      const window = Buffer.concat([tail, chunk]);
      if (window.includes(keyBytes)) {
        await reader.cancel();
        throw new Refusal(502, "key_in_answer", "the provider's answer was dropped");
      }
      tail = window.subarray(Math.max(0, window.length - (keyBytes.length - 1)));
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Copies a streamed answer to the worker, reading its usage on the way. False when the key showed up in it and the copy was stopped. */
async function pump(body: ReadableStream<Uint8Array>, response: ServerResponse, onChunk: (chunk: Uint8Array) => void, keyBytes: Buffer | undefined): Promise<boolean> {
  const reader: ReadableStreamDefaultReader<Uint8Array> = body.getReader();
  let tail: Buffer = Buffer.alloc(0);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return true;
      const chunk = Buffer.from(value);
      if (keyBytes !== undefined) {
        const window = Buffer.concat([tail, chunk]);
        if (window.includes(keyBytes)) {
          await reader.cancel();
          return false;
        }
        tail = window.subarray(Math.max(0, window.length - (keyBytes.length - 1)));
      }
      onChunk(chunk);
      if (!response.write(chunk)) await new Promise<void>((resolve) => { response.once("drain", resolve); response.once("close", resolve); });
      if (response.destroyed) {
        await reader.cancel();
        return true;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
