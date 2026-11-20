import { describe, expect, it, vi } from "vitest";
import { ConnectorNotConnected, CredentialUnavailable, discoverTools, type ConnectorContext, type ConnectorDefinition, type Invocation, type Ledger, type McpConnection } from "../../packages/gateway/src/index.js";

interface SiteScope { alias: string; siteId: string }

function connectorWith(issue: ConnectorDefinition<SiteScope>["credentials"]["issue"]) {
  const tools: McpConnection["tools"] = [{ name: "list_items", description: "List items", inputSchema: { type: "object", properties: { siteId: { type: "string" } }, required: ["siteId"] } }];
  const connector: ConnectorDefinition<SiteScope> = {
    label: "Tracker", endpoint: new URL("https://mcp.tracker.test/mcp"), permissionsHint: "Tracker key permissions",
    credentials: { issue }, binder: { properties: ["siteId"], bind: (scope) => ({ siteId: scope.siteId }) }, guards: [],
  };
  const context: ConnectorContext<SiteScope> = {
    workspaceId: "workspace", ownerKey: "alice", scopeAlias: "payments", scope: { alias: "payments", siteId: "site-1" },
    policy: { tools: [{ name: "list_items", access: "read" }] }, requestedBy: { teamId: "T1", userId: "U1" },
  };
  const records = new Map<string, Invocation>();
  const ledger: Ledger = {
    claim: async (record) => { if (records.has(record.requestId)) return false; records.set(record.requestId, record); return true; },
    get: async (id) => records.get(id),
    finish: async (record) => { records.set(record.requestId, record); },
  };
  const connect = vi.fn(async () => ({ tools, call: vi.fn(), close: vi.fn(async () => undefined) }));
  return { connector, context, ledger, connect };
}

describe("engine reporting phase 7 relies on", () => {

  it("names the connector and the provider's message when discovery cannot get a credential", async () => {
    const { connector, context, connect } = connectorWith(async () => { throw new CredentialUnavailable("credential tracker: sign in again"); });
    await expect(discoverTools(connector, context, { connect })).rejects.toEqual(new ConnectorNotConnected("Tracker is not connected: credential tracker: sign in again"));
  });
});
