// What a setup run's model costs per million tokens (sh-setup-wire, SH14 fix round, F3). The governor stops the run before a turn could cross the budget, so it needs the model's real prices, not a guess.
// They come from the catalog the product already holds for models (`E2E_AGENT_ELIGIBLE_MODELS`: dollars per million input and output tokens), matched by the model's canonical name; when several entries
// match (regional profiles of one model) the dearest wins. A model with no entry has NO price, and a setup run does not start for it: money is never estimated from a guess.
import { E2E_AGENT_ELIGIBLE_MODELS, canonicalModelName, RunPriceSchema, agentXError, type InvocationModelRoute } from "@agentx/contracts";
import { ROUTE_PROVIDER, routeUsageIdentity, type ModelProxyOptions } from "@agentx/model-runtime";
import { listPricesPerMillion } from "@agentx/model-runtime/catalog";

/** Internal evidence from the selected proxy adapter; a payload route or an unused fallback is not metering evidence. */
export function modelSpendIsMetered(
  environment: NodeJS.ProcessEnv,
  payload: { modelRoute?: InvocationModelRoute | undefined },
  session?: { model: { provider: string; modelId: string }; piAdapter?: unknown; meteredProxy?: ModelProxyOptions | undefined },
): boolean {
  const route = payload.modelRoute;
  if (route === undefined) {
    const proxy = environment["AGENTX_MODEL_PROXY_URL"];
    return proxy !== undefined && proxy !== "";
  }
  const actual = session?.meteredProxy?.route;
  return session?.piAdapter !== undefined && session.model.provider === ROUTE_PROVIDER && session.model.modelId === route.alias
    && actual !== undefined && actual.alias === route.alias && actual.catalog === route.catalog && actual.api === route.api;
}

/**
 * What a model costs per million tokens, by token class. `inputPerMTok` is the plain (uncached) input rate. The cache rates are optional: when the price source does not carry one (the e2e list, a catalog
 * entry with no cache price) `priceRatesOf` fills it in SAFELY, never below what the provider could charge (see there).
 */
export interface ModelPrice { inputPerMTok: number; outputPerMTok: number; cacheReadPerMTok?: number; cacheWritePerMTok?: number; baseBand?: ModelPriceBand }

/**
 * PRICE-BANDS: the model's BASE band, when the gateway's signed run price states one. The pooled rates above are the dearest over the base AND every long-context band, so they over-count a call that never reached a long
 * band by the band's factor (2x for glm-5). A call whose whole input (plain + cache read + cache write, the gateway's own rule) is at most `upToInputTokens` is counted at these rates; a bigger one, and a call
 * counted without a usable band, at the pooled rates. Every rate is given.
 */
export interface ModelPriceBand { upToInputTokens: number; inputPerMTok: number; outputPerMTok: number; cacheReadPerMTok: number; cacheWritePerMTok: number }

/**
 * A cache write with no known rate is priced at twice the input rate: Anthropic-class providers charge 1.25 times input for a 5 minute write and 2 times for a 1 hour write, and the run cannot tell which one a
 * call used. The dearer one is taken, so an unknown write rate can only over-count.
 */
export const SETUP_CACHE_WRITE_FALLBACK_MULTIPLIER = 2;

/** The four rates a turn is priced at, every one filled in. */
export interface PriceRates { input: number; output: number; cacheRead: number; cacheWrite: number }

/** The tokens of one model turn, by class (`message.usage` of Pi: `input` is the uncached input, the cache classes are counted separately). */
export interface TurnTokens { input: number; output: number; cacheRead: number; cacheWrite: number }

const known = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value) && value > 0;
const given = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value) && value >= 0;

/**
 * The rate of each token class. A cache rate the source GAVE (the gateway's run price, a catalog entry with a known price) is used as given, a 0 for a cache read included. One it did not carry falls back so that
 * it never under-counts: a cache read at the plain input rate (a read is really cheaper, so this is an upper bound), and a cache write at `SETUP_CACHE_WRITE_FALLBACK_MULTIPLIER` times the input rate.
 */
export function priceRatesOf(price: ModelPrice): PriceRates {
  return {
    input: price.inputPerMTok, output: price.outputPerMTok,
    cacheRead: given(price.cacheReadPerMTok) ? price.cacheReadPerMTok : price.inputPerMTok,
    cacheWrite: given(price.cacheWritePerMTok) ? price.cacheWritePerMTok : price.inputPerMTok * SETUP_CACHE_WRITE_FALLBACK_MULTIPLIER,
  };
}

/** A band is used only when it is whole and nowhere above the pooled rates (it can only LOWER what a call is counted at); anything else is ignored, so the figure is never below the pooled one by a wrong band. */
function usableBand(price: ModelPrice): ModelPriceBand | undefined {
  const band = price.baseBand;
  if (band === undefined || !Number.isSafeInteger(band.upToInputTokens) || band.upToInputTokens <= 0) return undefined;
  const rates = priceRatesOf({ inputPerMTok: price.inputPerMTok, outputPerMTok: price.outputPerMTok, ...(price.cacheReadPerMTok === undefined ? {} : { cacheReadPerMTok: price.cacheReadPerMTok }), ...(price.cacheWritePerMTok === undefined ? {} : { cacheWritePerMTok: price.cacheWritePerMTok }) });
  const inside = (value: number, pooled: number): boolean => Number.isFinite(value) && value >= 0 && value <= pooled;
  return inside(band.inputPerMTok, rates.input) && inside(band.outputPerMTok, rates.output) && inside(band.cacheReadPerMTok, rates.cacheRead) && inside(band.cacheWritePerMTok, rates.cacheWrite) ? band : undefined;
}

/** The price a call with this many whole input tokens is counted at: the base band when it fits inside it, else the pooled price (the band is dropped, so it never applies twice). */
export function priceForInputTokens(price: ModelPrice, inputTokens: number): ModelPrice {
  const { baseBand: _band, ...pooled } = price; void _band;
  const band = usableBand(price);
  if (band === undefined || !(inputTokens <= band.upToInputTokens)) return pooled;
  return { inputPerMTok: band.inputPerMTok, outputPerMTok: band.outputPerMTok, cacheReadPerMTok: band.cacheReadPerMTok, cacheWritePerMTok: band.cacheWritePerMTok };
}

/** The tokens of an assistant message's `usage` (Pi's), each class 0 when absent. */
export function tokensOfUsage(usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } | undefined): TurnTokens {
  return { input: usage?.input ?? 0, output: usage?.output ?? 0, cacheRead: usage?.cacheRead ?? 0, cacheWrite: usage?.cacheWrite ?? 0 };
}

/**
 * CACHE-RATES: the gateway settles each call in whole micro-dollars, rounded UP, and at least one (`roundedCost`, `Math.max(1, usageCost)`). A count that adds exact fractions is below the sum of the settles by up to a micro a call
 * (staging 2026-11-23: a 15-call Haiku run counted 98,408 micros against 98,416 settled). Rates here are dollars per million tokens, so tokens x rate IS micro-dollars. `MICRO_NOISE` keeps a product that is a whole number of
 * micros up to float error (90 x 1.1 is 99.00000000000001) from being pushed a whole micro up; real fractions are at least a millionth of a micro apart (a rate is whole micros per million).
 */
const MICRO_NOISE = 1e-7;

/** What one turn costs in dollars: every token class at its own rate, rounded up to a whole micro like the gateway's settle of the same call. */
export function turnCostUsd(price: ModelPrice, tokens: TurnTokens): number {
  const rates = priceRatesOf(priceForInputTokens(price, tokens.input + tokens.cacheRead + tokens.cacheWrite));
  const micros = tokens.input * rates.input + tokens.output * rates.output + tokens.cacheRead * rates.cacheRead + tokens.cacheWrite * rates.cacheWrite;
  if (!(tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite > 0)) return micros / 1_000_000;
  return Math.max(1, Math.ceil(micros - MICRO_NOISE)) / 1_000_000;
}

/**
 * The ONE input rate that bounds every input-side token: the dearest of the input, cache read and cache write rates. The next-turn reserve prices the whole carried context at it (the cache may have expired, so the
 * context may be written again) and the stand-in writer's cost ceiling uses it. Never below the input rate.
 */
export function dearestInputPerMTok(price: ModelPrice, inputTokens?: number): number {
  // With the size of the call it bounds, the base band applies when that call stays inside it; with none, the pooled price (a ceiling over any size).
  const rates = priceRatesOf(inputTokens === undefined ? priceForInputTokens(price, Infinity) : priceForInputTokens(price, inputTokens));
  return Math.max(rates.input, rates.cacheRead, rates.cacheWrite);
}

/**
 * Hotfix 0.5.33: what the broker's LEDGER charges a routed (hosted) run. The hosted meter (broker core-host/hosted-modules.ts `createHostedMetering`, `prices.findCap`) prices a usage under the identity the worker
 * reports for a route, `routeUsageIdentity(route)` (worker pi-session.ts `reportedModel`), at the model runtime's catalog list price (`listPricesPerMillion`, hosted-modules.ts `createModelPrices({ catalog })`;
 * price-table.ts `catalogPriceOf`: both figures known and above zero, else no price). Setup prices a route by that SAME chain, so the governor's price is the ledger's price and never lower (staging `zai.glm-5` is
 * Bedrock's $1.00/$3.20, where the OpenRouter `z-ai/glm-5` entry of the e2e list says $0.60/$1.90). No price in that chain: undefined, and the run does not start (the ledger would charge its cautious fixed price; setup never guesses).
 */
function routedModelPrice(route: InvocationModelRoute): ModelPrice | undefined {
  const listed = listPricesPerMillion(routeUsageIdentity(route));
  if (listed === undefined) return undefined;
  const priced = (value: number): boolean => Number.isFinite(value) && value > 0 && Math.round(value * 1_000_000) > 0;
  if (!priced(listed.input) || !priced(listed.output)) return undefined;
  // The catalog's cache prices go with it (a missing or 0 one is filled in by `priceRatesOf`, as the ledger does).
  return { inputPerMTok: listed.input, outputPerMTok: listed.output, ...(known(listed.cacheRead) ? { cacheReadPerMTok: listed.cacheRead } : {}), ...(known(listed.cacheWrite) ? { cacheWritePerMTok: listed.cacheWrite } : {}) };
}

export function setupModelPrice(model: { provider: string; modelId: string }, route?: InvocationModelRoute): ModelPrice | undefined {
  // A routed run (hosted: the task model is `rovara-route` + the route's alias) is priced as the ledger prices it; a laptop run (no route) is priced from the e2e list below, unchanged.
  if (route !== undefined && model.provider === ROUTE_PROVIDER) return routedModelPrice(route);
  const wanted = canonicalModelName(model);
  let found: ModelPrice | undefined;
  for (const entry of E2E_AGENT_ELIGIBLE_MODELS) {
    if (canonicalModelName({ provider: entry.provider, modelId: entry.modelId }) !== wanted) continue;
    if (!Number.isFinite(entry.inputUsdPerMTok) || !Number.isFinite(entry.outputUsdPerMTok) || entry.inputUsdPerMTok < 0 || entry.outputUsdPerMTok < 0) continue;
    found = found === undefined ? { inputPerMTok: entry.inputUsdPerMTok, outputPerMTok: entry.outputUsdPerMTok }
      : { inputPerMTok: Math.max(found.inputPerMTok, entry.inputUsdPerMTok), outputPerMTok: Math.max(found.outputPerMTok, entry.outputUsdPerMTok) };
  }
  return found;
}

/** Hosted runs use the gateway's bound answer, obtained before allocating network, sandbox or session. */
export async function invocationModelPrice(model: { provider: string; modelId: string }, route?: InvocationModelRoute, proxy?: ModelProxyOptions): Promise<ModelPrice | undefined> {
  if (route === undefined || proxy?.localCatalogPricing === true) return setupModelPrice(model, route);
  const parsed = RunPriceSchema.safeParse(await proxy?.runPrice?.());
  if (!parsed.success || parsed.data.model !== route.alias || parsed.data.expiresAt <= Date.now()) {
    console.error(JSON.stringify({ event: "hosted_run_price_unavailable" }));
    throw agentXError("RUNTIME_UNAVAILABLE", "AgentX does not know this model's price, so it did not start the run");
  }
  const p = parsed.data;
  // Each token class keeps the gateway's own rate (the same figures it settles at). The write rate is the gateway's bound over a 5 minute and a 1 hour write, and its rates are the per-component maxima over its context tiers. A cache read rate of 0 is used as 0.
  // PRICE-BANDS: the signed base band comes with it when the gateway stated one; without it (an older gateway) every call is counted at the pooled rates, as before.
  const band = p.baseBand;
  return { inputPerMTok: p.inputUsdPerMillion, outputPerMTok: p.outputUsdPerMillion, cacheReadPerMTok: p.cacheReadUsdPerMillion, cacheWritePerMTok: p.cacheWriteUsdPerMillion,
    ...(band === undefined ? {} : { baseBand: { upToInputTokens: band.upToInputTokens, inputPerMTok: band.inputUsdPerMillion, outputPerMTok: band.outputUsdPerMillion, cacheReadPerMTok: band.cacheReadUsdPerMillion, cacheWritePerMTok: band.cacheWriteUsdPerMillion } }) };
}

/** The tokens one more turn may add on top of the last turn's input and output: a command's output and the model's next words, in a bound (4 KiB of text is about 1,024 tokens). */
export const SETUP_NEXT_TURN_MARGIN_TOKENS = 1_024;
