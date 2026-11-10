// Port lane P5 (item K2): Amazon Bedrock as a normal model provider. Nothing here is hard-wired to the machine's role: Bedrock is a `model-provider` plug-in whose sign-in is
// AWS Signature Version 4, with the credential from an identity the owner NAMED (a profile, or a role to assume), or from the default chain only when the owner opted in (review M1).
// Claude goes through the messages format on bedrock-runtime's `/anthropic` path; open models go through chat completions on `/openai/v1`. Both paths and the capability rows come from the
// research (MODEL-PROVIDER-FORMATS-RESEARCH.md, 2026-11-09) and are not yet tried against a live account (docs/local.md, open checks): they are plain data a deployment can correct in a module.
import { SecretValue, type ModelFormatCapabilities, type ModelProviderAdapter, type ModelProviderPrices } from "@agentx/contracts";
import { createAwsCredentialSource, type AwsCredentialLoaders, type AwsIdentity } from "./credentials.js";

export const BEDROCK_PROVIDER_ID = "amazon-bedrock";

/** Bedrock's Claude: `tool_choice` is auto or none only (research), so a forced tool choice is refused here rather than ignored. */
export const BEDROCK_MESSAGES_CAPABILITIES: ModelFormatCapabilities = { forcedToolChoice: false, parallelToolCalls: true, reasoning: "thinking", reasoningReturned: true, promptCaching: true, streamUsage: true };
/** The open models on the chat route vary by model; nothing beyond streaming usage is claimed. */
export const BEDROCK_CHAT_CAPABILITIES: ModelFormatCapabilities = { forcedToolChoice: false, parallelToolCalls: false, reasoning: "none", reasoningReturned: false, promptCaching: false, streamUsage: true };

export interface BedrockProviderOptions {
  /** The AWS region (`us-west-2`). It names the address and the signature scope. */
  region: string;
  /** Whose credential signs: a named profile, a role to assume, or (opted in) the default chain. Required unless `credentials` is given. */
  identity?: AwsIdentity;
  /** The Claude model used when the owner names none (a Bedrock model id or inference profile id). Absent: only the owner's `model` setting chooses it. */
  defaultModel?: string;
  prices?: ModelProviderPrices;
  /** Replaces the AWS SDK's credential providers (tests, or a deployment that resolves its role another way). It is called at each call; make it cache. */
  credentials?: (() => Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken?: string | undefined }>) | undefined;
  loaders?: AwsCredentialLoaders;
  now?: () => number;
}

export function bedrockModelProvider(options: BedrockProviderOptions): ModelProviderAdapter {
  if (options.credentials === undefined && options.identity === undefined) throw new Error("Bedrock needs an AWS identity: a profile, a role, or the opt-in to the default chain");
  let problem: string | undefined;
  const source = options.credentials === undefined && options.identity !== undefined
    ? createAwsCredentialSource(options.identity, options.region, { ...(options.loaders === undefined ? {} : { loaders: options.loaders }), ...(options.now === undefined ? {} : { now: options.now }) })
    : undefined;
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
    credentialProblem: () => source?.problem() ?? problem,
    async credential() {
      try {
        const { accessKeyId, secretAccessKey, sessionToken } = await (source !== undefined ? source.resolve() : options.credentials!());
        problem = undefined;
        return new SecretValue(JSON.stringify({ accessKeyId, secretAccessKey, ...(sessionToken === undefined ? {} : { sessionToken }) }));
      } catch {
        // No identity to use. The key file's entry is tried first, so reaching here means it had none; the SDK's own words (a profile, an ARN) are never passed on.
        problem = source === undefined ? "no AWS credentials were found" : undefined;
        return undefined;
      }
    },
  };
}
