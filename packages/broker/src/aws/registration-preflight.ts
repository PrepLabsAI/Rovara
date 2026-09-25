import { AgentXError, itemPathProblems, type ConnectorPreflight, type ProjectDefinition, type RegistrationPreflight } from "@agentx/contracts";
import { ConnectorNotConnected, presentCatalog, TARGET_CONFLICT_REASON, type SkippedTool } from "@agentx/gateway";
import { discoverScope, stripCode, type ConnectorContextBase, type ScopeDiscovery } from "./connector-routes.js";
import type { ResolvedConnector } from "./connector-types.js";
import type { CredentialRegistry } from "./credentials.js";

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
  let resolved: Awaited<ReturnType<ResolvedConnector["definition"]>>;
  try {
    resolved = await connector.definition();
  } catch (error) {
    // definition() is vendor-owned code (it may mint a client or read a registry); a throw there
    // is a vendor or credential failure like any other, never a reason to fail the whole registration.
    const message = error instanceof AgentXError ? stripCode(error.message, error.code) : `${connector.vendor} MCP discovery failed`;
    return { entry: { name: connector.name, status: "unavailable", problem: message.slice(0, MAX_PROBLEM), offered: [], skipped: [] }, refusals: [] };
  }
  if ("notConnected" in resolved) {
    return { entry: { name: connector.name, status: "not_connected", problem: resolved.notConnected, offered: [], skipped: [] }, refusals: [] };
  }
  // Item argument paths are the connector's own data (feature 014, R7). A malformed declaration is
  // refused here, before any vendor contact; if one were served anyway, it is served as none.
  const pathProblems = itemPathProblems(resolved.itemArguments);
  if (pathProblems.length > 0) {
    return {
      entry: { name: connector.name, status: "unavailable", problem: `connector ${connector.name} declares unusable item arguments`, offered: [], skipped: [] },
      refusals: pathProblems.map((problem) => `connector ${connector.name}: ${problem}`),
    };
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

/**
 * A new revision is refused when a connector's credential cannot work in this deployment: no
 * registry, an unregistered reference, or a provider type the connector does not accept.
 * Only the reference and type are named, never a secret.
 */
export async function credentialRefusals(connectors: readonly ResolvedConnector[], registry: CredentialRegistry | undefined): Promise<string[]> {
  const refusals: string[] = [];
  for (const connector of connectors) {
    const credential = connector.credential;
    if (!credential) continue;
    if (!registry) { refusals.push(`connector ${connector.name}: connector credentials are not configured in this deployment`); continue; }
    const type = await registry.typeOf(credential.ref);
    if (type === undefined) refusals.push(`connector ${connector.name}: credential ${credential.ref} is not registered; run agentx admin credential register first`);
    else if (!credential.accepts.includes(type)) refusals.push(`connector ${connector.name}: credential ${credential.ref} is ${type}; a ${connector.vendor} connector needs ${credential.accepts.join(" or ")}`);
  }
  return refusals;
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
