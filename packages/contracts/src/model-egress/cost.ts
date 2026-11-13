// TE-F1a: what a call costs, in whole micro-dollars (never floating-point money). The meter reserves an estimate BEFORE the call and settles to the provider's reported usage AFTER; a call that is cut off keeps its reservation, so
// the meter errs high and never low. Every number that can be printed is checked as a finite whole number first.
import type { ModelEgressFamily, ModelEgressPriceRates, ModelEgressRow } from "./schemes.js";

export const MICROS_PER_USD = 1_000_000;
/** What a model with no price (and a row with no fallback) is reserved at: $100 per million tokens each way. High on purpose: an unpriced model is charged its full reservation and marked estimated. */
export const UNPRICED_CEILING_RATES: ModelEgressPriceRates = { inputMicrosPerMTok: 100_000_000, outputMicrosPerMTok: 100_000_000 };
/** The most output tokens a request may name before the row's default is used instead: a larger number is not a plausible limit and would only make the estimate meaningless. */
/** What a request that names a file or cached content reserves as input when its row sets nothing: two million tokens, above the longest context a model serves today. */
export const DEFAULT_EXTERNAL_INPUT_RESERVE_TOKENS = 2_000_000;
export const MAX_REQUESTED_OUTPUT_TOKENS = 1_000_000_000;

const isWholeNumber = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** `$2.00` from micro-dollars, rounded UP to the cent (a budget line never reads lower than the truth). Throws RangeError on a number that is not a whole non-negative micro-dollar count. */
export function formatUsdMicros(micros: number): string {
  if (!isWholeNumber(micros)) throw new RangeError("a dollar amount must be a whole number of micro-dollars");
  const cents = Math.ceil(micros / 10_000);
  const whole = Math.floor(cents / 100);
  return `$${String(whole)}.${String(cents % 100).padStart(2, "0")}`;
}

/** The rates for `model` on `row`: its own price, else the row's fallback, else the ceiling. `priced` is true only for the model's own price. */
export function priceFor(row: Pick<ModelEgressRow, "prices" | "fallbackPrice">, model: string | undefined): { readonly rates: ModelEgressPriceRates; readonly priced: boolean } {
  const own = model === undefined ? undefined : row.prices.find((price) => price.model === model);
  if (own !== undefined) return { rates: { inputMicrosPerMTok: own.inputMicrosPerMTok, outputMicrosPerMTok: own.outputMicrosPerMTok }, priced: true };
  return { rates: row.fallbackPrice ?? UNPRICED_CEILING_RATES, priced: false };
}

/** Micro-dollars for a token count at a rate, rounded up, in BigInt so a large count at a large rate cannot lose precision. Throws RangeError when an input is not a whole number or the cost cannot be held exactly. */
export function microsFor(tokens: number, microsPerMTok: number): number {
  if (!isWholeNumber(tokens) || !isWholeNumber(microsPerMTok)) throw new RangeError("a token count and a rate must be whole numbers");
  const scaled = BigInt(tokens) * BigInt(microsPerMTok);
  const micros = (scaled + 999_999n) / 1_000_000n;
  if (micros > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("the cost is too large to hold");
  return Number(micros);
}

function parseJsonObject(body: Uint8Array | string): Record<string, unknown> | undefined {
  try {
    const text = typeof body === "string" ? body : new TextDecoder().decode(body);
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
const own = (object: Record<string, unknown>, key: string): unknown => (Object.hasOwn(object, key) ? object[key] : undefined);
const asRecord = (value: unknown): Record<string, unknown> | undefined => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);

/** The maximum output tokens the request names, in the family's own field, when it names a plausible one. Undefined for a body that is not a JSON object or names none. */
export function requestedMaxOutputTokens(family: ModelEgressFamily, body: Uint8Array | string): number | undefined {
  const parsed = parseJsonObject(body);
  if (parsed === undefined) return undefined;
  const config = asRecord(own(parsed, "generationConfig"));
  const candidates: unknown[] =
    family === "gemini" || family === "vertex"
      ? [config === undefined ? undefined : own(config, "maxOutputTokens")]
      : family === "openai_compatible"
        ? [own(parsed, "max_completion_tokens"), own(parsed, "max_tokens"), own(parsed, "max_output_tokens")]
        : [own(parsed, "max_tokens")];
  // The HIGHEST plausible figure among the fields a body names (conflicting fields: the provider may honour any one of them), so the reservation never rests on the smallest.
  const plausible = candidates.filter((value): value is number => isWholeNumber(value) && value > 0 && value <= MAX_REQUESTED_OUTPUT_TOKENS);
  return plausible.length === 0 ? undefined : Math.max(...plausible);
}

/** The request keys that hand the provider input the body does not hold: an uploaded file, a cached context. Their size is unknown to the proxy, so the reservation does not rest on the body's size. */
const EXTERNAL_INPUT_KEYS = new Set(["fileData", "file_data", "fileUri", "file_uri", "cachedContent", "cached_content", "file_id", "fileId"]);
const EXTERNAL_SCAN_MAX_NODES = 200_000;
const EXTERNAL_SCAN_MAX_DEPTH = 64;

/** Whether a JSON request names a file or cached content anywhere in it (any depth, any spelling). False for a body that is not JSON. Bounded: a body too deep or too big to scan counts as holding one (fail high). */
export function hasExternalInput(body: Uint8Array | string): boolean {
  const parsed = parseJsonObject(body);
  if (parsed === undefined) return false;
  let nodes = 0;
  const visit = (value: unknown, depth: number): boolean => {
    nodes += 1;
    if (nodes > EXTERNAL_SCAN_MAX_NODES || depth > EXTERNAL_SCAN_MAX_DEPTH) return true;
    if (Array.isArray(value)) return value.some((item) => visit(item, depth + 1));
    const object = asRecord(value);
    if (object === undefined) return false;
    return Object.keys(object).some((key) => EXTERNAL_INPUT_KEYS.has(key) || visit(object[key], depth + 1));
  };
  return visit(parsed, 0);
}

/**
 * The request with the row's default maximum output set when it names none (so the reservation and the provider's own limit are the same number). Only for operations that generate an answer: chat completions and Responses (OpenAI shape),
 * `generateContent` and its stream (Gemini, Vertex), chat (Cohere). Anthropic always sets `max_tokens`. A body that is not a JSON object is left as it is. The body that is forwarded is the re-serialised one, so what the proxy priced
 * is what the provider reads (a duplicate key cannot mean two things).
 */
export function withDefaultMaxOutput(family: ModelEgressFamily, operation: string, body: Uint8Array, defaultMax: number): { readonly body: Uint8Array; readonly injected: boolean } {
  const parsed = parseJsonObject(body);
  if (parsed === undefined || !isWholeNumber(defaultMax) || defaultMax < 1) return { body, injected: false };
  const next: Record<string, unknown> = { ...parsed };
  const set = (object: Record<string, unknown>, key: string): boolean => {
    if (Object.hasOwn(object, key)) return false;
    Object.defineProperty(object, key, { value: defaultMax, enumerable: true, writable: true, configurable: true });
    return true;
  };
  let injected = false;
  if (family === "openai_compatible") {
    const named = ["max_tokens", "max_completion_tokens", "max_output_tokens"].some((key) => Object.hasOwn(parsed, key));
    if (operation === "chat/completions" && !named) injected = set(next, "max_tokens");
    else if (operation === "responses" && !named) injected = set(next, "max_output_tokens");
  } else if ((family === "gemini" || family === "vertex") && (operation === "generateContent" || operation === "streamGenerateContent")) {
    const config = { ...(asRecord(own(parsed, "generationConfig")) ?? {}) };
    if (set(config, "maxOutputTokens")) {
      Object.defineProperty(next, "generationConfig", { value: config, enumerable: true, writable: true, configurable: true });
      injected = true;
    }
  } else if (family === "cohere" && operation === "chat" && !Object.hasOwn(parsed, "max_tokens")) {
    injected = set(next, "max_tokens");
  }
  return injected ? { body: new TextEncoder().encode(JSON.stringify(next)), injected } : { body, injected: false };
}

/** The model a request names in its body (every family but Gemini and Vertex, which name it in the path). */
export function modelOfBody(body: Uint8Array | string): string | undefined {
  const parsed = parseJsonObject(body);
  const model = parsed === undefined ? undefined : own(parsed, "model");
  return typeof model === "string" && model.length > 0 && model.length <= 128 ? model : undefined;
}

export interface CostReservation {
  /** Micro-dollars held on the meter before the call. */
  readonly reserveMicros: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly rates: ModelEgressPriceRates;
  /** False for a model with no price of its own: its settled cost is its reservation, marked estimated. */
  readonly priced: boolean;
}

/** The reservation for one call: input bytes / 4 (rounded up) tokens at the input rate, plus the request's maximum output tokens (or the row's default) at the output rate. */
export function reserveEstimate(args: {
  readonly row: Pick<ModelEgressRow, "prices" | "fallbackPrice" | "defaultMaxOutputTokens"> & { readonly externalInputReserveTokens?: number | undefined };
  readonly model: string | undefined;
  readonly inputBytes: number;
  readonly maxOutputTokens: number | undefined;
  /** The request names a file or cached content (`hasExternalInput`): its input is unknown, so the input estimate is at least the row's external-input reservation. */
  readonly externalInput?: boolean;
}): CostReservation {
  if (!isWholeNumber(args.inputBytes)) throw new RangeError("the input size must be a whole number");
  const { rates, priced } = priceFor(args.row, args.model);
  const bodyTokens = Math.ceil(args.inputBytes / 4);
  const inputTokens = args.externalInput === true ? Math.max(bodyTokens, args.row.externalInputReserveTokens ?? DEFAULT_EXTERNAL_INPUT_RESERVE_TOKENS) : bodyTokens;
  const outputTokens =
    args.maxOutputTokens !== undefined && isWholeNumber(args.maxOutputTokens) && args.maxOutputTokens > 0 && args.maxOutputTokens <= MAX_REQUESTED_OUTPUT_TOKENS ? args.maxOutputTokens : args.row.defaultMaxOutputTokens;
  const reserveMicros = microsFor(inputTokens, rates.inputMicrosPerMTok) + microsFor(outputTokens, rates.outputMicrosPerMTok);
  if (!Number.isSafeInteger(reserveMicros)) throw new RangeError("the reservation is too large to hold");
  return { reserveMicros, inputTokens, outputTokens, rates, priced };
}

/** The words for the call after an overrun, fixed in code. */
export const MODEL_EGRESS_OVERRUN_SENTENCE = "budget exceeded by one call";

export interface CostSettlement {
  /** True when the settled cost is ABOVE what was reserved: the cap was overrun by this call, and the task takes no further call. */
  readonly overrun: boolean;
  readonly costMicros: number;
  /** True when the cost is the reservation, not the provider's report: an unpriced model, a call with no usage, a stream that was cut off. */
  readonly estimated: boolean;
}

/**
 * The cost to settle on the meter. Complete answer, priced model, usage reported: exactly that usage at the rates. Anything else (unpriced model, no usage in the answer, a stream cut off) keeps the full reservation
 * (estimated); a cut-off stream that reported partial usage keeps whichever is HIGHER, so the meter never errs low.
 */
export function settleCost(args: { readonly reservation: CostReservation; readonly usage: { readonly inputTokens: number; readonly outputTokens: number } | undefined; readonly complete: boolean }): CostSettlement {
  const { reservation, usage, complete } = args;
  if (usage === undefined || !isWholeNumber(usage.inputTokens) || !isWholeNumber(usage.outputTokens) || !reservation.priced) return { costMicros: reservation.reserveMicros, estimated: true, overrun: false };
  const actual = microsFor(usage.inputTokens, reservation.rates.inputMicrosPerMTok) + microsFor(usage.outputTokens, reservation.rates.outputMicrosPerMTok);
  if (!Number.isSafeInteger(actual)) return { costMicros: reservation.reserveMicros, estimated: true, overrun: false };
  if (!complete) return { costMicros: Math.max(actual, reservation.reserveMicros), estimated: true, overrun: actual > reservation.reserveMicros };
  return { costMicros: actual, estimated: false, overrun: actual > reservation.reserveMicros };
}
