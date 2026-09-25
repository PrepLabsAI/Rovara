import { describe, expect, it, vi } from "vitest";
import {
  approveTools,
  executeTool,
  githubBinder,
  reviewTools,
  type Binder,
  type ConnectorContext,
  type ConnectorDefinition,
  type GitHubRepositoryScope,
  type Invocation,
  type Ledger,
  type McpConnection,
  type McpToolResult,
  type connectMcp,
} from "../../packages/gateway/src/index.js";
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

  it("removes owner and repo, skips a tool that lacks either or has it optional, with the same reason text and hashes", () => {
    // Recorded from the phase 5a code before the binder changed (feature 013, phase 5b).
    expect(reviewTools({ tools }, { binder: githubBinder }, context)).toEqual({
      tools: [
        {
          name: "list_issues", scope: "demo", description: "List issues in a repository",
          inputSchema: { type: "object", properties: { state: { type: "string", enum: ["open", "closed"] }, perPage: { type: "number" } }, required: ["state"], additionalProperties: false },
          schemaHash: "43f2c9dcac73ccee04c89f461ce122d302b978a4be99eb1011684950d5db9daa", access: "read",
        },
        {
          name: "issue_write", scope: "demo", description: "Create or update an issue",
          inputSchema: { type: "object", properties: { title: { type: "string" }, body: { type: "string" } }, required: ["title"], additionalProperties: false },
          schemaHash: "f93da683b3799b4e0269da48af6ff98090670b5880c363fa87c28d40bc8b26cf", access: "write",
        },
      ],
      skipped: [
        { tool: "search_issues", reason: "missing server-bound property owner" },
        { tool: "get_me", reason: "missing server-bound property owner" },
      ],
    });
  });

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

  it("changes the schema hash when the vendor adds a when-present property to a tool, so an older request is refused as schema_changed", () => {
    const before: McpConnection["tools"] = [{ name: "plain", inputSchema: { type: "object", properties: { q: { type: "string" } } } }];
    const after: McpConnection["tools"] = [{ name: "plain", inputSchema: { type: "object", properties: { q: { type: "string" }, team: { type: "string" } } } }];
    const context = contextFor(linearScope, ["plain"]);
    const old = reviewTools({ tools: before }, { binder: linearBinder }, context).tools[0]!;
    const now = reviewTools({ tools: after }, { binder: linearBinder }, context).tools[0]!;
    expect(now.inputSchema).toEqual(old.inputSchema);
    expect(now.schemaHash).not.toBe(old.schemaHash);
  });

  it("does not let a binding change the schema hash, which depends only on the vendor tool, the policy and the scope", () => {
    const tools: McpConnection["tools"] = [{ name: "plain", inputSchema: { type: "object", properties: { team: { type: "string" }, q: { type: "string" } } } }];
    const context = contextFor(linearScope, ["plain"]);
    const bound = reviewTools({ tools }, { binder: linearBinder }, context).tools[0]!;
    const unbound = reviewTools({ tools }, { binder: { properties: [], bind: () => ({}) } }, context).tools[0]!;
    expect(bound.schemaHash).toBe(unbound.schemaHash);
    expect(propertiesOf(bound)).toEqual(["q"]);
    expect(propertiesOf(unbound)).toEqual(["team", "q"]);
  });
});
