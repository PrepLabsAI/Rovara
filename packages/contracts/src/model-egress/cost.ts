// TE-F1a: what a call costs, in whole micro-dollars (never floating-point money). The meter reserves an estimate BEFORE the call and settles to the provider's reported usage AFTER; a call that is cut off keeps its reservation, so
// the meter errs high and never low. Every number that can be printed is checked as a finite whole number first.
import { appendMember, applyJsonEdits, scanJsonObject, type JsonEdit, type JsonObjectSpan } from "./json-splice.js";
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
const own = (object: Record<string, unknown> | undefined, key: string): unknown => (object !== undefined && Object.hasOwn(object, key) ? object[key] : undefined);
const asRecord = (value: unknown): Record<string, unknown> | undefined => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);

/** Where a family's maximum output may be written in a request. Google's JSON accepts both spellings of the config and the field (`generationConfig.maxOutputTokens` and `generation_config.max_output_tokens`, in any mix). */
const GEMINI_CONFIG_KEYS = ["generationConfig", "generation_config"] as const;
const GEMINI_FIELD_KEYS = ["maxOutputTokens", "max_output_tokens"] as const;
const OPENAI_CHAT_FIELDS = ["max_tokens", "max_completion_tokens"] as const;
const OPENAI_RESPONSES_FIELDS = ["max_output_tokens"] as const;

const isPlausibleMax = (value: unknown): value is number => isWholeNumber(value) && value > 0 && value <= MAX_REQUESTED_OUTPUT_TOKENS;

/** The maximum output tokens the request names, in the family's own field, when it names a plausible one. The HIGHEST plausible figure among the fields a body names (the provider may honour any one of them), so the reservation never rests on the smallest. Undefined for a body that is not a JSON object or names none. */
export function requestedMaxOutputTokens(family: ModelEgressFamily, body: Uint8Array | string): number | undefined {
  const parsed = parseJsonObject(body);
  if (parsed === undefined) return undefined;
  const candidates: unknown[] =
    family === "gemini" || family === "vertex"
      ? GEMINI_CONFIG_KEYS.flatMap((configKey) => {
          const config = asRecord(own(parsed, configKey));
          return config === undefined ? [] : GEMINI_FIELD_KEYS.map((field) => own(config, field));
        })
      : family === "openai_compatible"
        ? [own(parsed, "max_completion_tokens"), own(parsed, "max_tokens"), own(parsed, "max_output_tokens")]
        : [own(parsed, "max_tokens")];
  const plausible = candidates.filter(isPlausibleMax);
  return plausible.length === 0 ? undefined : Math.max(...plausible);
}

/** The request keys that hand the provider input the body does not hold: an uploaded file, a cached context, a stored conversation, a page to fetch. Their size is unknown to the proxy, so the reservation does not rest on the body's size. */
const EXTERNAL_INPUT_KEYS = new Set(["fileData", "file_data", "fileUri", "file_uri", "cachedContent", "cached_content", "file_id", "fileId", "previous_response_id", "urlContext", "url_context"]);
const EXTERNAL_SCAN_MAX_NODES = 200_000;
const EXTERNAL_SCAN_MAX_DEPTH = 64;

/** An `image_url` (a string or `{ url }`) that is not an inline `data:` URL: the provider fetches it. */
function isFetchedImageUrl(value: unknown): boolean {
  const url = typeof value === "string" ? value : str(own(asRecord(value), "url"));
  return url !== undefined && !/^data:/iu.test(url.trim());
}
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/**
 * Whether a JSON request hands the provider input of unknown size: a file or cached content (`fileData`, `cachedContent`, `file_id` in any spelling), a stored conversation (`previous_response_id`), the Gemini `urlContext` tool, an OpenAI
 * `image_url` that is not an inline `data:` URL, or an Anthropic content source of `type: "url"`. Any depth. False for a body that is not JSON. Bounded: a body too deep or too big to scan counts as holding one (fail high).
 */
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
    return Object.keys(object).some((key) => {
      if (EXTERNAL_INPUT_KEYS.has(key)) return true;
      if (key === "image_url" && isFetchedImageUrl(object[key])) return true;
      if (key === "source" && own(asRecord(object[key]), "type") === "url") return true;
      return visit(object[key], depth + 1);
    });
  };
  return visit(parsed, 0);
}

/** The field a row's chat-completions maximum is written in: `max_completion_tokens` for OpenAI and Azure OpenAI (o-series and gpt-5 reject `max_tokens`), `max_tokens` for every other OpenAI-compatible row unless the row says otherwise. */
export function maxOutputFieldOf(row: Pick<ModelEgressRow, "id"> & { readonly maxOutputField?: "max_tokens" | "max_completion_tokens" | undefined }): "max_tokens" | "max_completion_tokens" {
  return row.maxOutputField ?? (row.id === "openai" || row.id === "azure-openai" ? "max_completion_tokens" : "max_tokens");
}

function readNumber(text: string, member: { start: number; end: number }): unknown {
  try {
    return JSON.parse(text.slice(member.start, member.end)) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The edits that make `object`'s own max-output fields (`fields`) say one number: every present field whose value is not a plausible maximum is overwritten with the effective maximum (the highest plausible one named, or the default);
 * when none is present, `appendField` is added. Returns the edits and the effective number.
 */
function maxEdits(text: string, object: JsonObjectSpan, fields: readonly string[], defaultMax: number, appendField: string): { readonly edits: JsonEdit[]; readonly named: number | undefined } {
  const present = object.members.filter((member) => fields.includes(member.key));
  const plausible = present.map((member) => readNumber(text, member)).filter(isPlausibleMax);
  const effective = plausible.length > 0 ? Math.max(...plausible) : defaultMax;
  const edits: JsonEdit[] = present.filter((member) => !isPlausibleMax(readNumber(text, member))).map((member) => ({ start: member.start, end: member.end, text: String(effective) }));
  if (present.length === 0) edits.push(appendMember(object, appendField, String(defaultMax)));
  return { edits, named: plausible.length > 0 ? effective : undefined };
}

/**
 * The request with the row's default maximum output set when it names none, EDITED IN PLACE: the one number is spliced into the original text, so every other byte the client sent (big integers, number spelling, key order, white
 * space) is as it was. A present but unusable maximum (null, a quoted string, a negative or huge number, or one next to a smaller usable one) is treated as unnamed and overwritten with the effective figure. Only for operations that
 * generate an answer: chat completions (`chatField`, or `max_completion_tokens` for OpenAI itself) and Responses, `generateContent` and its stream, Cohere chat. Gemini keeps its one config object (`generationConfig` or
 * `generation_config`, in whichever spelling the client used); a second one is never added. Anthropic always sets `max_tokens`. A body that is not UTF-8 JSON, or not an object, is left as it is.
 */
export function withDefaultMaxOutput(
  family: ModelEgressFamily,
  operation: string,
  body: Uint8Array,
  defaultMax: number,
  chatField: "max_tokens" | "max_completion_tokens" = "max_tokens",
): { readonly body: Uint8Array; readonly injected: boolean } {
  const untouched = { body, injected: false } as const;
  if (!isWholeNumber(defaultMax) || defaultMax < 1) return untouched;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    if (parseJsonObject(text) === undefined) return untouched;
  } catch {
    return untouched;
  }
  const start = skipLeading(text);
  const top = scanJsonObject(text, start);
  if (top === undefined) return untouched;
  let edits: JsonEdit[] = [];
  if (family === "openai_compatible" && operation === "chat/completions") {
    edits = maxEdits(text, top, OPENAI_CHAT_FIELDS, defaultMax, chatField).edits;
  } else if (family === "openai_compatible" && operation === "responses") {
    edits = maxEdits(text, top, OPENAI_RESPONSES_FIELDS, defaultMax, "max_output_tokens").edits;
  } else if (family === "cohere" && operation === "chat") {
    edits = maxEdits(text, top, ["max_tokens"], defaultMax, "max_tokens").edits;
  } else if ((family === "gemini" || family === "vertex") && (operation === "generateContent" || operation === "streamGenerateContent")) {
    edits = geminiEdits(text, top, defaultMax);
  }
  return edits.length === 0 ? untouched : { body: new TextEncoder().encode(applyJsonEdits(text, edits)), injected: true };
}

function skipLeading(text: string): number {
  let index = 0;
  while (index < text.length && /\s/u.test(text.charAt(index))) index += 1;
  return index;
}

function geminiEdits(text: string, top: JsonObjectSpan, defaultMax: number): JsonEdit[] {
  const configs = top.members.filter((member) => (GEMINI_CONFIG_KEYS as readonly string[]).includes(member.key));
  if (configs.length === 0) return [appendMember(top, "generationConfig", `{"maxOutputTokens":${String(defaultMax)}}`)];
  // The effective figure is the highest usable one named in ANY config object or spelling; every config object then says it.
  const spans = configs.map((member) => ({ member, object: text.charAt(member.start) === "{" ? scanJsonObject(text, member.start) : undefined }));
  const named = spans.flatMap(({ object }) => (object === undefined ? [] : object.members.filter((entry) => (GEMINI_FIELD_KEYS as readonly string[]).includes(entry.key)).map((entry) => readNumber(text, entry)))).filter(isPlausibleMax);
  const effective = named.length > 0 ? Math.max(...named) : defaultMax;
  const edits: JsonEdit[] = [];
  for (const { member, object } of spans) {
    const field = member.key === "generation_config" ? "max_output_tokens" : "maxOutputTokens";
    if (object === undefined) {
      // A config that is not an object (null, a string, an array) is unusable: it is replaced whole.
      edits.push({ start: member.start, end: member.end, text: `{${JSON.stringify(field)}:${String(effective)}}` });
      continue;
    }
    const present = object.members.filter((entry) => (GEMINI_FIELD_KEYS as readonly string[]).includes(entry.key));
    for (const entry of present) if (!isPlausibleMax(readNumber(text, entry))) edits.push({ start: entry.start, end: entry.end, text: String(effective) });
    if (present.length === 0) edits.push(appendMember(object, field, String(effective)));
  }
  return edits;
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

/** True when the spend on a meter is ABOVE its cap: the call that took it there was the one call the cap may be overrun by (DECISIONS 165), and the task takes no further call. */
export function isOverCap(spentMicros: number, capMicros: number): boolean {
  return isWholeNumber(spentMicros) && isWholeNumber(capMicros) && spentMicros > capMicros;
}

/** The words for the call after an overrun, fixed in code. */
export const MODEL_EGRESS_OVERRUN_SENTENCE = "budget exceeded by one call";

export interface CostSettlement {
  /** True when the settled cost is above what was reserved. Informational: the cap is overrun only when the SPEND passes the cap (`isOverCap`), not whenever one call costs more than its estimate. */
  readonly aboveReservation: boolean;
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
  if (usage === undefined || !isWholeNumber(usage.inputTokens) || !isWholeNumber(usage.outputTokens) || !reservation.priced) return { costMicros: reservation.reserveMicros, estimated: true, aboveReservation: false };
  const actual = microsFor(usage.inputTokens, reservation.rates.inputMicrosPerMTok) + microsFor(usage.outputTokens, reservation.rates.outputMicrosPerMTok);
  if (!Number.isSafeInteger(actual)) return { costMicros: reservation.reserveMicros, estimated: true, aboveReservation: false };
  if (!complete) return { costMicros: Math.max(actual, reservation.reserveMicros), estimated: true, aboveReservation: actual > reservation.reserveMicros };
  return { costMicros: actual, estimated: false, aboveReservation: actual > reservation.reserveMicros };
}
