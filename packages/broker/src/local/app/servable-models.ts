// The models this install could call for a step: the models of the providers that have a sign-in on this computer, from the installed catalog, limited to the strong, middle and small tiers of a known maker
// (the hundreds of others an aggregator lists are noise for choosing a model), and always the install's own model. Shared by the second review's picker and the per-step model rule, so both offer the same models.
import { modelCompany, type ModelIdentifier, type ModelKeyStore } from "@agentx/contracts";
import { catalogModelIds } from "@agentx/model-runtime/catalog";
import { criticCapabilityTier, isBatchVariant } from "../../core/second-review/index.js";
import { readyProviders } from "../model-proxy/credentials.js";
import type { ModelProviderBook } from "../model-proxy/types.js";

/** Models worth listing from a provider's catalog: those of a known AI company in the strong, middle or small tier, never a batch variant. */
export const worthListing = (model: ModelIdentifier): boolean => modelCompany(model) !== "other" && criticCapabilityTier(model) < 3 && !isBatchVariant(model);

export interface ServableOptions {
  companyId: string;
  providers: ModelProviderBook;
  keys: ModelKeyStore;
  /** The install's own model: always listed, whatever the catalog holds. */
  installModel(): Promise<ModelIdentifier | undefined>;
  /** For tests: the models a provider could serve (default: the installed catalog). */
  catalog?: ((provider: string) => readonly string[]) | undefined;
}

export async function servableModels(options: ServableOptions): Promise<ModelIdentifier[]> {
  const catalog = options.catalog ?? catalogModelIds;
  const found = new Map<string, ModelIdentifier>();
  for (const provider of await readyProviders(options.providers, options.keys, options.companyId)) {
    for (const modelId of catalog(provider)) {
      const model = { provider, modelId };
      if (worthListing(model)) found.set(`${provider}\0${modelId}`, model);
    }
  }
  const own = await options.installModel();
  if (own !== undefined) found.set(`${own.provider}\0${own.modelId}`, own);
  return [...found.values()];
}
