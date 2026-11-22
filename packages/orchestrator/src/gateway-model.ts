// Rovara's Slack chat and message router on the COMPANY's AI (DEC 254zzz79 (3)): a model runtime that speaks Anthropic Messages to the model gateway's answers route
// (`<gateway>/v1/answers` + `/v1/messages`), with a fresh company-scoped token for every request. The company's own connected AI source pays, inside the company's answers month and the combined company
// cap; there is no key here, no Rovara-paid Bedrock and no fallback to it.
//
//  - `token()` is asked before EVERY request (a token lasts two minutes and a chat turn can run longer); it names exactly one company, which the caller of `token` bound, never the model.
//  - The gateway's own refusals are read from the response (a pause header on a 403/422, or any other failure status) and kept as one of the fixed `ModelRefusal` kinds, never the gateway's or a
//    model's words. The Slack service says its fixed words for that kind when the turn fails; this module never sends them.
//  - A token that cannot be had, or a runtime that cannot be made, throws; nothing is sent.
import { GATEWAY_PAUSE_HEADER, isRovaraAiPaused, modelRefusalFor, type ModelRefusal } from "@agentx/contracts";
import { ROUTE_PROVIDER, createModelRuntimeWithFallback } from "@agentx/model-runtime";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

export interface CompanyGatewayRuntime {
  runtime: ModelRuntime;
  /** The model as the runtime names it (a routed model). */
  model: { provider: string; modelId: string };
  /** The first fixed refusal the gateway gave on this runtime's requests, or undefined (none yet). */
  refusal(): ModelRefusal | undefined;
}

export async function createCompanyGatewayRuntime(input: {
  /** `<gateway origin>/v1/answers`: the Anthropic client adds `/v1/messages`. */
  baseUrl: string;
  /** The one Claude model the token names. */
  model: string;
  token: () => Promise<string>;
  fetch?: typeof fetch;
}): Promise<CompanyGatewayRuntime> {
  let refusal: ModelRefusal | undefined;
  const send = input.fetch ?? fetch;
  const observed: typeof fetch = async (target, init) => {
    // Pi's Anthropic client calls `<base>/v1/messages?beta=true`; the gateway's answers route takes the path with no query (an unknown query is no route), so the one query the client adds is dropped.
    const url = new URL(target instanceof Request ? target.url : target.toString());
    if (url.search === "?beta=true") url.search = "";
    const response = await send(url.toString(), init);
    if (!response.ok && refusal === undefined) {
      // The gateway's pause (no connected account, no room): its fixed header on a 403 or 422. Anything else that failed is "unavailable".
      refusal = isRovaraAiPaused(response.status, (await response.clone().text().catch(() => "")).slice(0, 65_536)) ? "installPaused" : (response.status === 403 || response.status === 422) && response.headers.get(GATEWAY_PAUSE_HEADER) !== null
        ? modelRefusalFor(response.headers.get(GATEWAY_PAUSE_HEADER) ?? undefined)
        : "unavailable";
    }
    return response;
  };
  const resolved = await createModelRuntimeWithFallback({ provider: "anthropic", modelId: input.model }, "orchestrator", {
    fetch: observed, onUsage: () => undefined,
    proxy: { baseUrl: input.baseUrl, apiKey: input.token, route: { alias: input.model, api: "anthropic-messages", catalog: input.model } },
  });
  return { runtime: resolved.runtime, model: { provider: resolved.model.provider ?? ROUTE_PROVIDER, modelId: resolved.model.modelId }, refusal: () => refusal };
}
