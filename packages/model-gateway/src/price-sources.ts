import { RATE_KEYS, type RateKey } from "./price-tiers.js";
import type { TokenRates } from "./price.js";
import { record, whole } from "./model-gateway-token.js";
import { priceKey, validEntry, validFallback, validFloor, validLimit, validUnidentified, type UnidentifiedRow, type ModelFloor, type ModelFallback, type ModelLimit, type PriceEntry } from "./price-snapshot.js";
import { mediaRatesOf, type ModelMediaRates } from "./media-price.js";
import { deprecatedRates, knownRates, priceKind, priceProvider, ratesOf, tokenRateField } from "./price-classify.js";
import { AWS_LONG_CONTEXT_FALLBACK, AWS_MAX_BYTES, FETCH_DEADLINE_MS, FETCH_TIMEOUT_MS, LITELLM_MAX_BYTES, MAX_AWS_REGIONS, MAX_BAD_PRICE_FRACTION, MAX_ENTRIES_PER_SOURCE, MAX_NODES, MAX_PRICE_DEPTH, MICROS_PER_USD, MIN_AWS_MODELS, MIN_LITELLM_MODELS, PRICE_MAX, SHRINK_FLOOR } from "./price-constants.js";
export const LITELLM_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
export const AWS_HOST = "pricing.us-east-1.amazonaws.com";
export const AWS_REGIONS = ["us-east-1", "us-west-2"] as const;
export interface PriceTransport { get(url: string, options: { maxBytes: number; timeoutMs: number; signal: AbortSignal }): Promise<{ status: number; body: Uint8Array }> }
export interface PriceReport { skipped: string[]; ignoredLower: number; anthropicSkipped?: Readonly<Record<string, number>> }
export type PriceFetchResult = { ok: true; entries: PriceEntry[]; fallbacks?: ModelFallback[]; floors?: ModelFloor[]; unidentified?: UnidentifiedRow[]; limits?: ModelLimit[]; media?: ModelMediaRates[]; drops?: PriceEntry[]; report: PriceReport } | { ok: false; reason: string };
export interface SourceLimits { now?: number; minModels?: number; maxBytes?: number; deadlineMs?: number; timeoutMs?: number; previous?: readonly PriceEntry[]; regions?: readonly string[] }
const failure = (): PriceFetchResult => ({ ok: false, reason: "invalid source" });
const awsUrl = (region: string): string => `https://${AWS_HOST}/offers/v1.0/aws/AmazonBedrockFoundationModels/current/${region}/index.json`;
function allowedUrl(text: string): boolean {
  try { const u = new URL(text); return u.protocol === "https:" && u.username === "" && u.password === "" && u.port === "" && u.search === "" && u.hash === "" && (text === LITELLM_URL || (u.hostname === AWS_HOST && /^\/offers\/v1\.0\/aws\/AmazonBedrockFoundationModels\/current\/[a-z]{2}(?:-gov)?-[a-z]+-\d\/index\.json$/u.test(u.pathname))); } catch { return false; }
}
/** Race each dependency with abort: even a fake or non-cooperative transport cannot extend the deadline. */
async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error("price fetch unavailable"));
    if (signal.aborted) { void operation.catch(() => undefined); abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    void operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
export function fetchTransport(fetchFn: typeof fetch): PriceTransport {
  return { async get(url, options) {
    if (!allowedUrl(url) || !whole(options.maxBytes) || options.maxBytes < 1 || !whole(options.timeoutMs) || options.timeoutMs < 1) throw new Error("price fetch unavailable");
    const controller = new AbortController(); const abort = () => controller.abort();
    options.signal.addEventListener("abort", abort, { once: true }); if (options.signal.aborted) abort();
    const timer = setTimeout(abort, options.timeoutMs); let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await abortable(fetchFn(url, { redirect: "error", signal: controller.signal }), controller.signal);
      if (response.status !== 200 || response.redirected || response.url !== url || !allowedUrl(response.url) || response.body === null) throw new Error("price fetch unavailable");
      reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
      for (;;) {
        const next = await abortable(reader.read(), controller.signal); if (next.done) break;
        bytes += next.value.byteLength; if (bytes > options.maxBytes) throw new Error("price fetch unavailable"); chunks.push(next.value);
      }
      return { status: 200, body: Buffer.concat(chunks) };
    } catch { throw new Error("price fetch unavailable"); }
    finally { clearTimeout(timer); controller.abort(); options.signal.removeEventListener("abort", abort); if (reader !== undefined) void reader.cancel().catch(() => undefined); }
  } };
}
interface Budget { bytes: number; nodes: number; entries: number; maxBytes: number; deadline: number; signal: AbortSignal; timeoutMs: number }
/** Port of parked bounded(): one iterative node/depth/time budget for every regional input. */
function bounded(root: unknown, budget: Budget): boolean {
  const pending = [{ value: root, depth: 0 }];
  while (pending.length > 0) {
    const node = pending.pop()!; budget.nodes++;
    if (budget.nodes > MAX_NODES || node.depth > MAX_PRICE_DEPTH || performance.now() > budget.deadline || budget.signal.aborted) return false;
    if (typeof node.value !== "object" || node.value === null) continue;
    const keys = Object.keys(node.value);
    if (keys.length + pending.length + budget.nodes > MAX_NODES) return false;
    for (const key of keys) pending.push({ value: (node.value as Record<string, unknown>)[key], depth: node.depth + 1 });
  }
  return true;
}
async function read(transport: PriceTransport, url: string, budget: Budget): Promise<Record<string, unknown>> {
  if (!allowedUrl(url)) throw new Error("invalid source");
  const response = await abortable(transport.get(url, { maxBytes: budget.maxBytes - budget.bytes, timeoutMs: Math.min(budget.timeoutMs, Math.max(1, Math.ceil(budget.deadline - performance.now()))), signal: budget.signal }), budget.signal);
  if (response.status !== 200 || !(response.body instanceof Uint8Array)) throw new Error("invalid source");
  budget.bytes += response.body.byteLength;
  if (budget.bytes > budget.maxBytes || performance.now() > budget.deadline || budget.signal.aborted) throw new Error("invalid source");
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.body));
  if (!bounded(value, budget)) throw new Error("invalid source");
  const result = record(value); if (result === undefined) throw new Error("invalid source"); return result;
}
async function withBudget(limits: SourceLimits, maxBytes: number, job: (budget: Budget, now: number) => Promise<PriceFetchResult>): Promise<PriceFetchResult> {
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const now = limits.now ?? Date.now(); const bytes = limits.maxBytes ?? maxBytes; const duration = limits.deadlineMs ?? FETCH_DEADLINE_MS; const timeoutMs = limits.timeoutMs ?? FETCH_TIMEOUT_MS;
    if (!whole(now) || !whole(bytes) || bytes < 1 || bytes > maxBytes || !whole(duration) || duration < 1 || duration > FETCH_DEADLINE_MS || !whole(timeoutMs) || timeoutMs < 1 || timeoutMs > FETCH_TIMEOUT_MS || (limits.previous !== undefined && (!Array.isArray(limits.previous) || limits.previous.length > MAX_ENTRIES_PER_SOURCE || !limits.previous.every(validEntry)))) return failure();
    timer = setTimeout(() => controller.abort(), duration);
    return await job({ bytes: 0, nodes: 0, entries: 0, maxBytes: bytes, deadline: performance.now() + duration, signal: controller.signal, timeoutMs }, now);
  } catch { return failure(); }
  finally { if (timer !== undefined) clearTimeout(timer); controller.abort(); }
}
export function fetchLiteLLM(transport: PriceTransport, limits: SourceLimits = {}): Promise<PriceFetchResult> {
  return withBudget(limits, LITELLM_MAX_BYTES, async (budget, now) => {
    const map = await read(transport, LITELLM_URL, budget); const keys = Object.keys(map).filter((k) => k !== "sample_spec");
    const min = limits.minModels ?? MIN_LITELLM_MODELS;
    if (!whole(min) || min < 1 || keys.length < min || keys.length > MAX_ENTRIES_PER_SOURCE) return failure();
    const previousCount = limits.previous?.length ?? 0;
    const entries: PriceEntry[] = []; const fallbacks: ModelFallback[] = []; const floors: ModelFloor[] = []; const unidentified: UnidentifiedRow[] = []; const seen = new Set<string>(); const report: PriceReport = { skipped: [], ignoredLower: 0 };
    const anthropicSkipped = new Map<string, number>();
    const modelLimits: ModelLimit[] = []; const limitKeys = new Set<string>();
    const mediaRows: ModelMediaRates[] = []; const mediaKeys = new Set<string>();
    const skip = (reason: string, provider?: string) => { report.skipped.push(reason); if (provider === "anthropic") anthropicSkipped.set(reason, (anthropicSkipped.get(reason) ?? 0) + 1); };
    let bad = 0;
    for (const key of keys) {
      if (performance.now() > budget.deadline || budget.signal.aborted) return failure();
      const row = record(map[key]);
      if (row === undefined) { report.skipped.push("unsupported entry"); continue; }
      if (Object.entries(row).some(([field, value]) => tokenRateField(field) && (typeof value !== "number" || !Number.isFinite(value) || value < 0))) bad++;
      const provider = priceProvider(row.litellm_provider); const kind = priceKind(row.mode); const rates = ratesOf(row, now);
      // The row's own output ceiling (DEC 165/180: a request that names none is held, and capped, at it). Priced or not.
      if (provider !== undefined && row.max_output_tokens !== undefined) {
        const limit = { provider, model: key, maxOutputTokens: row.max_output_tokens };
        if (validLimit(limit) && !limitKeys.has(priceKey(limit))) { limitKeys.add(priceKey(limit)); modelLimits.push(limit); }
      }
      // Gemini audio and video prices (DEC 228e), read from the same row whatever its token price classification.
      const media = mediaRatesOf(row, provider, key, now);
      if (media !== undefined && !mediaKeys.has(priceKey(media))) { mediaKeys.add(priceKey(media)); mediaRows.push(media); }
      const perRequest = ["cost_per_request", "input_cost_per_request", "output_cost_per_request"].some((field) => Object.hasOwn(row, field));
      const known = knownRates(row);
      if (provider === undefined) {
        const u: UnidentifiedRow = { model: key, ...(kind === undefined ? {} : { kind }), ...(known === undefined ? {} : { rates: known }), ...(perRequest ? { perRequest: true } : {}) };
        if (!validUnidentified(u)) return failure(); unidentified.push(u); skip("unsupported provider"); continue;
      }
      const model = key; // Preserve exact upstream IDs for previously established identity recovery.
      if (typeof rates === "string" || kind === undefined) {
        const reason = typeof rates === "string" ? rates : "unsupported mode"; skip(reason, provider);
        // A deprecated row with every field known keeps its exact rates; pooling decides whether it may price its identity.
        const deprecated = kind === undefined ? undefined : deprecatedRates(row, now);
        if (deprecated !== undefined) {
          const floor = { provider, model, kind, ...deprecated, reason: "deprecated price" as const };
          if (!validFloor(floor) || seen.has(priceKey(floor))) return failure();
          seen.add(priceKey(floor)); floors.push(floor);
        } else if (known !== undefined) {
          const floor = { provider, model, ...(kind === undefined ? {} : { kind }), ...known, reason, ...(perRequest ? { perRequest: true as const } : {}) };
          if (!validFloor(floor) || seen.has(priceKey(floor))) return failure();
          seen.add(priceKey(floor)); floors.push(floor);
        } else {
          const fallback: ModelFallback = { provider, model, ...(kind === undefined ? {} : { kind }), reason: perRequest ? "per_request_price" : "unpriced" };
          if (!validFallback(fallback) || seen.has(priceKey(fallback))) return failure();
          seen.add(priceKey(fallback)); fallbacks.push(fallback);
        }
        continue;
      }
      const e: PriceEntry = { provider, model, kind, ...rates };
      if (!validEntry(e)) { skip("unsupported entry", provider); continue; }
      const id = priceKey(e); if (seen.has(id)) return failure(); seen.add(id);
      entries.push(e);
    }
    if (bad > keys.length * MAX_BAD_PRICE_FRACTION || entries.length + floors.length + fallbacks.length + unidentified.length === 0 || entries.length + floors.length + fallbacks.length + unidentified.length < previousCount * SHRINK_FLOOR) return failure();
    return { ok: true, entries, ...(fallbacks.length === 0 ? {} : { fallbacks }), ...(floors.length === 0 ? {} : { floors }), ...(unidentified.length === 0 ? {} : { unidentified }), ...(modelLimits.length === 0 ? {} : { limits: modelLimits }), ...(mediaRows.length === 0 ? {} : { media: mediaRows }), report: { ...report, anthropicSkipped: Object.fromEntries(anthropicSkipped) } };
  });
}
export { normalizeBedrockModel } from "./price-identity.js";
const AWS_USAGE = /_(input|output|cache_read|cache_write)_tokens(_1h)?(_long_ctx)?(_global)?_standard-Units$/u;
export function fetchAWS(transport: PriceTransport, limits: SourceLimits = {}): Promise<PriceFetchResult> {
  return withBudget(limits, AWS_MAX_BYTES, async (budget) => {
    const regions = limits.regions ?? AWS_REGIONS; const min = limits.minModels ?? MIN_AWS_MODELS;
    if (!whole(min) || min < 1 || !Array.isArray(regions) || regions.length < 1 || regions.length > MAX_AWS_REGIONS || new Set(regions).size !== regions.length || regions.some((r: unknown) => typeof r !== "string" || !/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u.test(r))) return failure();
    const models = new Map<string, { base: Partial<TokenRates>; long: Partial<TokenRates>; operatorReview: boolean }>(); const report: PriceReport = { skipped: [], ignoredLower: 0 };
    for (const region of regions as readonly string[]) {
      const offer = await read(transport, awsUrl(region), budget); const products = record(offer.products); const terms = record(record(offer.terms)?.OnDemand);
      if (products === undefined || terms === undefined || Object.keys(products).length === 0) return failure();
      budget.entries += Object.keys(products).length; if (budget.entries > MAX_ENTRIES_PER_SOURCE) return failure();
      for (const [sku, product] of Object.entries(products)) {
        if (performance.now() > budget.deadline || budget.signal.aborted) return failure();
        const attrs = record(record(product)?.attributes); const usage = typeof attrs?.usagetype === "string" ? AWS_USAGE.exec(attrs.usagetype) : null;
        if (typeof attrs?.model !== "string" || usage === null || (usage[2] !== undefined && usage[1] !== "cache_write")) { report.skipped.push("unsupported usage"); continue; }
        const name = attrs.model.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");
        let price = 0; let invalid = false; let operatorReview = false;
        const skuTerms = record(terms[sku]); if (skuTerms === undefined) return failure();
        for (const term of Object.values(skuTerms)) {
          const dims = record(record(term)?.priceDimensions); if (dims === undefined) return failure();
          for (const dimension of Object.values(dims)) {
            const d = record(dimension); if (d?.unit !== "1M tokens") return failure();
            const raw = record(d.pricePerUnit)?.USD;
            const n = typeof raw === "string" && /^(?:\d+)(?:\.\d+)?$/u.test(raw) ? Number(raw) : NaN;
            if (!Number.isFinite(n) || n <= 0) invalid = true;
            else { operatorReview ||= n > Number.MAX_SAFE_INTEGER / MICROS_PER_USD; price = Math.max(price, Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(n * MICROS_PER_USD))); }
          }
        }
        if (invalid || price === 0) return failure(); // Never publish a cheaper partial model after losing a priced tier.
        const row = models.get(name) ?? { base: {}, long: {}, operatorReview: false };
        row.operatorReview ||= operatorReview;
        const key: RateKey = usage[1] === "input" ? "inputMicrosPerMTok" : usage[1] === "output" ? "outputMicrosPerMTok" : usage[1] === "cache_read" ? "cacheReadMicrosPerMTok" : usage[2] === undefined ? "cacheWrite5mMicrosPerMTok" : "cacheWrite1hMicrosPerMTok";
        const rates = usage[3] === undefined ? row.base : row.long;
        rates[key] = Math.max(rates[key] ?? 0, price);
        models.set(name, row);
      }
    }
    const entries: PriceEntry[] = []; const floors: ModelFloor[] = [];
    for (const [model, rate] of models) {
      if (!rate.base.inputMicrosPerMTok || !rate.base.outputMicrosPerMTok) { report.skipped.push("missing base rate"); continue; }
      const e: PriceEntry = { provider: "bedrock", model, kind: "chat", ...rate.base as TokenRates, ...(Object.keys(rate.long).length ? { longContext: [{ aboveTokens: AWS_LONG_CONTEXT_FALLBACK, ...rate.long }] } : {}) };
      if ([rate.base, rate.long].some((r) => RATE_KEYS.some((k) => (r[k] ?? 0) > PRICE_MAX)) || rate.operatorReview) {
        const floor: ModelFloor = { ...e, reason: "token rate exceeds maximum", ...(rate.operatorReview ? { operatorReview: true } : {}) };
        if (!validFloor(floor)) return failure(); floors.push(floor); report.skipped.push("token rate exceeds maximum");
      } else { if (!validEntry(e)) return failure(); entries.push(e); }
    }
    if (entries.length + floors.length < min || entries.length + floors.length < (limits.previous?.length ?? 0) * SHRINK_FLOOR) return failure();
    return { ok: true, entries, ...(floors.length ? { floors } : {}), report };
  });
}
