import { describe, expect, it, vi } from "vitest";
import { approveTools, executeTool, githubBinder, reviewTools, type Binder, type ConnectorContext, type ConnectorDefinition, type Guard, type GitHubRepositoryScope, type Invocation, type Ledger, type McpConnection, type McpToolResult, type connectMcp } from "../../packages/gateway/src/index.js";
import { vendorTools } from "../support/vendor-fixtures.js";

function memoryLedger(): Ledger {
  const records = new Map<string, Invocation>();
  return {
    claim: async (record) => { if (records.has(record.requestId)) return false; records.set(record.requestId, structuredClone(record)); return true; },
    get: async (id) => records.get(id),
    finish: async (record) => { records.set(record.requestId, structuredClone(record)); },
  };
}

const ok: McpToolResult = { content: [{ type: "text", text: "{\"ok\":true}" }] };

describe("GitHub binding stays byte-identical", () => {
  const tools: McpConnection["tools"] = [
    { name: "list_issues", description: "List issues in a repository", inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, state: { type: "string", enum: ["open", "closed", "all"] }, perPage: { type: "number" } }, required: ["owner", "repo"] } },
    { name: "issue_write", description: "Create or update an issue", inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, title: { type: "string" }, body: { type: "string" } }, required: ["owner", "repo", "title"] } },
    { name: "search_issues", description: "Search issues", inputSchema: { type: "object", properties: { query: { type: "string" }, owner: { type: "string" } }, required: ["query"] } },
    { name: "get_me", description: "Who am I", inputSchema: { type: "object", properties: {} } },
  ];
  const scope: GitHubRepositoryScope = { name: "demo", url: "https://github.com/example/demo.git", credentialRef: "github-app" };
  const context: ConnectorContext<GitHubRepositoryScope> = {
    workspaceId: "w", ownerKey: "o", scopeAlias: "demo", scope,
    policy: { tools: [
      { name: "list_issues", access: "read", argumentValues: { state: ["open", "closed"] } },
      { name: "issue_write", access: "write", allowedArguments: ["title", "body"] },
      { name: "search_issues", access: "read" },
      { name: "get_me", access: "read" },
    ] },
  };

  it("sends exactly the model's arguments plus owner and repo, and refuses a model-supplied owner", async () => {
    const call = vi.fn<(name: string, args: Record<string, unknown>) => Promise<McpToolResult>>(async () => ok);
    const connect = vi.fn<typeof connectMcp>(async () => ({ tools, call, close: async () => undefined }));
    const connector: ConnectorDefinition<GitHubRepositoryScope> = {
      label: "GitHub", endpoint: new URL("https://api.githubcopilot.com/mcp/"), permissionsHint: "GitHub App issue permissions",
      credentials: { issue: async () => ({ token: "installation-secret", bindings: { owner: "example", repo: "demo" } }) },
      binder: githubBinder, guards: [],
    };
    const schemaHash = approveTools({ tools }, connector, context).find((tool) => tool.name === "issue_write")!.schemaHash;
    const request = { requestId: "r-1", scope: "demo", tool: "issue_write", schemaHash, arguments: { title: "Bug" } };
    expect(await executeTool(request, connector, context, { connect, ledger: memoryLedger() })).toMatchObject({ status: "SUCCEEDED" });
    expect(call).toHaveBeenCalledExactlyOnceWith("issue_write", { title: "Bug", owner: "example", repo: "demo" });
    await expect(executeTool({ ...request, requestId: "r-2", arguments: { title: "Bug", owner: "other" } }, connector, context, { connect, ledger: memoryLedger() }))
      .rejects.toThrow(/GitHub routing arguments are server controlled/);
  });
});

interface LinearScope { alias: string; teamId: string }
interface JiraScope { alias: string; cloudId: string; projectKey: string }

const linearScope: LinearScope = { alias: "charterarc", teamId: "c408e946-78aa-4db8-923e-f78053dd954f" };
const jiraScope: JiraScope = { alias: "kan", cloudId: "1437bb04-4c88-4efd-9d38-658e8febfeba", projectKey: "KAN" };
const linearBinder: Binder<LinearScope> = { properties: [], optionalProperties: ["team", "teamId"], bind: (scope) => ({ team: scope.teamId, teamId: scope.teamId }) };
const jiraBinder: Binder<JiraScope> = { properties: ["cloudId"], optionalProperties: ["projectKey"], bind: (scope) => ({ cloudId: scope.cloudId, projectKey: scope.projectKey }) };

function contextFor<Scope extends { alias: string }>(scope: Scope, names: readonly string[], write: readonly string[] = []): ConnectorContext<Scope> {
  return {
    workspaceId: "w", ownerKey: "o", scopeAlias: scope.alias, scope,
    policy: { tools: names.map((name) => ({ name, access: write.includes(name) ? "write" as const : "read" as const })) },
  };
}

const propertiesOf = (tool: { inputSchema: Record<string, unknown> } | undefined) => Object.keys(tool!.inputSchema.properties as Record<string, unknown>);
const LINEAR_TOOLS = ["list_issues", "save_issue", "list_issue_statuses", "list_documents", "get_issue", "save_comment"];
const JIRA_TOOLS = ["getJiraIssue", "searchJiraIssuesUsingJql", "createJiraIssue", "addOrEditJiraIssueComment", "executeRead", "atlassianUserInfo"];

describe("when-present binding over real Linear tools", () => {
  const tools = vendorTools("linear");
  const review = reviewTools({ tools }, { binder: linearBinder }, contextFor(linearScope, LINEAR_TOOLS, ["save_issue", "save_comment"]));

  it("offers every approved tool, with or without a team property", () => {
    expect(review.tools.map((tool) => tool.name)).toEqual(LINEAR_TOOLS);
    expect(review.skipped).toEqual([]);
  });

  it("removes an optional team, a required team and a teamId, and leaves every other property", () => {
    const byName = (name: string) => review.tools.find((tool) => tool.name === name);
    for (const name of LINEAR_TOOLS) {
      expect(propertiesOf(byName(name))).not.toContain("team");
      expect(propertiesOf(byName(name))).not.toContain("teamId");
    }
    const upstream = (name: string) => Object.keys(tools.find((tool) => tool.name === name)!.inputSchema.properties as Record<string, unknown>);
    expect(propertiesOf(byName("list_issues"))).toEqual(upstream("list_issues").filter((name) => name !== "team"));
    expect(propertiesOf(byName("list_documents"))).toEqual(upstream("list_documents").filter((name) => name !== "teamId"));
    expect(propertiesOf(byName("get_issue"))).toEqual(upstream("get_issue"));
    expect(byName("list_issue_statuses")!.inputSchema).toEqual({ type: "object", properties: {}, required: [], $schema: "https://json-schema.org/draft/2020-12/schema", additionalProperties: false });
    expect(byName("save_comment")!.inputSchema.required).toEqual(["body"]);
  });

  it("keeps a property-level anyOf on save_issue", () => {
    const properties = review.tools.find((tool) => tool.name === "save_issue")!.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(properties.slaBreachesAt!.anyOf).toBeDefined();
  });
});

describe("required and when-present binding over real Jira tools", () => {
  const tools = vendorTools("jira");
  const review = reviewTools({ tools }, { binder: jiraBinder }, contextFor(jiraScope, JIRA_TOOLS, ["createJiraIssue", "addOrEditJiraIssueComment"]));

  it("binds cloudId on every tool and projectKey only where the tool has it", () => {
    expect(review.tools.map((tool) => tool.name)).toEqual(["getJiraIssue", "searchJiraIssuesUsingJql", "createJiraIssue", "addOrEditJiraIssueComment"]);
    const byName = (name: string) => review.tools.find((tool) => tool.name === name)!;
    expect(byName("createJiraIssue").inputSchema.required).toEqual(["summary", "issueType"]);
    expect(propertiesOf(byName("createJiraIssue"))).not.toContain("projectKey");
    expect(byName("searchJiraIssuesUsingJql").inputSchema.required).toEqual(["jql"]);
    for (const tool of review.tools) expect(propertiesOf(tool)).not.toContain("cloudId");
  });

  it("still skips a tool whose cloudId is optional or absent, with the existing reason", () => {
    expect(review.skipped).toEqual([
      { tool: "executeRead", reason: "missing server-bound property cloudId" },
      { tool: "atlassianUserInfo", reason: "missing server-bound property cloudId" },
    ]);
  });
});

describe("when-present properties the gateway cannot bind", () => {
  it("skips a tool whose when-present property is not a plain string, or is required but undefined", () => {
    const tools: McpConnection["tools"] = [
      { name: "typed", inputSchema: { type: "object", properties: { team: { type: "number" } } } },
      { name: "nullable", inputSchema: { type: "object", properties: { team: { anyOf: [{ type: "string" }, { type: "null" }] } } } },
      { name: "dangling", inputSchema: { type: "object", properties: {}, required: ["team"] } },
      { name: "plain", inputSchema: { type: "object", properties: { team: { type: "string" }, q: { type: "string" } } } },
    ];
    const review = reviewTools({ tools }, { binder: linearBinder }, contextFor(linearScope, ["typed", "nullable", "dangling", "plain"]));
    expect(review.tools.map((tool) => tool.name)).toEqual(["plain"]);
    expect(review.skipped).toEqual([
      { tool: "typed", reason: "server-bound property team is not a string" },
      { tool: "nullable", reason: "server-bound property team is not a string" },
      { tool: "dangling", reason: "server-bound property team is not a string" },
    ]);
  });

});

function vendorRig<Scope extends { alias: string }>(vendor: "linear" | "jira", binder: Binder<Scope>, scope: Scope, names: readonly string[], guards: Guard[] = []) {
  const tools = vendorTools(vendor);
  const call = vi.fn<(name: string, args: Record<string, unknown>) => Promise<McpToolResult>>(async () => ok);
  const connect = vi.fn<typeof connectMcp>(async () => ({ tools, call, close: async () => undefined }));
  const issue = vi.fn(async () => ({ token: `${vendor}-secret`, bindings: {} }));
  const connector: ConnectorDefinition<Scope> = {
    label: vendor === "linear" ? "Linear" : "Jira", endpoint: new URL(`https://mcp.${vendor}.test/mcp`), permissionsHint: "API key permissions",
    credentials: { issue },
    binder, guards,
  };
  const context = contextFor(scope, names, ["createJiraIssue", "save_issue"]);
  const ledger = memoryLedger();
  let sequence = 0;
  const request = (tool: string, args: Record<string, unknown>) => {
    sequence += 1;
    const schemaHash = approveTools({ tools }, connector, context).find((entry) => entry.name === tool)!.schemaHash;
    return { requestId: `r-${sequence}`, scope: scope.alias, tool, schemaHash, arguments: args };
  };
  const send = (built: ReturnType<typeof request>) => executeTool(built, connector, context, { connect, ledger });
  const run = (tool: string, args: Record<string, unknown>) => send(request(tool, args));
  return { call, connect, connector, issue, request, send, run };
}

describe("when-present binding at call time", () => {

  it("fails closed, without calling the vendor, when the binder has no value for a when-present property the tool has", async () => {
    const binder: Binder<LinearScope> = { properties: [], optionalProperties: ["team"], bind: () => ({}) };
    const rig = vendorRig("linear", binder, linearScope, LINEAR_TOOLS);
    expect(await rig.run("list_issues", {})).toEqual({
      requestId: "r-1", status: "FAILED", reason: "policy_denied", truncated: false, replayed: false,
      text: "Linear has no server-bound value for team. An administrator must fix the connector configuration.",
    });
    expect(await rig.run("get_issue", { id: "CHA-1" })).toMatchObject({ status: "SUCCEEDED" });
    expect(rig.call).toHaveBeenCalledExactlyOnceWith("get_issue", { id: "CHA-1" });
  });

  it("checks a name listed as both required and when-present on the required path, not the when-present one", async () => {
    // A missing value makes the required path fail the vendor schema, so the refusal text shows which
    // path ran: the when-present one would say "has no server-bound value" instead.
    const binder: Binder<JiraScope> = { properties: ["cloudId"], optionalProperties: ["cloudId", "projectKey"], bind: (scope) => ({ projectKey: scope.projectKey }) };
    const rig = vendorRig("jira", binder, jiraScope, JIRA_TOOLS);
    expect(await rig.run("getJiraIssue", { issueIdOrKey: "KAN-1" })).toMatchObject({
      status: "FAILED", reason: "policy_denied", text: "Arguments do not match the upstream MCP tool schema.",
    });
    expect(rig.call).not.toHaveBeenCalled();
  });

});

describe("guards that rewrite the model's arguments", () => {

  it("refuses a rewrite that sets a server-bound property, even one the tool does not have", async () => {
    const rig = vendorRig("jira", jiraBinder, jiraScope, JIRA_TOOLS, [{ requiredTools: () => [], check: async () => undefined, rewrite: ({ arguments: args }) => ({ ...args, projectKey: "OTHER" }) }]);
    expect(await rig.run("searchJiraIssuesUsingJql", { jql: "status = Done" })).toMatchObject({
      status: "FAILED", reason: "policy_denied", text: "Jira guard set a server-controlled argument.",
    });
    expect(rig.call).not.toHaveBeenCalled();
  });

  it("replays a rewritten write from the ledger by the model's own arguments, without rewriting or calling again", async () => {
    const rewrite = vi.fn<NonNullable<Guard["rewrite"]>>(({ arguments: args }) => ({ ...args, summary: `[KAN] ${String(args.summary)}` }));
    const rig = vendorRig("jira", jiraBinder, jiraScope, JIRA_TOOLS, [{ requiredTools: () => [], check: async () => undefined, rewrite }]);
    const request = rig.request("createJiraIssue", { summary: "Bug", issueType: "Task" });
    expect(await rig.send(request)).toMatchObject({ status: "SUCCEEDED", replayed: false });
    expect(rig.call).toHaveBeenLastCalledWith("createJiraIssue", { summary: "[KAN] Bug", issueType: "Task", cloudId: jiraScope.cloudId, projectKey: "KAN" });
    expect(await rig.send(request)).toMatchObject({ status: "SUCCEEDED", replayed: true });
    expect(rewrite).toHaveBeenCalledOnce();
    expect(rig.call).toHaveBeenCalledOnce();
  });

});
