import { UNKNOWN_READ_FACTOR, UNKNOWN_WRITE_FACTOR, UNKNOWN_LONG_FACTOR, UNKNOWN_LONG_THRESHOLD } from "./price-constants.js";
import type { TokenUsage } from "./usage.js";
import type { Price, TokenRates } from "./price.js";
export const RATE_KEYS = ["inputMicrosPerMTok", "outputMicrosPerMTok", "cacheReadMicrosPerMTok", "cacheWrite5mMicrosPerMTok", "cacheWrite1hMicrosPerMTok", "cacheWriteMicrosPerMTok"] as const;
export type RateKey = typeof RATE_KEYS[number];
/**
 * Every long-context band a price source states (LiteLLM's `_above_<n>k_tokens` fields, 2026-11-17: 32k, 100k, 128k, 200k, 256k,
 * 272k, 512k). A row naming any other band stays unknown (the cautious price), never folded into a neighbouring band.
 */
export const CONTEXT_THRESHOLDS = [32_000, 100_000, 128_000, 200_000, 256_000, 272_000, 512_000] as const;
/** LiteLLM's band suffix, for exactly the bands above: `_above_100k_tokens` is the band above 100,000 prompt tokens. */
export const BAND_SUFFIX = new RegExp(`_above_(${CONTEXT_THRESHOLDS.map((t) => t / 1000).join("|")})k_tokens`, "u");
export function copyRates(p: Partial<TokenRates>): Partial<TokenRates> {
  const result: Partial<TokenRates> = {};
  for (const key of RATE_KEYS) if (p[key] !== undefined) result[key] = p[key];
  return result;
}
function maxRates(a: Partial<TokenRates>, b: Partial<TokenRates>): Partial<TokenRates> {
  const p = copyRates(a);
  for (const key of RATE_KEYS) if (b[key] !== undefined) p[key] = Math.max(a[key] ?? 0, b[key]);
  return p;
}
export function knownLongRates(p: Price, threshold: number): Partial<TokenRates> {
  let result: Partial<TokenRates> = {};
  for (const tier of p.longContext ?? []) if (tier.aboveTokens <= threshold) result = { ...result, ...copyRates(tier) };
  return result;
}
export function maxPrice(a: Price, b: Price): Price {
  const thresholds = [...new Set([...(a.longContext ?? []), ...(b.longContext ?? [])].map((t) => t.aboveTokens))].sort((x, y) => x - y);
  return { ...maxRates(a, b) as TokenRates,
    ...(thresholds.length ? { longContext: thresholds.map((aboveTokens) => ({ aboveTokens, ...maxRates(knownLongRates(a, aboveTokens), knownLongRates(b, aboveTokens)) })) } : {}),
    ...((a.operatorReview || b.operatorReview) ? { operatorReview: true } : {}) };
}
/** Fill only unknown components, after pooling known observations. Never let a missing alias tier hide a known discount. */
export function completePrice(p: Price): Price {
  let overflow = !!p.operatorReview;
  const derived: NonNullable<Price["derived"]> = [];
  const multiply = (rate: number, factor: number): number => {
    if (rate > Number.MAX_SAFE_INTEGER / factor) { overflow = true; return Number.MAX_SAFE_INTEGER; }
    return rate * factor;
  };
  const complete = (known: Partial<TokenRates>, aboveTokens: number, base?: TokenRates): TokenRates => {
    const keys = new Set<RateKey>(p.derived?.find((b) => b.aboveTokens === aboveTokens)?.keys ?? []);
    const rates = copyRates(known);
    const fill = (key: RateKey, rate: () => number) => { if (rates[key] === undefined) { rates[key] = rate(); keys.add(key); } };
    if (base !== undefined) {
      fill("inputMicrosPerMTok", () => multiply(base.inputMicrosPerMTok, UNKNOWN_LONG_FACTOR));
      fill("outputMicrosPerMTok", () => multiply(base.outputMicrosPerMTok, UNKNOWN_LONG_FACTOR));
    }
    fill("cacheReadMicrosPerMTok", () => multiply(rates.inputMicrosPerMTok!, UNKNOWN_READ_FACTOR));
    for (const key of ["cacheWrite5mMicrosPerMTok", "cacheWrite1hMicrosPerMTok"] as const) {
      if (rates[key] === undefined && rates.cacheWriteMicrosPerMTok !== undefined) rates[key] = rates.cacheWriteMicrosPerMTok;
      fill(key, () => multiply(rates.inputMicrosPerMTok!, UNKNOWN_WRITE_FACTOR));
    }
    if (keys.size) derived.push({ aboveTokens, keys: [...keys] });
    return rates as TokenRates;
  };
  const base = complete(p, 0);
  const thresholds = p.longContext?.length ? p.longContext.map((t) => t.aboveTokens) : "knownTokenPrice" in p && p.knownTokenPrice === true ? [UNKNOWN_LONG_THRESHOLD] : [];
  const longContext = thresholds.map((aboveTokens) => ({ aboveTokens, ...complete(knownLongRates(p, aboveTokens), aboveTokens, base) }));
  return { ...base, ...(longContext.length ? { longContext } : {}), ...(derived.length && (p.derived !== undefined || "knownTokenPrice" in p) ? { derived } : {}), ...(overflow ? { operatorReview: true } : {}) };
}
/** Only tiers actually consumed keep a settled call eligible for correction. */
export function usageEstimated(p: Price & { estimated?: boolean }, usage: TokenUsage): boolean {
  if (p.operatorReview || (p.estimated && p.uncertain === undefined)) return true;
  if (p.derived === undefined && p.uncertain === undefined) return false;
  const complete = completePrice(p);
  const tokens = usage.input + usage.cacheRead + usage.cacheWrite;
  let threshold = 0;
  for (const tier of complete.longContext ?? []) if (tokens > tier.aboveTokens) threshold = tier.aboveTokens;
  const keys = [...(complete.derived?.find((b) => b.aboveTokens === threshold)?.keys ?? []), ...(p.uncertain?.find((b) => b.aboveTokens === threshold)?.keys ?? [])];
  const used: Partial<Record<RateKey, number>> = { inputMicrosPerMTok: usage.input, outputMicrosPerMTok: usage.output, cacheReadMicrosPerMTok: usage.cacheRead,
    cacheWrite5mMicrosPerMTok: usage.cacheWrite5m ?? usage.cacheWrite, cacheWrite1hMicrosPerMTok: usage.cacheWrite1h ?? usage.cacheWrite };
  return !!complete.operatorReview || keys.some((key) => (used[key] ?? 0) > 0);
}
export function ratesForUsage(p: Price, inputTokens: number): TokenRates {
  const complete = completePrice(p); let rates: TokenRates = complete;
  for (const tier of complete.longContext ?? []) if (inputTokens > tier.aboveTokens) rates = { ...rates, ...copyRates(tier) };
  return rates;
}
/** Published prices already include fallbacks: missing bands mean the active base rate, not missing evidence. */
export function maxEffectivePrice(a: Price, b: Price): Price {
  const x = completePrice(a); const y = completePrice(b);
  const thresholds = [...new Set([...(x.longContext ?? []), ...(y.longContext ?? [])].map((t) => t.aboveTokens))].sort((m, n) => m - n);
  return { ...maxPrice(x, y), ...(thresholds.length ? { longContext: thresholds.map((aboveTokens) => ({ aboveTokens, ...maxRates({ ...copyRates(x), ...knownLongRates(x, aboveTokens) }, { ...copyRates(y), ...knownLongRates(y, aboveTokens) }) })) } : {}) };
}
export function samePrice(a: Price, b: Price): boolean {
  const x = completePrice(a); const y = completePrice(b);
  const thresholds = new Set([...(x.longContext ?? []), ...(y.longContext ?? [])].map((t) => t.aboveTokens));
  return RATE_KEYS.every((k) => x[k] === y[k]) && [...thresholds].every((t) => {
    const xr = { ...copyRates(x), ...knownLongRates(x, t) }; const yr = { ...copyRates(y), ...knownLongRates(y, t) };
    return RATE_KEYS.every((k) => xr[k] === yr[k]);
  }) && !!x.operatorReview === !!y.operatorReview;
}
export function lowerPrice(a: Price, b: Price): boolean { return !samePrice(maxEffectivePrice(a, b), a); }

/** A clean observation proves only the components it actually supplied at the published rate. */
export function uncertainComponents(price: Price, clean?: Price): NonNullable<Price["uncertain"]> {
  const bands = [{ aboveTokens: 0, ...copyRates(price) }, ...(price.longContext ?? [])];
  return bands.map((band) => {
    const known = clean === undefined ? {} : band.aboveTokens === 0 ? copyRates(clean) : knownLongRates(clean, band.aboveTokens);
    // Legacy generic writes are real evidence for either duration.
    if (known.cacheWriteMicrosPerMTok !== undefined) { known.cacheWrite5mMicrosPerMTok ??= known.cacheWriteMicrosPerMTok; known.cacheWrite1hMicrosPerMTok ??= known.cacheWriteMicrosPerMTok; }
    return { aboveTokens: band.aboveTokens, keys: RATE_KEYS.filter((k) => band[k] !== undefined && (known[k] === undefined || band[k] > known[k])) };
  }).filter((band) => band.keys.length > 0);
}
