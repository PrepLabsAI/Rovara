import { randomUUID } from "node:crypto";
import { agentXError } from "@agentx/contracts";
import type { AuthenticatedIdentity } from "./auth.js";
import { authorizeWorkspace } from "./authorization.js";
import type { InMemoryRegistry } from "./registry.js";

export interface ConversationRecord {
  id: string;
  workspaceId: string;
  createdAt: string;
  updatedAt: string;
}

export class ConversationRegistry {
  private readonly conversations = new Map<string, ConversationRecord>();

  constructor(private readonly workspaces: InMemoryRegistry) {}

  async create(identity: AuthenticatedIdentity, workspaceId: string): Promise<ConversationRecord> {
    const workspace = await this.workspaces.get(workspaceId);
    if (!workspace) throw agentXError("NOT_FOUND", "workspace not found");
    authorizeWorkspace(identity, workspace);
    const now = new Date().toISOString();
    const conversation = { id: randomUUID(), workspaceId, createdAt: now, updatedAt: now };
    this.conversations.set(conversation.id, conversation);
    return structuredClone(conversation);
  }

  async get(identity: AuthenticatedIdentity, workspaceId: string, conversationId: string): Promise<ConversationRecord> {
    const workspace = await this.workspaces.get(workspaceId);
    if (!workspace) throw agentXError("NOT_FOUND", "workspace not found");
    authorizeWorkspace(identity, workspace);
    const conversation = this.conversations.get(conversationId);
    if (!conversation || conversation.workspaceId !== workspaceId) {
      throw agentXError("NOT_FOUND", "conversation not found");
    }
    return structuredClone(conversation);
  }
}
