// The one place that picks the existing single-call check for a provider and runs it through the shared model check (M1.4 Task 4.10D): init's Bedrock branch,
// `config set`, doctor and the project-model checks all come here, so every failure carries the same class and a persistent Bedrock throttle is read against the quota.
import type { ModelsAnswers } from "../deploy/answer-schemas.js";
import { checkModel, type ModelCheckResult } from "@agentx/model-runtime/model-check";
import type { ModelProvider } from "@agentx/contracts";
import type { PrerequisiteChecks } from "./prerequisites.js";

/** Where each keyed provider's key and routing are configured for the environment (the settings' `models`). */
export interface ModelCheckConfig {
  openRouter?: ModelsAnswers["openRouter"] | undefined;
  anthropic?: { secretArn?: string } | undefined;
  openai?: { secretArn?: string } | undefined;
}

export type ModelCheckChecks = Pick<PrerequisiteChecks, "converse" | "openRouter" | "directProvider" | "quotas">;

/** Runs the check for one provider and model. A check this agentx cannot make (no OpenRouter or direct checker) is a failure of the check, not a pass. */
export async function runModelCheck(input: {
  provider: ModelProvider; modelId: string; region: string; checks: ModelCheckChecks; config: ModelCheckConfig; sleep: (ms: number) => Promise<void>;
}): Promise<ModelCheckResult> {
  const { provider, modelId, checks, config } = input;
  const run = async (): Promise<void> => {
    if (provider === "openrouter") {
      if (checks.openRouter === undefined) throw new Error("this agentx cannot check OpenRouter models");
      await checks.openRouter(modelId, config.openRouter ?? {});
    } else if (provider === "anthropic" || provider === "openai") {
      if (checks.directProvider === undefined) throw new Error(`this agentx cannot check ${provider} models`);
      await checks.directProvider(provider, modelId, config[provider] ?? {});
    } else {
      await checks.converse(modelId);
    }
  };
  return checkModel({ provider, modelId, region: input.region }, { run, sleep: input.sleep, ...(checks.quotas === undefined ? {} : { quotas: checks.quotas }), now: Date.now });
}
