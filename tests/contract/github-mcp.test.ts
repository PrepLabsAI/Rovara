import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { GitHubMcpRequestSchema, type GitHubMcpRequest } from "../../packages/contracts/src/github-mcp.js";
import { approvedTools, discoverGitHubTools, executeGitHubTool, type GitHubMcpContext, type GitHubMcpInvocation, type GitHubMcpStore } from "../../packages/broker/src/github-mcp.js";
import type { McpConnection, McpToolResult } from "../../packages/broker/src/mcp-client.js";

const repository = { name: "app", url: "https://github.com/acme/app.git", credentialRef: "github-app" };
const result = (value: unknown): McpToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const issue = { number: 7, html_url: "https://github.com/acme/app/issues/7", assignees: ["existing"] };
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, ...properties }, required: ["owner", "repo", ...required] });

function fixture() {
  const context: GitHubMcpContext = { workspaceId: "workspace", ownerKey: "alice", repository, policy: { tools: [
    { name: "list_issues", access: "read" },
    { name: "issue_read", access: "read", argumentValues: { method: ["get", "get_comments"] } },
    { name: "issue_write", access: "write", allowedArguments: ["method", "title", "body", "issue_number", "assignees"], argumentValues: { method: ["create", "update"] } },
    { name: "add_issue_comment", access: "write" },
  ] } };
  const tools: McpConnection["tools"] = [
    { name: "list_issues", description: "Upstream list description", inputSchema: schema({ after: { type: "string" }, perPage: { type: "integer", minimum: 1, maximum: 100 } }) },
    { name: "issue_read", description: "Upstream read description", inputSchema: schema({ method: { type: "string", enum: ["get", "get_comments", "get_parent"] }, issue_number: { type: "integer" } }, ["method", "issue_number"]) },
    { name: "issue_write", description: "Upstream issue write", inputSchema: schema({ method: { type: "string", enum: ["create", "update"] }, title: { type: "string" }, body: { type: "string" }, issue_number: { type: "integer" }, assignees: { type: "array", items: { type: "string" } }, state: { type: "string" } }, ["method"]) },
    { name: "add_issue_comment", description: "Upstream comment", inputSchema: schema({ issue_number: { type: "integer" }, body: { type: "string" } }, ["issue_number", "body"]) },
    { name: "push_files", description: "Unapproved", inputSchema: schema({}) },
  ];
  const records = new Map<string, GitHubMcpInvocation>();
  const store: GitHubMcpStore = {
    claim: async (record) => { if (records.has(record.requestId)) return false; records.set(record.requestId, structuredClone(record)); return true; },
    get: async (id) => records.get(id),
    finish: async (record) => { records.set(record.requestId, structuredClone(record)); },
  };
  const call = vi.fn<(name: string, args: Record<string, unknown>) => Promise<McpToolResult>>(async () => result(issue));
  const close = vi.fn(async () => undefined);
  const connect = vi.fn(async () => ({ tools, call, close }));
  const credentials = vi.fn(async () => ({ owner: "acme", repo: "app", token: "secret-installation-token" }));
  const request = (tool: string, args: Record<string, unknown> = {}): GitHubMcpRequest => ({ requestId: randomUUID(), repository: "app", tool, schemaHash: approvedTools({ tools }, context).find((entry) => entry.name === tool)!.schemaHash, arguments: args });
  return { context, tools, records, store, call, close, connect, credentials, request };
}

describe("dynamic GitHub MCP integration", () => {
  it("discovers descriptions/schemas, filters tools and narrows policy without hand-written definitions", async () => {
    const f = fixture();
    const catalog = await discoverGitHubTools(f.context, f);
    expect(catalog.tools.map((tool) => tool.name)).toEqual(["list_issues", "issue_read", "issue_write", "add_issue_comment"]);
    expect(catalog.tools[0]?.description).toBe("Upstream list description");
    const properties = catalog.tools[2]!.inputSchema.properties as Record<string, unknown>;
    expect(properties.owner).toBeUndefined();
    expect(properties.state).toBeUndefined();
    expect(f.close).toHaveBeenCalledOnce();
  });

  it("exposes a newly approved upstream tool with no new implementation", async () => {
    const f = fixture();
    f.tools.push({ name: "future_issue_tool", description: "A newly discovered tool", inputSchema: schema({ label: { type: "string" } }, ["label"]) });
    f.context.policy.tools.push({ name: "future_issue_tool", access: "read" });
    await discoverGitHubTools(f.context, f);
    const request = f.request("future_issue_tool", { label: "bug" });
    expect(await executeGitHubTool(request, f.context, f)).toMatchObject({ status: "SUCCEEDED" });
    expect(f.call).toHaveBeenCalledWith("future_issue_tool", { label: "bug", owner: "acme", repo: "app" });
  });

  it("validates upstream schemas and rejects unapproved methods, fields and routing", async () => {
    const f = fixture();
    expect(GitHubMcpRequestSchema.safeParse({ ...f.request("list_issues"), endpoint: "https://evil.test" }).success).toBe(false);
    await expect(executeGitHubTool(f.request("list_issues", { owner: "other" }), f.context, f)).rejects.toThrow(/server controlled/);
    expect(await executeGitHubTool(f.request("list_issues", { perPage: 101 }), f.context, f)).toMatchObject({ status: "FAILED" });
    expect(await executeGitHubTool(f.request("issue_read", { method: "get_parent", issue_number: 7 }), f.context, f)).toMatchObject({ status: "FAILED" });
    expect(await executeGitHubTool(f.request("issue_write", { method: "update", state: "closed", issue_number: 7 }), f.context, f)).toMatchObject({ status: "FAILED" });
    expect(f.call).not.toHaveBeenCalled();
  });

  it("invalidates old schema hashes when upstream definitions change", async () => {
    const f = fixture();
    const request = f.request("list_issues");
    f.tools[0]!.description = "Changed definition";
    expect(await executeGitHubTool(request, f.context, f)).toMatchObject({ status: "FAILED" });
    expect(f.call).not.toHaveBeenCalled();
  });

  it("writes once on replay and rejects changed inputs", async () => {
    const f = fixture();
    const request = f.request("issue_write", { method: "create", title: "Fix bug" });
    expect(await executeGitHubTool(request, f.context, f)).toMatchObject({ status: "SUCCEEDED" });
    expect(await executeGitHubTool(request, f.context, f)).toMatchObject({ status: "SUCCEEDED", replayed: true });
    expect(f.call).toHaveBeenCalledOnce();
    await expect(executeGitHubTool({ ...request, arguments: { method: "create", title: "Changed" } }, f.context, f)).rejects.toThrow(/IDEMPOTENCY_CONFLICT/);
  });

  it("does not repeat concurrent or interrupted writes and hides credentials", async () => {
    const f = fixture();
    let release!: () => void;
    f.call.mockImplementationOnce(async () => { await new Promise<void>((resolve) => { release = resolve; }); throw new Error("network lost secret-installation-token"); });
    const request = f.request("issue_write", { method: "create", title: "Fix bug" });
    const pending = executeGitHubTool(request, f.context, f);
    await vi.waitFor(() => expect(f.call).toHaveBeenCalledOnce());
    expect(await executeGitHubTool(request, f.context, f)).toMatchObject({ status: "IN_PROGRESS", replayed: true });
    release();
    expect(await pending).toMatchObject({ status: "UNKNOWN" });
    const replay = await executeGitHubTool(request, f.context, f);
    expect(replay.status).toBe("UNKNOWN");
    expect(JSON.stringify(replay)).not.toContain("secret-installation-token");
    expect(f.call).toHaveBeenCalledOnce();
  });

  it("forwards upstream assignment semantics instead of implementing its own assignment tool", async () => {
    const f = fixture();
    const request = f.request("issue_write", { method: "update", issue_number: 7, assignees: ["abhishek255"] });
    expect(await executeGitHubTool(request, f.context, f)).toMatchObject({ status: "SUCCEEDED" });
    expect(f.call.mock.calls[1]).toEqual(["issue_write", { owner: "acme", repo: "app", method: "update", issue_number: 7, assignees: ["abhishek255"] }]);
  });

  it("blocks issue tools from mutating a PR", async () => {
    const f = fixture();
    f.call.mockResolvedValueOnce(result({ ...issue, html_url: "https://github.com/acme/app/pull/7" }));
    expect(await executeGitHubTool(f.request("add_issue_comment", { issue_number: 7, body: "hello" }), f.context, f)).toMatchObject({ status: "FAILED" });
    expect(f.call).toHaveBeenCalledOnce();
  });

  it("treats MCP tool errors as failure/uncertainty, not success", async () => {
    const f = fixture();
    f.call.mockResolvedValue({ isError: true, content: [{ type: "text", text: "secret-installation-token" }] });
    expect(await executeGitHubTool(f.request("list_issues"), f.context, f)).toMatchObject({ status: "FAILED" });
    expect(await executeGitHubTool(f.request("issue_write", { method: "create", title: "Bug" }), f.context, f)).toMatchObject({ status: "UNKNOWN" });
  });

  it("retains a durable claim when saving the write result fails", async () => {
    const f = fixture();
    f.store.finish = async () => { throw new Error("storage unavailable"); };
    const request = f.request("issue_write", { method: "create", title: "Bug" });
    expect(await executeGitHubTool(request, f.context, f)).toMatchObject({ status: "UNKNOWN" });
    expect(await executeGitHubTool(request, f.context, f)).toMatchObject({ status: "IN_PROGRESS" });
    expect(f.call).toHaveBeenCalledOnce();
  });
});
