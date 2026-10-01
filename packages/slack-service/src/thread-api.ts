import {
  SlackThreadPrepareResultSchema,
  SlackThreadWorkspaceResultSchema,
  SlackWorkspaceCloseCompleteResultSchema,
  SlackWorkspaceCloseStartResultSchema,
  ProjectModelOptionsSchema,
  ProjectModelSelectionRequestSchema,
  SwebenchRunSchema,
  SwebenchStartRequestSchema,
  SwebenchStartResultSchema,
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
    return serviceRequest("POST", path, body, failure);
  }

  async function serviceRequest(method: string, path: string, body: unknown, failure: string): Promise<Record<string, unknown>> {
    const response = await signedFetch(`${controlPlaneUrl}${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
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
      return SlackThreadPrepareResultSchema.parse(await servicePost("/v1/threads/workspace/prepare", { requestId, includeOpenTaskCount: true, includeSharedTask: true }, "thread workspace preparation failed"));
    },
    async startClose(requestId) {
      return SlackWorkspaceCloseStartResultSchema.parse(await servicePost("/v1/threads/workspace/close", { requestId, includeSharedTask: true }, "workspace close request failed"));
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
    async taskResult(workspaceId, operationId, signal) {
      // The same wait and final response agentx_task_result gives the model (issue 157).
      const result = await client(workspaceId).taskResult({ workspaceId, operationId }, signal === undefined ? {} : { signal }) as {
        status: string; response?: string; error?: string;
      };
      return {
        status: result.status,
        ...(result.response === undefined ? {} : { response: result.response }),
        ...(result.error === undefined ? {} : { error: result.error }),
      };
    },
    async createConversation(workspaceId) {
      return (await client(workspaceId).createConversation()).id;
    },
    async listProjectModels() {
      return ProjectModelOptionsSchema.parse(await serviceRequest("GET", "/v1/project/models", undefined, "project model list failed"));
    },
    async selectProjectModel(model) {
      const body = ProjectModelSelectionRequestSchema.parse(model);
      return ProjectModelOptionsSchema.parse(await serviceRequest("PUT", "/v1/project/model", body, "project model selection failed"));
    },
    async startSwebenchRun(request) {
      const body = SwebenchStartRequestSchema.parse(request);
      return SwebenchStartResultSchema.parse(await servicePost("/v1/evals/swebench", body, "SWE-bench run request failed"));
    },
    async getSwebenchRun(runId) {
      const response = await serviceRequest("GET", `/v1/evals/swebench/${encodeURIComponent(runId)}`, undefined, "SWE-bench run lookup failed");
      return SwebenchRunSchema.parse(response.run);
    },
  };
}
