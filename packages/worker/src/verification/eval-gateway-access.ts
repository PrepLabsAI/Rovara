// The production `EvalModelAccess`: the model gateway's whole-stage eval hold on its product route, reached over HTTP with the
// task token Code mints (#670). Written against the gateway's published contract only:
//
//   POST <gateway>/v1/product/eval/hold     {grant, calls, costMicros}             -> 200 {scope, calls, costMicros, ...}; anything else holds nothing
//   POST <gateway>/v1/product/gemini/<path>[?query]   x-rovara-eval-scope, x-api-key -> 200 application/x-ndjson: one head, base64 chunks, one settle
//   POST <gateway>/v1/product/vertex/<path>[?query]   (L4-EVV: a Vertex AI shaped call, the same scope, the same answer; google publisher only)
//   POST <gateway>/v1/product/eval/release  {scope, calls, costMicros, unknown}    -> 200, once
//   POST <gateway>/v1/product/bedrock/model/<id>/<operation>   x-api-key only (RF-5, route A: NO scope header, and not part of the stage's hold) -> the company's own AWS role answers; see below
//
// Money rules, each with a test (tests/unit/worker-eval-gateway-access.test.ts):
// - A hold is used only when the gateway answered 200 with a readable scope and EXACTLY the asked calls and cost; a different
//   amount is released at once (nothing spent) and refused. Any other answer, a fault or no token is a refusal with nothing held.
// - Each call is ONE attempt, never retried. A call the adapter itself refuses (stage stopped, held count used, known spend reached
//   the held cost, a frame the product route would not take, no token) sends nothing and settles `cap` or `refused` at cost 0.
// - Any non-200 or non-NDJSON answer, a fault after the request may have left, an abort, or a stream that is malformed, over-long
//   or ends without exactly one settle is an UNKNOWN cost: the iterator throws a fixed error (the eval meter's "provider_error,
//   cost unknown"), the stage takes no further call, and the release says `unknown`, so the gateway keeps the whole hold.
// - The gateway enforces the hold (#704, DEC 165): it passes the held cost by at most one call and flags that call's settle
//   `overrun`. This adapter is a second line: once its known spend reaches the held cost (or an overrun settle arrives) it sends
//   nothing more, and a settle that takes its known spend past the held cost is flagged `overrun` even if the gateway did not say so.
// - Release is sent once: with the larger of the meter's and the adapter's own call count and known spend, and `unknown` when either
//   side lost a cost or a call is still open.
// - RF-5 (Bedrock, route A): a call whose path is a Bedrock product path (`/model/<id>/<operation>`) is NOT sent under the stage's hold: the gateway refuses a Bedrock path that carries an eval scope header, and it holds, caps and
//   counts every Bedrock call itself (per call, under the company's gateway cap; the customer's own AWS account pays). It goes through `createProductGatewayEgress({family: "bedrock"})` with the same task token source, one at a
//   time (the gateway admits one call in flight per company and source), and settles `costMicros: 0` on THIS line: the stage counts the call (so the held call count, the call deadline and "any call that did not answer ok makes the
//   round Not run" all apply) but not its dollars. The hold's own cost is released unspent. The words for a person: "counted by the company's gateway cap".
// - No header, token, provider word or error text leaves this file: faults are fixed words.
import {
  MODEL_EGRESS_CLASSES, MODEL_EGRESS_REFUSALS, parseModelEgressFrame, refusalResponse, sanitizeResponseHeaders,
  type ModelEgress, type ModelEgressEvent, type ModelEgressFrame, type ModelEgressRefusal, type ModelEgressScope, type ModelEgressSettle,
} from "@agentx/contracts";
import { createProductGatewayEgress } from "../product-gateway-egress.js";
import type { EvalModelAccess, EvalModelHold } from "./eval-model-access.js";

export const EVAL_GATEWAY_HOLD_PATH = "/v1/product/eval/hold";
export const EVAL_GATEWAY_RELEASE_PATH = "/v1/product/eval/release";
export const EVAL_GATEWAY_GEMINI_PREFIX = "/v1/product/gemini";
export const EVAL_GATEWAY_VERTEX_PREFIX = "/v1/product/vertex";
export const EVAL_GATEWAY_SCOPE_HEADER = "x-rovara-eval-scope";
/** The hold and release requests' own deadline. Default 30 seconds. */
export const EVAL_GATEWAY_CONTROL_TIMEOUT_MS = 30_000;
/** All NDJSON bytes one call's answer may hold: the 10 MiB answer limit in base64, plus the event framing. */
export const EVAL_GATEWAY_STREAM_BYTES = 16 * 1024 * 1024;
const CONTROL_BODY_BYTES = 64 * 1024;

export type EvalGatewayTokenSource = () => Promise<string>;
export interface EvalGatewayAccessOptions {
  /** Injected for tests; default the Node built-in. */
  readonly fetch?: typeof fetch;
  readonly controlTimeoutMs?: number;
  readonly streamBytes?: number;
}

/** The one fixed fault of a call whose cost could not be read. Never carries a provider word, a header or the token. */
export class EvalGatewayUnknownCost extends Error {
  constructor() { super("eval gateway call failed"); this.name = "EvalGatewayUnknownCost"; }
}

const TOKEN = /^[^\s]{1,16384}$/u;
const SCOPE = /^[A-Za-z0-9._~-]{1,128}$/u;
const B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
/** The two Gemini calls the product route takes; anything else (a dot segment, an encoded character, another operation) never leaves. */
const GEMINI_PATH = /^\/(?:v1|v1beta)\/models\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}:(?:generateContent|streamGenerateContent)$/u;
/**
 * The two Vertex AI calls the product route takes, in the shape the gateway's own parser reads (`/v1` or `/v1beta1`, a project, a location, Google's own publisher, a model, one of the two operations). The project and location are
 * the CLIENT's words and are not trusted here (this adapter does not know the connected ones): the gateway builds the upstream path from its key store and refuses any pair that is not the connected one or Rovara's placeholder.
 * Anything else (the express form with no project, another publisher, a dot segment, an encoded character, another operation) never leaves.
 */
const VERTEX_PATH = /^\/(?:v1|v1beta1)\/projects\/(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|[0-9]{1,20})\/locations\/(?:global|[a-z]{2,15}-[a-z]{2,15}[0-9]{1,2})\/publishers\/google\/models\/[a-z0-9][a-z0-9.-]{0,95}:(?:generateContent|streamGenerateContent)$/u;
/** The shape of a Bedrock product call's path (RF-5). Only the shape decides the route; the product egress checks the model id, the operation and the headers again before anything leaves. */
const BEDROCK_PATH = /^\/model\/[^/]+\/(?:converse|converse-stream|invoke|invoke-with-response-stream)$/u;
const QUERIES: readonly string[] = ["", "alt=sse"];
/** The only frame headers that leave: the body's type and what the client accepts. Credentials, cookies and `x-rovara-*` never do. */
const FORWARDED_HEADERS: readonly string[] = ["content-type", "accept"];
const HEADER_VALUE = /^[\x20-\x7e]{1,1024}$/u;
const classes: readonly string[] = MODEL_EGRESS_CLASSES;
const refusals: readonly string[] = MODEL_EGRESS_REFUSALS;

const whole = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const positive = (n: unknown, fallback: number): number => (typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : fallback);
const rec = (v: unknown): Record<string, unknown> | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : undefined);

/** The gateway's base: https, or http only to this machine (tests, a local gateway); no credentials, query or fragment. */
function gatewayBase(raw: string): string {
  let url: URL | undefined;
  try { url = new URL(raw); } catch { url = undefined; }
  const local = url !== undefined && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url === undefined || !(url.protocol === "https:" || (url.protocol === "http:" && local)) || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new Error("the eval gateway address must be an https URL with no credentials, query or fragment");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/u, "")}`;
}

/** Reads at most `limit` bytes of a body as text; more, or a fault, is undefined. */
async function boundedText(response: Response, limit: number): Promise<string | undefined> {
  const reader = (response.body as ReadableStream<Uint8Array> | null)?.getReader();
  if (reader === undefined) return "";
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
  return new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(parts));
}
async function discard(response: Response): Promise<void> { try { await response.body?.cancel(); } catch { /* nothing to read */ } }

/** One of the adapter's own refusals as events: a head with the fixed refusal answer, its body, and a settle at cost 0. Nothing was sent. */
function* ownRefusal(word: Extract<ModelEgressRefusal, "cap" | "not_allowed" | "not_found">, family: "gemini" | "vertex" | "bedrock" = "gemini"): Generator<ModelEgressEvent> {
  const answer = refusalResponse(family, word);
  yield { kind: "head", status: answer.status, headers: answer.headers };
  yield { kind: "chunk", bytes: answer.body };
  yield { kind: "settle", status: answer.status, class: word === "cap" ? "cap" : "refused", refusal: word, costMicros: 0, estimated: false };
}

/** The settle the gateway sent, checked field by field; undefined when any field is not what the contract says. */
function readSettle(event: Record<string, unknown>): ModelEgressSettle | undefined {
  const { status, class: cls, refusal, costMicros, estimated, overrun, inputTokens, outputTokens } = event;
  if (!Number.isInteger(status) || (status as number) < 100 || (status as number) > 599) return undefined;
  if (typeof cls !== "string" || !classes.includes(cls) || !whole(costMicros) || typeof estimated !== "boolean") return undefined;
  if (refusal !== undefined && (typeof refusal !== "string" || !refusals.includes(refusal))) return undefined;
  if (overrun !== undefined && typeof overrun !== "boolean") return undefined;
  if ((inputTokens !== undefined && !whole(inputTokens)) || (outputTokens !== undefined && !whole(outputTokens))) return undefined;
  return {
    kind: "settle", status: status as number, class: cls as ModelEgressSettle["class"], costMicros, estimated,
    ...(refusal === undefined ? {} : { refusal: refusal as ModelEgressRefusal }),
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(overrun === true ? { overrun: true } : {}),
  };
}
function readHead(event: Record<string, unknown>): ModelEgressEvent | undefined {
  const { status, headers } = event;
  if (!Number.isInteger(status) || (status as number) < 100 || (status as number) > 599 || !Array.isArray(headers) || headers.length > 64) return undefined;
  if (!headers.every((pair: unknown) => Array.isArray(pair) && pair.length === 2 && typeof pair[0] === "string" && typeof pair[1] === "string")) return undefined;
  return { kind: "head", status: status as number, headers: sanitizeResponseHeaders(headers as Array<[string, string]>) };
}

/**
 * The HTTP `EvalModelAccess` for the gateway at `gatewayUrl`. `tokenSource` returns the current task token (in the worker:
 * `async () => (await modelAccessSource(...)()).apiKey`); it is asked once per request and never logged. Throws only for an
 * unusable address (configuration), never at hold or call time.
 */
export function createEvalGatewayAccess(gatewayUrl: string, tokenSource: EvalGatewayTokenSource, options: EvalGatewayAccessOptions = {}): EvalModelAccess {
  const base = gatewayBase(gatewayUrl);
  if (typeof tokenSource !== "function") throw new Error("the eval gateway needs a task token source");
  const transport = options.fetch ?? fetch;
  // RF-5: the Bedrock product route of the same gateway, with the same task token source and transport. Made once; it never sees the stage's scope.
  const bedrockEgress = createProductGatewayEgress({ gatewayUrl: base, family: "bedrock", tokenSource, fetch: transport });
  const controlTimeoutMs = positive(options.controlTimeoutMs, EVAL_GATEWAY_CONTROL_TIMEOUT_MS);
  const streamLimit = positive(options.streamBytes, EVAL_GATEWAY_STREAM_BYTES);
  const token = async (): Promise<string | undefined> => {
    try { const value = await tokenSource(); return typeof value === "string" && TOKEN.test(value) ? value : undefined; } catch { return undefined; }
  };
  /** One control request (hold or release): JSON in, bounded JSON out; undefined for anything but a 200 JSON answer. */
  async function control(path: string, body: unknown, apiKey: string): Promise<Record<string, unknown> | undefined> {
    const response = await transport(`${base}${path}`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(controlTimeoutMs),
      headers: { "content-type": "application/json", accept: "application/json", "x-api-key": apiKey },
      body: JSON.stringify(body),
    });
    if (response.status !== 200 || !(response.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) { await discard(response); return undefined; }
    const text = await boundedText(response, CONTROL_BODY_BYTES);
    if (text === undefined) return undefined;
    try { return rec(JSON.parse(text)); } catch { return undefined; }
  }

  async function release(scope: string, spent: { calls: number; costMicros: number; unknown: boolean }): Promise<boolean> {
    const apiKey = await token();
    if (apiKey === undefined) return false;
    try { return (await control(EVAL_GATEWAY_RELEASE_PATH, { scope, calls: spent.calls, costMicros: spent.costMicros, unknown: spent.unknown }, apiKey)) !== undefined; } catch { return false; }
  }

  return {
    async hold(input) {
      const grant = rec(input?.grant);
      const calls = input?.calls; const costMicros = input?.costMicros;
      if (grant === undefined || !whole(calls) || calls < 1 || !whole(costMicros) || costMicros < 1) return undefined;
      // Exactly the grant's nine fields: the gateway refuses any other key, and nothing else of the caller's object leaves.
      const sent = {
        company: grant.company, project: grant.project, selection: grant.selection, role: grant.role, inputsDigest: grant.inputsDigest,
        provider: grant.provider, connected: grant.connected, maxCalls: grant.maxCalls, maxCostMicros: grant.maxCostMicros,
      };
      const apiKey = await token();
      if (apiKey === undefined) return undefined;
      let answer: Record<string, unknown> | undefined;
      try { answer = await control(EVAL_GATEWAY_HOLD_PATH, { grant: sent, calls, costMicros }, apiKey); } catch { return undefined; }
      if (answer === undefined || typeof answer.scope !== "string" || !SCOPE.test(answer.scope)) return undefined;
      const scope = answer.scope;
      if (answer.calls !== calls || answer.costMicros !== costMicros) {
        // Not the hold that was asked for: give it all back (nothing was spent under it) and refuse.
        await release(scope, { calls: 0, costMicros: 0, unknown: false });
        return undefined;
      }
      return stageHold(scope, calls, costMicros);
    },
  };

  function stageHold(scope: string, heldCalls: number, heldCost: number): EvalModelHold {
    const handle = Object.freeze({}) as unknown as ModelEgressScope;
    let forwarded = 0; let known = 0; let unknown = false; let stopped = false; let released = false; let open = 0;
    const lost = (): EvalGatewayUnknownCost => { unknown = true; return new EvalGatewayUnknownCost(); };

    // RF-5: Bedrock calls go one at a time (the gateway admits one call in flight per company and source; a second at once would read `busy`, which is a cap refusal and would make the round Not run).
    let bedrockTurn: Promise<void> = Promise.resolve();
    /** One Bedrock product call, outside the stage's hold. The same second lines as a Gemini call (released, stopped, held count used), the same unknown-cost rule (no settle: unknown), and the settle's cost (0) is added to the known spend. */
    async function* bedrockCall(input: ModelEgressFrame, signal: AbortSignal | undefined): AsyncGenerator<ModelEgressEvent> {
      if (released || stopped || unknown || forwarded >= heldCalls || known >= heldCost) { yield* ownRefusal("cap", "bedrock"); return; }
      forwarded++; open++;
      let delivered = false;
      const before = bedrockTurn;
      let next!: () => void;
      bedrockTurn = new Promise<void>(resolve => { next = resolve; });
      try {
        await before;
        if (signal?.aborted === true) throw lost();
        for await (const event of bedrockEgress.forward(handle, input, signal === undefined ? undefined : { signal })) {
          if (event.kind === "settle") { known += event.costMicros; if (!Number.isSafeInteger(known)) throw lost(); delivered = true; }
          yield event;
        }
      } finally {
        open--; next();
        if (!delivered) unknown = true;
      }
    }

    async function* forward(given: ModelEgressScope, input: ModelEgressFrame, signal: AbortSignal | undefined): AsyncGenerator<ModelEgressEvent> {
      if (given !== handle) { yield* ownRefusal("not_found"); return; }
      const parsed = parseModelEgressFrame(input);
      if (!parsed.ok) { yield* ownRefusal("not_allowed"); return; }
      const frame = parsed.frame;
      // The path's own shape decides the product route; a Vertex path is never sent to the Gemini route and the other way round.
      const vertex = VERTEX_PATH.test(frame.path);
      const family = vertex ? "vertex" : "gemini";
      if (frame.method !== "POST" || !(vertex || GEMINI_PATH.test(frame.path)) || !QUERIES.includes(frame.query)) { yield* ownRefusal("not_allowed", family); return; }
      const headers: Record<string, string> = {};
      for (const [name, value] of frame.headers) {
        const lower = name.toLowerCase();
        if (FORWARDED_HEADERS.includes(lower) && HEADER_VALUE.test(value) && headers[lower] === undefined) headers[lower] = value;
      }
      const apiKey = await token();
      if (apiKey === undefined) { yield* ownRefusal("not_allowed", family); return; }
      // The #704 rule's second line, checked after the last await before sending: nothing more once the stage was released or
      // stopped (an overrun settle, an unknown cost), its held count is used, or its known spend reached the held cost.
      if (released || stopped || unknown || forwarded >= heldCalls || known >= heldCost) { yield* ownRefusal("cap", family); return; }
      forwarded++; open++;
      // Set when the settle is handed over. A caller that stops reading before it (the meter's own answer limit) leaves the
      // call's cost unknown here too, and its body is cancelled at once.
      let delivered = false; let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        let response: Response;
        try {
          response = await transport(`${base}${vertex ? EVAL_GATEWAY_VERTEX_PREFIX : EVAL_GATEWAY_GEMINI_PREFIX}${frame.path}${frame.query === "" ? "" : `?${frame.query}`}`, {
            method: "POST", redirect: "error", ...(signal === undefined ? {} : { signal }),
            headers: { ...headers, [EVAL_GATEWAY_SCOPE_HEADER]: scope, "x-api-key": apiKey },
            body: frame.body,
          });
        } catch { throw lost(); }
        if (response.status !== 200 || !(response.headers.get("content-type") ?? "").toLowerCase().startsWith("application/x-ndjson")) { await discard(response); throw lost(); }
        reader = (response.body as ReadableStream<Uint8Array> | null)?.getReader();
        if (reader === undefined) throw lost();
        const decoder = new TextDecoder("utf-8", { fatal: true });
        const body = reader;
        let state: "start" | "body" | "settled" = "start"; let buffered = ""; let scanned = 0; let total = 0; let settle: ModelEgressSettle | undefined;
        const take = (line: string): ModelEgressEvent | undefined => {
          if (line.trim() === "") return undefined;
          if (state === "settled") throw lost();
          let event: Record<string, unknown> | undefined;
          try { event = rec(JSON.parse(line)); } catch { throw lost(); }
          if (event?.kind === "head" && state === "start") { const head = readHead(event); if (head === undefined) throw lost(); state = "body"; return head; }
          if (event?.kind === "chunk" && state === "body") {
            if (typeof event.b64 !== "string" || !B64.test(event.b64)) throw lost();
            return { kind: "chunk", bytes: new Uint8Array(Buffer.from(event.b64, "base64")) };
          }
          if (event?.kind === "settle" && state === "body") { settle = readSettle(event); if (settle === undefined) throw lost(); state = "settled"; return undefined; }
          throw lost();
        };
        try {
          for (;;) {
            let chunk: Awaited<ReturnType<typeof body.read>>;
            try { chunk = await body.read(); } catch { throw lost(); }
            if (chunk.done) break;
            total += chunk.value.byteLength;
            if (total > streamLimit) throw lost();
            try { buffered += decoder.decode(chunk.value, { stream: true }); } catch { throw lost(); }
            // Scanned from where the last scan stopped, so one long line is not read again for every chunk.
            let newline = buffered.indexOf("\n", scanned);
            while (newline >= 0) {
              const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1);
              const event = take(line);
              if (event !== undefined) yield event;
              newline = buffered.indexOf("\n");
            }
            scanned = buffered.length;
          }
          try { buffered += decoder.decode(); } catch { throw lost(); }
          const last = take(buffered);
          if (last !== undefined) yield last;
        } catch (error) {
          await body.cancel().catch(() => undefined);
          throw error instanceof EvalGatewayUnknownCost ? error : lost();
        }
        if (settle === undefined) throw lost();
        // The stream ended cleanly after exactly one settle: its cost is known.
        known += settle.costMicros;
        if (!Number.isSafeInteger(known)) throw lost();
        const over = settle.overrun === true || known > heldCost;
        if (over) stopped = true;
        delivered = true;
        yield over ? { ...settle, overrun: true } : settle;
      } finally {
        open--;
        if (!delivered) { unknown = true; void reader?.cancel().catch(() => undefined); }
      }
    }

    return {
      scope: handle,
      // The path's own shape decides the lane (RF-5): a Bedrock product path under this hold's own scope goes to the Bedrock lane, anything else to the stage's own route.
      egress: { capabilities: { schemes: [] }, forward: (given, frame, opts) => (given === handle && BEDROCK_PATH.test(String(frame?.path)) ? bedrockCall(frame, opts?.signal) : forward(given, frame, opts?.signal)) } satisfies ModelEgress,
      async release(spent) {
        if (released) throw new Error("eval hold already released");
        released = true;
        const report = rec(spent);
        const theirs = report !== undefined && whole(report.calls) && whole(report.costMicros) && typeof report.unknown === "boolean"
          ? { calls: report.calls, costMicros: report.costMicros, unknown: report.unknown } : { calls: 0, costMicros: 0, unknown: true };
        const final = {
          calls: Math.max(theirs.calls, forwarded),
          costMicros: Math.max(theirs.costMicros, known),
          unknown: theirs.unknown || unknown || open > 0,
        };
        if (!(await release(scope, final))) throw new Error("eval hold could not be released");
      },
    };
  }
}
