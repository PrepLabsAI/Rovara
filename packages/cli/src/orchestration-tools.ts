import { randomUUID } from "node:crypto";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const ORCHESTRATION_TOOL_NAMES = [
  "agentx_submit_task",
  "agentx_create_pull_request",
  "agentx_task_status",
  "agentx_task_result",
  "agentx_follow_up",
  "agentx_update_pull_request",
  "agentx_append_pull_request",
  "agentx_sync_pull_request",
  "agentx_close_pull_request",
  "agentx_reopen_pull_request",
  "agentx_replace_pull_request",
  "agentx_revert_pull_request",
] as const;

export interface OrchestrationApi {
  submitTask(input: {
    workspaceId: string;
    conversationId: string;
    requestId: string;
    prompt: string;
  }): Promise<unknown>;
  taskStatus(input: { workspaceId: string; operationId: string }): Promise<unknown>;
  taskResult(
    input: { workspaceId: string; operationId: string },
    options?: {
      signal?: AbortSignal;
      onProgress?: (progress: { operationId: string; status: string; message: string }) => void;
    },
  ): Promise<unknown>;
  followUp(input: {
    workspaceId: string;
    conversationId: string;
    requestId: string;
    prompt: string;
  }): Promise<unknown>;
  createPullRequest(input: {
    workspaceId: string;
    requestId: string;
    repository: string;
    title: string;
    body?: string;
  }): Promise<unknown>;
  managePullRequest(input: {
    workspaceId: string;
    requestId: string;
    repository: string;
    pullRequestNumber: number;
    action: "append" | "sync" | "edit" | "close" | "reopen" | "replace" | "revert";
    title?: string;
    body?: string;
  }): Promise<unknown>;
  pullRequestResult(
    input: { workspaceId: string; operationId: string },
    options?: {
      signal?: AbortSignal;
      onProgress?: (progress: { operationId: string; status: string; message: string }) => void;
    },
  ): Promise<unknown>;
}

export interface OrchestrationContext {
  workspaceId: string;
  conversationId: string;
}

export function createOrchestrationTools(
  api: OrchestrationApi,
  context: OrchestrationContext,
): ToolDefinition[] {
  const promptParameters = Type.Object({ prompt: Type.String({ minLength: 1, maxLength: 65_536 }) });
  const operationParameters = Type.Object({ operationId: Type.String({ format: "uuid" }) });
  const tools: ToolDefinition[] = [
    defineTool({
      name: "agentx_submit_task",
      label: "Delegate coding task",
      description:
        "Run repository inspection, editing, build, or test work on the remote AgentX worker. " +
        "This waits for completion and returns the worker's final response; do not poll or resubmit the task.",
      parameters: promptParameters,
      execute: async (_id, parameters, signal, onUpdate) => {
        const accepted = await api.submitTask({
          ...context,
          requestId: randomUUID(),
          prompt: parameters.prompt,
        });
        const operationId = acceptedOperationId(accepted);
        onUpdate?.(toolResult({ operationId, status: "ACCEPTED", message: "Remote AgentX worker accepted the task." }));
        return toolResult(await api.taskResult(
          { workspaceId: context.workspaceId, operationId },
          {
            ...(signal === undefined ? {} : { signal }),
            onProgress: (progress) => onUpdate?.(toolResult(progress)),
          },
        ));
      },
    }),
    defineTool({
      name: "agentx_create_pull_request",
      label: "Create pull request",
      description:
        "Explicitly validate and publish one changed registered repository as a ready-for-review pull request. " +
        "Call this only when the user clearly asks to create or raise a pull request.",
      parameters: Type.Object({
        repository: Type.String({ minLength: 1, maxLength: 63 }),
        title: Type.String({ minLength: 1, maxLength: 256 }),
        body: Type.Optional(Type.String({ maxLength: 32_768 })),
      }),
      execute: async (_id, parameters, signal, onUpdate) => {
        const accepted = await api.createPullRequest({
          workspaceId: context.workspaceId,
          requestId: randomUUID(),
          repository: parameters.repository,
          title: parameters.title,
          ...(parameters.body === undefined ? {} : { body: parameters.body }),
        });
        const operationId = acceptedOperationId(accepted);
        onUpdate?.(toolResult({ operationId, status: "ACCEPTED", message: "AgentX accepted pull request publication." }));
        return toolResult(await api.pullRequestResult(
          { workspaceId: context.workspaceId, operationId },
          {
            ...(signal === undefined ? {} : { signal }),
            onProgress: (progress) => onUpdate?.(toolResult(progress)),
          },
        ));
      },
    }),
    defineTool({
      name: "agentx_task_status",
      label: "Remote task status",
      description: "Recovery only: read durable status for a previously interrupted AgentX operation.",
      parameters: operationParameters,
      execute: async (_id, parameters) => toolResult(
        await api.taskStatus({ workspaceId: context.workspaceId, operationId: parameters.operationId }),
      ),
    }),
    defineTool({
      name: "agentx_task_result",
      label: "Remote task result",
      description:
        "Recovery only: wait for a previously interrupted operation and retrieve its final remote assistant response.",
      parameters: operationParameters,
      execute: async (_id, parameters, signal, onUpdate) => toolResult(
        await api.taskResult(
          { workspaceId: context.workspaceId, operationId: parameters.operationId },
          {
            ...(signal === undefined ? {} : { signal }),
            onProgress: (progress) => onUpdate?.(toolResult(progress)),
          },
        ),
      ),
    }),
    defineTool({
      name: "agentx_follow_up",
      label: "Remote follow-up",
      description:
        "Run a follow-up on the same remote workspace and conversation. " +
        "This waits for completion and returns the worker's final response; do not poll or resubmit it.",
      parameters: promptParameters,
      execute: async (_id, parameters, signal, onUpdate) => {
        const accepted = await api.followUp({
          ...context,
          requestId: randomUUID(),
          prompt: parameters.prompt,
        });
        const operationId = acceptedOperationId(accepted);
        onUpdate?.(toolResult({ operationId, status: "ACCEPTED", message: "Remote AgentX worker accepted the follow-up." }));
        return toolResult(await api.taskResult(
          { workspaceId: context.workspaceId, operationId },
          {
            ...(signal === undefined ? {} : { signal }),
            onProgress: (progress) => onUpdate?.(toolResult(progress)),
          },
        ));
      },
    }),
  ];
  const lifecycleTools = [
    ["update", "edit", "Edit the title or body of an AgentX-owned pull request."],
    ["append", "append", "Run checks and append workspace changes with a normal fast-forward push; force push is prohibited."],
    ["sync", "sync", "Merge the latest base branch into an open pull request; history is never rebased or force-pushed."],
    ["close", "close", "Close an open AgentX-owned pull request."],
    ["reopen", "reopen", "Reopen a closed, unmerged AgentX-owned pull request."],
    ["replace", "replace", "Create a clean replacement pull request before closing the original; never rewrite the old branch."],
    ["revert", "revert", "Create a reviewable revert pull request for a merged AgentX-owned pull request."],
  ] as const;
  for (const [toolName, action, description] of lifecycleTools) {
    tools.push(defineTool({
      name: `agentx_${toolName}_pull_request`,
      label: `${toolName[0]?.toUpperCase()}${toolName.slice(1)} pull request`,
      description: `${description} Call only when the user explicitly requests this pull request action.`,
      parameters: Type.Object({
        repository: Type.String({ minLength: 1, maxLength: 63 }),
        pullRequestNumber: Type.Integer({ minimum: 1 }),
        ...((action === "edit" || action === "replace" || action === "revert") ? {
          title: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
          body: Type.Optional(Type.String({ maxLength: 32_768 })),
        } : {}),
      }),
      execute: async (_id, parameters, signal, onUpdate) => {
        const lifecycle = parameters as {
          repository: string;
          pullRequestNumber: number;
          title?: string;
          body?: string;
        };
        const accepted = await api.managePullRequest({
          workspaceId: context.workspaceId,
          requestId: randomUUID(),
          repository: lifecycle.repository,
          pullRequestNumber: lifecycle.pullRequestNumber,
          action,
          ...(lifecycle.title === undefined ? {} : { title: lifecycle.title }),
          ...(lifecycle.body === undefined ? {} : { body: lifecycle.body }),
        });
        const operationId = acceptedOperationId(accepted);
        onUpdate?.(toolResult({ operationId, status: "ACCEPTED", message: `AgentX accepted pull request ${action}.` }));
        return toolResult(await api.pullRequestResult(
          { workspaceId: context.workspaceId, operationId },
          {
            ...(signal === undefined ? {} : { signal }),
            onProgress: (progress) => onUpdate?.(toolResult(progress)),
          },
        ));
      },
    }));
  }
  return tools;
}

export function assertOrchestrationOnly(tools: readonly Pick<ToolDefinition, "name">[]): void {
  const allowed = new Set<string>(ORCHESTRATION_TOOL_NAMES);
  const forbidden = tools.map(({ name }) => name).filter((name) => !allowed.has(name));
  if (forbidden.length > 0) throw new Error(`local orchestrator exposes forbidden tools: ${forbidden.join(", ")}`);
}

function toolResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    details: {},
  };
}

function acceptedOperationId(value: unknown): string {
  if (!value || typeof value !== "object") throw new Error("AgentX returned an invalid task acceptance response");
  const operation = (value as Record<string, unknown>).operation;
  if (!operation || typeof operation !== "object") throw new Error("AgentX task acceptance omitted the operation");
  const operationId = (operation as Record<string, unknown>).id;
  if (typeof operationId !== "string" || operationId.length === 0) {
    throw new Error("AgentX task acceptance omitted the operation ID");
  }
  return operationId;
}
