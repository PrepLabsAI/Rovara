import { describe, expect, it } from "vitest";
import {
  ConnectorCallRequestSchema,
  ConnectorCatalogSchema,
  ConnectorResultSchema,
  SlackThreadWorkspaceResultSchema,
  ToolApprovalSchema,
} from "../../packages/contracts/src/index.js";

const hash = "a".repeat(64);

describe("connector contracts", () => {
  it("accepts description overrides and up to three examples on an approval", () => {
    expect(ToolApprovalSchema.parse({ name: "list_issues", access: "read", description: "List issues.", examples: [{ state: "OPEN" }] }))
      .toMatchObject({ description: "List issues." });
    expect(ToolApprovalSchema.safeParse({ name: "list_issues", access: "read", examples: [{}, {}, {}, {}] }).success).toBe(false);
    expect(ToolApprovalSchema.safeParse({ name: "list_issues", access: "read", description: "x".repeat(1_025) }).success).toBe(false);
  });

  it("describes a presented catalog, a call and a result with a reason", () => {
    const catalog = ConnectorCatalogSchema.parse({
      connector: "github",
      tools: [{ name: "github__list_issues", upstreamName: "list_issues", description: "List.", access: "read",
        inputSchema: { type: "object", properties: {} }, scopes: [{ alias: "demo", schemaHash: hash }] }],
      skipped: [{ tool: "issue_write", reason: "not offered by the vendor" }],
    });
    expect(catalog.tools[0]?.scopes[0]?.alias).toBe("demo");
    expect(ConnectorCatalogSchema.safeParse({ connector: "github", notConnected: true, tools: [], skipped: [] }).success).toBe(true);
    expect(ConnectorCallRequestSchema.safeParse({ requestId: crypto.randomUUID(), scope: "demo", tool: "list_issues", schemaHash: hash, arguments: {}, endpoint: "x" }).success).toBe(false);
    expect(ConnectorResultSchema.parse({ requestId: crypto.randomUUID(), status: "FAILED", reason: "not_connected", text: "Not connected.", truncated: false, replayed: false }).reason)
      .toBe("not_connected");
    expect(ConnectorCatalogSchema.safeParse({ connector: "github", tools: [{ name: "has space", upstreamName: "x", description: "", access: "read", inputSchema: {}, scopes: [{ alias: "demo", schemaHash: hash }] }], skipped: [] }).success).toBe(false);
  });

  it("carries connectors and repositories on a thread workspace result", () => {
    const result = SlackThreadWorkspaceResultSchema.parse({
      outcome: "WORKSPACE", workspaceId: crypto.randomUUID(), status: "READY", operationId: null, created: false,
      orchestratorInstructions: "Delegate.", repositories: ["demo"],
      connectors: [{ name: "github", type: "github", label: "GitHub issues", scopes: ["demo"], connected: true }],
    });
    expect(result.outcome === "WORKSPACE" && result.connectors?.[0]?.label).toBe("GitHub issues");
  });
});
