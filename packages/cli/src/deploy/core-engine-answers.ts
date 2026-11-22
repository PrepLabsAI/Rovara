import { z } from "zod";
import { agentXError } from "@agentx/contracts";
import { coreAgentModel, coreModelGatewayUrl } from "../config/keys.js";

export interface CoreEngineAnswers { modelGatewayUrl: string; agentModel: string }
/** Reuse config's validators and normalization, but installation requires both values. */
export function coreEngineParameters(answers: CoreEngineAnswers | undefined): Record<string, string> {
  if (answers === undefined) throw agentXError("CONFIG_INVALID", "an install needs coreEngine { modelGatewayUrl, agentModel }; supply a signed-price gateway and its agent model in the answers");
  const host = coreModelGatewayUrl("coreEngine.modelGatewayUrl")(answers.modelGatewayUrl);
  const model = coreAgentModel("coreEngine.agentModel")(answers.agentModel);
  if (!host || !model) throw agentXError("CONFIG_INVALID", "coreEngine.modelGatewayUrl and coreEngine.agentModel must both be configured before worker activation");
  return { CoreModelGatewayHost: host, CoreAgentModel: model };
}
export const CoreEngineAnswersSchema = z.object({ modelGatewayUrl: z.string(), agentModel: z.string() }).strict().superRefine((answers, context) => {
  try { coreEngineParameters(answers); } catch (error) {
    context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "invalid coreEngine answers" });
  }
});
