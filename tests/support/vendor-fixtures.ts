// tests/support/vendor-fixtures.ts
// Real vendor tools/list output, trimmed to the tools the binding tests need.
// Recorded 2026-09-24 from https://mcp.linear.app/mcp and https://mcp.atlassian.com/v2/mcp.
// asana-tools.json is Asana's whole tools/list (39 tools), recorded 2026-09-24 from https://mcp.asana.com/v2/mcp.
import { readFileSync } from "node:fs";
import type { McpConnection } from "../../packages/gateway/src/index.js";

export type VendorFixture = "linear" | "jira" | "asana";

/** The tools a vendor offered, in its order, shaped as an MCP connection lists them. */
export function vendorTools(vendor: VendorFixture): McpConnection["tools"] {
  const raw = JSON.parse(readFileSync(new URL(`../fixtures/vendors/${vendor}-tools.json`, import.meta.url), "utf8")) as Array<{
    name: string; description?: string; inputSchema: Record<string, unknown>;
  }>;
  return raw.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

/** The same tools with the vendor's MCP annotations kept, as the SDK's listTools returns them (feature 014). */
export function vendorToolsWithAnnotations(vendor: VendorFixture): McpConnection["tools"] {
  const raw = JSON.parse(readFileSync(new URL(`../fixtures/vendors/${vendor}-tools.json`, import.meta.url), "utf8")) as Array<{
    name: string; description?: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown>;
  }>;
  return raw.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, ...(annotations === undefined ? {} : { annotations }) }));
}
