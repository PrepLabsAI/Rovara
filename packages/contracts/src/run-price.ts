import { z } from "zod";
import { OrgIdSchema } from "./browser-ids.js";
/** Gateway snapshot bounds for an entire run whose future context size is unknown. USD per million tokens. */
const paid = z.number().finite().positive().max(1_000_000).refine(value => value * 1_000_000 >= 1);
/**
 * PRICE-BANDS: the model's BASE band, beside the pooled maxima of the run price. A call whose whole input (plain + cache read + cache write) is at most `upToInputTokens` is settled at these rates; a bigger one at a
 * long-context band, which the pooled figures bound. Optional: a run price without it is the pooled ceiling alone, exactly as before. The gateway's signed task token carries it inside `runPrice` (Cloud
 * `parseRunPrice`); on the wire to a worker and in the gateway's quote it rides BESIDE `runPrice` (`runPriceBaseBand`), so an older reader of the strict `runPrice` object is not broken.
 */
export const RunPriceBaseBandSchema = z.object({
  upToInputTokens: z.number().int().positive().safe(),
  inputUsdPerMillion: paid, outputUsdPerMillion: paid, cacheWriteUsdPerMillion: paid, cacheReadUsdPerMillion: z.number().finite().nonnegative().max(1_000_000),
}).strict();
export type RunPriceBaseBand = z.infer<typeof RunPriceBaseBandSchema>;
const RATE_KEYS = ["inputUsdPerMillion", "outputUsdPerMillion", "cacheWriteUsdPerMillion", "cacheReadUsdPerMillion"] as const;
/** A band is a LOWER price inside the pooled ceiling: no rate of it may be above the pooled rate beside it. */
const bandInsidePool = (price: { baseBand?: RunPriceBaseBand | undefined } & Record<typeof RATE_KEYS[number], number>): boolean =>
  price.baseBand === undefined || RATE_KEYS.every(key => price.baseBand![key] <= price[key]);
export const RunPriceSchema = z.object({
  companyId: OrgIdSchema, model: z.string().min(1).max(256), provider: z.string().min(1).max(64),
  sourceId: z.string().min(1).max(512), connectionRevision: z.string().min(1).max(512),
  catalogModel: z.string().min(1).max(256), snapshotHash: z.string().regex(/^[a-f0-9]{64}$/u),
  snapshotVersion: z.number().int().positive().safe(), expiresAt: z.number().int().positive().safe(),
  inputUsdPerMillion: paid, outputUsdPerMillion: paid,
  cacheWriteUsdPerMillion: paid, cacheReadUsdPerMillion: z.number().finite().nonnegative().max(1_000_000),
  baseBand: RunPriceBaseBandSchema.optional(),
}).strict().refine(bandInsidePool, { path: ["baseBand"], message: "a base band cannot be dearer than the pooled run price" });
export type RunPrice = z.infer<typeof RunPriceSchema>;

/** The run price with a base band the gateway's quote stated beside it. A band that does not parse or is not inside the pooled rates is left out (the pooled ceiling alone, never a guess). */
export function runPriceWithBaseBand(price: RunPrice, band: unknown): RunPrice {
  if (band === undefined) return price;
  const parsed = RunPriceSchema.safeParse({ ...price, baseBand: band });
  return parsed.success ? parsed.data : price;
}

/** The two parts of a run price for a worker: `runPrice` in its pooled shape (what every older worker parses strictly) and the base band beside it, when there is one. */
export function splitRunPriceBaseBand(price: RunPrice): { runPrice: Omit<RunPrice, "baseBand">; runPriceBaseBand?: RunPriceBaseBand } {
  const { baseBand, ...pooled } = price;
  return { runPrice: pooled, ...(baseBand === undefined ? {} : { runPriceBaseBand: baseBand }) };
}
