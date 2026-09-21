import {
  AgentXError,
  OperationRequestSchema,
  ProjectDefinitionSchema,
  agentXError,
} from "@agentx/contracts";
import type { JwtAuthenticator } from "./auth.js";
import {
  assertNoUntrustedRoutingFields,
  authorizeProject,
  authorizeWorkspace,
  type ProjectMembership,
} from "./authorization.js";
import type { OperationStore } from "./operations.js";
import type { LifecycleService } from "./lifecycle.js";
import type { PreparationCoordinator } from "./prepare.js";
import type { InMemoryProjectRegistry } from "./projects.js";
import type { InMemoryRegistry } from "./registry.js";
import { parseRequestLookupPath, requestLookupFailure } from "./request-lookup.js";
import { publicWorkspace, WorkspaceResolver } from "./workspaces.js";
import type { WorkerCallbackService } from "./worker-callbacks.js";

export interface BrokerRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body?: string;
  requestId?: string;
}

export interface BrokerResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export function createBrokerHandler(dependencies: {
  authenticator: JwtAuthenticator;
  memberships: readonly ProjectMembership[];
  registry: InMemoryRegistry;
  operations: OperationStore;
  projects?: InMemoryProjectRegistry;
  preparation?: PreparationCoordinator;
  workerCallbacks?: WorkerCallbackService;
  lifecycle?: LifecycleService;
}) {
  return async (request: BrokerRequest): Promise<BrokerResponse> => {
    const requestId = request.requestId ?? crypto.randomUUID();
    try {
      const requestUrl = new URL(request.path, "https://agentx.invalid");
      const requestPath = requestUrl.pathname;
      const callbackMatch = /^\/v1\/internal\/workspaces\/([0-9a-f-]+)\/operations\/([0-9a-f-]+)\/(events|artifacts)$/.exec(
        requestPath,
      );
      if (request.method === "POST" && callbackMatch?.[1] && callbackMatch[2] && callbackMatch[3]) {
        if (!dependencies.workerCallbacks) throw agentXError("NOT_FOUND", "route not configured");
        const capability = request.headers["x-agentx-callback-capability"];
        if (!capability) throw agentXError("CALLBACK_FORBIDDEN", "callback capability is required");
        const body = parseBody(request.body);
        const result = callbackMatch[3] === "events"
          ? await dependencies.workerCallbacks.appendEvents(capability, callbackMatch[1], callbackMatch[2], body)
          : await dependencies.workerCallbacks.putArtifact(capability, callbackMatch[1], callbackMatch[2], body);
        return json(200, result, requestId);
      }
      const token = bearerToken(request.headers.authorization);
      const identity = await dependencies.authenticator.authenticate(token);
      const body = parseBody(request.body);
      assertNoUntrustedRoutingFields(body);

      if (request.method === "POST" && requestPath === "/v1/admin/projects") {
        if (!dependencies.projects) throw agentXError("NOT_FOUND", "route not configured");
        const definition = ProjectDefinitionSchema.parse(body);
        const registered = dependencies.projects.register(identity, definition, dependencies.memberships);
        return json(registered.duplicate ? 200 : 201, registered, requestId);
      }

      if (request.method === "POST" && requestPath === "/v1/admin/workspaces/prepare") {
        if (!dependencies.preparation) throw agentXError("NOT_FOUND", "route not configured");
        const prepared = await dependencies.preparation.prepare(identity, preparationRequest(body));
        return json(prepared.alreadyReady ? 200 : 202, prepared, requestId);
      }

      const stopMatch = /^\/v1\/admin\/workspaces\/([0-9a-f-]+)\/stop$/.exec(requestPath);
      if (request.method === "POST" && stopMatch?.[1]) {
        if (!dependencies.lifecycle) throw agentXError("NOT_FOUND", "route not configured");
        return json(202, { workspace: await dependencies.lifecycle.stop(identity, stopMatch[1]) }, requestId);
      }

      const resolveMatch = /^\/v1\/projects\/([^/]+)\/workspace$/.exec(requestPath);
      if (request.method === "GET" && resolveMatch?.[1]) {
        const project = decodeURIComponent(resolveMatch[1]);
        const revision = Number.parseInt(requestUrl.searchParams.get("revision") ?? "", 10);
        if (dependencies.projects && Number.isInteger(revision)) {
          const resolver = new WorkspaceResolver({
            projects: dependencies.projects,
            registry: dependencies.registry,
            memberships: dependencies.memberships,
          });
          return json(200, { workspace: await resolver.resolveDefault(identity, project, revision) }, requestId);
        }
        authorizeProject(identity, project, dependencies.memberships);
        const workspace = await dependencies.registry.getDefault(identity.ownerKey, project);
        if (!workspace) throw agentXError("NOT_FOUND", "workspace not found");
        authorizeWorkspace(identity, workspace);
        return json(200, { workspace: publicWorkspace(workspace) }, requestId);
      }

      const taskMatch = /^\/v1\/workspaces\/([0-9a-f-]+)\/tasks$/.exec(requestPath);
      if (request.method === "POST" && taskMatch?.[1]) {
        const workspace = await dependencies.registry.get(taskMatch[1]);
        if (!workspace) throw agentXError("NOT_FOUND", "workspace not found");
        authorizeWorkspace(identity, workspace);
        authorizeProject(identity, workspace.projectName, dependencies.memberships);
        const task = OperationRequestSchema.parse(body);
        const accepted = await dependencies.operations.acceptTask(workspace.id, identity.ownerKey, task);
        return json(202, accepted, requestId);
      }

      const lookup = parseRequestLookupPath(requestPath);
      if (request.method === "GET" && lookup) {
        const workspace = await dependencies.registry.get(lookup.workspaceId);
        if (!workspace) throw agentXError("NOT_FOUND", "workspace not found");
        authorizeWorkspace(identity, workspace);
        authorizeProject(identity, workspace.projectName, dependencies.memberships);
        let operation;
        try {
          operation = dependencies.operations.getByRequest(workspace.id, identity.ownerKey, lookup.requestId);
        } catch (error) {
          throw requestLookupFailure(error);
        }
        if (!operation) throw agentXError("NOT_FOUND", "request not found");
        return json(200, { operation }, requestId);
      }

      const operationMatch = /^\/v1\/workspaces\/([0-9a-f-]+)\/operations\/([0-9a-f-]+)$/.exec(
        requestPath,
      );
      if (request.method === "GET" && operationMatch?.[1] && operationMatch[2]) {
        const workspace = await dependencies.registry.get(operationMatch[1]);
        if (!workspace) throw agentXError("NOT_FOUND", "workspace not found");
        authorizeWorkspace(identity, workspace);
        const operation = dependencies.operations.get(operationMatch[2]);
        if (!operation || operation.workspaceId !== workspace.id) {
          throw agentXError("NOT_FOUND", "operation not found");
        }
        return json(200, { operation }, requestId);
      }

      throw agentXError("NOT_FOUND", "route not found");
    } catch (error) {
      if (error instanceof AgentXError) {
        return json(error.statusCode, { error: { code: error.code, message: error.message } }, requestId);
      }
      const message = error instanceof Error ? error.message : "invalid request";
      return json(400, { error: { code: "CONFIG_INVALID", message } }, requestId);
    }
  };
}

function bearerToken(value: string | undefined): string {
  if (!value?.startsWith("Bearer ") || value.length <= 7) {
    throw agentXError("AUTH_REQUIRED", "bearer token is required");
  }
  return value.slice(7);
}

function parseBody(body: string | undefined): unknown {
  if (!body) return {};
  return JSON.parse(body) as unknown;
}

function preparationRequest(value: unknown): {
  requestId: string;
  projectName: string;
  projectRevision: number;
  targetOwnerKey: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw agentXError("CONFIG_INVALID", "preparation request must be an object");
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set(["requestId", "projectName", "projectRevision", "targetOwnerKey"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw agentXError("CONFIG_INVALID", "preparation request contains unknown fields");
  }
  if (
    typeof input.requestId !== "string" ||
    typeof input.projectName !== "string" ||
    typeof input.projectRevision !== "number" ||
    typeof input.targetOwnerKey !== "string"
  ) {
    throw agentXError("CONFIG_INVALID", "preparation request fields are invalid");
  }
  return {
    requestId: input.requestId,
    projectName: input.projectName,
    projectRevision: input.projectRevision,
    targetOwnerKey: input.targetOwnerKey,
  };
}

function json(statusCode: number, value: unknown, requestId: string): BrokerResponse {
  const object = typeof value === "object" && value ? { ...value, requestId } : { data: value, requestId };
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(object),
  };
}
