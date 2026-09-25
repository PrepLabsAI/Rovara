import { createOrchestratorRuntime, type OrchestratorOptions } from "@agentx/orchestrator/orchestrator";
import type { TurnInput } from "./processor.js";

/** Shared production/test boundary: tool routing comes from workspace resolution, never Slack text. */
export function createHostedSlackRuntime(input: TurnInput, options: Pick<OrchestratorOptions, "stateDirectory" | "api" | "model" | "sessionFile" | "onConnectorUnavailable">) {
  return createOrchestratorRuntime({
    ...options,
    projectInstructions: input.orchestratorInstructions,
    context: { workspaceId: input.workspaceId, conversationId: input.conversationId },
    requestId: input.requestId,
    ...(input.connectors === undefined ? {} : { connectors: input.connectors }),
    ...(input.repositories === undefined ? {} : { repositories: input.repositories }),
    ...(input.recoverableOperations === undefined ? {} : { recoverableOperations: input.recoverableOperations }),
    ...(input.recorder === undefined ? {} : { turnRecorder: input.recorder }),
    ...(input.refreshConnectors === undefined ? {} : { refreshConnectors: input.refreshConnectors }),
  });
}
