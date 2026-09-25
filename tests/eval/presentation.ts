import type { ConnectorCatalog, ThreadConnector } from "../../packages/contracts/src/index.js";
import { githubConnector, jiraConnector, linearConnector, presentCatalog, reviewTools, type Binder, type ScopeCatalog } from "../../packages/gateway/src/index.js";
import { ORCHESTRATION_TOOL_NAMES, RECOVERY_TOOL_NAMES } from "../../packages/orchestrator/src/orchestration-tools.js";
import type { EvalConnector, EvalProject, UpstreamTool } from "./case.js";

/** Recorded catalogs already lack the binder's server-bound properties (owner and repo for GitHub). */
const RECORDED_BINDER: Binder<string> = { properties: [], bind: () => ({}) };

/** Never called: the evaluation builds connector definitions only to read their item arguments. */
const NO_CREDENTIALS = { issue: () => { throw new Error("the evaluation never reaches a vendor"); } };

/** Each built-in connector type's item arguments (spec 014 part 1), from the gateway's own definitions. */
const ITEM_ARGUMENTS: Readonly<Record<string, readonly string[] | undefined>> = {
  github: githubConnector(() => { throw new Error("the evaluation never reaches a vendor"); }).itemArguments,
  linear: linearConnector(NO_CREDENTIALS).itemArguments,
  jira: jiraConnector(NO_CREDENTIALS, { projectScoped: true }).itemArguments,
};

/**
 * The connector's scopes as the gateway's own discovery review would build them from the recorded
 * catalog: flattened schemas, allowedArguments and argumentValues applied, access from the approval.
 * An approved tool the review or the presentation drops is a fixture error and fails loudly, never
 * a smaller catalog.
 */
export function reviewedScopes(connector: EvalConnector, upstream: readonly UpstreamTool[]): ScopeCatalog[] {
  return connector.scopes.map((alias) => {
    const { tools, skipped } = reviewTools({ tools: upstream.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) }, { binder: RECORDED_BINDER }, {
      workspaceId: "evaluation", ownerKey: "evaluation", scopeAlias: alias, scope: alias, policy: connector.policy,
    });
    if (skipped.length > 0) {
      throw new Error(`connector ${connector.name} scope ${alias}: catalog ${connector.catalog} cannot offer ${skipped.map((entry) => `${entry.tool} (${entry.reason})`).join(", ")}`);
    }
    return { alias, tools };
  });
}

/** What the real orchestrator is given for a fixture project: the broker's presented catalogs and thread connectors. */
export function newPresentation(project: EvalProject, catalogs: ReadonlyMap<string, UpstreamTool[]>, options: { gateFields?: boolean } = {}): {
  repositories: string[];
  connectors: ThreadConnector[];
  catalogs: ConnectorCatalog[];
  recoverableOperations: string[];
  toolNames: string[];
} {
  const connectors: ThreadConnector[] = project.connectors.map((connector) => ({
    name: connector.name, type: connector.type, label: connector.label, scopes: connector.scopes, connected: connector.connected,
  }));
  const presented: ConnectorCatalog[] = project.connectors.filter((connector) => connector.connected).map((connector) => {
    const upstream = catalogs.get(connector.catalog);
    if (upstream === undefined) throw new Error(`no recorded catalog ${connector.catalog} for connector ${connector.name}`);
    const { tools, skipped } = presentCatalog({
      connector: connector.name, label: connector.vendor, scopeNoun: connector.scopeNoun, approvals: connector.approvals,
      scopes: reviewedScopes(connector, upstream),
      // A gate case gets each tool's item argument, as a Slack service that asks for the gate's fields does.
      ...(options.gateFields === true ? { itemArguments: ITEM_ARGUMENTS[connector.type] } : {}),
    });
    if (skipped.length > 0) {
      throw new Error(`connector ${connector.name}: the presentation skips ${skipped.map((entry) => `${entry.tool} (${entry.reason})`).join(", ")}`);
    }
    return { connector: connector.name, tools, skipped };
  });
  const recovery = project.recoverableOperations.length > 0;
  const inHouse = ORCHESTRATION_TOOL_NAMES.filter((name) => recovery || !(RECOVERY_TOOL_NAMES as readonly string[]).includes(name));
  return {
    repositories: project.repositories,
    connectors,
    catalogs: presented,
    recoverableOperations: project.recoverableOperations,
    toolNames: [...inHouse, ...presented.flatMap((catalog) => catalog.tools.map((tool) => tool.name))],
  };
}
