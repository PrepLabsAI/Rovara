import { whole } from "./model-gateway-token.js";
import { maxPrice, maxEffectivePrice, samePrice as equal, lowerPrice as lower, completePrice, copyRates, uncertainComponents } from "./price-tiers.js";
export { maxPrice } from "./price-tiers.js";
import { CAUTION_FACTOR, FETCH_DEADLINE_MS, FLAT_CEILING_MICROS_PER_MTOK, MAX_ENTRIES_PER_SOURCE } from "./price-constants.js";
import { cautiousPrice, validPrice, validRate, type PriceSource, type Price, type PriceKind, type PriceOrigin, type ResolvedPrice } from "./price.js";
import { identityKey, normalizedModel } from "./price-identity.js";
import type { EffectiveIdentity, ModelFallback, ModelFloor, PriceEntry, PriceSnapshot } from "./price-snapshot.js";
type Source = "litellm" | "aws";
const names = ["litellm", "aws"] as const;
const flat: ResolvedPrice = { inputMicrosPerMTok: FLAT_CEILING_MICROS_PER_MTOK, outputMicrosPerMTok: FLAT_CEILING_MICROS_PER_MTOK, estimated: true };
/** Inputs here are already scaled observations; policy never applies caution twice to an identity. */
function candidatePrice(clean: Price | undefined, uncertain: Price | undefined, perRequest: boolean): ResolvedPrice | undefined {
  const token = clean === undefined ? uncertain : uncertain === undefined ? clean : maxPrice(clean, uncertain);
  if (token === undefined) return perRequest ? { ...flat } : undefined;
  const price = perRequest ? maxPrice(token, flat) : token;
  const result = resolved({ ...price, estimated: clean === undefined || !equal(price, clean) });
  return result;
}
interface Pool {
  provider: string; model: string; kind?: PriceKind; aliases: Set<string>; sources: Set<Source>; origin: PriceOrigin;
  clean?: Price; uncertain?: Price; perRequest: boolean;
}
/** One pricing model: normalize, pool every observation, apply policy once, then confirm the effective price. */
export function effectivePrices(sources: PriceSnapshot["sources"], previous: readonly EffectiveIdentity[] = [], successful: ReadonlySet<Source> = new Set(names), deadline = performance.now() + FETCH_DEADLINE_MS, held: () => void = () => undefined, deprecatedUsed: (identities: number) => void = () => undefined): EffectiveIdentity[] {
  let work = 0; const check = () => { if (++work > 20 * MAX_ENTRIES_PER_SOURCE || performance.now() >= deadline) throw new Error("refresh failed"); };
  const prior = new Map(previous.map((e) => [identityKey(e.provider, e.model), e]));
  const pools = new Map<string, Pool>(); const exact = new Map<string, string | null>();
  const remember = (alias: string, key: string) => { const old = exact.get(alias); exact.set(alias, old === undefined || old === key ? key : null); };
  for (const e of previous) { check(); for (const alias of e.aliases) { check(); remember(alias, identityKey(e.provider, e.model)); } }
  const add = (row: PriceEntry | ModelFloor | ModelFallback, source: Source, fetchedAt: number): Pool => {
    check(); const key = identityKey(row.provider, row.model); remember(row.model, key);
    let p = pools.get(key);
    if (p === undefined) { p = { provider: row.provider, model: normalizedModel(row.provider, row.model), ...(row.kind === undefined ? {} : { kind: row.kind }), aliases: new Set(), sources: new Set(), origin: { source, fetchedAt }, perRequest: false }; pools.set(key, p); }
    else if (p.kind !== row.kind) delete p.kind;
    p.aliases.add(row.model); p.sources.add(source);
    if ("inputMicrosPerMTok" in row) {
      const target = "reason" in row ? "uncertain" : "clean";
      p[target] = p[target] === undefined ? row : maxPrice(p[target], row);
      if (target === "clean" || p.clean === undefined) p.origin = { source, fetchedAt };
    }
    p.perRequest ||= ("reason" in row && row.reason === "per_request_price") || ("perRequest" in row && row.perRequest === true);
    return p;
  };
  // Identities some non-deprecated row names (any source), and the lowest long-context band the LiteLLM rows state per identity.
  const live = new Set<string>(); const litellmBand = new Map<string, number>();
  for (const name of names) {
    const s = sources[name]; if (s === undefined) continue;
    for (const row of [...s.entries, ...(s.floors ?? []), ...(s.fallbacks ?? [])]) {
      check(); const key = identityKey(row.provider, row.model);
      if (!("reason" in row) || (row.reason !== "deprecated price" && row.reason !== "deprecated model")) live.add(key);
      if (name !== "litellm" || !("longContext" in row)) continue;
      for (const tier of row.longContext ?? []) litellmBand.set(key, Math.min(litellmBand.get(key) ?? Number.MAX_SAFE_INTEGER, tier.aboveTokens));
    }
  }
  const usedDeprecated = new Set<string>();
  for (const name of names) {
    const s = sources[name]; if (s === undefined) continue;
    for (const row of [...s.entries, ...(s.floors ?? []), ...(s.fallbacks ?? [])]) {
      const key = identityKey(row.provider, row.model);
      if ("reason" in row && row.reason === "deprecated price") {
        // Only when no non-deprecated row names the identity is a fully known deprecated row its price; otherwise it is an alias.
        if (live.has(key)) add({ provider: row.provider, model: row.model, ...(row.kind === undefined ? {} : { kind: row.kind }), reason: "unpriced" }, name, s.fetchedAt);
        else {
          usedDeprecated.add(key);
          add({ provider: row.provider, model: row.model, kind: row.kind ?? "chat", ...copyRates(row) as Price, ...(row.longContext === undefined ? {} : { longContext: row.longContext }), ...(row.operatorReview ? { operatorReview: true } : {}) }, name, s.fetchedAt);
        }
        continue;
      }
      add(name === "aws" ? awsBand(row, litellmBand.get(key)) : row, name, s.fetchedAt);
    }
  }
  if (usedDeprecated.size > 0) { try { deprecatedUsed(usedDeprecated.size); } catch { /* Observability cannot change prices. */ } }
  // Resolve malformed provider metadata only via an unambiguous, exact ID established by a recognized row.
  for (const row of sources.litellm?.unidentified ?? []) {
    check(); const key = exact.get(row.model); if (key === undefined || key === null) continue;
    const identity = pools.get(key) ?? prior.get(key); if (identity === undefined) continue;
    const p = add({ provider: identity.provider, model: row.model, ...(row.kind === undefined ? {} : { kind: row.kind }), reason: "unpriced" }, "litellm", sources.litellm!.fetchedAt);
    if (row.rates !== undefined) p.uncertain = p.uncertain === undefined ? row.rates : maxPrice(p.uncertain, row.rates);
    p.perRequest ||= row.perRequest === true;
  }
  const currentAliases = [...pools.values()].flatMap((p) => [...p.aliases].map((alias) => [identityKey(p.provider, p.model), alias] as const));
  const retained = new Map<string, readonly [string, string]>();
  const retain = (key: string, alias: string) => { const id = JSON.stringify([key, alias]); retained.delete(id); retained.set(id, [key, alias]); };
  for (const e of previous) for (const alias of e.aliases) { check(); retain(identityKey(e.provider, e.model), alias); }
  for (const [key, alias] of currentAliases) { check(); retain(key, alias); }
  while (retained.size > 2 * MAX_ENTRIES_PER_SOURCE) retained.delete(retained.keys().next().value!);
  const aliases = new Map<string, string[]>();
  for (const [key, alias] of retained.values()) { const list = aliases.get(key) ?? []; list.push(alias); aliases.set(key, list); }
  // Evict history before building candidates, so a full replacement stays within the total work budget.
  for (const key of prior.keys()) if (!aliases.has(key)) prior.delete(key);
  // A successful disappearance is a no-contribution candidate, subject to the same confirmation rule.
  for (const [key, old] of prior) if (!pools.has(key)) {
    check(); pools.set(key, { provider: old.provider, model: old.model, ...(old.kind === undefined ? {} : { kind: old.kind }), aliases: new Set(old.aliases), sources: new Set(old.sources), origin: old.origin, perRequest: false });
  }
  const candidates = new Map<string, EffectiveIdentity>(); const maxima = new Map<string, Price>();
  for (const [key, p] of pools) {
    check(); const uncertain = p.uncertain === undefined ? undefined : cautiousPrice(p.uncertain);
    const token = p.clean === undefined ? uncertain : uncertain === undefined ? p.clean : maxPrice(p.clean, uncertain);
    if (token === undefined) continue;
    const price = candidatePrice(p.clean, uncertain, p.perRequest)!;
    candidates.set(key, { provider: p.provider, model: p.model, ...(p.kind === undefined ? {} : { kind: p.kind }), aliases: [...p.aliases], sources: [...p.sources], origin: p.origin, ...price, knownTokenPrice: true, tokenPrice: maxPrice(token, token) });
    addMaximum(maxima, p.provider, p.kind, token);
  }
  for (const [key, p] of pools) if (!candidates.has(key)) {
    check(); const provider = maxima.get(JSON.stringify([p.provider, p.kind ?? "all"])) ?? maxima.get(JSON.stringify([p.provider, "all"]));
    const price = p.perRequest || provider === undefined ? flat : { ...cautiousPrice(provider), estimated: true };
    candidates.set(key, { provider: p.provider, model: p.model, ...(p.kind === undefined ? {} : { kind: p.kind }), aliases: [...p.aliases], sources: [...p.sources], origin: p.origin, ...price });
  }
  // Complete only from this identity; provider maxima are exclusively for wholly unknown identities.
  for (const [key, next] of candidates) {
    check(); candidates.set(key, { ...next, ...completePrice(next) });
  }
  const result: EffectiveIdentity[] = [];
  for (const [key, next] of candidates) {
    check(); const old = prior.get(key); const aliases = new Set([...(old?.aliases ?? []), ...next.aliases]);
    next.aliases = [...aliases];
    if (old !== undefined && lower(next, old)) {
      const required = new Set([...old.sources, ...next.sources]);
      const success = [...required].every((source) => successful.has(source));
      if (!success || old.pendingLower === undefined || !equal(next, old.pendingLower)) {
        const amount = maxEffectivePrice(old, next);
        result.push({ ...next, ...amount, ...((old.tokenPrice ?? next.tokenPrice) === undefined ? {} : { tokenPrice: maxPrice(old.tokenPrice ?? next.tokenPrice!, next.tokenPrice ?? old.tokenPrice!) }), sources: [...required], estimated: true, ...((old.knownTokenPrice || next.knownTokenPrice) ? { knownTokenPrice: true } : {}), ...(success ? { pendingLower: resolved(next) } : {}) });
        held(); continue;
      }
    }
    result.push(next);
  }
  const byKey = new Map(result.map((e) => [identityKey(e.provider, e.model), e]));
  return [...aliases].map(([key, retainedAliases]) => {
    check(); const e = byKey.get(key)!; e.aliases = retainedAliases;
    e.uncertain = uncertainComponents(e, pools.get(identityKey(e.provider, e.model))?.clean);
    return e;
  });
}
/**
 * AWS's offer never states where its one `_long_ctx` band starts (fetchAWS stores it at AWS_LONG_CONTEXT_FALLBACK): read it from the
 * identity's LiteLLM rows. The band only ever moves earlier, so a dearer long rate is never skipped inside a band.
 */
function awsBand<T extends PriceEntry | ModelFloor | ModelFallback>(row: T, band: number | undefined): T {
  if (!("longContext" in row) || row.longContext?.length !== 1 || band === undefined) return row;
  const tier = row.longContext[0]!;
  return band < tier.aboveTokens ? { ...row, longContext: [{ ...tier, aboveTokens: band }] } : row;
}
function addMaximum(maxima: Map<string, Price>, provider: string, kind: PriceKind | undefined, price: Price): void {
  for (const k of kind === undefined ? ["chat", "embedding", "all"] : [kind, "all"]) {
    const key = JSON.stringify([provider, k]); const old = maxima.get(key); maxima.set(key, old === undefined ? price : maxPrice(old, price));
  }
}
export function resolved(p: ResolvedPrice): ResolvedPrice {
  return { ...copyRates(p) as Price, ...(p.derived === undefined ? {} : { derived: structuredClone(p.derived) }), ...(p.uncertain === undefined ? {} : { uncertain: structuredClone(p.uncertain) }), ...(p.longContext === undefined ? {} : { longContext: p.longContext.map((t) => ({ aboveTokens: t.aboveTokens, ...copyRates(t) })) }), ...(p.operatorReview ? { operatorReview: true } : {}), estimated: p.estimated, ...(p.knownTokenPrice ? { knownTokenPrice: true } : {}) };
}
/** Build once; requests use maps only. The same candidate policy reads legacy snapshots without rewriting them. */
export function priceBook(snapshot: PriceSnapshot | undefined, overrides: Array<PriceEntry & { origin: PriceOrigin; expiresAt: number }> = []): { identities: EffectiveIdentity[]; index: Map<string, EffectiveIdentity>; maxima: Map<string, Price>; unknown: Set<string>; redundantOverrides: number; expiresAt: number } {
  const identities = snapshot?.effective ?? effectivePrices(snapshot?.sources ?? {});
  const index = new Map<string, EffectiveIdentity>(); const maxima = new Map<string, Price>(); const knownAliases = new Set<string>();
  for (const e of identities) {
    index.set(identityKey(e.provider, e.model), e); for (const alias of e.aliases) knownAliases.add(alias);
    if (e.tokenPrice !== undefined) addMaximum(maxima, e.provider, e.kind, e.tokenPrice);
  }
  const unknown = new Set((snapshot?.sources.litellm?.unidentified ?? []).filter((e) => !knownAliases.has(e.model)).map((e) => e.model.trim().toLowerCase()));
  let redundantOverrides = 0; let expiresAt = Infinity;
  for (const e of overrides) {
    const key = identityKey(e.provider, e.model); if (index.has(key) || unknown.has(e.model.trim().toLowerCase())) { redundantOverrides++; continue; }
    expiresAt = Math.min(expiresAt, e.expiresAt);
    const price = completePrice({ ...e, estimated: false, knownTokenPrice: true } as ResolvedPrice);
    index.set(key, { ...e, ...price, uncertain: uncertainComponents(price, e), aliases: [e.model], sources: [], estimated: false, knownTokenPrice: true, tokenPrice: price });
    addMaximum(maxima, e.provider, e.kind, price);
  }
  return { identities, index, maxima, unknown, redundantOverrides, expiresAt };
}
export function lookupPrice(book: ReturnType<typeof priceBook>, provider: string, model: string, kind: PriceKind): ResolvedPrice {
  const identity = book.index.get(identityKey(provider, model)); if (identity !== undefined) return resolved(identity);
  if (book.unknown.has(model.trim().toLowerCase())) return { ...flat };
  const maximum = book.maxima.get(JSON.stringify([provider, kind])) ?? book.maxima.get(JSON.stringify([provider, "all"]));
  return maximum === undefined ? { ...flat } : { ...completePrice(cautiousPrice(maximum)), estimated: true };
}

/** R3a injected sources adapt to the same candidate policy; production snapshots expose the published effective result. */
export async function resolvePrice(source: PriceSource, provider: string, model: string, ceiling = FLAT_CEILING_MICROS_PER_MTOK, signal?: AbortSignal, kind: PriceKind = "chat"): Promise<ResolvedPrice> {
  const review: ResolvedPrice = { inputMicrosPerMTok: Number.MAX_SAFE_INTEGER, outputMicrosPerMTok: Number.MAX_SAFE_INTEGER, estimated: true, operatorReview: true };
  if (source.effectiveFor !== undefined) {
    try {
      const price = await source.effectiveFor(provider, model, kind);
      if (typeof price?.estimated === "boolean" && (price.priceVersion === undefined || whole(price.priceVersion)) && (price.knownTokenPrice === undefined || price.knownTokenPrice === true) && validPrice({ ...price, estimated: false }, Number.MAX_SAFE_INTEGER)) return price;
    } catch { /* Unreadable effective money is never replaced by a cheaper guess. */ }
    return review;
  }
  let floor: Price | undefined; let clean: Price | undefined; let perRequest: boolean;
  try { perRequest = await source.fallbackFor?.(provider, model) !== undefined; } catch { perRequest = true; }
  try {
    const value = await source.floorFor?.(provider, model);
    if (value !== undefined) { if (!validPrice(value, Number.MAX_SAFE_INTEGER)) return review; floor = value; }
  } catch { return review; }
  try { const value = await source.priceFor(provider, model, signal); if (validPrice(value)) clean = value; } catch { /* R3a: a missing price uses the cautious fallback. */ }
  const own = candidatePrice(clean, floor, perRequest);
  if (own !== undefined) return { ...resolved(own), ...(floor === undefined ? {} : { knownTokenPrice: true }) };
  try {
    const price = await source.cautiousFor?.(provider, kind);
    if (validPrice(price, Number.MAX_SAFE_INTEGER)) return { ...price, estimated: true };
    const legacy = await source.dearestKnown?.(provider);
    if (validRate(legacy)) { const rate = Math.ceil(legacy * CAUTION_FACTOR); return { inputMicrosPerMTok: rate, outputMicrosPerMTok: rate, estimated: true }; }
  } catch { /* Keep the configured R3a fallback. */ }
  const fallback = validRate(ceiling) ? ceiling : FLAT_CEILING_MICROS_PER_MTOK;
  return { inputMicrosPerMTok: fallback, outputMicrosPerMTok: fallback, estimated: true };
}
