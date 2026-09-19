import { OperationRequestSchema, agentXError, type OperationRequest } from "@agentx/contracts";
import type { AuthenticatedIdentity } from "./auth.js";
import { assertNoUntrustedRoutingFields, authorizeProject, authorizeWorkspace, type ProjectMembership } from "./authorization.js";
import type { OperationStore } from "./operations.js";
import type { InMemoryRegistry } from "./registry.js";

export class TaskService {
  constructor(
    private readonly dependencies: {
      registry: InMemoryRegistry;
      operations: OperationStore;
      memberships: readonly ProjectMembership[];
    },
  ) {}

  async accept(identity: AuthenticatedIdentity, workspaceId: string, body: OperationRequest) {
    assertNoUntrustedRoutingFields(body);
    const request = OperationRequestSchema.parse(body);
    const workspace = await this.dependencies.registry.get(workspaceId);
    if (!workspace) throw agentXError("NOT_FOUND", "workspace not found");
    authorizeWorkspace(identity, workspace);
    authorizeProject(identity, workspace.projectName, this.dependencies.memberships);
    return this.dependencies.operations.acceptTask(workspace.id, identity.ownerKey, request);
  }
}
