import type { InvocationModelRoute } from "@agentx/contracts";
import type { ModelAccessSourceInput } from "../model-access.js";

/** The same boot fallback and signed-price requirements for local and hosted operations. */
export function operationModelAccessOptions(payload: { workflowMode?: string | undefined; modelRoute?: InvocationModelRoute | undefined }, proxyUrl: string | undefined, local: boolean): Pick<ModelAccessSourceInput, "fallbackBaseUrl" | "requiredPriceModel"> {
  const hostedSetup = payload.modelRoute !== undefined && ["SETUP_AGENT", "WIKI_BUILD"].includes(payload.workflowMode ?? "");
  return {
    ...(proxyUrl && (local || !hostedSetup) ? { fallbackBaseUrl: proxyUrl } : {}),
    ...(!local && payload.modelRoute !== undefined && (hostedSetup || payload.modelRoute.alias.includes("/")) ? { requiredPriceModel: payload.modelRoute.alias } : {}),
  };
}
