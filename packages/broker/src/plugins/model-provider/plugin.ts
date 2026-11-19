// Port lane P5 (item K2): turning a provider description into a `model-provider` plug-in module. A module is a few lines:
//
//   import { modelProviderPlugin } from "@agentx/broker/plugins/model-provider";   // or the package that re-exports it
//   export const plugin = modelProviderPlugin({
//     kind: "company-gateway", name: "Company gateway", address: "https://models.example.test/v1",
//     signIn: { kind: "bearer-key" },
//     formats: [{ format: "openai-completions", pathOverride: "/chat/completions", capabilities: { ... } }],
//   });
//
// and the config entry names it: { "point": "model-provider", "name": "company-gateway", "module": "./gateway.mjs", "settings": { ... } }. The module fixes what the provider IS (its sign-in
// kind and formats); the settings may change only what an owner reasonably varies: the address, the name, the default model and the price table. The key is never in the config: it is the
// provider's entry in the key file or its environment variable (or the provider's own `credential()`).
import { z } from "zod";
import { ModelProviderPricesSchema, assertModelProvider, type ModelProviderAdapter, type PluginModule } from "@agentx/contracts";
import { PluginRegistryError } from "@agentx/contracts";
import { readPluginSettings } from "../module-support.js";
import { BUILTIN_MODEL_PROVIDER_IDS } from "./builtin.js";

const SettingsSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  address: z.string().min(1).max(500).optional(),
  defaultModel: z.string().min(1).max(200).optional(),
  prices: ModelProviderPricesSchema.optional(),
}).strict();

export function modelProviderPlugin(provider: ModelProviderAdapter): PluginModule<"model-provider"> {
  assertModelProvider(provider);
  return {
    point: "model-provider",
    name: provider.kind,
    create(context) {
      const settings = readPluginSettings(SettingsSchema, context.settings, `model-provider/${provider.kind}`);
      if (settings.address !== undefined && (BUILTIN_MODEL_PROVIDER_IDS as readonly string[]).includes(provider.kind)) {
        throw new PluginRegistryError("bad_config", `the address of the built-in provider ${provider.kind} cannot be changed; use another provider id`);
      }
      // Rebuilt with the owner's settings, then checked as a whole: an address that is not https, or a price in a bad shape, stops the start.
      return assertModelProvider({
        ...provider,
        ...(settings.name === undefined ? {} : { name: settings.name }),
        ...(settings.address === undefined ? {} : { address: settings.address }),
        ...(settings.defaultModel === undefined ? {} : { defaultModel: settings.defaultModel }),
        ...(settings.prices === undefined ? {} : { prices: settings.prices }),
      });
    },
  };
}
