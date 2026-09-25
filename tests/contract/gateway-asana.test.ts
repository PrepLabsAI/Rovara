// tests/contract/gateway-asana.test.ts
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { ASANA_PROJECT_TOOL_ACCESS } from "../../packages/contracts/src/index.js";
import {
  ASANA_ITEM_ARGUMENTS, ASANA_MCP_ENDPOINT, ASANA_TASK_REFERENCES, ASANA_TOKEN_ENDPOINT, asanaBinder, asanaConnector, asanaProjectGuard, executeTool, GuardRejection, reviewTools,
  type AsanaProjectScope, type ConnectorContext, type Invocation, type Ledger, type McpToolResult, type ToolApproval,
} from "../../packages/gateway/src/index.js";
import { vendorTools } from "../support/vendor-fixtures.js";

const PROJECT = "1210000000000010";
const OTHER_PROJECT = "1210000000000020";
const scope: AsanaProjectScope = { alias: "payments", projectGid: PROJECT };
const GET_TASK = JSON.parse(readFileSync(new URL("../fixtures/vendors/asana-get-task.json", import.meta.url), "utf8")) as { data: Record<string, unknown> };

/** The get_task shape for a task in the given projects, optionally a subtask of `parent`. */
const taskResult = (gid: string, projects: string[], parent?: string): McpToolResult => ({
  content: [{ type: "text", text: JSON.stringify({ data: {
    ...GET_TASK.data, gid,
    projects: projects.map((project) => ({ gid: project, name: "Project" })),
    memberships: projects.map((project) => ({ project: { gid: project, name: "Project" } })),
    parent: parent === undefined ? null : { gid: parent, name: "Parent" },
  } }) }],
});

const approvals: ToolApproval[] = Object.entries(ASANA_PROJECT_TOOL_ACCESS).map(([name, access]) => ({ name, access }));

/** Tasks the fake knows: GID to projects and parent. */
const TASKS: Record<string, { projects: string[]; parent?: string }> = {
  "1210000000000101": { projects: [PROJECT] },
  "1210000000000102": { projects: [PROJECT, OTHER_PROJECT] },
  "1210000000000201": { projects: [OTHER_PROJECT] },
  "1210000000000301": { projects: [], parent: "1210000000000101" },
  "1210000000000302": { projects: [], parent: "1210000000000301" },
  "1210000000000401": { projects: [], parent: "1210000000000201" },
};

function harness(options: { policy?: ToolApproval[]; getTask?: (gid: string) => McpToolResult } = {}) {
  const tools = vendorTools("asana");
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  const call = vi.fn(async (name: string, args: Record<string, unknown>): Promise<McpToolResult> => {
    calls.push({ name, arguments: args });
    if (name === "get_task") {
      const gid = String(args.task_id);
      if (options.getTask) return options.getTask(gid);
      const task = TASKS[gid];
      return task ? taskResult(gid, task.projects, task.parent) : { isError: true, content: [{ type: "text", text: "Not found" }] };
    }
    return { content: [{ type: "text", text: JSON.stringify({ data: { ok: true } }) }] };
  });
  const connect = vi.fn(async (input: { endpoint: URL; tools: readonly string[] }) => {
    expect(input.endpoint.href).toBe(ASANA_MCP_ENDPOINT.href);
    return { tools: tools.filter((tool) => input.tools.includes(tool.name)), call, close: vi.fn(async () => undefined) };
  });
  const connector = asanaConnector({ issue: async () => ({ token: "asana-access-token-value", bindings: {} }) });
  const context: ConnectorContext<AsanaProjectScope> = {
    workspaceId: "workspace", ownerKey: "owner", scopeAlias: "payments", scope, policy: { tools: options.policy ?? approvals },
    requestedBy: { teamId: "T1", userId: "U1" },
  };
  const records = new Map<string, Invocation>();
  const ledger: Ledger = {
    claim: async (record) => { if (records.has(record.requestId)) return false; records.set(record.requestId, record); return true; },
    get: async (id) => records.get(id),
    finish: async (record) => { records.set(record.requestId, record); },
  };
  const reviewed = reviewTools({ tools }, connector, context);
  const hash = (tool: string) => reviewed.tools.find((entry) => entry.name === tool)!.schemaHash;
  const run = (tool: string, args: Record<string, unknown>) => executeTool(
    { requestId: randomUUID(), scope: "payments", tool, schemaHash: hash(tool), arguments: args },
    connector, context, { ledger, connect, attribution: "Requested by Slack member U1 via AgentX" },
  );
  const writes = () => calls.filter((entry) => entry.name !== "get_task" && ASANA_PROJECT_TOOL_ACCESS[entry.name as keyof typeof ASANA_PROJECT_TOOL_ACCESS] === "write");
  return { reviewed, run, calls, writes, connect };
}

describe("Asana connector definition", () => {
  it("talks to Asana's MCP server and refreshes at Asana's token endpoint", () => {
    expect(ASANA_MCP_ENDPOINT.href).toBe("https://mcp.asana.com/v2/mcp");
    expect(ASANA_TOKEN_ENDPOINT.href).toBe("https://app.asana.com/-/oauth_token");
    expect(asanaConnector({ issue: vi.fn() })).toMatchObject({ label: "Asana", attributionKeys: ["text"] });
  });

  it("offers all eight guarded tools from the recorded catalog with the project arguments removed", () => {
    const { reviewed } = harness();
    expect(reviewed.skipped).toEqual([]);
    expect(reviewed.tools.map((tool) => tool.name).sort()).toEqual(Object.keys(ASANA_PROJECT_TOOL_ACCESS).sort());
    const properties = (tool: string) => Object.keys(reviewed.tools.find((entry) => entry.name === tool)!.inputSchema.properties as Record<string, unknown>);
    expect(properties("get_tasks")).not.toContain("project");
    expect(properties("get_project")).not.toContain("project_id");
    expect(properties("create_tasks")).not.toContain("default_project");
    expect(properties("search_tasks")).not.toContain("projects_any");
    expect(properties("get_task")).toContain("task_id");
    expect(asanaBinder.properties).toEqual([]);
  });

  it("declares task_id as the item argument for spec 014, and every top-level task reference uses it", () => {
    expect(ASANA_ITEM_ARGUMENTS).toEqual(["task_id"]);
    const topLevel = Object.values(ASANA_TASK_REFERENCES).flat().filter((path) => path.length === 1).map((path) => path[0]);
    expect(new Set(topLevel)).toEqual(new Set(ASANA_ITEM_ARGUMENTS));
  });
});

describe("Asana project guard", () => {
  it("binds the project on lists, searches and project reads", async () => {
    const { run, calls } = harness();
    expect(await run("get_tasks", { completed_since: "2026-09-01T00:00:00Z" })).toMatchObject({ status: "SUCCEEDED" });
    expect(await run("search_tasks", { text: "login", completed: false })).toMatchObject({ status: "SUCCEEDED" });
    expect(await run("get_project", {})).toMatchObject({ status: "SUCCEEDED" });
    expect(calls).toEqual([
      { name: "get_tasks", arguments: { completed_since: "2026-09-01T00:00:00Z", project: PROJECT } },
      { name: "search_tasks", arguments: { text: "login", completed: false, projects_any: PROJECT } },
      { name: "get_project", arguments: { project_id: PROJECT } },
    ]);
  });

  it("refuses a model-supplied project on any tool before connecting", async () => {
    const { run, connect } = harness();
    await expect(run("get_tasks", { project: OTHER_PROJECT })).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("Asana routing arguments are server controlled") as unknown });
    await expect(run("search_tasks", { projects_any: `${PROJECT},${OTHER_PROJECT}` })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(connect).not.toHaveBeenCalled();
  });

  it("refuses get_tasks filters that would replace the project context", async () => {
    const { run, calls } = harness();
    for (const args of [{ tag: "1210000000000900" }, { section: "1210000000000901" }, { user_task_list: "1210000000000902" }, { assignee: "me" }]) {
      const result = await run("get_tasks", args);
      expect(result).toMatchObject({ status: "FAILED", reason: "policy_denied" });
      expect(result.text).toContain("works only in the payments project");
    }
    expect(calls).toEqual([]);
  });

  it("reads and comments on a task in the project, signing only the plain-text comment", async () => {
    const { run, calls } = harness();
    expect(await run("get_task", { task_id: "1210000000000101" })).toMatchObject({ status: "SUCCEEDED" });
    expect(await run("add_comment", { task_id: "1210000000000102", text: "Fixed in main." })).toMatchObject({ status: "SUCCEEDED" });
    expect(calls.map((entry) => entry.name)).toEqual(["get_task", "get_task", "get_task", "add_comment"]);
    expect(calls[1]).toEqual({ name: "get_task", arguments: { task_id: "1210000000000101" } });
    expect(calls[3]!.arguments).toEqual({ task_id: "1210000000000102", text: "Fixed in main.\n\n—\nRequested by Slack member U1 via AgentX" });
  });

  it("refuses to comment on, read or list the stories of a task in another project, and writes nothing", async () => {
    const { run, writes } = harness();
    for (const [tool, args] of [["add_comment", { task_id: "1210000000000201", text: "x" }], ["get_task", { task_id: "1210000000000201" }], ["get_task_stories", { task_id: "1210000000000201" }]] as const) {
      const result = await run(tool, args);
      expect(result).toMatchObject({ status: "FAILED", reason: "policy_denied", text: "Asana task 1210000000000201 is not in the payments project this connector may use." });
    }
    expect(writes()).toEqual([]);
  });

  it("follows a subtask up to its parent's project, at most three levels", async () => {
    const { run, calls } = harness();
    expect(await run("add_comment", { task_id: "1210000000000302", text: "x" })).toMatchObject({ status: "SUCCEEDED" });
    expect(calls.filter((entry) => entry.name === "get_task").map((entry) => entry.arguments.task_id)).toEqual(["1210000000000302", "1210000000000301", "1210000000000101"]);
    expect(await run("add_comment", { task_id: "1210000000000401", text: "x" })).toMatchObject({ status: "FAILED", reason: "policy_denied" });
  });

  it("fails closed when the task cannot be read, has an unexpected shape, or is a different task", async () => {
    const notFound = await harness().run("add_comment", { task_id: "1210000000000999", text: "x" });
    expect(notFound).toMatchObject({ status: "FAILED", reason: "policy_denied", text: "Asana task 1210000000000999 was not found or this connector cannot see it." });
    const shapes: McpToolResult[] = [
      { content: [{ type: "text", text: "Task: Flaky login test (project Payments)" }] },
      { content: [{ type: "text", text: JSON.stringify({ gid: "1210000000000101", projects: [{ gid: PROJECT }] }) }] },
      { content: [{ type: "text", text: JSON.stringify({ data: { gid: "1210000000000101" } }) }] },
      taskResult("1210000000000555", [PROJECT]),
    ];
    for (const shape of shapes) {
      const { run, writes } = harness({ getTask: () => shape });
      const result = await run("add_comment", { task_id: "1210000000000101", text: "x" });
      expect(result).toMatchObject({ status: "FAILED", reason: "policy_denied", text: "Could not confirm that Asana task 1210000000000101 is in the payments project, so the request was not sent." });
      expect(writes()).toEqual([]);
    }
  });

  it("refuses a task URL or name instead of a task ID, before any call", async () => {
    const { run, calls } = harness();
    for (const task_id of ["https://app.asana.com/0/1210000000000010/1210000000000101", "Flaky login test", "0123"]) {
      expect(await run("add_comment", { task_id, text: "x" })).toMatchObject({ status: "FAILED", text: expect.stringContaining("Pass the Asana task ID") as unknown });
    }
    expect(calls).toEqual([]);
  });

  it("creates tasks only in the project: binds default_project, allows its own project_id and a parent in it, refuses the rest", async () => {
    const { run, calls, writes } = harness();
    expect(await run("create_tasks", { tasks: [{ name: "Fix login" }, { name: "Subtask", parent: "1210000000000101" }, { name: "Same project", project_id: PROJECT }] })).toMatchObject({ status: "SUCCEEDED" });
    expect(calls.at(-1)).toEqual({ name: "create_tasks", arguments: { tasks: [{ name: "Fix login" }, { name: "Subtask", parent: "1210000000000101" }, { name: "Same project", project_id: PROJECT }], default_project: PROJECT } });
    const refused = [
      { tasks: [{ name: "Elsewhere", project_id: OTHER_PROJECT }] },
      { tasks: [{ name: "Sub elsewhere", parent: "1210000000000201" }] },
      { tasks: [{ name: "Sectioned", section_id: "1210000000000011" }] },
      { tasks: [{ name: "Mine", assignee_section: "1210000000000012" }] },
    ];
    for (const args of refused) expect(await run("create_tasks", args)).toMatchObject({ status: "FAILED", reason: "policy_denied" });
    expect(writes()).toHaveLength(1);
  });

  it("updates tasks only when every task, parent and dependency is in the project, and never moves a task between projects", async () => {
    const { run, writes } = harness();
    expect(await run("update_tasks", { tasks: [{ task: "1210000000000101", completed: true }, { task: "1210000000000102", add_dependencies: ["1210000000000101"], parent: null }] })).toMatchObject({ status: "SUCCEEDED" });
    const refused = [
      { tasks: [{ task: "1210000000000201", name: "x" }] },
      { tasks: [{ task: "1210000000000101", add_dependencies: ["1210000000000201"] }] },
      { tasks: [{ task: "1210000000000101", parent: "1210000000000201" }] },
      { tasks: [{ task: "1210000000000101", add_projects: [{ project_id: OTHER_PROJECT }] }] },
      { tasks: [{ task: "1210000000000101", remove_projects: [PROJECT] }] },
      { tasks: Array.from({ length: 11 }, (_unused, index) => ({ task: `12100000000011${String(index).padStart(2, "0")}`, completed: true })) },
    ];
    for (const args of refused) expect(await run("update_tasks", args)).toMatchObject({ status: "FAILED", reason: "policy_denied" });
    expect(writes()).toHaveLength(1);
  });

  it("refuses a tool the guard cannot hold to the project, even if a policy approves it", async () => {
    const { run, calls } = harness({ policy: [...approvals, { name: "delete_task", access: "write" }] });
    expect(await run("delete_task", { task: "1210000000000101" })).toMatchObject({ status: "FAILED", reason: "policy_denied", text: "delete_task cannot be limited to an Asana project, so this connector does not run it." });
    expect(calls).toEqual([]);
  });

  it("never sends the call when a task lookup throws", async () => {
    const { run, writes } = harness({ getTask: () => { throw new Error("socket closed: secret-vendor-detail"); } });
    const result = await run("add_comment", { task_id: "1210000000000101", text: "x" });
    expect(result).toMatchObject({ status: "FAILED", reason: "vendor_error" });
    expect(result.text).not.toContain("secret-vendor-detail");
    expect(writes()).toEqual([]);
  });

  it("refuses, on the guard alone, a missing scope and task entries that are not objects", async () => {
    const connection = { call: vi.fn(async (): Promise<McpToolResult> => taskResult("1210000000000101", [PROJECT])) };
    const check = (tool: string, args: Record<string, unknown>, guardScope: unknown = scope) => asanaProjectGuard.check({ tool, arguments: args, bound: {}, scope: guardScope, connection });
    await expect(check("add_comment", { task_id: "1210000000000101" }, null)).rejects.toThrow("The Asana project check could not run");
    await expect(check("update_tasks", { tasks: ["1210000000000201"] })).rejects.toBeInstanceOf(GuardRejection);
    await expect(check("update_tasks", { tasks: "1210000000000201" })).rejects.toBeInstanceOf(GuardRejection);
    await expect(check("add_comment", { task_id: 1210000000000201 })).rejects.toThrow("Pass the Asana task ID");
    await expect(check("create_tasks", { tasks: [7] })).rejects.toThrow("not allowed on create_tasks");
    expect(connection.call).not.toHaveBeenCalled();
  });
});
