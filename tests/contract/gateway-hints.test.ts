// tests/contract/gateway-hints.test.ts
import { describe, expect, it } from "vitest";
import { itemPathProblems } from "../../packages/contracts/src/index.js";
import { asanaConnector, githubConnector, jiraConnector, linearBinder, linearConnector, presentCatalog, reviewTools } from "../../packages/gateway/src/index.js";
import { vendorToolsWithAnnotations } from "../support/vendor-fixtures.js";

const scope = { alias: "charterarc", teamId: "c408e946-78aa-4db8-923e-f78053dd954f" };
const approvals = [
  { name: "list_issues", access: "read" as const },
  { name: "save_issue", access: "write" as const },
  { name: "delete_comment", access: "write" as const },
];
const context = { workspaceId: "w", ownerKey: "o", scopeAlias: "charterarc", scope, policy: { tools: approvals } };

describe("vendor hints through discovery", () => {

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

  it("declares only well-formed item argument paths for every built-in connector", () => {
    const unused = { issue: () => { throw new Error("not used"); } };
    const github = githubConnector(() => { throw new Error("not used"); });
    for (const declared of [github.itemArguments, linearConnector(unused).itemArguments, jiraConnector(unused, { projectScoped: true }).itemArguments, asanaConnector(unused).itemArguments]) {
      expect(declared).toBeDefined();
      expect(itemPathProblems(declared)).toEqual([]);
    }
  });

  it("offers no item argument that an administrator's allowedArguments removed", () => {
    const narrowed = reviewTools({ tools: vendorToolsWithAnnotations("linear") }, { binder: linearBinder },
      { ...context, policy: { tools: [{ name: "save_issue", access: "write" as const, allowedArguments: ["title", "description"] }] } });
    const presented = presentCatalog({ connector: "linear", label: "Linear", scopeNoun: "team", approvals: [{ name: "save_issue" }], scopes: [{ alias: "charterarc", tools: narrowed.tools }], itemArguments: ["id"] });
    expect(presented.tools[0]!.itemArguments).toEqual([]);
  });
});
