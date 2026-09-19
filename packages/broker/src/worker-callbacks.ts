import { agentXError } from "@agentx/contracts";
import type { CallbackCapabilities } from "./callbacks.js";
import type { OwnerScopedOutputStore } from "./events.js";
import type { OperationStore } from "./operations.js";
import type { InMemoryRegistry } from "./registry.js";

export class WorkerCallbackService {
  constructor(
    private readonly dependencies: {
      capabilities: CallbackCapabilities;
      registry: InMemoryRegistry;
      operations: OperationStore;
      outputs: OwnerScopedOutputStore;
    },
  ) {}

  async appendEvents(
    token: string,
    workspaceId: string,
    operationId: string,
    value: unknown,
  ): Promise<{ accepted: number }> {
    await this.authorize(token, "events", workspaceId, operationId);
    if (!value || typeof value !== "object" || !("events" in value) || !Array.isArray(value.events)) {
      throw agentXError("CONFIG_INVALID", "callback events must be an array");
    }
    if (value.events.length < 1 || value.events.length > 500) {
      throw agentXError("CONFIG_INVALID", "callback event batch must contain 1 through 500 events");
    }
    const events = value.events.map((event) => {
      if (!event || typeof event !== "object") throw agentXError("CONFIG_INVALID", "invalid event");
      const record = event as Record<string, unknown>;
      if (typeof record.type !== "string" || typeof record.timestamp !== "string") {
        throw agentXError("CONFIG_INVALID", "event type and timestamp are required");
      }
      return { type: record.type, timestamp: record.timestamp, payload: record.payload };
    });
    this.dependencies.outputs.appendEvents(operationId, workspaceId, events);
    return { accepted: events.length };
  }

  async putArtifact(
    token: string,
    workspaceId: string,
    operationId: string,
    value: unknown,
  ): Promise<{ artifactId: string }> {
    const workspace = await this.authorize(token, "artifacts", workspaceId, operationId);
    if (!value || typeof value !== "object") throw agentXError("CONFIG_INVALID", "invalid artifact");
    const artifact = value as Record<string, unknown>;
    if (
      typeof artifact.name !== "string" ||
      typeof artifact.mediaType !== "string" ||
      typeof artifact.content !== "string"
    ) {
      throw agentXError("CONFIG_INVALID", "artifact name, media type and content are required");
    }
    const stored = await this.dependencies.outputs.putArtifact({
      ownerKey: workspace.ownerKey,
      workspaceId,
      operationId,
      name: artifact.name,
      mediaType: artifact.mediaType,
      content: artifact.content,
    });
    return { artifactId: stored.id };
  }

  private async authorize(
    token: string,
    action: "events" | "artifacts",
    workspaceId: string,
    operationId: string,
  ) {
    const capability = this.dependencies.capabilities.verify(token, action);
    if (capability.workspaceId !== workspaceId || capability.operationId !== operationId) {
      throw agentXError("CALLBACK_FORBIDDEN", "callback route is outside the capability scope");
    }
    const workspace = await this.dependencies.registry.get(workspaceId);
    if (
      !workspace ||
      workspace.activeOperationId !== operationId ||
      workspace.fence !== capability.fence ||
      !this.dependencies.operations.get(operationId)
    ) {
      throw agentXError("STALE_FENCE", "callback no longer owns the workspace");
    }
    return workspace;
  }
}
