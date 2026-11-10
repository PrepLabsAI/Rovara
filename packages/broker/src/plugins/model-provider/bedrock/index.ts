// Port lane P5 (item K2): Amazon Bedrock as a normal model provider. Nothing here is hard-wired to the machine's role: Bedrock is a `model-provider` plug-in whose sign-in is
// AWS Signature Version 4, with the credential from the AWS role the broker runs as (or from the key file). Claude goes through the messages format on bedrock-runtime's `/anthropic`
// path; open models go through chat completions on `/openai/v1`. Both paths and the capability rows come from the research (MODEL-PROVIDER-FORMATS-RESEARCH.md, 2026-11-09) and are not yet
// tried against a live account: they are plain data a deployment can correct in a module.
import { SecretValue, type ModelFormatCapabilities, type ModelProviderAdapter, type ModelProviderPrices } from "@agentx/contracts";

export const BEDROCK_PROVIDER_ID = "amazon-bedrock";

/** Bedrock's Claude: `tool_choice` is auto or none only (research), so a forced tool choice is refused here rather than ignored. */
export const BEDROCK_MESSAGES_CAPABILITIES: ModelFormatCapabilities = { forcedToolChoice: false, parallelToolCalls: true, reasoning: "thinking", reasoningReturned: true, promptCaching: true, streamUsage: true };
/** The open models on the chat route vary by model; nothing beyond streaming usage is claimed. */
export const BEDROCK_CHAT_CAPABILITIES: ModelFormatCapabilities = { forcedToolChoice: false, parallelToolCalls: false, reasoning: "none", reasoningReturned: false, promptCaching: false, streamUsage: true };

export interface BedrockProviderOptions {
  /** The AWS region (`us-west-2`). It names the address and the signature scope. */
  region: string;
  /** The Claude model used when the owner names none (a Bedrock model id or inference profile id). Absent: only the owner's `model` setting chooses it. */
  defaultModel?: string;
  prices?: ModelProviderPrices;
  /**
   * The AWS credential as `{accessKeyId, secretAccessKey, sessionToken?}`, resolved at each call (a role's temporary credentials expire). Absent: the default AWS provider chain
   * (environment, shared config, SSO, container or instance role), loaded when first needed.
   */
  credentials?: (() => Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken?: string | undefined }>) | undefined;
}

async function defaultChainCredentials(): Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken?: string | undefined }> {
  const { defaultProvider } = await import("@aws-sdk/credential-provider-node");
  return defaultProvider()();
}

export function bedrockModelProvider(options: BedrockProviderOptions): ModelProviderAdapter {
  const resolve = options.credentials ?? defaultChainCredentials;
  return {
    kind: BEDROCK_PROVIDER_ID,
    name: "Amazon Bedrock",
    address: `https://bedrock-runtime.${options.region}.amazonaws.com`,
    signIn: { kind: "aws-sigv4", region: options.region, service: "bedrock" },
    formats: [
      { format: "anthropic-messages", pathOverride: "/anthropic/v1/messages", capabilities: BEDROCK_MESSAGES_CAPABILITIES },
      { format: "openai-completions", pathOverride: "/openai/v1/chat/completions", capabilities: BEDROCK_CHAT_CAPABILITIES },
    ],
    ...(options.defaultModel === undefined ? {} : { defaultModel: options.defaultModel }),
    ...(options.prices === undefined ? {} : { prices: options.prices }),
    async credential() {
      try {
        const { accessKeyId, secretAccessKey, sessionToken } = await resolve();
        return new SecretValue(JSON.stringify({ accessKeyId, secretAccessKey, ...(sessionToken === undefined ? {} : { sessionToken }) }));
      } catch {
        // No role to use: the key file's entry for this provider is tried next, and the words of an AWS error are never passed on.
        return undefined;
      }
    },
  };
}
