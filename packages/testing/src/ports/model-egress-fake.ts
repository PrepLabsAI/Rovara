// The fake `model-egress` adapter world: an in-process adapter built ONLY from the core's pure rules (`@agentx/contracts` `model-egress/`), a fake provider behind an injected transport, and a meter. It is the reference the
// conformance suite runs on in this lane's CI; Code's laptop adapter (F1-c) and Cloud's function adapter (F1-e) must pass the same suite later. Nothing here opens a socket: the transport is a function, and its answer is scripted.
//
// `mutation` switches on ONE named defect, each the way a real adapter could go wrong, so the tests can show that the suite fails on it (a suite that cannot fail proves nothing).
import {
  buildOutboundRequest, classifyProviderResponse, classOfRefusal, createKeyEchoScanner, createUsageScanner, familyErrorBody, isOverCap, isRedirectStatus, modelOfBody, parseModelEgressFrame, refusalResponse,
  reserveEstimate, sanitizeResponseHeaders, scrubResponseBody, settleCost, usageFromBody,
  type ModelEgress, type ModelEgressConnection, type ModelEgressEvent, type ModelEgressFamily, type ModelEgressFrame, type ModelEgressRefusal, type ModelEgressRow, type ModelEgressScope, type ModelEgressSettle, type OutboundRequest,
} from "@agentx/contracts";
import { fixtureToken } from "./model-egress-fixtures.js";

export type ModelEgressMutation =
  | "source_by_id_only" // looks a source up by its id alone: another company's source is found
  | "retry_on_fault" // retries once after a fault or a 5xx
  | "retry_on_429" // retries once after a provider 429
  | "forward_inbound_credentials" // sends the client's own credential headers on
  | "shared_token_cache" // caches a minted token by source id, not by company
  | "shared_meter" // keeps one meter per source id, not per company
  | "ignore_cap" // never refuses on the cap
  | "host_from_frame" // takes the host from a client header
  | "skip_scrub" // returns provider bodies as they are
  | "log_request" // writes the request headers into the log
  | "not_found_differs" // says something different for another company's source
  | "no_settle_on_refusal" // forgets the settle after a refusal
  | "reservation_released_on_cut" // charges only what a cut-off stream showed
  | "unfiltered_headers" // sends every provider header back
  | "unscanned_headers" // keeps allow-listed headers without looking in their values for the key
  | "two_credentials" // adds a second credential
  | "pass_redirect" // hands a provider 3xx back to the client instead of refusing it
  | "overrun_on_any_excess" // blocks the task after ANY call that costs more than its estimate
  | "no_overrun_block" // keeps serving a task after a call settled above its reservation
  | "default_company_on_broken_scope" // a scope it cannot read serves the first company instead of being refused
  | "wrong_row_host"; // sends a row's call (and its key) to ANOTHER row's host

export interface FakeBehaviour {
  /** The provider's status. Default 200. */
  readonly status?: number;
  readonly headers?: ReadonlyArray<readonly [string, string]>;
  /** The body, as text; default is an echo of the request with usage. */
  readonly body?: string;
  /** Streamed in these pieces instead of one body. */
  readonly chunks?: readonly string[];
  /** The stream ends with an error after the chunks (a cut-off). */
  readonly cutOff?: boolean;
  /** The transport throws instead of answering. */
  readonly fault?: boolean;
  /** The provider echoes the credential it received in the body (and in a header), as a careless provider might. */
  readonly echoCredential?: boolean;
}

export interface FakeProvider {
  /** Every request the transport was given, in order. */
  readonly calls: OutboundRequest[];
  script(...behaviours: FakeBehaviour[]): void;
  reset(): void;
  readonly transport: (request: OutboundRequest, signal?: AbortSignal) => Promise<{ status: number; headers: Array<[string, string]>; body: AsyncIterable<Uint8Array> }>;
}

const enc = (text: string) => new TextEncoder().encode(text);
const FAKE_USAGE = { input: 10, output: 5 };

function defaultBody(family: ModelEgressFamily, request: OutboundRequest): string {
  const echo = new TextDecoder().decode(request.body).slice(0, 2000);
  switch (family) {
    case "gemini":
    case "vertex":
      return JSON.stringify({ candidates: [{ content: { parts: [{ text: echo }] } }], usageMetadata: { promptTokenCount: FAKE_USAGE.input, candidatesTokenCount: FAKE_USAGE.output } });
    case "anthropic_messages":
      return JSON.stringify({ content: [{ type: "text", text: echo }], usage: { input_tokens: FAKE_USAGE.input, output_tokens: FAKE_USAGE.output } });
    case "cohere":
      return JSON.stringify({ text: echo, meta: { billed_units: { input_tokens: FAKE_USAGE.input, output_tokens: FAKE_USAGE.output } } });
    default:
      return JSON.stringify({ choices: [{ message: { content: echo } }], usage: { prompt_tokens: FAKE_USAGE.input, completion_tokens: FAKE_USAGE.output } });
  }
}

/** A provider behind the transport: answers per script, then by default. It knows the rows only to answer in the right family's shape. */
export function createFakeProvider(rows: readonly ModelEgressRow[]): FakeProvider {
  const calls: OutboundRequest[] = [];
  let queue: FakeBehaviour[] = [];
  const familyOf = (host: string): ModelEgressFamily => rows.find((row) => row.hosts.includes(host))?.family ?? "openai_compatible";
  return {
    calls,
    script(...behaviours) {
      queue = [...queue, ...behaviours];
    },
    reset() {
      calls.length = 0;
      queue = [];
    },
    async transport(request) {
      calls.push(request);
      const behaviour = queue.shift() ?? {};
      if (behaviour.fault === true) throw new Error("the fake provider connection failed");
      const family = familyOf(request.host);
      const credential = request.headers.map(([, value]) => value).join(" ") + request.query;
      const body = behaviour.echoCredential === true ? JSON.stringify({ error: { message: `Incorrect API key provided: ${credential}` }, echoed: credential }) : (behaviour.body ?? defaultBody(family, request));
      const headers: Array<[string, string]> = (behaviour.headers ?? [["content-type", "application/json"]]).map(([name, value]) => [name, value] as [string, string]);
      if (behaviour.echoCredential === true) headers.push(["set-cookie", `session=${credential}`], ["x-echo", credential], ["x-request-id", `echo-${credential}`], ["request-id", credential]);
      const pieces = behaviour.chunks ?? [body];
      return {
        status: behaviour.status ?? 200,
        headers,
        body: (async function* () {
          for (const piece of pieces) yield enc(piece);
          if (behaviour.cutOff === true) throw new Error("the fake provider stream was cut off");
        })(),
      };
    },
  };
}

export interface FakeSource {
  readonly company: string;
  readonly id: string;
  readonly row: ModelEgressRow;
  readonly connection: ModelEgressConnection;
  /** The stored key (key schemes); for a token scheme, what the minter derives its token from. */
  readonly key: string;
  capMicros: number;
}

export interface FakeEgressOptions {
  readonly rows: readonly ModelEgressRow[];
  readonly sources: readonly FakeSource[];
  readonly provider: FakeProvider;
  readonly mutation?: ModelEgressMutation;
}

interface FakeScope {
  readonly company: string;
  readonly source: string;
}
const scopeOf = (value: ModelEgressScope): FakeScope | undefined => {
  try {
    const held = value as unknown as Partial<FakeScope> | undefined;
    const company = held?.company;
    const source = held?.source;
    return typeof company === "string" && company !== "" && typeof source === "string" && source !== "" ? { company, source } : undefined;
  } catch {
    // A scope that cannot even be read is a scope nobody can be served under.
    return undefined;
  }
};
/** Builds the opaque scope the way a real adapter's capability would (here: a plain pair). */
export const fakeScope = (company: string, source: string): ModelEgressScope => ({ company, source }) as unknown as ModelEgressScope;

export interface FakeEgress {
  readonly adapter: ModelEgress;
  /** Settled micro-dollars for a company, over all its sources. */
  meterOf(company: string): number;
  setCap(company: string, micros: number): void;
  /** Fixed-field log lines, never a body or a header. */
  readonly logs: string[];
  /** How many tokens the fake minter has minted, per company (a warm adapter mints once per company). */
  readonly mints: Map<string, number>;
}

/** The token the fake minter makes for a company and a source: depends on both, so a token of A is not valid for B. */
export const fakeMintedToken = (company: string, source: string): string => fixtureToken(`${company}/${source}`);

export function createFakeEgress(options: FakeEgressOptions): FakeEgress {
  const { mutation } = options;
  const rowsById = new Map(options.rows.map((row) => [row.id, row]));
  const sources = new Map(options.sources.map((source) => [`${source.company}|${source.id}`, source]));
  const meters = new Map<string, { spent: number; reserved: number; overrun: boolean }>();
  const tokenCache = new Map<string, string>();
  const logs: string[] = [];
  const mints = new Map<string, number>();
  const meterKey = (source: FakeSource): string => (mutation === "shared_meter" ? source.id : `${source.company}|${source.id}`);
  const meterFor = (source: FakeSource) => {
    const key = meterKey(source);
    const held = meters.get(key) ?? { spent: 0, reserved: 0, overrun: false };
    meters.set(key, held);
    return held;
  };

  function findSource(scope: FakeScope): FakeSource | undefined {
    if (mutation === "source_by_id_only") return options.sources.find((source) => source.id === scope.source);
    return sources.get(`${scope.company}|${scope.source}`);
  }

  function credentialFor(source: FakeSource): string {
    if (source.row.scheme !== "gcp-oauth:federation" && source.row.scheme !== "gcp-oauth:key-file") return source.key;
    const cacheKey = mutation === "shared_token_cache" ? source.id : `${source.company}|${source.id}`;
    const cached = tokenCache.get(cacheKey);
    if (cached !== undefined) return cached;
    mints.set(source.company, (mints.get(source.company) ?? 0) + 1);
    const token = fakeMintedToken(source.company, source.id);
    tokenCache.set(cacheKey, token);
    return token;
  }

  async function* refuse(family: ModelEgressFamily, word: ModelEgressRefusal, extra: { capMicros?: number; overrun?: boolean } = {}): AsyncGenerator<ModelEgressEvent> {
    const answer = refusalResponse(family, word, extra);
    yield { kind: "head", status: answer.status, headers: answer.headers };
    yield { kind: "chunk", bytes: answer.body };
    if (mutation !== "no_settle_on_refusal") yield { kind: "settle", status: answer.status, class: classOfRefusal(word), refusal: word, costMicros: 0, estimated: false };
  }

  const adapter: ModelEgress = {
    capabilities: { schemes: ["bearer", "header:x-goog-api-key", "header:x-api-key", "header:api-key", "query:key", "gcp-oauth:federation", "gcp-oauth:key-file"] },
    async *forward(scopeValue, input, forwardOptions) {
      const parsed = parseModelEgressFrame(input);
      const catalogRow = parsed.ok ? rowsById.get(parsed.frame.row) : undefined;
      // The family for any answer that is not about a source comes from the public row, never from the source: "missing" and "another company's" cannot differ.
      const family: ModelEgressFamily = catalogRow?.family ?? "openai_compatible";
      if (!parsed.ok) {
        yield* refuse(family, parsed.refusal);
        return;
      }
      const frame: ModelEgressFrame = parsed.frame;
      let scope = scopeOf(scopeValue);
      if (scope === undefined && mutation === "default_company_on_broken_scope") scope = { company: options.sources[0]?.company ?? "", source: frame.row };
      const source = scope === undefined ? undefined : findSource(scope);
      if (source === undefined || catalogRow === undefined || source.row.id !== frame.row) {
        if (mutation === "not_found_differs" && scope !== undefined && [...sources.values()].some((other) => other.id === scope.source)) {
          yield* refuse(family, "not_allowed");
          return;
        }
        yield* refuse(family, "not_found");
        return;
      }
      const row = source.row;
      const secret = credentialFor(source);
      const built = buildOutboundRequest(row, source.connection, frame, secret);
      if (!built.ok) {
        yield* refuse(family, built.refusal);
        return;
      }
      let request: OutboundRequest = built.request;
      if (mutation === "host_from_frame") {
        const claimed = frame.headers.find(([name]) => name.toLowerCase() === "host")?.[1];
        if (claimed !== undefined) request = { ...request, host: claimed };
      }
      if (mutation === "forward_inbound_credentials") {
        const inbound = frame.headers.filter(([name]) => /^(authorization|x-api-key|x-goog-api-key|api-key)$/iu.test(name));
        request = { ...request, headers: [...request.headers, ...inbound] };
      }
      if (mutation === "wrong_row_host") {
        const other = options.rows.find((candidate) => candidate.id !== row.id && candidate.family !== "bedrock" && candidate.hosts[0] !== undefined);
        if (other !== undefined) request = { ...request, host: other.hosts[0] as string };
      }
      if (mutation === "two_credentials") request = { ...request, headers: [...request.headers, ["x-api-key", secret], ["authorization", `Bearer ${secret}`]] };
      if (mutation === "log_request") logs.push(JSON.stringify(request.headers));

      const meter = meterFor(source);
      if (meter.overrun && mutation !== "no_overrun_block") {
        // A call settled above its reservation: the task takes nothing more.
        logs.push(`row=${row.id} class=cap overrun`);
        yield* refuse(family, "cap", { capMicros: source.capMicros, overrun: true });
        return;
      }
      const reservation = reserveEstimate({ row, model: built.route.model ?? modelOfBody(built.request.body), inputBytes: built.request.body.byteLength, maxOutputTokens: built.maxOutputTokens, externalInput: built.externalInput });
      if (mutation !== "ignore_cap" && meter.spent + meter.reserved + reservation.reserveMicros > source.capMicros) {
        logs.push(`row=${row.id} class=cap`);
        yield* refuse(family, "cap", { capMicros: source.capMicros });
        return;
      }
      meter.reserved += reservation.reserveMicros;
      const release = (cost: number): void => {
        meter.reserved -= reservation.reserveMicros;
        meter.spent += cost;
      };

      // ONE attempt (a retry after a fault can double-spend); the mutations retry.
      let response: Awaited<ReturnType<FakeProvider["transport"]>> | undefined;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        let faulted = false;
        try {
          response = await options.provider.transport(request, forwardOptions?.signal);
        } catch {
          response = undefined;
          faulted = true;
        }
        const again = (mutation === "retry_on_fault" && (faulted || (response?.status ?? 0) >= 500)) || (mutation === "retry_on_429" && response?.status === 429);
        if (!again) break;
      }
      if (response === undefined) {
        release(0);
        const message = "The provider could not be reached.";
        const body = familyErrorBody(row.family, 502, message, "rovara_unreachable");
        logs.push(`row=${row.id} class=provider_error`);
        yield { kind: "head", status: 502, headers: [["content-type", "application/json"]] };
        yield { kind: "chunk", bytes: body };
        yield { kind: "settle", status: 502, class: "provider_error", costMicros: 0, estimated: false };
        return;
      }

      if (isRedirectStatus(response.status) && mutation !== "pass_redirect") {
        // A redirect is never followed, and never passed on: where a host sends a call is where nobody checked.
        release(0);
        logs.push(`row=${row.id} class=refused refusal=ssrf`);
        yield* refuse(family, "ssrf");
        return;
      }
      const headers = mutation === "unfiltered_headers" ? response.headers : sanitizeResponseHeaders(response.headers, mutation === "unscanned_headers" ? {} : { key: secret });
      const contentType = response.headers.find(([name]) => name.toLowerCase() === "content-type")?.[1] ?? "";
      const streaming = response.status < 400 && (built.route.streaming === "always" || /event-stream/iu.test(contentType));
      const finish = (args: { status: number; usageBody: ReturnType<typeof usageFromBody>; cls: ModelEgressSettle["class"]; complete: boolean }): ModelEgressSettle => {
        const cost = settleCost({ reservation, usage: args.usageBody, complete: args.complete });
        const costMicros = mutation === "reservation_released_on_cut" && !args.complete ? 0 : cost.costMicros;
        release(costMicros);
        // The cap is overrun only when the SPEND passes it (DECISIONS 165): one call over its estimate but under the cap is nothing.
        const overrun = mutation === "overrun_on_any_excess" ? cost.aboveReservation : isOverCap(meter.spent, source.capMicros);
        if (overrun) meter.overrun = true;
        logs.push(`row=${row.id} status=${String(args.status)} class=${args.cls} cost=${String(costMicros)}`);
        return { kind: "settle", status: args.status, class: args.cls, ...(args.usageBody === undefined ? {} : { inputTokens: args.usageBody.inputTokens, outputTokens: args.usageBody.outputTokens }), costMicros, estimated: cost.estimated, ...(overrun ? { overrun: true } : {}) };
      };

      if (!streaming) {
        const parts: Uint8Array[] = [];
        let complete = true;
        try {
          for await (const part of response.body) parts.push(part);
        } catch {
          complete = false;
        }
        const whole = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
        let at = 0;
        for (const part of parts) {
          whole.set(part, at);
          at += part.byteLength;
        }
        const scrubbed = mutation === "skip_scrub" ? { body: whole, replaced: false } : scrubResponseBody({ family: row.family, status: response.status, headers: response.headers, body: whole, key: secret });
        const cls = classifyProviderResponse({ status: response.status, body: whole });
        yield { kind: "head", status: response.status, headers };
        yield { kind: "chunk", bytes: scrubbed.body };
        yield finish({ status: response.status, usageBody: usageFromBody(row.family, whole), cls, complete });
        return;
      }

      const scanner = createKeyEchoScanner(secret);
      const usage = createUsageScanner(row.family);
      let complete = true;
      let hit = false;
      yield { kind: "head", status: response.status, headers };
      try {
        for await (const part of response.body) {
          usage.push(part);
          if (mutation === "skip_scrub") {
            yield { kind: "chunk", bytes: part };
            continue;
          }
          const step = scanner.push(part);
          if (step.safe.byteLength > 0) yield { kind: "chunk", bytes: step.safe };
          if (step.hit) {
            hit = true;
            complete = false;
            break;
          }
        }
      } catch {
        complete = false;
      }
      if (!hit && mutation !== "skip_scrub") {
        const end = scanner.finish();
        if (end.safe.byteLength > 0) yield { kind: "chunk", bytes: end.safe };
        hit = end.hit;
        if (hit) complete = false;
      }
      yield finish({ status: response.status, usageBody: usage.finish(), cls: hit ? "provider_error" : classifyProviderResponse({ status: response.status }), complete });
    },
  };

  return {
    adapter,
    meterOf: (company) => [...meters.entries()].filter(([key]) => key.startsWith(`${company}|`) || mutation === "shared_meter").reduce((total, [, value]) => total + value.spent, 0),
    setCap(company, micros) {
      for (const source of options.sources) if (source.company === company) source.capMicros = micros;
    },
    logs,
    mints,
  };
}
