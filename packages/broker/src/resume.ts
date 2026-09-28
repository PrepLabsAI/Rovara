import { agentXError, type WorkspaceInstance } from "@agentx/contracts";
import type { AuthenticatedIdentity } from "./auth.js";
import { authorizeWorkspace } from "./authorization.js";
import type { InMemoryProjectRegistry } from "./projects.js";
import type { InMemoryRegistry } from "./registry.js";

export class ResumeCoordinator {
  constructor(
    private readonly dependencies: { registry: InMemoryRegistry; projects: InMemoryProjectRegistry },
  ) {}

  async begin(identity: AuthenticatedIdentity, workspaceId: string): Promise<WorkspaceInstance> {
    const workspace = await this.dependencies.registry.get(workspaceId);
    if (!workspace) throw agentXError("NOT_FOUND", "workspace not found");
    authorizeWorkspace(identity, workspace);
    if (workspace.deploymentMode !== "ec2-ebs") throw agentXError("RUNTIME_UNAVAILABLE", "retired workspace cannot resume compute");
    if (workspace.status !== "STOPPED") throw agentXError("WORKSPACE_BUSY", `workspace is ${workspace.status}`);
    const project = this.dependencies.projects.get(workspace.projectName, workspace.projectRevision);
    if (!project) {
      throw agentXError("PROJECT_REVISION_MISMATCH", "workspace's registered project revision no longer exists");
    }
    return this.dependencies.registry.setLifecycleStatus(workspace.id, "RESUMING");
  }
}
