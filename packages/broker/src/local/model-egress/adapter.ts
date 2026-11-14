// TE-F1c (M2, release 0.5.19): the LAPTOP `model-egress` adapter. It implements F1-a's port (`ports/model-egress.ts`) in process, with the user's OWN key from the local product-key store, the local meter (per task and per month, in a
// file) and the in-process forwarder. It is built only from the core's pure rules (`@agentx/contracts` `model-egress/`), exactly as the conformance suite's fake adapter is, and must pass `runModelEgressConformance` and the
// two-company kit (tests/unit/model-egress-laptop-conformance.test.ts).
//
// The scope is the adapter's own, opaque to the bridge: `{ owner, source, task? }` (`laptopScope`); a call with no task counts on the source's own meter. The frame never names any of them. A source that is missing, another owner's, or for another row gives the one fixed
// `not_found`. A call makes ONE attempt (no retry after a fault: it can double-spend). The destination is the row's own host, checked again here (`hostAllowedForRow`) on top of the core's routing and the forwarder's address
// checks. The key is placed and not kept; it never reaches a log (fixed fields only), an error, a ledger or an answer.
import {
  buildOutboundRequest, classOfRefusal, classifyProviderResponse, createKeyEchoScanner, createUsageScanner, familyErrorBody, isRedirectStatus, modelOfBody, parseModelEgressFrame, refusalResponse, reserveEstimate,
  sanitizeResponseHeaders, scrubResponseBody, settleCost, usageFromBody, MODEL_EGRESS_MIN_KEY_CHARS,
  type ModelEgress, type ModelEgressConnection, type ModelEgressEvent, type ModelEgressFamily, type ModelEgressFrame, type ModelEgressRefusal, type ModelEgressRow, type ModelEgressScheme, type ModelEgressScope, type ModelEgressSettle,
} from "@agentx/contracts";
import { EgressSsrfError, type ProviderTransport } from "./forwarder.js";
import type { ProductKeyStore } from "./key-store.js";
import type { LocalMeter, MeterReservation } from "./meter.js";

declare const laptopScopeBrand: unique symbol;
interface LaptopScopeFields { readonly owner: string; readonly source: string; readonly task?: string }
export type LaptopModelEgressScope = ModelEgressScope & { readonly [laptopScopeBrand]: true };

/** The scope for a call: the local workspace that owns the key, the source (the project's name for one key), and the task whose meter the call counts on. */
export const laptopScope = (owner: string, source: string, task?: string): ModelEgressScope => ({ owner, source, ...(task === undefined ? {} : { task }) }) as unknown as ModelEgressScope;

const KEY_SCHEMES: readonly ModelEgressScheme[] = ["bearer", "header:x-goog-api-key", "header:x-api-key", "header:api-key", "query:key"];
const TOKEN_SCHEMES: readonly ModelEgressScheme[] = ["gcp-oauth:federation", "gcp-oauth:key-file"];
const TOKEN_CACHE_MS = 10 * 60 * 1000;
const UNREACHABLE = "The provider could not be reached.";

/** Whether `host` is one this row may call: one of its own hosts, or (an Azure row) the connected resource's own host under the row's suffix. Nothing else, whatever a frame said. */
export function hostAllowedForRow(row: Pick<ModelEgressRow, "hosts" | "hostSuffixes">, connection: ModelEgressConnection, host: string): boolean {
  if (row.hosts.includes(host)) return true;
  return connection.host !== undefined && host === connection.host && row.hostSuffixes.some((suffix) => host.endsWith(`.${suffix}`));
}

export interface LaptopModelEgressOptions {
  readonly rows: readonly ModelEgressRow[];
  readonly keys: ProductKeyStore;
  readonly meter: LocalMeter;
  readonly transport: ProviderTransport;
  /** Makes the short-lived token for a Google token scheme (federation or key file). Without it those rows are `not_allowed`. */
  readonly mintToken?: (owner: string, sourceId: string, row: ModelEgressRow) => Promise<string>;
  readonly now?: () => number;
  /** Fixed fields only: row, status, class, refusal word, cost. */
  readonly log?: (fields: Readonly<Record<string, string | number>>) => void;
}

function scopeOf(value: ModelEgressScope): { owner: string; source: string; task: string } | undefined {
  try {
    const held = value as unknown as Partial<LaptopScopeFields> | undefined;
    const owner = held?.owner;
    const source = held?.source;
    const task = held?.task;
    return typeof owner === "string" && owner !== "" && typeof source === "string" && source !== "" ? { owner, source, task: typeof task === "string" && task !== "" ? task : source } : undefined;
  } catch {
    // A scope that cannot even be read is a scope nobody can be served under.
    return undefined;
  }
}

export function createLaptopModelEgress(options: LaptopModelEgressOptions): ModelEgress {
  const rowsById = new Map(options.rows.map((row) => [row.id, row]));
  const now = options.now ?? Date.now;
  const tokens = new Map<string, { token: string; untilMs: number }>();
  const log = (fields: Readonly<Record<string, string | number>>): void => {
    try { options.log?.(fields); } catch { /* a log sink that throws is not the call's problem */ }
  };
  const schemes = options.mintToken === undefined ? KEY_SCHEMES : [...KEY_SCHEMES, ...TOKEN_SCHEMES];

  async function* refuse(family: ModelEgressFamily, word: ModelEgressRefusal, row: string, extra: { capMicros?: number; overrun?: boolean } = {}): AsyncGenerator<ModelEgressEvent> {
    const answer = refusalResponse(family, word, extra);
    log({ event: "refused", row, status: answer.status, class: classOfRefusal(word), refusal: word });
    yield { kind: "head", status: answer.status, headers: answer.headers };
    yield { kind: "chunk", bytes: answer.body };
    yield { kind: "settle", status: answer.status, class: classOfRefusal(word), refusal: word, costMicros: 0, estimated: false };
  }

  async function credentialFor(owner: string, sourceId: string, row: ModelEgressRow, key: string): Promise<string | undefined> {
    if (!TOKEN_SCHEMES.includes(row.scheme)) return key;
    if (options.mintToken === undefined) return undefined;
    // Cached per (owner, source, row): one owner's token is never placed for another.
    const cacheKey = JSON.stringify([owner, sourceId, row.id]);
    const held = tokens.get(cacheKey);
    if (held !== undefined && held.untilMs > now()) return held.token;
    const token = await options.mintToken(owner, sourceId, row);
    tokens.set(cacheKey, { token, untilMs: now() + TOKEN_CACHE_MS });
    return token;
  }

  return {
    capabilities: { schemes },
    async *forward(scopeValue, input, forwardOptions) {
      const parsed = parseModelEgressFrame(input);
      const catalogRow = parsed.ok ? rowsById.get(parsed.frame.row) : undefined;
      // The family for any answer that is not about a source comes from the public row, never from the source: "missing" and "another owner's" cannot differ.
      const family: ModelEgressFamily = catalogRow?.family ?? "openai_compatible";
      const rowName = catalogRow?.id ?? "unknown";
      if (!parsed.ok) {
        yield* refuse(family, parsed.refusal, rowName);
        return;
      }
      const frame: ModelEgressFrame = parsed.frame;
      const scope = scopeOf(scopeValue);
      let entry: Awaited<ReturnType<ProductKeyStore["get"]>>;
      try {
        entry = scope === undefined ? undefined : await options.keys.get(scope.owner, scope.source);
      } catch {
        // A key file that cannot be read is a source nobody can be served from. The words of the failure are not repeated.
        entry = undefined;
      }
      if (scope === undefined || entry === undefined || catalogRow === undefined || entry.rowId !== frame.row) {
        yield* refuse(family, "not_found", rowName);
        return;
      }
      const row = catalogRow;
      const connection: ModelEgressConnection = entry.connection ?? {};
      let secret: string | undefined;
      try {
        secret = row.family === "bedrock" || row.scheme === "sigv4" ? entry.key : await credentialFor(scope.owner, scope.source, row, entry.key);
      } catch {
        secret = undefined;
      }
      if (secret === undefined || secret.length < MODEL_EGRESS_MIN_KEY_CHARS) {
        yield* refuse(family, "not_allowed", row.id);
        return;
      }
      let built: ReturnType<typeof buildOutboundRequest>;
      try {
        built = buildOutboundRequest(row, connection, frame, secret);
      } catch {
        yield* refuse(family, "bad_request", row.id);
        return;
      }
      if (!built.ok) {
        yield* refuse(family, built.refusal, row.id);
        return;
      }
      const request = built.request;
      // The destination is the row's own host, whatever the request says: checked here again, before a cap is touched.
      if (!hostAllowedForRow(row, connection, request.host)) {
        yield* refuse(family, "ssrf", row.id);
        return;
      }
      const reservation = reserveEstimate({ row, model: built.route.model ?? modelOfBody(request.body), inputBytes: request.body.byteLength, maxOutputTokens: built.maxOutputTokens, externalInput: built.externalInput });
      const reserved = await options.meter.reserve({ owner: scope.owner, task: scope.task, estimateMicros: reservation.reserveMicros });
      if (!reserved.ok) {
        yield* refuse(family, "cap", row.id, { capMicros: reserved.capMicros, ...(reserved.reason === "overrun" ? { overrun: true } : {}) });
        return;
      }
      const handle: MeterReservation = reserved.handle;

      // ONE attempt: a retry after a fault, a 5xx or a 429 can double-spend.
      let response: Awaited<ReturnType<ProviderTransport>> | undefined;
      let refusedAddress = false;
      try {
        response = await options.transport(request, forwardOptions?.signal);
      } catch (error) {
        response = undefined;
        refusedAddress = error instanceof EgressSsrfError;
      }
      if (response === undefined) {
        await options.meter.settle(handle, 0);
        if (refusedAddress) {
          yield* refuse(family, "ssrf", row.id);
          return;
        }
        log({ event: "call", row: row.id, status: 502, class: "provider_error", cost: 0 });
        yield { kind: "head", status: 502, headers: [["content-type", "application/json"]] };
        yield { kind: "chunk", bytes: familyErrorBody(row.family, 502, UNREACHABLE, "rovara_unreachable") };
        yield { kind: "settle", status: 502, class: "provider_error", costMicros: 0, estimated: false };
        return;
      }
      if (isRedirectStatus(response.status)) {
        // A redirect is never followed, and never passed on: where a host sends a call is where nobody checked.
        await options.meter.settle(handle, 0);
        yield* refuse(family, "ssrf", row.id);
        return;
      }
      // A header whose value holds the key (any spelling) is dropped too: an allow-listed name is no promise about its value.
      const headers = sanitizeResponseHeaders(response.headers, { key: secret });
      const contentType = response.headers.find(([name]) => name.toLowerCase() === "content-type")?.[1] ?? "";
      const streaming = response.status < 400 && (built.route.streaming === "always" || /event-stream/iu.test(contentType));
      const finish = async (args: { status: number; usage: ReturnType<typeof usageFromBody>; cls: ModelEgressSettle["class"]; complete: boolean }): Promise<ModelEgressSettle> => {
        const cost = settleCost({ reservation, usage: args.usage, complete: args.complete });
        const settled = await options.meter.settle(handle, cost.costMicros);
        log({ event: "call", row: row.id, status: args.status, class: args.cls, cost: cost.costMicros });
        return { kind: "settle", status: args.status, class: args.cls, ...(args.usage === undefined ? {} : { inputTokens: args.usage.inputTokens, outputTokens: args.usage.outputTokens }), costMicros: cost.costMicros, estimated: cost.estimated, ...(settled.overrun ? { overrun: true } : {}) };
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
        const scrubbed = scrubResponseBody({ family: row.family, status: response.status, headers: response.headers, body: whole, key: secret });
        const cls = classifyProviderResponse({ status: response.status, body: whole });
        yield { kind: "head", status: response.status, headers };
        yield { kind: "chunk", bytes: scrubbed.body };
        yield await finish({ status: response.status, usage: usageFromBody(row.family, whole), cls, complete });
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
      if (!hit) {
        const end = scanner.finish();
        if (end.safe.byteLength > 0) yield { kind: "chunk", bytes: end.safe };
        hit = end.hit;
        if (hit) complete = false;
      }
      yield await finish({ status: response.status, usage: usage.finish(), cls: hit ? "provider_error" : classifyProviderResponse({ status: response.status }), complete });
    },
  };
}
