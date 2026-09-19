import { createHash, randomUUID } from "node:crypto";
import {
  agentXError,
  OperationRequestSchema,
  TERMINAL_OPERATION_STATUSES,
  type Operation,
  type OperationRequest,
  type OperationStatus,
} from "@agentx/contracts";
import type { InMemoryRegistry } from "./registry.js";

export interface OutboxRecord {
  id: string;
  operationId: string;
  workspaceId: string;
  fence: number;
  payload: OperationRequest;
  deliveredAt?: string;
  attempts: number;
}

export interface OperationEvent {
  sequence: number;
  type: string;
  payload: unknown;
}

export class OperationStore {
  readonly operations = new Map<string, Operation>();
  readonly idempotency = new Map<string, string>();
  readonly outbox = new Map<string, OutboxRecord>();
  readonly events = new Map<string, OperationEvent[]>();

  constructor(readonly registry: InMemoryRegistry) {}

  async acceptTask(
    workspaceId: string,
    ownerKey: string,
    untrustedRequest: OperationRequest,
  ): Promise<{ operation: Operation; duplicate: boolean }> {
    const request = OperationRequestSchema.parse(untrustedRequest);
    const hash = payloadHash(request);
    const key = `${ownerKey}\0${workspaceId}\0${request.requestId}`;
    const existingId = this.idempotency.get(key);
    if (existingId) {
      const existing = this.require(existingId);
      if (existing.payloadHash !== hash) {
        throw agentXError("IDEMPOTENCY_CONFLICT", "request ID was already used for a different payload");
      }
      return { operation: structuredClone(existing), duplicate: true };
    }

    const id = randomUUID();
    const workspace = await this.registry.acquireWriter(workspaceId, ownerKey, id);
    const now = new Date().toISOString();
    const operation: Operation = {
      id,
      workspaceId,
      conversationId: request.conversationId,
      kind: "task",
      requestId: request.requestId,
      payloadHash: hash,
      status: "ACCEPTED",
      fence: workspace.fence,
      createdAt: now,
      updatedAt: now,
    };
    const outbox: OutboxRecord = {
      id: randomUUID(),
      operationId: id,
      workspaceId,
      fence: workspace.fence,
      payload: request,
      attempts: 0,
    };

    this.operations.set(id, operation);
    this.idempotency.set(key, id);
    this.outbox.set(outbox.id, outbox);
    return { operation: structuredClone(operation), duplicate: false };
  }

  pendingOutbox(): OutboxRecord[] {
    return [...this.outbox.values()].filter((item) => !item.deliveredAt).map((item) => structuredClone(item));
  }

  recordOutboxAttempt(id: string): void {
    const record = this.outbox.get(id);
    if (!record) throw agentXError("NOT_FOUND", "outbox record not found");
    record.attempts += 1;
  }

  markOutboxDelivered(id: string): void {
    const record = this.outbox.get(id);
    if (!record) throw agentXError("NOT_FOUND", "outbox record not found");
    record.deliveredAt = new Date().toISOString();
  }

  get(id: string): Operation | undefined {
    const operation = this.operations.get(id);
    return operation ? structuredClone(operation) : undefined;
  }

  transition(id: string, status: OperationStatus, details?: { result?: unknown; error?: string }): Operation {
    const operation = this.require(id);
    if (TERMINAL_OPERATION_STATUSES.has(operation.status as never)) {
      throw agentXError("IDEMPOTENCY_CONFLICT", "terminal operation results are immutable");
    }
    const updated: Operation = {
      ...operation,
      status,
      updatedAt: new Date().toISOString(),
      ...(details?.result === undefined ? {} : { result: details.result }),
      ...(details?.error === undefined ? {} : { error: details.error }),
    };
    this.operations.set(id, updated);
    return structuredClone(updated);
  }

  appendEvent(operationId: string, event: Omit<OperationEvent, "sequence">): OperationEvent {
    this.require(operationId);
    const events = this.events.get(operationId) ?? [];
    const stored = { ...event, sequence: events.length + 1 };
    events.push(stored);
    this.events.set(operationId, events);
    return structuredClone(stored);
  }

  private require(id: string): Operation {
    const operation = this.operations.get(id);
    if (!operation) throw agentXError("NOT_FOUND", "operation not found");
    return operation;
  }
}

function payloadHash(request: OperationRequest): string {
  return createHash("sha256")
    .update(JSON.stringify({ conversationId: request.conversationId, prompt: request.prompt }))
    .digest("hex");
}
