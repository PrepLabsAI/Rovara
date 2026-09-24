import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  approveTools,
  type ConnectorContext,
  type ConnectorDefinition,
  type Guard,
  type Invocation,
  type Ledger,
  type McpConnection,
  type McpToolResult,
  type ToolRequest,
} from "../../packages/gateway/src/index.js";

interface TrackerScope { alias: string; siteId: string }

const scope: TrackerScope = { alias: "payments", siteId: "site-42" };
const text = (value: unknown): McpToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties: { siteId: { type: "string" }, ...properties },
  required: ["siteId", ...required],
});

function fixture(guards: Guard[] = []) {
  const tools: McpConnection["tools"] = [
    { name: "list_items", description: "List items", inputSchema: schema({ state: { type: "string", enum: ["open", "closed", "archived"] } }) },
    { name: "create_item", description: "Create an item", inputSchema: schema({ title: { type: "string" }, priority: { type: "string" } }, ["title"]) },
    { name: "unscoped", description: "No site property", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
    { name: "composed", description: "Uses allOf", inputSchema: { ...schema({}), allOf: [] } },
    { name: "unapproved", description: "Not in policy", inputSchema: schema({}) },
  ];
  const issue = vi.fn<ConnectorDefinition<TrackerScope>["credentials"]["issue"]>(async () => ({ token: "tracker-secret-token", bindings: {} }));
  const connector: ConnectorDefinition<TrackerScope> = {
    label: "Tracker",
    endpoint: new URL("https://mcp.tracker.test/mcp"),
    permissionsHint: "Tracker key permissions",
    credentials: { issue },
    binder: { properties: ["siteId"], bind: (value) => ({ siteId: value.siteId }) },
    guards,
  };
  const context: ConnectorContext<TrackerScope> = {
    workspaceId: "workspace", ownerKey: "alice", scopeAlias: scope.alias, scope,
    policy: { tools: [
      { name: "list_items", access: "read", argumentValues: { state: ["open", "closed"] } },
      { name: "create_item", access: "write", allowedArguments: ["title"] },
      { name: "unscoped", access: "read" },
      { name: "composed", access: "read" },
    ] },
  };
  const records = new Map<string, Invocation>();
  const ledger: Ledger = {
    claim: async (record) => { if (records.has(record.requestId)) return false; records.set(record.requestId, structuredClone(record)); return true; },
    get: async (id) => records.get(id),
    finish: async (record) => { records.set(record.requestId, structuredClone(record)); },
  };
  const call = vi.fn<(name: string, args: Record<string, unknown>) => Promise<McpToolResult>>(async () => text({ ok: true }));
  const close = vi.fn(async () => undefined);
  const connect = vi.fn(async (_options: { tools: readonly string[]; token: string }) => ({ tools, call, close }));
  const request = (tool: string, args: Record<string, unknown> = {}): ToolRequest => ({
    requestId: randomUUID(), scope: "payments", tool, arguments: args,
    schemaHash: approveTools({ tools }, connector, context).find((entry) => entry.name === tool)!.schemaHash,
  });
  return { tools, issue, connector, context, records, ledger, call, close, connect, request };
}

describe("gateway tool approval", () => {
  it("removes bound properties and skips tools it cannot bind or represent", () => {
    const f = fixture();
    const catalog = approveTools({ tools: f.tools }, f.connector, f.context);
    expect(catalog.map((tool) => tool.name)).toEqual(["list_items", "create_item"]);
    expect(catalog.every((tool) => tool.scope === "payments")).toBe(true);
    const list = catalog[0]!.inputSchema;
    expect((list.properties as Record<string, unknown>).siteId).toBeUndefined();
    expect(list.required).toEqual(["state"]);
    expect((list.properties as Record<string, { enum: string[] }>).state.enum).toEqual(["open", "closed"]);
    expect((catalog[1]!.inputSchema.properties as Record<string, unknown>).priority).toBeUndefined();
    expect(catalog[1]!.access).toBe("write");
  });
});

export { createHash, fixture, text };
