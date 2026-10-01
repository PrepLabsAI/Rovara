// Pi's scripted provider, registered on a private ModelRuntime, so a test or the offline evaluation
// drives the real agent loop without calling a paid model.
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxProvider, type FauxProviderHandle } from "@earendil-works/pi-ai";

export const FAUX_MODEL = { provider: "agentx-faux", modelId: "scripted", thinkingLevel: "off" } as const;

export async function fauxModelRuntime(model: { reasoning?: boolean } = {}): Promise<{ modelRuntime: ModelRuntime; faux: FauxProviderHandle }> {
  const faux = fauxProvider({ provider: FAUX_MODEL.provider, models: [{ id: FAUX_MODEL.modelId, ...model }] });
  const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  return { modelRuntime, faux };
}
