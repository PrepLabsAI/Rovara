import { randomUUID } from "node:crypto";
import {
  ProjectDefinitionSchema,
  WorkspaceInstanceSchema,
  agentXError,
  type ProjectDefinition,
  type WorkspaceInstance,
  type WorkspaceStatus,
} from "@agentx/contracts";
import { authorizeProjectAdministrator, type AuthenticatedIdentity, type ProjectMembership } from "@agentx/broker";
import { inTransaction, type HostDatabase } from "./database.js";

export interface RegisteredProject {
  definition: ProjectDefinition;
  registeredBy: string;
  registeredAt: string;
}

/**
 * Durable replacement for `InMemoryRegistry` and `InMemoryProjectRegistry`.
 *
 * The method surface matches the in-memory stores so the same broker helpers keep
 * working, but nothing canonical lives in a process `Map`: project registrations,
 * workspace ownership, the writer lease and conversations all survive a restart.
 */
export class SqliteRegistry {
  constructor(private readonly database: HostDatabase) {}

  // -- projects ---------------------------------------------------------

  /**
   * Register one immutable project revision.
   *
   * A revision is frozen once written: re-registering identical bytes is a duplicate,
   * anything else is a mismatch. This is the same rule the in-memory registry applies,
   * moved somewhere a restart cannot forget it.
   */
  registerProject(
    identity: AuthenticatedIdentity,
    untrustedDefinition: ProjectDefinition,
    memberships: readonly ProjectMembership[],
  ): { project: RegisteredProject; duplicate: boolean } {
    const definition = ProjectDefinitionSchema.parse(untrustedDefinition);
    authorizeProjectAdministrator(identity, definition.name, memberships);
    assertDefinitionContainsReferencesOnly(definition);
    const document = JSON.stringify(definition);
    return inTransaction(this.database, () => {
      const existing = this.database
        .prepare("SELECT document, registered_by, registered_at FROM projects WHERE name = ? AND revision = ?")
        .get(definition.name, definition.revision) as
        | { document: string; registered_by: string; registered_at: string }
        | undefined;
      if (existing) {
        if (existing.document !== document) {
          throw agentXError("PROJECT_REVISION_MISMATCH", "a project revision is immutable after registration");
        }
        return { project: readProject(existing), duplicate: true };
      }
      const registeredAt = new Date().toISOString();
      this.database
        .prepare("INSERT INTO projects (name, revision, document, registered_by, registered_at) VALUES (?, ?, ?, ?, ?)")
        .run(definition.name, definition.revision, document, identity.ownerKey, registeredAt);
      return {
        project: { definition, registeredBy: identity.ownerKey, registeredAt },
        duplicate: false,
      };
    });
  }

  getProject(name: string, revision: number): RegisteredProject | undefined {
    const row = this.database
      .prepare("SELECT document, registered_by, registered_at FROM projects WHERE name = ? AND revision = ?")
      .get(name, revision) as { document: string; registered_by: string; registered_at: string } | undefined;
    return row ? readProject(row) : undefined;
  }

  // -- workspaces -------------------------------------------------------

  async createDefault(input: WorkspaceInstance): Promise<WorkspaceInstance> {
    const validated = WorkspaceInstanceSchema.parse(input);
    return inTransaction(this.database, () => {
      const existing = this.database
        .prepare("SELECT workspace_id FROM workspace_defaults WHERE owner_key = ? AND project_name = ?")
        .get(validated.ownerKey, validated.projectName) as { workspace_id: string } | undefined;
      if (existing) return this.requireSync(existing.workspace_id);
      this.writeWorkspace(validated);
      this.database
        .prepare("INSERT INTO workspace_defaults (owner_key, project_name, workspace_id) VALUES (?, ?, ?)")
        .run(validated.ownerKey, validated.projectName, validated.id);
      return validated;
    });
  }

  async get(id: string): Promise<WorkspaceInstance | undefined> {
    const row = this.database.prepare("SELECT document FROM workspaces WHERE id = ?").get(id) as
      | { document: string }
      | undefined;
    return row ? WorkspaceInstanceSchema.parse(JSON.parse(row.document)) : undefined;
  }

  async getDefault(ownerKey: string, projectName: string): Promise<WorkspaceInstance | undefined> {
    const row = this.database
      .prepare("SELECT workspace_id FROM workspace_defaults WHERE owner_key = ? AND project_name = ?")
      .get(ownerKey, projectName) as { workspace_id: string } | undefined;
    return row ? this.get(row.workspace_id) : undefined;
  }

  /**
   * Take the single writer lease, conditioned on the exact fence we observed.
   *
   * The condition is in the `UPDATE`, so two callers racing for one workspace cannot
   * both believe they won: the loser changes no rows and is told the workspace is busy.
   */
  async acquireWriter(id: string, ownerKey: string, operationId: string): Promise<WorkspaceInstance> {
    return inTransaction(this.database, () => this.acquireWriterLocked(id, ownerKey, operationId));
  }

  /** `acquireWriter` for a caller that already holds the transaction. */
  acquireWriterLocked(id: string, ownerKey: string, operationId: string): WorkspaceInstance {
    const workspace = this.requireSync(id);
    if (workspace.ownerKey !== ownerKey) throw agentXError("NOT_FOUND", "workspace not found");
    if (workspace.status !== "READY") {
      if (workspace.status === "BUSY" || workspace.activeOperationId) {
        throw agentXError("WORKSPACE_BUSY", "workspace already has an active writer");
      }
      throw agentXError("WORKSPACE_NOT_READY", `workspace is ${workspace.status}`);
    }
    const updated: WorkspaceInstance = {
      ...workspace,
      activeOperationId: operationId,
      fence: workspace.fence + 1,
      status: "BUSY",
      updatedAt: new Date().toISOString(),
    };
    const changes = this.database
      .prepare(
        `UPDATE workspaces SET document = ?, status = ?, fence = ?, active_operation_id = ?, updated_at = ?
         WHERE id = ? AND owner_key = ? AND fence = ? AND active_operation_id IS NULL AND status = 'READY'`,
      )
      .run(
        JSON.stringify(updated), updated.status, updated.fence, operationId, updated.updatedAt,
        id, ownerKey, workspace.fence,
      );
    if (changes.changes !== 1) throw agentXError("WORKSPACE_BUSY", "workspace already has an active writer");
    return updated;
  }

  async releaseWriter(id: string, operationId: string): Promise<void> {
    inTransaction(this.database, () => {
      const workspace = this.requireSync(id);
      if (workspace.activeOperationId !== operationId) {
        throw agentXError("STALE_FENCE", "operation no longer owns workspace");
      }
      this.writeWorkspace({
        ...workspace,
        activeOperationId: null,
        status: "READY",
        updatedAt: new Date().toISOString(),
      });
    });
  }

  /**
   * Release the writer lease only if this operation still holds it.
   *
   * A late terminal callback from a superseded attempt must not free a lease that a
   * newer attempt has since taken, so a mismatch is simply left alone rather than
   * treated as an error.
   */
  async releaseWriterIfHeld(workspaceId: string, operationId: string): Promise<void> {
    inTransaction(this.database, () => {
      const workspace = this.requireSync(workspaceId);
      if (workspace.activeOperationId !== operationId) return;
      this.writeWorkspace({
        ...workspace,
        activeOperationId: null,
        status: "READY",
        updatedAt: new Date().toISOString(),
      });
    });
  }

  async forceFence(id: string): Promise<void> {
    inTransaction(this.database, () => {
      const workspace = this.requireSync(id);
      this.writeWorkspace({ ...workspace, fence: workspace.fence + 1, updatedAt: new Date().toISOString() });
    });
  }

  async setPreparationStatus(
    id: string,
    status: Extract<WorkspaceStatus, "PREPARING" | "READY" | "PREPARATION_FAILED">,
    manifest?: string,
  ): Promise<WorkspaceInstance> {
    return inTransaction(this.database, () => {
      const workspace = this.requireSync(id);
      if (!["PREPARING", "PREPARATION_FAILED"].includes(workspace.status) && status !== workspace.status) {
        throw agentXError("WORKSPACE_BUSY", `cannot change preparation state from ${workspace.status}`);
      }
      const updated: WorkspaceInstance = {
        ...workspace,
        status,
        ...(manifest === undefined ? {} : { preparationManifest: manifest }),
        updatedAt: new Date().toISOString(),
      };
      this.writeWorkspace(updated);
      return updated;
    });
  }

  /** Record the candidate binding a governed task established for this workspace. */
  async setCandidateTaskOperation(id: string, operationId: string): Promise<void> {
    inTransaction(this.database, () => {
      const workspace = this.requireSync(id);
      this.writeWorkspace({
        ...workspace,
        candidateTaskOperationId: operationId,
        updatedAt: new Date().toISOString(),
      });
    });
  }

  /** Every workspace this host knows about, for restart reconciliation. */
  listWorkspaceIds(): string[] {
    return (this.database.prepare("SELECT id FROM workspaces ORDER BY id").all() as Array<{ id: string }>)
      .map((row) => row.id);
  }

  // -- conversations ----------------------------------------------------

  createConversation(workspaceId: string, conversationId = randomUUID()): string {
    return inTransaction(this.database, () => {
      this.requireSync(workspaceId);
      const existing = this.database
        .prepare("SELECT id FROM conversations WHERE workspace_id = ? AND id = ?")
        .get(workspaceId, conversationId);
      if (existing) throw agentXError("IDEMPOTENCY_CONFLICT", "conversation already exists");
      this.database
        .prepare("INSERT INTO conversations (workspace_id, id, created_at) VALUES (?, ?, ?)")
        .run(workspaceId, conversationId, new Date().toISOString());
      return conversationId;
    });
  }

  hasConversation(workspaceId: string, conversationId: string): boolean {
    return (
      this.database
        .prepare("SELECT id FROM conversations WHERE workspace_id = ? AND id = ?")
        .get(workspaceId, conversationId) !== undefined
    );
  }

  listConversations(workspaceId: string): string[] {
    return (
      this.database
        .prepare("SELECT id FROM conversations WHERE workspace_id = ? ORDER BY created_at, id")
        .all(workspaceId) as Array<{ id: string }>
    ).map((row) => row.id);
  }

  // -- internals --------------------------------------------------------

  private requireSync(id: string): WorkspaceInstance {
    const row = this.database.prepare("SELECT document FROM workspaces WHERE id = ?").get(id) as
      | { document: string }
      | undefined;
    if (!row) throw agentXError("NOT_FOUND", "workspace not found");
    return WorkspaceInstanceSchema.parse(JSON.parse(row.document));
  }

  private writeWorkspace(workspace: WorkspaceInstance): void {
    this.database
      .prepare(
        `INSERT INTO workspaces (id, owner_key, project_name, project_revision, status, fence,
                                 active_operation_id, document, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, fence = excluded.fence,
           active_operation_id = excluded.active_operation_id, document = excluded.document,
           updated_at = excluded.updated_at`,
      )
      .run(
        workspace.id, workspace.ownerKey, workspace.projectName, workspace.projectRevision,
        workspace.status, workspace.fence, workspace.activeOperationId, JSON.stringify(workspace),
        workspace.updatedAt,
      );
  }
}

function readProject(row: { document: string; registered_by: string; registered_at: string }): RegisteredProject {
  return {
    definition: ProjectDefinitionSchema.parse(JSON.parse(row.document)),
    registeredBy: row.registered_by,
    registeredAt: row.registered_at,
  };
}

function assertDefinitionContainsReferencesOnly(definition: ProjectDefinition): void {
  for (const repository of definition.repositories) {
    const url = new URL(repository.url);
    if (url.username || url.password) {
      throw agentXError("CONFIG_INVALID", "repository URLs cannot contain embedded credentials");
    }
    if (/secret|password|token/i.test(repository.credentialRef)) {
      throw agentXError(
        "CONFIG_INVALID",
        "credentialRef must be an opaque reference name, not a secret-bearing field",
      );
    }
  }
}
