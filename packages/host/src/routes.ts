import { randomUUID } from "node:crypto";
import {
  AgentXError,
  OperationRequestSchema,
  ProjectDefinitionSchema,
  WorkspaceInstanceSchema,
  agentXError,
  type WorkerInvocation,
} from "@agentx/contracts";
import {
  assertNoUntrustedRoutingFields,
  authorizeProject,
  authorizeWorkspace,
  parseRequestLookupPath,
  requestLookupFailure,
  type AuthenticatedIdentity,
  type BrokerRequest,
  type BrokerResponse,
  type ProjectMembership,
} from "@agentx/broker";
import { mintCallbackCapability, verifyCallbackCapability } from "./capability.js";
import type { SqliteOperationStore } from "./store/sqlite-operations.js";
import type { SqliteRegistry } from "./store/sqlite-registry.js";

/**
 * Resolves the authenticated caller for a request.
 *
 * This is the **only** source of caller identity in the host. Route handlers never read
 * an owner, subject or role out of a body, a query string or an unverified header: a
 * caller that could name itself would be choosing its own authority.
 */
export type TrustedIdentityAdapter = (request: BrokerRequest) => Promise<AuthenticatedIdentity>;

export interface LocalBrokerDependencies {
  registry: SqliteRegistry;
  operations: SqliteOperationStore;
  memberships: readonly ProjectMembership[];
  resolveIdentity: TrustedIdentityAdapter;
  callbackSigningKey: Uint8Array | string;
  /** How long a minted callback capability stays valid. */
  callbackTtlMs?: number;
  now?: () => Date;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const CALLBACK = new RegExp(`^/v1/internal/workspaces/(${UUID})/operations/(${UUID})/(events|artifacts|result)$`, "i");

/**
 * The local host's route table.
 *
 * Same request/response shape as the in-memory broker handler, over durable stores and
 * with the routes a real worker and a recovering client actually need.
 */
export function createLocalBrokerHandler(dependencies: LocalBrokerDependencies) {
  const now = dependencies.now ?? (() => new Date());
  const callbackTtlMs = dependencies.callbackTtlMs ?? 3_600_000;

  return async (request: BrokerRequest): Promise<BrokerResponse> => {
    const requestId = request.requestId ?? randomUUID();
    try {
      const url = new URL(request.path, "https://agentx.invalid");
      const path = url.pathname;

      // Worker callbacks authenticate with a capability this host minted, not with a
      // user token, so they are matched before any identity resolution.
      const callback = CALLBACK.exec(path);
      if (request.method === "POST" && callback?.[1] && callback[2] && callback[3]) {
        return json(200, await handleCallback(dependencies, now, request, callback[1], callback[2], callback[3]), requestId);
      }

      const identity = await dependencies.resolveIdentity(request);
      const body = parseBody(request.body);
      assertNoUntrustedRoutingFields(body);

      if (request.method === "POST" && path === "/v1/admin/projects") {
        const registered = dependencies.registry.registerProject(
          identity, ProjectDefinitionSchema.parse(body), dependencies.memberships,
        );
        return json(registered.duplicate ? 200 : 201, registered, requestId);
      }

      if (request.method === "POST" && path === "/v1/admin/workspaces") {
        const workspace = WorkspaceInstanceSchema.parse(body);
        if (workspace.ownerKey !== identity.ownerKey) {
          throw agentXError("FORBIDDEN", "a workspace is registered for its own owner");
        }
        authorizeProject(identity, workspace.projectName, dependencies.memberships);
        return json(201, { workspace: await dependencies.registry.createDefault(workspace) }, requestId);
      }

      const resolveWorkspace = /^\/v1\/projects\/([^/]+)\/workspace$/.exec(path);
      if (request.method === "GET" && resolveWorkspace?.[1]) {
        const projectName = decodeURIComponent(resolveWorkspace[1]);
        authorizeProject(identity, projectName, dependencies.memberships);
        const workspace = await dependencies.registry.getDefault(identity.ownerKey, projectName);
        if (!workspace) throw agentXError("NOT_FOUND", "workspace not found");
        authorizeWorkspace(identity, workspace);
        return json(200, { workspace }, requestId);
      }

      const conversations = new RegExp(`^/v1/workspaces/(${UUID})/conversations$`, "i").exec(path);
      if (request.method === "POST" && conversations?.[1]) {
        const workspace = await owned(dependencies, identity, conversations[1]);
        const conversationId = dependencies.registry.createConversation(workspace.id, randomUUID());
        return json(201, { conversation: { id: conversationId, workspaceId: workspace.id } }, requestId);
      }

      const tasks = new RegExp(`^/v1/workspaces/(${UUID})/tasks$`, "i").exec(path);
      if (request.method === "POST" && tasks?.[1]) {
        const workspace = await owned(dependencies, identity, tasks[1]);
        const task = OperationRequestSchema.parse(body);
        const project = dependencies.registry.getProject(workspace.projectName, workspace.projectRevision);
        if (task.candidate) {
          if (!project) throw agentXError("PROJECT_REVISION_MISMATCH", "registered project revision not found");
          if (!project.definition.repositories.some((entry) => entry.name === task.candidate!.repository)) {
            throw agentXError("CONFIG_INVALID", "candidate repository is not registered for this project");
          }
        }
        const accepted = await dependencies.operations.acceptTask(workspace.id, identity.ownerKey, task, {
          invocation: ({ operationId, fence, request: parsed }): WorkerInvocation => ({
            protocolVersion: 1,
            kind: "task",
            operationId,
            workspaceId: workspace.id,
            fence,
            projectRevision: workspace.projectRevision,
            callbackCapability: mintCallbackCapability({
              key: dependencies.callbackSigningKey,
              workspaceId: workspace.id,
              operationId,
              fence,
              expiresAt: new Date(now().getTime() + callbackTtlMs).toISOString(),
            }),
            payload: {
              conversationId: parsed.conversationId,
              prompt: parsed.prompt,
              ...(parsed.candidate && project
                ? { candidate: parsed.candidate, project: project.definition }
                : {}),
            },
          }),
        });
        return json(202, accepted, requestId);
      }

      const lookup = parseRequestLookupPath(path);
      if (request.method === "GET" && lookup) {
        const workspace = await owned(dependencies, identity, lookup.workspaceId);
        let operation;
        try {
          operation = dependencies.operations.getByRequest(workspace.id, identity.ownerKey, lookup.requestId);
        } catch (error) {
          throw requestLookupFailure(error);
        }
        if (!operation) throw agentXError("NOT_FOUND", "request not found");
        return json(200, { operation }, requestId);
      }

      const events = new RegExp(`^/v1/workspaces/(${UUID})/operations/(${UUID})/events$`, "i").exec(path);
      if (request.method === "GET" && events?.[1] && events[2]) {
        const workspace = await owned(dependencies, identity, events[1]);
        const operation = requireOperation(dependencies, workspace.id, events[2]);
        const after = Number.parseInt(url.searchParams.get("after") ?? "0", 10);
        return json(200, {
          events: dependencies.operations.listEvents(operation.id, Number.isFinite(after) ? after : 0),
        }, requestId);
      }

      const cancel = new RegExp(`^/v1/workspaces/(${UUID})/operations/(${UUID})/cancel$`, "i").exec(path);
      if (request.method === "POST" && cancel?.[1] && cancel[2]) {
        const workspace = await owned(dependencies, identity, cancel[1]);
        const operation = requireOperation(dependencies, workspace.id, cancel[2]);
        return json(202, { operation: dependencies.operations.requestCancellation(operation.id, {
          invocation: (input) => ({
            protocolVersion: 1,
            kind: "cancel",
            operationId: input.cancelOperationId,
            workspaceId: workspace.id,
            fence: operation.fence,
            projectRevision: workspace.projectRevision,
            callbackCapability: mintCallbackCapability({
              key: dependencies.callbackSigningKey,
              workspaceId: workspace.id,
              operationId: input.cancelOperationId,
              fence: operation.fence,
              expiresAt: new Date(now().getTime() + callbackTtlMs).toISOString(),
            }),
            payload: { targetOperationId: operation.id },
          }),
        }) }, requestId);
      }

      const operationRoute = new RegExp(`^/v1/workspaces/(${UUID})/operations/(${UUID})$`, "i").exec(path);
      if (request.method === "GET" && operationRoute?.[1] && operationRoute[2]) {
        const workspace = await owned(dependencies, identity, operationRoute[1]);
        return json(200, { operation: requireOperation(dependencies, workspace.id, operationRoute[2]) }, requestId);
      }

      const artifact = new RegExp(`^/v1/workspaces/(${UUID})/artifacts/([0-9a-f-]{36})$`, "i").exec(path);
      if (request.method === "GET" && artifact?.[1] && artifact[2]) {
        const workspace = await owned(dependencies, identity, artifact[1]);
        const stored = dependencies.operations.getArtifact(workspace.id, artifact[2]);
        if (!stored) throw agentXError("NOT_FOUND", "artifact not found");
        return json(200, { artifact: stored }, requestId);
      }

      throw agentXError("NOT_FOUND", "route not found");
    } catch (error) {
      if (error instanceof AgentXError) {
        return json(error.statusCode, { error: { code: error.code, message: stripCode(error.message, error.code) } }, requestId);
      }
      const message = error instanceof Error ? error.message : "invalid request";
      return json(400, { error: { code: "CONFIG_INVALID", message } }, requestId);
    }
  };
}

/**
 * Apply one worker callback after checking the capability against stored state.
 *
 * The worker's claim about which operation it is reporting on is never taken on trust:
 * the capability must have been minted by this host for exactly this workspace,
 * operation and writer generation, and it must not have expired.
 */
async function handleCallback(
  dependencies: LocalBrokerDependencies,
  now: () => Date,
  request: BrokerRequest,
  workspaceId: string,
  operationId: string,
  kind: string,
): Promise<unknown> {
  const presented = request.headers["x-agentx-callback-capability"];
  if (!presented) throw agentXError("CALLBACK_FORBIDDEN", "callback capability is required");
  const operation = dependencies.operations.get(operationId);
  if (!operation || operation.workspaceId !== workspaceId) {
    throw agentXError("CALLBACK_FORBIDDEN", "callback capability targets another operation");
  }
  verifyCallbackCapability({
    key: dependencies.callbackSigningKey,
    capability: presented,
    workspaceId,
    operationId,
    fence: operation.fence,
    now: now(),
  });
  const body = parseBody(request.body);

  if (kind === "events") {
    const batch = body as { events?: Array<{ type: string; payload: unknown }> };
    return { events: dependencies.operations.appendEvents(operationId, batch.events ?? []) };
  }
  if (kind === "artifacts") {
    const artifact = body as { id?: string; name: string; mediaType: string; content: string };
    return dependencies.operations.putArtifact({
      ...(artifact.id === undefined ? {} : { id: artifact.id }),
      operationId, workspaceId, name: artifact.name, mediaType: artifact.mediaType, content: artifact.content,
    });
  }
  const terminal = body as { status: "SUCCEEDED" | "FAILED" | "CANCELLED"; result?: unknown; error?: string };
  const updated = dependencies.operations.settleTerminal(operationId, terminal.status, {
    ...(terminal.result === undefined ? {} : { result: terminal.result }),
    ...(terminal.error === undefined ? {} : { error: terminal.error }),
  });
  await dependencies.registry.releaseWriterIfHeld(workspaceId, operationId);
  return { operation: updated };
}

async function owned(
  dependencies: LocalBrokerDependencies,
  identity: AuthenticatedIdentity,
  workspaceId: string,
) {
  const workspace = await dependencies.registry.get(workspaceId);
  if (!workspace) throw agentXError("NOT_FOUND", "workspace not found");
  authorizeWorkspace(identity, workspace);
  authorizeProject(identity, workspace.projectName, dependencies.memberships);
  return workspace;
}

function requireOperation(dependencies: LocalBrokerDependencies, workspaceId: string, operationId: string) {
  const operation = dependencies.operations.get(operationId);
  if (!operation || operation.workspaceId !== workspaceId) {
    throw agentXError("NOT_FOUND", "operation not found");
  }
  return operation;
}

function parseBody(body: string | undefined): unknown {
  if (!body) return {};
  return JSON.parse(body) as unknown;
}

function stripCode(message: string, code: string): string {
  return message.startsWith(`${code}: `) ? message.slice(code.length + 2) : message;
}

function json(statusCode: number, value: unknown, requestId: string): BrokerResponse {
  const object = typeof value === "object" && value ? { ...value, requestId } : { data: value, requestId };
  return {
    statusCode,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify(object),
  };
}
