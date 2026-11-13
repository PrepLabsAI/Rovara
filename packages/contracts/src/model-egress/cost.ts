// TE-F1a: what a call costs, in whole micro-dollars (never floating-point money). The meter reserves an estimate BEFORE the call and settles to the provider's reported usage AFTER; a call that is cut off keeps its reservation, so
// the meter errs high and never low. Every number that can be printed is checked as a finite whole number first.
import type { ModelEgressFamily, ModelEgressPriceRates, ModelEgressRow } from "./schemes.js";

export const MICROS_PER_USD = 1_000_000;
/** What a model with no price (and a row with no fallback) is reserved at: $100 per million tokens each way. High on purpose: an unpriced model is charged its full reservation and marked estimated. */
export const UNPRICED_CEILING_RATES: ModelEgressPriceRates = { inputMicrosPerMTok: 100_000_000, outputMicrosPerMTok: 100_000_000 };
/** The most output tokens a request may name before the row's default is used instead: a larger number is not a plausible limit and would only make the estimate meaningless. */
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
  const found = candidates.find((value) => isWholeNumber(value) && value > 0 && value <= MAX_REQUESTED_OUTPUT_TOKENS);
  return found as number | undefined;
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
  readonly row: Pick<ModelEgressRow, "prices" | "fallbackPrice" | "defaultMaxOutputTokens">;
  readonly model: string | undefined;
  readonly inputBytes: number;
  readonly maxOutputTokens: number | undefined;
}): CostReservation {
  if (!isWholeNumber(args.inputBytes)) throw new RangeError("the input size must be a whole number");
  const { rates, priced } = priceFor(args.row, args.model);
  const inputTokens = Math.ceil(args.inputBytes / 4);
  const outputTokens =
    args.maxOutputTokens !== undefined && isWholeNumber(args.maxOutputTokens) && args.maxOutputTokens > 0 && args.maxOutputTokens <= MAX_REQUESTED_OUTPUT_TOKENS ? args.maxOutputTokens : args.row.defaultMaxOutputTokens;
  const reserveMicros = microsFor(inputTokens, rates.inputMicrosPerMTok) + microsFor(outputTokens, rates.outputMicrosPerMTok);
  if (!Number.isSafeInteger(reserveMicros)) throw new RangeError("the reservation is too large to hold");
  return { reserveMicros, inputTokens, outputTokens, rates, priced };
}

export interface CostSettlement {
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
  if (usage === undefined || !isWholeNumber(usage.inputTokens) || !isWholeNumber(usage.outputTokens) || !reservation.priced) return { costMicros: reservation.reserveMicros, estimated: true };
  const actual = microsFor(usage.inputTokens, reservation.rates.inputMicrosPerMTok) + microsFor(usage.outputTokens, reservation.rates.outputMicrosPerMTok);
  if (!Number.isSafeInteger(actual)) return { costMicros: reservation.reserveMicros, estimated: true };
  if (!complete) return { costMicros: Math.max(actual, reservation.reserveMicros), estimated: true };
  return { costMicros: actual, estimated: false };
}
