// tests/contract/gateway-hints.test.ts
import { describe, expect, it } from "vitest";
import { itemPathProblems } from "../../packages/contracts/src/index.js";
import { githubConnector, jiraConnector, linearBinder, linearConnector, presentCatalog, reviewTools, type CatalogTool } from "../../packages/gateway/src/index.js";
import { vendorTools, vendorToolsWithAnnotations } from "../support/vendor-fixtures.js";

const scope = { alias: "charterarc", teamId: "c408e946-78aa-4db8-923e-f78053dd954f" };
const approvals = [
  { name: "list_issues", access: "read" as const },
  { name: "save_issue", access: "write" as const },
  { name: "delete_comment", access: "write" as const },
];
const context = { workspaceId: "w", ownerKey: "o", scopeAlias: "charterarc", scope, policy: { tools: approvals } };

describe("vendor hints through discovery", () => {
  it("keeps readOnlyHint and destructiveHint from the recorded Linear annotations, and nothing else", () => {
    const reviewed = reviewTools({ tools: vendorToolsWithAnnotations("linear") }, { binder: linearBinder }, context);
    expect(reviewed.tools.map((tool) => [tool.name, tool.hints])).toEqual([
      ["list_issues", { readOnlyHint: true, destructiveHint: false }],
      ["save_issue", { readOnlyHint: false, destructiveHint: true }],
      ["delete_comment", { readOnlyHint: false, destructiveHint: true }],
    ]);
  });

  it("adds no hints when the vendor sent none, or sent them as something other than booleans", () => {
    expect(reviewTools({ tools: vendorTools("linear") }, { binder: linearBinder }, context).tools.every((tool) => !("hints" in tool))).toBe(true);
    const odd = vendorToolsWithAnnotations("linear").map((tool) => ({ ...tool, annotations: { readOnlyHint: "yes", destructiveHint: 1 } }));
    expect(reviewTools({ tools: odd }, { binder: linearBinder }, context).tools.every((tool) => !("hints" in tool))).toBe(true);
  });

  it("merges hints across scopes, keeping the stricter reading", () => {
    const tool = (alias: string, hints?: CatalogTool["hints"]): CatalogTool => ({
      name: "close_item", scope: alias, description: "Close an item.", access: "write", schemaHash: alias.padEnd(64, "0"),
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
      ...(hints === undefined ? {} : { hints }),
    });
    const present = (first?: CatalogTool["hints"], second?: CatalogTool["hints"]) => presentCatalog({
      connector: "tracker", label: "Tracker", scopeNoun: "site", approvals: [{ name: "close_item" }],
      scopes: [{ alias: "payments", tools: [tool("payments", first)] }, { alias: "billing", tools: [tool("billing", second)] }],
    }).tools[0]!.hints;
    expect(present({ readOnlyHint: false, destructiveHint: true }, { readOnlyHint: false, destructiveHint: false })).toEqual({ readOnlyHint: false, destructiveHint: true });
    expect(present({ readOnlyHint: true, destructiveHint: false }, { readOnlyHint: true, destructiveHint: false })).toEqual({ readOnlyHint: true, destructiveHint: false });
    expect(present({ readOnlyHint: true }, undefined)).toBeUndefined();
    expect(present(undefined, undefined)).toBeUndefined();
  });

  it("names the argument through which each presented tool addresses an existing item, from the connector's data", () => {
    const unused = { issue: () => { throw new Error("not used"); } };
    const reviewed = reviewTools({ tools: vendorToolsWithAnnotations("linear") }, { binder: linearBinder }, context);
    const presented = presentCatalog({
      connector: "linear", label: "Linear", scopeNoun: "team", approvals: approvals.map(({ name }) => ({ name })),
      scopes: [{ alias: "charterarc", tools: reviewed.tools }], itemArguments: linearConnector(unused).itemArguments,
    });
    expect(presented.tools.map((tool) => [tool.name, tool.itemArguments])).toEqual([
      ["linear__list_issues", []], ["linear__save_issue", ["id"]], ["linear__delete_comment", ["id"]],
    ]);
    expect(jiraConnector(unused, { projectScoped: true }).itemArguments).toEqual(["issueIdOrKey"]);
    const undeclared = presentCatalog({ connector: "linear", label: "Linear", scopeNoun: "team", approvals: [{ name: "save_issue" }], scopes: [{ alias: "charterarc", tools: reviewed.tools }] });
    expect(undeclared.tools[0]).not.toHaveProperty("itemArguments");
  });

  it("names GitHub's issue and pull request arguments as the official GitHub MCP server spells them", () => {
    // Shaped like github/github-mcp-server: pkg/github/pullrequests.go names the pull request
    // argument "pullNumber" (merge_pull_request, update_pull_request, pull_request_read, the review
    // tools); pkg/github/issues.go names the issue argument "issue_number".
    const tool = (name: string, properties: string[]): CatalogTool => ({
      name, scope: "demo", description: name, access: "write", schemaHash: name.padEnd(64, "0"),
      inputSchema: { type: "object", properties: Object.fromEntries(properties.map((property) => [property, { type: property === "pullNumber" || property === "issue_number" ? "number" : "string" }])), required: properties, additionalProperties: false },
    });
    const tools = [tool("merge_pull_request", ["owner", "repo", "pullNumber"]), tool("issue_write", ["owner", "repo", "issue_number", "method"]), tool("create_pull_request", ["owner", "repo", "title", "head", "base"])];
    const presented = presentCatalog({
      connector: "github", label: "GitHub", scopeNoun: "repository", approvals: tools.map(({ name }) => ({ name })),
      scopes: [{ alias: "demo", tools }], itemArguments: githubConnector(() => { throw new Error("not used"); }).itemArguments,
    });
    expect(presented.tools.map((entry) => [entry.name, entry.itemArguments])).toEqual([
      ["github__merge_pull_request", ["pullNumber"]], ["github__issue_write", ["issue_number"]], ["github__create_pull_request", []],
    ]);
  });

  it("declares only well-formed item argument paths for every built-in connector", () => {
    const unused = { issue: () => { throw new Error("not used"); } };
    const github = githubConnector(() => { throw new Error("not used"); });
    for (const declared of [github.itemArguments, linearConnector(unused).itemArguments, jiraConnector(unused, { projectScoped: true }).itemArguments]) {
      expect(declared).toBeDefined();
      expect(itemPathProblems(declared)).toEqual([]);
    }
  });

  it("offers an item argument path inside an array of objects, and serves a malformed declaration as none", () => {
    const tool: CatalogTool = {
      name: "update_items", scope: "payments", description: "Update items.", access: "write", schemaHash: "a".repeat(64),
      inputSchema: { type: "object", properties: { items: { type: "array", items: { type: "object", properties: { item: { type: "string" }, completed: { type: "boolean" } } } } }, additionalProperties: false },
    };
    const present = (itemArguments: readonly string[]) => presentCatalog({
      connector: "tracker", label: "Tracker", scopeNoun: "site", approvals: [{ name: "update_items" }], scopes: [{ alias: "payments", tools: [tool] }], itemArguments,
    }).tools[0]!;
    expect(present(["item_id", "items[].item"]).itemArguments).toEqual(["items[].item"]);
    expect(present(["items.item"]).itemArguments).toEqual([]);
    expect(present(["item_id", "items[]"])).not.toHaveProperty("itemArguments");
  });

  it("offers no item argument that an administrator's allowedArguments removed", () => {
    const narrowed = reviewTools({ tools: vendorToolsWithAnnotations("linear") }, { binder: linearBinder },
      { ...context, policy: { tools: [{ name: "save_issue", access: "write" as const, allowedArguments: ["title", "description"] }] } });
    const presented = presentCatalog({ connector: "linear", label: "Linear", scopeNoun: "team", approvals: [{ name: "save_issue" }], scopes: [{ alias: "charterarc", tools: narrowed.tools }], itemArguments: ["id"] });
    expect(presented.tools[0]!.itemArguments).toEqual([]);
  });
});
