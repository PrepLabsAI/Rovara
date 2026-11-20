// tests/contract/gateway-asana.test.ts
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { ASANA_PROJECT_TOOL_ACCESS, itemPathProblems } from "../../packages/contracts/src/index.js";
import { ASANA_CREATE_TASK_ITEM_KEYS, ASANA_ITEM_ARGUMENTS, ASANA_MCP_ENDPOINT, ASANA_TASK_REFERENCES, ASANA_UPDATE_TASK_ITEM_KEYS, asanaBinder, asanaConnector, asanaProjectGuard, executeTool, GuardRejection, reviewTools, type AsanaProjectScope, type ConnectorContext, type Invocation, type Ledger, type McpToolResult, type ToolApproval } from "../../packages/gateway/src/index.js";
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
  "1210000000000303": { projects: [], parent: "1210000000000301" },
  "1210000000000304": { projects: [], parent: "1210000000000301" },
  "1210000000000305": { projects: [], parent: "1210000000000301" },
  "1210000000000306": { projects: [], parent: "1210000000000301" },
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

  it("declares task_id and tasks[].task as the item arguments for spec 014, each a path the guard also checks", () => {
    // task_id names the task of get_task, get_task_stories and add_comment; tasks[].task names the
    // task of each update_tasks item. Parents and dependencies are guarded but are not item
    // arguments: they are other tasks the call points at, not the item it acts on.
    expect(ASANA_ITEM_ARGUMENTS).toEqual(["task_id", "tasks[].task"]);
    expect(itemPathProblems(ASANA_ITEM_ARGUMENTS)).toEqual([]);
    expect(asanaConnector({ issue: vi.fn() }).itemArguments).toEqual(ASANA_ITEM_ARGUMENTS);
    const guarded = new Set(Object.values(ASANA_TASK_REFERENCES).flat().map((path) => path.join(".").replaceAll(".*", "[]")));
    for (const path of ASANA_ITEM_ARGUMENTS) expect(guarded).toContain(path);
    const topLevel = Object.values(ASANA_TASK_REFERENCES).flat().filter((path) => path.length === 1).map((path) => path[0]);
    expect(new Set(topLevel)).toEqual(new Set(["task_id"]));
  });

});

describe("Asana project guard", () => {

  it("refuses get_tasks filters that would replace the project context", async () => {
    const { run, calls } = harness();
    for (const args of [{ tag: "1210000000000900" }, { section: "1210000000000901" }, { user_task_list: "1210000000000902" }, { assignee: "me" }]) {
      const result = await run("get_tasks", args);
      expect(result).toMatchObject({ status: "FAILED", reason: "policy_denied" });
      expect(result.text).toContain("works only in the payments project");
    }
    expect(calls).toEqual([]);
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

  it("allows exactly the task item keys the recorded Asana catalog lists for create_tasks and update_tasks", () => {
    const itemKeys = (tool: string) => {
      const properties = vendorTools("asana").find((entry) => entry.name === tool)!.inputSchema.properties as Record<string, { items: { properties: Record<string, unknown> } }>;
      return Object.keys(properties.tasks!.items.properties).sort();
    };
    expect([...ASANA_CREATE_TASK_ITEM_KEYS].sort()).toEqual(itemKeys("create_tasks"));
    expect([...ASANA_UPDATE_TASK_ITEM_KEYS].sort()).toEqual(itemKeys("update_tasks"));
  });

  it("refuses task item keys the catalog does not list, including own __proto__ and constructor keys, and writes nothing", async () => {
    const { run, writes } = harness();
    const refused: Array<[string, Record<string, unknown>]> = [
      ["create_tasks", { tasks: [{ name: "a", projects: [OTHER_PROJECT] }] }],
      ["create_tasks", { tasks: [{ name: "a", workspace: "1", memberships: [{ project: OTHER_PROJECT }] }] }],
      ["create_tasks", { tasks: [{ name: "a", workspace: "1210000000000001" }] }],
      ["update_tasks", { tasks: [{ task: "1210000000000101", task_id: "1210000000000201", name: "x" }] }],
      ["update_tasks", { tasks: [{ task: "1210000000000101", gid: "1210000000000201", name: "x" }] }],
      ["update_tasks", { tasks: [{ task: "1210000000000101", projects: [OTHER_PROJECT] }] }],
      ["update_tasks", { tasks: [{ task: "1210000000000101", memberships: [{ project: OTHER_PROJECT }] }] }],
      ["update_tasks", { tasks: [{ task: "1210000000000101", constructor: "1210000000000201" }] }],
      ["update_tasks", JSON.parse('{"tasks":[{"task":"1210000000000101","__proto__":{"task":"1210000000000201"}}]}') as Record<string, unknown>],
    ];
    for (const [tool, args] of refused) {
      const result = await run(tool, args);
      expect(result).toMatchObject({ status: "FAILED", reason: "policy_denied" });
      expect(result.text).toContain("is not allowed");
    }
    expect(writes()).toEqual([]);
  });

  it("allows task custom fields keyed by field GID only", async () => {
    const { run, writes } = harness();
    expect(await run("update_tasks", { tasks: [{ task: "1210000000000101", custom_fields: { "1200456789012345": "1200123456789012", "1200456789012349": { date: "2025-06-15" }, "1200456789012348": ["1200111111111111"] } }] })).toMatchObject({ status: "SUCCEEDED" });
    expect(await run("create_tasks", { tasks: [{ name: "a", custom_fields: '{"1200456789012346":12.5}' }] })).toMatchObject({ status: "SUCCEEDED" });
    const refused: Array<[string, Record<string, unknown>]> = [
      ["update_tasks", { tasks: [{ task: "1210000000000101", custom_fields: { projects: OTHER_PROJECT } }] }],
      ["update_tasks", { tasks: [{ task: "1210000000000101", custom_fields: { "1200456789012349": { project: OTHER_PROJECT } } }] }],
      ["create_tasks", { tasks: [{ name: "a", custom_fields: "not json" }] }],
      ["create_tasks", { tasks: [{ name: "a", custom_fields: '{"memberships":[{"project":"1210000000000020"}]}' }] }],
    ];
    for (const [tool, args] of refused) expect(await run(tool, args)).toMatchObject({ status: "FAILED", reason: "policy_denied" });
    expect(writes()).toHaveLength(2);
  });

  it("refuses removing the parent of a task that is in the project only through that parent", async () => {
    const { run, writes } = harness();
    const result = await run("update_tasks", { tasks: [{ task: "1210000000000301", parent: null }] });
    expect(result).toMatchObject({ status: "FAILED", reason: "policy_denied", text: "Asana task 1210000000000301 is in the payments project only through its parent, so this connector does not remove its parent." });
    expect(writes()).toEqual([]);
    expect(await run("update_tasks", { tasks: [{ task: "1210000000000101", parent: null }] })).toMatchObject({ status: "SUCCEEDED" });
  });

  it("fails closed when Asana returns a malformed parent GID", async () => {
    for (const parent of [{ gid: "not-a-gid" }, { gid: 1210000000000101 }, "1210000000000101"]) {
      const { run, writes } = harness({ getTask: (gid) => {
        const result = taskResult(gid, []);
        const body = JSON.parse(result.content![0]!.text!) as { data: Record<string, unknown> };
        body.data.parent = parent;
        return { content: [{ type: "text", text: JSON.stringify(body) }] };
      } });
      expect(await run("add_comment", { task_id: "1210000000000301", text: "x" })).toMatchObject({ status: "FAILED", reason: "policy_denied", text: "Could not confirm that Asana task 1210000000000301 is in the payments project, so the request was not sent." });
      expect(writes()).toEqual([]);
    }
  });

  it("checks search_tasks custom_fields: GID.operator keys with plain values only", async () => {
    const { run, calls } = harness();
    expect(await run("search_tasks", { custom_fields: '{"4578152156.value":"1200123456789012","1200999999999999.is_set":true}' })).toMatchObject({ status: "SUCCEEDED" });
    for (const custom_fields of ['{"projects.any":"1210000000000020"}', "not json", "[]", '"x"', '{"4578152156":"x"}', '{"4578152156.value":{"a":1}}', '{"4578152156.value":["a"]}', '{"__proto__":{"a":1}}']) {
      expect(await run("search_tasks", { custom_fields })).toMatchObject({ status: "FAILED", reason: "policy_denied" });
    }
    expect(calls.map((entry) => entry.name)).toEqual(["search_tasks"]);
  });

  it("refuses html_text on add_comment, so every comment carries the plain-text attribution", async () => {
    const { run, calls } = harness();
    expect(await run("add_comment", { task_id: "1210000000000101", html_text: "<body>Fixed</body>" })).toMatchObject({
      status: "FAILED", reason: "policy_denied", text: "This Asana connector posts comments as plain text only. Pass text instead of html_text.",
    });
    expect(calls).toEqual([]);
  });

  it("refuses an explicit null project_id, section_id or assignee_section on task items", async () => {
    const { run, writes } = harness();
    const refused: Array<[string, Record<string, unknown>]> = [
      ["create_tasks", { tasks: [{ name: "a", project_id: null }] }],
      ["create_tasks", { tasks: [{ name: "a", section_id: null }] }],
      ["create_tasks", { tasks: [{ name: "a", assignee_section: null }] }],
      ["update_tasks", { tasks: [{ task: "1210000000000101", assignee_section: null }] }],
    ];
    for (const [tool, args] of refused) expect(await run(tool, args)).toMatchObject({ status: "FAILED", reason: "policy_denied" });
    expect(writes()).toEqual([]);
  });

  it("requires every update_tasks item to name its task by GID", async () => {
    const { run, calls } = harness();
    for (const item of [{ name: "x", parent: null }, { task: 1210000000000101, name: "x" }, { task: "Flaky login test", name: "x" }]) {
      expect(await run("update_tasks", { tasks: [{ task: "1210000000000101", completed: true }, item] })).toMatchObject({ status: "FAILED", reason: "policy_denied" });
    }
    expect(calls).toEqual([]);
    const connection = { call: vi.fn(async (): Promise<McpToolResult> => taskResult("1210000000000101", [PROJECT])) };
    await expect(asanaProjectGuard.check({ tool: "update_tasks", arguments: { tasks: [{ name: "x", parent: null }] }, bound: {}, scope, connection })).rejects.toThrow("Pass the Asana task ID");
    expect(connection.call).not.toHaveBeenCalled();
  });
});
