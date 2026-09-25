import { describe, expect, it } from "vitest";
import { presentCatalog, type CatalogTool } from "../../packages/gateway/src/index.js";
import { capabilitiesManifest } from "../../packages/orchestrator/src/manifest.js";
import { orchestratorSystemPrompt } from "../../packages/orchestrator/src/orchestrator.js";
import type { ConnectorCatalog } from "../../packages/contracts/src/index.js";

// Recorded shape of GitHub's issue tools after feature 007 narrowing (owner and repo removed).
const recorded = (scope: string): CatalogTool[] => [
  { name: "list_issues", scope, access: "read", schemaHash: `${scope}1`.padEnd(64, "0"), description: "List issues in a GitHub repository. For pagination, use the 'endCursor' from the previous response's 'pageInfo' in the 'after' parameter.",
    inputSchema: { type: "object", properties: { state: { type: "string", enum: ["OPEN", "CLOSED"] }, after: { type: "string" } }, required: [], additionalProperties: false } },
  { name: "issue_write", scope, access: "write", schemaHash: `${scope}2`.padEnd(64, "0"), description: "Create a new or update an existing issue in a GitHub repository.",
    inputSchema: { type: "object", properties: { method: { type: "string", enum: ["create", "update"] }, title: { type: "string" }, body: { type: "string" } }, required: ["method"], additionalProperties: false } },
];

describe("what the orchestrator sees", () => {
  it("for a two-repository project with GitHub issues", () => {
    const presented = presentCatalog({
      connector: "github", label: "GitHub", scopeNoun: "repository",
      approvals: [{ name: "list_issues" }, { name: "issue_write", description: "Create or update a GitHub issue. Not for pull requests (agentx_create_pull_request)." }],
      scopes: [{ alias: "api", tools: recorded("api") }, { alias: "web", tools: recorded("web") }],
    });
    const catalog: ConnectorCatalog = { connector: "github", tools: presented.tools, skipped: presented.skipped };
    const manifest = capabilitiesManifest({
      repositories: ["api", "web"],
      connectors: [{ name: "github", type: "github", label: "GitHub issues", scopes: ["api", "web"], connected: true }],
      catalogs: [catalog],
    });
    expect({ tools: presented.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })), skipped: presented.skipped }).toMatchSnapshot();
    expect(orchestratorSystemPrompt("Delegate every repository read, edit, build and test to the worker.", manifest)).toMatchSnapshot();
    expect(presented.tools.every((tool) => tool.description.length <= 2_048 && /^[a-zA-Z0-9_-]{1,64}$/.test(tool.name))).toBe(true);
  });

  it("for a one-team project with Linear issues", async () => {
    const { linearBinder, reviewTools } = await import("../../packages/gateway/src/index.js");
    const { vendorTools } = await import("../support/vendor-fixtures.js");
    const tools = vendorTools("linear");
    const approvals = [{ name: "list_issues", access: "read" as const }, { name: "get_issue", access: "read" as const }, { name: "save_issue", access: "write" as const }, { name: "save_comment", access: "write" as const }];
    const reviewed = reviewTools({ tools }, { binder: linearBinder }, {
      workspaceId: "w", ownerKey: "o", scopeAlias: "charterarc", scope: { alias: "charterarc", teamId: "c408e946-78aa-4db8-923e-f78053dd954f" }, policy: { tools: approvals },
    });
    const presented = presentCatalog({ connector: "linear", label: "Linear", scopeNoun: "team", approvals, scopes: [{ alias: "charterarc", tools: reviewed.tools }] });
    const catalog: ConnectorCatalog = { connector: "linear", tools: presented.tools, skipped: presented.skipped };
    const manifest = capabilitiesManifest({
      repositories: ["api"],
      connectors: [{ name: "linear", type: "linear", label: "Linear issues", scopes: ["charterarc"], connected: true }],
      catalogs: [catalog],
    });
    expect({ tools: presented.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })), skipped: presented.skipped }).toMatchSnapshot();
    expect(orchestratorSystemPrompt("Delegate every repository read, edit, build and test to the worker.", manifest)).toMatchSnapshot();
    expect(presented.tools.every((tool) => tool.description.length <= 2_048 && /^[a-zA-Z0-9_-]{1,64}$/.test(tool.name))).toBe(true);
  });
});
