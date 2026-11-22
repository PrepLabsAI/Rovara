import { agentXError, type RunPrice } from "@agentx/contracts";

/** A renewed quote must keep the identity and stay within the first accepted rates. */
function aboveCeiling(p: RunPrice, ceiling: RunPrice | undefined): boolean {
  if (ceiling === undefined) return false;
  return p.model !== ceiling.model || p.companyId !== ceiling.companyId || p.provider !== ceiling.provider || p.sourceId !== ceiling.sourceId
    || p.connectionRevision !== ceiling.connectionRevision || p.catalogModel !== ceiling.catalogModel || p.inputUsdPerMillion > ceiling.inputUsdPerMillion
    || p.outputUsdPerMillion > ceiling.outputUsdPerMillion || p.cacheWriteUsdPerMillion > ceiling.cacheWriteUsdPerMillion || p.cacheReadUsdPerMillion > ceiling.cacheReadUsdPerMillion;
}

/** Keep the first accepted price as the ceiling across access renewals. */
export function acceptedRunPrice(price: RunPrice | undefined, requiredPriceModel: string | undefined, ceiling: RunPrice | undefined, now: () => number): RunPrice | undefined {
  if (requiredPriceModel !== undefined || price !== undefined || ceiling !== undefined) {
    const p = price;
    if (p === undefined || (requiredPriceModel !== undefined && p.model !== requiredPriceModel) || p.expiresAt <= now() || aboveCeiling(p, ceiling)) {
      console.error(JSON.stringify({ event: "hosted_run_price_unavailable" }));
      throw agentXError("RUNTIME_UNAVAILABLE", "AgentX does not know this model's price, so it did not start the run");
    }
    return ceiling ?? p;
  }
  return ceiling;
}
