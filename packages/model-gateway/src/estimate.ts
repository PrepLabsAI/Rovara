import { completePrice, ratesForUsage } from "./price-tiers.js";
import type { Price, TokenRates } from "./price.js";
import type { MediaRates } from "./media-price.js";
import { hasMediaUsage, type TokenUsage } from "./usage.js";
export const TOOL_INPUT_ALLOWANCE_TOKENS = 4096;
function roundedCost(numerator: bigint, denominator = 1_000_000n, saturate = false): number {
  const micros = (numerator + denominator - 1n) / denominator;
  if (micros > BigInt(Number.MAX_SAFE_INTEGER)) { if (saturate) return Number.MAX_SAFE_INTEGER; throw new Error("request not allowed"); }
  return Number(micros);
}
/** Audio and video carried inline by a call: their estimated prompt tokens (the caller leaves their encoded bytes out of `bytes`). */
export interface MediaEstimate { tokens: number; audio: boolean; video: boolean }
/**
 * The media rates at one tier. A listed media rate is never charged below that tier's text input rate (a long-context tier
 * raises it too); "input" is the tier's own input rate. Cached audio uses its listed cache rate, else its own input rate when
 * that is listed, else the cache-read rate; cached video likewise. Undefined: that modality has no price.
 */
/**
 * Reported audio/video tokens the gateway has no price for (a cached context holding audio, a model with no media row): never
 * $0 and never the hold (REVIEW-1 M1). They are charged at this multiple of the tier's text input rate, above Google's dearest
 * audio-to-text ratio (3.33x on Gemini 2.5 Flash), and the settle is flagged estimated so a correction row is written.
 */
export const UNPRICED_MEDIA_FACTOR = 4;
/**
 * A row that takes audio or video but lists no media price ("input"): held and settled at this multiple of the text rate
 * (Google's highest media multiple today), never below it, and flagged estimated so a correction re-prices it once the row
 * lists its own price (controller decision on DEC 228e, logged for owner review).
 */
export const TEXT_RATE_MEDIA_FACTOR = 3;
const times = (rate: number, factor: number): number => rate > Number.MAX_SAFE_INTEGER / factor ? Number.MAX_SAFE_INTEGER : rate * factor;
export function mediaRatesAt(rates: TokenRates, media: MediaRates | undefined, unpriced?: "cautious"): { audio?: number; video?: number; audioCache?: number; videoCache?: number } {
  const own = (r: MediaRates["audioInput"]): number | undefined => r === undefined ? undefined : r === "input" ? times(rates.inputMicrosPerMTok, TEXT_RATE_MEDIA_FACTOR) : Math.max(r, rates.inputMicrosPerMTok);
  const cautious = times(rates.inputMicrosPerMTok, UNPRICED_MEDIA_FACTOR);
  const audio = own(media?.audioInput); const video = own(media?.videoInput); const cacheRead = rates.cacheReadMicrosPerMTok!;
  const textRateCache = times(cacheRead, TEXT_RATE_MEDIA_FACTOR);
  return {
    ...(audio === undefined ? (unpriced === "cautious" ? { audio: cautious, audioCache: cautious } : {}) : { audio, audioCache: media!.audioCacheRead !== undefined ? Math.max(media!.audioCacheRead, cacheRead) : media!.audioInput === "input" ? textRateCache : audio }),
    ...(video === undefined ? (unpriced === "cautious" ? { video: cautious, videoCache: cautious } : {}) : { video, videoCache: media!.videoInput === "input" ? textRateCache : video }),
  };
}
/** The usage has audio or video counts priced by the 3x text-rate rule: the settle is estimated (a correction row). */
export function mediaEstimated(usage: TokenUsage, price: Price): boolean {
  return ((usage.audioInput ?? 0) + (usage.audioCacheRead ?? 0) > 0 && price.media?.audioInput === "input")
    || ((usage.videoInput ?? 0) + (usage.videoCacheRead ?? 0) > 0 && price.media?.videoInput === "input");
}
/** Every audio/video count in the usage has a rate for this model (text-only usage always does). */
export function mediaPriced(usage: TokenUsage, price: Price): boolean {
  if (!hasMediaUsage(usage)) return true;
  const m = mediaRatesAt({ inputMicrosPerMTok: 1, outputMicrosPerMTok: 1, cacheReadMicrosPerMTok: 1 }, price.media);
  return ((usage.audioInput ?? 0) + (usage.audioCacheRead ?? 0) === 0 || m.audio !== undefined) && ((usage.videoInput ?? 0) + (usage.videoCacheRead ?? 0) === 0 || m.video !== undefined);
}
export function estimateCall(bytes: number, maxTokens: number, price: Price, inputAllowance = 0, plainInput = false, media?: MediaEstimate): number {
  const complete = completePrice(price);
  if (complete.operatorReview) return Number.MAX_SAFE_INTEGER;
  const tokens = bytes + inputAllowance + (media?.tokens ?? 0);
  const rates = [complete, ...(complete.longContext ?? []).filter((t) => t.aboveTokens < tokens).map((t) => ({ ...complete, ...t }))];
  // Inline media: every input token is held at the dearest rate the call can use (video carries an audio track).
  const mediaRates = (r: TokenRates): number[] => {
    if (media === undefined || (!media.audio && !media.video)) return [];
    const m = mediaRatesAt(r, price.media);
    if (m.audio === undefined || (media.video && m.video === undefined)) throw new Error("request not allowed");
    return [m.audio, m.audioCache!, ...(media.video ? [m.video!, m.videoCache!] : [])];
  };
  const input = Math.max(...rates.flatMap((r) => [...(plainInput ? [r.inputMicrosPerMTok] : [r.inputMicrosPerMTok, r.cacheReadMicrosPerMTok!, r.cacheWrite5mMicrosPerMTok!, r.cacheWrite1hMicrosPerMTok!]), ...mediaRates(r)]));
  const output = Math.max(...rates.map((r) => r.outputMicrosPerMTok));
  return roundedCost(BigInt(tokens) * BigInt(input) + BigInt(maxTokens) * BigInt(output), 1_000_000n, "estimated" in price && price.estimated === true);
}
/** The context threshold counts all prompt tokens; missing write durations use the dearer write tier. */
export function usageCost(usage: TokenUsage, price: Price, unpricedMedia?: "cautious"): number {
  if (completePrice(price).operatorReview) return Number.MAX_SAFE_INTEGER;
  // Unpriced audio or video saturates (operator review: corrections), unless the caller asks for the cautious rate (the settle).
  if (unpricedMedia !== "cautious" && !mediaPriced(usage, price)) return Number.MAX_SAFE_INTEGER;
  const rates = ratesForUsage(price, usage.input + usage.cacheRead + usage.cacheWrite);
  const m = mediaRatesAt(rates, price.media, unpricedMedia);
  const audioIn = usage.audioInput ?? 0; const videoIn = usage.videoInput ?? 0; const audioCache = usage.audioCacheRead ?? 0; const videoCache = usage.videoCacheRead ?? 0;
  const media = BigInt(audioIn) * BigInt(m.audio ?? 0) + BigInt(videoIn) * BigInt(m.video ?? 0) + BigInt(audioCache) * BigInt(m.audioCache ?? 0) + BigInt(videoCache) * BigInt(m.videoCache ?? 0);
  const fiveMinute = usage.cacheWrite5m ?? 0;
  const hour = usage.cacheWrite1h ?? 0;
  const unknown = usage.cacheWrite - fiveMinute - hour;
  const numerator = media + BigInt(usage.input - audioIn - videoIn) * BigInt(rates.inputMicrosPerMTok) + BigInt(usage.output) * BigInt(rates.outputMicrosPerMTok)
    + BigInt(usage.cacheRead - audioCache - videoCache) * BigInt(rates.cacheReadMicrosPerMTok!)
    + BigInt(fiveMinute) * BigInt(rates.cacheWrite5mMicrosPerMTok!) + BigInt(hour) * BigInt(rates.cacheWrite1hMicrosPerMTok!)
    + BigInt(unknown) * BigInt(Math.max(rates.cacheWrite5mMicrosPerMTok!, rates.cacheWrite1hMicrosPerMTok!));
  return roundedCost(numerator, 1_000_000n, "estimated" in price && price.estimated === true);
}
