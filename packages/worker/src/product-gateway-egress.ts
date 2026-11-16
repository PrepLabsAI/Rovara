// The worker's side of the product bridge (plan 7.4 item 7; contracts/shared/model-gateway-product-ai.v1.json, copied byte for
// byte from the gateway's repository and pinned by SHA-256 in tests/unit/product-gateway-egress.test.ts). A `ModelEgress` the
// model bridge (TE-F1c, `model-bridge.ts`) hands checked frames to, in a deployed install where the PRODUCT key stays with the
// model gateway:
//
//   sandbox test --(dummy Google key)--> helper --> model bridge --> THIS egress --(task token as x-api-key)--> <gateway>/v1/product/gemini/...
//
// Rules, each with a test:
// - Only the two Gemini calls of the contract leave: POST `/{v1|v1beta}/models/{model}:generateContent` with no query, and
//   `:streamGenerateContent?alt=sse`. Anything else is refused here (`not_allowed`, `bad_request`), before any request.
// - The sandbox's Google credentials never leave: `x-goog-api-key`, `x-goog-user-project` and `authorization` are dropped (only the
//   Gemini family's allow-listed headers are kept at all) and every `key=` is removed from the query.
// - The task token is added HERE, from the worker's own token source (GET /v1/internal/model-access, Code #670); the frame, the
//   helper and the sandbox never carry it. An answer that echoes it is cut (`provider_error`), never handed on.
// - ONE attempt per call, never retried (a retry can double-spend). Redirects are never followed.
// - The gateway's own refusals become the fixed Rovara refusal answers, so the evidence reads the not-run sentence: its budget
//   refusals are `cap` (with "budget exceeded by one call" when it says so), a refused product key is `key_refused`, the provider's
//   limits are `rate_limit`, `quota` and `overloaded`. Its words are matched only against the contract's fixed words, never echoed.
// - The gateway meters, caps and charges every product call (the project pays). It does not report a call's cost to the worker, so
//   every settle here carries `costMicros: 0`; the bridge's own per-task pre-caps (count, concurrency) still apply, its dollar
//   pre-cap cannot, and the gateway's cap is the one that holds (DEFERRED PRODUCT-BRIDGE-COST-REPORT-20261115).
// - No header value, token, provider word or error text is logged or thrown.
import {
  createKeyEchoScanner, familyErrorBody, modelEgressAllowedHeaders, parseModelEgressFrame, refusalResponse, sanitizeResponseHeaders,
  MODEL_EGRESS_MIN_KEY_CHARS,
  type ModelEgress, type ModelEgressClass, type ModelEgressEvent, type ModelEgressFrame, type ModelEgressRefusal, type ModelEgressScope, type ModelEgressSettle,
} from "@agentx/contracts";

/** The contract's own values (tests compare each with contracts/shared/model-gateway-product-ai.v1.json). */
export const PRODUCT_BRIDGE_CONTRACT = Object.freeze({
  version: 1,
  routePrefix: "/v1/product/",
  provider: "gemini",
  versions: Object.freeze(["v1", "v1beta"]),
  model: "^[a-z0-9][a-z0-9.-]{0,95}$",
  workerRemovesHeaders: Object.freeze(["x-goog-api-key", "x-goog-user-project", "authorization"]),
  workerRemovesQuery: Object.freeze(["key"]),
  tokenHeader: "x-api-key",
});
export const PRODUCT_BRIDGE_RESPONSE_BYTES = 10 * 1024 * 1024;
const ERROR_BODY_BYTES = 64 * 1024;
const MODEL = new RegExp(PRODUCT_BRIDGE_CONTRACT.model, "u");
const PATH = /^\/(v1|v1beta)\/models\/([^/:]+):(generateContent|streamGenerateContent)$/u;
const TOKEN = /^[^\s]{1,16384}$/u;
const HEADER_VALUE = /^[\x20-\x7e]{1,1024}$/u;
const ALLOWED_HEADERS = modelEgressAllowedHeaders("gemini").filter((name) => !PRODUCT_BRIDGE_CONTRACT.workerRemovesHeaders.includes(name));
const UNREACHABLE = "The provider could not be reached.";

export type ProductGatewayTokenSource = () => Promise<string>;
export interface ProductGatewayEgressOptions {
  /** The gateway's base: https, or http only to this machine. */
  readonly gatewayUrl: string;
  /** The current task token (in the worker: `async () => (await modelAccessSource(...)()).apiKey`). Asked once per call. */
  readonly tokenSource: ProductGatewayTokenSource;
  /** Injected for tests; default the Node built-in. */
  readonly fetch?: typeof fetch;
  readonly responseBytes?: number;
}

/** The gateway's refusal types (contract `refusals`, plus the provider limit codes its product route answers) and what each is here. */
const GATEWAY_REFUSALS: Readonly<Record<string, ModelEgressRefusal>> = {
  budget_exceeded: "cap", budget_held: "cap", busy: "cap",
  product_key_refused: "key_refused",
  provider_limited: "rate_limit", provider_quota: "quota", provider_overloaded: "overloaded",
  authentication_error: "not_allowed", task_ended: "not_allowed",
  not_set_up: "not_found", not_found: "not_found",
  invalid_request: "bad_request", request_too_large: "too_large", too_large: "too_large",
};
const OVER_BY_ONE_CALL = "budget exceeded by one call";

function gatewayBase(raw: string): string {
  let url: URL | undefined;
  try { url = new URL(raw); } catch { url = undefined; }
  const local = url !== undefined && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url === undefined || !(url.protocol === "https:" || (url.protocol === "http:" && local)) || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new Error("the product gateway address must be an https URL with no credentials, query or fragment");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/u, "")}`;
}

/** The query the gateway takes, after every `key=` is removed: none for generateContent, exactly `alt=sse` for the stream. Undefined: refused. */
export function productQuery(query: string, operation: string): string | undefined {
  const kept = query === "" ? [] : query.split("&").filter((part) => !PRODUCT_BRIDGE_CONTRACT.workerRemovesQuery.some((name) => part === name || part.startsWith(`${name}=`)));
  if (operation === "generateContent") return kept.length === 0 ? "" : undefined;
  return kept.length === 1 && kept[0] === "alt=sse" ? "alt=sse" : undefined;
}

function* refused(word: ModelEgressRefusal, options: { overrun?: boolean; retryAfter?: string } = {}): Generator<ModelEgressEvent> {
  const answer = refusalResponse("gemini", word, options.overrun === true ? { overrun: true } : {});
  const headers: Array<[string, string]> = [...answer.headers, ...(options.retryAfter === undefined ? [] : [["retry-after", options.retryAfter] as [string, string]])];
  yield { kind: "head", status: answer.status, headers };
  yield { kind: "chunk", bytes: answer.body };
  yield settled(answer.status, word === "cap" ? "cap" : word === "key_refused" || word === "rate_limit" || word === "quota" || word === "overloaded" ? word : "refused", word);
}
function* unreachable(status = 502): Generator<ModelEgressEvent> {
  yield { kind: "head", status, headers: [["content-type", "application/json"]] };
  yield { kind: "chunk", bytes: familyErrorBody("gemini", status, UNREACHABLE, "rovara_unreachable") };
  yield settled(status, "provider_error");
}
const settled = (status: number, cls: ModelEgressClass, refusal?: ModelEgressRefusal): ModelEgressSettle =>
  ({ kind: "settle", status, class: cls, ...(refusal === undefined ? {} : { refusal }), costMicros: 0, estimated: false });

async function boundedBytes(response: Response, limit: number): Promise<Uint8Array | undefined> {
  const reader = (response.body as ReadableStream<Uint8Array> | null)?.getReader();
  if (reader === undefined) return new Uint8Array(0);
  const parts: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel().catch(() => undefined); return undefined; }
      parts.push(value);
    }
  } catch { return undefined; }
  return Buffer.concat(parts);
}
/** The gateway's `{error: {type, message}}`, read only to pick the refusal; undefined for anything else. */
function gatewayError(bytes: Uint8Array | undefined): { type: string; message: string } | undefined {
  if (bytes === undefined) return undefined;
  try {
    const value = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
    const error = typeof value === "object" && value !== null ? (value as { error?: unknown }).error : undefined;
    if (typeof error !== "object" || error === null) return undefined;
    const { type, message } = error as { type?: unknown; message?: unknown };
    return typeof type === "string" ? { type, message: typeof message === "string" ? message : "" } : undefined;
  } catch { return undefined; }
}

/**
 * The product bridge's `ModelEgress` for a deployed install. The scope is not read: the task token alone names the company,
 * project and task to the gateway. Throws only for an unusable address or token source (configuration), never on a call.
 */
export function createProductGatewayEgress(options: ProductGatewayEgressOptions): ModelEgress {
  const base = gatewayBase(options.gatewayUrl);
  if (typeof options.tokenSource !== "function") throw new Error("the product gateway needs a task token source");
  const transport = options.fetch ?? fetch;
  const responseLimit = typeof options.responseBytes === "number" && Number.isSafeInteger(options.responseBytes) && options.responseBytes > 0 ? options.responseBytes : PRODUCT_BRIDGE_RESPONSE_BYTES;

  async function* forward(input: ModelEgressFrame, signal: AbortSignal | undefined): AsyncGenerator<ModelEgressEvent> {
    const parsed = parseModelEgressFrame(input);
    if (!parsed.ok) { yield* refused(parsed.refusal); return; }
    const frame = parsed.frame;
    const path = PATH.exec(frame.path);
    if (frame.method !== "POST" || path === null || !MODEL.test(path[2] as string)) { yield* refused("not_allowed"); return; }
    const query = productQuery(frame.query, path[3] as string);
    if (query === undefined) { yield* refused("not_allowed"); return; }
    const headers: Record<string, string> = {};
    for (const [name, value] of frame.headers) {
      const lower = name.toLowerCase();
      if (ALLOWED_HEADERS.includes(lower) && HEADER_VALUE.test(value) && headers[lower] === undefined) headers[lower] = value;
    }
    let token: string | undefined;
    try { const value = await options.tokenSource(); token = typeof value === "string" && TOKEN.test(value) && value.length >= MODEL_EGRESS_MIN_KEY_CHARS ? value : undefined; } catch { token = undefined; }
    if (token === undefined) { yield* refused("not_allowed"); return; }

    let response: Response;
    try {
      response = await transport(`${base}${PRODUCT_BRIDGE_CONTRACT.routePrefix}gemini${frame.path}${query === "" ? "" : `?${query}`}`, {
        method: "POST", redirect: "error", ...(signal === undefined ? {} : { signal }),
        headers: { ...headers, [PRODUCT_BRIDGE_CONTRACT.tokenHeader]: token },
        body: frame.body,
      });
    } catch { yield* unreachable(); return; }

    if (response.status !== 200) {
      const error = gatewayError(await boundedBytes(response, ERROR_BODY_BYTES));
      const word = error === undefined ? undefined : GATEWAY_REFUSALS[error.type];
      if (word === undefined) { yield* unreachable(response.status >= 400 && response.status <= 599 ? response.status : 502); return; }
      const retry = response.headers.get("retry-after");
      yield* refused(word, {
        ...(word === "cap" && error?.message === OVER_BY_ONE_CALL ? { overrun: true } : {}),
        ...(retry !== null && /^\d{1,4}$/u.test(retry) ? { retryAfter: retry } : {}),
      });
      return;
    }

    const reader = (response.body as ReadableStream<Uint8Array> | null)?.getReader();
    if (reader === undefined) { yield { kind: "head", status: 200, headers: [] }; yield settled(200, "provider_error"); return; }
    const scanner = createKeyEchoScanner(token);
    let total = 0; let clean = false;
    try {
      yield { kind: "head", status: 200, headers: sanitizeResponseHeaders([...response.headers.entries()], { key: token }) };
      for (;;) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try { chunk = await reader.read(); } catch { yield settled(200, "provider_error"); return; }
        if (chunk.done) break;
        total += chunk.value.byteLength;
        if (total > responseLimit) { yield settled(200, "provider_error"); return; }
        const safe = scanner.push(chunk.value);
        if (safe.hit) { yield settled(200, "provider_error"); return; }
        if (safe.safe.byteLength > 0) yield { kind: "chunk", bytes: safe.safe };
      }
      const last = scanner.finish();
      if (last.hit) { yield settled(200, "provider_error"); return; }
      if (last.safe.byteLength > 0) yield { kind: "chunk", bytes: last.safe };
      clean = true;
      yield settled(200, "ok");
    } finally {
      // A caller that stopped early, a cut-off, an over-long answer or an echo: nothing more is read.
      if (!clean) await reader.cancel().catch(() => undefined);
    }
  }

  return {
    capabilities: { schemes: ["header:x-api-key"] },
    forward: (_scope: ModelEgressScope, frame: ModelEgressFrame, opts?: { readonly signal?: AbortSignal }) => forward(frame, opts?.signal),
  };
}
