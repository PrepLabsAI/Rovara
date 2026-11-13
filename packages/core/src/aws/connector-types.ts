import { GitHubConnectorSchema, githubConnectorOf, type ProjectDefinition, type RepositoryDefinition } from "@rovara-code/contracts";
import { githubConnector } from "@agentx/gateway";
import type { ConnectorType, ResolvedConnector, StoredConnectorConfig, ConnectorTypeContext } from "../connectors/native/keys.js";
import { GITHUB_LEDGER } from "./connector-ledger.js";
import { asanaConnectorType } from "./asana-connector-type.js";
import { mcpConnectorType } from "./connector-presets.js";
import { datadogConnectorType } from "../connectors/native/datadog-connector-type.js";
import { grafanaConnectorType } from "../connectors/native/grafana-connector-type.js";
import { pagerdutyConnectorType } from "../connectors/native/pagerduty-connector-type.js";
import { sentryConnectorType } from "../connectors/native/sentry-connector-type.js";
import { vercelConnectorType } from "../connectors/native/vercel-connector-type.js";
import { jiraConnectorType } from "./jira-connector-type.js";
import { linearConnectorType } from "./linear-connector-type.js";

export type { ConnectorScope, ConnectorType, ConnectorTypeContext, ResolvedConnector, StoredConnectorConfig } from "../connectors/native/keys.js";

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
export const BUILT_IN_CONNECTOR_TYPES: Readonly<Record<string, ConnectorType>> = {
  github: githubConnectorType, linear: linearConnectorType, jira: jiraConnectorType, asana: asanaConnectorType, mcp: mcpConnectorType,
  // The native read-only connectors.
  sentry: sentryConnectorType, datadog: datadogConnectorType, grafana: grafanaConnectorType,
  pagerduty: pagerdutyConnectorType, vercel: vercelConnectorType,
};

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
