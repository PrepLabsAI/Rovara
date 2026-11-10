// Port lane P5 (item K2): the three providers Code has always known, as `model-provider` rows. They are data only: the same addresses, the same sign-in and the same
// request format the local model proxy used when they were fixed in its code, so nothing changes for a laptop that uses them. A `model-provider` plug-in of the same
// name replaces one (to add a price table, or to point it at a gateway).
import type { AdapterRegistry, ModelFormatCapabilities, ModelProviderAdapter } from "@agentx/contracts";
import { ModelProviderError, assertModelProvider } from "@agentx/contracts";

/** What the provider's own API honours, by format (research: MODEL-PROVIDER-FORMATS-RESEARCH.md). */
export const NATIVE_MESSAGES_CAPABILITIES: ModelFormatCapabilities = { forcedToolChoice: true, parallelToolCalls: true, reasoning: "thinking", reasoningReturned: true, promptCaching: true, streamUsage: true };
export const NATIVE_RESPONSES_CAPABILITIES: ModelFormatCapabilities = { forcedToolChoice: true, parallelToolCalls: true, reasoning: "effort", reasoningReturned: true, promptCaching: true, streamUsage: true };
export const NATIVE_CHAT_CAPABILITIES: ModelFormatCapabilities = { forcedToolChoice: true, parallelToolCalls: true, reasoning: "effort", reasoningReturned: false, promptCaching: true, streamUsage: true };

/** The built-in provider ids, in the order a provider is picked when the owner names none (model-choice.ts). */
export const BUILTIN_MODEL_PROVIDER_IDS = ["anthropic", "openai", "openrouter"] as const;

export const ANTHROPIC_PROVIDER: ModelProviderAdapter = {
  kind: "anthropic",
  name: "Anthropic",
  address: "https://api.anthropic.com",
  signIn: { kind: "named-header", header: "x-api-key" },
  formats: [{ format: "anthropic-messages", capabilities: NATIVE_MESSAGES_CAPABILITIES }],
};

export const OPENAI_PROVIDER: ModelProviderAdapter = {
  kind: "openai",
  name: "OpenAI",
  address: "https://api.openai.com",
  signIn: { kind: "bearer-key" },
  // Responses first (the format the worker speaks to it); chat completions stays served, as it was.
  formats: [{ format: "openai-responses", capabilities: NATIVE_RESPONSES_CAPABILITIES }, { format: "openai-completions", capabilities: NATIVE_CHAT_CAPABILITIES }],
};

/** OpenRouter speaks the chat shape only. */
export const OPENROUTER_PROVIDER: ModelProviderAdapter = {
  kind: "openrouter",
  name: "OpenRouter",
  address: "https://openrouter.ai/api",
  signIn: { kind: "bearer-key" },
  formats: [{ format: "openai-completions", capabilities: NATIVE_CHAT_CAPABILITIES }],
};

export const BUILTIN_MODEL_PROVIDERS: readonly ModelProviderAdapter[] = [ANTHROPIC_PROVIDER, OPENAI_PROVIDER, OPENROUTER_PROVIDER].map(assertModelProvider);

/** Registers the built-ins as defaults: a configured provider of the same name replaces one without a conflict. */
export function registerBuiltinModelProviders(registry: AdapterRegistry): void {
  for (const provider of BUILTIN_MODEL_PROVIDERS) registry.register("model-provider", provider.kind, provider, { isDefault: true });
}

/**
 * Review L4: the ids of the built-in providers belong to them. A plug-in of the same name may change the name, default model and prices (to price Anthropic's models, say), but not where the
 * provider is, how it signs in or what formats it speaks: otherwise `anthropic` could send ANTHROPIC_API_KEY to another address. `amazon-bedrock` may only be an AWS sign-in to a Bedrock runtime address.
 * Throws a `ModelProviderError`; the caller names it at start-up.
 */
export function assertBuiltinIdsKept(provider: ModelProviderAdapter): void {
  const builtin = BUILTIN_MODEL_PROVIDERS.find((row) => row.kind === provider.kind);
  if (builtin !== undefined) {
    const same = (value: unknown, other: unknown): boolean => JSON.stringify(value) === JSON.stringify(other);
    if (provider.address !== builtin.address || !same(provider.signIn, builtin.signIn) || !same(provider.formats, builtin.formats)) {
      throw new ModelProviderError(provider.kind, "a built-in provider's id cannot point at another address or sign in another way; use another provider id");
    }
  }
  if (provider.kind === "amazon-bedrock") {
    // A strict host: bedrock-runtime (or its fips name) in the signing region, nothing in between (`bedrock-runtime.s3.amazonaws.com` is not Bedrock).
    const region = provider.signIn.kind === "aws-sigv4" ? provider.signIn.region.replaceAll(/[^a-z0-9-]/gu, "") : "";
    const strict = new RegExp(`^bedrock-runtime(-fips)?\\.${region}\\.amazonaws\\.com(\\.cn)?$`, "u");
    if (provider.signIn.kind !== "aws-sigv4" || !strict.test(new URL(provider.address).hostname)) {
      throw new ModelProviderError(provider.kind, "the id amazon-bedrock is for AWS sign-in to a Bedrock runtime address in the signing region; use another provider id");
    }
  }
}
