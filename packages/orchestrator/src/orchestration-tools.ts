import { randomUUID } from "node:crypto";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ConnectorCallRequest, ConnectorCatalog } from "@agentx/contracts";
import { createConnectorTools } from "./connector-tools.js";

export const ORCHESTRATION_TOOL_NAMES = [
  "agentx_submit_task",
  "agentx_create_pull_request",
  "agentx_task_status",
  "agentx_task_result",
  "agentx_follow_up",
  "agentx_manage_pull_request",
] as const;

export const RECOVERY_TOOL_NAMES = ["agentx_task_status", "agentx_task_result"] as const;

/** In-house tools that run on the remote worker, so a thread without compute prepares it first (spec 014). */
export const WORKER_TOOL_NAMES = ["agentx_submit_task", "agentx_follow_up"] as const;

/** Why a tool that needs the worker cannot run; handed to the model as the tool result. */
export interface WorkerRefusal {
  status: "WORKSPACE_LIMIT_REACHED" | "WORKSPACE_UNAVAILABLE";
  message: string;
}

/** A thread's worker, prepared on first use. Absent for a thread that already has compute. */
export interface WorkerAccess {
  /**
   * True once this thread has prepared compute in this turn. A plain, externally readable fact,
   * not just an internal detail of these tools: 14c part 2's confirmation gate reads it to decide
   * whether agentx_submit_task counts as a write (spec 014 D5).
   */
  prepared(): boolean;
  /** Prepares compute once per turn. Undefined when the worker can take work; otherwise a refusal. */
  ensureReady(): Promise<WorkerRefusal | undefined>;
}

/** A thread with no compute has no changes to publish; preparing a fresh clone would not change that. */
export const NO_WORKSPACE_TO_PUBLISH = {
  status: "NO_WORKSPACE",
  message: "This thread has no workspace yet, so it has no changes to publish. Run the coding work with agentx_submit_task first.",
} as const;

/** Retired in feature 013; kept so the orchestrator can tell the model the new name for one release. */
// TODO(2026-09-24): remove this map and the retired-names prompt line in orchestrator.ts one release
// after feature 013 ships.
export const RETIRED_PULL_REQUEST_TOOLS = {
  agentx_update_pull_request: "edit",
  agentx_append_pull_request: "append",
  agentx_sync_pull_request: "sync",
  agentx_close_pull_request: "close",
  agentx_reopen_pull_request: "reopen",
  agentx_replace_pull_request: "replace",
  agentx_revert_pull_request: "revert",
} as const;

const PULL_REQUEST_ACTIONS = ["edit", "append", "sync", "close", "reopen", "replace", "revert"] as const;
type PullRequestAction = (typeof PULL_REQUEST_ACTIONS)[number];
/** Only these actions ever carried a title or body. */
const TITLED_ACTIONS = new Set<PullRequestAction>(["edit", "replace", "revert"]);

export interface OrchestrationApi {
  discoverConnectorTools?(input: { workspaceId: string; connector: string; refresh?: boolean }): Promise<ConnectorCatalog>;
  callConnectorTool?(input: ConnectorCallRequest & { workspaceId: string; connector: string }): Promise<unknown>;
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
  options: {
    requestId?: () => string;
    connectorCatalogs?: readonly ConnectorCatalog[];
    recovery?: boolean;
    onConnectorError?: (toolCallId: string, code: string) => void;
    /** Spec 014: present only for a thread whose compute is not prepared yet. */
    worker?: WorkerAccess;
    /**
     * Issue 157: told each worker task or follow-up operation as soon as it is accepted, and awaited
     * before the tool waits on it, so the host can remember it durably. It must not throw.
     */
    onOperationAccepted?: (operationId: string) => Promise<void>;
  } = {},
): ToolDefinition[] {
  const nextRequestId = options.requestId ?? randomUUID;
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
        const refusal = await options.worker?.ensureReady();
        if (refusal) return toolResult(refusal);
        const accepted = await api.submitTask({
          ...context,
          requestId: nextRequestId(),
          prompt: parameters.prompt,
        });
        const operationId = acceptedOperationId(accepted);
        await options.onOperationAccepted?.(operationId);
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
        if (options.worker && !options.worker.prepared()) return toolResult(NO_WORKSPACE_TO_PUBLISH);
        const accepted = await api.createPullRequest({
          workspaceId: context.workspaceId,
          requestId: nextRequestId(),
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
        const refusal = await options.worker?.ensureReady();
        if (refusal) return toolResult(refusal);
        const accepted = await api.followUp({
          ...context,
          requestId: nextRequestId(),
          prompt: parameters.prompt,
        });
        const operationId = acceptedOperationId(accepted);
        await options.onOperationAccepted?.(operationId);
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
  tools.push(defineTool({
    name: "agentx_manage_pull_request",
    label: "Manage pull request",
    description:
      "Change an existing AgentX-owned pull request. Actions: edit its title or body; append new workspace commits with a normal fast-forward push; " +
      "sync by merging the latest base branch into it; close it; reopen a closed, unmerged one; replace it with clean history (the new pull request is " +
      "created before the original is closed); revert a merged one with a reviewable revert pull request. History is never rebased or force-pushed. " +
      "Title and body apply only to edit, replace and revert. Call only for the action the user explicitly asked for.",
    parameters: Type.Object({
      repository: Type.String({ minLength: 1, maxLength: 63 }),
      pullRequestNumber: Type.Integer({ minimum: 1 }),
      action: Type.Unsafe<PullRequestAction>({ type: "string", enum: [...PULL_REQUEST_ACTIONS] }),
      title: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
      body: Type.Optional(Type.String({ maxLength: 32_768 })),
    }),
    execute: async (_id, parameters, signal, onUpdate) => {
      const titled = TITLED_ACTIONS.has(parameters.action);
      const accepted = await api.managePullRequest({
        workspaceId: context.workspaceId,
        requestId: nextRequestId(),
        repository: parameters.repository,
        pullRequestNumber: parameters.pullRequestNumber,
        action: parameters.action,
        ...(titled && parameters.title !== undefined ? { title: parameters.title } : {}),
        ...(titled && parameters.body !== undefined ? { body: parameters.body } : {}),
      });
      const operationId = acceptedOperationId(accepted);
      onUpdate?.(toolResult({ operationId, status: "ACCEPTED", message: `AgentX accepted pull request ${parameters.action}.` }));
      return toolResult(await api.pullRequestResult(
        { workspaceId: context.workspaceId, operationId },
        {
          ...(signal === undefined ? {} : { signal }),
          onProgress: (progress) => onUpdate?.(toolResult(progress)),
        },
      ));
    },
  }));
  if (options.recovery === false) {
    const recovery = new Set<string>(RECOVERY_TOOL_NAMES);
    for (let index = tools.length - 1; index >= 0; index -= 1) if (recovery.has(tools[index]!.name)) tools.splice(index, 1);
  }
  if (options.connectorCatalogs?.some((catalog) => catalog.tools.length > 0)) {
    if (!api.callConnectorTool) throw new Error("connector API is not configured");
    tools.push(...createConnectorTools(options.connectorCatalogs, (input) => api.callConnectorTool!(input), context, options));
  }
  return tools;
}

export function assertOrchestrationOnly(tools: readonly Pick<ToolDefinition, "name" | "executionMode">[], catalogs: readonly ConnectorCatalog[] = []): void {
  const allowed = new Set<string>([...ORCHESTRATION_TOOL_NAMES, ...catalogs.flatMap((catalog) => catalog.tools.map((tool) => tool.name))]);
  const forbidden = tools.map(({ name }) => name).filter((name) => !allowed.has(name));
  if (forbidden.length > 0) throw new Error(`local orchestrator exposes forbidden tools: ${forbidden.join(", ")}`);
  // Pi prepares (and so gates) every sibling call before running any only in parallel mode; one
  // sequential tool switches the whole batch to run each call before the next is decided.
  const sequential = tools.filter((tool) => tool.executionMode === "sequential").map(({ name }) => name);
  if (sequential.length > 0) {
    throw new Error(`orchestrator tools must run in Pi's parallel mode so the action gate decides every call before any runs: ${sequential.join(", ")} ${sequential.length === 1 ? "is" : "are"} sequential`);
  }
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
