// A task's model access (ruling R29): the proxy's address and a key minted for this task alone, from the
// control plane through the operation's callback capability. The worker holds no provider secret; the key
// stays in memory until shortly before it expires, is asked for once at a time, and is never logged.
import { type RunPrice, agentXError } from "@agentx/contracts";
import { parseModelAccess, refuseModelAccess } from "./cx-c/model-access-response.js";
import { acceptedRunPrice } from "./cx-c/run-price-ceiling.js";

/** Asked for again this long before the key expires, so no request carries one about to lapse. */
export const MODEL_ACCESS_MARGIN_MS = 60_000;

export interface ModelAccess {
  runPrice?: RunPrice;
  baseUrl: string;
  apiKey: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export interface ModelAccessSourceInput {
  controlPlaneUrl: string;
  /** The operation's callback capability, which grants this one request. */
  capability: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** DR5: the key slot of one design reviewer. The broker mints a key for that slot alone; without it the request is the operation's own key, as always. */
  slot?: string;
  /** Boot proxy used only when this answer has no usable address. */
  fallbackBaseUrl?: string;
  requiredPriceModel?: string;
  allowLocalHttp?: boolean;
}

/**
 * What the runtime needs of the proxy, without asking for a key: the proxy's origin (the worker's own configuration names it) and
 * the key as often as it is asked for. Nothing is minted until a request actually needs the proxy, so a ChatGPT-plan task whose
 * requests go direct to OpenAI never mints one unless its plan falls back to the proxy's models.
 */
export function lazyModelProxy(input: { baseUrl: string; source: () => Promise<ModelAccess> }): { baseUrl: string; apiKey: () => Promise<string>; runPrice: () => Promise<RunPrice | undefined> } {
  let origin: URL | undefined;
  try { origin = new URL(input.baseUrl); } catch { origin = undefined; }
  if (origin === undefined || !/^https?:$/u.test(origin.protocol)) throw agentXError("CONFIG_INVALID", "the worker's model proxy address is not an http or https URL");
  return { baseUrl: input.baseUrl, runPrice: async () => (await input.source()).runPrice, async apiKey(this: { baseUrl: string }) {
    const answer = await input.source();
    // The runtime binds this method to a fresh request-local proxy object. URL and key are taken from ONE answer,
    // before returning either to the transport; simultaneous requests cannot overwrite each other's address.
    this.baseUrl = answer.baseUrl;
    return answer.apiKey;
  } };
}

/** The current model access, fetched when there is none or it is about to expire; concurrent callers share one fetch. */
export function modelAccessSource(input: ModelAccessSourceInput): () => Promise<ModelAccess> {
  const transport = input.fetch ?? fetch;
  const now = input.now ?? Date.now;
  const url = `${input.controlPlaneUrl.replace(/\/$/u, "")}/v1/internal/model-access${input.slot === undefined ? "" : `?slot=${encodeURIComponent(input.slot)}`}`;
  let current: ModelAccess | undefined;
  let ceiling: RunPrice | undefined;
  let pending: Promise<ModelAccess> | undefined;
  return async () => {
    if (current !== undefined && Math.min(current.expiresAt - MODEL_ACCESS_MARGIN_MS, current.runPrice?.expiresAt ?? Infinity) > now()) return current;
    pending ??= (async () => {
      try {
        const response = await transport(url, { method: "GET", headers: { "x-agentx-callback-capability": input.capability } });
        if (!response.ok) await refuseModelAccess(response, input.requiredPriceModel);
        const answer = parseModelAccess(await response.json().catch(() => undefined), input.fallbackBaseUrl, input.allowLocalHttp);
        ceiling = acceptedRunPrice(answer.runPrice, input.requiredPriceModel, ceiling, now);
        current = answer;
        return current;
      } finally {
        pending = undefined;
      }
    })();
    return pending;
  };
}
