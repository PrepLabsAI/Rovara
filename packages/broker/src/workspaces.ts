import {
  agentXError,
  type StoredDeploymentMode,
  type WorkspaceStatus,
} from "@agentx/contracts";
import type { AuthenticatedIdentity } from "./auth.js";
import { authorizeProject, authorizeWorkspace, type ProjectMembership } from "./authorization.js";
import type { InMemoryProjectRegistry } from "./projects.js";
import type { InMemoryRegistry } from "./registry.js";

export interface PublicWorkspace {
  id: string;
  projectName: string;
  projectRevision: number;
  deploymentMode: StoredDeploymentMode;
  status: WorkspaceStatus;
  createdAt: string;
  updatedAt: string;
}

export class WorkspaceResolver {
  constructor(
    private readonly dependencies: {
      projects: InMemoryProjectRegistry;
      registry: InMemoryRegistry;
      memberships: readonly ProjectMembership[];
    },
  ) {}

  async resolveDefault(
    identity: AuthenticatedIdentity,
    projectName: string,
    projectRevision: number,
  ): Promise<PublicWorkspace> {
    authorizeProject(identity, projectName, this.dependencies.memberships);
    const project = this.dependencies.projects.get(projectName, projectRevision);
    if (!project) {
      throw agentXError("PROJECT_REVISION_MISMATCH", "local project revision is not registered");
    }
    const workspace = await this.dependencies.registry.getDefault(identity.ownerKey, projectName);
    if (!workspace) {
      throw agentXError("WORKSPACE_NOT_READY", "workspace has not been prepared by an administrator");
    }
    authorizeWorkspace(identity, workspace);
    if (workspace.projectRevision !== projectRevision) {
      throw agentXError(
        "PROJECT_REVISION_MISMATCH",
        "workspace is pinned to a different registered project revision",
      );
    }
    return publicWorkspace(workspace);
  }

  async getById(identity: AuthenticatedIdentity, workspaceId: string): Promise<PublicWorkspace> {
    const workspace = await this.dependencies.registry.get(workspaceId);
    if (!workspace) throw agentXError("NOT_FOUND", "workspace not found");
    authorizeWorkspace(identity, workspace);
    authorizeProject(identity, workspace.projectName, this.dependencies.memberships);
    return publicWorkspace(workspace);
  }
}

export function publicWorkspace(workspace: {
  id: string;
  projectName: string;
  projectRevision: number;
  deploymentMode: StoredDeploymentMode;
  status: WorkspaceStatus;
  createdAt: string;
  updatedAt: string;
}): PublicWorkspace {
  return {
    id: workspace.id,
    projectName: workspace.projectName,
    projectRevision: workspace.projectRevision,
    deploymentMode: workspace.deploymentMode,
    status: workspace.status,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  };
}
