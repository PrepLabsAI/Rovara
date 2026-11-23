import { z } from "zod";
import { OrgIdSchema } from "./browser-ids.js";
/** Gateway snapshot bounds for an entire run whose future context size is unknown. USD per million tokens. */
const paid = z.number().finite().positive().max(1_000_000).refine(value => value * 1_000_000 >= 1);
export const RunPriceSchema = z.object({
  companyId: OrgIdSchema, model: z.string().min(1).max(256), provider: z.string().min(1).max(64),
  sourceId: z.string().min(1).max(512), connectionRevision: z.string().min(1).max(512),
  catalogModel: z.string().min(1).max(256), snapshotHash: z.string().regex(/^[a-f0-9]{64}$/u),
  snapshotVersion: z.number().int().positive().safe(), expiresAt: z.number().int().positive().safe(),
  inputUsdPerMillion: paid, outputUsdPerMillion: paid,
  cacheWriteUsdPerMillion: paid, cacheReadUsdPerMillion: z.number().finite().nonnegative().max(1_000_000),
}).strict();
export type RunPrice = z.infer<typeof RunPriceSchema>;
