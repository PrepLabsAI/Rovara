import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  approveTools, executeTool, reviewTools, jiraBinder, jiraConnector, jiraProjectGuard, JIRA_MCP_ENDPOINT,
  type ConnectorContext, type Invocation, type JiraScope, type Ledger, type McpToolResult, type connectMcp,
} from "../../packages/gateway/src/index.js";
import { vendorTools } from "../support/vendor-fixtures.js";

const recorded = { tools: vendorTools("jira") };
/** The live getJiraIssue result (2026-09-24): `{ data: { appliedContentFormat, id, key, fields } }`. */
const issueFixture = JSON.parse(readFileSync(new URL("../fixtures/vendors/jira-get-issue.json", import.meta.url), "utf8")) as { data: Record<string, unknown> };
/** The live shape for an issue whose current key is `key`. */
const issueWithKey = (key: string) => ({ ...issueFixture, data: { ...issueFixture.data, key } });
const CLOUD = "1437bb04-4c88-4efd-9d38-658e8febfeba";
const text = (value: unknown): McpToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const APPROVALS = [
  { name: "getJiraIssue", access: "read" as const }, { name: "searchJiraIssuesUsingJql", access: "read" as const },
  { name: "createJiraIssue", access: "write" as const }, { name: "editJiraIssue", access: "write" as const },
  { name: "transitionJiraIssue", access: "write" as const }, { name: "addOrEditJiraIssueComment", access: "write" as const },
  { name: "executeWrite", access: "write" as const }, { name: "getAccessibleAtlassianResources", access: "read" as const },
];

/** A Jira connector over the recorded tools; getJiraIssue answers from `issues`. */
function jira(scope: JiraScope, issues: Record<string, unknown> = { "KAN-1": issueWithKey("KAN-1") }) {
  const connector = jiraConnector({ issue: async () => ({ token: "jira-token-value", bindings: {} }) }, { projectScoped: scope.projectKey !== undefined });
  const call = vi.fn<(name: string, args: Record<string, unknown>) => Promise<McpToolResult>>(async (name, args) => {
    if (name !== "getJiraIssue") return text({ ok: true });
    const issue = issues[String(args.issueIdOrKey)];
    return issue === undefined ? { isError: true, content: [{ type: "text", text: "Issue does not exist" }] } : typeof issue === "string" ? { content: [{ type: "text", text: issue }] } : text(issue);
  });
  const connect = vi.fn<typeof connectMcp>(async () => ({ tools: recorded.tools, call, close: async () => undefined }));
  const context: ConnectorContext<JiraScope> = { workspaceId: "w", ownerKey: "alice", scopeAlias: scope.alias, scope, policy: { tools: APPROVALS } };
  const records = new Map<string, Invocation>();
  const ledger: Ledger = {
    claim: async (record) => { if (records.has(record.requestId)) return false; records.set(record.requestId, record); return true; },
    get: async (id) => records.get(id), finish: async (record) => { records.set(record.requestId, record); },
  };
  const run = (tool: string, args: Record<string, unknown>, attribution?: string) => executeTool(
    { requestId: randomUUID(), scope: scope.alias, tool, arguments: args, schemaHash: approveTools({ tools: recorded.tools }, connector, context).find((entry) => entry.name === tool)!.schemaHash },
    connector, context, { connect, ledger, ...(attribution ? { attribution } : {}) });
  return { connector, context, call, connect, run };
}
const kan: JiraScope = { alias: "kan", cloudId: CLOUD, projectKey: "KAN" };
const vendorCalls = (call: ReturnType<typeof jira>["call"]) => call.mock.calls.map(([name, args]) => ({ name, args }));

describe("Jira connector definition", () => {
  it("targets the v2 endpoint, signs description and commentBody, and names what to check on rejection", () => {
    const { connector } = jira(kan);
    expect(JIRA_MCP_ENDPOINT.href).toBe("https://mcp.atlassian.com/v2/mcp");
    expect(connector).toMatchObject({ label: "Jira", endpoint: JIRA_MCP_ENDPOINT, attributionKeys: ["description", "commentBody"], guards: [jiraProjectGuard] });
    expect(connector.permissionsHint).toBe("the service account's API token (complete, not expired), API token authentication in the Rovo MCP server settings, and the service account's Jira project access");
  });

  it("binds cloudId strictly and projectKey only where declared, and only for a project-scoped connector", () => {
    expect(jiraBinder(true)).toMatchObject({ properties: ["cloudId"], optionalProperties: ["projectKey"] });
    expect(jiraBinder(true).bind(kan, { token: "t", bindings: {} })).toEqual({ cloudId: CLOUD, projectKey: "KAN" });
    expect(jiraBinder(false).optionalProperties).toBeUndefined();
    expect(jiraBinder(false).bind({ alias: "site", cloudId: CLOUD }, { token: "t", bindings: {} })).toEqual({ cloudId: CLOUD });
  });

  it("removes cloudId everywhere and projectKey from createJiraIssue, and skips tools without a required cloudId", () => {
    const { connector, context } = jira(kan);
    const { tools, skipped } = reviewTools({ tools: recorded.tools }, connector, context);
    expect(tools.map((tool) => tool.name)).toEqual(["getJiraIssue", "searchJiraIssuesUsingJql", "createJiraIssue", "addOrEditJiraIssueComment", "editJiraIssue", "transitionJiraIssue"]);
    for (const tool of tools) expect(Object.keys(tool.inputSchema.properties as object)).not.toContain("cloudId");
    expect(Object.keys(tools.find((tool) => tool.name === "createJiraIssue")!.inputSchema.properties as object)).not.toContain("projectKey");
    expect(skipped).toEqual([
      { tool: "getAccessibleAtlassianResources", reason: "missing server-bound property cloudId" },
      { tool: "executeWrite", reason: "missing server-bound property cloudId" },
    ]);
  });

  it("keeps projectKey for the model when the connector is not project scoped", () => {
    const site: JiraScope = { alias: "site", cloudId: CLOUD };
    const { connector, context } = jira(site);
    const create = reviewTools({ tools: recorded.tools }, connector, context).tools.find((tool) => tool.name === "createJiraIssue")!;
    expect((create.inputSchema.required as string[])).toContain("projectKey");
  });

  it("binds cloudId and projectKey on create, cloudId alone on reads, and signs the description", async () => {
    const f = jira(kan);
    expect(await f.run("createJiraIssue", { summary: "Flaky login", issueType: "Bug", description: "Fails 1 in 5." }, "Requested by Pratik in Slack")).toMatchObject({ status: "SUCCEEDED" });
    expect(f.call).toHaveBeenLastCalledWith("createJiraIssue", { summary: "Flaky login", issueType: "Bug", description: "Fails 1 in 5.\n\n—\nRequested by Pratik in Slack", cloudId: CLOUD, projectKey: "KAN" });
  });

  it("limits a search to the scope's project and refuses JQL it cannot limit", async () => {
    const f = jira(kan);
    expect(await f.run("searchJiraIssuesUsingJql", { jql: 'status = "To Do" ORDER BY created DESC' })).toMatchObject({ status: "SUCCEEDED" });
    expect(f.call).toHaveBeenLastCalledWith("searchJiraIssuesUsingJql", { jql: 'project = "KAN" AND (status = "To Do") ORDER BY created DESC', cloudId: CLOUD });
    const refused = await f.run("searchJiraIssuesUsingJql", { jql: "status = Open) OR (project = OPS" });
    expect(refused).toMatchObject({ status: "FAILED", reason: "policy_denied" });
    expect(refused.text).toBe('This JQL cannot be limited to Jira project KAN: unbalanced parentheses. AgentX adds "project = KAN" itself; send only the rest of the query.');
    expect(f.call).toHaveBeenCalledTimes(1);
  });

  it("checks an issue's project before a comment, and refuses one in another project without writing", async () => {
    const f = jira(kan, { "KAN-1": issueWithKey("KAN-1"), "OPS-3": issueWithKey("OPS-3") });
    expect(await f.run("addOrEditJiraIssueComment", { issueIdOrKey: "KAN-1", commentBody: "Deployed." }, "Requested by Pratik")).toMatchObject({ status: "SUCCEEDED" });
    expect(vendorCalls(f.call)).toEqual([
      { name: "getJiraIssue", args: { cloudId: CLOUD, issueIdOrKey: "KAN-1" } },
      { name: "addOrEditJiraIssueComment", args: { issueIdOrKey: "KAN-1", commentBody: "Deployed.\n\n—\nRequested by Pratik", cloudId: CLOUD } },
    ]);
    expect(f.connect).toHaveBeenLastCalledWith(expect.objectContaining({ tools: ["addOrEditJiraIssueComment", "getJiraIssue"] }));
    f.call.mockClear();
    const refused = await f.run("addOrEditJiraIssueComment", { issueIdOrKey: "OPS-3", commentBody: "x" });
    expect(refused).toMatchObject({ status: "FAILED", reason: "policy_denied", text: "Jira issue OPS-3 is not in project KAN. This connector works only in KAN." });
    expect(vendorCalls(f.call).map((entry) => entry.name)).toEqual(["getJiraIssue"]);
  });

  it("reads the key from the live getJiraIssue shape", async () => {
    const f = jira(kan, { "KAN-3": issueFixture });
    expect(await f.run("addOrEditJiraIssueComment", { issueIdOrKey: "KAN-3", commentBody: "x" })).toMatchObject({ status: "SUCCEEDED" });
  });

  it("follows a numeric ID or a moved issue to its current key", async () => {
    const f = jira(kan, { "10001": issueWithKey("KAN-5"), "KAN-7": issueWithKey("OPS-9") });
    expect(await f.run("getJiraIssue", { issueIdOrKey: "10001" })).toMatchObject({ status: "SUCCEEDED" });
    expect(await f.run("editJiraIssue", { issueIdOrKey: "KAN-7", fields: { summary: "x" } })).toMatchObject({ status: "FAILED", text: "Jira issue KAN-7 is not in project KAN. This connector works only in KAN." });
  });

  it.each([
    ["an issue URL", { issueIdOrKey: "https://other.atlassian.net/browse/OPS-1" }],
    ["lowercase text", { issueIdOrKey: "kan-1" }],
  ])("refuses %s before any vendor call", async (_label, args) => {
    const f = jira(kan);
    expect(await f.run("getJiraIssue", args)).toMatchObject({ status: "FAILED", reason: "policy_denied", text: "Pass the Jira issue key (for example KAN-123) or its numeric ID, not a URL or other text." });
    expect(f.call).not.toHaveBeenCalled();
  });

  it("refuses when it cannot read the issue or cannot find its key at data.key", async () => {
    const f = jira(kan, { "KAN-2": "**KAN-2** Example issue (markdown, not JSON)", "KAN-4": { key: "KAN-4", fields: {} } });
    expect((await f.run("getJiraIssue", { issueIdOrKey: "KAN-9" })).text).toBe("Could not read Jira issue KAN-9 to check its project. It may not exist, or AgentX's Jira account cannot see it.");
    expect((await f.run("getJiraIssue", { issueIdOrKey: "KAN-2" })).text).toBe("Could not confirm which project Jira issue KAN-2 is in, so AgentX did not run this call.");
    expect((await f.run("getJiraIssue", { issueIdOrKey: "KAN-4" })).text).toBe("Could not confirm which project Jira issue KAN-4 is in, so AgentX did not run this call.");
  });

  it("checks parents and refuses project changes on create, edit and transition", async () => {
    const f = jira(kan, { "KAN-1": issueWithKey("KAN-1"), "OPS-1": issueWithKey("OPS-1") });
    expect((await f.run("createJiraIssue", { summary: "s", issueType: "Sub-task", parent: "OPS-1" })).text).toBe("Jira issue OPS-1 is not in project KAN. This connector works only in KAN.");
    expect(await f.run("createJiraIssue", { summary: "s", issueType: "Sub-task", parent: "KAN-1" })).toMatchObject({ status: "SUCCEEDED" });
    expect((await f.run("createJiraIssue", { summary: "s", issueType: "Task", additional_fields: { Project: "OPS" } })).text).toBe("This connector cannot change an issue's project.");
    expect((await f.run("editJiraIssue", { issueIdOrKey: "KAN-1", fields: { parent: { key: "OPS-1" } } })).text).toBe("Jira issue OPS-1 is not in project KAN. This connector works only in KAN.");
    expect((await f.run("editJiraIssue", { issueIdOrKey: "KAN-1", fields: { parent: { set: "x" } } })).text).toBe("Give the parent as an issue key (for example KAN-10).");
    expect((await f.run("transitionJiraIssue", { issueIdOrKey: "KAN-1", transitionName: "Done", update: { project: [] } })).text).toBe("This connector cannot change an issue's project.");
  });

  it("checks rank anchors and refuses issue links and a Parent Link in another project", async () => {
    const f = jira(kan, { "KAN-1": issueWithKey("KAN-1"), "KAN-2": issueWithKey("KAN-2"), "OPS-1": issueWithKey("OPS-1") });
    expect((await f.run("editJiraIssue", { issueIdOrKey: "KAN-1", rankAfterIssue: "OPS-1" })).text).toBe("Jira issue OPS-1 is not in project KAN. This connector works only in KAN.");
    expect((await f.run("editJiraIssue", { issueIdOrKey: "KAN-1", rankBeforeIssue: "https://x/browse/OPS-1" })).text).toBe("Pass the Jira issue key (for example KAN-123) or its numeric ID, not a URL or other text.");
    f.call.mockClear();
    expect(await f.run("editJiraIssue", { issueIdOrKey: "KAN-1", rankBeforeIssue: "KAN-2" })).toMatchObject({ status: "SUCCEEDED" });
    expect(vendorCalls(f.call).map((entry) => entry.args.issueIdOrKey)).toEqual(["KAN-1", "KAN-2", "KAN-1"]);
    expect((await f.run("editJiraIssue", { issueIdOrKey: "KAN-1", fields: { "Parent Link": "OPS-1" } })).text).toBe("Jira issue OPS-1 is not in project KAN. This connector works only in KAN.");
    expect((await f.run("transitionJiraIssue", { issueIdOrKey: "KAN-1", transitionName: "Done", update: { issuelinks: [{ add: { outwardIssue: { key: "OPS-1" } } }] } })).text)
      .toBe("This connector cannot link issues, because a link can reach an issue in another project.");
    expect((await f.run("createJiraIssue", { summary: "s", issueType: "Task", additional_fields: { IssueLinks: [] } })).text)
      .toBe("This connector cannot link issues, because a link can reach an issue in another project.");
  });

  it("does not treat a longer project key with the same prefix as the scope's project", async () => {
    const f = jira(kan, { "KAN-1": issueWithKey("KANX-1") });
    expect((await f.run("getJiraIssue", { issueIdOrKey: "KAN-1" })).text).toBe("Jira issue KAN-1 is not in project KAN. This connector works only in KAN.");
  });

  it("binds and limits by the chosen scope when two scopes share a site", async () => {
    const ops: JiraScope = { alias: "ops", cloudId: CLOUD, projectKey: "OPS" };
    const f = jira(ops, { "OPS-1": issueWithKey("OPS-1") });
    await f.run("searchJiraIssuesUsingJql", { jql: "status = Open" });
    expect(f.call).toHaveBeenLastCalledWith("searchJiraIssuesUsingJql", { jql: 'project = "OPS" AND (status = Open)', cloudId: CLOUD });
    await f.run("createJiraIssue", { summary: "s", issueType: "Task" });
    expect(f.call).toHaveBeenLastCalledWith("createJiraIssue", { summary: "s", issueType: "Task", cloudId: CLOUD, projectKey: "OPS" });
  });

  it("does not look up or rewrite anything when the connector is not project scoped", async () => {
    const f = jira({ alias: "site", cloudId: CLOUD });
    await f.run("searchJiraIssuesUsingJql", { jql: "status = Open" });
    await f.run("createJiraIssue", { projectKey: "OPS", summary: "s", issueType: "Task" });
    expect(vendorCalls(f.call)).toEqual([
      { name: "searchJiraIssuesUsingJql", args: { jql: "status = Open", cloudId: CLOUD } },
      { name: "createJiraIssue", args: { projectKey: "OPS", summary: "s", issueType: "Task", cloudId: CLOUD } },
    ]);
  });

  it("refuses a create in another project even if projectKey was left to the model", async () => {
    const call = vi.fn();
    await expect(jiraProjectGuard.check({ tool: "createJiraIssue", arguments: { projectKey: "OPS", summary: "s", issueType: "Task" }, bound: { cloudId: CLOUD }, scope: kan, connection: { call } }))
      .rejects.toThrow("This connector works only in Jira project KAN.");
    await expect(jiraProjectGuard.check({ tool: "createJiraIssue", arguments: { projectKey: "KAN", summary: "s", issueType: "Task" }, bound: { cloudId: CLOUD }, scope: kan, connection: { call } }))
      .resolves.toBeUndefined();
    expect(call).not.toHaveBeenCalled();
  });

  it("refuses, in a project scope, any tool it cannot hold to the project", async () => {
    const call = vi.fn();
    await expect(jiraProjectGuard.check({ tool: "getConfluenceContent", arguments: { content_id: "1" }, bound: { cloudId: CLOUD }, scope: kan, connection: { call } }))
      .rejects.toThrow("getConfluenceContent cannot be limited to Jira project KAN, so this connector does not run it.");
    await expect(jiraProjectGuard.check({ tool: "getConfluenceContent", arguments: { content_id: "1" }, bound: { cloudId: CLOUD }, scope: { alias: "site", cloudId: CLOUD }, connection: { call } }))
      .resolves.toBeUndefined();
    expect(call).not.toHaveBeenCalled();
  });

  it("fails closed when a guard input carries no Jira scope", async () => {
    await expect(jiraProjectGuard.check({ tool: "getJiraIssue", arguments: { issueIdOrKey: "KAN-1" }, bound: { cloudId: CLOUD }, scope: undefined, connection: { call: vi.fn() } }))
      .rejects.toThrow("The Jira project check could not run, so AgentX did not run this call.");
    expect(() => jiraProjectGuard.rewrite!({ tool: "searchJiraIssuesUsingJql", arguments: { jql: "status = Open" }, bound: { cloudId: CLOUD }, scope: undefined }))
      .toThrow("The Jira project check could not run, so AgentX did not run this call.");
  });
});
