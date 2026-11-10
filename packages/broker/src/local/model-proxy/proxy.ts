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
import { TASK_BUDGET_EXCEEDED_PREFIX, providerFormat, type AdapterRegistry, type AgentXError, type Cost, type Metering, type ModelKeyStore, type ModelProviderAdapter } from "@agentx/contracts";
import type { BrokerResponse } from "../../handler.js";
import { BUILTIN_MODEL_PROVIDERS } from "../../plugins/model-provider/builtin.js";
import { credentialFix, hasCredential } from "./credentials.js";
import {
  PROXY_PATH_API, RequestNotAllowed, checkRequestBody, checkRequestHeaders, upstreamTarget, type ProviderEndpoints,
} from "./providers.js";
import { SignInProblem, needsCredential, signCall } from "./sign-in.js";
import { ModelTokenBook } from "./tokens.js";
import type { ModelGrantSource, ModelProviderBook, ModelProxyEvent, ProxyApi, ProxyProvider, ProxyRoute } from "./types.js";
import { UsageCollector, type TokenUsage } from "./usage.js";

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
/** The `anthropic_version` Claude on Google Cloud's Vertex AI takes in the body. */
const VERTEX_ANTHROPIC_VERSION = "vertex-2023-10-16";

/**
 * The providers of the `model-provider` point, looked up when asked (so a provider registered at start-up is seen). A registry with none registered (a test that builds its own)
 * has the three built-ins.
 */
export function registryModelProviderBook(registry: Pick<AdapterRegistry, "get" | "names">): ModelProviderBook {
  const fallback = builtinModelProviderBook();
  return {
    get: (id) => (registry.names("model-provider").length === 0 ? fallback.get(id) : registry.get("model-provider", id)),
    ids: () => (registry.names("model-provider").length === 0 ? fallback.ids() : registry.names("model-provider")),
  };
}

/** A book of the three built-in providers, for a caller (a test) that gives the proxy none. */
export function builtinModelProviderBook(): ModelProviderBook {
  return { get: (id) => BUILTIN_MODEL_PROVIDERS.find((provider) => provider.kind === id), ids: () => BUILTIN_MODEL_PROVIDERS.map((provider) => provider.kind) };
}

export interface LocalModelProxyOptions {
  /** Where the real keys are (the `model-keys` port). Read per call; never kept. */
  keys: ModelKeyStore;
  /** Where the keys come from, in words for the owner, when it is not the key file and the environment (`the "svc" secrets plug-in`). */
  keySource?: string | undefined;
  /** Prices and records what each call used (the `metering` port). */
  metering: Metering;
  companyId: string;
  grants: ModelGrantSource;
  /** The address the worker is told to call: its egress gateway's name for the broker, plus `MODEL_PROXY_PREFIX`. */
  workerUrl: string;
  /** The providers a route may name (the `model-provider` plug-ins). Absent: the three built-in providers. */
  providers?: ModelProviderBook | undefined;
  /** Where each provider is, by provider id, in place of its own address. Absent: the providers' own addresses. Tests point these at a fake provider. */
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
  /** The task flow calls this when an operation settles (finished, failed, cancelled): its tokens and its spend record are freed at once and not at its next refused call. */
  operationEnded(operationId: string): void;
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

/** The fixed words for a sign-in that could not be made: the provider's own sentence about why (no secret in it), then where to look. */
function signInFailure(row: ModelProviderAdapter): string {
  const why = row.credentialProblem?.();
  return `the sign-in to ${row.name} could not be made${why === undefined ? "" : ` (${why})`}; check it on this computer`;
}

/** A provider's words that say the request's signature time is off (AWS: "Signature expired", "RequestTimeTooSkewed"). */
export const CLOCK_SKEW_PATTERN = /signature expired|signature not yet current|requesttimetooskewed|request has expired|request time too skewed|too skewed|time.{0,20}skew|clock/iu;

/** Whether a request's `tool_choice` makes the model call a tool (a named tool, "required", "any"), as opposed to leaving it free ("auto", "none"). */
export function forcesToolChoice(choice: unknown): boolean {
  if (choice === undefined || choice === null) return false;
  if (typeof choice === "string") return choice === "required" || choice === "any";
  if (typeof choice !== "object" || Array.isArray(choice)) return false;
  const type = (choice as Record<string, unknown>).type;
  return type !== "auto" && type !== "none";
}

/** Used when a request names no output limit (OpenAI's routes may not): the most output a call is assumed to be able to use. */
export const ASSUMED_MAX_OUTPUT_TOKENS = 64_000;

/** The most input a call is assumed to be able to use: no model reads more, and a request of base64 pictures is far bigger in bytes than in tokens. */
export const ASSUMED_MAX_INPUT_TOKENS = 2_000_000;

/**
 * The most a request could use: the output limit it names (or the assumed one) and an input of ONE token to each byte of the request (no tokenizer produces more tokens
 * than bytes), at most `ASSUMED_MAX_INPUT_TOKENS`. A reservation this high refuses a call earlier than the real cost would, never later.
 */
export function worstCaseUsage(body: Readonly<Record<string, unknown>>, requestBytes: number): TokenUsage {
  const asked = [body.max_tokens, body.max_output_tokens, body.max_completion_tokens].find((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
  return { input: Math.min(Math.ceil(requestBytes), ASSUMED_MAX_INPUT_TOKENS), output: Math.min(Math.floor(asked ?? ASSUMED_MAX_OUTPUT_TOKENS), 1_000_000), cacheRead: 0, cacheWrite: 0 };
}

export function createLocalModelProxy(options: LocalModelProxyOptions): LocalModelProxy {
  const now = options.now ?? Date.now;
  const tokens = new ModelTokenBook({ now, ...(options.ttlSeconds === undefined ? {} : { ttlSeconds: options.ttlSeconds }) });
  const endpoints: Partial<ProviderEndpoints> = { ...options.endpoints };
  const book = options.providers ?? builtinModelProviderBook();
  const transport = options.fetch ?? fetch;
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxConcurrent = options.maxConcurrentPerOperation ?? DEFAULT_MAX_CONCURRENT;
  const tell = (event: ModelProxyEvent): void => {
    try { options.onEvent?.(event); } catch { /* a listener failing changes nothing here */ }
  };

  /** The most a call could cost, or null when its model has no price. Input is priced at the dearer of the plain and the cache-write rate. */
  async function worstCaseCost(route: ProxyRoute, worst: TokenUsage): Promise<Cost | null> {
    const plain = await options.metering.price({ provider: route.provider, modelId: route.model, tokens: worst });
    const written = await options.metering.price({ provider: route.provider, modelId: route.model, tokens: { input: 0, output: worst.output, cacheRead: 0, cacheWrite: worst.input } });
    if (plain === null || written === null) return null;
    return { micros: Math.max(plain.micros, written.micros), currency: plain.currency };
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
      held = await Promise.all(providers.map(async (provider) => {
        const row = book.get(provider);
        return { provider, has: row !== undefined && (await hasCredential(row, options.keys, options.companyId)) };
      }));
    } catch {
      // The keys could not be read (wrong mode, not JSON, or a secrets plug-in failed). The words of that error can quote the file or the plug-in's data, so none are passed on; the source is named.
      return { statusCode: 503, headers: { ...JSON_HEADERS }, body: JSON.stringify({ error: { code: "MODEL_PROXY_UNAVAILABLE", message: `the model keys on this computer could not be read; check ${options.keySource ?? "~/.rovara/keys.json"}` } }) };
    }
    if (!held.some((entry) => entry.has)) {
      const first = book.get(providers[0]!);
      if (first === undefined) return notAllowed(`the model provider ${providers[0]!.slice(0, 40)} is not set up on this computer`);
      const keyed = first.signIn.kind === "bearer-key" || first.signIn.kind === "named-header";
      const fix = keyed && options.keySource !== undefined ? `put it in a place ${options.keySource} reads` : credentialFix(first);
      return notAllowed(`no ${providers.join(" or ")} ${keyed ? "key" : "sign-in"} is set on this computer; ${fix} and restart rovara up`);
    }
    const ledger = tokens.ledger(grant.operationId);
    if (grant.budget !== undefined) {
      if (ledger.currency !== undefined && ledger.currency !== grant.budget.currency) return notAllowed("this task's budget is in another currency than its spend");
      if (ledger.spentMicros + ledger.reservedMicros >= grant.budget.micros) return budgetAccessRefusal();
    }
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

    // ---- the concurrency cap: checked and taken in one synchronous step, before the first await, so a burst cannot all pass the check
    const ledger = tokens.ledger(token.operationId);
    if (ledger.inFlight >= maxConcurrent) throw new Refusal(429, "too_many_requests", "this task has too many model calls running", { "retry-after": "2" });
    ledger.inFlight += 1;
    let reserved = 0;
    const release = (): void => {
      ledger.reservedMicros -= reserved;
      reserved = 0;
    };
    const controller = new AbortController();
    let provider: ProxyProvider | undefined;
    let upstreamOk = false;
    let requestSent = false;
    let complete = false;
    let settled = false;
    let worst: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const collector = new UsageCollector(api);
    const abortOnClose = (): void => { if (!response.writableEnded) controller.abort(); };
    response.once("close", abortOnClose);
    let timer: ReturnType<typeof setTimeout> | undefined;
    /**
     * Records what the call used and adds its cost to the operation's spend, before the answer ends, so the worker's next call sees it. A call that sent a request and did not
     * finish cleanly (the worker cut it off, the stream broke, the time ran out), or whose provider never said what it used, is charged the most it could have cost: the
     * request's output limit and an input of its size.
     */
    const settle = async (route: ProxyRoute | undefined): Promise<void> => {
      if (settled || route === undefined || !requestSent || !(upstreamOk || controller.signal.aborted)) return;
      settled = true;
      const seen = complete ? collector.finish() : undefined;
      if (seen === undefined) tell({ event: "unmetered", code: "charged_maximum", operationId: token.operationId, provider: route.provider });
      await record(token, route, seen ?? worst, ledger).catch(() => tell({ event: "unmetered", code: "meter_failed", operationId: token.operationId, provider: route.provider }));
    };
    let route: ProxyRoute | undefined;
    try {
      if (!(await options.grants.active({ workspaceId: token.workspaceId, operationId: token.operationId, fence: token.fence }))) {
        // The operation is over: its tokens and its spend record go with it.
        tokens.forgetOperation(token.operationId);
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
      route = typeof alias === "string" ? token.routes.get(alias) : undefined;
      if (route === undefined) throw new Refusal(403, "model_not_allowed", "this task may not call that model");
      if (route.api !== api) throw new Refusal(400, "request_not_allowed", "request not allowed: that model speaks another route");
      const row = book.get(route.provider);
      if (row === undefined) throw new Refusal(400, "request_not_allowed", "request not allowed: that provider is not set up");
      const format = providerFormat(row, route.api);
      if (format === undefined) throw new Refusal(400, "request_not_allowed", "request not allowed: that provider does not serve this route");
      // A provider that ignores a forced tool choice would let the model answer without the tool: refuse it by name (the plug-in states what it honours).
      if (!format.capabilities.forcedToolChoice && forcesToolChoice(body.tool_choice)) throw new Refusal(400, "request_not_allowed", `request not allowed: ${row.name} does not honour a forced tool choice on this route`);
      const stream = body.stream === true;
      const target = upstreamTarget(row, format, route.model, stream, endpoints[route.provider]);
      provider = route.provider;
      note({ operationId: token.operationId, provider });

      // ---- the budget: the most this call could cost is held against it until the call settles to what it used
      worst = worstCaseUsage(body, raw.byteLength);
      if (token.budget !== undefined) {
        if (ledger.currency !== undefined && ledger.currency !== token.budget.currency) throw new Refusal(403, "model_not_allowed", "this task's budget is in another currency than its spend");
        const maximum = await worstCaseCost(route, worst);
        if (maximum === null) throw new Refusal(403, "model_not_allowed", "this model has no price on this computer, so the task budget cannot be held");
        if (maximum.currency !== token.budget.currency) throw new Refusal(403, "model_not_allowed", "this model is priced in another currency than the task's budget");
        // Nothing awaits between this check and the reservation below. A budget that is spent, or cannot pay for this call even with nothing else running, ends the task (422).
        // A call that would fit alone but not beside the calls running now is told to wait (429): their reservations come back when they settle.
        if (ledger.spentMicros + maximum.micros > token.budget.micros) throw budgetRefusal();
        if (ledger.spentMicros + ledger.reservedMicros + maximum.micros > token.budget.micros) throw new Refusal(429, "budget_held", "other model calls of this task hold the budget for now; try again shortly", { "retry-after": "2" });
        reserved = maximum.micros;
        ledger.reservedMicros += reserved;
      }

      // ---- the credential, only now: the key store's entry (read through the `secrets` socket) wins, the provider's own `credential()` is the fallback
      // A failing key store (or a secrets plug-in) ends the call with a fixed sentence naming the source, never its own text.
      let secret;
      if (needsCredential(row)) {
        secret = await options.keys.get(options.companyId, route.provider).catch(() => { throw new Refusal(503, "model_proxy_unavailable", `the model key could not be read from ${options.keySource ?? "the key file"}`); });
        if (secret === undefined && row.credential !== undefined) {
          // The provider's own credential could not be resolved (a role that expired, a token that could not be refreshed). Its words can quote a setting, so none are passed on.
          secret = await row.credential().catch(() => { throw new Refusal(502, "provider_sign_in_failed", signInFailure(row)); });
        }
      }
      if (needsCredential(row) && secret === undefined) throw new Refusal(403, "model_not_allowed", `no ${route.provider} ${row.signIn.kind === "bearer-key" || row.signIn.kind === "named-header" ? "key" : "sign-in"} is set on this computer${row.credentialProblem?.() === undefined ? "" : ` (${row.credentialProblem()!})`}`);

      const forwarded: Record<string, unknown> = { ...body, model: route.model };
      if (stream && api === "openai-completions") {
        const asked = body.stream_options;
        forwarded.stream_options = { ...(asked !== null && typeof asked === "object" && !Array.isArray(asked) ? asked : {}), include_usage: true };
      }
      // Nothing is kept at the provider, whatever the worker asked: Responses and chat completions are both sent with `store: false` (the full history goes in every call; `previous_response_id`
      // is not an allowed field). The guard's allow-lists still allow the field, as Cloud's do; this is an override of the forwarded body.
      if (api === "openai-responses" || api === "openai-completions") forwarded.store = false;
      if (target.variant === "vertex") {
        // Claude on Google Cloud: the model is in the address, the API version in the body.
        delete forwarded.model;
        forwarded.anthropic_version = VERTEX_ANTHROPIC_VERSION;
      }
      const forwardedText = JSON.stringify(forwarded);
      const upstreamHeaders: Record<string, string> = {
        "content-type": "application/json",
        accept: stream ? "text/event-stream" : "application/json",
        "user-agent": "rovara-local-model-proxy",
      };
      if (api === "anthropic-messages" && target.variant === undefined) {
        upstreamHeaders["anthropic-version"] = /^\d{4}-\d{2}-\d{2}$/u.test(headers["anthropic-version"] ?? "") ? headers["anthropic-version"]! : ANTHROPIC_VERSION;
        if (headers["anthropic-beta"] !== undefined) upstreamHeaders["anthropic-beta"] = headers["anthropic-beta"].split(",").map((value) => value.trim()).join(",");
      }
      let sensitive: string[];
      try {
        const signed = signCall({ provider: row, url: new URL(target.url), headers: { "content-type": "application/json" }, body: forwardedText, secret, now: new Date(now()) });
        Object.assign(upstreamHeaders, signed.headers);
        sensitive = signed.sensitive;
      } catch (error) {
        if (error instanceof SignInProblem) throw new Refusal(502, "provider_sign_in_failed", signInFailure(row));
        throw error;
      }

      timer = setTimeout(() => controller.abort(), timeoutMs);
      let upstream: Response;
      try {
        // redirect "manual": a redirect is never followed (the next address would get the key); it is an error.
        requestSent = true;
        upstream = await transport(target.url, { method: "POST", headers: upstreamHeaders, body: forwardedText, redirect: "manual", signal: controller.signal });
      } catch {
        throw new Refusal(controller.signal.aborted ? 504 : 502, "provider_unreachable", `the ${route.provider} provider could not be reached`);
      }
      tell({ event: "call_forwarded", operationId: token.operationId, provider: route.provider, status: upstream.status });
      if (upstream.status < 200 || upstream.status >= 300) {
        // An error answer is not billed.
        requestSent = false;
        const text = await readBounded(upstream, ERROR_BODY_MAX_BYTES).catch(() => "");
        throw providerRefusal(upstream.status, upstream.headers.get("retry-after"), text, sensitive);
      }
      const keyBytes = sensitive.filter((value) => value.length >= 8).map((value) => Buffer.from(value));
      const contentType = upstream.headers.get("content-type") ?? "";
      if (stream && contentType.toLowerCase().startsWith("text/event-stream") && upstream.body !== null) {
        upstreamOk = true;
        response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
        const outcome = await pump(upstream.body, response, (chunk) => collector.push(chunk), keyBytes, controller.signal);
        if (outcome === "key") {
          tell({ event: "stream_stopped", code: "key_in_answer", operationId: token.operationId, provider: route.provider });
          await settle(route);
          response.destroy();
        } else if (outcome === "aborted") {
          await settle(route);
        } else {
          complete = true;
          await settle(route);
          response.end();
        }
      } else {
        upstreamOk = true;
        const whole = await readBounded(upstream, WHOLE_ANSWER_MAX_BYTES, keyBytes);
        let parsed: unknown;
        try { parsed = JSON.parse(whole); } catch { parsed = undefined; }
        if (parsed === undefined) throw new Refusal(502, "provider_answer_unreadable", `the ${route.provider} provider answered with something that is not JSON`);
        collector.whole(parsed);
        complete = true;
        await settle(route);
        response.writeHead(200, { ...JSON_HEADERS });
        response.end(whole);
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      response.off("close", abortOnClose);
      await settle(route);
      release();
      ledger.inFlight -= 1;
      if (route !== undefined) tell({ event: "call_finished", operationId: token.operationId, provider: route.provider });
    }
  }

  /** Records what the call used and adds its cost to the operation's spend. Recording the same entry twice counts once (the port's rule). */
  async function record(token: { operationId: string; taskId: string | undefined; projectName: string | undefined; budget: Cost | undefined }, route: ProxyRoute, usage: TokenUsage, ledger: { currency: string | undefined; spentMicros: number; unpriced: number }): Promise<void> {
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
  function providerRefusal(status: number, retryAfter: string | null, text: string, secrets: readonly string[]): Refusal {
    let message = "";
    try {
      const error = (JSON.parse(text) as { error?: { message?: unknown } | string }).error;
      message = typeof error === "string" ? error : typeof error?.message === "string" ? error.message : "";
    } catch { /* not JSON */ }
    tell({ event: "provider_refused", status });
    const cleaned = (secrets.length === 0 ? [""] : secrets).reduce((clean, secret) => scrubProviderText(clean, secret), message);
    const headers: Record<string, string> = retryAfter !== null && /^\d{1,5}$/u.test(retryAfter) ? { "retry-after": retryAfter } : {};
    if ((status === 401 || status === 403) && CLOCK_SKEW_PATTERN.test(text.slice(0, ERROR_BODY_MAX_BYTES))) return new Refusal(502, "provider_clock_skew", "the model provider says the time of this call is off; check your computer's clock", headers);
    if (status === 401 || status === 403) return new Refusal(502, "provider_refused_key", "the model provider refused the key on this computer; check it", headers);
    // 3xx is never followed, and anything else keeps its status class so the worker retries what is worth retrying (429, 5xx).
    const outgoing = status >= 300 && status < 400 ? 502 : status === 429 || status === 408 || status === 413 || status === 422 || status === 404 || status === 400 || status === 529 || (status >= 500 && status < 600) ? status : 502;
    return new Refusal(outgoing, "provider_error", cleaned === "" ? `the provider answered HTTP ${String(status)}` : `the provider answered HTTP ${String(status)}: ${cleaned}`, headers);
  }

  return { tokens, access, handle, operationEnded: (operationId) => tokens.forgetOperation(operationId) };
}

async function readBounded(upstream: Response, limit: number, keyBytes: readonly Buffer[] = []): Promise<string> {
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
    if (keyBytes.length > 0) {
      const window = Buffer.concat([tail, chunk]);
      if (keyBytes.some((secret) => window.includes(secret))) {
        await reader.cancel();
        throw new Refusal(502, "key_in_answer", "the provider's answer was dropped");
      }
      tail = window.subarray(Math.max(0, window.length - (Math.max(...keyBytes.map((secret) => secret.length)) - 1)));
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Resolves when the response has drained, closed, or the call was aborted (the worker went away, or the time ran out), so a worker that stops reading cannot hold a call open. */
function drained(response: ServerResponse, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (response.destroyed || signal.aborted) return resolve();
    const done = (): void => {
      response.off("drain", done);
      response.off("close", done);
      signal.removeEventListener("abort", done);
      resolve();
    };
    response.once("drain", done);
    response.once("close", done);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Copies a streamed answer to the worker, reading its usage on the way. The last `key length - 1` bytes of everything read are held back and written only with
 * the next chunk (or at a clean end), so a key split across two chunks is found before any byte of it has left: "key" when it showed up and the copy was stopped,
 * "aborted" when the call was aborted or the worker went away, "clean" when the whole answer was copied.
 */
async function pump(body: ReadableStream<Uint8Array>, response: ServerResponse, onChunk: (chunk: Uint8Array) => void, keyBytes: readonly Buffer[], signal: AbortSignal): Promise<"clean" | "key" | "aborted"> {
  const reader: ReadableStreamDefaultReader<Uint8Array> = body.getReader();
  const hold = keyBytes.length === 0 ? 0 : Math.max(...keyBytes.map((secret) => secret.length)) - 1;
  let tail: Buffer = Buffer.alloc(0);
  const send = async (bytes: Buffer): Promise<boolean> => {
    if (bytes.length > 0) {
      onChunk(bytes);
      if (!response.write(bytes)) await drained(response, signal);
    }
    return !(signal.aborted || response.destroyed);
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return (await send(tail)) ? "clean" : "aborted";
      const window = Buffer.concat([tail, Buffer.from(value)]);
      if (keyBytes.some((secret) => window.includes(secret))) {
        await reader.cancel();
        return "key";
      }
      const cut = Math.max(0, window.length - hold);
      tail = window.subarray(cut);
      if (!(await send(window.subarray(0, cut)))) {
        await reader.cancel();
        return "aborted";
      }
    }
  } finally {
    reader.releaseLock();
  }
}
