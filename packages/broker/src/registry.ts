import {
  agentXError,
  WorkspaceInstanceSchema,
  type WorkspaceInstance,
  type WorkspaceStatus,
} from "@agentx/contracts";

export class InMemoryRegistry {
  readonly workspaces = new Map<string, WorkspaceInstance>();
  readonly defaults = new Map<string, string>();

  async createDefault(input: WorkspaceInstance): Promise<WorkspaceInstance> {
    const validated = WorkspaceInstanceSchema.parse(input);
    const key = this.defaultKey(validated.ownerKey, validated.projectName);
    const existingId = this.defaults.get(key);
    if (existingId) return this.require(existingId);
    this.workspaces.set(validated.id, structuredClone(validated));
    this.defaults.set(key, validated.id);
    return structuredClone(validated);
  }

  async get(id: string): Promise<WorkspaceInstance | undefined> {
    const workspace = this.workspaces.get(id);
    return workspace ? structuredClone(workspace) : undefined;
  }

  async getDefault(ownerKey: string, projectName: string): Promise<WorkspaceInstance | undefined> {
    const id = this.defaults.get(this.defaultKey(ownerKey, projectName));
    return id ? this.get(id) : undefined;
  }

  async acquireWriter(id: string, ownerKey: string, operationId: string): Promise<WorkspaceInstance> {
    const workspace = this.require(id);
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
    this.workspaces.set(id, updated);
    return structuredClone(updated);
  }

  async releaseWriter(id: string, operationId: string): Promise<void> {
    const workspace = this.require(id);
    if (workspace.activeOperationId !== operationId) {
      throw agentXError("STALE_FENCE", "operation no longer owns workspace");
    }
    this.workspaces.set(id, {
      ...workspace,
      activeOperationId: null,
      status: "READY",
      updatedAt: new Date().toISOString(),
    });
  }

  async forceFence(id: string): Promise<void> {
    const workspace = this.require(id);
    this.workspaces.set(id, { ...workspace, fence: workspace.fence + 1, updatedAt: new Date().toISOString() });
  }

  async setPreparationStatus(
    id: string,
    status: Extract<WorkspaceStatus, "PREPARING" | "READY" | "PREPARATION_FAILED">,
    manifest?: string,
  ): Promise<WorkspaceInstance> {
    const workspace = this.require(id);
    if (!["PREPARING", "PREPARATION_FAILED"].includes(workspace.status) && status !== workspace.status) {
      throw agentXError("WORKSPACE_BUSY", `cannot change preparation state from ${workspace.status}`);
    }
    const updated: WorkspaceInstance = {
      ...workspace,
      status,
      ...(manifest === undefined ? {} : { preparationManifest: manifest }),
      updatedAt: new Date().toISOString(),
    };
    this.workspaces.set(id, updated);
    return structuredClone(updated);
  }

  async setLifecycleStatus(
    id: string,
    status: Extract<WorkspaceStatus, "STOPPED" | "RESUMING" | "READY" | "UNHEALTHY">,
  ): Promise<WorkspaceInstance> {
    const workspace = this.require(id);
    const allowed = new Set([
      "READY:STOPPED",
      "STOPPED:RESUMING",
      "RESUMING:READY",
      "RESUMING:UNHEALTHY",
    ]);
    if (!allowed.has(`${workspace.status}:${status}`)) {
      throw agentXError("WORKSPACE_BUSY", `invalid lifecycle transition ${workspace.status} -> ${status}`);
    }
    if (workspace.activeOperationId) throw agentXError("WORKSPACE_BUSY", "workspace has an active writer");
    const updated = { ...workspace, status, updatedAt: new Date().toISOString() };
    this.workspaces.set(id, updated);
    return structuredClone(updated);
  }

  private require(id: string): WorkspaceInstance {
    const workspace = this.workspaces.get(id);
    if (!workspace) throw agentXError("NOT_FOUND", "workspace not found");
    return workspace;
  }

  private defaultKey(ownerKey: string, projectName: string): string {
    return `${ownerKey}\0${projectName}`;
  }
}
