/** Every model provider an installation can configure for a role or approve for a project. */
export const MODEL_PROVIDERS = ["amazon-bedrock", "openrouter", "anthropic", "openai"] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

/** A Secrets Manager secret ARN. Keyed providers' secrets are referenced only by ARN, never by value. */
export const SECRET_ARN_PATTERN = /^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]+$/;
/** The longest secret ARN: a secret name is at most 512 characters, plus the partition, region,
 * account and the 7-character suffix. Bounds what each ARN adds to EC2 user data (#223). */
export const SECRET_ARN_MAX_LENGTH = 640;

/**
 * Providers whose API key an administrator stores in Secrets Manager (specs 032 and 054). Each row
 * names everything that carries the secret's ARN, so init, deploy, the stacks, the worker boot and
 * doctor stay in step. The secret's value is the raw key. OpenRouter's names predate the table and
 * stay as they are, because deployed stacks and saved answers use them.
 */
export const KEYED_MODEL_PROVIDERS = {
  openrouter: {
    label: "OpenRouter",
    /** Init's own secret: agentx/<env>/<secretName>. */
    secretName: "openrouter",
    /** The process environment variable holding the ARN. */
    secretArnVariable: "AGENTX_OPENROUTER_SECRET_ARN",
    /** The CloudFormation parameter holding the ARN, in the control-plane, runtime, Slack and eval stacks. */
    stackParameter: "OpenRouterSecretArn",
    /** The CDK id prefix of the stack's condition and read policy. */
    constructPrefix: "OpenRouter",
    /** The key of WORKER_SETTING_PARAMETERS holding the ARN for workers. */
    workerSetting: "openRouterSecretArn",
    /** The CLI flag stem: --<flag>-key-file, --<flag>-key-env, --<flag>-secret-arn. */
    flag: "openrouter",
    /** Where an administrator makes a key. */
    keysUrl: "openrouter.ai/settings/keys",
  },
  anthropic: {
    label: "Anthropic",
    secretName: "anthropic",
    secretArnVariable: "AGENTX_ANTHROPIC_SECRET_ARN",
    stackParameter: "AnthropicSecretArn",
    constructPrefix: "Anthropic",
    workerSetting: "anthropicSecretArn",
    flag: "anthropic",
    keysUrl: "console.anthropic.com/settings/keys",
  },
  openai: {
    label: "OpenAI",
    secretName: "openai",
    secretArnVariable: "AGENTX_OPENAI_SECRET_ARN",
    stackParameter: "OpenAISecretArn",
    constructPrefix: "OpenAI",
    workerSetting: "openaiSecretArn",
    flag: "openai",
    keysUrl: "platform.openai.com/api-keys",
  },
} as const;
export type KeyedModelProvider = keyof typeof KEYED_MODEL_PROVIDERS;
export const KEYED_PROVIDER_IDS = Object.keys(KEYED_MODEL_PROVIDERS) as KeyedModelProvider[];

export function isKeyedModelProvider(provider: string | undefined): provider is KeyedModelProvider {
  return provider !== undefined && Object.hasOwn(KEYED_MODEL_PROVIDERS, provider);
}

/** The secret init creates for a keyed provider's key: agentx/<env>/<name>. */
export function keyedProviderSecretName(env: string, provider: KeyedModelProvider): string {
  return `agentx/${env}/${KEYED_MODEL_PROVIDERS[provider].secretName}`;
}
