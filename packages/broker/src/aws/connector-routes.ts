import { agentXError, type ConnectorCallRequest, type ConnectorCatalog, type ConnectorResult, type SlackRequester, type WorkspaceInstance } from "@agentx/contracts";
import {
  ConnectorNotConnected,
  discoverTools,
  executeTool,
  presentCatalog,
  type CatalogCache,
  type CatalogTool,
  type ConnectorContext,
  type ConnectorDefinition,
  type Ledger,
  type ScopeCatalog,
  type SkippedTool,
} from "@agentx/gateway";
import type { ConnectorScope, ResolvedConnector } from "./connector-types.js";

/** One scope's discovered tools and the approved tools it could not offer. */
export interface ScopeDiscovery { tools: CatalogTool[]; skipped: SkippedTool[] }

/** Who a connector call or discovery is for, and the project revision whose policy authorizes it. */
export interface ConnectorContextBase {
  workspaceId: string;
  ownerKey: string;
  requestedBy?: SlackRequester;
  settingsRevision: number;
}

/** The catalog cache key shared by the connector and legacy GitHub routes. */
export function connectorCatalogKey(projectName: string, revision: number, connector: string, alias: string): string {
  return JSON.stringify([projectName, revision, connector, alias]);
}

/** Asks the vendor for one scope's tools, uncached. Registration preflight reuses it. */
export function discoverScope<Scope>(
  connector: ResolvedConnector<Scope>,
  definition: ConnectorDefinition<Scope>,
  scope: ConnectorScope<Scope>,
  context: ConnectorContextBase,
): Promise<ScopeDiscovery> {
  return discoverTools(definition, scopeContext(connector, scope, context), connector.connect ? { connect: connector.connect } : {});
}

/**
 * One scope's discovery from the cache, or from the vendor on a miss, logging (on a miss only) the
 * approved tools it cannot offer. A credential problem throws ConnectorNotConnected.
 */
export async function discoverCachedScope<Scope>(input: {
  connector: ResolvedConnector<Scope>;
  definition: ConnectorDefinition<Scope>;
  scope: ConnectorScope<Scope>;
  projectName: string;
  context: ConnectorContextBase;
  catalogs: CatalogCache<ScopeDiscovery>;
}): Promise<ScopeDiscovery> {
  const { connector, scope, projectName, context, catalogs } = input;
  const key = connectorCatalogKey(projectName, context.settingsRevision, connector.name, scope.alias);
  const cached = catalogs.get(key);
  if (cached) return cached;
  const discovery = await discoverScope(connector, input.definition, scope, context);
  if (discovery.skipped.length > 0) {
    console.log(JSON.stringify({
      component: "broker", event: "connector.tools_skipped", project: projectName,
      revision: context.settingsRevision, connector: connector.name, scope: scope.alias, skipped: discovery.skipped,
    }));
  }
  catalogs.set(key, discovery);
  return discovery;
}

/** The connector's presented catalog across its scopes, or a not-connected catalog that says why in the log. */
export async function discoverConnector(input: {
  connector: ResolvedConnector;
  workspace: WorkspaceInstance;
  context: ConnectorContextBase;
  catalogs: CatalogCache<ScopeDiscovery>;
}): Promise<ConnectorCatalog> {
  const { connector, workspace, context, catalogs } = input;
  const notConnected = (message: string, scope?: string): ConnectorCatalog => {
    console.log(JSON.stringify({
      component: "broker", event: "connector.not_connected", project: workspace.projectName,
      revision: context.settingsRevision, connector: connector.name, ...(scope === undefined ? {} : { scope }), message,
    }));
    return { connector: connector.name, notConnected: true, tools: [], skipped: [] };
  };
  const definition = await connector.definition();
  if ("notConnected" in definition) return notConnected(definition.notConnected);
  const scopes: ScopeCatalog[] = [];
  for (const scope of connector.scopes) {
    let discovery: ScopeDiscovery;
    try {
      discovery = await discoverCachedScope({ connector, definition, scope, projectName: workspace.projectName, context, catalogs });
    } catch (error) {
      if (!(error instanceof ConnectorNotConnected)) throw error;
      return notConnected(stripCode(error.message, error.code), scope.alias);
    }
    scopes.push({ alias: scope.alias, tools: discovery.tools });
  }
  const presented = presentCatalog({ connector: connector.name, label: connector.vendor, scopeNoun: connector.scopeNoun, approvals: connector.approvals, scopes });
  return { connector: connector.name, tools: presented.tools, skipped: presented.skipped };
}

/** Executes one approved tool on one scope through the gateway, with the connector's ledger. */
export async function callConnector(input: {
  connector: ResolvedConnector;
  request: ConnectorCallRequest;
  workspace: WorkspaceInstance;
  context: ConnectorContextBase;
  attribution?: string;
  ledger: Ledger;
  catalogs: CatalogCache<ScopeDiscovery>;
}): Promise<ConnectorResult> {
  const { connector, request, workspace, context, attribution, ledger, catalogs } = input;
  const revision = context.settingsRevision;
  // A malformed request (unknown scope or unapproved tool) is refused the same way whether or not
  // the connector is connected in this deployment.
  const scope = connector.scopes.find((entry) => entry.alias === request.scope);
  if (!scope) throw agentXError("NOT_FOUND", "connector scope not found");
  if (!connector.approvals.some((tool) => tool.name === request.tool)) {
    throw agentXError("FORBIDDEN", `${connector.vendor} MCP tool is not approved for this project`);
  }
  const definition = await connector.definition();
  if ("notConnected" in definition) {
    return {
      requestId: request.requestId, status: "FAILED", reason: "not_connected", truncated: false, replayed: false,
      text: `${connector.label} is not connected for this project. An administrator must configure its credential.`,
    };
  }
  return executeTool(
    { requestId: request.requestId, scope: scope.alias, tool: request.tool, schemaHash: request.schemaHash, arguments: request.arguments },
    definition,
    scopeContext(connector, scope, context),
    {
      ...(connector.connect ? { connect: connector.connect } : {}),
      ...(attribution === undefined ? {} : { attribution }),
      onAttributionDropped: attributionDroppedLog(workspace.projectName, revision, connector.name, scope.alias, request.requestId),
      onDefinitionChanged: () => catalogs.delete(connectorCatalogKey(workspace.projectName, revision, connector.name, scope.alias)),
      ledger,
    },
  );
}

/**
 * The legacy GitHub route's discovery of one repository, through the connector route's cache.
 * Feature 007 answers: a missing deployment credential or a rejected one is RUNTIME_UNAVAILABLE.
 */
export async function discoverLegacyGitHubScope(input: {
  connectors: readonly ResolvedConnector[];
  connectorName: string;
  /** Whether this deployment's type map has a `github` entry at all, independent of whether this
   * particular stored connector resolved. Distinguishes the two reasons the connector can be
   * missing from `connectors` below. */
  githubTypeKnown: boolean;
  repository: string;
  projectName: string;
  context: ConnectorContextBase;
  catalogs: CatalogCache<ScopeDiscovery>;
}): Promise<ScopeDiscovery> {
  const connector = input.connectors.find((entry) => entry.type === "github" && entry.name === input.connectorName);
  if (!connector) {
    // The revision configures a github connector (the caller checked). Either this deployment does
    // not know the github type at all, or it does but the stored config did not resolve: see the
    // connector.unusable log line resolveConnectors already wrote for the cause.
    throw agentXError("FORBIDDEN", input.githubTypeKnown
      ? "github connector configuration is not usable; see the connector.unusable log"
      : "github connector type is not available in this deployment");
  }
  const scope = connector.scopes.find((entry) => entry.alias === input.repository);
  if (!scope) throw agentXError("NOT_FOUND", "registered repository not found");
  const definition = await connector.definition();
  if ("notConnected" in definition) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub MCP is not configured");
  return discoverCachedScope({ connector, definition, scope, projectName: input.projectName, context: input.context, catalogs: input.catalogs });
}

/** One diagnostic line when a write went out without its footer; never the request's text. */
export function attributionDroppedLog(projectName: string, revision: number, connector: string, scope: string, requestId: string): (tool: string) => void {
  return (tool) => console.log(JSON.stringify({
    component: "broker", event: "connector.attribution_dropped", project: projectName,
    revision, connector, scope, tool, requestId,
  }));
}

function scopeContext<Scope>(connector: ResolvedConnector<Scope>, scope: ConnectorScope<Scope>, context: ConnectorContextBase): ConnectorContext<Scope> {
  return {
    workspaceId: context.workspaceId,
    ownerKey: context.ownerKey,
    scopeAlias: scope.alias,
    scope: scope.scope,
    policy: connector.policy,
    settingsRevision: context.settingsRevision,
    ...(context.requestedBy === undefined ? {} : { requestedBy: context.requestedBy }),
  };
}

/** An AgentXError message without its "CODE: " prefix. */
export function stripCode(message: string, code: string): string {
  return message.startsWith(`${code}: `) ? message.slice(code.length + 2) : message;
}
