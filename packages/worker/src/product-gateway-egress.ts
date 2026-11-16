// Bedrock v2 is opt-in via `family: "bedrock"`; it uses only the four product operations, strips all AWS/SDK credential headers
// through an allow list, and preserves binary event-stream bytes. No run-task wiring is introduced here.
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
  createKeyEchoScanner, keyEchoNeedles, classOfRefusal, familyErrorBody, modelEgressAllowedHeaders, parseModelEgressFrame, refusalResponse, sanitizeResponseHeaders,
  MODEL_EGRESS_MIN_KEY_CHARS,
  type KeyEchoScanner, type ModelEgressFamily, type ModelEgress, type ModelEgressClass, type ModelEgressEvent, type ModelEgressFrame, type ModelEgressRefusal, type ModelEgressScope, type ModelEgressSettle,
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
// Bedrock uses the same frames and task-token transport. Only an explicitly selected family enables it.
// Values from the pinned v2 contract; error text is selected from this fixed list, never repeated from a response.
const BEDROCK_MODEL = /^[a-z0-9][a-z0-9.:-]{1,200}$/u;
const BEDROCK_PATH = /^\/model\/([^/]+)\/(converse|converse-stream|invoke|invoke-with-response-stream)$/u;
const BEDROCK_REFUSALS = [
  { status: 400, type: "not_allowed", message: "this Bedrock feature is not offered on the product route: guardrails, priority or latency tiers, provisioned throughput and application inference profiles are refused" },
  { status: 400, type: "not_allowed", message: "this model is not one your company picked for its Bedrock connection" },
  { status: 400, type: "not_allowed", message: "this model is not offered this way on the product route: Converse for every picked model, InvokeModel only for Claude's Anthropic body and Titan text embeddings" },
  { status: 404, type: "not_set_up", message: "no Bedrock role is connected for this project" },
  { status: 403, type: "model_not_enabled", message: "this model is not enabled yet in your AWS account: an AWS admin opens it once in the Bedrock console, then try again" },
  { status: 502, type: "product_key_refused", message: "not run: AWS refused the connected role (check the Bedrock connection in Settings)" },
  { status: 429, type: "provider_limited", message: "Bedrock is limiting this account; try again later" },
  { status: 429, type: "provider_quota", message: "the Bedrock quota for this account is used up" },
  { status: 400, type: "provider_refused", message: "the provider refused this request" },
  { status: 503, type: "unavailable", message: "model access unavailable" },
] as const;
const BEDROCK_WORDS: Readonly<Record<string, ModelEgressRefusal>> = {
  not_allowed: "not_allowed", not_set_up: "not_found", model_not_enabled: "not_allowed",
  product_key_refused: "key_refused", provider_limited: "rate_limit", provider_quota: "quota", provider_refused: "bad_request",
};

/** The SDK percent-encodes model colons. Decode one segment, validate it, then construct only a contract path. */
function bedrockPath(path: string, query: string): string | undefined {
  if (query !== "") return undefined; // v2 removes no query keys and admits none.
  const match = BEDROCK_PATH.exec(path);
  if (match === null) return undefined;
  let model: string;
  try { model = decodeURIComponent(match[1] as string); } catch { return undefined; }
  return !model.startsWith("arn:") && BEDROCK_MODEL.test(model) ? `/model/${model}/${match[2] as string}` : undefined;
}

/** Scan the same token spellings as v1, holding bytes across chunks without decoding/re-encoding event-stream CRCs. */
function binaryKeyScanner(key: string): KeyEchoScanner {
  const needles = keyEchoNeedles(key).map(needle => Buffer.from(needle, "utf8"));
  const hold = Math.max(...needles.map(needle => needle.length)) - 1;
  let carry = Buffer.alloc(0);
  let hit = false;
  const scan = (chunk: Uint8Array, final: boolean) => {
    if (hit) return { safe: new Uint8Array(0), hit: true };
    const bytes = Buffer.concat([carry, chunk]);
    if (needles.some(needle => bytes.includes(needle))) { hit = true; carry = Buffer.alloc(0); return { safe: new Uint8Array(0), hit: true }; }
    const cut = final ? bytes.length : Math.max(0, bytes.length - hold);
    carry = Buffer.from(bytes.subarray(cut));
    return { safe: bytes.subarray(0, cut), hit: false };
  };
  return { push: chunk => scan(chunk, false), finish: () => scan(new Uint8Array(0), true) };
}

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
  /** Defaults to Gemini. Bedrock product traffic is off unless this is explicitly `bedrock`. */
  readonly family?: "gemini" | "bedrock";
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
  invalid_request: "bad_request", provider_refused: "bad_request", request_too_large: "too_large", too_large: "too_large",
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

function* refused(family: ModelEgressFamily, word: ModelEgressRefusal, options: { overrun?: boolean; retryAfter?: string } = {}): Generator<ModelEgressEvent> {
  const answer = refusalResponse(family, word, options.overrun === true ? { overrun: true } : {});
  const headers: Array<[string, string]> = [...answer.headers, ...(options.retryAfter === undefined ? [] : [["retry-after", options.retryAfter] as [string, string]])];
  yield { kind: "head", status: answer.status, headers };
  yield { kind: "chunk", bytes: answer.body };
  yield settled(answer.status, word === "cap" ? "cap" : word === "key_refused" || word === "rate_limit" || word === "quota" || word === "overloaded" ? word : "refused", word);
}
function* unreachable(family: ModelEgressFamily, status = 502): Generator<ModelEgressEvent> {
  yield { kind: "head", status, headers: [["content-type", "application/json"]] };
  yield { kind: "chunk", bytes: familyErrorBody(family, status, UNREACHABLE, "rovara_unreachable") };
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
  const family = options.family ?? "gemini";
  const allowedHeaders = family === "bedrock" ? modelEgressAllowedHeaders("bedrock") : ALLOWED_HEADERS;
  if (typeof options.tokenSource !== "function") throw new Error("the product gateway needs a task token source");
  const transport = options.fetch ?? fetch;
  const responseLimit = typeof options.responseBytes === "number" && Number.isSafeInteger(options.responseBytes) && options.responseBytes > 0 ? options.responseBytes : PRODUCT_BRIDGE_RESPONSE_BYTES;

  async function* forward(input: ModelEgressFrame, signal: AbortSignal | undefined): AsyncGenerator<ModelEgressEvent> {
    const parsed = parseModelEgressFrame(input);
    if (!parsed.ok) { yield* refused(family, parsed.refusal); return; }
    const frame = parsed.frame;
    if (family === "bedrock" && frame.headers.some(([name]) => /^(?:x-amz-bedrock-|x-amzn-bedrock-)/iu.test(name))) {
      const message = BEDROCK_REFUSALS[0].message;
      yield { kind: "head", status: 400, headers: [["content-type", "application/json"], ["x-rovara-refusal", "not_allowed"]] };
      yield { kind: "chunk", bytes: new TextEncoder().encode(JSON.stringify({ message, error: { type: "not_allowed", message } })) };
      yield settled(400, "refused", "not_allowed");
      return;
    }
    let path: string | undefined;
    let query: string | undefined;
    if (family === "bedrock") {
      path = bedrockPath(frame.path, frame.query);
      query = "";
    } else {
      const match = PATH.exec(frame.path);
      if (match !== null && MODEL.test(match[2] as string)) {
        path = frame.path;
        query = productQuery(frame.query, match[3] as string);
      }
    }
    if (frame.method !== "POST" || path === undefined || query === undefined) { yield* refused(family, "not_allowed"); return; }
    const headers: Record<string, string> = {};
    for (const [name, value] of frame.headers) {
      const lower = name.toLowerCase();
      if (allowedHeaders.includes(lower) && HEADER_VALUE.test(value) && headers[lower] === undefined) headers[lower] = value;
    }
    let token: string | undefined;
    try { const value = await options.tokenSource(); token = typeof value === "string" && TOKEN.test(value) && value.length >= MODEL_EGRESS_MIN_KEY_CHARS ? value : undefined; } catch { token = undefined; }
    if (token === undefined) { yield* refused(family, "not_allowed"); return; }

    let response: Response;
    try {
      response = await transport(`${base}${PRODUCT_BRIDGE_CONTRACT.routePrefix}${family}${path}${query === "" ? "" : `?${query}`}`, {
        method: "POST", redirect: "error", ...(signal === undefined ? {} : { signal }),
        headers: { ...headers, [PRODUCT_BRIDGE_CONTRACT.tokenHeader]: token },
        body: frame.body,
      });
    } catch { yield* unreachable(family); return; }

    if (response.status !== 200) {
      const error = gatewayError(await boundedBytes(response, ERROR_BODY_BYTES));
      if (family === "bedrock" && error !== undefined) {
        const candidates = BEDROCK_REFUSALS.filter(r => r.type === error.type && r.status === response.status);
        const fixed = candidates.find(r => r.message === error.message) ?? candidates[0];
        if (fixed !== undefined) {
          const word = BEDROCK_WORDS[fixed.type];
          yield { kind: "head", status: fixed.status, headers: [["content-type", "application/json"], ...(word === undefined ? [] : [["x-rovara-refusal", word] as [string, string]])] };
          yield { kind: "chunk", bytes: new TextEncoder().encode(JSON.stringify({ message: fixed.message, error: { type: fixed.type, message: fixed.message } })) };
          yield settled(fixed.status, word === undefined ? "provider_error" : classOfRefusal(word), word);
          return;
        }
      }
      const word = error === undefined ? undefined : GATEWAY_REFUSALS[error.type];
      if (word === undefined) { yield* unreachable(family, response.status >= 400 && response.status <= 599 ? response.status : 502); return; }
      const retry = response.headers.get("retry-after");
      yield* refused(family, word, {
        ...(word === "cap" && error?.message === OVER_BY_ONE_CALL ? { overrun: true } : {}),
        ...(retry !== null && /^\d{1,4}$/u.test(retry) ? { retryAfter: retry } : {}),
      });
      return;
    }

    const reader = (response.body as ReadableStream<Uint8Array> | null)?.getReader();
    if (reader === undefined) { yield { kind: "head", status: 200, headers: [] }; yield settled(200, "provider_error"); return; }
    const scanner = family === "bedrock" ? binaryKeyScanner(token) : createKeyEchoScanner(token);
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
