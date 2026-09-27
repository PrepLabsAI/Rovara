import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { agentXError } from "@agentx/contracts";

export type ModelRole = "worker" | "orchestrator" | "classifier";
export const DEFAULT_BEDROCK_MODELS = {
  worker: "amazon.nova-pro-v1:0",
  orchestrator: "us.anthropic.claude-sonnet-4-6",
  classifier: "amazon.nova-lite-v1:0",
} as const;

export class MissingOpenRouterSecret extends Error {
  constructor() { super("OpenRouter secret is not configured or has no value"); this.name = "MissingOpenRouterSecret"; }
}

export function defaultBedrockModel(role: ModelRole, environment: NodeJS.ProcessEnv = {}) {
  const prefix = role === "worker" ? "AGENTX_MODEL" : role === "classifier" ? "AGENTX_GATE_CLASSIFIER" : "AGENTX_ORCHESTRATOR";
  const idVariable = role === "worker" ? "AGENTX_MODEL_ID" : `${prefix}_MODEL`;
  return { provider: "amazon-bedrock", modelId: environment[`${prefix}_PROVIDER`] === "amazon-bedrock" && environment[idVariable]
    ? environment[idVariable] : DEFAULT_BEDROCK_MODELS[role] };
}

export async function readOpenRouterKey(arn: string, readSecret?: (arn: string) => Promise<string | undefined>): Promise<string> {
  if (!arn) throw new MissingOpenRouterSecret();
  if (!/^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]+$/.test(arn)) {
    throw agentXError("CONFIG_INVALID", "configure an OpenRouter secret ARN before selecting OpenRouter models");
  }
  try {
    const value = await (readSecret ?? (async (id) => {
      const client = new SecretsManagerClient({ region: id.split(":")[3]! });
      try { return (await client.send(new GetSecretValueCommand({ SecretId: id }))).SecretString; }
      finally { client.destroy(); }
    }))(arn);
    const key = value?.trim();
    if (!key) throw new MissingOpenRouterSecret();
    if (/[\r\n]/.test(key) || key.length < 10) throw new Error("invalid key");
    return key;
  } catch (error) {
    if (error instanceof MissingOpenRouterSecret || (error instanceof Error && error.name === "ResourceNotFoundException")) throw new MissingOpenRouterSecret();
    throw agentXError("RUNTIME_UNAVAILABLE", "OpenRouter credential could not be loaded; check the secret value and read permissions");
  }
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
export function openRouterModel(modelId: string) {
  if (modelId.startsWith("openrouter/")) throw agentXError("CONFIG_INVALID", "automatic OpenRouter routers are not supported; approve a specific model ID");
  const model = openrouterProvider().getModels().find((entry) => entry.id === modelId);
  if (!model || model.contextWindow <= 0 || model.maxTokens <= 0) {
    throw agentXError("CONFIG_INVALID", "OpenRouter model is not in the installed Pi catalog; choose a supported model or update AgentX");
  }
  return model;
}
