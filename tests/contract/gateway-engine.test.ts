import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  approveTools,
  discoverTools,
  executeTool,
  reviewTools,
  GuardRejection,
  type ConnectorContext,
  type ConnectorDefinition,
  type Guard,
  type Invocation,
  type Ledger,
  type McpConnection,
  type McpToolResult,
  type ToolRequest,
  type connectMcp,
} from "../../packages/gateway/src/index.js";

interface TrackerScope { alias: string; siteId: string }

const scope: TrackerScope = { alias: "payments", siteId: "site-42" };
const text = (value: unknown): McpToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties: { siteId: { type: "string" }, ...properties },
  required: ["siteId", ...required],
});

function fixture(guards: Guard[] = []) {
  const tools: McpConnection["tools"] = [
    { name: "list_items", description: "List items", inputSchema: schema({ state: { type: "string", enum: ["open", "closed", "archived"] } }) },
    { name: "create_item", description: "Create an item", inputSchema: schema({ title: { type: "string" }, priority: { type: "string" } }, ["title"]) },
    { name: "unscoped", description: "No site property", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
    { name: "composed", description: "Uses allOf", inputSchema: { allOf: [schema({}), { type: "object", properties: { note: { $ref: "#/$defs/Note" } } }], $defs: { Note: { type: "string" } } } },
    { name: "either", description: "Uses anyOf", inputSchema: { anyOf: [schema({})] } },
    { name: "unapproved", description: "Not in policy", inputSchema: schema({}) },
  ];
  const issue = vi.fn<ConnectorDefinition<TrackerScope>["credentials"]["issue"]>(async () => ({ token: "tracker-secret-token", bindings: {} }));
  const connector: ConnectorDefinition<TrackerScope> = {
    label: "Tracker",
    endpoint: new URL("https://mcp.tracker.test/mcp"),
    permissionsHint: "Tracker key permissions",
    credentials: { issue },
    binder: { properties: ["siteId"], bind: (value) => ({ siteId: value.siteId }) },
    guards,
  };
  const context: ConnectorContext<TrackerScope> = {
    workspaceId: "workspace", ownerKey: "alice", scopeAlias: scope.alias, scope,
    policy: { tools: [
      { name: "list_items", access: "read", argumentValues: { state: ["open", "closed"] } },
      { name: "create_item", access: "write", allowedArguments: ["title"] },
      { name: "unscoped", access: "read" },
      { name: "composed", access: "read" },
      { name: "either", access: "read" }, { name: "retired", access: "read" },
    ] },
  };
  const records = new Map<string, Invocation>();
  const ledger: Ledger = {
    claim: async (record) => { if (records.has(record.requestId)) return false; records.set(record.requestId, structuredClone(record)); return true; },
    get: async (id) => records.get(id),
    finish: async (record) => { records.set(record.requestId, structuredClone(record)); },
  };
  const call = vi.fn<(name: string, args: Record<string, unknown>) => Promise<McpToolResult>>(async () => text({ ok: true }));
  const close = vi.fn(async () => undefined);
  const connect = vi.fn<typeof connectMcp>(async () => ({ tools, call, close }));
  const request = (tool: string, args: Record<string, unknown> = {}): ToolRequest => ({
    requestId: randomUUID(), scope: "payments", tool, arguments: args,
    schemaHash: approveTools({ tools }, connector, context).find((entry) => entry.name === tool)!.schemaHash,
  });
  return { tools, issue, connector, context, records, ledger, call, close, connect, request };
}

describe("gateway tool approval", () => {
  it("removes bound properties and skips tools it cannot bind or represent", () => {
    const f = fixture();
    const catalog = approveTools({ tools: f.tools }, f.connector, f.context);
    expect(catalog.map((tool) => tool.name)).toEqual(["list_items", "create_item", "composed"]);
    expect(catalog.every((tool) => tool.scope === "payments")).toBe(true);
    const list = catalog[0]!.inputSchema;
    expect((list.properties as Record<string, unknown>).siteId).toBeUndefined();
    expect(list.required).toEqual(["state"]);
    expect((list.properties as Record<string, { enum: string[] }>).state.enum).toEqual(["open", "closed"]);
    expect((catalog[1]!.inputSchema.properties as Record<string, unknown>).priority).toBeUndefined();
    expect(catalog[1]!.access).toBe("write");
  });

  it("skips an oversized or uncompilable vendor schema instead of failing discovery", () => {
    const f = fixture();
    const tools: McpConnection["tools"] = [
      { name: "list_items", description: "Huge", inputSchema: schema({ state: { type: "string", description: "x".repeat(40_000) } }) },
      { name: "create_item", description: "Broken", inputSchema: schema({ title: { type: "nonsense" } }, ["title"]) },
    ];
    const review = reviewTools({ tools }, f.connector, f.context);
    expect(review.tools).toEqual([]);
    expect(review.skipped).toEqual(expect.arrayContaining([
      { tool: "list_items", reason: "schema exceeds 32768 characters" },
      { tool: "create_item", reason: "schema does not compile" },
    ]));
  });

  it("skips a tool whose schema grows past the size limit once references are inlined", () => {
    const f = fixture();
    const $defs = { Big: { type: "string", description: "y".repeat(3_000) } };
    const properties = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`p${index}`, { $ref: "#/$defs/Big" }]));
    // "composed" has no argument narrowing, so only the size limit can refuse it.
    const tools: McpConnection["tools"] = [{ name: "composed", description: "Expands", inputSchema: { ...schema(properties), $defs } }];
    const review = reviewTools({ tools }, f.connector, f.context);
    expect(review.tools).toEqual([]);
    expect(review.skipped).toContainEqual({ tool: "composed", reason: "flattened schema exceeds 32768 characters" });
  });

  it("reports every approved tool it cannot offer, with a reason", () => {
    const f = fixture();
    const review = reviewTools({ tools: f.tools }, f.connector, f.context);
    expect(review.skipped).toEqual([
      { tool: "retired", reason: "not offered by the vendor" },
      { tool: "unscoped", reason: "missing server-bound property siteId" },
      { tool: "either", reason: "schema is not a plain object" },
    ]);
    expect((review.tools.find((tool) => tool.name === "composed")!.inputSchema.properties as Record<string, unknown>).note).toEqual({ type: "string" });
  });
});

const legacyFingerprint = (value: unknown): string => {
  const sort = (item: unknown): unknown => Array.isArray(item) ? item.map(sort)
    : item && typeof item === "object" ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, sort(entry)]))
    : item;
  return createHash("sha256").update(JSON.stringify(sort(value))).digest("hex");
};

describe("gateway execution", () => {
  it("appends the attribution to a body the model supplied on a write, and to nothing else", async () => {
    const f = fixture();
    f.tools[1]!.inputSchema = schema({ title: { type: "string" }, body: { type: "string" } }, ["title"]);
    f.context.policy.tools[1] = { name: "create_item", access: "write", allowedArguments: ["title", "body"] };
    const options = { connect: f.connect, ledger: f.ledger, attribution: "Requested by Pratik via AgentX · https://slack.com/archives/C1/p1" };
    await executeTool(f.request("create_item", { title: "Bug", body: "Steps" }), f.connector, f.context, options);
    expect(f.call).toHaveBeenLastCalledWith("create_item", { title: "Bug", body: "Steps\n\n—\nRequested by Pratik via AgentX · https://slack.com/archives/C1/p1", siteId: "site-42" });
    await executeTool(f.request("create_item", { title: "No body" }), f.connector, f.context, options);
    expect(f.call).toHaveBeenLastCalledWith("create_item", { title: "No body", siteId: "site-42" });
    await executeTool(f.request("list_items", { state: "open" }), f.connector, f.context, options);
    expect(f.call).toHaveBeenLastCalledWith("list_items", { state: "open", siteId: "site-42" });
  });

  it("replays an attributed write from the ledger instead of conflicting", async () => {
    const f = fixture();
    f.tools[1]!.inputSchema = schema({ title: { type: "string" }, body: { type: "string" } }, ["title"]);
    f.context.policy.tools[1] = { name: "create_item", access: "write", allowedArguments: ["title", "body"] };
    const request = f.request("create_item", { title: "Bug", body: "Steps" });
    const options = { connect: f.connect, ledger: f.ledger, attribution: "Requested by Pratik via AgentX · https://slack.com/archives/C1/p1" };
    await executeTool(request, f.connector, f.context, options);
    const retried = { ...options, attribution: "Requested by Slack member U2 via AgentX · https://slack.com/archives/C2/p2" };
    expect(await executeTool(request, f.connector, f.context, retried)).toMatchObject({ status: "SUCCEEDED", replayed: true });
    expect(f.call).toHaveBeenCalledOnce();
  });

  it("signs only the connector's attribution keys, leaving a short description alone", async () => {
    const f = fixture();
    f.tools[1]!.inputSchema = schema({ title: { type: "string" }, description: { type: "string" } }, ["title"]);
    f.context.policy.tools[1] = { name: "create_item", access: "write", allowedArguments: ["title", "description"] };
    const connector = { ...f.connector, attributionKeys: ["body"] };
    await executeTool(f.request("create_item", { title: "Label", description: "Short" }), connector, f.context, { connect: f.connect, ledger: f.ledger, attribution: "Requested by Pratik via AgentX · https://slack.com/archives/C1/p1" });
    expect(f.call).toHaveBeenLastCalledWith("create_item", { title: "Label", description: "Short", siteId: "site-42" });
  });

  it("sends the unsigned body when the footer would break the upstream schema, and still refuses an unsigned body that breaks it", async () => {
    const f = fixture();
    f.tools[1]!.inputSchema = schema({ title: { type: "string" }, body: { type: "string", maxLength: 20 } }, ["title"]);
    f.context.policy.tools[1] = { name: "create_item", access: "write", allowedArguments: ["title", "body"] };
    const options = { connect: f.connect, ledger: f.ledger, attribution: "Requested by Pratik via AgentX · https://slack.com/archives/C1/p1" };
    expect(await executeTool(f.request("create_item", { title: "Bug", body: "Steps" }), f.connector, f.context, options)).toMatchObject({ status: "SUCCEEDED" });
    expect(f.call).toHaveBeenLastCalledWith("create_item", { title: "Bug", body: "Steps", siteId: "site-42" });
    await executeTool(f.request("create_item", { title: "Bug", body: "Steps" }), f.connector, f.context, { ...options, attribution: "By P" });
    expect(f.call).toHaveBeenLastCalledWith("create_item", { title: "Bug", body: "Steps\n\n—\nBy P", siteId: "site-42" });
    expect(f.call).toHaveBeenCalledTimes(2);
    const tooLong = await executeTool(f.request("create_item", { title: "Bug", body: "x".repeat(21) }), f.connector, f.context, options);
    expect(tooLong).toMatchObject({ status: "FAILED", reason: "policy_denied" });
    expect(f.call).toHaveBeenCalledTimes(2);
  });

  it("does not stack a footer the value already ends with", async () => {
    const f = fixture();
    f.tools[1]!.inputSchema = schema({ title: { type: "string" }, body: { type: "string" } }, ["title"]);
    f.context.policy.tools[1] = { name: "create_item", access: "write", allowedArguments: ["title", "body"] };
    const attribution = "Requested by Pratik via AgentX · https://slack.com/archives/C1/p1";
    const signed = `Steps\n\n—\n${attribution}`;
    await executeTool(f.request("create_item", { title: "Bug", body: signed }), f.connector, f.context, { connect: f.connect, ledger: f.ledger, attribution });
    expect(f.call).toHaveBeenLastCalledWith("create_item", { title: "Bug", body: signed, siteId: "site-42" });
  });

  it("injects bound values from the scope and passes the requester to the credential provider", async () => {
    const f = fixture();
    const context = { ...f.context, requestedBy: { teamId: "T1", userId: "U1" } };
    const request = f.request("list_items", { state: "open" });
    expect(await executeTool(request, f.connector, context, { connect: f.connect, ledger: f.ledger })).toMatchObject({ status: "SUCCEEDED" });
    expect(f.call).toHaveBeenCalledWith("list_items", { state: "open", siteId: "site-42" });
    expect(f.issue).toHaveBeenCalledWith(scope, "read", { teamId: "T1", userId: "U1" });
    expect(f.connect).toHaveBeenCalledWith(expect.objectContaining({ tools: ["list_items"], token: "tracker-secret-token" }));
  });

  it("refuses a model-supplied bound property before contacting the vendor", async () => {
    const f = fixture();
    await expect(executeTool(f.request("list_items", { state: "open", siteId: "other" }), f.connector, f.context, { connect: f.connect, ledger: f.ledger }))
      .rejects.toThrow(/Tracker routing arguments are server controlled/);
    expect(f.connect).not.toHaveBeenCalled();
  });

  it("runs guards on the call's connection before executing and returns their refusal", async () => {
    const check = vi.fn<Guard["check"]>(async ({ arguments: args, bound }) => {
      expect(bound).toEqual({ siteId: "site-42" });
      if (args.title === "blocked") throw new GuardRejection("Blocked by guard.");
    });
    const f = fixture([{ requiredTools: (tool) => tool === "create_item" ? ["list_items"] : [], check }]);
    const result = await executeTool(f.request("create_item", { title: "blocked" }), f.connector, f.context, { connect: f.connect, ledger: f.ledger });
    expect(result).toMatchObject({ status: "FAILED", text: "Blocked by guard." });
    expect(f.connect).toHaveBeenCalledWith(expect.objectContaining({ tools: ["create_item", "list_items"] }));
    expect(f.call).not.toHaveBeenCalled();
  });

  it("keeps feature 007 fingerprints so stored records replay across the release", async () => {
    const f = fixture();
    const request = f.request("create_item", { title: "Flaky login" });
    const stored = legacyFingerprint({ requestId: request.requestId, repository: "payments", tool: "create_item", schemaHash: request.schemaHash, arguments: request.arguments });
    f.records.set(request.requestId, {
      requestId: request.requestId, workspaceId: "workspace", ownerKey: "alice", repository: "payments", tool: "create_item",
      fingerprint: stored, createdAt: "2026-09-23T00:00:00.000Z", updatedAt: "2026-09-23T00:00:01.000Z",
      result: { requestId: request.requestId, status: "SUCCEEDED", text: "stored", truncated: false, replayed: false },
    });
    expect(await executeTool(request, f.connector, f.context, { connect: f.connect, ledger: f.ledger }))
      .toEqual({ requestId: request.requestId, status: "SUCCEEDED", text: "stored", truncated: false, replayed: true });
    expect(f.connect).not.toHaveBeenCalled();
  });

  it("redacts the credential from results", async () => {
    const f = fixture();
    f.call.mockResolvedValueOnce({ content: [{ type: "text", text: "echo tracker-secret-token" }] });
    const result = await executeTool(f.request("list_items", { state: "open" }), f.connector, f.context, { connect: f.connect, ledger: f.ledger });
    expect(result.text).toBe("echo [REDACTED]");
  });

  it("reports a credential failure as FAILED before any write without contacting the vendor", async () => {
    const f = fixture();
    f.issue.mockRejectedValueOnce(new Error("app not installed"));
    const result = await executeTool(f.request("create_item", { title: "Bug" }), f.connector, f.context, { connect: f.connect, ledger: f.ledger });
    expect(result).toMatchObject({ status: "FAILED", text: "Tracker MCP request failed before any write. Check Tracker key permissions and MCP availability." });
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.records.get(result.requestId)?.result.status).toBe("FAILED");
  });

  it("names the connector and its permissions when discovery fails", async () => {
    const f = fixture();
    f.connect.mockRejectedValueOnce(new Error("401"));
    await expect(discoverTools(f.connector, f.context, { connect: f.connect }))
      .rejects.toThrow(/Tracker MCP discovery failed; check Tracker key permissions and endpoint availability/);
  });

  it("discovers the approved catalog and closes the connection", async () => {
    const f = fixture();
    const catalog = await discoverTools(f.connector, f.context, { connect: f.connect });
    expect(catalog.tools.map((tool) => tool.name)).toEqual(["list_items", "create_item", "composed"]);
    expect(catalog.skipped.map((entry) => entry.tool)).toEqual(["retired", "unscoped", "either"]);
    expect(f.connect).toHaveBeenCalledWith(expect.objectContaining({ tools: ["list_items", "create_item", "unscoped", "composed", "either", "retired"] }));
    expect(f.close).toHaveBeenCalledOnce();
  });

  it("gives every failure a reason the model and the broker can act on", async () => {
    const f = fixture();
    const changed = f.request("list_items", { state: "open" });
    f.tools[0]!.description = "Changed upstream";
    expect(await executeTool(changed, f.connector, f.context, { connect: f.connect, ledger: f.ledger })).toMatchObject({ status: "FAILED", reason: "schema_changed" });
    f.tools[0]!.description = "List items";
    const guard = fixture([{ requiredTools: () => [], check: async () => { throw new GuardRejection("No."); } }]);
    expect(await executeTool(guard.request("list_items", { state: "open" }), guard.connector, guard.context, { connect: guard.connect, ledger: guard.ledger }))
      .toMatchObject({ status: "FAILED", reason: "policy_denied" });
    const vendor = fixture();
    vendor.issue.mockRejectedValueOnce(new Error("down"));
    expect(await executeTool(vendor.request("list_items", { state: "open" }), vendor.connector, vendor.context, { connect: vendor.connect, ledger: vendor.ledger }))
      .toMatchObject({ status: "FAILED", reason: "vendor_error" });
  });
});
