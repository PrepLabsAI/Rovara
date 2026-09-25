import { describe, expect, it, vi } from "vitest";
import {
  approveTools,
  executeTool,
  githubBinder,
  reviewTools,
  type ConnectorContext,
  type ConnectorDefinition,
  type GitHubRepositoryScope,
  type Invocation,
  type Ledger,
  type McpConnection,
  type McpToolResult,
  type connectMcp,
} from "../../packages/gateway/src/index.js";

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
