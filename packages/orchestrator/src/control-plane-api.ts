import {
  AgentXErrorCodeSchema,
  ConnectorCatalogSchema,
  ConnectorResultSchema,
  type ConnectorCallRequest,
  OperationSchema,
  agentXError,
  lastAssistantResponse,
  type Operation,
} from "@agentx/contracts";
import {
  pollOperation,
  type OperationPollingTransport,
  type RemoteEventPage,
  type RemoteOperationStatus,
} from "./event-client.js";
import type { OrchestrationApi } from "./orchestration-tools.js";

export { lastAssistantResponse };

export class ControlPlaneApi implements OrchestrationApi, OperationPollingTransport {
  readonly baseUrl: string;

  constructor(
    controlPlaneUrl: string,
    private readonly accessToken: string,
    private readonly workspaceId: string,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {
    this.baseUrl = controlPlaneUrl.replace(/\/$/, "");
  }

  async createConversation(): Promise<{ id: string; workspaceId: string }> {
    const value = object(await this.request(`/v1/workspaces/${this.workspaceId}/conversations`, {
      method: "POST",
    }));
    const conversation = object(value.conversation);
    if (typeof conversation.id !== "string" || conversation.workspaceId !== this.workspaceId) {
      throw agentXError("RUNTIME_UNAVAILABLE", "control plane returned an invalid conversation");
    }
    return { id: conversation.id, workspaceId: conversation.workspaceId };
  }

  async discoverConnectorTools(input: { workspaceId: string; connector: string; refresh?: boolean }) {
    this.assertWorkspace(input.workspaceId);
    // refresh=1 asks the broker to skip its per-container catalog cache; an older broker ignores it.
    const query = input.refresh === true ? "?refresh=1" : "";
    // Asks for the action gate's fields (spec 014); an older control plane ignores the header.
    const response = object(await this.request(`/v1/workspaces/${this.workspaceId}/connectors/${encodeURIComponent(input.connector)}/tools${query}`, {
      method: "GET", headers: { "x-agentx-include": "gate" },
    }));
    return ConnectorCatalogSchema.parse(response.catalog);
  }

  async callConnectorTool(input: ConnectorCallRequest & { workspaceId: string; connector: string }) {
    this.assertWorkspace(input.workspaceId);
    const { workspaceId, connector, ...body } = input;
    const response = object(await this.request(`/v1/workspaces/${workspaceId}/connectors/${encodeURIComponent(connector)}/call`, {
      method: "POST", body: JSON.stringify(body),
    }));
    return ConnectorResultSchema.parse(response.result);
  }

  async submitTask(input: {
    workspaceId: string;
    conversationId: string;
    requestId: string;
    prompt: string;
  }): Promise<unknown> {
    this.assertWorkspace(input.workspaceId);
    return this.request(`/v1/workspaces/${this.workspaceId}/tasks`, {
      method: "POST",
      body: JSON.stringify({
        requestId: input.requestId,
        conversationId: input.conversationId,
        prompt: input.prompt,
      }),
    });
  }

  async taskStatus(input: { workspaceId: string; operationId: string }): Promise<unknown> {
    this.assertWorkspace(input.workspaceId);
    return this.getOperation(input.operationId);
  }

  async taskResult(
    input: { workspaceId: string; operationId: string },
    options: {
      signal?: AbortSignal;
      onProgress?: (progress: { operationId: string; status: string; message: string }) => void;
    } = {},
  ): Promise<unknown> {
    this.assertWorkspace(input.workspaceId);
    const events: RemoteEventPage["events"] = [];
    const completed = await pollOperation(input.operationId, this, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      onEvents: (page) => {
        events.push(...page);
        options.onProgress?.({
          operationId: input.operationId,
          status: "RUNNING",
          message: `Remote AgentX worker is running (${events.length} progress events received).`,
        });
      },
    });
    return completedTaskResult(completed.operation, events);
  }

  async followUp(input: {
    workspaceId: string;
    conversationId: string;
    requestId: string;
    prompt: string;
  }): Promise<unknown> {
    return this.submitTask(input);
  }

  async createPullRequest(input: {
    workspaceId: string;
    requestId: string;
    repository: string;
    title: string;
    body?: string;
  }): Promise<unknown> {
    this.assertWorkspace(input.workspaceId);
    return this.request(`/v1/workspaces/${this.workspaceId}/pull-requests`, {
      method: "POST",
      body: JSON.stringify({
        requestId: input.requestId,
        repository: input.repository,
        title: input.title,
        ...(input.body === undefined ? {} : { body: input.body }),
      }),
    });
  }

  async managePullRequest(input: {
    workspaceId: string;
    requestId: string;
    repository: string;
    pullRequestNumber: number;
    action: "append" | "sync" | "edit" | "close" | "reopen" | "replace" | "revert";
    title?: string;
    body?: string;
  }): Promise<unknown> {
    this.assertWorkspace(input.workspaceId);
    return this.request(`/v1/workspaces/${this.workspaceId}/pull-request-actions`, {
      method: "POST",
      body: JSON.stringify({
        requestId: input.requestId,
        repository: input.repository,
        pullRequestNumber: input.pullRequestNumber,
        action: input.action,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.body === undefined ? {} : { body: input.body }),
      }),
    });
  }

  async pullRequestResult(
    input: { workspaceId: string; operationId: string },
    options: {
      signal?: AbortSignal;
      onProgress?: (progress: { operationId: string; status: string; message: string }) => void;
    } = {},
  ): Promise<unknown> {
    this.assertWorkspace(input.workspaceId);
    const completed = await pollOperation(input.operationId, this, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      onEvents: (events) => options.onProgress?.({
        operationId: input.operationId,
        status: "RUNNING",
        message: `Remote AgentX publication is running (${events.length} new events).`,
      }),
    });
    return {
      operationId: completed.operation.id,
      status: completed.operation.status,
      ...(completed.operation.result === undefined ? {} : { result: completed.operation.result }),
      ...(completed.operation.error === undefined ? {} : { error: completed.operation.error }),
    };
  }

  /**
   * Issue 167: asks the worker to cancel an operation through the broker's cancel route. An
   * operation that already finished answers as a duplicate with its own status, and nothing is
   * queued; otherwise the answer is the queued cancel operation.
   */
  async cancelOperation(input: { workspaceId: string; operationId: string }): Promise<{ duplicate: true; status: string } | { duplicate: false }> {
    this.assertWorkspace(input.workspaceId);
    const value = object(await this.request(
      `/v1/workspaces/${this.workspaceId}/operations/${encodeURIComponent(input.operationId)}/cancel`,
      { method: "POST" },
    ));
    // Only the finished target's status is read, so a queued cancel never fails on the rest of the answer.
    return value.duplicate === true ? { duplicate: true, status: OperationSchema.parse(value.operation).status } : { duplicate: false };
  }

  async getOperation(operationId: string): Promise<Operation> {
    const value = object(await this.request(
      `/v1/workspaces/${this.workspaceId}/operations/${encodeURIComponent(operationId)}`,
    ));
    return OperationSchema.parse(value.operation);
  }

  async getEvents(operationId: string, cursor?: string): Promise<RemoteEventPage> {
    const parameters = new URLSearchParams({ limit: "500" });
    if (cursor !== undefined) parameters.set("cursor", cursor);
    const value = object(await this.request(
      `/v1/workspaces/${this.workspaceId}/operations/${encodeURIComponent(operationId)}/events?${parameters.toString()}`,
    ));
    if (!Array.isArray(value.events)) {
      throw agentXError("RUNTIME_UNAVAILABLE", "control plane returned an invalid event page");
    }
    const events = value.events.map((entry) => {
      const event = object(entry);
      if (
        typeof event.sequence !== "number" ||
        typeof event.type !== "string" ||
        typeof event.timestamp !== "string"
      ) {
        throw agentXError("RUNTIME_UNAVAILABLE", "control plane returned an invalid event");
      }
      return {
        sequence: event.sequence,
        type: event.type,
        timestamp: event.timestamp,
        payload: event.payload,
      };
    });
    if (value.cursor !== undefined && typeof value.cursor !== "string") {
      throw agentXError("RUNTIME_UNAVAILABLE", "control plane returned an invalid event cursor");
    }
    return { events, ...(value.cursor === undefined ? {} : { cursor: value.cursor }) };
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.accessToken}`);
    if (init.body !== undefined) headers.set("content-type", "application/json");
    let response: Response;
    try {
      response = await this.fetchImplementation(`${this.baseUrl}${path}`, { ...init, headers });
    } catch (error) {
      throw agentXError(
        "RUNTIME_UNAVAILABLE",
        error instanceof Error ? error.message : "control plane request failed",
      );
    }
    const value: unknown = await response.json().catch(() => ({}));
    if (!response.ok) throw brokerError(value, response.status);
    return value;
  }

  private assertWorkspace(workspaceId: string): void {
    if (workspaceId !== this.workspaceId) {
      throw agentXError("FORBIDDEN", "orchestrator request is outside the connected workspace");
    }
  }
}

export function completedTaskResult(
  operation: RemoteOperationStatus,
  events: RemoteEventPage["events"],
): { operationId: string; status: string; response?: string; error?: string } {
  const response = lastAssistantResponse(events);
  return {
    operationId: operation.id,
    status: operation.status,
    ...(response === undefined ? {} : { response }),
    ...(operation.error === undefined ? {} : { error: operation.error }),
  };
}

export function acceptedOperationId(value: unknown): string {
  const response = object(value);
  const operation = object(response.operation);
  const parsed = OperationSchema.parse(operation);
  return parsed.id;
}

function brokerError(value: unknown, status: number): Error {
  if (value && typeof value === "object" && "error" in value) {
    const candidate = (value as { error?: unknown }).error;
    if (candidate && typeof candidate === "object") {
      const error = candidate as Record<string, unknown>;
      const code = AgentXErrorCodeSchema.safeParse(error.code);
      if (code.success && typeof error.message === "string") return agentXError(code.data, error.message);
    }
  }
  return agentXError("RUNTIME_UNAVAILABLE", `control plane request failed with HTTP ${status}`);
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw agentXError("RUNTIME_UNAVAILABLE", "control plane returned invalid JSON");
  }
  return value as Record<string, unknown>;
}
