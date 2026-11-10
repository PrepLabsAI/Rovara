import {
  CommentAnsweredRequestSchema,
  ThreadNoteAnsweredRequestSchema,
  ThreadNoteAnsweredResultSchema,
  ThreadPrepareResultSchema,
  ThreadWorkspaceResultSchema,
  WorkspaceCloseCompleteResultSchema,
  WorkspaceCloseStartResultSchema,
  ProjectModelOptionsSchema,
  ProjectModelSelectionRequestSchema,
  taskResultChecks,
} from "@agentx/contracts";
import { ControlPlaneApi } from "@agentx/orchestrator/control-plane-api";
import { pollOperation } from "@agentx/orchestrator/event-client";
import type { ThreadServiceApi } from "./processor.js";
import { threadWorkspaceRequest } from "./thread-workspace-request.js";

/** The orchestrator service's conversation-level control-plane client; Slack's extra routes are in slack-thread-api.ts. */
/** One request to a /v1/service route; an error answer throws with its code and message. */
export async function serviceRequestWith(signedFetch: typeof fetch, url: string, method: string, body: unknown, failure: string): Promise<Record<string, unknown>> {
  const response = await signedFetch(url, {
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

export function createThreadApi(options: { controlPlaneUrl: string; signedFetch: typeof fetch; pollIntervalMilliseconds?: number }): ThreadServiceApi {
  const { controlPlaneUrl, signedFetch } = options;
  const client = (workspaceId: string) => new ControlPlaneApi(controlPlaneUrl, "slack-service", workspaceId, signedFetch);

  async function servicePost(path: string, body: unknown, failure: string): Promise<Record<string, unknown>> {
    return serviceRequest("POST", path, body, failure);
  }

  async function serviceRequest(method: string, path: string, body: unknown, failure: string): Promise<Record<string, unknown>> {
    return serviceRequestWith(signedFetch, `${controlPlaneUrl}${path}`, method, body, failure);
  }

  return {
    async ensureWorkspace(requestId) {
      return ThreadWorkspaceResultSchema.parse(await servicePost("/v1/threads/workspace", threadWorkspaceRequest(requestId), "thread workspace request failed"));
    },
    async taskAnswerWorkspace(requestId, taskId, commentId) {
      const taskAnswer = commentId === undefined ? { taskId } : { taskId, commentId };
      return ThreadWorkspaceResultSchema.parse(await servicePost("/v1/threads/workspace", { ...threadWorkspaceRequest(requestId), taskAnswer }, "task answer workspace request failed"));
    },
    async markCommentAnswered(input) {
      const body = CommentAnsweredRequestSchema.parse(input);
      await servicePost("/v1/tasks/comments/answered", body, "writing the comment answer failed");
    },
    async markThreadNoteAnswered(input) {
      const body = ThreadNoteAnsweredRequestSchema.parse(input);
      ThreadNoteAnsweredResultSchema.parse(await servicePost("/v1/tasks/thread-notes/answered", body, "marking the thread note answered failed"));
    },
    async prepareWorkspace(requestId) {
      return ThreadPrepareResultSchema.parse(await servicePost("/v1/threads/workspace/prepare", { requestId, includeOpenTaskCount: true, includeSharedTask: true }, "thread workspace preparation failed"));
    },
    async startClose(requestId, discardUnpublished = false) {
      return WorkspaceCloseStartResultSchema.parse(await servicePost("/v1/threads/workspace/close", { requestId, includeSharedTask: true, ...(discardUnpublished ? { discard_unpublished: true } : {}) }, "workspace close request failed"));
    },
    async completeClose(requestId, operationId) {
      return WorkspaceCloseCompleteResultSchema.parse(
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
        status: string; response?: string; error?: string; checks?: unknown;
      };
      const checks = taskResultChecks(result);
      return {
        status: result.status,
        ...(checks === undefined ? {} : { checks }),
        ...(result.response === undefined ? {} : { response: result.response }),
        ...(result.error === undefined ? {} : { error: result.error }),
      };
    },
    async cancelOperation(workspaceId, operationId) {
      const answer = await client(workspaceId).cancelOperation({ workspaceId, operationId });
      // A duplicate names the target, which had already finished; otherwise a cancel was queued.
      return answer.duplicate ? { outcome: "finished", status: answer.status } : { outcome: "requested" };
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
  };
}
