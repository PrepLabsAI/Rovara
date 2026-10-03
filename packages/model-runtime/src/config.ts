import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { KEYED_MODEL_PROVIDERS, SECRET_ARN_PATTERN, agentXError, type KeyedModelProvider } from "@agentx/contracts";
import { catalogModel } from "./catalog.js";

export type ModelRole = "worker" | "orchestrator" | "classifier";
export const DEFAULT_BEDROCK_MODELS = {
  worker: "us.anthropic.claude-sonnet-4-6",
  orchestrator: "us.anthropic.claude-sonnet-4-6",
  classifier: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
} as const;

/** Init's suggested models when one direct provider runs every role (spec 054, D3). OpenRouter has none. */
export const DEFAULT_DIRECT_MODELS = {
  anthropic: { worker: "claude-sonnet-4-6", orchestrator: "claude-sonnet-4-6", classifier: "claude-haiku-4-5" },
  openai: { worker: "gpt-5.4", orchestrator: "gpt-5.4", classifier: "gpt-5.4-mini" },
} as const satisfies Record<Exclude<KeyedModelProvider, "openrouter">, Record<ModelRole, string>>;

/** A keyed provider's secret is not configured, does not exist, or is empty: the one case that falls back to Bedrock. */
export class MissingProviderSecret extends Error {
  constructor(readonly provider: KeyedModelProvider) {
    super(`${KEYED_MODEL_PROVIDERS[provider].label} secret is not configured or has no value`);
    this.name = "MissingProviderSecret";
  }
}

export class MissingOpenRouterSecret extends MissingProviderSecret {
  constructor() { super("openrouter"); this.name = "MissingOpenRouterSecret"; }
}

export function defaultBedrockModel(role: ModelRole, environment: NodeJS.ProcessEnv = {}) {
  const prefix = role === "worker" ? "AGENTX_MODEL" : role === "classifier" ? "AGENTX_GATE_CLASSIFIER" : "AGENTX_ORCHESTRATOR";
  const idVariable = role === "worker" ? "AGENTX_MODEL_ID" : `${prefix}_MODEL`;
  return { provider: "amazon-bedrock", modelId: environment[`${prefix}_PROVIDER`] === "amazon-bedrock" && environment[idVariable]
    ? environment[idVariable] : DEFAULT_BEDROCK_MODELS[role] };
}

/** The shortest provider key accepted; init refuses a shorter one before storing it. */
export const PROVIDER_KEY_MIN_LENGTH = 10;
export const OPENROUTER_KEY_MIN_LENGTH = PROVIDER_KEY_MIN_LENGTH;

/** Why a key cannot be the given provider's API key, judged by its prefix, or undefined when it can. */
export function providerKeyProblem(provider: KeyedModelProvider, key: string): string | undefined {
  const { label } = KEYED_MODEL_PROVIDERS[provider];
  if (provider === "anthropic") {
    // Pi treats an sk-ant-oat token as a Claude subscription sign-in, which AgentX does not use (FR-005).
    if (key.startsWith("sk-ant-oat")) return "that is a Claude subscription token, not an API key; make an API key";
    if (!key.startsWith("sk-ant-")) return `an ${label} API key starts with sk-ant-`;
  }
  if (provider === "openai") {
    if (key.startsWith("sk-or-")) return "that is an OpenRouter key, not an OpenAI key";
    if (key.startsWith("sk-ant-")) return "that is an Anthropic key, not an OpenAI key";
    if (!key.startsWith("sk-")) return `an ${label} API key starts with sk-`;
  }
  return undefined;
}

export async function readProviderKey(provider: KeyedModelProvider, arn: string, readSecret?: (arn: string) => Promise<string | undefined>): Promise<string> {
  const { label } = KEYED_MODEL_PROVIDERS[provider];
  if (!arn) throw new MissingProviderSecret(provider);
  if (!SECRET_ARN_PATTERN.test(arn)) {
    throw agentXError("CONFIG_INVALID", `configure an ${label} secret ARN before selecting ${label} models`);
  }
  try {
    const value = await (readSecret ?? (async (id) => {
      const client = new SecretsManagerClient({ region: id.split(":")[3]! });
      try { return (await client.send(new GetSecretValueCommand({ SecretId: id }))).SecretString; }
      finally { client.destroy(); }
    }))(arn);
    const key = value?.trim();
    if (!key) throw new MissingProviderSecret(provider);
    if (/[\r\n]/.test(key) || key.length < PROVIDER_KEY_MIN_LENGTH) throw new Error("invalid key");
    if (provider === "anthropic" && key.startsWith("sk-ant-oat")) throw new Error("subscription token");
    return key;
  } catch (error) {
    if (error instanceof MissingProviderSecret || (error instanceof Error && error.name === "ResourceNotFoundException")) throw new MissingProviderSecret(provider);
    throw agentXError("RUNTIME_UNAVAILABLE", `${label} credential could not be loaded; check the secret value and read permissions`);
  }
}

export async function readOpenRouterKey(arn: string, readSecret?: (arn: string) => Promise<string | undefined>): Promise<string> {
  try { return await readProviderKey("openrouter", arn, readSecret); }
  catch (error) { throw error instanceof MissingProviderSecret ? new MissingOpenRouterSecret() : error; }
}

/** Explicit policy: no model escalation, no provider fallback, supported parameters only. */
export function openRouterRouting(environment: NodeJS.ProcessEnv): Record<string, unknown> {
  const only = (environment.AGENTX_OPENROUTER_PROVIDERS ?? "").split(",").filter(Boolean);
  if (only.some((name) => !/^[a-z0-9][a-z0-9_/-]{0,79}$/.test(name))) {
    throw agentXError("CONFIG_INVALID", "OpenRouter providers must be comma-separated provider slugs");
  }
  return { allow_fallbacks: false, require_parameters: true, data_collection: "deny", ...(only.length ? { only, order: only } : {}) };
}

/** Use the pinned catalog's limits/reasoning metadata; never guess limits for an unknown ID. */
export function requireKeyedModel(provider: KeyedModelProvider, modelId: string) {
  if (provider === "openrouter" && modelId.startsWith("openrouter/")) {
    throw agentXError("CONFIG_INVALID", "automatic OpenRouter routers are not supported; approve a specific model ID");
  }
  const model = catalogModel({ provider, modelId });
  if (!model || model.contextWindow <= 0 || model.maxTokens <= 0) {
    throw agentXError("CONFIG_INVALID", `${KEYED_MODEL_PROVIDERS[provider].label} model is not in the installed Pi catalog; choose a supported model or update AgentX`);
  }
  return model;
}

export function openRouterModel(modelId: string) {
  return requireKeyedModel("openrouter", modelId);
}
