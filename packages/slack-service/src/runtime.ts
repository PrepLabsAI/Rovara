import { createOrchestratorRuntime, type OrchestratorOptions } from "@agentx/cli/orchestrator";
import type { TurnInput } from "./processor.js";

/** Shared production/test boundary: tool routing comes from workspace resolution, never Slack text. */
export function createHostedSlackRuntime(input: TurnInput, options: Pick<OrchestratorOptions, "stateDirectory" | "api" | "model" | "sessionFile">) {
  return createOrchestratorRuntime({
    ...options,
    projectInstructions: input.orchestratorInstructions,
    context: { workspaceId: input.workspaceId, conversationId: input.conversationId },
    requestId: input.requestId,
    ...(input.githubMcpRepositories === undefined ? {} : { githubMcpRepositories: input.githubMcpRepositories }),
  });
}
