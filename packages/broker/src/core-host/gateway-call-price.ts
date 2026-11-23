import { RunPriceSchema, type RunPrice } from "@agentx/contracts";

/** Conservative micro-dollar bound using the authorized rates and actual serialized Messages bytes. */
export function gatewayCallUsd(price: RunPrice | undefined, call: { system: string; user: string; maxOutputTokens: number }): number | undefined {
  const parsed = RunPriceSchema.safeParse(price);
  if (!parsed.success || !Number.isSafeInteger(call.maxOutputTokens) || call.maxOutputTokens < 1) return undefined;
  const p = parsed.data;
  const bytes = Buffer.byteLength(JSON.stringify({ model: p.model, max_tokens: call.maxOutputTokens, system: call.system, messages: [{ role: "user", content: call.user }] }));
  const micros = Math.ceil((bytes + 256) * Math.max(p.inputUsdPerMillion, p.cacheWriteUsdPerMillion, p.cacheReadUsdPerMillion) + call.maxOutputTokens * p.outputUsdPerMillion);
  return Number.isSafeInteger(micros) && micros > 0 ? micros / 1_000_000 : undefined;
}
