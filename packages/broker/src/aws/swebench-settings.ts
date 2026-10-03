import {
  agentXError,
  SWEBENCH_SETTING_PARAMETERS,
  SwebenchRunnerFeaturesSchema,
  SwebenchSettingsSchema,
  WORKER_SETTING_PARAMETERS,
  type SwebenchLaunch,
} from "@agentx/contracts";
import type { SwebenchDeployment } from "./swebench.js";

const ECR_DIGEST_IMAGE = /^\d{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/[a-z0-9]+(?:[._/-][a-z0-9]+)*@sha256:[0-9a-f]{64}$/;

/**
 * Spec 043 FR-016: the eval stack's settings, the runner image and the worker model settings, from
 * SSM under the environment's settings prefix. Undefined until the eval stack and a runner image are
 * both installed; a malformed value is an error, not "not installed".
 */
export async function swebenchDeploymentFromParameters(
  prefix: string,
  read: (names: readonly string[]) => Promise<ReadonlyMap<string, string>>,
): Promise<SwebenchDeployment | undefined> {
  const name = (suffix: string) => `${prefix}${suffix}`;
  const names = {
    settings: name(SWEBENCH_SETTING_PARAMETERS.settings),
    runnerImage: name(SWEBENCH_SETTING_PARAMETERS.runnerImage),
    runnerFeatures: name(SWEBENCH_SETTING_PARAMETERS.runnerFeatures),
    modelProvider: name(WORKER_SETTING_PARAMETERS.modelProvider),
    modelId: name(WORKER_SETTING_PARAMETERS.modelId),
    promptCacheRetention: name(WORKER_SETTING_PARAMETERS.promptCacheRetention),
    openRouterSecretArn: name(WORKER_SETTING_PARAMETERS.openRouterSecretArn),
    openRouterProviders: name(WORKER_SETTING_PARAMETERS.openRouterProviders),
    anthropicSecretArn: name(WORKER_SETTING_PARAMETERS.anthropicSecretArn),
    openaiSecretArn: name(WORKER_SETTING_PARAMETERS.openaiSecretArn),
  };
  const values = await read(Object.values(names));
  const settingsValue = values.get(names.settings);
  const runnerImage = values.get(names.runnerImage);
  if (settingsValue === undefined || runnerImage === undefined || runnerImage === "none") return undefined;
  // #48 review: AgentXErrors, so the broker's catch-all passes these operator fixes on in its answer.
  if (!ECR_DIGEST_IMAGE.test(runnerImage)) throw agentXError("RUNTIME_UNAVAILABLE", `${names.runnerImage} must be an ECR image pinned by digest`);
  const settings = parseSettings(settingsValue, names.settings);
  const provider = values.get(names.modelProvider);
  const modelId = values.get(names.modelId);
  if (!provider || !modelId) throw agentXError("RUNTIME_UNAVAILABLE", `${names.modelProvider} and ${names.modelId} are required for SWE-bench runs`);
  const environment: SwebenchLaunch["environment"] = {};
  const retention = values.get(names.promptCacheRetention);
  if (retention === "short" || retention === "long") environment.PI_CACHE_RETENTION = retention;
  const secret = values.get(names.openRouterSecretArn);
  if (secret && secret !== "none") environment.AGENTX_OPENROUTER_SECRET_ARN = secret;
  const providers = values.get(names.openRouterProviders);
  if (providers && providers !== "none") environment.AGENTX_OPENROUTER_PROVIDERS = providers;
  const anthropic = values.get(names.anthropicSecretArn);
  if (anthropic && anthropic !== "none") environment.AGENTX_ANTHROPIC_SECRET_ARN = anthropic;
  const openai = values.get(names.openaiSecretArn);
  if (openai && openai !== "none") environment.AGENTX_OPENAI_SECRET_ARN = openai;
  return { settings, runnerImage, defaultModel: { provider, modelId }, environment, runnerFeatures: runnerFeatures(values.get(names.runnerFeatures), runnerImage) };
}

/**
 * Spec 053: the features recorded for this runner image. Missing, malformed or recorded for another
 * image means none, so the broker sends only what every runner image parses.
 */
function runnerFeatures(value: string | undefined, runnerImage: string): readonly string[] {
  if (value === undefined) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return []; }
  const recorded = SwebenchRunnerFeaturesSchema.safeParse(parsed);
  return recorded.success && recorded.data.runnerImage === runnerImage ? recorded.data.features : [];
}

/** The stored settings, or a refusal naming the parameter; the parser's own words would quote it. */
function parseSettings(value: string, parameter: string): SwebenchDeployment["settings"] {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { parsed = undefined; }
  const settings = SwebenchSettingsSchema.safeParse(parsed);
  if (!settings.success) throw agentXError("RUNTIME_UNAVAILABLE", `${parameter} is not valid SWE-bench settings JSON; install the eval stack again`);
  return settings.data;
}
