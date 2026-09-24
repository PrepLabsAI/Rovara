import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  BedrockAgentCoreClient,
  DeleteCapacityProviderSessionCommand,
  StopRuntimeSessionCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import {
  AgentXError,
  ConnectorCallRequestSchema,
  GitHubMcpRequestSchema,
  OperationRequestSchema,
  OperationSchema,
  PullRequestRequestSchema,
  PullRequestLifecycleRequestSchema,
  PullRequestLifecycleResultSchema,
  PullRequestResultSchema,
  ProjectDefinitionSchema,
  githubConnectorOf,
  legacyProjectFields,
  SLACK_THREAD_OWNER_ISSUER,
  SlackChannelBindingSchema,
  SlackChannelIdSchema,
  SlackRequesterSchema,
  SlackTeamIdSchema,
  WorkspaceClosePreflightResultSchema,
  WorkspaceInstanceSchema,
  agentXError,
  parseSlackThreadSubject,
  slackThreadSubject,
  type Operation,
  type OperationStatus,
  type CodeBuildCheckResult,
  type CodeBuildGateDefinition,
  type ProjectDefinition,
  type PullRequestLifecycleResult,
  type SlackChannelBinding,
  type SlackRequester,
  type SlackThreadWorkspaceResult,
  type SlackWorkspaceCloseCompleteResult,
  type SlackWorkspaceCloseStartResult,
  type ThreadConnector,
  type WorkerInvocation,
  type WorkspaceInstance,
} from "@agentx/contracts";
import type { AuthenticatedIdentity } from "../auth.js";
import { GitHubAppCredentialProvider, privateKeyFromSecret } from "../github-app.js";
import { CatalogCache, presentCatalog, type ScopeCatalog } from "@agentx/gateway";
import { discoverGitHubTools, executeGitHubConnectorTool, executeGitHubTool, type GitHubMcpCatalog, type GitHubMcpDependencies } from "../github-mcp.js";
import { DynamoConnectorLedger, GITHUB_LEDGER } from "./connector-ledger.js";
import { createCodeBuildGateway, type CodeBuildGateway } from "../codebuild.js";
import { RepositoryGrantService } from "../repository-access.js";
import { publicWorkspace } from "../workspaces.js";
import {
  adaptHttpApiEvent,
  identityFromJwtClaims,
  isAssumedRoleOf,
  ownerKeyForSubject,
  parseRuntimeBinding,
  requiredEnvironment,
  type AdaptedHttpRequest,
  type DurableOutboxRecord,
  type HttpApiV2Event,
  type RuntimeBinding,
} from "./lambda.js";

const TERMINAL = new Set<OperationStatus>(["SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"]);
const MAX_ARTIFACT_BYTES = 5_000_000;
const EVENT_TRANSACTION_CHUNK = 80;

interface RegisteredProjectRecord {
  pk: string;
  sk: string;
  entityType: "PROJECT";
  definition: ProjectDefinition;
  runtimeBinding: RuntimeBinding;
  registeredBy: string;
  registeredAt: string;
}

interface MembershipRecord {
  pk: string;
  sk: string;
  entityType: "MEMBERSHIP";
  ownerKey: string;
  projectName: string;
  role: "developer" | "administrator";
}

interface OperationRecord extends Operation {
  pk: string;
  sk: string;
  entityType: "OPERATION";
  eventSequence: number;
  targetOperationId?: string;
  /** The project revision whose non-disk settings applied, which may be newer than the workspace's. */
  settingsRevision?: number;
  publication?: {
    repository: string;
    repositoryUrl: string;
    headBranch: string;
    baseBranch: string;
    title: string;
    body?: string;
    mode?: "create" | "replace" | "revert";
    targetPullRequestNumber?: number;
    revertCommit?: string;
    codeBuildGates: CodeBuildGateDefinition[];
  };
  maintenance?: {
    action: "append" | "sync";
    repository: string;
    repositoryUrl: string;
    pullRequestNumber: number;
    headBranch: string;
    baseBranch: string;
    expectedHeadCommit: string;
    codeBuildGates: CodeBuildGateDefinition[];
  };
  candidateCommit?: string;
  closePreviousStatus?: "READY" | "STOPPED";
}

interface CallbackClaims {
  workspaceId: string;
  operationId: string;
  fence: number;
  actions: Array<"events" | "artifacts" | "result" | "pull-request" | "pull-request-update" | "codebuild">;
  expiresAt: number;
}

interface PullRequestRecord {
  pk: string;
  sk: string;
  entityType: "PULL_REQUEST";
  workspaceId: string;
  repository: string;
  repositoryUrl: string;
  number: number;
  url: string;
  state: "open" | "closed" | "merged";
  headBranch: string;
  baseBranch: string;
  expectedHeadCommit: string;
  title: string;
  body: string;
  createdByOperationId: string;
  replacedBy?: number;
  replacementFor?: number;
  updatedAt: string;
}

interface CodeBuildRecord {
  pk: string;
  sk: string;
  entityType: "CODEBUILD";
  workspaceId: string;
  operationId: string;
  fence: number;
  repository: string;
  gate: string;
  projectName: string;
  requestedSourceVersion: string;
  idempotencyToken: string;
  buildId: string;
  evidence: CodeBuildCheckResult;
  createdAt: string;
  updatedAt: string;
}

interface AwsBrokerDependencies {
  documentClient: DynamoDBDocumentClient;
  s3: S3Client;
  stopRuntimeSession: (input: {
    runtimeArn: string;
    endpointQualifier: string;
    runtimeSessionId: string;
  }) => Promise<void>;
  deleteWorkspaceSession: (input: {
    capacityProviderArn: string;
    runtimeSessionId: string;
  }) => Promise<void>;
  tableName: string;
  artifactBucketName: string;
  issuer: string;
  adminClaim: string;
  adminValues: readonly string[];
  callbackSigningKey: string;
  repositoryGrants: RepositoryGrantService;
  githubPullRequests: Pick<GitHubAppCredentialProvider, "reconcilePullRequest" | "getPullRequest" | "updatePullRequest">;
  codeBuild: CodeBuildGateway;
  slack?: SlackServiceConfiguration;
  githubMcp?: GitHubMcpDependencies;
  catalogs: CatalogCache<GitHubMcpCatalog>;
}

/** What callers supply; the handler creates the per-container catalog cache when none is given. */
export type AwsBrokerInput = Omit<AwsBrokerDependencies, "catalogs"> & { catalogs?: CatalogCache<GitHubMcpCatalog> };

interface SlackServiceConfiguration {
  orchestratorRoleArn: string;
  memberWorkspaceLimit: number;
  organizationWorkspaceLimit: number;
}

type TransactItems = NonNullable<TransactWriteCommandInput["TransactItems"]>;

export function createAwsBrokerHandler(input: AwsBrokerInput) {
  // One cache per container: discovery per revision, connector and repository costs one vendor round trip.
  const dependencies: AwsBrokerDependencies = { ...input, catalogs: input.catalogs ?? new CatalogCache<GitHubMcpCatalog>({ ttlMs: 600_000, maxEntries: 256 }) };
  if (Buffer.byteLength(dependencies.callbackSigningKey, "utf8") < 32) {
    throw new Error("CALLBACK_SIGNING_KEY must contain at least 32 bytes");
  }
  return async (event: HttpApiV2Event): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> => {
    const request = adaptHttpApiEvent(event);
    try {
      const url = new URL(request.path, "https://agentx.invalid");
      // Internal worker routes authenticate with operation-scoped capabilities; user JWT auth starts below them.
      const callback = /^\/v1\/internal\/workspaces\/([0-9a-f-]+)\/operations\/([0-9a-f-]+)\/(events|artifacts|result|pull-request|pull-request-update|codebuild)$/.exec(
        url.pathname,
      );
      if (request.method === "POST" && callback?.[1] && callback[2] && callback[3]) {
        return await handleCallback(dependencies, request, callback[1], callback[2], callback[3]);
      }
      const credentialExchange = /^\/v1\/internal\/workspaces\/([0-9a-f-]+)\/operations\/([0-9a-f-]+)\/repository-credentials$/.exec(
        url.pathname,
      );
      if (request.method === "POST" && credentialExchange?.[1] && credentialExchange[2]) {
        return json(
          {
            credential: await exchangeRepositoryCredential(
              dependencies,
              request,
              credentialExchange[1],
              credentialExchange[2],
            ),
          },
          request.requestId,
        );
      }

      // The hosted Slack orchestrator authenticates with its IAM role and acts only as a Slack thread owner.
      if (url.pathname.startsWith("/v1/service/")) {
        const identity = await slackServiceIdentity(dependencies, request);
        const serviceUrl = new URL(`/v1${url.pathname.slice("/v1/service".length)}${url.search}`, "https://agentx.invalid");
        if (request.method === "POST" && serviceUrl.pathname === "/v1/threads/workspace") {
          return json(await ensureThreadWorkspace(dependencies, identity, parseBody(request.body)), request.requestId);
        }
        if (request.method === "POST" && serviceUrl.pathname === "/v1/threads/workspace/close") {
          return json(await startThreadWorkspaceClose(dependencies, identity, parseBody(request.body)), request.requestId, 202);
        }
        if (request.method === "POST" && serviceUrl.pathname === "/v1/threads/workspace/close/complete") {
          return json(await completeThreadWorkspaceClose(dependencies, identity, parseBody(request.body)), request.requestId);
        }
        return await routeWorkspaceRequest(dependencies, request, serviceUrl, identity);
      }

      const identity = identityFromJwtClaims(request.jwtClaims, {
        issuer: dependencies.issuer,
        adminClaim: dependencies.adminClaim,
        adminValues: dependencies.adminValues,
      });
      const body = parseBody(request.body);

      if (request.method === "POST" && url.pathname === "/v1/admin/projects") {
        return json(await registerProject(dependencies, identity, body), request.requestId, 201);
      }
      if (request.method === "POST" && url.pathname === "/v1/admin/workspaces/prepare") {
        return json(await prepareWorkspace(dependencies, identity, body), request.requestId, 202);
      }
      const slackBinding = /^\/v1\/admin\/slack\/bindings\/([^/]+)\/([^/]+)$/.exec(url.pathname);
      if (slackBinding?.[1] && slackBinding[2] && request.method === "PUT") {
        return json(await putSlackBinding(dependencies, identity, slackBinding[1], slackBinding[2], body), request.requestId);
      }
      if (slackBinding?.[1] && slackBinding[2] && request.method === "DELETE") {
        return json(await deleteSlackBinding(dependencies, identity, slackBinding[1], slackBinding[2]), request.requestId);
      }
      const stop = /^\/v1\/admin\/workspaces\/([0-9a-f-]+)\/stop$/.exec(url.pathname);
      if (request.method === "POST" && stop?.[1]) {
        return json({ workspace: await stopWorkspace(dependencies, identity, stop[1]) }, request.requestId, 202);
      }

      // Developer workflows run in Slack threads, which reach the same handlers through
      // /v1/service/*. The OIDC entry point serves administration only.
      throw agentXError(
        "FORBIDDEN",
        "AgentX developer workflows run in the project's Slack channel; this endpoint serves administration only",
      );
    } catch (error) {
      if (error instanceof AgentXError) {
        return json({ error: { code: error.code, message: stripCode(error.message, error.code) } }, request.requestId, error.statusCode);
      }
      const message = error instanceof Error ? error.message : "invalid request";
      return json({ error: { code: "CONFIG_INVALID", message } }, request.requestId, 400);
    }
  };
}

async function routeWorkspaceRequest(
  dependencies: AwsBrokerDependencies,
  request: AdaptedHttpRequest,
  url: URL,
  identity: AuthenticatedIdentity,
): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
  const body = parseBody(request.body);
  const githubMcp = /^\/v1\/workspaces\/([0-9a-f-]+)\/github\/(tools|call)$/.exec(url.pathname);
  if (githubMcp?.[1] && ((request.method === "GET" && githubMcp[2] === "tools") || (request.method === "POST" && githubMcp[2] === "call"))) {
    // Feature 007 shapes, kept for Slack services from before feature 013.
    const { workspace, project, github } = await authorizeGitHubConnector(dependencies, identity, githubMcp[1]);
    if (!dependencies.githubMcp) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub MCP is not configured");
    const parsed = request.method === "POST" ? GitHubMcpRequestSchema.safeParse(body) : undefined;
    if (parsed && !parsed.success) throw agentXError("CONFIG_INVALID", "invalid GitHub MCP request");
    const repositoryName = parsed?.success ? parsed.data.repository : url.searchParams.get("repository");
    const repository = github.repositories.find((entry) => entry.name === repositoryName);
    if (!repository) throw agentXError("NOT_FOUND", "registered repository not found");
    if (!parsed?.success) {
      return json({ catalog: await discoverGitHubScope(dependencies, identity, workspace, project, github, repository) }, request.requestId);
    }
    const result = await executeGitHubTool(parsed.data, gitHubContext(identity, workspace, project, github, repository), {
      ...dependencies.githubMcp,
      store: new DynamoConnectorLedger(dependencies.documentClient, dependencies.tableName, workspace.id, GITHUB_LEDGER, github.name),
      onDefinitionChanged: () => dependencies.catalogs.delete(catalogKey(workspace, project, github, repository)),
    });
    return json({ result }, request.requestId);
  }

  const connectorRoute = /^\/v1\/workspaces\/([0-9a-f-]+)\/connectors\/([a-z][a-z0-9-]{0,19})\/(tools|call)$/.exec(url.pathname);
  if (connectorRoute?.[1] && connectorRoute[2] && ((request.method === "GET" && connectorRoute[3] === "tools") || (request.method === "POST" && connectorRoute[3] === "call"))) {
    const { workspace, project, github } = await authorizeGitHubConnector(dependencies, identity, connectorRoute[1]);
    if (github.name !== connectorRoute[2]) throw agentXError("NOT_FOUND", "connector not found");
    const parsed = request.method === "POST" ? ConnectorCallRequestSchema.safeParse(body) : undefined;
    if (parsed && !parsed.success) throw agentXError("CONFIG_INVALID", "invalid connector request");
    if (!parsed?.success) {
      if (!dependencies.githubMcp) return json({ catalog: { connector: github.name, notConnected: true, tools: [], skipped: [] } }, request.requestId);
      const scopes: ScopeCatalog[] = [];
      for (const repository of github.repositories) {
        const discovered = await discoverGitHubScope(dependencies, identity, workspace, project, github, repository);
        scopes.push({ alias: repository.name, tools: discovered.tools.map(({ repository: scope, ...tool }) => ({ ...tool, scope })) });
      }
      const presented = presentCatalog({ connector: github.name, label: "GitHub", scopeNoun: "repository", approvals: github.policy.tools, scopes });
      return json({ catalog: { connector: github.name, tools: presented.tools, skipped: presented.skipped } }, request.requestId);
    }
    // A malformed request (unknown scope or unapproved tool) is refused the same way regardless of
    // whether this deployment has a GitHub credential configured.
    const repository = github.repositories.find((entry) => entry.name === parsed.data.scope);
    if (!repository) throw agentXError("NOT_FOUND", "connector scope not found");
    if (!github.policy.tools.some((tool) => tool.name === parsed.data.tool)) {
      throw agentXError("FORBIDDEN", "GitHub MCP tool is not approved for this project");
    }
    if (!dependencies.githubMcp) {
      return json({ result: {
        requestId: parsed.data.requestId, status: "FAILED", reason: "not_connected", truncated: false, replayed: false,
        text: `${GITHUB_LABEL} is not connected for this project. An administrator must configure its credential.`,
      } }, request.requestId);
    }
    const result = await executeGitHubConnectorTool(
      { requestId: parsed.data.requestId, repository: repository.name, tool: parsed.data.tool, schemaHash: parsed.data.schemaHash, arguments: parsed.data.arguments },
      gitHubContext(identity, workspace, project, github, repository),
      {
        ...dependencies.githubMcp,
        store: new DynamoConnectorLedger(dependencies.documentClient, dependencies.tableName, workspace.id, GITHUB_LEDGER, github.name),
        onDefinitionChanged: () => dependencies.catalogs.delete(catalogKey(workspace, project, github, repository)),
      },
    );
    return json({ result }, request.requestId);
  }

  const resolve = /^\/v1\/projects\/([^/]+)\/workspace$/.exec(url.pathname);
  if (request.method === "GET" && resolve?.[1]) {
    const revision = Number.parseInt(url.searchParams.get("revision") ?? "", 10);
    return json(
      { workspace: await resolveWorkspace(dependencies, identity, decodeURIComponent(resolve[1]), revision) },
      request.requestId,
    );
  }

  const conversations = /^\/v1\/workspaces\/([0-9a-f-]+)\/conversations$/.exec(url.pathname);
  if (request.method === "POST" && conversations?.[1]) {
    return json(
      { conversation: await createConversation(dependencies, identity, conversations[1]) },
      request.requestId,
      201,
    );
  }

  const tasks = /^\/v1\/workspaces\/([0-9a-f-]+)\/tasks$/.exec(url.pathname);
  if (request.method === "POST" && tasks?.[1]) {
    return json(await acceptTask(dependencies, identity, tasks[1], body), request.requestId, 202);
  }

  const pullRequests = /^\/v1\/workspaces\/([0-9a-f-]+)\/pull-requests$/.exec(url.pathname);
  if (request.method === "POST" && pullRequests?.[1]) {
    return json(await acceptPullRequest(dependencies, identity, pullRequests[1], body), request.requestId, 202);
  }
  const pullRequestActions = /^\/v1\/workspaces\/([0-9a-f-]+)\/pull-request-actions$/.exec(url.pathname);
  if (request.method === "POST" && pullRequestActions?.[1]) {
    return json(
      await acceptPullRequestLifecycle(dependencies, identity, pullRequestActions[1], body),
      request.requestId,
      202,
    );
  }

  const operation = /^\/v1\/workspaces\/([0-9a-f-]+)\/operations\/([0-9a-f-]+)$/.exec(url.pathname);
  if (request.method === "GET" && operation?.[1] && operation[2]) {
    return json(
      { operation: await getAuthorizedOperation(dependencies, identity, operation[1], operation[2]) },
      request.requestId,
    );
  }

  const events = /^\/v1\/workspaces\/([0-9a-f-]+)\/operations\/([0-9a-f-]+)\/events$/.exec(url.pathname);
  if (request.method === "GET" && events?.[1] && events[2]) {
    return json(
      await pageEvents(dependencies, identity, events[1], events[2], {
        limit: Number.parseInt(url.searchParams.get("limit") ?? "100", 10),
        ...(url.searchParams.get("cursor") === null
          ? {}
          : { cursor: url.searchParams.get("cursor")! }),
      }),
      request.requestId,
    );
  }

  const artifact = /^\/v1\/workspaces\/([0-9a-f-]+)\/artifacts\/([0-9a-f-]+)$/.exec(url.pathname);
  if (request.method === "GET" && artifact?.[1] && artifact[2]) {
    return json(
      { artifact: await getArtifact(dependencies, identity, artifact[1], artifact[2]) },
      request.requestId,
    );
  }

  const cancel = /^\/v1\/workspaces\/([0-9a-f-]+)\/operations\/([0-9a-f-]+)\/cancel$/.exec(url.pathname);
  if (request.method === "POST" && cancel?.[1] && cancel[2]) {
    return json(await acceptCancellation(dependencies, identity, cancel[1], cancel[2]), request.requestId, 202);
  }

  throw agentXError("NOT_FOUND", "route not found");
}

const GITHUB_LABEL = "GitHub issues";

/** Workspace ownership, channel binding and membership, then the latest revision's GitHub connector. */
async function authorizeGitHubConnector(dependencies: AwsBrokerDependencies, identity: AuthenticatedIdentity, workspaceId: string) {
  const workspace = await requireOwnedWorkspace(dependencies, identity, workspaceId);
  if (identity.slack && identity.slack.binding.projectName !== workspace.projectName) throw agentXError("FORBIDDEN", "Slack channel is no longer bound to this project");
  await requireMembership(dependencies, identity.ownerKey, workspace.projectName);
  // The policy and the repositories it may address come from the project's latest registered
  // revision, so enabling, narrowing or revoking a tool reaches an existing thread at once.
  const project = await requireLatestProject(dependencies, workspace.projectName);
  const github = githubConnectorOf(project.definition);
  if (!github) throw agentXError("FORBIDDEN", "GitHub MCP is not enabled for this project revision");
  return { workspace, project, github };
}

type GitHubConnector = NonNullable<ReturnType<typeof githubConnectorOf>>;
type GitHubRepository = GitHubConnector["repositories"][number];

function gitHubContext(identity: AuthenticatedIdentity, workspace: WorkspaceInstance, project: RegisteredProjectRecord, github: GitHubConnector, repository: GitHubRepository) {
  return {
    workspaceId: workspace.id,
    ownerKey: identity.ownerKey,
    repository,
    policy: github.policy,
    settingsRevision: project.definition.revision,
    ...requesterOf(identity),
  };
}

function catalogKey(workspace: WorkspaceInstance, project: RegisteredProjectRecord, github: GitHubConnector, repository: GitHubRepository): string {
  return JSON.stringify([workspace.projectName, project.definition.revision, github.name, repository.name]);
}

async function discoverGitHubScope(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  workspace: WorkspaceInstance,
  project: RegisteredProjectRecord,
  github: GitHubConnector,
  repository: GitHubRepository,
): Promise<GitHubMcpCatalog> {
  if (!dependencies.githubMcp) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub MCP is not configured");
  const key = catalogKey(workspace, project, github, repository);
  const cached = dependencies.catalogs.get(key);
  if (cached) return cached;
  const { skipped, ...catalog } = await discoverGitHubTools(gitHubContext(identity, workspace, project, github, repository), dependencies.githubMcp);
  if (skipped.length > 0) {
    console.log(JSON.stringify({
      component: "broker", event: "connector.tools_skipped", project: workspace.projectName,
      revision: project.definition.revision, connector: github.name, scope: repository.name, skipped,
    }));
  }
  dependencies.catalogs.set(key, catalog);
  return catalog;
}

async function registerProject(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  value: unknown,
): Promise<{ project: Omit<RegisteredProjectRecord, "pk" | "sk">; duplicate: boolean }> {
  if (!identity.isAdministrator) throw agentXError("FORBIDDEN", "administrator claim is required");
  const input = object(value, "project registration");
  const retired = legacyProjectFields(input.definition);
  if (retired.length > 0) {
    throw agentXError("CONFIG_INVALID", `project definition must not contain ${retired.join(", ")}; remove them and register again`);
  }
  const definition = ProjectDefinitionSchema.parse(input.definition);
  const runtimeBinding = parseRuntimeBinding(input.runtimeBinding);
  const key = projectKey(definition.name, definition.revision);
  const existing = await getItem<RegisteredProjectRecord>(dependencies, key);
  if (existing) {
    if (
      JSON.stringify(existing.definition) !== JSON.stringify(definition) ||
      JSON.stringify(existing.runtimeBinding) !== JSON.stringify(runtimeBinding)
    ) {
      throw agentXError("PROJECT_REVISION_MISMATCH", "registered project revisions and runtime bindings are immutable");
    }
    return { project: withoutKeys(existing), duplicate: true };
  }
  const now = new Date().toISOString();
  const record: RegisteredProjectRecord = {
    ...key,
    entityType: "PROJECT",
    definition,
    runtimeBinding,
    registeredBy: identity.ownerKey,
    registeredAt: now,
  };
  const membership = membershipRecord(identity.ownerKey, definition.name, "administrator");
  try {
    await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: dependencies.tableName, Item: record, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: dependencies.tableName, Item: membership } },
    ] }));
  } catch (error) {
    if (isConditional(error)) return registerProject(dependencies, identity, value);
    throw error;
  }
  return { project: withoutKeys(record), duplicate: false };
}

async function prepareWorkspace(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  value: unknown,
): Promise<{ operationId: string; workspace: ReturnType<typeof publicWorkspace>; alreadyReady: boolean; duplicate?: boolean }> {
  const input = object(value, "workspace preparation");
  const requestId = uuid(input.requestId, "requestId");
  const projectName = name(input.projectName, "projectName");
  const projectRevision = positiveInteger(input.projectRevision, "projectRevision");
  if (typeof input.ownerSubject !== "string") throw agentXError("CONFIG_INVALID", "ownerSubject is required");
  await requireAdministrator(dependencies, identity, projectName);
  const targetOwnerKey = ownerKeyForSubject(dependencies.issuer, input.ownerSubject);
  const idempotency = await getItem<{ operationId: string; workspaceId: string }>(dependencies, {
    pk: `IDEMPOTENCY#${identity.ownerKey}#ADMIN`,
    sk: `REQUEST#${requestId}`,
  });
  if (idempotency) {
    const workspace = await requireWorkspace(dependencies, idempotency.workspaceId);
    return { operationId: idempotency.operationId, workspace: publicWorkspace(workspace), alreadyReady: workspace.status === "READY", duplicate: true };
  }
  const project = await requireProject(dependencies, projectName, projectRevision);
  const existing = await getDefaultWorkspace(dependencies, targetOwnerKey, projectName);
  if (existing) {
    if (existing.projectRevision !== projectRevision) {
      throw agentXError("PROJECT_REVISION_MISMATCH", "existing workspace is pinned to another revision");
    }
    if (["READY", "STOPPED"].includes(existing.status)) {
      return { operationId: randomUUID(), workspace: publicWorkspace(existing), alreadyReady: true };
    }
    if (existing.status === "PREPARING" && existing.activeOperationId) {
      return {
        operationId: existing.activeOperationId,
        workspace: publicWorkspace(existing),
        alreadyReady: false,
        duplicate: true,
      };
    }
    if (existing.status === "PREPARATION_FAILED" && !existing.activeOperationId) {
      return retryWorkspacePreparation(
        dependencies,
        identity,
        requestId,
        targetOwnerKey,
        project,
        existing,
      );
    }
    throw agentXError("WORKSPACE_BUSY", `workspace cannot be prepared while ${existing.status}`);
  }

  const preparation = await newWorkspacePreparation(dependencies, identity, project, targetOwnerKey, requestId);
  await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
    ...preparation.items,
    { Put: { TableName: dependencies.tableName, Item: { pk: `IDEMPOTENCY#${identity.ownerKey}#ADMIN`, sk: `REQUEST#${requestId}`, entityType: "IDEMPOTENCY", operationId: preparation.operationId, workspaceId: preparation.workspace.id }, ConditionExpression: "attribute_not_exists(pk)" } },
  ] }));
  return { operationId: preparation.operationId, workspace: publicWorkspace(preparation.workspace), alreadyReady: false };
}

async function newWorkspacePreparation(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  project: RegisteredProjectRecord,
  targetOwnerKey: string,
  requestId: string,
): Promise<{ workspace: WorkspaceInstance; operationId: string; items: TransactItems }> {
  const projectName = project.definition.name;
  const projectRevision = project.definition.revision;
  const now = new Date().toISOString();
  const workspaceId = randomUUID();
  const operationId = randomUUID();
  const runtimeSessionId = randomUUID();
  const workspace = WorkspaceInstanceSchema.parse({
    id: workspaceId,
    ownerKey: targetOwnerKey,
    projectName,
    projectRevision,
    runtimeArn: project.runtimeBinding.runtimeArn,
    endpointQualifier: project.runtimeBinding.endpointQualifier,
    runtimeSessionId,
    deploymentMode: project.runtimeBinding.deploymentMode,
    capacityProviderArn: project.runtimeBinding.capacityProviderArn,
    rootPath: "/mnt/workspace",
    status: "PREPARING",
    activeOperationId: operationId,
    fence: 1,
    createdAt: now,
    updatedAt: now,
  });
  const operation = operationRecord({
    id: operationId,
    workspaceId,
    kind: "prepare",
    requestId,
    payloadHash: hashJson({ projectName, projectRevision, targetOwnerKey }),
    status: "ACCEPTED",
    fence: workspace.fence,
    createdAt: now,
    updatedAt: now,
    ...requesterOf(identity),
  });
  const invocation: WorkerInvocation = {
    protocolVersion: 1,
    kind: "prepare",
    operationId,
    workspaceId,
    fence: workspace.fence,
    projectRevision,
    callbackCapability: issueCapability(dependencies, workspaceId, operationId, workspace.fence),
    payload: {
      project: project.definition,
      repositoryGrant: issueRepositoryGrant(
        dependencies,
        project,
        targetOwnerKey,
        workspaceId,
        operationId,
      ),
    },
  };
  const outbox = outboxRecord(project.runtimeBinding, workspace, invocation);
  const existingMembership = await getMembership(dependencies, targetOwnerKey, projectName);
  const membership = membershipRecord(
    targetOwnerKey,
    projectName,
    existingMembership?.role ?? "developer",
  );
  return {
    workspace,
    operationId,
    items: [
      { Put: { TableName: dependencies.tableName, Item: workspaceItem(workspace), ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: dependencies.tableName, Item: { pk: `OWNER#${targetOwnerKey}`, sk: `PROJECT#${projectName}`, entityType: "DEFAULT_WORKSPACE", workspaceId }, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: dependencies.tableName, Item: operation, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: dependencies.tableName, Item: outbox, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: dependencies.tableName, Item: membership } },
    ],
  };
}

async function slackServiceIdentity(
  dependencies: AwsBrokerDependencies,
  request: AdaptedHttpRequest,
): Promise<AuthenticatedIdentity> {
  const configuration = dependencies.slack;
  if (!configuration) throw agentXError("NOT_FOUND", "route not found");
  if (!request.iamPrincipalArn || !isAssumedRoleOf(request.iamPrincipalArn, configuration.orchestratorRoleArn)) {
    throw agentXError("FORBIDDEN", "only the Slack orchestrator role may call service routes");
  }
  const context = parseSlackHeaders(request.headers);
  const binding = await getSlackBinding(dependencies, context.thread.teamId, context.thread.channelId);
  if (!binding) throw agentXError("FORBIDDEN", "Slack channel is not bound to a project");
  const subject = slackThreadSubject(context.thread);
  return {
    issuer: SLACK_THREAD_OWNER_ISSUER,
    subject,
    ownerKey: ownerKeyForSubject(SLACK_THREAD_OWNER_ISSUER, subject),
    isAdministrator: false,
    claims: {},
    slack: { ...context, binding },
  };
}

function parseSlackHeaders(headers: Record<string, string | undefined>): Omit<NonNullable<AuthenticatedIdentity["slack"]>, "binding"> {
  try {
    const thread = parseSlackThreadSubject(headers["x-agentx-slack-thread"] ?? "");
    const requester = SlackRequesterSchema.parse({ teamId: thread.teamId, userId: headers["x-agentx-slack-user"] });
    return { thread, requester };
  } catch {
    throw agentXError("CONFIG_INVALID", "valid x-agentx-slack-thread and x-agentx-slack-user headers are required");
  }
}

async function putSlackBinding(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  teamIdValue: string,
  channelIdValue: string,
  value: unknown,
): Promise<{ binding: SlackChannelBinding; latestRevision: number }> {
  const input = object(value, "Slack channel binding");
  // Older CLIs still send projectRevision; the binding follows the project's latest revision instead.
  const binding = SlackChannelBindingSchema.parse({
    teamId: decodeURIComponent(teamIdValue),
    channelId: decodeURIComponent(channelIdValue),
    projectName: input.projectName,
    updatedAt: new Date().toISOString(),
  });
  await requireAdministrator(dependencies, identity, binding.projectName);
  const existing = await getSlackBinding(dependencies, binding.teamId, binding.channelId);
  if (existing && existing.projectName !== binding.projectName) {
    await requireAdministrator(dependencies, identity, existing.projectName);
  }
  const latest = await requireLatestProject(dependencies, binding.projectName);
  await dependencies.documentClient.send(new PutCommand({
    TableName: dependencies.tableName,
    Item: { ...slackBindingKey(binding.teamId, binding.channelId), entityType: "SLACK_BINDING", ...binding, updatedBy: identity.ownerKey },
  }));
  return { binding, latestRevision: latest.definition.revision };
}

async function deleteSlackBinding(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  teamIdValue: string,
  channelIdValue: string,
): Promise<{ deleted: true; binding: SlackChannelBinding }> {
  const teamId = SlackTeamIdSchema.parse(decodeURIComponent(teamIdValue));
  const channelId = SlackChannelIdSchema.parse(decodeURIComponent(channelIdValue));
  const binding = await getSlackBinding(dependencies, teamId, channelId);
  if (!binding) throw agentXError("NOT_FOUND", "Slack channel binding not found");
  await requireAdministrator(dependencies, identity, binding.projectName);
  await dependencies.documentClient.send(new DeleteCommand({
    TableName: dependencies.tableName,
    Key: slackBindingKey(teamId, channelId),
  }));
  return { deleted: true, binding };
}

async function getSlackBinding(
  dependencies: AwsBrokerDependencies,
  teamId: string,
  channelId: string,
): Promise<SlackChannelBinding | undefined> {
  const item = await getItem<Record<string, unknown>>(dependencies, slackBindingKey(teamId, channelId));
  if (!item) return undefined;
  // Bindings written before channels followed the latest revision also carry projectRevision; it is ignored.
  return SlackChannelBindingSchema.parse({
    teamId: item.teamId,
    channelId: item.channelId,
    projectName: item.projectName,
    updatedAt: item.updatedAt,
  });
}

async function startThreadWorkspaceClose(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  value: unknown,
): Promise<SlackWorkspaceCloseStartResult> {
  if (!identity.slack) throw agentXError("FORBIDDEN", "a Slack thread identity is required");
  const input = object(value, "thread workspace close request");
  const requestId = uuid(input.requestId, "requestId");
  const workspace = await getThreadWorkspace(dependencies, identity.ownerKey);
  if (!workspace) return { outcome: "NOT_FOUND" };
  if (workspace.status === "CLOSED" && workspace.closedAt) {
    return { outcome: "CLOSED", workspaceId: workspace.id, closedAt: workspace.closedAt };
  }
  if (workspace.status === "CLOSING" && workspace.closeOperationId) {
    const operation = await requireOperation(dependencies, workspace.id, workspace.closeOperationId);
    return { outcome: "PREFLIGHT", workspaceId: workspace.id, operationId: operation.id, status: operation.status };
  }

  const idempotencyKey = {
    pk: `IDEMPOTENCY#${identity.ownerKey}#CLOSE`,
    sk: `REQUEST#${requestId}`,
  };
  const previous = await getItem<{ operationId: string; workspaceId: string }>(dependencies, idempotencyKey);
  if (previous) {
    const operation = await requireOperation(dependencies, previous.workspaceId, previous.operationId);
    return { outcome: "PREFLIGHT", workspaceId: previous.workspaceId, operationId: operation.id, status: operation.status };
  }
  if ((workspace.status !== "READY" && workspace.status !== "STOPPED") || workspace.activeOperationId) {
    throw agentXError("WORKSPACE_BUSY", `workspace is ${workspace.status}; wait for active work before closing it`);
  }

  const now = new Date().toISOString();
  const operationId = randomUUID();
  const fence = workspace.fence + 1;
  const operation = operationRecord({
    id: operationId,
    workspaceId: workspace.id,
    kind: "close",
    requestId,
    payloadHash: hashJson({ action: "close", workspaceId: workspace.id }),
    status: "ACCEPTED",
    fence,
    createdAt: now,
    updatedAt: now,
    ...requesterOf(identity),
  });
  operation.closePreviousStatus = workspace.status;
  const invocation: WorkerInvocation = {
    protocolVersion: 1,
    kind: "close",
    operationId,
    workspaceId: workspace.id,
    fence,
    projectRevision: workspace.projectRevision,
    callbackCapability: issueCapability(dependencies, workspace.id, operationId, fence),
    payload: {},
  };
  const outbox = outboxRecord({
    runtimeArn: workspace.runtimeArn,
    endpointQualifier: workspace.endpointQualifier,
    deploymentMode: workspace.deploymentMode,
    ...(workspace.capacityProviderArn === undefined ? {} : { capacityProviderArn: workspace.capacityProviderArn }),
  }, workspace, invocation);
  try {
    await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Update: {
        TableName: dependencies.tableName,
        Key: workspaceKey(workspace.id),
        UpdateExpression: "SET #status = :closing, activeOperationId = :operation, closeOperationId = :operation, closedBy = :requester, fence = :fence, updatedAt = :now REMOVE closeError",
        ConditionExpression: "ownerKey = :owner AND attribute_not_exists(activeOperationId) AND (#status = :ready OR #status = :stopped)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":owner": identity.ownerKey,
          ":closing": "CLOSING",
          ":ready": "READY",
          ":stopped": "STOPPED",
          ":operation": operationId,
          ":requester": identity.slack.requester,
          ":fence": fence,
          ":now": now,
        },
      } },
      { Put: { TableName: dependencies.tableName, Item: operation, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: dependencies.tableName, Item: outbox, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: {
        TableName: dependencies.tableName,
        Item: { ...idempotencyKey, entityType: "IDEMPOTENCY", operationId, workspaceId: workspace.id },
        ConditionExpression: "attribute_not_exists(pk)",
      } },
    ] }));
  } catch (error) {
    if (!isConditional(error)) throw error;
    const concurrent = await getItem<{ operationId: string; workspaceId: string }>(dependencies, idempotencyKey);
    if (concurrent) {
      const existing = await requireOperation(dependencies, concurrent.workspaceId, concurrent.operationId);
      return { outcome: "PREFLIGHT", workspaceId: concurrent.workspaceId, operationId: existing.id, status: existing.status };
    }
    throw agentXError("WORKSPACE_BUSY", "another operation acquired the workspace before closure");
  }
  return { outcome: "PREFLIGHT", workspaceId: workspace.id, operationId, status: "ACCEPTED" };
}

async function completeThreadWorkspaceClose(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  value: unknown,
): Promise<SlackWorkspaceCloseCompleteResult> {
  const slack = identity.slack;
  if (!slack) throw agentXError("FORBIDDEN", "a Slack thread identity is required");
  const input = object(value, "thread workspace close completion");
  uuid(input.requestId, "requestId");
  const operationId = uuid(input.operationId, "operationId");
  const workspace = await getThreadWorkspace(dependencies, identity.ownerKey);
  if (!workspace) throw agentXError("NOT_FOUND", "thread workspace not found");
  if (workspace.status === "CLOSED" && workspace.closedAt && workspace.closeOperationId === operationId) {
    return { outcome: "CLOSED", workspaceId: workspace.id, operationId, closedAt: workspace.closedAt, storageReleased: workspace.deploymentMode === "instances-ebs" };
  }
  const operation = await requireOperation(dependencies, workspace.id, operationId);
  if (operation.kind !== "close" || operation.status !== "SUCCEEDED" || workspace.status !== "CLOSING" || workspace.closeOperationId !== operationId) {
    throw agentXError("WORKSPACE_NOT_READY", "workspace close preflight has not completed safely");
  }
  const preflight = WorkspaceClosePreflightResultSchema.parse(operation.result);
  if (!preflight.safeToClose) throw agentXError("WORKSPACE_NOT_READY", "workspace contains unpublished work");

  let storageReleased = false;
  if (workspace.deploymentMode === "instances-ebs") {
    if (!workspace.capacityProviderArn) throw agentXError("CONFIG_INVALID", "workspace capacity provider is missing");
    try {
      await dependencies.deleteWorkspaceSession({
        capacityProviderArn: workspace.capacityProviderArn,
        runtimeSessionId: workspace.runtimeSessionId,
      });
    } catch {
      throw agentXError("RUNTIME_UNAVAILABLE", "workspace resource cleanup failed; retry the close request");
    }
    storageReleased = true;
  }

  const thread = await getItem<{ starterUserId?: string; closedAt?: string }>(dependencies, slackThreadKey(identity.ownerKey));
  if (typeof thread?.starterUserId !== "string") throw agentXError("CONFIG_INVALID", "Slack thread starter is missing");
  const organizationKey = slackOrganizationLimitKey(slack.thread.teamId);
  const memberKey = slackMemberLimitKey(slack.thread.teamId, thread.starterUserId);
  const organization = await getItem<{ count?: number }>(dependencies, organizationKey);
  const member = await getItem<{ count?: number; threads?: string[] }>(dependencies, memberKey);
  const organizationCount = organization?.count ?? 0;
  const memberCount = member?.count ?? 0;
  if (organizationCount < 1 || memberCount < 1) throw agentXError("CONFIG_INVALID", "workspace quota record is inconsistent");
  const remainingThreads = (member?.threads ?? []).filter((subject) => subject !== identity.subject);
  const closedAt = new Date().toISOString();
  try {
    await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Update: {
        TableName: dependencies.tableName,
        Key: workspaceKey(workspace.id),
        UpdateExpression: "SET #status = :closed, closedAt = :closedAt, updatedAt = :closedAt REMOVE activeOperationId, closeError",
        ConditionExpression: "#status = :closing AND closeOperationId = :operation AND fence = :fence",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":closed": "CLOSED", ":closing": "CLOSING", ":closedAt": closedAt, ":operation": operationId, ":fence": operation.fence },
      } },
      { Update: {
        TableName: dependencies.tableName,
        Key: organizationKey,
        UpdateExpression: "SET #count = :next",
        ConditionExpression: "#count = :current",
        ExpressionAttributeNames: { "#count": "count" },
        ExpressionAttributeValues: { ":next": organizationCount - 1, ":current": organizationCount },
      } },
      { Update: {
        TableName: dependencies.tableName,
        Key: memberKey,
        UpdateExpression: "SET #count = :next, #threads = :threads",
        ConditionExpression: "#count = :current",
        ExpressionAttributeNames: { "#count": "count", "#threads": "threads" },
        ExpressionAttributeValues: { ":next": memberCount - 1, ":current": memberCount, ":threads": remainingThreads },
      } },
      { Update: {
        TableName: dependencies.tableName,
        Key: slackThreadKey(identity.ownerKey),
        UpdateExpression: "SET closedAt = :closedAt, closeOperationId = :operation",
        ConditionExpression: "attribute_not_exists(closedAt)",
        ExpressionAttributeValues: { ":closedAt": closedAt, ":operation": operationId },
      } },
    ] }));
  } catch (error) {
    if (!isConditional(error)) throw error;
    const closed = await requireWorkspace(dependencies, workspace.id);
    if (closed.status === "CLOSED" && closed.closedAt) {
      return { outcome: "CLOSED", workspaceId: closed.id, operationId, closedAt: closed.closedAt, storageReleased };
    }
    throw agentXError("WORKSPACE_BUSY", "workspace close completion conflicted; retry");
  }
  return { outcome: "CLOSED", workspaceId: workspace.id, operationId, closedAt, storageReleased };
}

async function ensureThreadWorkspace(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  value: unknown,
): Promise<SlackThreadWorkspaceResult> {
  const slack = identity.slack;
  const limits = dependencies.slack;
  if (!slack || !limits) throw agentXError("FORBIDDEN", "a Slack thread identity is required");
  const input = object(value, "thread workspace request");
  const requestId = uuid(input.requestId, "requestId");
  // Older deployed Slack services parse a strict response; add discovery metadata only on opt-in.
  const includeIntegrations = input.includeIntegrations === true;
  const includeSettingsRevision = input.includeSettingsRevision === true;
  const includeConnectors = input.includeConnectors === true;
  const include: IntegrationInclude = { integrations: includeIntegrations, connectors: includeConnectors, connected: dependencies.githubMcp !== undefined };
  const threadWorkspace = await getThreadWorkspace(dependencies, identity.ownerKey);
  if (threadWorkspace) {
    if (threadWorkspace.status === "CLOSED" && threadWorkspace.closedAt) {
      return { outcome: "CLOSED", workspaceId: threadWorkspace.id, closedAt: threadWorkspace.closedAt };
    }
    if (threadWorkspace.projectName !== slack.binding.projectName) {
      throw agentXError("FORBIDDEN", "this thread's workspace belongs to the channel's previous project binding");
    }
  }
  const existing = threadWorkspace ?? await getDefaultWorkspace(dependencies, identity.ownerKey, slack.binding.projectName);
  if (existing) {
    if (existing.status === "CLOSED" && existing.closedAt) {
      return { outcome: "CLOSED", workspaceId: existing.id, closedAt: existing.closedAt };
    }
    return existingThreadWorkspace(dependencies, identity, requestId, existing, include, includeSettingsRevision);
  }

  // New threads use the latest revision; an existing thread keeps the revision its workspace was prepared with.
  const project = await requireLatestProject(dependencies, slack.binding.projectName);
  const preparation = await newWorkspacePreparation(dependencies, identity, project, identity.ownerKey, requestId);
  const { teamId, userId } = slack.requester;
  try {
    await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
      ...preparation.items,
      { Put: {
        TableName: dependencies.tableName,
        Item: { pk: `IDEMPOTENCY#${identity.ownerKey}#THREAD`, sk: `REQUEST#${requestId}`, entityType: "IDEMPOTENCY", operationId: preparation.operationId, workspaceId: preparation.workspace.id },
        ConditionExpression: "attribute_not_exists(pk)",
      } },
      { Update: {
        TableName: dependencies.tableName,
        Key: slackOrganizationLimitKey(teamId),
        UpdateExpression: "SET #count = if_not_exists(#count, :zero) + :one, entityType = :entity",
        ConditionExpression: "attribute_not_exists(#count) OR #count < :limit",
        ExpressionAttributeNames: { "#count": "count" },
        ExpressionAttributeValues: { ":zero": 0, ":one": 1, ":limit": limits.organizationWorkspaceLimit, ":entity": "SLACK_LIMIT" },
      } },
      { Update: {
        TableName: dependencies.tableName,
        Key: slackMemberLimitKey(teamId, userId),
        UpdateExpression: "SET #count = if_not_exists(#count, :zero) + :one, #threads = list_append(if_not_exists(#threads, :none), :thread), entityType = :entity",
        ConditionExpression: "attribute_not_exists(#count) OR #count < :limit",
        ExpressionAttributeNames: { "#count": "count", "#threads": "threads" },
        ExpressionAttributeValues: {
          ":zero": 0,
          ":one": 1,
          ":limit": limits.memberWorkspaceLimit,
          ":none": [],
          ":thread": [identity.subject],
          ":entity": "SLACK_LIMIT",
        },
      } },
    ] }));
  } catch (error) {
    if (!isConditional(error)) throw error;
    const concurrent = await getDefaultWorkspace(dependencies, identity.ownerKey, slack.binding.projectName);
    if (concurrent) {
      return existingThreadWorkspace(dependencies, identity, requestId, concurrent, include, includeSettingsRevision);
    }
    return threadWorkspaceLimitRefusal(dependencies, teamId, userId, limits);
  }
  await recordThreadRequester(dependencies, identity, preparation.workspace.id, true);
  return {
    outcome: "WORKSPACE",
    workspaceId: preparation.workspace.id,
    status: "PREPARING",
    operationId: preparation.operationId,
    created: true,
    orchestratorInstructions: project.definition.orchestratorInstructions,
    ...threadIntegrations(project.definition, include),
    ...(includeSettingsRevision ? { settingsRevision: project.definition.revision } : {}),
  };
}

async function existingThreadWorkspace(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  requestId: string,
  workspace: WorkspaceInstance,
  include: IntegrationInclude,
  includeSettingsRevision: boolean,
): Promise<SlackThreadWorkspaceResult> {
  await recordThreadRequester(dependencies, identity, workspace.id, false);
  // Preparation rebuilds the workspace's disk, so it keeps the revision the workspace was created
  // with. Everything the model is told comes from the project's latest registered revision.
  const pinned = await requireProject(dependencies, workspace.projectName, workspace.projectRevision);
  const settings = await requireLatestProject(dependencies, workspace.projectName);
  const applied = {
    orchestratorInstructions: settings.definition.orchestratorInstructions,
    ...threadIntegrations(settings.definition, include),
    ...(includeSettingsRevision ? { settingsRevision: settings.definition.revision } : {}),
  };
  if (workspace.status === "PREPARATION_FAILED" && !workspace.activeOperationId) {
    const retried = await retryWorkspacePreparation(dependencies, identity, requestId, identity.ownerKey, pinned, workspace);
    return {
      outcome: "WORKSPACE",
      workspaceId: workspace.id,
      status: "PREPARING",
      operationId: retried.operationId,
      created: false,
      ...applied,
    };
  }
  return {
    outcome: "WORKSPACE",
    workspaceId: workspace.id,
    status: workspace.status,
    operationId: workspace.activeOperationId,
    created: false,
    ...applied,
  };
}

interface IntegrationInclude { integrations: boolean; connectors: boolean; connected: boolean }

function threadIntegrations(project: ProjectDefinition, include: IntegrationInclude): {
  githubMcpRepositories?: string[];
  connectors?: ThreadConnector[];
  repositories?: string[];
} {
  const github = githubConnectorOf(project);
  const repositories = github?.repositories.map((repository) => repository.name) ?? [];
  return {
    ...(include.integrations && github ? { githubMcpRepositories: repositories } : {}),
    ...(include.connectors ? {
      repositories: project.repositories.map((repository) => repository.name),
      connectors: github ? [{ name: github.name, type: "github" as const, label: GITHUB_LABEL, scopes: repositories, connected: include.connected }] : [],
    } : {}),
  };
}

async function threadWorkspaceLimitRefusal(
  dependencies: AwsBrokerDependencies,
  teamId: string,
  userId: string,
  limits: SlackServiceConfiguration,
): Promise<SlackThreadWorkspaceResult> {
  const member = await getItem<{ count?: number; threads?: string[] }>(dependencies, slackMemberLimitKey(teamId, userId));
  if ((member?.count ?? 0) >= limits.memberWorkspaceLimit) {
    return {
      outcome: "LIMIT_REACHED",
      limit: "MEMBER",
      maximum: limits.memberWorkspaceLimit,
      starterThreads: (member?.threads ?? []).map((subject) => parseSlackThreadSubject(subject)),
    };
  }
  const organization = await getItem<{ count?: number }>(dependencies, slackOrganizationLimitKey(teamId));
  if ((organization?.count ?? 0) >= limits.organizationWorkspaceLimit) {
    return { outcome: "LIMIT_REACHED", limit: "ORGANIZATION", maximum: limits.organizationWorkspaceLimit, starterThreads: [] };
  }
  throw agentXError("WORKSPACE_BUSY", "thread workspace creation conflicted with another request; retry");
}

async function recordThreadRequester(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  workspaceId: string,
  starter: boolean,
): Promise<void> {
  const slack = identity.slack;
  if (!slack) return;
  await dependencies.documentClient.send(new UpdateCommand({
    TableName: dependencies.tableName,
    Key: slackThreadKey(identity.ownerKey),
    UpdateExpression: [
      "SET #entity = :entity, #thread = if_not_exists(#thread, :thread), #workspace = if_not_exists(#workspace, :workspace)",
      ...(starter ? [", #starter = if_not_exists(#starter, :user)"] : []),
      " ADD #requesters :users",
    ].join(""),
    ExpressionAttributeNames: {
      "#entity": "entityType",
      "#thread": "thread",
      "#workspace": "workspaceId",
      "#requesters": "requesters",
      ...(starter ? { "#starter": "starterUserId" } : {}),
    },
    ExpressionAttributeValues: {
      ":entity": "SLACK_THREAD",
      ":thread": identity.subject,
      ":workspace": workspaceId,
      ":users": new Set([slack.requester.userId]),
      ...(starter ? { ":user": slack.requester.userId } : {}),
    },
  }));
}

async function slackAttributedBody(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  body: string | undefined,
): Promise<string | undefined> {
  const slack = identity.slack;
  if (!slack) return body;
  const thread = await getItem<{ requesters?: Iterable<string> }>(dependencies, slackThreadKey(identity.ownerKey));
  const requesters = [...new Set([...(thread?.requesters ?? []), slack.requester.userId])].sort();
  const link = `https://slack.com/archives/${slack.thread.channelId}/p${slack.thread.threadTs.replace(".", "")}`;
  const attribution = `Requested in Slack thread ${link} by ${requesters.join(", ")}.`;
  const attributed = body ? `${body}\n\n---\n${attribution}` : attribution;
  return Buffer.byteLength(attributed, "utf8") <= 32_768 ? attributed : body;
}

function requesterOf(identity: AuthenticatedIdentity): { requestedBy?: SlackRequester } {
  return identity.slack ? { requestedBy: identity.slack.requester } : {};
}

function slackBindingKey(teamId: string, channelId: string) {
  return { pk: `SLACK_BINDING#${teamId}`, sk: `CHANNEL#${channelId}` };
}

function slackOrganizationLimitKey(teamId: string) {
  return { pk: `SLACK_LIMIT#${teamId}`, sk: "ORGANIZATION" };
}

function slackMemberLimitKey(teamId: string, userId: string) {
  return { pk: `SLACK_LIMIT#${teamId}`, sk: `MEMBER#${userId}` };
}

function slackThreadKey(ownerKey: string) {
  return { pk: `SLACK_THREAD#${ownerKey}`, sk: "META" };
}

async function retryWorkspacePreparation(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  requestId: string,
  targetOwnerKey: string,
  project: RegisteredProjectRecord,
  workspace: WorkspaceInstance,
): Promise<{
  operationId: string;
  workspace: ReturnType<typeof publicWorkspace>;
  alreadyReady: false;
}> {
  const now = new Date().toISOString();
  const operationId = randomUUID();
  const fence = workspace.fence + 1;
  const operation = operationRecord({
    id: operationId,
    workspaceId: workspace.id,
    kind: "prepare",
    requestId,
    payloadHash: hashJson({
      projectName: workspace.projectName,
      projectRevision: workspace.projectRevision,
      targetOwnerKey,
    }),
    status: "ACCEPTED",
    fence,
    createdAt: now,
    updatedAt: now,
    ...requesterOf(identity),
  });
  const invocation: WorkerInvocation = {
    protocolVersion: 1,
    kind: "prepare",
    operationId,
    workspaceId: workspace.id,
    fence,
    projectRevision: workspace.projectRevision,
    callbackCapability: issueCapability(dependencies, workspace.id, operationId, fence),
    payload: {
      project: project.definition,
      repositoryGrant: issueRepositoryGrant(
        dependencies,
        project,
        targetOwnerKey,
        workspace.id,
        operationId,
      ),
    },
  };
  const updated = WorkspaceInstanceSchema.parse({
    ...workspace,
    status: "PREPARING",
    activeOperationId: operationId,
    fence,
    updatedAt: now,
  });
  const outbox = outboxRecord(project.runtimeBinding, updated, invocation);
  await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
    { Update: {
      TableName: dependencies.tableName,
      Key: workspaceKey(workspace.id),
      UpdateExpression: "SET #status = :preparing, activeOperationId = :operation, fence = :nextFence, updatedAt = :now",
      ConditionExpression: "#status = :failed AND attribute_not_exists(activeOperationId) AND fence = :currentFence",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":preparing": "PREPARING",
        ":failed": "PREPARATION_FAILED",
        ":operation": operationId,
        ":nextFence": fence,
        ":currentFence": workspace.fence,
        ":now": now,
      },
    } },
    { Put: { TableName: dependencies.tableName, Item: operation, ConditionExpression: "attribute_not_exists(pk)" } },
    { Put: { TableName: dependencies.tableName, Item: outbox, ConditionExpression: "attribute_not_exists(pk)" } },
    { Put: {
      TableName: dependencies.tableName,
      Item: {
        pk: `IDEMPOTENCY#${identity.ownerKey}#ADMIN`,
        sk: `REQUEST#${requestId}`,
        entityType: "IDEMPOTENCY",
        operationId,
        workspaceId: workspace.id,
      },
      ConditionExpression: "attribute_not_exists(pk)",
    } },
  ] }));
  return { operationId, workspace: publicWorkspace(updated), alreadyReady: false };
}

async function resolveWorkspace(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  projectName: string,
  revision: number,
) {
  if (!Number.isInteger(revision) || revision < 1) throw agentXError("CONFIG_INVALID", "revision is required");
  await requireMembership(dependencies, identity.ownerKey, projectName);
  await requireProject(dependencies, projectName, revision);
  const workspace = await getDefaultWorkspace(dependencies, identity.ownerKey, projectName);
  if (!workspace) throw agentXError("WORKSPACE_NOT_READY", "workspace has not been prepared by an administrator");
  if (workspace.projectRevision !== revision) {
    throw agentXError("PROJECT_REVISION_MISMATCH", "workspace is pinned to another project revision");
  }
  return publicWorkspace(workspace);
}

async function createConversation(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  workspaceId: string,
) {
  const workspace = await requireOwnedWorkspace(dependencies, identity, workspaceId);
  await requireMembership(dependencies, identity.ownerKey, workspace.projectName);
  const now = new Date().toISOString();
  const conversation = { id: randomUUID(), workspaceId, createdAt: now, updatedAt: now };
  await dependencies.documentClient.send(new PutCommand({
    TableName: dependencies.tableName,
    Item: { pk: `WORKSPACE#${workspaceId}`, sk: `CONVERSATION#${conversation.id}`, entityType: "CONVERSATION", ...conversation },
    ConditionExpression: "attribute_not_exists(pk)",
  }));
  return conversation;
}

async function acceptTask(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  workspaceId: string,
  value: unknown,
): Promise<{ operation: Operation; duplicate: boolean }> {
  const request = OperationRequestSchema.parse(value);
  const workspace = await requireOwnedWorkspace(dependencies, identity, workspaceId);
  await requireMembership(dependencies, identity.ownerKey, workspace.projectName);
  const requestHash = hashJson({ conversationId: request.conversationId, prompt: request.prompt });
  const idempotencyKey = {
    pk: `IDEMPOTENCY#${identity.ownerKey}#${workspaceId}`,
    sk: `REQUEST#${request.requestId}`,
  };
  const previous = await getItem<{ operationId: string; payloadHash: string }>(dependencies, idempotencyKey);
  if (previous) {
    if (previous.payloadHash !== requestHash) throw agentXError("IDEMPOTENCY_CONFLICT", "request ID was reused with another payload");
    return { operation: publicOperation(await requireOperation(dependencies, workspaceId, previous.operationId)), duplicate: true };
  }
  const conversation = await getItem<{ startedAt?: string }>(dependencies, {
    pk: `WORKSPACE#${workspaceId}`,
    sk: `CONVERSATION#${request.conversationId}`,
  });
  if (!conversation) throw agentXError("NOT_FOUND", "conversation not found");
  // Only a recorded attribute means "started"; conversations from before this attribute existed
  // have none, so their next task creates the session instead of failing closed.
  const conversationStarted = typeof conversation.startedAt === "string";
  if (!["READY", "STOPPED"].includes(workspace.status) || workspace.activeOperationId) {
    throw agentXError(workspace.status === "BUSY" ? "WORKSPACE_BUSY" : "WORKSPACE_NOT_READY", `workspace is ${workspace.status}`);
  }
  const settings = await requireLatestProject(dependencies, workspace.projectName);
  const now = new Date().toISOString();
  const operationId = randomUUID();
  const fence = workspace.fence + 1;
  const operation = operationRecord({
    id: operationId,
    workspaceId,
    conversationId: request.conversationId,
    kind: "task",
    requestId: request.requestId,
    payloadHash: requestHash,
    status: "ACCEPTED",
    fence,
    createdAt: now,
    updatedAt: now,
    ...requesterOf(identity),
  });
  operation.settingsRevision = settings.definition.revision;
  const invocation: WorkerInvocation = {
    protocolVersion: 1,
    kind: "task",
    operationId,
    workspaceId,
    fence,
    projectRevision: workspace.projectRevision,
    callbackCapability: issueCapability(dependencies, workspaceId, operationId, fence),
    payload: { conversationId: request.conversationId, prompt: request.prompt, conversationStarted },
  };
  const outbox = outboxRecord(
    {
      runtimeArn: workspace.runtimeArn,
      endpointQualifier: workspace.endpointQualifier,
      deploymentMode: workspace.deploymentMode,
      ...(workspace.capacityProviderArn === undefined ? {} : { capacityProviderArn: workspace.capacityProviderArn }),
    },
    workspace,
    invocation,
  );
  try {
    await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Update: {
        TableName: dependencies.tableName,
        Key: workspaceKey(workspaceId),
        UpdateExpression: "SET #status = :busy, activeOperationId = :operation, fence = :fence, updatedAt = :now",
        ConditionExpression: "ownerKey = :owner AND attribute_not_exists(activeOperationId) AND (#status = :ready OR #status = :stopped)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":owner": identity.ownerKey, ":busy": "BUSY", ":ready": "READY", ":stopped": "STOPPED", ":operation": operationId, ":fence": fence, ":now": now },
      } },
      { Put: { TableName: dependencies.tableName, Item: operation, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: dependencies.tableName, Item: outbox, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: dependencies.tableName, Item: { ...idempotencyKey, entityType: "IDEMPOTENCY", operationId, payloadHash: requestHash }, ConditionExpression: "attribute_not_exists(pk)" } },
    ] }));
  } catch (error) {
    if (isConditional(error)) {
      const concurrent = await getItem<{ operationId: string; payloadHash: string }>(dependencies, idempotencyKey);
      if (concurrent) {
        if (concurrent.payloadHash !== requestHash) {
          throw agentXError("IDEMPOTENCY_CONFLICT", "request ID was reused with another payload");
        }
        return {
          operation: publicOperation(await requireOperation(dependencies, workspaceId, concurrent.operationId)),
          duplicate: true,
        };
      }
      throw agentXError("WORKSPACE_BUSY", "workspace already has an active writer");
    }
    throw error;
  }
  return { operation: publicOperation(operation), duplicate: false };
}

async function acceptPullRequest(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  workspaceId: string,
  value: unknown,
): Promise<{ operation: Operation; duplicate: boolean }> {
  const request = PullRequestRequestSchema.parse(value);
  const workspace = await requireOwnedWorkspace(dependencies, identity, workspaceId);
  await requireMembership(dependencies, identity.ownerKey, workspace.projectName);
  const requestHash = hashJson({
    repository: request.repository,
    title: request.title,
    ...(request.body === undefined ? {} : { body: request.body }),
  });
  const idempotencyKey = {
    pk: `IDEMPOTENCY#${identity.ownerKey}#${workspaceId}`,
    sk: `REQUEST#${request.requestId}`,
  };
  const previous = await getItem<{ operationId: string; payloadHash: string }>(dependencies, idempotencyKey);
  if (previous) {
    if (previous.payloadHash !== requestHash) {
      throw agentXError("IDEMPOTENCY_CONFLICT", "request ID was reused with another payload");
    }
    return {
      operation: publicOperation(await requireOperation(dependencies, workspaceId, previous.operationId)),
      duplicate: true,
    };
  }
  if (!['READY', 'STOPPED'].includes(workspace.status) || workspace.activeOperationId) {
    throw agentXError(
      workspace.status === "BUSY" ? "WORKSPACE_BUSY" : "WORKSPACE_NOT_READY",
      `workspace is ${workspace.status}`,
    );
  }
  const { project, settingsRevision } = await publicationProject(dependencies, workspace);
  const repository = project.definition.repositories.find((candidate) => candidate.name === request.repository);
  if (!repository) throw agentXError("CONFIG_INVALID", "repository is not registered for this project");
  const body = await slackAttributedBody(dependencies, identity, request.body);

  const now = new Date().toISOString();
  const operationId = randomUUID();
  const fence = workspace.fence + 1;
  const headBranch = `agentx/${operationId}`;
  const operation = operationRecord({
    id: operationId,
    workspaceId,
    kind: "publish",
    requestId: request.requestId,
    payloadHash: requestHash,
    status: "ACCEPTED",
    fence,
    createdAt: now,
    updatedAt: now,
    ...requesterOf(identity),
  });
  operation.settingsRevision = settingsRevision;
  operation.publication = {
    repository: repository.name,
    repositoryUrl: repository.url,
    headBranch,
    baseBranch: repository.defaultBranch,
    title: request.title,
    codeBuildGates: repository.codeBuildGates ?? [],
    ...(body === undefined ? {} : { body }),
  };
  const invocation: WorkerInvocation = {
    protocolVersion: 1,
    kind: "publish",
    operationId,
    workspaceId,
    fence,
    projectRevision: workspace.projectRevision,
    callbackCapability: issueCapability(dependencies, workspaceId, operationId, fence, true),
    payload: {
      mode: "create",
      project: project.definition,
      repository: repository.name,
      title: request.title,
      ...(body === undefined ? {} : { body }),
      headBranch,
      repositoryGrant: issueRepositoryGrant(
        dependencies,
        project,
        identity.ownerKey,
        workspaceId,
        operationId,
        "push",
        repository.name,
      ),
    },
  };
  const outbox = outboxRecord({
    runtimeArn: workspace.runtimeArn,
    endpointQualifier: workspace.endpointQualifier,
    deploymentMode: workspace.deploymentMode,
    ...(workspace.capacityProviderArn === undefined ? {} : { capacityProviderArn: workspace.capacityProviderArn }),
  }, workspace, invocation);
  try {
    await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Update: {
        TableName: dependencies.tableName,
        Key: workspaceKey(workspaceId),
        UpdateExpression: "SET #status = :busy, activeOperationId = :operation, fence = :fence, updatedAt = :now",
        ConditionExpression: "ownerKey = :owner AND attribute_not_exists(activeOperationId) AND (#status = :ready OR #status = :stopped)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":owner": identity.ownerKey,
          ":busy": "BUSY",
          ":ready": "READY",
          ":stopped": "STOPPED",
          ":operation": operationId,
          ":fence": fence,
          ":now": now,
        },
      } },
      { Put: { TableName: dependencies.tableName, Item: operation, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: dependencies.tableName, Item: outbox, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: {
        TableName: dependencies.tableName,
        Item: { ...idempotencyKey, entityType: "IDEMPOTENCY", operationId, payloadHash: requestHash },
        ConditionExpression: "attribute_not_exists(pk)",
      } },
    ] }));
  } catch (error) {
    if (isConditional(error)) {
      const concurrent = await getItem<{ operationId: string; payloadHash: string }>(dependencies, idempotencyKey);
      if (concurrent) {
        if (concurrent.payloadHash !== requestHash) {
          throw agentXError("IDEMPOTENCY_CONFLICT", "request ID was reused with another payload");
        }
        return {
          operation: publicOperation(await requireOperation(dependencies, workspaceId, concurrent.operationId)),
          duplicate: true,
        };
      }
      throw agentXError("WORKSPACE_BUSY", "workspace already has an active writer");
    }
    throw error;
  }
  return { operation: publicOperation(operation), duplicate: false };
}

async function acceptPullRequestLifecycle(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  workspaceId: string,
  value: unknown,
): Promise<{ operation: Operation; duplicate: boolean }> {
  const request = PullRequestLifecycleRequestSchema.parse(value);
  const workspace = await requireOwnedWorkspace(dependencies, identity, workspaceId);
  await requireMembership(dependencies, identity.ownerKey, workspace.projectName);
  const requestHash = hashJson({
    repository: request.repository,
    pullRequestNumber: request.pullRequestNumber,
    action: request.action,
    ...(request.title === undefined ? {} : { title: request.title }),
    ...(request.body === undefined ? {} : { body: request.body }),
  });
  const idempotencyKey = {
    pk: `IDEMPOTENCY#${identity.ownerKey}#${workspaceId}`,
    sk: `REQUEST#${request.requestId}`,
  };
  const previous = await getItem<{ operationId: string; payloadHash: string }>(dependencies, idempotencyKey);
  if (previous) {
    if (previous.payloadHash !== requestHash) {
      throw agentXError("IDEMPOTENCY_CONFLICT", "request ID was reused with another payload");
    }
    return { operation: publicOperation(await requireOperation(dependencies, workspaceId, previous.operationId)), duplicate: true };
  }
  const { project, settingsRevision } = await publicationProject(dependencies, workspace);
  const repository = project.definition.repositories.find((candidate) => candidate.name === request.repository);
  if (!repository) throw agentXError("CONFIG_INVALID", "repository is not registered for this project");
  const existingRecord = await getItem<PullRequestRecord>(
    dependencies,
    pullRequestKey(workspaceId, request.repository, request.pullRequestNumber),
  );
  const remote = await dependencies.githubPullRequests.getPullRequest(repository.url, request.pullRequestNumber);
  const record = existingRecord ?? await adoptLegacyPullRequest(
    dependencies,
    workspaceId,
    repository.name,
    repository.url,
    remote,
  );
  if (record.repositoryUrl !== repository.url) throw agentXError("FORBIDDEN", "pull request repository is outside this project revision");
  if (remote.headBranch !== record.headBranch || remote.baseBranch !== record.baseBranch) {
    throw agentXError("STALE_FENCE", "pull request branch identity changed outside AgentX");
  }
  if (remote.headCommit !== record.expectedHeadCommit) {
    throw agentXError("STALE_FENCE", "pull request head changed outside AgentX; reconcile it before retrying");
  }

  const now = new Date().toISOString();
  const operationId = randomUUID();
  if (request.action === "edit" || request.action === "close" || request.action === "reopen") {
    if (request.action === "edit" && remote.state === "merged") {
      throw agentXError("CONFIG_INVALID", "merged pull request metadata is immutable through AgentX");
    }
    if (request.action === "close" && remote.state !== "open") {
      throw agentXError("CONFIG_INVALID", "only an open pull request can be closed");
    }
    if (request.action === "reopen" && remote.state !== "closed") {
      throw agentXError("CONFIG_INVALID", "only a closed, unmerged pull request can be reopened");
    }
    const updated = await dependencies.githubPullRequests.updatePullRequest(record.repositoryUrl, record.number, {
      ...(request.title === undefined ? {} : { title: request.title }),
      ...(request.body === undefined
        ? {}
        : { body: (await slackAttributedBody(dependencies, identity, request.body)) ?? request.body }),
      ...(request.action === "close" ? { state: "closed" as const } : {}),
      ...(request.action === "reopen" ? { state: "open" as const } : {}),
    });
    const result: PullRequestLifecycleResult = PullRequestLifecycleResultSchema.parse({
      action: request.action,
      repository: record.repository,
      number: record.number,
      url: updated.url,
      state: updated.state,
      headBranch: record.headBranch,
      baseBranch: record.baseBranch,
      commit: updated.headCommit,
      checks: [],
      reconciled: false,
    });
    const operation = operationRecord({
      id: operationId, workspaceId, kind: "maintain", requestId: request.requestId,
      payloadHash: requestHash, status: "SUCCEEDED", fence: workspace.fence,
      createdAt: now, updatedAt: now, result,
      ...requesterOf(identity),
    });
    const updatedRecord: PullRequestRecord = {
      ...record,
      state: updated.state,
      expectedHeadCommit: updated.headCommit,
      title: updated.title,
      body: updated.body,
      updatedAt: now,
    };
    await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: dependencies.tableName, Item: operation, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: dependencies.tableName, Item: updatedRecord } },
      { Put: {
        TableName: dependencies.tableName,
        Item: { ...idempotencyKey, entityType: "IDEMPOTENCY", operationId, payloadHash: requestHash },
        ConditionExpression: "attribute_not_exists(pk)",
      } },
    ] }));
    return { operation: publicOperation(operation), duplicate: false };
  }

  if (request.action === "replace" || request.action === "revert") {
    if (request.action === "replace" && remote.state !== "open") {
      throw agentXError("CONFIG_INVALID", "only an open pull request can be replaced");
    }
    if (request.action === "revert" && (remote.state !== "merged" || !remote.mergeCommit)) {
      throw agentXError("CONFIG_INVALID", "only a merged pull request with a merge commit can be reverted");
    }
    if (!['READY', 'STOPPED'].includes(workspace.status) || workspace.activeOperationId) {
      throw agentXError(workspace.status === "BUSY" ? "WORKSPACE_BUSY" : "WORKSPACE_NOT_READY", `workspace is ${workspace.status}`);
    }
    const fence = workspace.fence + 1;
    const title = request.title ?? `${request.action === "replace" ? "Replace" : "Revert"}: ${remote.title}`;
    const baseBody = request.body ?? (request.action === "replace"
      ? `Clean replacement for #${record.number}.`
      : `Reverts merged pull request #${record.number}.`);
    const body = (await slackAttributedBody(dependencies, identity, baseBody)) ?? baseBody;
    const headBranch = `agentx/${operationId}`;
    const operation = operationRecord({
      id: operationId, workspaceId, kind: "publish", requestId: request.requestId,
      payloadHash: requestHash, status: "ACCEPTED", fence, createdAt: now, updatedAt: now,
      ...requesterOf(identity),
    });
    operation.settingsRevision = settingsRevision;
    operation.publication = {
      repository: record.repository,
      repositoryUrl: record.repositoryUrl,
      headBranch,
      baseBranch: record.baseBranch,
      title,
      body,
      codeBuildGates: repository.codeBuildGates ?? [],
      mode: request.action,
      targetPullRequestNumber: record.number,
      ...(remote.mergeCommit === undefined ? {} : { revertCommit: remote.mergeCommit }),
    };
    const invocation: WorkerInvocation = {
      protocolVersion: 1,
      kind: "publish",
      operationId,
      workspaceId,
      fence,
      projectRevision: workspace.projectRevision,
      callbackCapability: issueCapability(dependencies, workspaceId, operationId, fence, true),
      payload: {
        mode: request.action,
        project: project.definition,
        repository: record.repository,
        title,
        body,
        headBranch,
        repositoryGrant: issueRepositoryGrant(
          dependencies, project, identity.ownerKey, workspaceId, operationId, "push", record.repository,
        ),
        targetPullRequestNumber: record.number,
        ...(remote.mergeCommit === undefined ? {} : { revertCommit: remote.mergeCommit }),
      },
    };
    const outbox = outboxRecord({
      runtimeArn: workspace.runtimeArn,
      endpointQualifier: workspace.endpointQualifier,
      deploymentMode: workspace.deploymentMode,
      ...(workspace.capacityProviderArn === undefined ? {} : { capacityProviderArn: workspace.capacityProviderArn }),
    }, workspace, invocation);
    await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Update: {
        TableName: dependencies.tableName,
        Key: workspaceKey(workspaceId),
        UpdateExpression: "SET #status = :busy, activeOperationId = :operation, fence = :fence, updatedAt = :now",
        ConditionExpression: "ownerKey = :owner AND attribute_not_exists(activeOperationId) AND (#status = :ready OR #status = :stopped)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":owner": identity.ownerKey, ":busy": "BUSY", ":ready": "READY", ":stopped": "STOPPED",
          ":operation": operationId, ":fence": fence, ":now": now,
        },
      } },
      { Put: { TableName: dependencies.tableName, Item: operation, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: dependencies.tableName, Item: outbox, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: {
        TableName: dependencies.tableName,
        Item: { ...idempotencyKey, entityType: "IDEMPOTENCY", operationId, payloadHash: requestHash },
        ConditionExpression: "attribute_not_exists(pk)",
      } },
    ] }));
    return { operation: publicOperation(operation), duplicate: false };
  }

  if (request.action !== "append" && request.action !== "sync") {
    throw agentXError("CONFIG_INVALID", "pull request action is not supported");
  }
  if (remote.state !== "open") throw agentXError("CONFIG_INVALID", "only an open pull request can be maintained");
  if (!['READY', 'STOPPED'].includes(workspace.status) || workspace.activeOperationId) {
    throw agentXError(workspace.status === "BUSY" ? "WORKSPACE_BUSY" : "WORKSPACE_NOT_READY", `workspace is ${workspace.status}`);
  }
  const fence = workspace.fence + 1;
  const operation = operationRecord({
    id: operationId, workspaceId, kind: "maintain", requestId: request.requestId,
    payloadHash: requestHash, status: "ACCEPTED", fence, createdAt: now, updatedAt: now,
    ...requesterOf(identity),
  });
  operation.settingsRevision = settingsRevision;
  operation.maintenance = {
    action: request.action,
    repository: record.repository,
    repositoryUrl: record.repositoryUrl,
    pullRequestNumber: record.number,
    headBranch: record.headBranch,
    baseBranch: record.baseBranch,
    expectedHeadCommit: record.expectedHeadCommit,
    codeBuildGates: repository.codeBuildGates ?? [],
  };
  const invocation: WorkerInvocation = {
    protocolVersion: 1,
    kind: "maintain",
    operationId,
    workspaceId,
    fence,
    projectRevision: workspace.projectRevision,
    callbackCapability: issueCapability(dependencies, workspaceId, operationId, fence, true),
    payload: {
      action: request.action,
      project: project.definition,
      repository: record.repository,
      pullRequestNumber: record.number,
      headBranch: record.headBranch,
      baseBranch: record.baseBranch,
      expectedHeadCommit: record.expectedHeadCommit,
      repositoryGrant: issueRepositoryGrant(
        dependencies, project, identity.ownerKey, workspaceId, operationId, "push", record.repository,
      ),
    },
  };
  const outbox = outboxRecord({
    runtimeArn: workspace.runtimeArn,
    endpointQualifier: workspace.endpointQualifier,
    deploymentMode: workspace.deploymentMode,
    ...(workspace.capacityProviderArn === undefined ? {} : { capacityProviderArn: workspace.capacityProviderArn }),
  }, workspace, invocation);
  await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
    { Update: {
      TableName: dependencies.tableName,
      Key: workspaceKey(workspaceId),
      UpdateExpression: "SET #status = :busy, activeOperationId = :operation, fence = :fence, updatedAt = :now",
      ConditionExpression: "ownerKey = :owner AND attribute_not_exists(activeOperationId) AND (#status = :ready OR #status = :stopped)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":owner": identity.ownerKey, ":busy": "BUSY", ":ready": "READY", ":stopped": "STOPPED",
        ":operation": operationId, ":fence": fence, ":now": now,
      },
    } },
    { Put: { TableName: dependencies.tableName, Item: operation, ConditionExpression: "attribute_not_exists(pk)" } },
    { Put: { TableName: dependencies.tableName, Item: outbox, ConditionExpression: "attribute_not_exists(pk)" } },
    { Put: {
      TableName: dependencies.tableName,
      Item: { ...idempotencyKey, entityType: "IDEMPOTENCY", operationId, payloadHash: requestHash },
      ConditionExpression: "attribute_not_exists(pk)",
    } },
  ] }));
  return { operation: publicOperation(operation), duplicate: false };
}

async function acceptCancellation(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  workspaceId: string,
  targetOperationId: string,
) {
  const workspace = await requireOwnedWorkspace(dependencies, identity, workspaceId);
  const target = await requireOperation(dependencies, workspaceId, targetOperationId);
  if (TERMINAL.has(target.status)) return { operation: publicOperation(target), duplicate: true };
  if (workspace.activeOperationId !== targetOperationId) throw agentXError("STALE_FENCE", "operation no longer owns the workspace");
  const now = new Date().toISOString();
  const operationId = randomUUID();
  const operation = operationRecord({
    id: operationId,
    workspaceId,
    kind: "cancel",
    requestId: randomUUID(),
    payloadHash: hashJson({ targetOperationId }),
    status: "ACCEPTED",
    fence: workspace.fence,
    createdAt: now,
    updatedAt: now,
    ...requesterOf(identity),
  }, targetOperationId);
  const invocation: WorkerInvocation = {
    protocolVersion: 1,
    kind: "cancel",
    operationId,
    workspaceId,
    fence: workspace.fence,
    projectRevision: workspace.projectRevision,
    callbackCapability: issueCapability(dependencies, workspaceId, operationId, workspace.fence),
    payload: { targetOperationId },
  };
  const outbox = outboxRecord({
    runtimeArn: workspace.runtimeArn,
    endpointQualifier: workspace.endpointQualifier,
    deploymentMode: workspace.deploymentMode,
    ...(workspace.capacityProviderArn === undefined ? {} : { capacityProviderArn: workspace.capacityProviderArn }),
  }, workspace, invocation);
  await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
    { Update: {
      TableName: dependencies.tableName,
      Key: operationKey(workspaceId, targetOperationId),
      UpdateExpression: "SET #status = :cancel, updatedAt = :now",
      ConditionExpression: "fence = :fence",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":cancel": "CANCEL_REQUESTED", ":now": now, ":fence": workspace.fence },
    } },
    { Put: { TableName: dependencies.tableName, Item: operation } },
    { Put: { TableName: dependencies.tableName, Item: outbox } },
  ] }));
  return { operation: publicOperation(operation), duplicate: false };
}

async function stopWorkspace(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  workspaceId: string,
) {
  const workspace = await requireWorkspace(dependencies, workspaceId);
  await requireAdministrator(dependencies, identity, workspace.projectName);
  if (workspace.status !== "READY" || workspace.activeOperationId) {
    throw agentXError("WORKSPACE_BUSY", "cancel or finish active work before stopping compute");
  }
  await dependencies.stopRuntimeSession({
    runtimeArn: workspace.runtimeArn,
    endpointQualifier: workspace.endpointQualifier,
    runtimeSessionId: workspace.runtimeSessionId,
  });
  const updated = WorkspaceInstanceSchema.parse({ ...workspace, status: "STOPPED", updatedAt: new Date().toISOString() });
  await dependencies.documentClient.send(new PutCommand({ TableName: dependencies.tableName, Item: workspaceItem(updated) }));
  return publicWorkspace(updated);
}

async function handleCallback(
  dependencies: AwsBrokerDependencies,
  request: AdaptedHttpRequest,
  workspaceId: string,
  operationId: string,
  action: string,
) {
  const token = request.headers["x-agentx-callback-capability"];
  if (!token) throw agentXError("CALLBACK_FORBIDDEN", "callback capability is required");
  const claims = verifyCapability(dependencies, token, action as CallbackClaims["actions"][number]);
  if (claims.workspaceId !== workspaceId || claims.operationId !== operationId) {
    throw agentXError("CALLBACK_FORBIDDEN", "callback route is outside the capability scope");
  }
  const operation = await requireOperation(dependencies, workspaceId, operationId);
  if (operation.fence !== claims.fence) throw agentXError("STALE_FENCE", "callback fence is stale");
  if (action !== "result" && TERMINAL.has(operation.status)) {
    throw agentXError("STALE_FENCE", "terminal operations cannot publish more output");
  }
  const body = parseBody(request.body);
  if (action === "events") {
    const accepted = await appendEvents(dependencies, operation, body);
    return json({ accepted }, request.requestId);
  }
  if (action === "artifacts") {
    const artifactId = await putArtifact(dependencies, operation, body);
    return json({ artifactId }, request.requestId);
  }
  if (action === "pull-request") {
    const pullRequest = await reconcilePullRequest(dependencies, operation, body);
    return json(pullRequest, request.requestId);
  }
  if (action === "pull-request-update") {
    const pullRequest = await reconcilePullRequestUpdate(dependencies, operation, body);
    return json(pullRequest, request.requestId);
  }
  if (action === "codebuild") {
    const build = await handleCodeBuild(dependencies, operation, body);
    return json(build, request.requestId);
  }
  const result = await recordTerminalResult(dependencies, operation, body);
  return json({ operation: publicOperation(result) }, request.requestId);
}

async function handleCodeBuild(
  dependencies: AwsBrokerDependencies,
  operation: OperationRecord,
  value: unknown,
): Promise<CodeBuildCheckResult> {
  const scope = operation.publication ?? operation.maintenance;
  if ((operation.kind !== "publish" && operation.kind !== "maintain") || !scope) {
    throw agentXError("CALLBACK_FORBIDDEN", "operation cannot start CodeBuild gates");
  }
  const input = object(value, "CodeBuild callback");
  const allowed = new Set(["action", "repository", "gate", "projectName", "commit", "buildId"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw agentXError("CONFIG_INVALID", "CodeBuild callback contains unknown fields");
  }
  if (input.action !== "start" && input.action !== "status") {
    throw agentXError("CONFIG_INVALID", "CodeBuild callback action is invalid");
  }
  if (input.repository !== scope.repository) {
    throw agentXError("CALLBACK_FORBIDDEN", "CodeBuild repository is outside the operation scope");
  }
  if (typeof input.gate !== "string" || typeof input.projectName !== "string") {
    throw agentXError("CONFIG_INVALID", "CodeBuild gate and projectName are required");
  }
  const gate = scope.codeBuildGates.find((candidate) => candidate.name === input.gate);
  if (!gate || gate.projectName !== input.projectName) {
    throw agentXError("CALLBACK_FORBIDDEN", "CodeBuild gate is outside the registered project scope");
  }
  if (typeof input.commit !== "string" || !/^[a-f0-9]{40,64}$/u.test(input.commit)) {
    throw agentXError("CONFIG_INVALID", "CodeBuild candidate commit is invalid");
  }

  await bindCandidateCommit(dependencies, operation, input.commit);
  const key = codeBuildKey(operation.workspaceId, operation.id, gate.name);
  const existing = await getItem<CodeBuildRecord>(dependencies, key);
  if (existing) {
    assertCodeBuildRecord(existing, operation, scope.repository, gate, input.commit);
    if (input.action === "start") return existing.evidence;
    if (input.buildId !== existing.buildId) {
      throw agentXError("CALLBACK_FORBIDDEN", "CodeBuild build ID is outside the operation scope");
    }
    return refreshCodeBuildRecord(dependencies, existing);
  }
  if (input.action !== "start" || input.buildId !== undefined) {
    throw agentXError("NOT_FOUND", "CodeBuild gate has not been started");
  }

  const idempotencyToken = createHash("sha256")
    .update(`${operation.id}:${gate.name}:${input.commit}`)
    .digest("hex");
  const evidence = await dependencies.codeBuild.start({
    gate: gate.name,
    projectName: gate.projectName,
    commit: input.commit,
    timeoutMinutes: gate.timeoutMinutes,
    idempotencyToken,
  });
  const now = new Date().toISOString();
  const record: CodeBuildRecord = {
    ...key,
    entityType: "CODEBUILD",
    workspaceId: operation.workspaceId,
    operationId: operation.id,
    fence: operation.fence,
    repository: scope.repository,
    gate: gate.name,
    projectName: gate.projectName,
    requestedSourceVersion: input.commit,
    idempotencyToken,
    buildId: evidence.buildId,
    evidence,
    createdAt: now,
    updatedAt: now,
  };
  try {
    await dependencies.documentClient.send(new PutCommand({
      TableName: dependencies.tableName,
      Item: record,
      ConditionExpression: "attribute_not_exists(pk)",
    }));
  } catch (error) {
    if (!isConditional(error)) throw error;
    const concurrent = await getItem<CodeBuildRecord>(dependencies, key);
    if (!concurrent) throw error;
    assertCodeBuildRecord(concurrent, operation, scope.repository, gate, input.commit);
    return concurrent.evidence;
  }
  return evidence;
}

async function bindCandidateCommit(
  dependencies: AwsBrokerDependencies,
  operation: OperationRecord,
  commit: string,
): Promise<void> {
  if (operation.candidateCommit !== undefined && operation.candidateCommit !== commit) {
    throw agentXError("CALLBACK_FORBIDDEN", "CodeBuild candidate commit changed during the operation");
  }
  try {
    await dependencies.documentClient.send(new UpdateCommand({
      TableName: dependencies.tableName,
      Key: operationKey(operation.workspaceId, operation.id),
      UpdateExpression: "SET candidateCommit = if_not_exists(candidateCommit, :commit)",
      ConditionExpression: "attribute_not_exists(candidateCommit) OR candidateCommit = :commit",
      ExpressionAttributeValues: { ":commit": commit },
    }));
  } catch (error) {
    if (isConditional(error)) {
      throw agentXError("CALLBACK_FORBIDDEN", "CodeBuild candidate commit changed during the operation");
    }
    throw error;
  }
}

function assertCodeBuildRecord(
  record: CodeBuildRecord,
  operation: OperationRecord,
  repository: string,
  gate: CodeBuildGateDefinition,
  commit: string,
): void {
  if (
    record.operationId !== operation.id || record.fence !== operation.fence ||
    record.repository !== repository || record.gate !== gate.name ||
    record.projectName !== gate.projectName || record.requestedSourceVersion !== commit
  ) {
    throw agentXError("CALLBACK_FORBIDDEN", "CodeBuild record is outside the operation scope");
  }
}

async function refreshCodeBuildRecord(
  dependencies: AwsBrokerDependencies,
  record: CodeBuildRecord,
): Promise<CodeBuildCheckResult> {
  const evidence = await dependencies.codeBuild.status({
    gate: record.gate,
    projectName: record.projectName,
    commit: record.requestedSourceVersion,
    buildId: record.buildId,
  });
  await dependencies.documentClient.send(new UpdateCommand({
    TableName: dependencies.tableName,
    Key: { pk: record.pk, sk: record.sk },
    UpdateExpression: "SET evidence = :evidence, updatedAt = :now",
    ConditionExpression: "buildId = :buildId AND fence = :fence",
    ExpressionAttributeValues: {
      ":evidence": evidence,
      ":now": new Date().toISOString(),
      ":buildId": record.buildId,
      ":fence": record.fence,
    },
  }));
  return evidence;
}

async function reconcilePullRequestUpdate(
  dependencies: AwsBrokerDependencies,
  operation: OperationRecord,
  value: unknown,
) {
  if (operation.kind !== "maintain" || !operation.maintenance) {
    throw agentXError("CALLBACK_FORBIDDEN", "operation cannot update a pull request");
  }
  const input = object(value, "pull request update callback");
  const expected = operation.maintenance;
  const allowed = new Set([
    "repository", "pullRequestNumber", "action", "headBranch", "baseBranch", "previousCommit", "commit",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw agentXError("CONFIG_INVALID", "pull request update callback contains unknown fields");
  }
  for (const key of ["repository", "pullRequestNumber", "action", "headBranch", "baseBranch"] as const) {
    if (input[key] !== expected[key]) {
      throw agentXError("CALLBACK_FORBIDDEN", `pull request update callback ${key} is outside the operation scope`);
    }
  }
  if (input.previousCommit !== expected.expectedHeadCommit) {
    throw agentXError("STALE_FENCE", "pull request update used a stale expected head");
  }
  if (typeof input.commit !== "string" || !/^[a-f0-9]{40,64}$/u.test(input.commit)) {
    throw agentXError("CONFIG_INVALID", "updated pull request commit is invalid");
  }
  await assertCodeBuildGatesPassed(dependencies, operation, input.commit);
  const record = await requirePullRequest(
    dependencies,
    operation.workspaceId,
    expected.repository,
    expected.pullRequestNumber,
  );
  if (record.expectedHeadCommit === input.commit) {
    return { url: record.url, state: record.state, reconciled: true };
  }
  if (record.expectedHeadCommit !== expected.expectedHeadCommit) {
    throw agentXError("STALE_FENCE", "pull request record changed before callback reconciliation");
  }
  const remote = await dependencies.githubPullRequests.getPullRequest(record.repositoryUrl, record.number);
  if (
    remote.state !== "open" || remote.headBranch !== record.headBranch ||
    remote.baseBranch !== record.baseBranch || remote.headCommit !== input.commit
  ) {
    throw agentXError("STALE_FENCE", "GitHub pull request state does not match the worker update");
  }
  await dependencies.documentClient.send(new UpdateCommand({
    TableName: dependencies.tableName,
    Key: pullRequestKey(operation.workspaceId, expected.repository, expected.pullRequestNumber),
    UpdateExpression: "SET expectedHeadCommit = :commit, #state = :state, updatedAt = :now",
    ConditionExpression: "expectedHeadCommit = :previous",
    ExpressionAttributeNames: { "#state": "state" },
    ExpressionAttributeValues: {
      ":commit": input.commit,
      ":previous": expected.expectedHeadCommit,
      ":state": remote.state,
      ":now": new Date().toISOString(),
    },
  }));
  return { url: remote.url, state: remote.state, reconciled: false };
}

async function reconcilePullRequest(
  dependencies: AwsBrokerDependencies,
  operation: OperationRecord,
  value: unknown,
) {
  if (operation.kind !== "publish" || !operation.publication) {
    throw agentXError("CALLBACK_FORBIDDEN", "operation cannot create a pull request");
  }
  const input = object(value, "pull request callback");
  const expected = operation.publication;
  const allowed = new Set(["repository", "repositoryUrl", "headBranch", "baseBranch", "commit", "title", "body"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw agentXError("CONFIG_INVALID", "pull request callback contains unknown fields");
  }
  for (const key of ["repository", "repositoryUrl", "headBranch", "baseBranch", "title"] as const) {
    const expectedValue = expected[key];
    if (input[key] !== expectedValue) {
      throw agentXError("CALLBACK_FORBIDDEN", `pull request callback ${key} is outside the operation scope`);
    }
  }
  if (expected.body === undefined && input.body !== undefined) {
    throw agentXError("CALLBACK_FORBIDDEN", "pull request callback body is outside the operation scope");
  }
  if (typeof input.commit !== "string" || !/^[a-f0-9]{40,64}$/.test(input.commit)) {
    throw agentXError("CONFIG_INVALID", "published commit is invalid");
  }
  await assertCodeBuildGatesPassed(dependencies, operation, input.commit);
  const pullRequest = await dependencies.githubPullRequests.reconcilePullRequest({
    repositoryUrl: expected.repositoryUrl,
    headBranch: expected.headBranch,
    baseBranch: expected.baseBranch,
    title: expected.title,
    ...(expected.body === undefined ? {} : { body: expected.body }),
  });
  const record: PullRequestRecord = {
    ...pullRequestKey(operation.workspaceId, expected.repository, pullRequest.number),
    entityType: "PULL_REQUEST",
    workspaceId: operation.workspaceId,
    repository: expected.repository,
    repositoryUrl: expected.repositoryUrl,
    number: pullRequest.number,
    url: pullRequest.url,
    state: "open",
    headBranch: expected.headBranch,
    baseBranch: expected.baseBranch,
    expectedHeadCommit: input.commit,
    title: expected.title,
    body: expected.body ?? "",
    createdByOperationId: operation.id,
    ...(expected.mode === "replace" && expected.targetPullRequestNumber !== undefined
      ? { replacementFor: expected.targetPullRequestNumber }
      : {}),
    updatedAt: new Date().toISOString(),
  };
  if (expected.mode === "replace" && expected.targetPullRequestNumber !== undefined) {
    const original = await requirePullRequest(
      dependencies,
      operation.workspaceId,
      expected.repository,
      expected.targetPullRequestNumber,
    );
    const closed = await dependencies.githubPullRequests.updatePullRequest(
      original.repositoryUrl,
      original.number,
      { state: "closed" },
    );
    const linkedOriginal: PullRequestRecord = {
      ...original,
      state: closed.state,
      replacedBy: pullRequest.number,
      updatedAt: new Date().toISOString(),
    };
    await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: dependencies.tableName, Item: record } },
      { Put: { TableName: dependencies.tableName, Item: linkedOriginal } },
    ] }));
  } else {
    await dependencies.documentClient.send(new PutCommand({
      TableName: dependencies.tableName,
      Item: record,
    }));
  }
  return pullRequest;
}

async function assertCodeBuildGatesPassed(
  dependencies: AwsBrokerDependencies,
  operation: OperationRecord,
  commit: string,
): Promise<void> {
  const scope = operation.publication ?? operation.maintenance;
  if (!scope) throw agentXError("CALLBACK_FORBIDDEN", "operation has no publication scope");
  if (
    operation.maintenance?.action === "sync" &&
    commit === operation.maintenance.expectedHeadCommit
  ) return;
  for (const gate of scope.codeBuildGates) {
    const record = await getItem<CodeBuildRecord>(
      dependencies,
      codeBuildKey(operation.workspaceId, operation.id, gate.name),
    );
    if (
      !record || record.fence !== operation.fence || record.repository !== scope.repository ||
      record.projectName !== gate.projectName || record.requestedSourceVersion !== commit ||
      record.evidence.status !== "SUCCEEDED" || record.evidence.resolvedSourceVersion !== commit
    ) {
      throw agentXError("CALLBACK_FORBIDDEN", `CodeBuild gate ${gate.name} has not passed for this candidate`);
    }
  }
}

async function appendEvents(
  dependencies: AwsBrokerDependencies,
  operation: OperationRecord,
  value: unknown,
): Promise<number> {
  const input = object(value, "event callback");
  if (!Array.isArray(input.events) || input.events.length < 1 || input.events.length > 500) {
    throw agentXError("CONFIG_INVALID", "callback must contain 1 through 500 events");
  }
  const events = input.events.map((event) => {
    const item = object(event, "event");
    if (typeof item.type !== "string" || typeof item.timestamp !== "string") {
      throw agentXError("CONFIG_INVALID", "event type and timestamp are required");
    }
    return { type: item.type, timestamp: item.timestamp, payload: item.payload };
  });
  for (let offset = 0; offset < events.length; offset += EVENT_TRANSACTION_CHUNK) {
    const chunk = events.slice(offset, offset + EVENT_TRANSACTION_CHUNK);
    await appendEventChunk(dependencies, operation, chunk, offset, hashJson(value));
  }
  if (events.some((event) => event.type === "lifecycle" && isStatus(event.payload, "RUNNING"))) {
    await dependencies.documentClient.send(new UpdateCommand({
      TableName: dependencies.tableName,
      Key: operationKey(operation.workspaceId, operation.id),
      UpdateExpression: "SET #status = :running, updatedAt = :now",
      ConditionExpression: "#status = :dispatching OR #status = :accepted OR #status = :running",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":running": "RUNNING", ":dispatching": "DISPATCHING", ":accepted": "ACCEPTED", ":now": new Date().toISOString() },
    })).catch(() => undefined);
  }
  if (events.some((event) => event.type === "lifecycle" && startsConversation(event.payload))) {
    await markConversationStarted(dependencies, operation);
  }
  return events.length;
}

/**
 * The authoritative record that a conversation owns a session. It outlives the workspace volume,
 * so a replaced volume fails closed on the next turn instead of silently starting the thread over.
 */
async function markConversationStarted(
  dependencies: AwsBrokerDependencies,
  operation: OperationRecord,
): Promise<void> {
  if (!operation.conversationId) return;
  await dependencies.documentClient.send(new UpdateCommand({
    TableName: dependencies.tableName,
    Key: { pk: `WORKSPACE#${operation.workspaceId}`, sk: `CONVERSATION#${operation.conversationId}` },
    UpdateExpression: "SET startedAt = :now, updatedAt = :now",
    ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(startedAt)",
    ExpressionAttributeValues: { ":now": new Date().toISOString() },
  })).catch((error: unknown) => {
    // Already marked by an earlier delivery of the same event. Anything else must reach the worker,
    // which retries the batch, so the record cannot quietly fall behind the workspace.
    if (!isConditional(error)) throw error;
  });
}

async function appendEventChunk(
  dependencies: AwsBrokerDependencies,
  operation: OperationRecord,
  events: Array<{ type: string; timestamp: string; payload: unknown }>,
  chunkOffset: number,
  batchHash: string,
): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await requireOperation(dependencies, operation.workspaceId, operation.id);
    const start = current.eventSequence + 1;
    const markerKey = { pk: `OPERATION#${operation.id}`, sk: `EVENTBATCH#${batchHash}#${chunkOffset}` };
    if (await getItem(dependencies, markerKey)) return;
    const items = events.map((event, index) => ({
      pk: `OPERATION#${operation.id}`,
      sk: `EVENT#${String(start + index).padStart(12, "0")}`,
      entityType: "EVENT",
      workspaceId: operation.workspaceId,
      operationId: operation.id,
      sequence: start + index,
      ...event,
    }));
    try {
      await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
        { Update: {
          TableName: dependencies.tableName,
          Key: operationKey(operation.workspaceId, operation.id),
          UpdateExpression: "SET eventSequence = :next",
          ConditionExpression: "eventSequence = :current AND fence = :fence",
          ExpressionAttributeValues: { ":next": current.eventSequence + events.length, ":current": current.eventSequence, ":fence": operation.fence },
        } },
        { Put: { TableName: dependencies.tableName, Item: { ...markerKey, entityType: "EVENT_BATCH" }, ConditionExpression: "attribute_not_exists(pk)" } },
        ...items.map((item) => ({ Put: { TableName: dependencies.tableName, Item: item, ConditionExpression: "attribute_not_exists(pk)" } })),
      ] }));
      return;
    } catch (error) {
      if (!isConditional(error) || attempt === 3) throw error;
    }
  }
}

async function putArtifact(
  dependencies: AwsBrokerDependencies,
  operation: OperationRecord,
  value: unknown,
): Promise<string> {
  const input = object(value, "artifact callback");
  if (typeof input.name !== "string" || typeof input.mediaType !== "string" || typeof input.content !== "string") {
    throw agentXError("CONFIG_INVALID", "artifact name, mediaType and content are required");
  }
  if (Buffer.byteLength(input.content, "utf8") > MAX_ARTIFACT_BYTES) {
    throw agentXError("CONFIG_INVALID", "artifact exceeds the 5 MB demo limit");
  }
  const workspace = await requireWorkspace(dependencies, operation.workspaceId);
  const artifactId = randomUUID();
  const objectKey = `private/${workspace.ownerKey}/${workspace.id}/${operation.id}/${artifactId}`;
  await dependencies.s3.send(new PutObjectCommand({
    Bucket: dependencies.artifactBucketName,
    Key: objectKey,
    Body: input.content,
    ContentType: input.mediaType,
  }));
  await dependencies.documentClient.send(new PutCommand({
    TableName: dependencies.tableName,
    Item: {
      pk: `WORKSPACE#${workspace.id}`,
      sk: `ARTIFACT#${artifactId}`,
      entityType: "ARTIFACT",
      id: artifactId,
      workspaceId: workspace.id,
      operationId: operation.id,
      ownerKey: workspace.ownerKey,
      name: input.name,
      mediaType: input.mediaType,
      objectKey,
      createdAt: new Date().toISOString(),
    },
    ConditionExpression: "attribute_not_exists(pk)",
  }));
  return artifactId;
}

async function recordTerminalResult(
  dependencies: AwsBrokerDependencies,
  operation: OperationRecord,
  value: unknown,
): Promise<OperationRecord> {
  const input = object(value, "terminal result");
  const status = input.status;
  if (!TERMINAL.has(status as OperationStatus)) throw agentXError("CONFIG_INVALID", "terminal status is invalid");
  if (TERMINAL.has(operation.status)) {
    if (operation.status !== status) throw agentXError("IDEMPOTENCY_CONFLICT", "terminal result is immutable");
    return operation;
  }
  const workspace = await requireWorkspace(dependencies, operation.workspaceId);
  const now = new Date().toISOString();
  const terminalStatus = status as OperationStatus;
  const error = typeof input.error === "string" ? input.error.slice(0, 16_384) : undefined;
  const result = operation.kind === "publish" && status === "SUCCEEDED"
    ? PullRequestResultSchema.parse(input.result)
    : operation.kind === "close" && status === "SUCCEEDED"
      ? WorkspaceClosePreflightResultSchema.parse(input.result)
      : input.result;
  const closePreflight = operation.kind === "close" && terminalStatus === "SUCCEEDED"
    ? WorkspaceClosePreflightResultSchema.parse(result)
    : undefined;
  const workspaceStatus =
    operation.kind === "prepare"
      ? terminalStatus === "SUCCEEDED"
        ? "READY"
        : "PREPARATION_FAILED"
      : operation.kind === "close"
        ? closePreflight?.safeToClose === true
          ? "CLOSING"
          : operation.closePreviousStatus ?? "READY"
        : "READY";
  const terminalTarget = operation.kind === "cancel" && operation.targetOperationId
    ? operationKey(operation.workspaceId, operation.targetOperationId)
    : undefined;
  const transactItems: ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"] = [
    { Update: {
      TableName: dependencies.tableName,
      Key: operationKey(operation.workspaceId, operation.id),
      UpdateExpression: "SET #status = :status, updatedAt = :now, #result = :result, #error = :error",
      ConditionExpression: "fence = :fence",
      ExpressionAttributeNames: { "#status": "status", "#result": "result", "#error": "error" },
      ExpressionAttributeValues: { ":status": terminalStatus, ":now": now, ":result": result ?? null, ":error": error ?? null, ":fence": operation.fence },
    } },
  ];
  if (operation.kind === "cancel" && terminalTarget) {
    transactItems.push({ Update: {
      TableName: dependencies.tableName,
      Key: terminalTarget,
      UpdateExpression: "SET #status = :status, updatedAt = :now",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":status": terminalStatus === "SUCCEEDED" ? "CANCELLED" : "INTERRUPTED", ":now": now },
    } });
  }
  if (operation.kind !== "cancel" || terminalStatus === "SUCCEEDED") {
    transactItems.push({ Update: {
      TableName: dependencies.tableName,
      Key: workspaceKey(workspace.id),
      UpdateExpression: operation.kind === "prepare" && terminalStatus === "SUCCEEDED"
        ? "SET #status = :status, updatedAt = :now, preparationManifest = :manifest REMOVE activeOperationId"
        : operation.kind === "close" && closePreflight?.safeToClose !== true
          ? "SET #status = :status, updatedAt = :now, closeError = :closeError REMOVE activeOperationId"
          : "SET #status = :status, updatedAt = :now REMOVE activeOperationId, closeError",
      ConditionExpression: operation.kind === "cancel"
        ? "activeOperationId = :target AND fence = :fence"
        : "activeOperationId = :operation AND fence = :fence",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":status": workspaceStatus,
        ":now": now,
        ":fence": operation.fence,
        ...(operation.kind === "cancel" ? { ":target": operation.targetOperationId } : { ":operation": operation.id }),
        ...(operation.kind === "prepare" && terminalStatus === "SUCCEEDED" ? { ":manifest": ".agentx/preparation-manifest.json" } : {}),
        ...(operation.kind === "close" && closePreflight?.safeToClose !== true
          ? { ":closeError": error ?? (closePreflight ? "workspace contains unpublished work" : "workspace close preflight failed") }
          : {}),
      },
    } });
  }
  try {
    await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: transactItems }));
  } catch (transactionError) {
    if (!isConditional(transactionError)) throw transactionError;
    const existing = await requireOperation(dependencies, operation.workspaceId, operation.id);
    if (existing.status === terminalStatus) return existing;
    throw agentXError("STALE_FENCE", "terminal callback no longer owns the workspace");
  }
  return { ...operation, status: terminalStatus, updatedAt: now, ...(result === undefined ? {} : { result }), ...(error === undefined ? {} : { error }) };
}

async function pageEvents(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  workspaceId: string,
  operationId: string,
  input: { cursor?: string; limit: number },
) {
  await getAuthorizedOperation(dependencies, identity, workspaceId, operationId);
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500) {
    throw agentXError("CONFIG_INVALID", "event limit must be from 1 through 500");
  }
  const after = decodeCursor(input.cursor);
  const response = await dependencies.documentClient.send(new QueryCommand({
    TableName: dependencies.tableName,
    ExpressionAttributeValues: {
      ":pk": `OPERATION#${operationId}`,
      ":after": `EVENT#${String(after).padStart(12, "0")}`,
      ":end": "EVENT#\uffff",
    },
    KeyConditionExpression: "pk = :pk AND sk BETWEEN :after AND :end",
    Limit: input.limit,
    ConsistentRead: true,
  }));
  const events = (response.Items ?? [])
    .filter((item) => item.entityType === "EVENT")
    .map((item) => parseStoredEvent(item));
  const last = events.at(-1)?.sequence;
  return { events, ...(response.LastEvaluatedKey && last !== undefined ? { cursor: encodeCursor(last) } : {}) };
}

async function getArtifact(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  workspaceId: string,
  artifactId: string,
) {
  await requireOwnedWorkspace(dependencies, identity, workspaceId);
  const artifact = await getItem<Record<string, unknown>>(dependencies, {
    pk: `WORKSPACE#${workspaceId}`,
    sk: `ARTIFACT#${artifactId}`,
  });
  if (!artifact || artifact.ownerKey !== identity.ownerKey || typeof artifact.objectKey !== "string") {
    throw agentXError("NOT_FOUND", "artifact not found");
  }
  const object = await dependencies.s3.send(new GetObjectCommand({ Bucket: dependencies.artifactBucketName, Key: artifact.objectKey }));
  const content = object.Body ? await object.Body.transformToString("utf8") : "";
  return { id: artifactId, name: artifact.name, mediaType: artifact.mediaType, operationId: artifact.operationId, content };
}

async function getAuthorizedOperation(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  workspaceId: string,
  operationId: string,
): Promise<Operation> {
  const workspace = await requireOwnedWorkspace(dependencies, identity, workspaceId);
  await requireMembership(dependencies, identity.ownerKey, workspace.projectName);
  return publicOperation(await requireOperation(dependencies, workspaceId, operationId));
}

async function requireOwnedWorkspace(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  workspaceId: string,
): Promise<WorkspaceInstance> {
  const workspace = await requireWorkspace(dependencies, workspaceId);
  if (workspace.ownerKey !== identity.ownerKey) throw agentXError("NOT_FOUND", "workspace not found");
  return workspace;
}

async function requireWorkspace(dependencies: AwsBrokerDependencies, workspaceId: string): Promise<WorkspaceInstance> {
  const item = await getItem<Record<string, unknown>>(dependencies, workspaceKey(workspaceId));
  if (!item) throw agentXError("NOT_FOUND", "workspace not found");
  const workspace = Object.fromEntries(
    Object.entries(item).filter(([key]) => !["pk", "sk", "entityType"].includes(key)),
  );
  return WorkspaceInstanceSchema.parse(workspace);
}

async function getDefaultWorkspace(
  dependencies: AwsBrokerDependencies,
  ownerKey: string,
  projectName: string,
): Promise<WorkspaceInstance | undefined> {
  const mapping = await getItem<{ workspaceId: string }>(dependencies, {
    pk: `OWNER#${ownerKey}`,
    sk: `PROJECT#${projectName}`,
  });
  return mapping ? requireWorkspace(dependencies, mapping.workspaceId) : undefined;
}

async function getThreadWorkspace(
  dependencies: AwsBrokerDependencies,
  ownerKey: string,
): Promise<WorkspaceInstance | undefined> {
  const thread = await getItem<{ workspaceId?: string }>(dependencies, slackThreadKey(ownerKey));
  return typeof thread?.workspaceId === "string" ? requireWorkspace(dependencies, thread.workspaceId) : undefined;
}

async function requireProject(
  dependencies: AwsBrokerDependencies,
  projectName: string,
  revision: number,
): Promise<RegisteredProjectRecord> {
  const project = await getItem<RegisteredProjectRecord>(dependencies, projectKey(projectName, revision));
  if (!project) throw agentXError("NOT_FOUND", "registered project revision not found");
  return project;
}

/**
 * The definition a publication or maintenance run works from: the workspace's own revision for
 * everything that touches its disk, and the project's latest registered revision for the settings
 * that do not. Returns the revision whose settings applied, for the operation record.
 */
async function publicationProject(
  dependencies: AwsBrokerDependencies,
  workspace: WorkspaceInstance,
): Promise<{ project: RegisteredProjectRecord; settingsRevision: number }> {
  const pinned = await requireProject(dependencies, workspace.projectName, workspace.projectRevision);
  const settings = await requireLatestProject(dependencies, workspace.projectName);
  if (settings.definition.revision === pinned.definition.revision) {
    return { project: pinned, settingsRevision: pinned.definition.revision };
  }
  const definition: ProjectDefinition = {
    ...pinned.definition,
    readiness: settings.definition.readiness,
    repositories: pinned.definition.repositories.map((repository) => {
      const latest = settings.definition.repositories.find((candidate) => candidate.name === repository.name);
      // A repository the latest revision dropped keeps the gates it was registered with.
      if (!latest) return repository;
      const withoutGates = { ...repository };
      delete withoutGates.codeBuildGates;
      return { ...withoutGates, ...(latest.codeBuildGates === undefined ? {} : { codeBuildGates: latest.codeBuildGates }) };
    }),
  };
  return { project: { ...pinned, definition }, settingsRevision: settings.definition.revision };
}

async function requireLatestProject(
  dependencies: AwsBrokerDependencies,
  projectName: string,
): Promise<RegisteredProjectRecord> {
  // Revision sort keys are zero-padded, so the last key in descending order is the highest revision.
  const response = await dependencies.documentClient.send(new QueryCommand({
    TableName: dependencies.tableName,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :revision)",
    ExpressionAttributeValues: { ":pk": `PROJECT#${projectName}`, ":revision": "REV#" },
    ScanIndexForward: false,
    Limit: 1,
    ConsistentRead: true,
  }));
  const project = response.Items?.[0] as RegisteredProjectRecord | undefined;
  if (!project) throw agentXError("NOT_FOUND", "registered project not found");
  return project;
}

async function requireOperation(
  dependencies: AwsBrokerDependencies,
  workspaceId: string,
  operationId: string,
): Promise<OperationRecord> {
  const operation = await getItem<OperationRecord>(dependencies, operationKey(workspaceId, operationId));
  if (!operation) throw agentXError("NOT_FOUND", "operation not found");
  return operation;
}

async function requirePullRequest(
  dependencies: AwsBrokerDependencies,
  workspaceId: string,
  repository: string,
  number: number,
): Promise<PullRequestRecord> {
  const record = await getItem<PullRequestRecord>(dependencies, pullRequestKey(workspaceId, repository, number));
  if (!record) throw agentXError("NOT_FOUND", "AgentX pull request record not found");
  return record;
}

async function adoptLegacyPullRequest(
  dependencies: AwsBrokerDependencies,
  workspaceId: string,
  repository: string,
  repositoryUrl: string,
  remote: Awaited<ReturnType<GitHubAppCredentialProvider["getPullRequest"]>>,
): Promise<PullRequestRecord> {
  const match = /^agentx\/([0-9a-f-]{36})$/iu.exec(remote.headBranch);
  if (!match?.[1]) throw agentXError("NOT_FOUND", "pull request is not owned by this AgentX workspace");
  const operation = await requireOperation(dependencies, workspaceId, match[1]);
  if (
    operation.kind !== "publish" || operation.status !== "SUCCEEDED" || !operation.publication ||
    operation.publication.repository !== repository || operation.publication.repositoryUrl !== repositoryUrl ||
    operation.publication.headBranch !== remote.headBranch || operation.publication.baseBranch !== remote.baseBranch
  ) {
    throw agentXError("NOT_FOUND", "pull request is not backed by a successful AgentX publication");
  }
  const record: PullRequestRecord = {
    ...pullRequestKey(workspaceId, repository, remote.number),
    entityType: "PULL_REQUEST",
    workspaceId,
    repository,
    repositoryUrl,
    number: remote.number,
    url: remote.url,
    state: remote.state,
    headBranch: remote.headBranch,
    baseBranch: remote.baseBranch,
    expectedHeadCommit: remote.headCommit,
    title: remote.title,
    body: remote.body,
    createdByOperationId: operation.id,
    updatedAt: new Date().toISOString(),
  };
  await dependencies.documentClient.send(new PutCommand({ TableName: dependencies.tableName, Item: record }));
  return record;
}

async function requireMembership(
  dependencies: AwsBrokerDependencies,
  ownerKey: string,
  projectName: string,
): Promise<MembershipRecord> {
  const membership = await getMembership(dependencies, ownerKey, projectName);
  if (!membership) throw agentXError("NOT_FOUND", "project not found");
  return membership;
}

async function getMembership(dependencies: AwsBrokerDependencies, ownerKey: string, projectName: string) {
  return getItem<MembershipRecord>(dependencies, { pk: `MEMBER#${ownerKey}`, sk: `PROJECT#${projectName}` });
}

async function requireAdministrator(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  projectName: string,
): Promise<void> {
  if (!identity.isAdministrator) throw agentXError("FORBIDDEN", "administrator claim is required");
  const membership = await requireMembership(dependencies, identity.ownerKey, projectName);
  if (membership.role !== "administrator") throw agentXError("FORBIDDEN", "administrator project membership is required");
}

async function getItem<T>(dependencies: AwsBrokerDependencies, key: { pk: string; sk: string }): Promise<T | undefined> {
  const response = await dependencies.documentClient.send(new GetCommand({
    TableName: dependencies.tableName,
    Key: key,
    ConsistentRead: true,
  }));
  return response.Item as T | undefined;
}

function operationRecord(operation: Operation, targetOperationId?: string): OperationRecord {
  const parsed = OperationSchema.parse(operation);
  return {
    pk: `WORKSPACE#${parsed.workspaceId}`,
    sk: `OPERATION#${parsed.id}`,
    entityType: "OPERATION",
    eventSequence: 0,
    ...parsed,
    ...(targetOperationId === undefined ? {} : { targetOperationId }),
  };
}

function publicOperation(record: OperationRecord): Operation {
  return OperationSchema.parse({
    id: record.id,
    workspaceId: record.workspaceId,
    kind: record.kind,
    requestId: record.requestId,
    payloadHash: record.payloadHash,
    status: record.status,
    fence: record.fence,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.conversationId === undefined ? {} : { conversationId: record.conversationId }),
    ...(record.heartbeatAt === undefined ? {} : { heartbeatAt: record.heartbeatAt }),
    ...(record.result === undefined ? {} : { result: record.result }),
    ...(typeof record.error === "string" ? { error: record.error } : {}),
    ...(record.requestedBy === undefined ? {} : { requestedBy: record.requestedBy }),
  });
}

function outboxRecord(
  runtimeBinding: RuntimeBinding,
  workspace: WorkspaceInstance,
  invocation: WorkerInvocation,
): DurableOutboxRecord & { pk: string; sk: string; createdAt: string } {
  const id = randomUUID();
  return {
    pk: `OUTBOX#${id}`,
    sk: "OUTBOX",
    id,
    entityType: "OUTBOX",
    status: "PENDING",
    operationId: invocation.operationId,
    workspaceId: workspace.id,
    runtimeArn: runtimeBinding.runtimeArn,
    endpointQualifier: runtimeBinding.endpointQualifier,
    runtimeSessionId: workspace.runtimeSessionId,
    invocation,
    createdAt: new Date().toISOString(),
  };
}

function workspaceItem(workspace: WorkspaceInstance) {
  return { ...workspaceKey(workspace.id), entityType: "WORKSPACE", ...workspace };
}

function membershipRecord(ownerKey: string, projectName: string, role: MembershipRecord["role"]): MembershipRecord {
  return { pk: `MEMBER#${ownerKey}`, sk: `PROJECT#${projectName}`, entityType: "MEMBERSHIP", ownerKey, projectName, role };
}

function projectKey(nameValue: string, revision: number) {
  return { pk: `PROJECT#${nameValue}`, sk: `REV#${String(revision).padStart(12, "0")}` };
}

function workspaceKey(id: string) {
  return { pk: `WORKSPACE#${id}`, sk: "META" };
}

function operationKey(workspaceId: string, operationId: string) {
  return { pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${operationId}` };
}

export async function deleteCapacityProviderWorkspaceSession(
  client: { send(command: DeleteCapacityProviderSessionCommand): Promise<unknown> },
  input: { capacityProviderArn: string; runtimeSessionId: string },
): Promise<void> {
  const capacityProviderId = input.capacityProviderArn.split("/").at(-1);
  if (!capacityProviderId) throw agentXError("CONFIG_INVALID", "capacity provider ARN is invalid");
  try {
    await client.send(new DeleteCapacityProviderSessionCommand({
      capacityProviderId,
      sessionId: input.runtimeSessionId,
    }));
  } catch (error) {
    if (!(error instanceof Error && error.name === "ResourceNotFoundException")) throw error;
  }
}

function pullRequestKey(workspaceId: string, repository: string, number: number) {
  return {
    pk: `WORKSPACE#${workspaceId}`,
    sk: `PULL_REQUEST#${repository}#${String(number).padStart(12, "0")}`,
  };
}

function codeBuildKey(workspaceId: string, operationId: string, gate: string) {
  return {
    pk: `WORKSPACE#${workspaceId}`,
    sk: `CODEBUILD#${operationId}#${gate}`,
  };
}

function issueRepositoryGrant(
  dependencies: AwsBrokerDependencies,
  project: RegisteredProjectRecord,
  ownerKey: string,
  workspaceId: string,
  operationId: string,
  access: "clone" | "push" = "clone",
  repositoryName?: string,
): string {
  return dependencies.repositoryGrants.issue({
    ownerKey,
    projectName: project.definition.name,
    workspaceId,
    operationId,
    repositories: project.definition.repositories
      .filter((repository) => repositoryName === undefined || repository.name === repositoryName)
      .map((repository) => ({
      credentialRef: repository.credentialRef,
      repositoryUrl: repository.url,
      access,
    })),
  });
}

async function exchangeRepositoryCredential(
  dependencies: AwsBrokerDependencies,
  request: AdaptedHttpRequest,
  workspaceId: string,
  operationId: string,
) {
  const grant = request.headers["x-agentx-repository-grant"];
  if (!grant) throw agentXError("FORBIDDEN", "repository grant is required");
  const input = object(parseBody(request.body), "repository credential exchange");
  const credentialRef = name(input.credentialRef, "credentialRef");
  const access = input.access === "clone" || input.access === "push" ? input.access : undefined;
  if (!access) throw agentXError("CONFIG_INVALID", "repository access is invalid");
  if (typeof input.repositoryUrl !== "string" || input.repositoryUrl.length > 2_048) {
    throw agentXError("CONFIG_INVALID", "repositoryUrl is invalid");
  }
  return dependencies.repositoryGrants.exchange(grant, {
    workspaceId,
    operationId,
    credentialRef,
    repositoryUrl: input.repositoryUrl,
    access,
  });
}

function issueCapability(
  dependencies: AwsBrokerDependencies,
  workspaceId: string,
  operationId: string,
  fence: number,
  allowPullRequest = false,
): string {
  const claims: CallbackClaims = {
    workspaceId,
    operationId,
    fence,
    actions: [
      "artifacts",
      "events",
      "result",
      ...(allowPullRequest
        ? ["pull-request" as const, "pull-request-update" as const, "codebuild" as const]
        : []),
    ],
    expiresAt: Math.floor(Date.now() / 1_000) + 32_400,
  };
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${body}.${createHmac("sha256", dependencies.callbackSigningKey).update(body).digest("base64url")}`;
}

function verifyCapability(
  dependencies: AwsBrokerDependencies,
  token: string,
  action: CallbackClaims["actions"][number],
): CallbackClaims {
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra) throw agentXError("CALLBACK_FORBIDDEN", "invalid callback capability");
  const expected = createHmac("sha256", dependencies.callbackSigningKey).update(body).digest();
  const actual = Buffer.from(signature, "base64url");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw agentXError("CALLBACK_FORBIDDEN", "invalid callback signature");
  }
  const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as CallbackClaims;
  if (claims.expiresAt <= Math.floor(Date.now() / 1_000) || !claims.actions.includes(action)) {
    throw agentXError("CALLBACK_FORBIDDEN", `callback capability does not allow ${action}`);
  }
  return claims;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw agentXError("CONFIG_INVALID", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function parseBody(body: string | undefined): unknown {
  return body ? JSON.parse(body) as unknown : {};
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw agentXError("CONFIG_INVALID", `${label} must be a UUID`);
  }
  return value;
}

function name(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,62}$/.test(value)) {
    throw agentXError("CONFIG_INVALID", `${label} is invalid`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw agentXError("CONFIG_INVALID", `${label} must be a positive integer`);
  }
  return value;
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function encodeCursor(sequence: number): string {
  return Buffer.from(String(sequence)).toString("base64url");
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const value = Number.parseInt(Buffer.from(cursor, "base64url").toString("utf8"), 10);
  if (!Number.isInteger(value) || value < 0) throw agentXError("CONFIG_INVALID", "event cursor is invalid");
  return value;
}

function isConditional(error: unknown): boolean {
  return error instanceof Error && ["ConditionalCheckFailedException", "TransactionCanceledException"].includes(error.name);
}

/** The worker reports, once per conversation, that a saved session now exists for it. */
function startsConversation(value: unknown): boolean {
  if (!value || typeof value !== "object" || !("conversation" in value)) return false;
  const conversation = value.conversation;
  return Boolean(
    conversation && typeof conversation === "object" && "started" in conversation && conversation.started === true,
  );
}

function isStatus(value: unknown, status: string): boolean {
  return Boolean(value && typeof value === "object" && "status" in value && value.status === status);
}

function withoutKeys(record: RegisteredProjectRecord): Omit<RegisteredProjectRecord, "pk" | "sk"> {
  return {
    entityType: record.entityType,
    definition: record.definition,
    runtimeBinding: record.runtimeBinding,
    registeredBy: record.registeredBy,
    registeredAt: record.registeredAt,
  };
}

function parseStoredEvent(item: Record<string, unknown>): {
  sequence: number;
  type: string;
  timestamp: string;
  payload: unknown;
} {
  if (
    typeof item.sequence !== "number" ||
    typeof item.type !== "string" ||
    typeof item.timestamp !== "string"
  ) {
    throw agentXError("RUNTIME_UNAVAILABLE", "stored event is invalid");
  }
  return {
    sequence: item.sequence,
    type: item.type,
    timestamp: item.timestamp,
    payload: item.payload,
  };
}

function stripCode(message: string, code: string): string {
  return message.startsWith(`${code}: `) ? message.slice(code.length + 2) : message;
}

function json(
  value: unknown,
  requestId: string,
  statusCode = 200,
): { statusCode: number; headers: Record<string, string>; body: string } {
  const body = value && typeof value === "object" ? { ...value, requestId } : { data: value, requestId };
  return {
    statusCode,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify(body),
  };
}

const awsClientConfiguration = process.env.AWS_REGION === undefined ? {} : { region: process.env.AWS_REGION };
const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient(awsClientConfiguration), {
  marshallOptions: { removeUndefinedValues: true },
});
const s3 = new S3Client(awsClientConfiguration);
const agentCore = new BedrockAgentCoreClient(awsClientConfiguration);
const secretsManager = new SecretsManagerClient(awsClientConfiguration);
const codeBuild = createCodeBuildGateway(awsClientConfiguration);
const githubPrivateKeySecretArn = requiredEnvironment("GITHUB_APP_PRIVATE_KEY_SECRET_ARN");
let githubPrivateKey: Promise<string> | undefined;
const loadGitHubPrivateKey = (): Promise<string> => {
  githubPrivateKey ??= secretsManager.send(new GetSecretValueCommand({
    SecretId: githubPrivateKeySecretArn,
  })).then((response) => {
    const secret = response.SecretString ?? (
      response.SecretBinary === undefined
        ? undefined
        : Buffer.from(response.SecretBinary).toString("utf8")
    );
    if (!secret) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub App private-key secret is empty");
    return privateKeyFromSecret(secret);
  }).catch((error: unknown) => {
    githubPrivateKey = undefined;
    throw error;
  });
  return githubPrivateKey;
};
const githubCredentials = new GitHubAppCredentialProvider({
  credentialRef: requiredEnvironment("GITHUB_APP_CREDENTIAL_REF"),
  account: requiredEnvironment("GITHUB_APP_ACCOUNT"),
  appId: requiredEnvironment("GITHUB_APP_ID"),
  installationId: requiredEnvironment("GITHUB_APP_INSTALLATION_ID"),
  getPrivateKey: loadGitHubPrivateKey,
});
const repositoryGrantSigningKey = createHmac("sha256", requiredEnvironment("CALLBACK_SIGNING_KEY"))
  .update("agentx:repository-grants:v3")
  .digest();
const repositoryGrants = new RepositoryGrantService(
  repositoryGrantSigningKey,
  (credentialRef, repositoryUrl, access) => githubCredentials.resolve(credentialRef, repositoryUrl, access),
);

export const handler = createAwsBrokerHandler({
  documentClient,
  s3,
  tableName: requiredEnvironment("STATE_TABLE_NAME"),
  artifactBucketName: requiredEnvironment("ARTIFACT_BUCKET_NAME"),
  issuer: requiredEnvironment("OIDC_ISSUER"),
  adminClaim: process.env.ADMIN_CLAIM ?? "cognito:groups",
  adminValues: JSON.parse(process.env.ADMIN_VALUES ?? "[\"agentx-admin\"]") as string[],
  callbackSigningKey: requiredEnvironment("CALLBACK_SIGNING_KEY"),
  repositoryGrants,
  githubPullRequests: githubCredentials,
  githubMcp: { credentials: (repository, access) => githubCredentials.issueCredentials(repository, access) },
  codeBuild,
  ...(process.env.SLACK_ORCHESTRATOR_ROLE_ARN
    ? {
        slack: {
          orchestratorRoleArn: process.env.SLACK_ORCHESTRATOR_ROLE_ARN,
          memberWorkspaceLimit: positiveInteger(
            Number(process.env.SLACK_MEMBER_WORKSPACE_LIMIT ?? "3"),
            "SLACK_MEMBER_WORKSPACE_LIMIT",
          ),
          organizationWorkspaceLimit: positiveInteger(
            Number(process.env.SLACK_ORGANIZATION_WORKSPACE_LIMIT ?? "20"),
            "SLACK_ORGANIZATION_WORKSPACE_LIMIT",
          ),
        },
      }
    : {}),
  async stopRuntimeSession(input) {
    await agentCore.send(new StopRuntimeSessionCommand({
      agentRuntimeArn: input.runtimeArn,
      qualifier: input.endpointQualifier,
      runtimeSessionId: input.runtimeSessionId,
      clientToken: randomUUID(),
    }));
  },
  async deleteWorkspaceSession(input) {
    await deleteCapacityProviderWorkspaceSession(agentCore, input);
  },
});
