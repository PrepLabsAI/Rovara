import { z } from "zod";
import { agentXError } from "@agentx/contracts";
import { coreAgentModel, coreModelGatewayUrl } from "../config/keys.js";

export interface CoreEngineAnswers { modelGatewayUrl: string; agentModel: string }

/** True when the install uses the built-in self-hosted `agentx-<env>-gateway` stack instead of an external gateway URL. */
export function usesBuiltInGateway(answers: CoreEngineAnswers | undefined): boolean {
  return answers === undefined || answers.modelGatewayUrl.trim() === "";
}

/** Reuse config's validators and normalization. Empty `modelGatewayUrl` means the built-in self-hosted gateway stack will be deployed and wired automatically. */
export function coreEngineParameters(answers: CoreEngineAnswers | undefined, options: { allowDeferredGateway?: boolean } = {}): Record<string, string> {
  if (answers === undefined) throw agentXError("CONFIG_INVALID", "an install needs coreEngine { modelGatewayUrl, agentModel }; supply a signed-price gateway (or empty for built-in) and its agent model in the answers");
  const model = coreAgentModel("coreEngine.agentModel")(answers.agentModel);
  if (!model) throw agentXError("CONFIG_INVALID", "coreEngine.agentModel must be configured before worker activation");
  const rawUrl = answers.modelGatewayUrl.trim();
  if (rawUrl === "") {
    if (options.allowDeferredGateway === true) return { CoreAgentModel: model };
    throw agentXError("CONFIG_INVALID", "coreEngine.modelGatewayUrl and coreEngine.agentModel must both be configured before worker activation");
  }
  const host = coreModelGatewayUrl("coreEngine.modelGatewayUrl")(rawUrl);
  if (!host) throw agentXError("CONFIG_INVALID", "coreEngine.modelGatewayUrl and coreEngine.agentModel must both be configured before worker activation");
  return { CoreModelGatewayHost: host, CoreAgentModel: model };
}

export const CoreEngineAnswersSchema = z.object({ modelGatewayUrl: z.string(), agentModel: z.string() }).strict().superRefine((answers, context) => {
  try { coreEngineParameters(answers, { allowDeferredGateway: true }); } catch (error) {
    context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "invalid coreEngine answers" });
  }
});
