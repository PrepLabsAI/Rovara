import { normalizedModel } from "./price-identity.js";
import { record, whole } from "./model-gateway-token.js";
import { MAX_ENTRIES_PER_SOURCE, MAX_MODEL_LENGTH } from "./price-constants.js";
import { validPrice, type Price, type PriceKind, type PriceOrigin, type ResolvedPrice } from "./price.js";
import { validModelMediaRates, type ModelMediaRates } from "./media-price.js";
export interface PriceEntry extends Price { provider: string; model: string; kind: PriceKind }
export interface PriceKey { provider: string; model: string }
export interface ModelFallback extends PriceKey { kind?: PriceKind; reason: "per_request_price" | "unpriced" }
export interface UnidentifiedRow { model: string; kind?: PriceKind; rates?: Price; perRequest?: true }
export interface EffectiveIdentity extends PriceKey, ResolvedPrice {
  tokenPrice?: Price; kind?: PriceKind; aliases: string[]; sources: Array<"litellm" | "aws">; origin: PriceOrigin; pendingLower?: ResolvedPrice;
}
/** "deprecated price": a row past its deprecation date whose every field is known, stored at its exact rates (deprecatedRates). */
export const FLOOR_REASONS = ["unsupported mode", "unsupported deprecation date", "deprecated model", "deprecated price", "unsupported price field", "unsupported token rate", "token rate exceeds maximum", "sanity hold", "unsupported provider", "unsupported per-request price"] as const;
export interface ModelFloor extends Price, PriceKey { kind?: PriceKind; perRequest?: true; reason: typeof FLOOR_REASONS[number] }
/** A model's own most output tokens per call, from the source row (LiteLLM max_output_tokens). */
export interface ModelLimit extends PriceKey { maxOutputTokens: number }
export const MAX_OUTPUT_TOKENS_LIMIT = 10_000_000;
export interface SourceSnapshot { fetchedAt: number; count: number; entries: PriceEntry[]; fallbacks?: ModelFallback[]; floors?: ModelFloor[]; unidentified?: UnidentifiedRow[]; limits?: ModelLimit[]; confirmations?: (PriceEntry | ModelFloor)[];
  /** Gemini audio and video prices per model row (LiteLLM only; DEC 228e). Absent: no media is priced. */
  media?: ModelMediaRates[] }
export interface PriceSnapshot { version: number; sources: { litellm?: SourceSnapshot; aws?: SourceSnapshot }; effective?: EffectiveIdentity[] }
export interface PriceSnapshotStore { load(): Promise<PriceSnapshot | undefined>; save(snapshot: PriceSnapshot, expectedVersion: number): Promise<boolean> }
export const priceKey = (key: PriceKey): string => JSON.stringify([key.provider, key.model]);
export function validModel(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_MODEL_LENGTH && ![...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
}
export function validEntry(value: unknown): value is PriceEntry {
  const v = record(value);
  return v !== undefined && validPrice(v) && typeof v.provider === "string" && ["anthropic", "openai", "gemini", "vertex", "bedrock", "openrouter"].includes(v.provider) && validModel(v.model) && (v.kind === "chat" || v.kind === "embedding");
}
export function validFloor(value: unknown): value is ModelFloor {
  const v = record(value);
  return v !== undefined && FLOOR_REASONS.includes(v.reason as ModelFloor["reason"]) && (v.perRequest === undefined || v.perRequest === true) && validPrice(v, Number.MAX_SAFE_INTEGER) && (v.operatorReview === undefined || v.operatorReview === true) && (v.kind === undefined || v.kind === "chat" || v.kind === "embedding") && validEntry({ provider: v.provider, model: v.model, kind: "chat", inputMicrosPerMTok: 1, outputMicrosPerMTok: 1 });
}
export function validFallback(value: unknown): value is ModelFallback {
  const v = record(value);
  return v !== undefined && (v.reason === "per_request_price" || v.reason === "unpriced") && (v.kind === undefined || v.kind === "chat" || v.kind === "embedding") && validEntry({ ...v, kind: "chat", inputMicrosPerMTok: 1, outputMicrosPerMTok: 1 });
}
export function validLimit(value: unknown): value is ModelLimit {
  const v = record(value);
  return v !== undefined && Object.keys(v).length === 3 && whole(v.maxOutputTokens) && v.maxOutputTokens >= 1 && v.maxOutputTokens <= MAX_OUTPUT_TOKENS_LIMIT && validEntry({ provider: v.provider, model: v.model, kind: "chat", inputMicrosPerMTok: 1, outputMicrosPerMTok: 1 });
}
export function validUnidentified(value: unknown): value is UnidentifiedRow {
  const v = record(value);
  return v !== undefined && validModel(v.model) && (v.kind === undefined || v.kind === "chat" || v.kind === "embedding") && (v.perRequest === undefined || v.perRequest === true) && (v.rates === undefined || validPrice(v.rates, Number.MAX_SAFE_INTEGER));
}
function validEffectivePrice(value: unknown): value is ResolvedPrice {
  const v = record(value);
  return v !== undefined && typeof v.estimated === "boolean" && (v.knownTokenPrice === undefined || v.knownTokenPrice === true) && validPrice({ ...v, estimated: false }, Number.MAX_SAFE_INTEGER);
}
export function validSnapshot(value: unknown): value is PriceSnapshot {
  const v = record(value); const sources = record(v?.sources);
  if (v === undefined || !whole(v.version) || sources === undefined || Object.keys(sources).some((key) => key !== "litellm" && key !== "aws")) return false;
  for (const name of ["litellm", "aws"] as const) {
    if (sources[name] === undefined) continue;
    const s = record(sources[name]);
    if (s === undefined || !whole(s.fetchedAt) || !Array.isArray(s.entries) || s.entries.length > MAX_ENTRIES_PER_SOURCE || s.count !== s.entries.length) return false;
    if (s.fallbacks !== undefined && (!Array.isArray(s.fallbacks) || s.entries.length + s.fallbacks.length > MAX_ENTRIES_PER_SOURCE)) return false;
    if (s.floors !== undefined && !Array.isArray(s.floors)) return false;
    if (s.unidentified !== undefined && (!Array.isArray(s.unidentified) || name !== "litellm")) return false;
    if (s.entries.length + ((s.fallbacks ?? []) as unknown[]).length + ((s.floors ?? []) as unknown[]).length + ((s.unidentified ?? []) as unknown[]).length > MAX_ENTRIES_PER_SOURCE) return false;
    if (s.confirmations !== undefined && (!Array.isArray(s.confirmations) || s.confirmations.length > MAX_ENTRIES_PER_SOURCE)) return false;
    const confirmations = new Set<string>();
    for (const e of (s.confirmations ?? []) as unknown[]) {
      if ((!validEntry(e) && !validFloor(e)) || (name === "aws" && e.provider !== "bedrock") || confirmations.has(priceKey(e))) return false;
      confirmations.add(priceKey(e));
    }
    const seen = new Set<string>();
    for (const e of s.entries as unknown[]) {
      if (!validEntry(e) || (name === "aws" && e.provider !== "bedrock") || seen.has(priceKey(e))) return false;
      seen.add(priceKey(e));
    }
    for (const f of (s.floors ?? []) as unknown[]) {
      if (!validFloor(f) || (name === "aws" && f.provider !== "bedrock") || seen.has(priceKey(f))) return false;
      seen.add(priceKey(f));
    }
    for (const f of (s.fallbacks ?? []) as unknown[]) {
      if (!validFallback(f) || (name === "aws" && f.provider !== "bedrock") || seen.has(priceKey(f))) return false;
      seen.add(priceKey(f));
    }
    if (s.limits !== undefined) {
      if (!Array.isArray(s.limits) || s.limits.length > MAX_ENTRIES_PER_SOURCE || name !== "litellm") return false;
      const limits = new Set<string>();
      for (const l of s.limits as unknown[]) { if (!validLimit(l) || limits.has(priceKey(l))) return false; limits.add(priceKey(l)); }
    }
    if (s.media !== undefined) {
      if (!Array.isArray(s.media) || s.media.length > MAX_ENTRIES_PER_SOURCE || name !== "litellm") return false;
      const media = new Set<string>();
      for (const m of s.media as unknown[]) { if (!validModelMediaRates(m) || media.has(priceKey(m))) return false; media.add(priceKey(m)); }
    }
    const unidentified = new Set<string>();
    for (const u of (s.unidentified ?? []) as unknown[]) {
      if (!validUnidentified(u) || unidentified.has(u.model)) return false;
      unidentified.add(u.model);
    }
  }
  if (v.effective !== undefined) {
    if (!Array.isArray(v.effective) || v.effective.length > 2 * MAX_ENTRIES_PER_SOURCE) return false;
    const seen = new Set<string>(); let aliases = 0;
    for (const value of v.effective as unknown[]) {
      const e = record(value);
      if (e === undefined || (e.tokenPrice !== undefined && !validPrice(e.tokenPrice, Number.MAX_SAFE_INTEGER)) || !validEffectivePrice(e) || !validEntry({ provider: e.provider, model: e.model, kind: "chat", inputMicrosPerMTok: 1, outputMicrosPerMTok: 1 }) || (e.kind !== undefined && e.kind !== "chat" && e.kind !== "embedding")) return false;
      if (!Array.isArray(e.aliases) || e.aliases.length === 0 || (aliases += e.aliases.length) > 2 * MAX_ENTRIES_PER_SOURCE || !e.aliases.every(validModel) || new Set(e.aliases).size !== e.aliases.length) return false;
      if (!Array.isArray(e.sources) || e.sources.length < 1 || e.sources.length > 2 || e.sources.some((s) => s !== "litellm" && s !== "aws") || new Set(e.sources).size !== e.sources.length) return false;
      const origin = record(e.origin);
      if (origin === undefined || !e.sources.includes(origin.source) || !whole(origin.fetchedAt) || (e.pendingLower !== undefined && !validEffectivePrice(e.pendingLower))) return false;
      if (e.model !== normalizedModel(e.provider as string, e.model as string)) return false;
      const key = priceKey(e as unknown as PriceKey); if (seen.has(key)) return false; seen.add(key);
    }
  }
  return true;
}
/** Adapter contract: version-conditional save, deep copies, no partial source write. */
export class InMemoryPriceSnapshotStore implements PriceSnapshotStore {
  #snapshot: PriceSnapshot | undefined;
  async load(): Promise<PriceSnapshot | undefined> { return this.#snapshot === undefined ? undefined : structuredClone(this.#snapshot); }
  async save(snapshot: PriceSnapshot, expectedVersion: number): Promise<boolean> {
    if (!validSnapshot(snapshot) || !whole(expectedVersion) || snapshot.version !== expectedVersion + 1 || (this.#snapshot?.version ?? 0) !== expectedVersion) return false;
    this.#snapshot = structuredClone(snapshot); return true;
  }
}
