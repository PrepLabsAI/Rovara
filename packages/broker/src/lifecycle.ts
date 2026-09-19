import { agentXError, type WorkspaceInstance } from "@agentx/contracts";
import type { AuthenticatedIdentity } from "./auth.js";
import { type ProjectMembership } from "./authorization.js";
import { authorizeProjectAdministrator } from "./projects.js";
import type { InMemoryRegistry } from "./registry.js";

export class LifecycleService {
  constructor(
    private readonly dependencies: {
      registry: InMemoryRegistry;
      memberships: readonly ProjectMembership[];
      stopRuntimeSession: (input: { runtimeArn: string; runtimeSessionId: string }) => Promise<void>;
    },
  ) {}

  async stop(identity: AuthenticatedIdentity, workspaceId: string): Promise<WorkspaceInstance> {
    const workspace = await this.dependencies.registry.get(workspaceId);
    if (!workspace) throw agentXError("NOT_FOUND", "workspace not found");
    authorizeProjectAdministrator(identity, workspace.projectName, this.dependencies.memberships);
    if (workspace.status !== "READY" || workspace.activeOperationId) {
      throw agentXError("WORKSPACE_BUSY", "cancel or finish active work before stopping compute");
    }
    await this.dependencies.stopRuntimeSession({
      runtimeArn: workspace.runtimeArn,
      runtimeSessionId: workspace.runtimeSessionId,
    });
    return this.dependencies.registry.setLifecycleStatus(workspace.id, "STOPPED");
  }
}
