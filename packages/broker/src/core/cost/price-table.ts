// What a model costs (the price table). One lookup serves the metering port, the second review's spend cap, the model picker and the per-step model rule, so a model has ONE price wherever it is asked for.
//
// Where a price comes from, in order:
//   1. the provider's own table (the `prices` of its `model-provider` plug-in: per million tokens, keyed by the provider's model id). It wins, so an owner who knows a negotiated or a gateway price states it once and it holds everywhere;
//   2. the catalog's list price (the installed model catalog, in US dollars), for a provider the catalog knows (`anthropic`, `openai`, `openrouter`, `amazon-bedrock`).
// A model neither knows is UNPRICED, and unpriced never means free. Usage of it is recorded as unknown (the ledger says "N calls not priced"), and where a cap applies it is refused: the model proxy answers
// `model_not_priced` to a budgeted call, the per-step rule leaves it out of a run that has a limit, and the broker learns it as unusable the way it learns a model an account refused (`core/model-selection/usability.ts`).
// A catalog price of zero is not a free model but a missing price (the catalog lists the free variants of an aggregator's models at 0), so it is unpriced too; only a provider's own table may say `free: true`.
import { type ModelIdentifier, type ModelPrice, type ModelProviderAdapter } from "@agentx/contracts";

/** The catalog's list prices for one model, in US dollars per million tokens. */
export interface CatalogPrices { input: number; output: number; cacheRead: number; cacheWrite: number }

export type PriceOrigin = "provider" | "catalog" | "built-in";

export interface FoundPrice {
  /** In millionths of `currency` per million tokens (what the metering port reads). */
  price: ModelPrice;
  currency: string;
  origin: PriceOrigin;
}

export interface ModelPrices {
  /** What a model costs, or undefined when no table knows it (unpriced): the figure a cost is recorded and shown at. */
  find(model: ModelIdentifier): FoundPrice | undefined;
  /** What a CAP must assume (a budget's reservation, the second review's and a diagnosis's spend cap): the same, but never lower than the catalog's list price for a model the catalog prices. */
  findCap(model: ModelIdentifier): FoundPrice | undefined;
}

export interface ModelPricesOptions {
  /** The registered `model-provider` plug-ins, read at each lookup (they are loaded after the install starts). */
  providers: () => readonly ModelProviderAdapter[];
  /** The catalog's list prices (`listPricesPerMillion` of the model runtime). Absent: only the providers' own tables price a model. */
  catalog?: ((model: ModelIdentifier) => CatalogPrices | undefined) | undefined;
}

const MICROS = 1_000_000;
const known = (value: number): boolean => Number.isFinite(value) && value > 0;

/** A catalog price as the metering port reads it, or undefined when the catalog's figure is not a price (zero or missing: not known to be free). */
export function catalogPriceOf(listed: CatalogPrices | undefined): ModelPrice | undefined {
  if (listed === undefined || !known(listed.input) || !known(listed.output)) return undefined;
  const input = Math.round(listed.input * MICROS);
  const output = Math.round(listed.output * MICROS);
  // A figure so small that it rounds to nothing is no price either: a budget would pass every call of it.
  if (input === 0 || output === 0) return undefined;
  return {
    inputMicrosPerMillionTokens: input,
    outputMicrosPerMillionTokens: output,
    // A cache price of 0 in the catalog is an absent one: without it the metering port counts cache tokens at the plain input price, which can only over-count, never hide spend.
    ...(known(listed.cacheRead) ? { cacheReadMicrosPerMillionTokens: Math.round(listed.cacheRead * MICROS) } : {}),
    ...(known(listed.cacheWrite) ? { cacheWriteMicrosPerMillionTokens: Math.round(listed.cacheWrite * MICROS) } : {}),
  };
}

/** A model's free variant on an aggregator that really does not charge for it: OpenRouter's `<model>:free`. The one built-in rule that prices a model at exactly zero. */
const FREE_VARIANT_PROVIDER = "openrouter";
const FREE_VARIANT_ID = /:free$/iu;
const ZERO_PRICE: ModelPrice = { inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0 };

/** The dearer of two prices, component by component (a cache price a table lacks counts at its input price, as the metering port reads it). */
function dearerOf(left: ModelPrice, right: ModelPrice): ModelPrice {
  const input = Math.max(left.inputMicrosPerMillionTokens, right.inputMicrosPerMillionTokens);
  return {
    inputMicrosPerMillionTokens: input,
    outputMicrosPerMillionTokens: Math.max(left.outputMicrosPerMillionTokens, right.outputMicrosPerMillionTokens),
    cacheReadMicrosPerMillionTokens: Math.max(left.cacheReadMicrosPerMillionTokens ?? left.inputMicrosPerMillionTokens, right.cacheReadMicrosPerMillionTokens ?? right.inputMicrosPerMillionTokens),
    cacheWriteMicrosPerMillionTokens: Math.max(left.cacheWriteMicrosPerMillionTokens ?? left.inputMicrosPerMillionTokens, right.cacheWriteMicrosPerMillionTokens ?? right.inputMicrosPerMillionTokens),
  };
}

export function createModelPrices(options: ModelPricesOptions): ModelPrices {
  const find = (model: ModelIdentifier): FoundPrice | undefined => {
    const provider = options.providers().find((row) => row.kind === model.provider);
    const own = provider?.prices?.models[model.modelId];
    const listed = catalogPriceOf(options.catalog?.(model));
    if (provider?.prices !== undefined && own !== undefined) {
      // A model the catalog prices is never free, whatever a plug-in says: `free` is for a model nobody lists a price for.
      if (own.free === true && listed !== undefined) return { price: listed, currency: "USD", origin: "catalog" };
      // A zero price that is not declared free is no price (a plug-in is refused at load for one; a row built by hand is read the same way), and the catalog is not asked in its place: the table named the model.
      if (own.free !== true && (!known(own.inputMicrosPerMillionTokens) || !known(own.outputMicrosPerMillionTokens))) return undefined;
      return {
        price: {
          inputMicrosPerMillionTokens: own.inputMicrosPerMillionTokens, outputMicrosPerMillionTokens: own.outputMicrosPerMillionTokens,
          ...(own.cacheReadMicrosPerMillionTokens === undefined ? {} : { cacheReadMicrosPerMillionTokens: own.cacheReadMicrosPerMillionTokens }),
          ...(own.cacheWriteMicrosPerMillionTokens === undefined ? {} : { cacheWriteMicrosPerMillionTokens: own.cacheWriteMicrosPerMillionTokens }),
        },
        currency: provider.prices.currency, origin: "provider",
      };
    }
    if (listed !== undefined) return { price: listed, currency: "USD", origin: "catalog" };
    // The catalog lists a free variant at zero (which reads as no price); it is free by the aggregator's own rule, so it is priced at exactly zero.
    if (model.provider === FREE_VARIANT_PROVIDER && FREE_VARIANT_ID.test(model.modelId)) return { price: ZERO_PRICE, currency: "USD", origin: "built-in" };
    return undefined;
  };
  return {
    find,
    findCap(model) {
      const found = find(model);
      const listed = catalogPriceOf(options.catalog?.(model));
      // A cap never assumes less than the catalog's list price: a plug-in's table is the owner's own code, and a slip in it (dollars where micros belong) must not make a paid model cost nothing under a budget.
      if (found?.origin === "provider" && found.currency === "USD" && listed !== undefined) return { price: dearerOf(found.price, listed), currency: "USD", origin: "provider" };
      return found;
    },
  };
}

/** What a usage costs at a price, in millionths of the currency, rounded to the nearest. The cache prices fall back to the plain input price. */
export function costMicrosOf(price: ModelPrice, tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }): number {
  const perMillion = tokens.input * price.inputMicrosPerMillionTokens
    + tokens.output * price.outputMicrosPerMillionTokens
    + tokens.cacheRead * (price.cacheReadMicrosPerMillionTokens ?? price.inputMicrosPerMillionTokens)
    + tokens.cacheWrite * (price.cacheWriteMicrosPerMillionTokens ?? price.inputMicrosPerMillionTokens);
  return Math.round(perMillion / MICROS);
}

/** The price per million tokens in dollars, for a place that shows or estimates in dollars (the picker, the second review's cap). Undefined: unpriced, or not in dollars. */
export function usdPerMillion(found: FoundPrice | undefined): CatalogPrices | undefined {
  if (found === undefined || found.currency !== "USD") return undefined;
  const { price } = found;
  return {
    input: price.inputMicrosPerMillionTokens / MICROS, output: price.outputMicrosPerMillionTokens / MICROS,
    cacheRead: (price.cacheReadMicrosPerMillionTokens ?? price.inputMicrosPerMillionTokens) / MICROS,
    cacheWrite: (price.cacheWriteMicrosPerMillionTokens ?? price.inputMicrosPerMillionTokens) / MICROS,
  };
}
