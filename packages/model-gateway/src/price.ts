import { record, whole } from "./model-gateway-token.js";
import { RATE_KEYS, CONTEXT_THRESHOLDS, copyRates, maxEffectivePrice, type RateKey } from "./price-tiers.js";
import { PRICE_MAX } from "./price-constants.js";
import type { MediaRates } from "./media-price.js";
export interface TokenRates { inputMicrosPerMTok: number; outputMicrosPerMTok: number; cacheReadMicrosPerMTok?: number; cacheWrite5mMicrosPerMTok?: number; cacheWrite1hMicrosPerMTok?: number; cacheWriteMicrosPerMTok?: number }
export interface Price extends TokenRates {
  /** The model's audio/video rates, attached per call by a route (never stored in a snapshot price). */
  media?: MediaRates;
  longContext?: Array<Partial<TokenRates> & { aboveTokens: number }>; operatorReview?: true; derived?: Array<{ aboveTokens: number; keys: RateKey[] }>; uncertain?: Array<{ aboveTokens: number; keys: RateKey[] }> }
export type PriceKind = "chat" | "embedding";
export interface PriceOrigin { source: "litellm" | "aws" | "override"; fetchedAt: number }
export interface ResolvedPrice extends Price { estimated: boolean; priceVersion?: number; knownTokenPrice?: true }
export interface PriceSource {
  quoteBasis?(provider: string, model: string): { version: number; hash: string; fetchedAt: number; model: string } | undefined;
  correctionFor?(provider: string, model: string): (ResolvedPrice & { origin: PriceOrigin; priceVersion: number }) | undefined;
  effectiveFor?(provider: string, model: string, kind: PriceKind): ResolvedPrice | Promise<ResolvedPrice>;
  priceFor(provider: string, model: string, signal?: AbortSignal): Price | undefined | Promise<Price | undefined>;
  floorFor?(provider: string, model: string): Price | undefined | Promise<Price | undefined>;
  fallbackFor?(provider: string, model: string): "per_request_price" | undefined | Promise<"per_request_price" | undefined>;
  cautiousFor?(provider: string, kind: PriceKind): Price | undefined | Promise<Price | undefined>;
  /** The model's audio and video prices (product route, corrections of media calls). Absent: no media is priced. */
  mediaFor?(provider: string, model: string): MediaRates | undefined;
  /** Compatibility with R3a sources; snapshot sources use separate rates and kinds. */
  dearestKnown?(provider: string): number | undefined | Promise<number | undefined>;
}
export const UnknownPriceSource: PriceSource = { priceFor: () => undefined };
export const validRate = (v: unknown, max = PRICE_MAX): v is number => whole(v) && v > 0 && v <= max;
export function validPrice(v: unknown, max = PRICE_MAX): v is Price {
  const p = record(v);
  return p !== undefined && validDerived(p.derived) && validDerived(p.uncertain) && p.estimated !== true && (p.operatorReview === undefined || p.operatorReview === true) && validRate(p.inputMicrosPerMTok, max) && validRate(p.outputMicrosPerMTok, max) && RATE_KEYS.slice(2).every((k) => p[k] === undefined || (whole(p[k]) && p[k] <= max && (k !== "cacheWriteMicrosPerMTok" || p[k] > 0))) && (p.longContext === undefined || (Array.isArray(p.longContext) && p.longContext.length <= CONTEXT_THRESHOLDS.length && p.longContext.every((t: unknown, i: number, all: unknown[]) => {
    const tier = record(t); const previous = record(all[i - 1]);
    return tier !== undefined && CONTEXT_THRESHOLDS.some((n) => n === tier.aboveTokens) && (i === 0 || Number(previous?.aboveTokens) < Number(tier.aboveTokens)) && Object.keys(tier).every((k) => k === "aboveTokens" || RATE_KEYS.some((r) => r === k)) && RATE_KEYS.every((k) => tier[k] === undefined || (whole(tier[k]) && tier[k] <= max));
  })));
}
/** Completion provenance is bounded independently of customer input. Old prices may omit it. */
function validDerived(value: unknown): boolean {
  if (value === undefined) return true;
  return Array.isArray(value) && value.length <= CONTEXT_THRESHOLDS.length + 1 && value.every((band: unknown, i: number, all: unknown[]) => {
    const b = record(band);
    return b !== undefined && (b.aboveTokens === 0 || CONTEXT_THRESHOLDS.some((n) => n === b.aboveTokens)) && (i === 0 || Number(record(all[i - 1])?.aboveTokens) < Number(b.aboveTokens)) && Array.isArray(b.keys) && b.keys.length <= RATE_KEYS.length && new Set(b.keys).size === b.keys.length && b.keys.every((key: unknown) => RATE_KEYS.some((k) => k === key));
  });
}
export { resolvePrice } from "./price-sanity.js";

/**
 * Two rows for one call (Vertex: the AI Studio row and the Vertex row of the same model): the dearer rate per component, each
 * price completed first (a missing band or cache rate means the rate that applies instead), so the call is never priced below
 * either row. A row that is only an estimate (no row for that identity) adds nothing; if the first is the estimate and the
 * second is known, the known row is used.
 */
export function dearerPrice(a: ResolvedPrice, b: ResolvedPrice): ResolvedPrice {
  if (b.estimated) return a;
  const version = a.priceVersion ?? b.priceVersion;
  if (a.estimated) return { ...b, ...(version === undefined ? {} : { priceVersion: version }) };
  return { ...maxEffectivePrice(a, b), estimated: false, ...(version === undefined ? {} : { priceVersion: version }), ...(a.knownTokenPrice === true || b.knownTokenPrice === true ? { knownTokenPrice: true as const } : {}) };
}

/** Exact integer ×1.5 without BigInt, saturation before unsafe arithmetic. */
export function cautiousPrice(price: Price): Price {
  const scale = (n: number): number => n > Number.MAX_SAFE_INTEGER - Math.ceil(n / 2) ? Number.MAX_SAFE_INTEGER : n + Math.ceil(n / 2);
  let overflow = !!price.operatorReview;
  const scaled = (rates: Partial<TokenRates>): Partial<TokenRates> => {
    const result = copyRates(rates);
    for (const key of RATE_KEYS) if (result[key] !== undefined) { overflow ||= result[key] > Number.MAX_SAFE_INTEGER - Math.ceil(result[key] / 2); result[key] = scale(result[key]); }
    return result;
  };
  const rates = scaled(price) as TokenRates;
  const longContext = price.longContext?.map((t) => ({ aboveTokens: t.aboveTokens, ...scaled(t) }));
  return { ...rates, ...(longContext === undefined ? {} : { longContext }), ...(overflow ? { operatorReview: true } : {}) };
}
