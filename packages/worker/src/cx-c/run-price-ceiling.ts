import { agentXError, type RunPrice } from "@agentx/contracts";

/** A renewed quote must keep the identity and stay within the first accepted rates. */
function aboveCeiling(p: RunPrice, ceiling: RunPrice | undefined): boolean {
  if (ceiling === undefined) return false;
  return p.model !== ceiling.model || p.companyId !== ceiling.companyId || p.provider !== ceiling.provider || p.sourceId !== ceiling.sourceId
    || p.connectionRevision !== ceiling.connectionRevision || p.catalogModel !== ceiling.catalogModel || p.inputUsdPerMillion > ceiling.inputUsdPerMillion
    || p.outputUsdPerMillion > ceiling.outputUsdPerMillion || p.cacheWriteUsdPerMillion > ceiling.cacheWriteUsdPerMillion || p.cacheReadUsdPerMillion > ceiling.cacheReadUsdPerMillion;
}

/**
 * PRICE-BANDS: the ceiling's base band stays only while a renewed quote still states one that is no dearer, and starts no sooner (a smaller `upToInputTokens` means the long band begins earlier): any change of either
 * drops the band, and the run is counted at the pooled ceiling alone (never below what the gateway settles).
 */
function keepBaseBandInside(ceiling: RunPrice, renewed: RunPrice): RunPrice {
  const kept = ceiling.baseBand;
  if (kept === undefined) return ceiling;
  const now = renewed.baseBand;
  const holds = now !== undefined && now.upToInputTokens >= kept.upToInputTokens && now.inputUsdPerMillion <= kept.inputUsdPerMillion && now.outputUsdPerMillion <= kept.outputUsdPerMillion
    && now.cacheWriteUsdPerMillion <= kept.cacheWriteUsdPerMillion && now.cacheReadUsdPerMillion <= kept.cacheReadUsdPerMillion;
  if (holds) return ceiling;
  const { baseBand: _dropped, ...pooled } = ceiling; void _dropped;
  return pooled;
}

/** Keep the first accepted price as the ceiling across access renewals. */
export function acceptedRunPrice(price: RunPrice | undefined, requiredPriceModel: string | undefined, ceiling: RunPrice | undefined, now: () => number): RunPrice | undefined {
  if (requiredPriceModel !== undefined || price !== undefined || ceiling !== undefined) {
    const p = price;
    if (p === undefined || (requiredPriceModel !== undefined && p.model !== requiredPriceModel) || p.expiresAt <= now() || aboveCeiling(p, ceiling)) {
      console.error(JSON.stringify({ event: "hosted_run_price_unavailable" }));
      throw agentXError("RUNTIME_UNAVAILABLE", "AgentX does not know this model's price, so it did not start the run");
    }
    return ceiling === undefined ? p : keepBaseBandInside(ceiling, p);
  }
  return ceiling;
}
