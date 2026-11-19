// Port lane P5 (item K2): the Bedrock `model-provider` module. Config entry (one identity is required, review M1):
//   { "point": "model-provider", "name": "amazon-bedrock", "module": "./bedrock.mjs",
//     "settings": { "region": "us-west-2", "profile": "rovara-bedrock", "defaultModel": "<a Bedrock Claude model id>" } }
// `profile` (a named AWS profile; give it only bedrock:InvokeModel*), or `roleArn` (assumed for a 15-minute session), or `"allowAmbientAwsCredentials": true` (whatever identity this shell has).
// with ./bedrock.mjs holding: `import { bedrockModelProviderPlugin } from ...; export const plugin = bedrockModelProviderPlugin();`
import { z } from "zod";
import { ModelProviderPricesSchema, type PluginModule } from "@agentx/contracts";
import { readPluginSettings } from "../../module-support.js";
import type { AwsIdentity } from "./credentials.js";
import { BEDROCK_PROVIDER_ID, bedrockModelProvider, type BedrockProviderOptions } from "./index.js";

const AWS_REGION = /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/u;
export const BedrockSettingsSchema = z.object({
  region: z.string().regex(AWS_REGION, "an AWS region such as us-west-2"),
  profile: z.string().regex(/^[A-Za-z0-9_.@-]{1,128}$/u, "an AWS profile name").optional(),
  roleArn: z.string().regex(/^arn:aws[a-z-]*:iam::\d{12}:role\/[A-Za-z0-9+=,.@_/-]{1,512}$/u, "an IAM role ARN").optional(),
  allowAmbientAwsCredentials: z.literal(true).optional(),
  defaultModel: z.string().min(1).max(200).optional(),
  prices: ModelProviderPricesSchema.optional(),
}).strict().refine(
  (settings) => [settings.profile, settings.roleArn, settings.allowAmbientAwsCredentials].filter((value) => value !== undefined).length === 1,
  "name exactly one AWS identity: profile, roleArn, or allowAmbientAwsCredentials: true (the default chain: whatever identity this shell has)",
);

export function bedrockIdentityOf(settings: z.infer<typeof BedrockSettingsSchema>): AwsIdentity {
  if (settings.profile !== undefined) return { kind: "profile", profile: settings.profile };
  if (settings.roleArn !== undefined) return { kind: "role", roleArn: settings.roleArn };
  return { kind: "ambient" };
}

/** What `rovara up --check` says about a Bedrock config entry's settings, without loading the module or touching AWS. */
export function describeBedrockSettings(settings: unknown): { ok: true; identity: string; priced: boolean } | { ok: false; problem: string } {
  const parsed = BedrockSettingsSchema.safeParse(settings);
  if (!parsed.success) return { ok: false, problem: parsed.error.issues.map((issue) => `${issue.path.join(".") || "settings"}: ${issue.message}`).join("; ") };
  const identity = bedrockIdentityOf(parsed.data);
  const text = identity.kind === "profile" ? `the AWS profile "${identity.profile}"` : identity.kind === "role" ? `the AWS role ${identity.roleArn} (assumed for 15 minutes)` : "the default AWS credential chain (whatever identity this shell has; you opted in)";
  return { ok: true, identity: text, priced: parsed.data.prices !== undefined && Object.keys(parsed.data.prices.models).length > 0 };
}

export interface BedrockPluginOptions {
  /** Replaces the AWS SDK's credential providers (tests, or a deployment that resolves its role another way). The settings must still name an identity. */
  credentials?: BedrockProviderOptions["credentials"];
  loaders?: BedrockProviderOptions["loaders"];
}

export function bedrockModelProviderPlugin(options: BedrockPluginOptions = {}): PluginModule<"model-provider"> {
  return {
    point: "model-provider",
    name: BEDROCK_PROVIDER_ID,
    create(context) {
      const settings = readPluginSettings(BedrockSettingsSchema, context.settings, `model-provider/${BEDROCK_PROVIDER_ID}`);
      return bedrockModelProvider({
        region: settings.region,
        identity: bedrockIdentityOf(settings),
        ...(settings.defaultModel === undefined ? {} : { defaultModel: settings.defaultModel }),
        ...(settings.prices === undefined ? {} : { prices: settings.prices }),
        ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
        ...(options.loaders === undefined ? {} : { loaders: options.loaders }),
      });
    },
  };
}
