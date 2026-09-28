import { createHash, randomUUID } from "node:crypto";
import {
  AgentXNameSchema,
  WorkerInvocationSchema,
  agentXError,
  type WorkerInvocation,
  type WorkspaceInstance,
} from "@agentx/contracts";
import type { AuthenticatedIdentity } from "./auth.js";
import type { ProjectMembership } from "./authorization.js";
import { authorizeProjectAdministrator } from "./projects.js";
import type { InMemoryProjectRegistry } from "./projects.js";
import type { RepositoryGrantService } from "./repository-access.js";
import type { InMemoryRegistry } from "./registry.js";

export interface AllocatedRuntime {
  deploymentMode: "ec2-ebs";
}

export interface PreparationDispatch {
  operationId: string;
  requestId: string;
  workspace: WorkspaceInstance;
  invocation?: WorkerInvocation;
  alreadyReady: boolean;
}

export class PreparationCoordinator {
  private readonly accepted = new Map<string, { hash: string; dispatch: PreparationDispatch }>();

  constructor(
    private readonly dependencies: {
      projects: InMemoryProjectRegistry;
      registry: InMemoryRegistry;
      memberships: readonly ProjectMembership[];
      repositoryGrants: RepositoryGrantService;
      allocateRuntime: (input: { ownerKey: string; projectName: string }) => Promise<AllocatedRuntime>;
      createCallbackCapability: (input: { operationId: string; workspaceId: string; fence: number }) => string;
    },
  ) {}

  async prepare(
    identity: AuthenticatedIdentity,
    input: { requestId: string; projectName: string; projectRevision: number; targetOwnerKey: string },
  ): Promise<PreparationDispatch> {
    if (!/^[0-9a-f-]{36}$/i.test(input.requestId)) {
      throw agentXError("CONFIG_INVALID", "requestId must be a UUID");
    }
    AgentXNameSchema.parse(input.projectName);
    if (!Number.isInteger(input.projectRevision) || input.projectRevision < 1) {
      throw agentXError("CONFIG_INVALID", "projectRevision must be a positive integer");
    }
    if (!/^[a-f0-9]{64}$/.test(input.targetOwnerKey)) {
      throw agentXError("CONFIG_INVALID", "targetOwnerKey must be a broker-derived owner key");
    }
    authorizeProjectAdministrator(identity, input.projectName, this.dependencies.memberships);
    const registered = this.dependencies.projects.get(input.projectName, input.projectRevision);
    if (!registered) throw agentXError("NOT_FOUND", "registered project revision not found");

    const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const idempotencyKey = `${identity.ownerKey}\0${input.requestId}`;
    const previous = this.accepted.get(idempotencyKey);
    if (previous) {
      if (previous.hash !== hash) {
        throw agentXError("IDEMPOTENCY_CONFLICT", "requestId was used for another preparation request");
      }
      return structuredClone(previous.dispatch);
    }

    let workspace = await this.dependencies.registry.getDefault(input.targetOwnerKey, input.projectName);
    if (workspace && workspace.projectRevision !== input.projectRevision) {
      throw agentXError(
        "PROJECT_REVISION_MISMATCH",
        "existing workspace is pinned to another project revision; migration is explicit",
      );
    }
    if (workspace && workspace.deploymentMode !== "ec2-ebs") throw agentXError("RUNTIME_UNAVAILABLE", "retired workspace cannot prepare compute");
    if (workspace?.status === "READY") {
      const dispatch: PreparationDispatch = {
        operationId: randomUUID(),
        requestId: input.requestId,
        workspace,
        alreadyReady: true,
      };
      this.accepted.set(idempotencyKey, { hash, dispatch });
      return structuredClone(dispatch);
    }
    if (workspace?.status === "BUSY") throw agentXError("WORKSPACE_BUSY", "workspace has an active writer");

    if (!workspace) {
      const runtime = await this.dependencies.allocateRuntime({
        ownerKey: input.targetOwnerKey,
        projectName: input.projectName,
      });
      const now = new Date().toISOString();
      workspace = await this.dependencies.registry.createDefault({
        id: randomUUID(),
        ownerKey: input.targetOwnerKey,
        projectName: input.projectName,
        projectRevision: input.projectRevision,
        deploymentMode: runtime.deploymentMode,
        rootPath: "/mnt/workspace",
        status: "PREPARING",
        activeOperationId: null,
        fence: 1,
        createdAt: now,
        updatedAt: now,
      });
    } else if (workspace.status === "PREPARATION_FAILED") {
      workspace = await this.dependencies.registry.setPreparationStatus(workspace.id, "PREPARING");
    }

    const operationId = randomUUID();
    const repositoryGrant = this.dependencies.repositoryGrants.issue({
      ownerKey: input.targetOwnerKey,
      projectName: input.projectName,
      workspaceId: workspace.id,
      operationId,
      repositories: registered.definition.repositories.map((repository) => ({
        credentialRef: repository.credentialRef,
        repositoryUrl: repository.url,
        access: "clone",
      })),
    });
    const invocation = WorkerInvocationSchema.parse({
      protocolVersion: 1,
      operationId,
      workspaceId: workspace.id,
      fence: workspace.fence,
      projectRevision: input.projectRevision,
      callbackCapability: this.dependencies.createCallbackCapability({
        operationId,
        workspaceId: workspace.id,
        fence: workspace.fence,
      }),
      kind: "prepare",
      payload: { project: registered.definition, repositoryGrant },
    });
    const dispatch: PreparationDispatch = {
      operationId,
      requestId: input.requestId,
      workspace,
      invocation,
      alreadyReady: false,
    };
    this.accepted.set(idempotencyKey, { hash, dispatch });
    return structuredClone(dispatch);
  }

  async recordResult(input: {
    operationId: string;
    workspaceId: string;
    fence: number;
    succeeded: boolean;
    manifestPath?: string;
  }): Promise<WorkspaceInstance> {
    const accepted = [...this.accepted.values()].find(
      ({ dispatch }) => dispatch.operationId === input.operationId,
    );
    if (!accepted || accepted.dispatch.workspace.id !== input.workspaceId) {
      throw agentXError("NOT_FOUND", "preparation operation not found");
    }
    const workspace = await this.dependencies.registry.get(input.workspaceId);
    if (!workspace || workspace.fence !== input.fence) {
      throw agentXError("STALE_FENCE", "preparation callback no longer owns the workspace");
    }
    return this.dependencies.registry.setPreparationStatus(
      input.workspaceId,
      input.succeeded ? "READY" : "PREPARATION_FAILED",
      input.manifestPath,
    );
  }
}
