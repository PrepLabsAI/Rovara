import { agentXError } from "@agentx/contracts";
import { writeEnvironmentCache } from "./cache.js";
import type { ParameterStore } from "./parameter-store.js";
import { listEnvironments, readEnvironmentSettings } from "./settings.js";

/** `agentx env list`: the environments installed in this AWS account and region. */
export async function runEnvList(store: ParameterStore): Promise<string[]> {
  return listEnvironments(store);
}

/** `agentx --env <env> env use`: rebuild the local settings cache for <env> from SSM. */
export async function runEnvUse(input: { store: ParameterStore; home: string; env: string }): Promise<{ env: string; path: string; controlPlaneUrl: string }> {
  const settings = await readEnvironmentSettings(input.store, input.env);
  if (settings === undefined) {
    throw agentXError(
      "CONFIG_INVALID",
      `environment ${input.env} is not installed in this account and region; check your AWS profile and region, or install it with agentx init --env ${input.env}`,
    );
  }
  const path = await writeEnvironmentCache(input.home, settings);
  return { env: settings.env, path, controlPlaneUrl: settings.controlPlaneUrl };
}
