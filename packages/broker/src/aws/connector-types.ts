import { GitHubConnectorSchema, githubConnectorOf, type ProjectDefinition, type RepositoryDefinition } from "@agentx/contracts";
import { githubConnector, type ConnectorDefinition, type ConnectorPolicy, type PresentationApproval, type connectMcp } from "@agentx/gateway";
import type { GitHubMcpDependencies } from "../github-mcp.js";
import { GITHUB_LEDGER } from "./connector-ledger.js";
import type { CredentialRegistry } from "./credentials.js";

export interface ConnectorScope<Scope> { alias: string; scope: Scope }

export interface ResolvedConnector<Scope = unknown> {
  name: string;
  type: string;
  /** Thread and manifest label, for example "GitHub issues". */
  label: string;
  /** Vendor name in presented descriptions, for example "GitHub". */
  vendor: string;
  scopeNoun: string;
  scopes: ReadonlyArray<ConnectorScope<Scope>>;
  policy: ConnectorPolicy;
  approvals: readonly PresentationApproval[];
  attribution: boolean;
  ledger: { prefix: string; entityType: string };
  /** Whether this deployment can reach the connector at all; cheap, used at thread setup. */
  configured(): Promise<boolean>;
  /** The engine definition, or why the connector is not connected in this deployment. */
  definition(): Promise<ConnectorDefinition<Scope> | { notConnected: string }>;
  connect?: typeof connectMcp;
}

export interface ConnectorTypeContext {
  githubMcp?: GitHubMcpDependencies;
  credentialRegistry?: CredentialRegistry;
  /** A vendor connection override, for a connector type with no deployment connect of its own. Only test types use this today. */
  connect?: typeof connectMcp;
}

/** A stored connectors entry. Only its name and type are known before its type validates the rest. */
export type StoredConnectorConfig = { name: string; type: string } & Record<string, unknown>;

export interface ConnectorType {
  type: string;
  /** Returns `{ unusable }`, with a reason, when the configuration cannot be served by this type. */
  resolve(config: StoredConnectorConfig, project: ProjectDefinition, context: ConnectorTypeContext): ResolvedConnector | { unusable: string };
}

const GITHUB_NOT_CONFIGURED = "GitHub MCP is not configured in this deployment";

/** GitHub: one scope per repository, each using that repository's own GitHub App credential. */
export const githubConnectorType: ConnectorType = {
  type: "github",
  resolve(config, project, context) {
    // Stored data is validated here, not trusted: a malformed entry is unusable, never a throw.
    const parsed = GitHubConnectorSchema.safeParse(config);
    if (!parsed.success) {
      const fields = [...new Set(parsed.error.issues.map((issue) => issue.path[0] === undefined ? "entry" : String(issue.path[0])))];
      return { unusable: `invalid github connector configuration: ${fields.join(", ")}` };
    }
    const resolved = githubConnectorOf({ repositories: project.repositories, integrations: { connectors: [parsed.data] } });
    if (!resolved) return { unusable: "not a github connector" };
    const githubMcp = context.githubMcp;
    // The deployment's own GitHub MCP connect, if any, always wins over the context's; only a type
    // with no deployment connect of its own, such as a test type, relies on the context's.
    const connect = githubMcp?.connect ?? context.connect;
    const connector: ResolvedConnector<RepositoryDefinition> = {
      name: resolved.name,
      type: "github",
      label: "GitHub issues",
      vendor: "GitHub",
      scopeNoun: "repository",
      scopes: resolved.repositories.map((repository) => ({ alias: repository.name, scope: repository })),
      policy: resolved.policy,
      approvals: resolved.policy.tools,
      attribution: resolved.attribution,
      ledger: GITHUB_LEDGER,
      configured: () => Promise.resolve(githubMcp !== undefined),
      definition: () => Promise.resolve(githubMcp
        ? githubConnector((repository, access) => githubMcp.credentials(repository, access))
        : { notConnected: GITHUB_NOT_CONFIGURED }),
      ...(connect ? { connect } : {}),
    };
    return connector;
  },
};

/**
 * Every connector type this deployment serves when a project or a dependency override does not
 * name its own map. A type added to `ConnectorConfigSchema` without an entry here would resolve
 * as unknown and be silently dropped; a contract test checks every schema option has one.
 */
export const BUILT_IN_CONNECTOR_TYPES: Readonly<Record<string, ConnectorType>> = { github: githubConnectorType };

/**
 * Every connector the project configures that this broker can serve, in definition order. The
 * feature 007 `githubMcp` policy reads as a connector named `github` over every repository.
 */
export function resolveConnectors(
  project: ProjectDefinition,
  context: ConnectorTypeContext,
  types: Readonly<Record<string, ConnectorType>> = BUILT_IN_CONNECTOR_TYPES,
): ResolvedConnector[] {
  const legacy = project.integrations?.githubMcp;
  const configs: StoredConnectorConfig[] = legacy
    ? [{ name: "github", type: "github", scopes: "all-repositories", tools: legacy.tools }]
    : project.integrations?.connectors ?? [];
  const resolved: ResolvedConnector[] = [];
  for (const config of configs) {
    const fields = { project: project.name, revision: project.revision, connector: config.name, type: config.type };
    const type = Object.hasOwn(types, config.type) ? types[config.type] : undefined;
    if (!type) {
      console.log(JSON.stringify({ component: "broker", event: "connector.type_unknown", ...fields }));
      continue;
    }
    const result = type.resolve(config, project, context);
    if ("unusable" in result) {
      console.log(JSON.stringify({ component: "broker", event: "connector.unusable", ...fields, reason: result.unusable }));
      continue;
    }
    resolved.push(result);
  }
  return resolved;
}
