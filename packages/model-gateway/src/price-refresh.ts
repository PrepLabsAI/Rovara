import { effectivePrices, priceBook } from "./price-sanity.js";
import { whole } from "./model-gateway-token.js";
import { FETCH_DEADLINE_MS, REFRESH_INTERVAL_MS, REFRESH_JITTER, RETRY_MS } from "./price-constants.js";
import type { SnapshotPriceSource } from "./price-index.js";
import { priceKey, validEntry, validSnapshot, type PriceEntry, type PriceKey, type SourceSnapshot, type PriceSnapshotStore } from "./price-snapshot.js";
import type { PriceFetchResult } from "./price-sources.js";
export interface RefreshResult { ok: boolean; gained: number }
export class PriceRefresher {
  #flight: Promise<RefreshResult> | undefined;
  constructor(private readonly options: { store: PriceSnapshotStore; prices: SnapshotPriceSource; litellm: (previous: readonly PriceEntry[]) => Promise<PriceFetchResult>; aws: (previous: readonly PriceEntry[]) => Promise<PriceFetchResult>; correctedKeys?: (keys: readonly PriceKey[]) => Promise<void>; log?: (line: { event: "price_sanity_held" } | { event: "price_deprecated_used"; identities: number }) => void }) {}
  run(now: number): Promise<RefreshResult> {
    if (this.#flight !== undefined) return this.#flight;
    this.#flight = this.#run(now).catch(() => ({ ok: false, gained: 0 })).finally(() => { this.#flight = undefined; });
    return this.#flight;
  }
  async #run(now: number): Promise<RefreshResult> {
    if (!whole(now)) return { ok: false, gained: 0 };
    const deadline = performance.now() + FETCH_DEADLINE_MS;
    const { store, prices } = this.options; const prior = await store.load();
    if (prior !== undefined && !validSnapshot(prior)) return { ok: false, gained: 0 };
    const sources = structuredClone(prior?.sources ?? {}); const known = new Set(prices.keys().map(priceKey));
    const names = ["litellm", "aws"] as const;
    const results = await Promise.all(names.map(async (name) => { try { return await this.options[name](prior?.sources[name]?.entries ?? []); } catch { return { ok: false as const, reason: "refresh failed" }; } }));
    let ok = true; let changed = false; const successful = new Set<"litellm" | "aws">();
    const failure = (name: "litellm" | "aws") => {
      ok = false; prices.failure(name, true);
      // Preserve prices and fetchedAt; only confirmation evidence is invalidated by a failed fetch.
      const source = sources[name]; if (source?.confirmations !== undefined) { delete source.confirmations; changed = true; }
    };
    for (const [i, name] of names.entries()) {
      const r = results[i]!;
      const candidate = r.ok ? { version: 1, sources: { [name]: { fetchedAt: now, count: r.entries.length, entries: r.entries, ...(r.fallbacks === undefined ? {} : { fallbacks: r.fallbacks }), ...(r.floors === undefined ? {} : { floors: r.floors }), ...(r.unidentified === undefined ? {} : { unidentified: r.unidentified }), ...(r.limits === undefined ? {} : { limits: r.limits }), ...(r.media === undefined ? {} : { media: r.media }) } } } : undefined;
      const success = candidate !== undefined && validSnapshot(candidate) && r.ok && (r.entries.length + (r.floors?.length ?? 0) + (r.fallbacks?.length ?? 0) + (r.unidentified?.length ?? 0)) > 0 && now >= (prior?.sources[name]?.fetchedAt ?? 0);
      prices.failure(name, !success);
      if (!success || !r.ok) { failure(name); continue; }
      const source = candidate.sources[name] as SourceSnapshot;
      if (r.drops !== undefined) {
        if (!Array.isArray(r.drops) || r.drops.length > source.entries.length || !r.drops.every(validEntry)) { failure(name); continue; }
        const drops = new Map(r.drops.map((e) => [priceKey(e), e]));
        const keys = new Set(source.entries.map(priceKey));
        if (drops.size !== r.drops.length || r.drops.some((e) => !keys.has(priceKey(e)))) { failure(name); continue; }
        source.entries = source.entries.map((e) => drops.get(priceKey(e)) ?? e);
      }
      sources[name] = source; successful.add(name); changed = true;
    }
    if (performance.now() >= deadline) return { ok: false, gained: 0 };
    const previous = prior?.effective ?? priceBook(prior).identities;
    // A failure invalidates pending evidence even if it was the only source this time.
    changed ||= previous.some((e) => e.pendingLower !== undefined && e.sources.some((name) => !successful.has(name)));
    if (changed) {
      const effective = effectivePrices(sources, previous, successful, deadline, () => { try { this.options.log?.({ event: "price_sanity_held" }); } catch { /* Observability cannot change prices. */ } },
        // Once per refresh: how many identities are priced only by a deprecated row (fixed words, a count, no model names).
        (identities) => { try { this.options.log?.({ event: "price_deprecated_used", identities }); } catch { /* Observability cannot change prices. */ } });
      const snapshot = { version: (prior?.version ?? 0) + 1, sources, effective };
      if (performance.now() >= deadline || !validSnapshot(snapshot) || !await store.save(snapshot, prior?.version ?? 0)) return { ok: false, gained: 0 };
    }
    await prices.reload();
    const gained = prices.keys().filter((key) => !known.has(priceKey(key)));
    // Also call on a no-gain run so a prior bounded correction run can continue.
    await this.options.correctedKeys?.(gained);
    return { ok, gained: gained.length };
  }
}
export interface PriceTimers { setTimer(fn: () => void, ms: number): { unref?(): void }; clearTimer(timer: { unref?(): void }): void }
export function startPriceRefresh(options: { refresher: Pick<PriceRefresher, "run">; timers: PriceTimers; intervalMs?: number; retryMs?: number; random?: () => number; now?: () => number }): { stop(): void } {
  let stopped = false; let timer: { unref?(): void } | undefined;
  const interval = whole(options.intervalMs) && options.intervalMs > 0 ? options.intervalMs : REFRESH_INTERVAL_MS;
  const retry = whole(options.retryMs) && options.retryMs > 0 ? options.retryMs : RETRY_MS;
  const run = async (): Promise<void> => {
    if (stopped) return;
    let ok = false;
    try { ok = (await options.refresher.run((options.now ?? Date.now)())).ok; } catch { /* Schedule a retry, fixed result. */ }
    if (stopped) return;
    let random = 0; try { random = (options.random ?? Math.random)(); } catch { /* Zero jitter is safe. */ }
    if (!Number.isFinite(random) || random < 0 || random > 1) random = 0;
    try { timer = options.timers.setTimer(() => { void run(); }, Math.ceil((ok ? interval : retry) * (1 - random * REFRESH_JITTER))); timer.unref?.(); } catch { stopped = true; }
  };
  void run();
  return { stop() { stopped = true; if (timer !== undefined) options.timers.clearTimer(timer); } };
}
