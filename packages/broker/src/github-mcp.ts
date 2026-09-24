import type { GitHubMcpPolicy, GitHubMcpRequest, GitHubMcpResult, GitHubMcpTool, SlackRequester } from "@agentx/contracts";
import {
  approveTools,
  discoverTools,
  executeTool,
  githubBinder,
  githubConnector,
  type CatalogTool,
  type ConnectorContext,
  type GitHubIssuer,
  type GitHubRepositoryScope,
  type Invocation,
  type Ledger,
  type SkippedTool,
  type McpConnection,
  type ToolResult,
  type connectMcp,
} from "@agentx/gateway";

// Feature 007 names, kept while the broker moves to connector routes (feature 013, phase 1b).
export type GitHubMcpInvocation = Invocation;
export type GitHubMcpStore = Ledger;
export interface GitHubMcpCatalog { tools: GitHubMcpTool[] }
/** A catalog plus the approved tools that could not be offered, which the caller reports. */
export interface GitHubMcpDiscovery extends GitHubMcpCatalog { skipped: SkippedTool[] }

export interface GitHubMcpDependencies {
  credentials(repository: { url: string; credentialRef: string }, access: "read" | "write"): Promise<{ owner: string; repo: string; token: string }>;
  connect?: typeof connectMcp;
  onDefinitionChanged?: () => void;
}

export interface GitHubMcpContext {
  requestedBy?: SlackRequester;
  workspaceId: string;
  ownerKey: string;
  repository: GitHubRepositoryScope;
  policy: GitHubMcpPolicy;
  settingsRevision?: number;
}

export async function discoverGitHubTools(context: GitHubMcpContext, dependencies: GitHubMcpDependencies): Promise<GitHubMcpDiscovery> {
  const { tools, skipped } = await discoverTools(githubConnector(issuer(dependencies)), connectorContext(context), connectOption(dependencies));
  return { tools: tools.map(toGitHubTool), skipped };
}

export function approvedTools(connection: Pick<McpConnection, "tools">, context: GitHubMcpContext): GitHubMcpTool[] {
  return approveTools(connection, { binder: githubBinder }, connectorContext(context)).map(toGitHubTool);
}

/** The full gateway result, including why a call failed, for the connector routes. */
export async function executeGitHubConnectorTool(
  request: GitHubMcpRequest,
  context: GitHubMcpContext,
  dependencies: GitHubMcpDependencies & { store: GitHubMcpStore },
): Promise<ToolResult> {
  return executeTool(
    { requestId: request.requestId, scope: request.repository, tool: request.tool, schemaHash: request.schemaHash, arguments: request.arguments },
    githubConnector(issuer(dependencies)),
    connectorContext(context),
    {
      ...connectOption(dependencies),
      ...(dependencies.onDefinitionChanged === undefined ? {} : { onDefinitionChanged: dependencies.onDefinitionChanged }),
      ledger: dependencies.store,
    },
  );
}

/** Feature 007 result: the legacy route's strict schema has no reason. */
export async function executeGitHubTool(
  request: GitHubMcpRequest,
  context: GitHubMcpContext,
  dependencies: GitHubMcpDependencies & { store: GitHubMcpStore },
): Promise<GitHubMcpResult> {
  const { requestId, status, text, truncated, replayed } = await executeGitHubConnectorTool(request, context, dependencies);
  return { requestId, status, text, truncated, replayed };
}

function issuer(dependencies: GitHubMcpDependencies): GitHubIssuer {
  return (repository, access) => dependencies.credentials(repository, access);
}

function connectOption(dependencies: GitHubMcpDependencies): { connect?: typeof connectMcp } {
  return dependencies.connect === undefined ? {} : { connect: dependencies.connect };
}

function connectorContext(context: GitHubMcpContext): ConnectorContext<GitHubRepositoryScope> {
  return {
    workspaceId: context.workspaceId,
    ownerKey: context.ownerKey,
    scopeAlias: context.repository.name,
    scope: context.repository,
    policy: context.policy,
    ...(context.requestedBy === undefined ? {} : { requestedBy: context.requestedBy }),
    ...(context.settingsRevision === undefined ? {} : { settingsRevision: context.settingsRevision }),
  };
}

function toGitHubTool(tool: CatalogTool): GitHubMcpTool {
  return { name: tool.name, repository: tool.scope, description: tool.description, inputSchema: tool.inputSchema, schemaHash: tool.schemaHash, access: tool.access };
}
