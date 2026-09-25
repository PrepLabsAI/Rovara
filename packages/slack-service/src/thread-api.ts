import {
  SlackThreadPrepareResultSchema,
  SlackThreadWorkspaceResultSchema,
  SlackWorkspaceCloseCompleteResultSchema,
  SlackWorkspaceCloseStartResultSchema,
} from "@agentx/contracts";
import { ControlPlaneApi } from "@agentx/orchestrator/control-plane-api";
import { pollOperation } from "@agentx/orchestrator/event-client";
import type { ThreadServiceApi } from "./processor.js";
import { threadWorkspaceRequest } from "./thread-workspace-request.js";

/** The Slack service's thread-level control-plane client, moved out of main.ts so tests can drive it. */
export function createThreadApi(options: { controlPlaneUrl: string; signedFetch: typeof fetch; pollIntervalMilliseconds?: number }): ThreadServiceApi {
  const { controlPlaneUrl, signedFetch } = options;
  const client = (workspaceId: string) => new ControlPlaneApi(controlPlaneUrl, "slack-service", workspaceId, signedFetch);

  async function servicePost(path: string, body: unknown, failure: string): Promise<Record<string, unknown>> {
    const response = await signedFetch(`${controlPlaneUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const parsed = await response.json() as Record<string, unknown>;
    if (!response.ok) {
      const error = parsed.error as { code?: string; message?: string } | undefined;
      throw new Error(`${failure}: ${error?.code ?? response.status} ${error?.message ?? ""}`.trim());
    }
    delete parsed.requestId;
    return parsed;
  }

  return {
    async ensureWorkspace(requestId) {
      return SlackThreadWorkspaceResultSchema.parse(await servicePost("/v1/threads/workspace", threadWorkspaceRequest(requestId), "thread workspace request failed"));
    },
    async prepareWorkspace(requestId) {
      return SlackThreadPrepareResultSchema.parse(await servicePost("/v1/threads/workspace/prepare", { requestId }, "thread workspace preparation failed"));
    },
    async startClose(requestId) {
      return SlackWorkspaceCloseStartResultSchema.parse(await servicePost("/v1/threads/workspace/close", { requestId }, "workspace close request failed"));
    },
    async completeClose(requestId, operationId) {
      return SlackWorkspaceCloseCompleteResultSchema.parse(
        await servicePost("/v1/threads/workspace/close/complete", { requestId, operationId }, "workspace close completion failed"),
      );
    },
    async waitForOperation(workspaceId, operationId, signal) {
      const { operation } = await pollOperation(operationId, client(workspaceId), {
        intervalMilliseconds: options.pollIntervalMilliseconds ?? 5_000,
        ...(signal === undefined ? {} : { signal }),
      });
      return {
        status: operation.status,
        ...(operation.error === undefined ? {} : { error: operation.error }),
        ...(operation.result === undefined ? {} : { result: operation.result }),
      };
    },
    async createConversation(workspaceId) {
      return (await client(workspaceId).createConversation()).id;
    },
  };
}
