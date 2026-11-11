// The per-step model rule on a laptop: the install's answers to the core's seams (`core/model-selection/service.ts`) from what `rovara up` has: the model providers (the `model-provider` plug-ins), the key store
// and the owner's chosen model. The core knows no provider; this is the one place that does.
import { providerFormat, type ModelIdentifier, type ModelKeyStore } from "@agentx/contracts";
import type { ModelSelectionSeams } from "../../core/model-selection/service.js";
import { readyProviders } from "../model-proxy/credentials.js";
import { localRoute } from "../model-proxy/providers.js";
import type { ModelProviderBook } from "../model-proxy/types.js";
import type { LocalModelChoice } from "../model-choice.js";
import { servableModels } from "./servable-models.js";

export interface LocalModelSelectionSeamsOptions {
  companyId: string;
  providers: ModelProviderBook;
  keys: ModelKeyStore;
  /** The install's one chosen model (the owner's `model` setting, else the first provider with a key). */
  chosen(): Promise<LocalModelChoice | undefined>;
  /** For tests: the models a provider could serve (default: the installed catalog). */
  catalog?: ((provider: string) => readonly string[]) | undefined;
}

export function createLocalModelSelectionSeams(options: LocalModelSelectionSeamsOptions): ModelSelectionSeams {
  const installModel = async (): Promise<ModelIdentifier | undefined> => {
    const choice = await options.chosen();
    return choice === undefined ? undefined : { provider: choice.provider, modelId: choice.model };
  };
  return {
    servable: () => servableModels({ companyId: options.companyId, providers: options.providers, keys: options.keys, installModel, catalog: options.catalog }),
    async canServe(model) {
      const row = options.providers.get(model.provider);
      if (row === undefined || providerFormat(row) === undefined) return false;
      // The install's own model is one it can call by definition: it was chosen because its provider has a sign-in (or the caller fixed it).
      const own = await installModel();
      if (own !== undefined && own.provider === model.provider && own.modelId === model.modelId) return true;
      return (await readyProviders(options.providers, options.keys, options.companyId, [model.provider])).includes(model.provider);
    },
    installModel,
    async route(model) {
      const row = options.providers.get(model.provider);
      if (row === undefined) return undefined;
      // The install's own model keeps the request format the owner named for it; any other model goes in its provider's first format.
      const own = await options.chosen();
      const api = own !== undefined && own.provider === model.provider && own.model === model.modelId && own.api !== undefined ? own.api : undefined;
      const format = providerFormat(row, api)?.format;
      return format === undefined ? undefined : localRoute(model.provider, model.modelId, format).workerRoute;
    },
  };
}
