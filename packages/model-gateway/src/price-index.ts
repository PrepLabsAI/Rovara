import { openRouterPolicy, openRouterRates, REVIEWED_OPENROUTER_POLICIES, type OpenRouterTariff } from "./openrouter-policy.js";
import { createHash } from "node:crypto";
import { copyRates } from "./price-tiers.js";
import { STALE_ALARM_MS } from "./price-constants.js";
import { type Price, type PriceKind, type PriceOrigin, type PriceSource, type ResolvedPrice } from "./price.js";
import { PRICE_OVERRIDES, validOverrides } from "./price-overrides.js";
import { validSnapshot, type PriceSnapshot, type PriceSnapshotStore } from "./price-snapshot.js";
import { identityKey } from "./price-identity.js";
import { dearestMediaRates, type MediaRates } from "./media-price.js";
import { priceBook, lookupPrice, resolved } from "./price-sanity.js";
export interface SourceHealth { fetchedAt?: number; ageMs?: number; count: number; stale: boolean; lastFailure?: string }
export class SnapshotPriceSource implements PriceSource {
  #book = priceBook(undefined);
  #snapshot: PriceSnapshot | undefined;
  #failures: { litellm?: string; aws?: string } = {};
  #redundant = 0;
  #expiresAt = Infinity;
  #limits = new Map<string, number>();
  #media = new Map<string, MediaRates[]>();
  #snapshotHash: string | undefined;
  constructor(private readonly store: PriceSnapshotStore, private readonly options: { now?: () => number; overrides?: readonly unknown[]; openRouterTariffs?: readonly OpenRouterTariff[] } = {}) {}
  #now(): number { return (this.options.now ?? Date.now)(); }
  async reload(): Promise<void> {
    let snapshot: PriceSnapshot | undefined;
    try { snapshot = await this.store.load(); } catch { return; }
    if (snapshot !== undefined && !validSnapshot(snapshot)) return;
    if (snapshot !== undefined && this.#snapshot !== undefined && snapshot.version < this.#snapshot.version) return;
    this.#build(snapshot);
  }
  #build(snapshot: PriceSnapshot | undefined): void {
    const overrides = validOverrides(this.options.overrides ?? PRICE_OVERRIDES, this.#now()).map((e) => ({ ...e, origin: { source: "override" as const, fetchedAt: e.verifiedAt } }));
    this.#book = priceBook(snapshot, overrides); this.#snapshot = snapshot;
    this.#snapshotHash = snapshot === undefined ? undefined : createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
    // Several rows can name one identity (dated and undated IDs): the smallest ceiling holds for all of them.
    const limits = new Map<string, number>();
    for (const l of snapshot?.sources.litellm?.limits ?? []) { const key = identityKey(l.provider, l.model); limits.set(key, Math.min(limits.get(key) ?? Number.MAX_SAFE_INTEGER, l.maxOutputTokens)); }
    this.#limits = limits;
    const media = new Map<string, MediaRates[]>();
    for (const { provider, model, ...rates } of snapshot?.sources.litellm?.media ?? []) { const key = identityKey(provider, model); media.set(key, [...(media.get(key) ?? []), rates]); }
    this.#media = media;
    this.#redundant = this.#book.redundantOverrides; this.#expiresAt = this.#book.expiresAt;
  }
  /** Identity of exactly the in-memory snapshot used for admission, never a second store read. */
  quoteBasis(provider: string, model: string): { version: number; hash: string; fetchedAt: number; model: string } | undefined {
    if (this.#now() >= this.#expiresAt) this.#build(this.#snapshot);
    if (provider === "openrouter") { const p = openRouterPolicy(model, this.#now(), this.options.openRouterTariffs); return p === undefined ? undefined : { version: 1, hash: p.hash, fetchedAt: p.verifiedAt, model: p.model }; }
    const identity = this.#book.index.get(identityKey(provider, model));
    if (this.#snapshot === undefined || identity === undefined) return undefined;
    return { version: this.#snapshot.version, hash: this.#snapshotHash!, fetchedAt: identity.origin.fetchedAt, model: identity.model };
  }
  effectiveFor(provider: string, model: string, kind: PriceKind): ResolvedPrice {
    if (this.#now() >= this.#expiresAt) this.#build(this.#snapshot);
    if (provider === "openrouter") {
      const p = openRouterPolicy(model, this.#now(), this.options.openRouterTariffs);
      if (p !== undefined && kind === "chat") return openRouterRates(p);
      // Preserve observed token floors for settlement; quoteBasis still requires a reviewed tariff for admission.
      const observed = lookupPrice(this.#book, provider, model, kind);
      if (kind === "chat" && observed.knownTokenPrice) return { ...observed, priceVersion: this.#snapshot?.version ?? 0 };
      return { inputMicrosPerMTok: 1, outputMicrosPerMTok: 1, estimated: true, operatorReview: true };
    }
    return { ...lookupPrice(this.#book, provider, model, kind), priceVersion: this.#snapshot?.version ?? 0 };
  }
  priceFor(provider: string, model: string): (Price & { origin: PriceOrigin }) | undefined {
    if (provider === "openrouter") { const p = openRouterPolicy(model, this.#now(), this.options.openRouterTariffs); return p === undefined ? undefined : { ...openRouterRates(p), origin: { source: "override", fetchedAt: p.verifiedAt } }; }
    if (this.#now() >= this.#expiresAt) this.#build(this.#snapshot);
    const p = this.#book.index.get(identityKey(provider, model));
    if (p === undefined || p.estimated) return undefined;
    const rates = resolved(p);
    return { ...copyRates(rates) as Price, ...(rates.longContext === undefined ? {} : { longContext: rates.longContext }), ...(rates.operatorReview ? { operatorReview: true } : {}), origin: { ...p.origin } };
  }
  correctionFor(provider: string, model: string): (ResolvedPrice & { origin: PriceOrigin; priceVersion: number }) | undefined {
    // A router's missing-usage hold needs actual billing evidence, never an automatic token-tariff credit.
    if (provider === "openrouter") return undefined;
    if (this.#now() >= this.#expiresAt) this.#build(this.#snapshot);
    const p = this.#book.index.get(identityKey(provider, model));
    if (p === undefined) return undefined;
    return { ...resolved(p), origin: { ...p.origin }, priceVersion: this.#snapshot?.version ?? 0 };
  }
  /**
   * The model's own most output tokens per call (ModelLimitsSource), from its source row, by the same identity a price is
   * found by: the model's own key first, then the smallest ceiling among the aliases of its price identity. Undefined: no row
   * names one.
   */
  maxOutputTokens(provider: string, model: string): number | undefined {
    if (typeof provider !== "string" || typeof model !== "string") return undefined;
    const own = this.#limits.get(identityKey(provider, model)); if (own !== undefined) return own;
    const identity = this.#book.index.get(identityKey(provider, model)); if (identity === undefined) return undefined;
    let found: number | undefined;
    for (const alias of [identity.model, ...identity.aliases]) { const limit = this.#limits.get(identityKey(provider, alias)); if (limit !== undefined) found = Math.min(found ?? limit, limit); }
    return found;
  }
  /**
   * The model's audio and video prices (MediaPriceSource), by the same identity a price is found by: the model's own rows and
   * every alias of its price identity, each field at its dearest (REVIEW-1 L2). Undefined: no row prices any media.
   */
  mediaFor(provider: string, model: string): MediaRates | undefined {
    if (typeof provider !== "string" || typeof model !== "string") return undefined;
    if (this.#now() >= this.#expiresAt) this.#build(this.#snapshot);
    const own = this.#media.get(identityKey(provider, model)) ?? [];
    const identity = this.#book.index.get(identityKey(provider, model));
    const keys = new Set([identityKey(provider, model), ...(identity === undefined ? [] : [identity.model, ...identity.aliases].map((alias) => identityKey(provider, alias)))]);
    keys.delete(identityKey(provider, model));
    return dearestMediaRates([...own, ...[...keys].flatMap((key) => this.#media.get(key) ?? [])]);
  }
  runPriceSnapshotVersion(): number | undefined {
    if ((this.options.openRouterTariffs ?? REVIEWED_OPENROUTER_POLICIES).some(row => openRouterPolicy(row.model, this.#now(), this.options.openRouterTariffs) !== undefined)) return this.#snapshot?.version ?? 1;
    if (this.#snapshot === undefined) return undefined;
    const now = this.#now();
    const sources = [this.#snapshot.sources.aws, this.#snapshot.sources.litellm];
    return sources.some(s => s !== undefined && s.count > 0 && s.fetchedAt <= now && now - s.fetchedAt < STALE_ALARM_MS) ? this.#snapshot.version : undefined;
  }
  keys(): Array<{ provider: string; model: string }> { return [...this.#book.index.values()].filter((e) => !e.estimated).map(({ provider, model }) => ({ provider, model })); }
  failure(source: "litellm" | "aws", failed: boolean): void { if (failed) this.#failures[source] = "refresh failed"; else delete this.#failures[source]; }
  health(): { litellm: SourceHealth; aws: SourceHealth; redundantOverrides: number } {
    const result = (name: "litellm" | "aws"): SourceHealth => {
      const s = this.#snapshot?.sources[name]; const ageMs = s === undefined ? undefined : Math.max(0, this.#now() - s.fetchedAt);
      return { count: s?.count ?? 0, stale: ageMs === undefined || ageMs > STALE_ALARM_MS, ...(s === undefined ? {} : { fetchedAt: s.fetchedAt, ageMs: ageMs! }), ...(this.#failures[name] === undefined ? {} : { lastFailure: this.#failures[name] }) };
    };
    return { litellm: result("litellm"), aws: result("aws"), redundantOverrides: this.#redundant };
  }
}
