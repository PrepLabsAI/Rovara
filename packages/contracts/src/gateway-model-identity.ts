import { z } from "zod";
/** Approved lossless identity for a connected gateway model. No credential material. */
export const GatewayModelIdentitySchema = z.object({
  provider: z.literal("openrouter"),
  sourceId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u),
  connectionRevision: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u),
  modelId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,62}\/[a-z0-9][a-z0-9._-]{0,62}$/u).refine(value => !["auto", "free"].includes(value.split("/")[1]!)),
}).strict();
export type GatewayModelIdentity = z.infer<typeof GatewayModelIdentitySchema>;
