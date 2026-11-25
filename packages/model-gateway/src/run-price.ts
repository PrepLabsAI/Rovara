import { openRouterPolicy, type OpenRouterTariff } from "./openrouter-policy.js";
import type { RunPrice, TaskClaims } from "./model-gateway-token.js";
import type { ResolvedPrice } from "./price.js";
import { completePrice } from "./price-tiers.js";
import type { ChargeSource } from "./charge-producer.js";

/** Why a signed run price does not fit the admitted account and tariff: a fixed word per check (logged on a refusal; never sent to the client). */
export type RunPriceDenial = "company_mismatch" | "model_mismatch" | "token_expired" | "provider_mismatch" | "source_mismatch" | "connection_changed" | "tariff_snapshot_changed" | "price_operator_review" | "price_estimated" | "price_version_changed" | "rate_above_ceiling";

/** The first check that fails, or undefined when the admitted account and effective tariff fit the signed authorization. */
export function runPriceDenial(claims: TaskClaims, provider: string, model: string, source: ChargeSource | undefined, price: ResolvedPrice, now: number, tariffs?: readonly OpenRouterTariff[]): RunPriceDenial | undefined {
  const grant: RunPrice | undefined = claims.runPrice;
  if (grant === undefined) return undefined; // Existing laptop and ordinary task tokens.
  if (grant.companyId !== claims.cid) return "company_mismatch";
  if (claims.mdl.length !== 1 || grant.model !== claims.mdl[0] || grant.catalogModel !== model) return "model_mismatch";
  if (grant.expiresAt <= now) return "token_expired";
  if (grant.provider !== provider || source?.source.provider !== provider) return "provider_mismatch";
  if (source === undefined || grant.sourceId !== source.source.id) return "source_mismatch";
  if (grant.connectionRevision !== source.source.connectionRevision) return "connection_changed";
  if (provider === "openrouter" && openRouterPolicy(model, now, tariffs)?.hash !== grant.snapshotHash) return "tariff_snapshot_changed";
  if (price.operatorReview) return "price_operator_review";
  if (price.estimated && !price.knownTokenPrice) return "price_estimated";
  if (price.priceVersion !== grant.snapshotVersion) return "price_version_changed";
  const completed = completePrice(price);
  const fits = [completed, ...(completed.longContext ?? []).map((tier) => ({ ...completed, ...tier }))].every((r) =>
    r.inputMicrosPerMTok / 1_000_000 <= grant.inputUsdPerMillion && r.outputMicrosPerMTok / 1_000_000 <= grant.outputUsdPerMillion &&
    r.cacheReadMicrosPerMTok! / 1_000_000 <= grant.cacheReadUsdPerMillion &&
    Math.max(r.cacheWrite5mMicrosPerMTok!, r.cacheWrite1hMicrosPerMTok!) / 1_000_000 <= grant.cacheWriteUsdPerMillion);
  if (!fits) return "rate_above_ceiling";
  // PRICE-BANDS: a signed base band is what the run counts its spend at below its threshold, so the real base rates must not be above it, and no long-context band may start below its limit (a call between would be charged the long rates and counted at the base).
  const band = grant.baseBand;
  if (band !== undefined) {
    const lowest = Math.min(Infinity, ...(completed.longContext ?? []).map((tier) => tier.aboveTokens));
    if (completed.inputMicrosPerMTok / 1_000_000 > band.inputUsdPerMillion || completed.outputMicrosPerMTok / 1_000_000 > band.outputUsdPerMillion
      || completed.cacheReadMicrosPerMTok! / 1_000_000 > band.cacheReadUsdPerMillion
      || Math.max(completed.cacheWrite5mMicrosPerMTok!, completed.cacheWrite1hMicrosPerMTok!) / 1_000_000 > band.cacheWriteUsdPerMillion
      || lowest < band.upToInputTokens) return "rate_above_ceiling";
  }
  return undefined;
}

/** The admitted account and effective tariff must fit the signed authorization. */
export function runPriceAllows(claims: TaskClaims, provider: string, model: string, source: ChargeSource | undefined, price: ResolvedPrice, now: number, tariffs?: readonly OpenRouterTariff[]): boolean {
  return runPriceDenial(claims, provider, model, source, price, now, tariffs) === undefined;
}
