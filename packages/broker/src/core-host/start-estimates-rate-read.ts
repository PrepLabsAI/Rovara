import { z } from "zod";
import { RateQuoteV1Schema, OrgIdSchema, type QuoteModel, type QuoteSource, type QuotePrice } from "@agentx/contracts";
import { boundedText, signServiceToken, type OfferedModelsHttpInputs } from "./offered-models-http.js";
import { readGatewayUrl } from "./gateway-model-access.js";
import type { TokenSigner } from "../developer/tokens.js";
const envelope = z.object({ state: z.literal("available"), value: RateQuoteV1Schema }).strict();
export interface PreviewRateQuote { model: QuoteModel; source: QuoteSource; ref: QuotePrice; expiresAt: string }
export type PreviewRateReader = (companyId: string, model: string) => Promise<PreviewRateQuote | undefined>;
/** E's existing read only: no model invocation, reservation, key read or new IAM permission. */
export function previewRateQuoteReader(input: OfferedModelsHttpInputs): PreviewRateReader {
 return async (companyId, model) => {
  if (!OrgIdSchema.safeParse(companyId).success || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(model)) return undefined;
  const abort = new AbortController();let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>(resolve => { timer = setTimeout(() => { abort.abort();resolve(undefined); }, input.timeoutMs ?? 4_000); });
  const read = async (): Promise<PreviewRateQuote | undefined> => {
   const token = await signServiceToken(input, companyId, "rovara-model-gateway-rate-quote");
   const response = await (input.fetch ?? fetch)(`${input.gatewayUrl.replace(/\/+$/u, "")}/v1/service/companies/${companyId}/rate-quote?${new URLSearchParams({ model }).toString()}`, { method: "GET", redirect: "error", signal: abort.signal, headers: { accept: "application/json", authorization: `Bearer ${token}` } });
   if (response.status !== 200) { await response.body?.cancel().catch(() => undefined);return undefined; }
   const parsed = envelope.safeParse(JSON.parse(await boundedText(response, 65_536)));
   if (!parsed.success) return undefined;
   const q = parsed.data.value, now = input.now?.() ?? Date.now();
   if (Date.parse(q.asOf) > now || Date.parse(q.expiresAt) <= now) return undefined;
   return { model: q.model, source: q.source, ref: q.ref, expiresAt: q.expiresAt };
  };
  try { return await Promise.race([read(), timeout]); } catch { return undefined; }
  finally { clearTimeout(timer); }
 };
}
export function previewRateReaderFromEnvironment(env: NodeJS.ProcessEnv, taskTokens: (() => { signer: TokenSigner; issuer: string } | undefined) | undefined): PreviewRateReader | undefined {
 const gatewayUrl = readGatewayUrl(env);
 if (typeof gatewayUrl !== "string" || taskTokens === undefined) return undefined;
 return async (companyId, model) => {
  try { const tokens = taskTokens();return tokens === undefined ? undefined : await previewRateQuoteReader({ gatewayUrl, ...tokens })(companyId, model); } catch { return undefined; }
 };
}
