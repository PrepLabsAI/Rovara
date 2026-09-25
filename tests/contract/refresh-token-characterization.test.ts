// Phase 7 characterization: shared behaviour the oauth-refresh-token provider and the Asana
// connector rely on, pinned before any phase 7 change. Every test here passes on mainline af67c2c
// and must keep passing, unchanged, through the phase.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  ConnectorNotConnected, CredentialUnavailable, discoverTools, executeTool,
  type ConnectorContext, type ConnectorDefinition, type Invocation, type Ledger, type McpConnection,
} from "../../packages/gateway/src/index.js";
import { adminCall, createAdminBroker } from "../support/admin-broker.js";

const githubApp = { ref: "github-app", secretName: "arn:aws:secretsmanager:us-east-1:111122223333:secret:github-key" };
const secretValues: Record<string, string> = {
  "agentx/connectors/tracker": JSON.stringify({ apiKey: "tracker-key-value" }),
  "agentx/connectors/oauth": JSON.stringify({ clientId: "id", clientSecret: "oauth-secret-value", scopes: ["read"] }),
};
const secrets = { read: vi.fn(async (name: string) => secretValues[name]) };

describe("credential registry behaviour phase 7 keeps", () => {
  it("never reports a cached token for a static-secret credential, even with a token row present", async () => {
    const { db, handler } = await createAdminBroker({ connectorCredentials: { secrets, githubApp } });
    await adminCall(handler, { method: "POST", path: "/v1/admin/credentials", body: { ref: "tracker", type: "static-secret", secretName: "agentx/connectors/tracker" } });
    db.set({ pk: "CREDENTIAL#tracker", sk: "TOKEN#abc", token: "stray-token", expiresAt: Date.now() + 3_600_000 });
    const listed = await adminCall(handler, { method: "GET", path: "/v1/admin/credentials" });
    expect(listed.body.credentials).toContainEqual(expect.objectContaining({ ref: "tracker", type: "static-secret", tokenCached: false }));
  });

  it("re-registering deletes the credential's TOKEN# rows and leaves its other rows alone", async () => {
    const { db, handler } = await createAdminBroker({ connectorCredentials: { secrets, githubApp } });
    const body = { ref: "oauth", type: "oauth-client-credentials", secretName: "agentx/connectors/oauth" };
    await adminCall(handler, { method: "POST", path: "/v1/admin/credentials", body });
    db.set({ pk: "CREDENTIAL#oauth", sk: "TOKEN#abc", token: "cached-token", expiresAt: Date.now() + 3_600_000 });
    db.set({ pk: "CREDENTIAL#oauth", sk: "LEASE#refresh", owner: "someone", expiresAt: Date.now() + 15_000 });
    await adminCall(handler, { method: "POST", path: "/v1/admin/credentials", body });
    expect(db.get("CREDENTIAL#oauth", "TOKEN#abc")).toBeUndefined();
    expect(db.get("CREDENTIAL#oauth", "LEASE#refresh")).toMatchObject({ owner: "someone" });
  });
});

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
  it("reports a credential the provider cannot issue as FAILED not_connected, with the provider's message", async () => {
    const { connector, context, ledger, connect } = connectorWith(async () => { throw new CredentialUnavailable("credential tracker: the token endpoint refused the refresh token"); });
    const result = await executeTool({ requestId: randomUUID(), scope: "payments", tool: "list_items", schemaHash: "0".repeat(64), arguments: {} }, connector, context, { ledger, connect });
    expect(result).toMatchObject({
      status: "FAILED", reason: "not_connected",
      text: "Tracker is not connected for this project: credential tracker: the token endpoint refused the refresh token. An administrator must fix its credential.",
    });
    expect(connect).not.toHaveBeenCalled();
  });

  it("reports any other provider failure as a vendor error, not as not connected", async () => {
    const { connector, context, ledger, connect } = connectorWith(async () => { throw new Error("token endpoint returned HTTP 503"); });
    const result = await executeTool({ requestId: randomUUID(), scope: "payments", tool: "list_items", schemaHash: "0".repeat(64), arguments: {} }, connector, context, { ledger, connect });
    expect(result).toMatchObject({ status: "FAILED", reason: "vendor_error", text: "Tracker MCP request failed before any write. Check Tracker key permissions and MCP availability." });
  });

  it("names the connector and the provider's message when discovery cannot get a credential", async () => {
    const { connector, context, connect } = connectorWith(async () => { throw new CredentialUnavailable("credential tracker: sign in again"); });
    await expect(discoverTools(connector, context, { connect })).rejects.toEqual(new ConnectorNotConnected("Tracker is not connected: credential tracker: sign in again"));
  });
});
