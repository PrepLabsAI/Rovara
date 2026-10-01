import {
  SWEBENCH_SETTING_PARAMETERS,
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
    modelProvider: name(WORKER_SETTING_PARAMETERS.modelProvider),
    modelId: name(WORKER_SETTING_PARAMETERS.modelId),
    promptCacheRetention: name(WORKER_SETTING_PARAMETERS.promptCacheRetention),
    openRouterSecretArn: name(WORKER_SETTING_PARAMETERS.openRouterSecretArn),
    openRouterProviders: name(WORKER_SETTING_PARAMETERS.openRouterProviders),
  };
  const values = await read(Object.values(names));
  const settingsValue = values.get(names.settings);
  const runnerImage = values.get(names.runnerImage);
  if (settingsValue === undefined || runnerImage === undefined || runnerImage === "none") return undefined;
  if (!ECR_DIGEST_IMAGE.test(runnerImage)) throw new Error(`${names.runnerImage} must be an ECR image pinned by digest`);
  const settings = SwebenchSettingsSchema.parse(JSON.parse(settingsValue));
  const provider = values.get(names.modelProvider);
  const modelId = values.get(names.modelId);
  if (!provider || !modelId) throw new Error(`${names.modelProvider} and ${names.modelId} are required for SWE-bench runs`);
  const environment: SwebenchLaunch["environment"] = {};
  const retention = values.get(names.promptCacheRetention);
  if (retention === "short" || retention === "long") environment.PI_CACHE_RETENTION = retention;
  const secret = values.get(names.openRouterSecretArn);
  if (secret && secret !== "none") environment.AGENTX_OPENROUTER_SECRET_ARN = secret;
  const providers = values.get(names.openRouterProviders);
  if (providers && providers !== "none") environment.AGENTX_OPENROUTER_PROVIDERS = providers;
  return { settings, runnerImage, defaultModel: { provider, modelId }, environment };
}
