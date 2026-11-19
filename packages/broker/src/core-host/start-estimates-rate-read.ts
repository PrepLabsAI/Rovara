import { z } from "zod";
import { OrgIdSchema, type QuoteModel, type QuoteSource, type QuotePrice } from "@agentx/contracts";
import { boundedText, signServiceToken, type OfferedModelsHttpInputs } from "./offered-models-http.js";
import { readGatewayUrl } from "./gateway-model-access.js";
import type { TokenSigner } from "../developer/tokens.js";
const text = z.string().min(1).max(512), nat = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), iso = z.iso.datetime();
const rates = z.object({ input: nat, output: nat, cacheRead: nat, cacheWrite5m: nat, cacheWrite1h: nat }).strict();
const value = z.object({ version: z.literal(1), currency: z.literal("USD"), unit: z.literal("micros_per_million_tokens"),
 model: z.object({ provider: text, modelId: text }).strict(), source: z.object({ kind: z.enum(["rovara_ai", "company_key"]), id: text, name: text, provider: text, connectionRevision: text }).strict(),
 ref: z.object({ authority: z.enum(["gateway", "local_provider"]), version: text, hash: z.string().regex(/^[a-f0-9]{64}$/u), fetchedAt: iso }).strict(), region: text, asOf: iso, expiresAt: iso, base: rates,
 longContext: z.array(z.object({ aboveInputTokens: nat.positive(), rates }).strict()).max(16),
 derived: z.array(z.object({ aboveInputTokens: nat, components: z.array(z.enum(["input", "output", "cacheRead", "cacheWrite5m", "cacheWrite1h"])).max(5).refine(a => new Set(a).size === a.length) }).strict()).max(17),
}).strict();
const envelope = z.object({ state: z.literal("available"), value }).strict();
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
   if (Date.parse(q.asOf) > now || Date.parse(q.expiresAt) <= now || Date.parse(q.expiresAt) <= Date.parse(q.asOf) || Date.parse(q.ref.fetchedAt) > Date.parse(q.asOf) || !q.longContext.every((b,i,a) => i === 0 || a[i-1]!.aboveInputTokens < b.aboveInputTokens) || !q.derived.every((b,i,a) => (i === 0 || a[i-1]!.aboveInputTokens < b.aboveInputTokens) && (b.aboveInputTokens === 0 || q.longContext.some(c => c.aboveInputTokens === b.aboveInputTokens)))) return undefined;
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
