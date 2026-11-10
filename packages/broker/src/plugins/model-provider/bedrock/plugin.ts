// Port lane P5 (item K2): the Bedrock `model-provider` module. Config entry:
//   { "point": "model-provider", "name": "amazon-bedrock", "module": "./bedrock.mjs", "settings": { "region": "us-west-2", "defaultModel": "<a Bedrock Claude model id>" } }
// with ./bedrock.mjs holding: `import { bedrockModelProviderPlugin } from ...; export const plugin = bedrockModelProviderPlugin();`
import { z } from "zod";
import { ModelProviderPricesSchema, type PluginModule } from "@agentx/contracts";
import { readPluginSettings } from "../../module-support.js";
import { BEDROCK_PROVIDER_ID, bedrockModelProvider, type BedrockProviderOptions } from "./index.js";

const AWS_REGION = /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/u;
const SettingsSchema = z.object({
  region: z.string().regex(AWS_REGION, "an AWS region such as us-west-2"),
  defaultModel: z.string().min(1).max(200).optional(),
  prices: ModelProviderPricesSchema.optional(),
}).strict();

export interface BedrockPluginOptions {
  /** Replaces the default AWS provider chain (tests, or a deployment that resolves its role another way). */
  credentials?: BedrockProviderOptions["credentials"];
}

export function bedrockModelProviderPlugin(options: BedrockPluginOptions = {}): PluginModule<"model-provider"> {
  return {
    point: "model-provider",
    name: BEDROCK_PROVIDER_ID,
    create(context) {
      const settings = readPluginSettings(SettingsSchema, context.settings, `model-provider/${BEDROCK_PROVIDER_ID}`);
      return bedrockModelProvider({
        region: settings.region,
        ...(settings.defaultModel === undefined ? {} : { defaultModel: settings.defaultModel }),
        ...(settings.prices === undefined ? {} : { prices: settings.prices }),
        ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
      });
    },
  };
}
