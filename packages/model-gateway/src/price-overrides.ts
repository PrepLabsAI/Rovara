import { record } from "./model-gateway-token.js";
import { priceDate } from "./price-classify.js";
import { DAY_MS, MAX_OVERRIDES, OVERRIDE_MAX_DAYS } from "./price-constants.js";
import { validEntry, type PriceEntry } from "./price-snapshot.js";
/** No operator-entered prices; reviewed, expiring gaps only. */
export const PRICE_OVERRIDES: readonly unknown[] = [];
export function validOverrides(value: unknown, now: number): Array<PriceEntry & { verifiedAt: number; expiresAt: number }> {
  if (!Array.isArray(value) || value.length > MAX_OVERRIDES || !Number.isSafeInteger(now) || now < 0) return [];
  const entries: Array<PriceEntry & { verifiedAt: number; expiresAt: number }> = [];
  for (const candidate of value as unknown[]) {
    const v = record(candidate); if (v === undefined) continue;
    const verified = priceDate(v.verifiedOn); const expires = priceDate(v.expiresOn); const rates = record(v.rates);
    if (verified === undefined || expires === undefined || verified > now || expires <= now || expires <= verified || expires - verified > OVERRIDE_MAX_DAYS * DAY_MS || typeof v.reason !== "string" || v.reason.length === 0 || v.reason.length > 512 || rates === undefined) continue;
    const e = { provider: v.provider, model: v.model, kind: v.kind, inputMicrosPerMTok: rates.inputMicrosPerMTok, outputMicrosPerMTok: rates.outputMicrosPerMTok };
    if (validEntry(e)) entries.push({ ...e, verifiedAt: verified, expiresAt: expires });
  }
  return entries;
}
