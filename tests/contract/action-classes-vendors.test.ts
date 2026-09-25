// Pins the class AgentX gives every tool in the recorded vendor catalogs (spec 014 D1), from the
// vendor's hints and each connector's declared item arguments, with no vendor name in gate code.
import { describe, expect, it } from "vitest";
import { ASANA_PROJECT_TOOL_ACCESS, schemaHasItemPath } from "../../packages/contracts/src/index.js";
import { asanaConnector, jiraConnector, linearConnector, type McpConnection } from "../../packages/gateway/src/index.js";
import { baseClass, type ToolFacts } from "../../packages/orchestrator/src/action-policy.js";
import { vendorToolsWithAnnotations, type VendorFixture } from "../support/vendor-fixtures.js";

const unused = { issue: () => { throw new Error("not used"); } };

function facts(connector: string, tool: McpConnection["tools"][number], itemArguments: readonly string[]): ToolFacts {
  const annotations = tool.annotations ?? {};
  return {
    connector, upstreamName: tool.name, access: annotations.readOnlyHint === true ? "read" : "write",
    hints: { readOnlyHint: annotations.readOnlyHint as boolean, destructiveHint: annotations.destructiveHint as boolean },
    itemArguments: itemArguments.filter((path) => schemaHasItemPath(tool.inputSchema, path)),
  };
}

/** Arguments that set one item argument path to "X-1", such as { tasks: [{ task: "X-1" }] } for tasks[].task. */
function naming(path: string): Record<string, unknown> {
  return path.split(".").reduceRight<unknown>((inner, part) => part.endsWith("[]") ? { [part.slice(0, -2)]: [inner] } : { [part]: inner }, "X-1") as Record<string, unknown>;
}

/** Every recorded tool, or only those `approvable` names (Asana's fixture is its whole tools/list). */
function classes(connector: VendorFixture, itemArguments: readonly string[], approvable?: readonly string[]) {
  const tools = vendorToolsWithAnnotations(connector).filter((tool) => approvable === undefined || approvable.includes(tool.name));
  return Object.fromEntries(tools.map((tool) => {
    const toolFacts = facts(connector, tool, itemArguments);
    const first = toolFacts.itemArguments?.[0];
    const withItem = first === undefined ? "no item argument" : baseClass(tool.name, toolFacts, naming(first));
    return [tool.name, { bare: baseClass(tool.name, toolFacts, {}), withItem }];
  }));
}

describe("the class of every recorded vendor tool", () => {
  it("Linear", () => {
    expect(classes("linear", linearConnector(unused).itemArguments!)).toEqual({
      list_issues: { bare: "read", withItem: "no item argument" },
      save_issue: { bare: "create", withItem: "change" },
      list_issue_statuses: { bare: "read", withItem: "no item argument" },
      list_documents: { bare: "read", withItem: "no item argument" },
      get_issue: { bare: "read", withItem: "read" },
      save_comment: { bare: "create", withItem: "change" },
      list_comments: { bare: "read", withItem: "no item argument" },
      list_teams: { bare: "read", withItem: "no item argument" },
      delete_comment: { bare: "destructive", withItem: "destructive" },
    });
  });

  it("Linear: closing or marking a duplicate is destructive", () => {
    const save = facts("linear", vendorToolsWithAnnotations("linear").find((tool) => tool.name === "save_issue")!, ["id"]);
    expect(baseClass("linear__save_issue", save, { id: "CHA-6", state: "Done" })).toBe("destructive");
    expect(baseClass("linear__save_issue", save, { id: "CHA-6", duplicateOf: "CHA-2" })).toBe("destructive");
    expect(baseClass("linear__save_issue", save, { id: "CHA-5", priority: 2 })).toBe("change");
  });

  it("Jira", () => {
    expect(classes("jira", jiraConnector(unused, { projectScoped: true }).itemArguments!)).toEqual({
      getJiraIssue: { bare: "read", withItem: "read" },
      searchJiraIssuesUsingJql: { bare: "read", withItem: "no item argument" },
      createJiraIssue: { bare: "create", withItem: "no item argument" },
      addOrEditJiraIssueComment: { bare: "create", withItem: "change" },
      executeRead: { bare: "read", withItem: "no item argument" },
      atlassianUserInfo: { bare: "read", withItem: "no item argument" },
      getAccessibleAtlassianResources: { bare: "read", withItem: "no item argument" },
      getConfluenceContent: { bare: "read", withItem: "no item argument" },
      editJiraIssue: { bare: "create", withItem: "change" },
      transitionJiraIssue: { bare: "destructive", withItem: "destructive" },
      // Runs any Atlassian write with no item AgentX can see: the setup guide says not to approve it.
      executeWrite: { bare: "create", withItem: "no item argument" },
    });
  });

  it("Jira: an edit that sets a status or resolution is destructive", () => {
    const edit = facts("jira", vendorToolsWithAnnotations("jira").find((tool) => tool.name === "editJiraIssue")!, ["issueIdOrKey"]);
    expect(baseClass("jira__editJiraIssue", edit, { issueIdOrKey: "PAY-7", fields: { status: "Done" } })).toBe("destructive");
    expect(baseClass("jira__editJiraIssue", edit, { issueIdOrKey: "PAY-7", fields: { summary: "x" } })).toBe("change");
  });

  // R19: the tools an Asana connector may approve, with its item paths task_id and tasks[].task.
  it("Asana", () => {
    expect(classes("asana", asanaConnector(unused).itemArguments!, Object.keys(ASANA_PROJECT_TOOL_ACCESS))).toEqual({
      get_project: { bare: "read", withItem: "no item argument" },
      search_tasks: { bare: "read", withItem: "no item argument" },
      get_task: { bare: "read", withItem: "read" },
      get_task_stories: { bare: "read", withItem: "read" },
      create_tasks: { bare: "create", withItem: "no item argument" },
      update_tasks: { bare: "create", withItem: "change" },
      add_comment: { bare: "create", withItem: "change" },
      get_tasks: { bare: "read", withItem: "no item argument" },
    });
  });

  it("Asana: completing a task inside update_tasks is destructive", () => {
    const update = facts("asana", vendorToolsWithAnnotations("asana").find((tool) => tool.name === "update_tasks")!, asanaConnector(unused).itemArguments!);
    expect(baseClass("asana__update_tasks", update, { tasks: [{ task: "1201", completed: true }] })).toBe("destructive");
    expect(baseClass("asana__update_tasks", update, { tasks: [{ task: "1201", name: "Renamed" }] })).toBe("change");
  });
});
