import { randomUUID } from "node:crypto";
import type { OrchestrationApi } from "./orchestration-tools.js";
import type { ReconnectState } from "./client-state.js";

export async function sendFeedback(
  api: OrchestrationApi,
  state: ReconnectState,
  prompt: string,
): Promise<unknown> {
  return api.followUp({
    workspaceId: state.workspaceId,
    conversationId: state.conversationId,
    requestId: randomUUID(),
    prompt,
  });
}
