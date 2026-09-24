import { AgentXError, type ConnectorPreflight, type ProjectDefinition, type RegistrationPreflight } from "@agentx/contracts";
import { ConnectorNotConnected, presentCatalog, TARGET_CONFLICT_REASON, type SkippedTool } from "@agentx/gateway";
import { discoverScope, stripCode, type ConnectorContextBase, type ScopeDiscovery } from "./connector-routes.js";
import type { ResolvedConnector } from "./connector-types.js";

const MAX_SKIPPED = 64;
const MAX_PROBLEM = 512;
const MAX_REASON = 256;

/**
 * Asks each connector's vendor, at registration, which approved tools it offers and which cannot be
 * presented. A credential or vendor failure is reported, never thrown: the revision still
 * registers. Only a tool that could never be presented across several scopes is a refusal.
 * Discovery is uncached: registration never serves or poisons the per-container catalog cache that
 * thread discovery reads.
 */
export async function preflightConnectors(
  connectors: readonly ResolvedConnector[],
  definition: ProjectDefinition,
  ownerKey: string,
): Promise<{ report: RegistrationPreflight; refusals: string[] }> {
  const results = await Promise.all(connectors.map((connector) => preflightConnector(connector, definition, ownerKey)));
  return {
    report: { connectors: results.map((result) => result.entry) },
    refusals: results.flatMap((result) => result.refusals),
  };
}

async function preflightConnector(
  connector: ResolvedConnector,
  definition: ProjectDefinition,
  ownerKey: string,
): Promise<{ entry: ConnectorPreflight; refusals: string[] }> {
  const resolved = await connector.definition();
  if ("notConnected" in resolved) {
    return { entry: { name: connector.name, status: "not_connected", problem: resolved.notConnected, offered: [], skipped: [] }, refusals: [] };
  }
  const context: ConnectorContextBase = { workspaceId: "registration", ownerKey, settingsRevision: definition.revision };
  const settled = await Promise.allSettled(connector.scopes.map((scope) => discoverScope(connector, resolved, scope, context)));
  const notConnected = settled.find((entry): entry is PromiseRejectedResult => entry.status === "rejected" && entry.reason instanceof ConnectorNotConnected);
  const failed = settled.find((entry): entry is PromiseRejectedResult => entry.status === "rejected");
  const rejection = notConnected ?? failed;
  if (rejection) {
    const reason = rejection.reason as Error;
    // discoverTools only surfaces messages it wrote itself, so no credential reaches the report.
    const message = reason instanceof AgentXError ? stripCode(reason.message, reason.code) : `${connector.vendor} MCP discovery failed`;
    return { entry: {
      name: connector.name, status: notConnected ? "not_connected" : "unavailable",
      problem: message.slice(0, MAX_PROBLEM), offered: [], skipped: [],
    }, refusals: [] };
  }
  const discoveries = settled.map((entry) => (entry as PromiseFulfilledResult<ScopeDiscovery>).value);
  const presented = presentCatalog({
    connector: connector.name, label: connector.vendor, scopeNoun: connector.scopeNoun, approvals: connector.approvals,
    scopes: connector.scopes.map((scope, index) => ({ alias: scope.alias, tools: discoveries[index]!.tools })),
  });
  const skipped = uniqueSkipped([...discoveries.flatMap((discovery) => discovery.skipped), ...presented.skipped]);
  const refusals = connector.scopes.length > 1
    ? presented.skipped.filter((entry) => entry.reason === TARGET_CONFLICT_REASON)
      .map((entry) => `connector ${connector.name} tool ${entry.tool} already has a target argument and the connector has several scopes; remove its approval`)
    : [];
  return { entry: { name: connector.name, status: "connected", offered: presented.tools.map((tool) => tool.name), skipped }, refusals };
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
