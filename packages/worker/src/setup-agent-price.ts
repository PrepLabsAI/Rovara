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
export interface ModelPrice { inputPerMTok: number; outputPerMTok: number; cacheReadPerMTok?: number; cacheWritePerMTok?: number }

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

/** The tokens of an assistant message's `usage` (Pi's), each class 0 when absent. */
export function tokensOfUsage(usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } | undefined): TurnTokens {
  return { input: usage?.input ?? 0, output: usage?.output ?? 0, cacheRead: usage?.cacheRead ?? 0, cacheWrite: usage?.cacheWrite ?? 0 };
}

/** What one turn costs in dollars: every token class at its own rate. */
export function turnCostUsd(price: ModelPrice, tokens: TurnTokens): number {
  const rates = priceRatesOf(price);
  return (tokens.input * rates.input + tokens.output * rates.output + tokens.cacheRead * rates.cacheRead + tokens.cacheWrite * rates.cacheWrite) / 1_000_000;
}

/**
 * The ONE input rate that bounds every input-side token: the dearest of the input, cache read and cache write rates. The next-turn reserve prices the whole carried context at it (the cache may have expired, so the
 * context may be written again) and the stand-in writer's cost ceiling uses it. Never below the input rate.
 */
export function dearestInputPerMTok(price: ModelPrice): number {
  const rates = priceRatesOf(price);
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
  return { inputPerMTok: p.inputUsdPerMillion, outputPerMTok: p.outputUsdPerMillion, cacheReadPerMTok: p.cacheReadUsdPerMillion, cacheWritePerMTok: p.cacheWriteUsdPerMillion };
}

/** The tokens one more turn may add on top of the last turn's input and output: a command's output and the model's next words, in a bound (4 KiB of text is about 1,024 tokens). */
export const SETUP_NEXT_TURN_MARGIN_TOKENS = 1_024;
