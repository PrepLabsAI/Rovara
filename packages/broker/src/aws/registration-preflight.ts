import {
  AgentXError,
  githubConnectorOf,
  type ProjectDefinition,
  type RegistrationPreflight,
} from "@agentx/contracts";
import { ConnectorNotConnected, presentCatalog, TARGET_CONFLICT_REASON, type SkippedTool } from "@agentx/gateway";
import { discoverGitHubTools, type GitHubMcpDependencies, type GitHubMcpDiscovery } from "../github-mcp.js";

const MAX_SKIPPED = 64;
const MAX_PROBLEM = 512;
const MAX_REASON = 256;

/**
 * Asks the vendor, at registration, which approved tools it offers and which cannot be presented.
 * A credential or vendor failure is reported, never thrown: the revision still registers. Only a
 * tool that could never be presented across several scopes is a refusal.
 */
export async function preflightConnectors(
  definition: ProjectDefinition,
  githubMcp: GitHubMcpDependencies | undefined,
  ownerKey: string,
): Promise<{ report: RegistrationPreflight; refusals: string[] }> {
  const github = githubConnectorOf(definition);
  if (!github) return { report: { connectors: [] }, refusals: [] };
  if (!githubMcp) return { report: { connectors: [{ name: github.name, status: "not_connected", problem: "GitHub MCP is not configured in this deployment", offered: [], skipped: [] }] }, refusals: [] };
  const settled = await Promise.allSettled(github.repositories.map((repository) => discoverGitHubTools(
    { workspaceId: "registration", ownerKey, repository, policy: github.policy, settingsRevision: definition.revision }, githubMcp,
  )));
  const notConnected = settled.find((entry): entry is PromiseRejectedResult => entry.status === "rejected" && entry.reason instanceof ConnectorNotConnected);
  const failed = settled.find((entry): entry is PromiseRejectedResult => entry.status === "rejected");
  const rejection = notConnected ?? failed;
  if (rejection) {
    const reason = rejection.reason as Error;
    // discoverTools only surfaces messages it wrote itself, so no credential reaches the report.
    const message = reason instanceof AgentXError ? withoutCode(reason.message, reason.code) : "GitHub MCP discovery failed";
    return { report: { connectors: [{
      name: github.name, status: notConnected ? "not_connected" : "unavailable",
      problem: message.slice(0, MAX_PROBLEM), offered: [], skipped: [],
    }] }, refusals: [] };
  }
  const discoveries = settled.map((entry) => (entry as PromiseFulfilledResult<GitHubMcpDiscovery>).value);
  const presented = presentCatalog({
    connector: github.name, label: "GitHub", scopeNoun: "repository", approvals: github.policy.tools,
    scopes: discoveries.map((discovery, index) => ({ alias: github.repositories[index]!.name, tools: discovery.tools.map(({ repository: scope, ...tool }) => ({ ...tool, scope })) })),
  });
  const skipped = uniqueSkipped([...discoveries.flatMap((discovery) => discovery.skipped), ...presented.skipped]);
  const refusals = github.repositories.length > 1
    ? presented.skipped.filter((entry) => entry.reason === TARGET_CONFLICT_REASON)
      .map((entry) => `connector ${github.name} tool ${entry.tool} already has a target argument and the connector has several scopes; remove its approval`)
    : [];
  return { report: { connectors: [{ name: github.name, status: "connected", offered: presented.tools.map((tool) => tool.name), skipped }] }, refusals };
}

/** The budget warning, then per connector its problem (when not connected) and each skipped tool. */
export function registrationWarnings(budgetWarning: string | undefined, report: RegistrationPreflight | undefined): string[] {
  const warnings = budgetWarning ? [budgetWarning] : [];
  for (const connector of report?.connectors ?? []) {
    if (connector.status !== "connected") warnings.push(`connector ${connector.name}: ${connector.problem ?? connector.status}`);
    for (const entry of connector.skipped) warnings.push(`connector ${connector.name}: tool ${entry.tool} skipped: ${entry.reason}`);
  }
  return warnings;
}

/** The first entry for each tool and reason pair, in order, capped at the report's limit. */
function uniqueSkipped(entries: readonly SkippedTool[]): Array<{ tool: string; reason: string }> {
  const seen = new Set<string>();
  const unique: Array<{ tool: string; reason: string }> = [];
  for (const entry of entries) {
    const key = JSON.stringify([entry.tool, entry.reason]);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ tool: entry.tool, reason: entry.reason.slice(0, MAX_REASON) });
    if (unique.length === MAX_SKIPPED) break;
  }
  return unique;
}

function withoutCode(message: string, code: string): string {
  return message.startsWith(`${code}: `) ? message.slice(code.length + 2) : message;
}
