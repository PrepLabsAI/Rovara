import { randomUUID } from "node:crypto";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const ORCHESTRATION_TOOL_NAMES = [
  "agentx_submit_task",
  "agentx_task_status",
  "agentx_task_result",
  "agentx_follow_up",
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
  return [
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
