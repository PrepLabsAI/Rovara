import { createHmac, timingSafeEqual } from "node:crypto";
import { agentXError } from "@agentx/contracts";
import type { OperationStore } from "./operations.js";
import type { InMemoryRegistry } from "./registry.js";

export type CallbackAction = "events" | "artifacts" | "heartbeat" | "result";

interface CallbackCapability {
  workspaceId: string;
  operationId: string;
  fence: number;
  actions: CallbackAction[];
  expiresAt: number;
}

export class CallbackCapabilities {
  constructor(readonly secret: Buffer) {
    if (secret.byteLength < 32) throw new Error("callback capability secret must be at least 32 bytes");
  }

  issue(input: Omit<CallbackCapability, "expiresAt"> & { expiresInSeconds: number }): string {
    const capability: CallbackCapability = {
      workspaceId: input.workspaceId,
      operationId: input.operationId,
      fence: input.fence,
      actions: [...new Set(input.actions)].sort(),
      expiresAt: Math.floor(Date.now() / 1_000) + input.expiresInSeconds,
    };
    const body = Buffer.from(JSON.stringify(capability)).toString("base64url");
    const signature = createHmac("sha256", this.secret).update(body).digest("base64url");
    return `${body}.${signature}`;
  }

  verify(token: string, action: CallbackAction): CallbackCapability {
    const [body, signature, extra] = token.split(".");
    if (!body || !signature || extra) throw agentXError("CALLBACK_FORBIDDEN", "invalid capability");
    const expected = createHmac("sha256", this.secret).update(body).digest();
    const received = Buffer.from(signature, "base64url");
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      throw agentXError("CALLBACK_FORBIDDEN", "invalid capability signature");
    }
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as CallbackCapability;
    if (parsed.expiresAt <= Math.floor(Date.now() / 1_000) || !parsed.actions.includes(action)) {
      throw agentXError("CALLBACK_FORBIDDEN", `capability does not allow ${action}`);
    }
    return parsed;
  }
}

export class CallbackReceiver {
  constructor(
    readonly registry: InMemoryRegistry,
    readonly operations: OperationStore,
    readonly capabilities: CallbackCapabilities,
  ) {}

  async recordEvent(token: string, event: { type: string; payload: unknown }): Promise<void> {
    const capability = await this.authorize(token, "events");
    this.operations.appendEvent(capability.operationId, event);
  }

  async recordArtifact(token: string, artifact: { name: string }): Promise<{ name: string }> {
    await this.authorize(token, "artifacts");
    return artifact;
  }

  private async authorize(token: string, action: CallbackAction): Promise<CallbackCapability> {
    const capability = this.capabilities.verify(token, action);
    const workspace = await this.registry.get(capability.workspaceId);
    if (!workspace || workspace.activeOperationId !== capability.operationId || workspace.fence !== capability.fence) {
      throw agentXError("STALE_FENCE", "callback no longer owns the workspace");
    }
    return capability;
  }
}
