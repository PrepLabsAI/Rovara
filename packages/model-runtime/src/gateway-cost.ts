// What a hosted call costs at the MODEL GATEWAY's own rates (task cost truth, stage 1). The gateway settles each call at the rates of the source that serves the company (Rovara AI: the Bedrock `us.` profile row;
// a company's Anthropic key: the direct row; its own Bedrock: the dearer of two rows), so a hosted run prices from what the gateway states, never from the catalog row of the model's engine NAME.
//
// Two statements of those rates exist, best first:
//   1. the RATE QUOTE (`RateQuoteV1`, the gateway's `rate-quote` answer): the base rates and every long-context band, with the 5 minute and 1 hour cache-write rates apart;
//   2. the RUN PRICE (`RunPrice`, signed into the task token): the base band beside the pooled maxima. Without a base band the pooled (dearest) rates stand for every call.
// Cache writes are priced at the dearer of the 5 minute and 1 hour rates: exact for 1 hour writes and for writes whose duration the gateway did not see (it prices those at the dearer rate), and high, never low,
// for a write the gateway saw as a 5 minute one. A long-context band applies when the call's whole input (plain + cache read + cache write) is ABOVE its threshold, as the gateway applies it.
import type { RateQuoteV1, RunPrice } from "@agentx/contracts";

const MILLION = 1_000_000;

/** USD per million tokens (the shape Pi's model cost has). */
export interface GatewayRates { input: number; output: number; cacheRead: number; cacheWrite: number }
export interface GatewayModelCost extends GatewayRates { tiers?: Array<GatewayRates & { inputTokensAbove: number }> }
/** Where a model cost came from. `run_price_pooled`: the run price had no base band, so every call is counted at the pooled (dearest) rates. */
export type GatewayCostBasis = "rate_quote" | "run_price" | "run_price_pooled";

type QuoteRates = RateQuoteV1["base"];
const ratesOfQuote = (rates: QuoteRates): GatewayRates => ({ input: rates.input / MILLION, output: rates.output / MILLION, cacheRead: rates.cacheRead / MILLION, cacheWrite: Math.max(rates.cacheWrite5m, rates.cacheWrite1h) / MILLION });

/** The model cost a rate quote states: base rates and a tier for every band. */
export function modelCostFromRateQuote(quote: RateQuoteV1): GatewayModelCost {
  const bands = [...quote.longContext].sort((left, right) => left.aboveInputTokens - right.aboveInputTokens);
  return { ...ratesOfQuote(quote.base), ...(bands.length === 0 ? {} : { tiers: bands.map((band) => ({ ...ratesOfQuote(band.rates), inputTokensAbove: band.aboveInputTokens })) }) };
}

/** The model cost a run price states: the base band when it has one (pooled above it), else the pooled rates alone. */
export function modelCostFromRunPrice(price: RunPrice): { cost: GatewayModelCost; pooledOnly: boolean } {
  const pooled: GatewayRates = { input: price.inputUsdPerMillion, output: price.outputUsdPerMillion, cacheRead: price.cacheReadUsdPerMillion, cacheWrite: price.cacheWriteUsdPerMillion };
  const band = price.baseBand;
  if (band === undefined) return { cost: pooled, pooledOnly: true };
  const base: GatewayRates = { input: band.inputUsdPerMillion, output: band.outputUsdPerMillion, cacheRead: band.cacheReadUsdPerMillion, cacheWrite: band.cacheWriteUsdPerMillion };
  return { cost: { ...base, tiers: [{ ...pooled, inputTokensAbove: band.upToInputTokens }] }, pooledOnly: false };
}

/** The model cost for a hosted run: the live rate quote, else the run price; undefined when neither is usable (the caller keeps the catalog row). */
export function gatewayModelCost(input: { rateQuote?: RateQuoteV1 | undefined; runPrice?: RunPrice | undefined; now: number }): { cost: GatewayModelCost; basis: GatewayCostBasis } | undefined {
  if (input.rateQuote !== undefined && Date.parse(input.rateQuote.expiresAt) > input.now) return { cost: modelCostFromRateQuote(input.rateQuote), basis: "rate_quote" };
  if (input.runPrice !== undefined && input.runPrice.expiresAt > input.now) {
    const { cost, pooledOnly } = modelCostFromRunPrice(input.runPrice);
    return { cost, basis: pooledOnly ? "run_price_pooled" : "run_price" };
  }
  return undefined;
}

export interface CallTokens { input: number; output: number; cacheRead: number; cacheWrite: number }

/** One call's cost in micros at a quote: the band of its whole input, rounded UP (the gateway rounds each call up, at least one micro for any usage). */
export function rateQuoteCallMicros(quote: RateQuoteV1, tokens: CallTokens, baseBandOnly = false): number {
  const whole = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  let rates = quote.base;
  if (!baseBandOnly) for (const band of [...quote.longContext].sort((left, right) => left.aboveInputTokens - right.aboveInputTokens)) if (whole > band.aboveInputTokens) rates = band.rates;
  const perMillion = BigInt(tokens.input) * BigInt(rates.input) + BigInt(tokens.output) * BigInt(rates.output) + BigInt(tokens.cacheRead) * BigInt(rates.cacheRead) + BigInt(tokens.cacheWrite) * BigInt(Math.max(rates.cacheWrite5m, rates.cacheWrite1h));
  const micros = Number((perMillion + BigInt(MILLION - 1)) / BigInt(MILLION));
  return micros === 0 && whole + tokens.output > 0 ? 1 : micros;
}

/**
 * A usage's cost in micros at a quote. With the per-call token counts, and only when they add up to the usage's own totals, each call is priced in its band and rounded up; otherwise the whole usage is
 * priced as one call at the base band (it cannot be split into calls, and a long-context call is then priced by the worker's own figure, which the booking keeps when it is higher).
 */
export function rateQuoteUsageMicros(quote: RateQuoteV1, tokens: CallTokens, calls?: readonly CallTokens[]): number {
  if (calls !== undefined && calls.length > 0) {
    const sum = calls.reduce((all, call) => ({ input: all.input + call.input, output: all.output + call.output, cacheRead: all.cacheRead + call.cacheRead, cacheWrite: all.cacheWrite + call.cacheWrite }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    if (sum.input === tokens.input && sum.output === tokens.output && sum.cacheRead === tokens.cacheRead && sum.cacheWrite === tokens.cacheWrite) return calls.reduce((all, call) => all + rateQuoteCallMicros(quote, call), 0);
  }
  return rateQuoteCallMicros(quote, tokens, true);
}
