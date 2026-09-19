import { randomUUID } from "node:crypto";
import { agentXError } from "@agentx/contracts";
import type { AuthenticatedIdentity } from "./auth.js";
import { authorizeWorkspace } from "./authorization.js";
import type { InMemoryRegistry } from "./registry.js";

export interface StoredEvent {
  operationId: string;
  sequence: number;
  timestamp: string;
  type: string;
  payload: unknown;
}

export interface StoredArtifact {
  id: string;
  workspaceId: string;
  operationId: string;
  ownerKey: string;
  name: string;
  mediaType: string;
  objectKey: string;
  content: string;
}

export class OwnerScopedOutputStore {
  readonly events = new Map<string, StoredEvent[]>();
  readonly eventWorkspaces = new Map<string, string>();
  readonly artifacts = new Map<string, StoredArtifact>();

  constructor(private readonly registry: InMemoryRegistry) {}

  appendEvents(
    operationId: string,
    workspaceId: string,
    events: ReadonlyArray<Omit<StoredEvent, "operationId" | "sequence">>,
  ): StoredEvent[] {
    const existingWorkspace = this.eventWorkspaces.get(operationId);
    if (existingWorkspace && existingWorkspace !== workspaceId) {
      throw agentXError("FORBIDDEN", "event operation is bound to another workspace");
    }
    this.eventWorkspaces.set(operationId, workspaceId);
    const stored = this.events.get(operationId) ?? [];
    const added = events.map((event, index) => ({
      ...event,
      operationId,
      sequence: stored.length + index + 1,
    }));
    stored.push(...added);
    this.events.set(operationId, stored);
    return structuredClone(added);
  }

  async pageEvents(
    identity: AuthenticatedIdentity,
    workspaceId: string,
    operationId: string,
    input: { cursor?: string; limit?: number } = {},
  ): Promise<{ events: StoredEvent[]; cursor?: string }> {
    await this.authorize(identity, workspaceId);
    if (this.eventWorkspaces.get(operationId) !== workspaceId) {
      throw agentXError("NOT_FOUND", "operation events not found");
    }
    const limit = input.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw agentXError("CONFIG_INVALID", "event page limit must be from 1 through 500");
    }
    const offset = decodeCursor(input.cursor);
    const all = this.events.get(operationId) ?? [];
    const events = all.slice(offset, offset + limit);
    const next = offset + events.length;
    return {
      events: structuredClone(events),
      ...(next < all.length ? { cursor: Buffer.from(String(next)).toString("base64url") } : {}),
    };
  }

  async putArtifact(input: {
    ownerKey: string;
    workspaceId: string;
    operationId: string;
    name: string;
    mediaType: string;
    content: string;
  }): Promise<StoredArtifact> {
    const workspace = await this.registry.get(input.workspaceId);
    if (!workspace || workspace.ownerKey !== input.ownerKey) {
      throw agentXError("FORBIDDEN", "artifact scope does not match workspace owner");
    }
    const id = randomUUID();
    const artifact: StoredArtifact = {
      id,
      ...input,
      objectKey: `private/${input.ownerKey}/${input.workspaceId}/${input.operationId}/${id}`,
    };
    this.artifacts.set(id, artifact);
    return structuredClone(artifact);
  }

  async getArtifact(identity: AuthenticatedIdentity, workspaceId: string, artifactId: string): Promise<StoredArtifact> {
    await this.authorize(identity, workspaceId);
    const artifact = this.artifacts.get(artifactId);
    if (!artifact || artifact.workspaceId !== workspaceId || artifact.ownerKey !== identity.ownerKey) {
      throw agentXError("NOT_FOUND", "artifact not found");
    }
    return structuredClone(artifact);
  }

  private async authorize(identity: AuthenticatedIdentity, workspaceId: string): Promise<void> {
    const workspace = await this.registry.get(workspaceId);
    if (!workspace) throw agentXError("NOT_FOUND", "workspace not found");
    authorizeWorkspace(identity, workspace);
  }
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const parsed = Number.parseInt(Buffer.from(cursor, "base64url").toString("utf8"), 10);
  if (!Number.isInteger(parsed) || parsed < 0) throw agentXError("CONFIG_INVALID", "invalid event cursor");
  return parsed;
}
