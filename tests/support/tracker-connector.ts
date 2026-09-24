// A test-only connector type: a static-secret vendor whose scopes are sites. No production code
// registers it; tests inject it to exercise the generic connector paths beside GitHub.
import type { ToolApproval } from "@agentx/gateway";
import { connectorLedgerKeys } from "../../packages/broker/src/aws/connector-ledger.js";
import type { ConnectorType, ResolvedConnector } from "../../packages/broker/src/aws/connector-types.js";

export const TRACKER_ENDPOINT = "https://mcp.tracker.test/mcp";

export interface TrackerScope { alias: string; siteId: string }

function isTrackerScope(value: unknown): value is TrackerScope {
  if (!value || typeof value !== "object") return false;
  const scope = value as Record<string, unknown>;
  return typeof scope.alias === "string" && typeof scope.siteId === "string";
}

export const trackerConnectorType: ConnectorType = {
  type: "tracker",
  resolve(config, _project, context) {
    const { credentialRef, scopes, tools } = config;
    if (typeof credentialRef !== "string") return { unusable: "credentialRef is missing" };
    if (!Array.isArray(scopes) || !scopes.every(isTrackerScope)) return { unusable: "scopes must be { alias, siteId } entries" };
    if (!Array.isArray(tools)) return { unusable: "tools are missing" };
    const approvals = tools as ToolApproval[];
    const registry = context.credentialRegistry;
    const connector: ResolvedConnector<TrackerScope> = {
      name: config.name,
      type: "tracker",
      label: "Tracker issues",
      vendor: "Tracker",
      scopeNoun: "site",
      scopes: scopes.map((scope) => ({ alias: scope.alias, scope })),
      policy: { tools: approvals },
      approvals,
      attribution: config.attribution !== false,
      ledger: connectorLedgerKeys(config.name),
      configured: async () => await registry?.has(credentialRef) ?? false,
      async definition() {
        if (!registry || !await registry.has(credentialRef)) return { notConnected: `credential ${credentialRef} is not registered` };
        return {
          label: "Tracker",
          endpoint: new URL(TRACKER_ENDPOINT),
          permissionsHint: "Tracker API key permissions",
          credentials: registry.provider(credentialRef),
          binder: { properties: ["siteId"], bind: (scope) => ({ siteId: scope.siteId }) },
          guards: [],
          attributionKeys: ["body"],
        };
      },
    };
    return connector;
  },
};
