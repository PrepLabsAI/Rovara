import { RateQuoteV1Schema, OrgIdSchema, type RateQuoteV1 } from "@agentx/contracts";
import { readGatewayUrl } from "./gateway-model-access.js";
import { boundedText, signServiceToken, type OfferedModelsHttpInputs } from "./offered-models-http.js";

/** A quote is kept this long at most (and never past its own expiry), so a booking burst reads the gateway once. */
const QUOTE_CACHE_MS = 60_000;
/** A read that found nothing is not asked again this soon. */
const MISS_CACHE_MS = 15_000;
const BODY_MAX_BYTES = 65_536;

export type GatewayQuoteReader = (companyId: string, model: string) => Promise<RateQuoteV1 | undefined>;

/**
 * The gateway's full rate quote for one company's source and model (`GET /v1/service/companies/<id>/rate-quote?model=`, the route the run price already comes from; no new gateway route, token audience or permission).
 * Task cost truth: the quote prices a hosted call at the rates the gateway settles it at (source-bound, with every long-context band and both cache-write rates). It is for PRICING only; a read that fails,
 * is stale or does not parse answers undefined (the caller keeps its own price). Cached per company and model for at most a minute.
 */
export function gatewayRateQuoteReader(input: Omit<OfferedModelsHttpInputs, "signer" | "issuer"> & { signing: () => { signer: OfferedModelsHttpInputs["signer"]; issuer: string } | undefined }): GatewayQuoteReader {
  const cache = new Map<string, { until: number; quote: RateQuoteV1 | undefined }>();
  return async (companyId, model) => {
    if (!OrgIdSchema.safeParse(companyId).success || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(model)) return undefined;
    const now = input.now?.() ?? Date.now();
    const key = `${companyId}\n${model}`;
    const kept = cache.get(key);
    if (kept !== undefined && kept.until > now) return kept.quote;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>(resolve => { timer = setTimeout(() => { abort.abort(); resolve(undefined); }, input.timeoutMs ?? 2_500); });
    const read = async (): Promise<RateQuoteV1 | undefined> => {
      const signing = input.signing();
      if (signing === undefined) return undefined;
      const token = await signServiceToken({ ...signing, ...(input.now === undefined ? {} : { now: input.now }) }, companyId, "rovara-model-gateway-rate-quote");
      const response = await (input.fetch ?? fetch)(`${input.gatewayUrl.replace(/\/+$/u, "")}/v1/service/companies/${companyId}/rate-quote?${new URLSearchParams({ model }).toString()}`, {
        method: "GET", redirect: "error", signal: abort.signal, headers: { accept: "application/json", authorization: `Bearer ${token}` },
      });
      if (response.status !== 200) { await response.body?.cancel().catch(() => undefined); return undefined; }
      const body = JSON.parse(await boundedText(response, BODY_MAX_BYTES)) as { state?: unknown; value?: unknown } | null;
      const parsed = body?.state === "available" ? RateQuoteV1Schema.safeParse(body.value) : undefined;
      if (parsed === undefined || !parsed.success) return undefined;
      return Date.parse(parsed.data.asOf) <= now && Date.parse(parsed.data.expiresAt) > now ? parsed.data : undefined;
    };
    let quote: RateQuoteV1 | undefined;
    try { quote = await Promise.race([read(), timeout]); } catch { quote = undefined; } finally { clearTimeout(timer); }
    cache.set(key, { until: quote === undefined ? now + MISS_CACHE_MS : Math.min(now + QUOTE_CACHE_MS, Date.parse(quote.expiresAt)), quote });
    if (cache.size > 512) for (const [old, row] of cache) { if (row.until <= now) cache.delete(old); }
    return quote;
  };
}

/** The reader for a root: the gateway's origin and the task-key signer it already holds; undefined where either is missing (no quote, the table prices). One reader, so its cache is shared. */
export function gatewayRateQuoteReaderFor(gatewayUrl: string | undefined, tokens: (() => { signer: OfferedModelsHttpInputs["signer"]; issuer: string } | undefined) | undefined): GatewayQuoteReader | undefined {
  if (gatewayUrl === undefined || tokens === undefined) return undefined;
  const read = gatewayRateQuoteReader({ gatewayUrl, signing: tokens });
  return async (companyId, model) => { try { return await read(companyId, model); } catch { return undefined; } };
}

/** As `gatewayRateQuoteReaderFor`, with the gateway's origin read from the deployment's environment (none, or a malformed one: no reader). */
export function gatewayRateQuoteReaderFromEnvironment(env: NodeJS.ProcessEnv, tokens: (() => { signer: OfferedModelsHttpInputs["signer"]; issuer: string } | undefined) | undefined): GatewayQuoteReader | undefined {
  const url = readGatewayUrl(env);
  return gatewayRateQuoteReaderFor(typeof url === "string" ? url : undefined, tokens);
}
