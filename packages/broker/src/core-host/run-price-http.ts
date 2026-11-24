import { RunPriceSchema, OrgIdSchema, runPriceWithBaseBand, type RunPrice } from "@agentx/contracts";
import { boundedText, signServiceToken, type OfferedModelsHttpInputs } from "./offered-models-http.js";
/** Existing signed company price read; never a display-price or cross-provider catalog substitute. */
export function runPriceReader(input: OfferedModelsHttpInputs): (companyId: string, model: string) => Promise<RunPrice | undefined> {
  return async (companyId, model) => {
    if (!OrgIdSchema.safeParse(companyId).success || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(model)) return undefined;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>(resolve => { timer = setTimeout(() => { abort.abort(); resolve(undefined); }, input.timeoutMs ?? 4_000); });
    const read = async () => {
      const token = await signServiceToken(input, companyId, "rovara-model-gateway-rate-quote");
      const response = await (input.fetch ?? fetch)(`${input.gatewayUrl.replace(/\/+$/u, "")}/v1/service/companies/${companyId}/rate-quote?${new URLSearchParams({ model, runPrice: "1" }).toString()}`, {
        method: "GET", redirect: "error", signal: abort.signal, headers: { accept: "application/json", authorization: `Bearer ${token}` },
      });
      if (response.status !== 200) { await response.body?.cancel().catch(() => undefined); return undefined; }
      const body = JSON.parse(await boundedText(response, 65_536)) as { runPrice?: unknown; runPriceBaseBand?: unknown } | null;
      const parsed = RunPriceSchema.safeParse(body?.runPrice);
      if (!parsed.success || parsed.data.companyId !== companyId || parsed.data.model !== model || parsed.data.expiresAt <= (input.now?.() ?? Date.now())) return undefined;
      // PRICE-BANDS: the quote's base band, when the gateway states one (an older gateway does not: the pooled ceiling alone, as before). One that is not inside the pooled rates is left out.
      return runPriceWithBaseBand(parsed.data, body?.runPriceBaseBand);
    };
    try { return await Promise.race([read(), timeout]); } catch { return undefined; }
    finally { clearTimeout(timer); }
  };
}
