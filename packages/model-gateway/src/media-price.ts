// Gemini audio and video prices for the product route (DEC 228e, DEC 172, DEC 217): read from the same LiteLLM rows as the
// token prices, kept per model in the snapshot (sources.litellm.media), and never $0. A modality with no price is refused.
import { record, whole } from "./model-gateway-token.js";
import { PRICE_MAX, RATE_SCALE } from "./price-constants.js";
import { priceDate, priceKind, rateMicros } from "./price-classify.js";
import type { PriceKey } from "./price-snapshot.js";

/** Micro-dollars per million tokens, or "input": billed at the model's own text input rate (Google's single-rate models). */
export type MediaRate = number | "input";
export interface MediaRates {
  /** Audio prompt tokens. Absent: audio is not priced for this model (refused). */
  audioInput?: MediaRate;
  /** Video prompt tokens (frames). Absent: video is not priced for this model (refused). */
  videoInput?: MediaRate;
  /** Cached audio prompt tokens; absent: the audio input rate when that is its own rate, else the cache-read rate. */
  audioCacheRead?: number;
  /** Audio answer tokens. Stored for the price list; the product route still refuses audio output. */
  audioOutput?: number;
}
export interface ModelMediaRates extends PriceKey, MediaRates {}
export interface MediaPriceSource { mediaFor(provider: string, model: string): MediaRates | undefined }

const FIELDS = ["provider", "model", "audioInput", "videoInput", "audioCacheRead", "audioOutput"] as const;
const rate = (v: unknown): v is number => whole(v) && v >= 1 && v <= PRICE_MAX;
export function validMediaRates(value: unknown): value is MediaRates {
  const v = record(value);
  if (v === undefined || Object.keys(v).some((k) => !FIELDS.slice(2).includes(k as typeof FIELDS[number]))) return false;
  const priced = (k: "audioInput" | "videoInput") => v[k] === undefined || v[k] === "input" || rate(v[k]);
  return priced("audioInput") && priced("videoInput") && (v.audioCacheRead === undefined || rate(v.audioCacheRead)) && (v.audioOutput === undefined || rate(v.audioOutput)) && FIELDS.slice(2).some((k) => v[k] !== undefined);
}
export function validModelMediaRates(value: unknown): value is ModelMediaRates {
  const v = record(value);
  if (v === undefined || Object.keys(v).some((k) => !FIELDS.includes(k as typeof FIELDS[number]))) return false;
  const { provider, model, ...rates } = v;
  return provider === "gemini" && typeof model === "string" && model.trim().length > 0 && model.length <= 512 && ![...model].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) && validMediaRates(rates);
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
/**
 * A listed per-token media price: the standard field and its batch/flex variants (the dearest wins, as for text rates;
 * priority is a service tier the gateway does not expose). "invalid" if any listed variant is not a positive number in
 * range: never $0, never a guess.
 */
function listed(row: Record<string, unknown>, field: string): number | "invalid" | undefined {
  let found: number | undefined;
  for (const name of [field, `${field}_batches`, `${field}_flex`]) {
    if (!Object.hasOwn(row, name)) continue;
    const value = row[name];
    if (!finite(value) || value <= 0 || value > PRICE_MAX / RATE_SCALE) return "invalid";
    const micros = rateMicros(value);
    if (!rate(micros)) return "invalid";
    found = Math.max(found ?? 0, micros);
  }
  return found;
}
/** The row says the model takes this modality (supported_modalities or supports_<m>_input); an explicit false wins. */
function supports(row: Record<string, unknown>, modality: "audio" | "video"): boolean | undefined {
  const flag = row[`supports_${modality}_input`];
  if (flag === false) return false;
  if (flag === true) return true;
  return Array.isArray(row.supported_modalities) && row.supported_modalities.includes(modality) ? true : undefined;
}
function inputRate(row: Record<string, unknown>, modality: "audio" | "video"): MediaRate | undefined {
  const support = supports(row, modality);
  if (support === false) return undefined;
  // A per-second price can't be charged from token counts, and a long-context media tier isn't read (REVIEW-1 L1): unpriced.
  if (Object.keys(row).some((k) => k.startsWith(`input_cost_per_${modality}_per_second`) || k.startsWith(`input_cost_per_${modality}_token_above_`))) return undefined;
  const own = listed(row, `input_cost_per_${modality}_token`);
  if (own === "invalid") return undefined;
  if (own !== undefined) return own;
  // No separate price, but the row takes the modality: Google bills it at the model's text input rate (LiteLLM's convention).
  return support === true ? "input" : undefined;
}
/** A Gemini chat row's audio and video prices, or undefined (nothing priced, not Gemini, deprecated, or no base input rate). */
export function mediaRatesOf(value: unknown, provider: string | undefined, model: string, now: number): ModelMediaRates | undefined {
  const row = record(value);
  if (row === undefined || provider !== "gemini" || priceKind(row.mode) !== "chat") return undefined;
  if (row.deprecation_date !== undefined && row.deprecation_date !== null) {
    const date = priceDate(row.deprecation_date);
    if (date === undefined || date < now) return undefined;
  }
  if (!finite(row.input_cost_per_token) || row.input_cost_per_token <= 0) return undefined;
  const audioInput = inputRate(row, "audio"); const videoInput = inputRate(row, "video");
  const cache = audioInput === undefined ? undefined : listed(row, "cache_read_input_audio_token_cost");
  const output = listed(row, "output_cost_per_audio_token");
  const rates: ModelMediaRates = { provider, model,
    ...(audioInput === undefined ? {} : { audioInput }), ...(videoInput === undefined ? {} : { videoInput }),
    ...(typeof cache === "number" ? { audioCacheRead: cache } : {}), ...(typeof output === "number" ? { audioOutput: output } : {}) };
  return validModelMediaRates(rates) ? rates : undefined;
}
/** Several rows for one identity: each field's dearest price; a field any row leaves unpriced stays priced by the others. */
export function dearestMediaRates(all: readonly MediaRates[]): MediaRates | undefined {
  if (all.length === 0) return undefined;
  const pick = (k: "audioInput" | "videoInput"): MediaRate | undefined => {
    const values = all.map((r) => r[k]).filter((v): v is MediaRate => v !== undefined);
    if (values.length === 0) return undefined;
    const numbers = values.filter((v): v is number => v !== "input");
    // "input" and a number disagree: keep the number, which estimate and settle never lower below the text input rate.
    return numbers.length === 0 ? "input" : Math.max(...numbers);
  };
  const max = (k: "audioCacheRead" | "audioOutput") => { const n = all.map((r) => r[k]).filter((v): v is number => v !== undefined); return n.length === 0 ? undefined : Math.max(...n); };
  const audioInput = pick("audioInput"); const videoInput = pick("videoInput"); const audioCacheRead = max("audioCacheRead"); const audioOutput = max("audioOutput");
  const result: MediaRates = { ...(audioInput === undefined ? {} : { audioInput }), ...(videoInput === undefined ? {} : { videoInput }), ...(audioCacheRead === undefined ? {} : { audioCacheRead }), ...(audioOutput === undefined ? {} : { audioOutput }) };
  return validMediaRates(result) ? result : undefined;
}
