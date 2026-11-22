// Internal config stack-choice checks, kept in their original pre-update order.
import { agentXError, environmentStackName, KEYED_MODEL_PROVIDERS, eligibleE2EAgentModel, isClaudeAgentModel, isKeyedModelProvider, type ModelProvider } from "@agentx/contracts";
import type { ConfigServices } from "../commands.js";
import type { EnvironmentSettings } from "../../environments/settings.js";
import type { DeployPart } from "../../deploy/parameters.js";
import { requireGatewayOffers } from "../gateway-offered.js";
import { configKey, savedEnvRegistryReadiness, type ConfigKey } from "../keys.js";

/** One stack parameter as the stack reports it now, or the key's default when the stack reports none. */
export async function stackParameterValue(services: ConfigServices, env: string, where: { part: DeployPart; parameter: string }, fallback: string | undefined): Promise<string> {
  return (await services.stacks.describe(environmentStackName(env, where.part)))?.parameters[where.parameter] ?? fallback ?? "unknown";
}

/**
 * models.e2eAgent: `default` is always fine; a model id must be one the table of eligible AI navigation models lists for the environment's worker provider and region. There is no test
 * call here: the driving test on the qualified runner is the gate (Task 4.10C), and the broker shows the choice at setup approval.
 */
function checkE2eAgentChoice(env: string, settings: EnvironmentSettings, value: string): void {
  if (value === "default") return;
  const provider: ModelProvider = settings.models.providers?.worker ?? "amazon-bedrock";
  if (eligibleE2EAgentModel(provider, value, settings.region) !== null) return;
  const label = isKeyedModelProvider(provider) ? KEYED_MODEL_PROVIDERS[provider].label : "Amazon Bedrock";
  throw agentXError("CONFIG_INVALID", `models.e2eAgent must be default or a model Rovara can use with ${label} in ${settings.region}; agentx --env ${env} config set models.e2eAgent default puts the recommendation back; nothing changed`);
}

/**
 * coreEngine.modelGatewayUrl and coreEngine.agentModel work only together (core-host/gateway-model-access.ts): with one set and the other empty the core refuses work in fixed words, as
 * with neither. Each is set on its own, so this says, before the change is shown, what the other one still needs. Names only, never a value.
 */
async function notePairedCoreSetting(services: ConfigServices, env: string, entry: ConfigKey, pairedKey: string, value: string): Promise<void> {
  const paired = configKey(pairedKey);
  if (paired.target.kind !== "stack-parameter") return;
  const pairedValue = await stackParameterValue(services, env, paired.target, paired.defaultValue);
  if ((value === "") === (pairedValue === "")) return;
  services.write(value === ""
    ? `Note: ${paired.key} is still set; with ${entry.key} empty the core engine refuses work. To turn the gateway off fully, also run agentx --env ${env} config set ${paired.key} none`
    : `Note: ${paired.key} is not set yet; the core engine refuses work until both ${entry.key} and ${paired.key} are set. Next: agentx --env ${env} config set ${paired.key} <value>`);
}

export async function validateStackChoice(services: ConfigServices, env: string, entry: ConfigKey, settings: EnvironmentSettings, value: string, company: string | undefined): Promise<void> {
  if (entry.key === "savedEnvironments.switch" && value === "1") {
    const stack = await services.stacks.describe(settings.stacks["control-plane"]);
    const missing = savedEnvRegistryReadiness(stack?.outputs, env, (await services.identity.get()).account);
    if (missing.length > 0) throw agentXError("CONFIG_INVALID", `savedEnvironments.switch cannot be on: missing or invalid ${missing.join(", ")} on ${settings.stacks["control-plane"]}; nothing changed`);
  }
  if (entry.e2eAgentModel === true) checkE2eAgentChoice(env, settings, value);
  // DEC 254g: a non-Claude core agent model must be one the model gateway offers now (live, fail closed); a Claude id keeps its catalog rule.
  if (entry.gatewayOffered === true && value !== "" && !isClaudeAgentModel(value)) {
    await requireGatewayOffers({ key: entry.key, env, value, session: await services.adminSession?.(env), fetch: services.fetch ?? fetch, ...(company === undefined ? {} : { company }) });
  }
  if (entry.corePairedWith !== undefined) await notePairedCoreSetting(services, env, entry, entry.corePairedWith, value);
}
