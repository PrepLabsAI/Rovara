import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  LINEAR_MCP_ENDPOINT, executeTool, issueInTeamGuard, linearBinder, linearConnector, reviewTools,
  GuardRejection, type Invocation, type Ledger, type LinearTeamScope,
} from "../../packages/gateway/src/index.js";
import { vendorTools } from "../support/vendor-fixtures.js";

const tools = vendorTools("linear");
/** The live get_issue result (2026-09-24), free text replaced: top-level teamId (UUID), team (name), id (identifier). */
const issueFixture = JSON.parse(readFileSync(new URL("../fixtures/vendors/linear-get-issue.json", import.meta.url), "utf8")) as Record<string, unknown>;
const CHARTERARC = "c408e946-78aa-4db8-923e-f78053dd954f";
const OTHER = "0b6f3f7e-5d1a-4c1e-9a53-2f0f5a8f1c11";
const scope: LinearTeamScope = { alias: "charterarc", teamId: CHARTERARC };
const bound = { team: CHARTERARC, teamId: CHARTERARC };

/** The live get_issue result with its team UUID set to `teamId`. */
const issueIn = (teamId: string): Record<string, unknown> => ({ ...structuredClone(issueFixture), teamId });
const text = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const context = (names: Array<[string, "read" | "write"]>) => ({
  workspaceId: "w", ownerKey: "o", scopeAlias: "charterarc", scope,
  policy: { tools: names.map(([name, access]) => ({ name, access })) },
});

describe("linear connector definition", () => {
  it("points at the Linear MCP endpoint and signs description, then body", () => {
    const definition = linearConnector({ issue: vi.fn() });
    expect(LINEAR_MCP_ENDPOINT.href).toBe("https://mcp.linear.app/mcp");
    expect(definition).toMatchObject({ label: "Linear", endpoint: LINEAR_MCP_ENDPOINT, attributionKeys: ["description", "body"], guards: [issueInTeamGuard], binder: linearBinder });
  });

  it("binds the scope's team id as both team and teamId, where a tool declares them", () => {
    expect(linearBinder).toMatchObject({ properties: [], optionalProperties: ["team", "teamId"] });
    expect(linearBinder.bind(scope, { token: "t", bindings: {} })).toEqual({ team: CHARTERARC, teamId: CHARTERARC });
  });

  it("removes team and teamId where a tool declares them and offers tools without either unchanged", () => {
    const reviewed = reviewTools({ tools }, { binder: linearBinder }, context([
      ["list_issues", "read"], ["list_issue_statuses", "read"], ["list_documents", "read"], ["get_issue", "read"], ["save_issue", "write"], ["save_comment", "write"], ["list_teams", "read"],
    ]));
    expect(reviewed.skipped).toEqual([]);
    const byName = Object.fromEntries(reviewed.tools.map((tool) => [tool.name, tool.inputSchema as { properties: Record<string, unknown>; required: string[] }]));
    expect(Object.keys(byName).sort()).toEqual(["get_issue", "list_documents", "list_issue_statuses", "list_issues", "list_teams", "save_comment", "save_issue"]);
    for (const schema of Object.values(byName)) {
      expect(schema.properties).not.toHaveProperty("team");
      expect(schema.properties).not.toHaveProperty("teamId");
    }
    expect(byName.list_issue_statuses!.required).toEqual([]);
    expect(Object.keys(byName.save_comment!.properties)).toContain("issueId");
    expect(byName.get_issue!.required).toEqual(["id"]);
  });
});

describe("issue-in-team guard", () => {
  /** `teamId` is a team UUID, or "error" / "garbage" for a failed or unreadable get_issue. */
  const connection = (teamId: string) => ({
    call: vi.fn(async () => teamId === "error" ? { isError: true, content: [{ type: "text", text: "Entity not found" }] }
      : teamId === "garbage" ? { content: [{ type: "text", text: "not json" }] } : text(issueIn(teamId))),
  });
  /** An explicit `undefined` target is passed through as a missing scope; only an omitted one defaults. */
  const check = (tool: string, args: Record<string, unknown>, conn: ReturnType<typeof connection>, ...target: [unknown?]) =>
    issueInTeamGuard.check({ tool, arguments: args, bound, scope: target.length > 0 ? target[0] : scope, connection: conn });

  it("asks for get_issue only for issue-addressed calls", () => {
    expect(issueInTeamGuard.requiredTools("save_issue", { id: "CHA-1" })).toEqual(["get_issue"]);
    expect(issueInTeamGuard.requiredTools("save_issue", { title: "new" })).toEqual([]);
    expect(issueInTeamGuard.requiredTools("save_comment", { issueId: "CHA-1", body: "x" })).toEqual(["get_issue"]);
    expect(issueInTeamGuard.requiredTools("list_comments", { issueId: "CHA-1" })).toEqual(["get_issue"]);
    expect(issueInTeamGuard.requiredTools("get_issue", { id: "CHA-1" })).toEqual(["get_issue"]);
    expect(issueInTeamGuard.requiredTools("list_issues", {})).toEqual([]);
  });

  it("allows an issue in the scope's team, comparing ids case-insensitively", async () => {
    const conn = connection(CHARTERARC.toUpperCase());
    await expect(check("save_issue", { id: "CHA-1", priority: 2 }, conn)).resolves.toBeUndefined();
    expect(conn.call).toHaveBeenCalledWith("get_issue", { id: "CHA-1" });
  });

  it("refuses get_issue with includeRelations: true before any Linear call, and leaves includeRelations false or absent unchanged", async () => {
    const conn = connection(CHARTERARC);
    await expect(check("get_issue", { id: "CHA-1", includeRelations: true }, conn))
      .rejects.toThrow(new GuardRejection("This Linear connector refuses get_issue with includeRelations: true, because related issues can belong to another team it does not return."));
    expect(conn.call).not.toHaveBeenCalled();
    await expect(check("get_issue", { id: "CHA-1", includeRelations: false }, conn)).resolves.toBeUndefined();
    await expect(check("get_issue", { id: "CHA-1" }, conn)).resolves.toBeUndefined();
    expect(conn.call).toHaveBeenCalledTimes(2);
  });

  it("reads the team from the call's scope, on tools without a team property too, and fails closed without one", async () => {
    const conn = connection(CHARTERARC);
    await expect(check("save_comment", { issueId: "CHA-3", body: "x" }, conn)).resolves.toBeUndefined();
    await expect(check("get_issue", { id: "CHA-3" }, conn, undefined)).rejects.toThrow(new GuardRejection("The Linear team check could not run, so the request was not sent."));
    await expect(check("get_issue", { id: "CHA-3" }, conn, { alias: "charterarc" })).rejects.toBeInstanceOf(GuardRejection);
    expect(conn.call).toHaveBeenCalledTimes(1);
  });

  it("refuses an issue in another team, a missing issue and an unreadable answer", async () => {
    await expect(check("save_issue", { id: "OTH-9" }, connection(OTHER))).rejects.toThrow(new GuardRejection('Linear issue "OTH-9" is not in the charterarc team this connector may use.'));
    await expect(check("save_comment", { issueId: "OTH-9", body: "x" }, connection(OTHER))).rejects.toBeInstanceOf(GuardRejection);
    await expect(check("get_issue", { id: "OTH-9" }, connection(OTHER))).rejects.toBeInstanceOf(GuardRejection);
    await expect(check("save_issue", { id: "CHA-404" }, connection("error"))).rejects.toThrow(new GuardRejection('Linear issue "CHA-404" was not found or this connector cannot see it.'));
    await expect(check("save_issue", { id: "CHA-1" }, connection("garbage"))).rejects.toThrow(new GuardRejection('Could not confirm that Linear issue "CHA-1" is in the charterarc team, so the request was not sent.'));
    // Only the live field counts: a result with the team name but no teamId is refused.
    const nameOnly = { call: vi.fn(async () => text({ ...issueFixture, teamId: undefined, team: "CharterArc" })) };
    await expect(check("save_issue", { id: "CHA-1" }, nameOnly as never)).rejects.toThrow(new GuardRejection('Could not confirm that Linear issue "CHA-1" is in the charterarc team, so the request was not sent.'));
  });

  it("does not check a create, and refuses comment targets it cannot verify", async () => {
    const conn = connection(CHARTERARC);
    await expect(check("save_issue", { title: "new" }, conn)).resolves.toBeUndefined();
    for (const other of ["id", "parentId", "projectId", "initiativeId", "documentId", "milestoneId", "statusUpdateId", "statusUpdateType"]) {
      await expect(check("save_comment", { [other]: "x", body: "b" }, conn)).rejects.toThrow(new GuardRejection(`This Linear connector only works with comments on issues in the charterarc team, so ${other} is not allowed. Pass issueId.`));
    }
    await expect(check("list_comments", {}, conn)).rejects.toThrow(new GuardRejection("Pass issueId: this Linear connector only works with comments on issues in the charterarc team."));
    expect(conn.call).not.toHaveBeenCalled();
  });
});

describe("issue-in-team guard: issues referenced by save_issue", () => {
  const NOT_IN_TEAM = (id: string) => new GuardRejection(`Linear issue "${id}" is not in the charterarc team this connector may use.`);
  /** get_issue answers with the team in `teamOf`, "garbage" for an unreadable answer, and an error otherwise. */
  const teams = (teamOf: Record<string, string>) => ({
    call: vi.fn(async (_name: string, args: Record<string, unknown>) => {
      const team = teamOf[String(args.id)];
      if (team === undefined) return { isError: true, content: [{ type: "text", text: "Entity not found" }] };
      return team === "garbage" ? { content: [{ type: "text", text: "not json" }] } : text(issueIn(team));
    }),
  });
  const check = (args: Record<string, unknown>, conn: ReturnType<typeof teams>) =>
    issueInTeamGuard.check({ tool: "save_issue", arguments: args, bound, scope, connection: conn });

  it("asks for get_issue whenever save_issue references an issue", () => {
    expect(issueInTeamGuard.requiredTools("save_issue", { title: "new", parentId: "CHA-2" })).toEqual(["get_issue"]);
    expect(issueInTeamGuard.requiredTools("save_issue", { title: "new", duplicateOf: "CHA-2" })).toEqual(["get_issue"]);
    expect(issueInTeamGuard.requiredTools("save_issue", { title: "new", removeBlockedBy: ["CHA-2"] })).toEqual(["get_issue"]);
    expect(issueInTeamGuard.requiredTools("save_issue", { title: "new", parentId: null, duplicateOf: null, relatedTo: [] })).toEqual([]);
  });

  it("allows a parent in the scope's team", async () => {
    const conn = teams({ "CHA-2": CHARTERARC });
    await expect(check({ title: "new", parentId: "CHA-2" }, conn)).resolves.toBeUndefined();
    expect(conn.call.mock.calls).toEqual([["get_issue", { id: "CHA-2" }]]);
  });

  it.each([
    ["parentId", { title: "new", parentId: "OTH-9" }],
    ["duplicateOf", { id: "CHA-1", duplicateOf: "OTH-9" }],
    ["relatedTo", { id: "CHA-1", relatedTo: ["OTH-9"] }],
    ["blocks", { id: "CHA-1", blocks: ["OTH-9"] }],
    ["blockedBy", { id: "CHA-1", blockedBy: ["OTH-9"] }],
    ["removeRelatedTo", { id: "CHA-1", removeRelatedTo: ["OTH-9"] }],
    ["removeBlocks", { id: "CHA-1", removeBlocks: ["OTH-9"] }],
    ["removeBlockedBy", { id: "CHA-1", removeBlockedBy: ["OTH-9"] }],
  ])("refuses an issue in another team referenced by %s", async (_field, args) => {
    await expect(check(args, teams({ "CHA-1": CHARTERARC, "OTH-9": OTHER }))).rejects.toThrow(NOT_IN_TEAM("OTH-9"));
  });

  it("refuses a mix of in-team and out-of-team references", async () => {
    await expect(check({ id: "CHA-1", relatedTo: ["CHA-2", "OTH-9"], blocks: ["CHA-3"] }, teams({ "CHA-1": CHARTERARC, "CHA-2": CHARTERARC, "CHA-3": CHARTERARC, "OTH-9": OTHER })))
      .rejects.toThrow(NOT_IN_TEAM("OTH-9"));
  });

  it("fails closed when a referenced issue is missing or its answer is unreadable", async () => {
    await expect(check({ title: "new", parentId: "CHA-404" }, teams({}))).rejects.toThrow(new GuardRejection('Linear issue "CHA-404" was not found or this connector cannot see it.'));
    await expect(check({ id: "CHA-1", blockedBy: ["CHA-5"] }, teams({ "CHA-1": CHARTERARC, "CHA-5": "garbage" })))
      .rejects.toThrow(new GuardRejection('Could not confirm that Linear issue "CHA-5" is in the charterarc team, so the request was not sent.'));
  });

  it("refuses more than 10 distinct references, counting case-insensitive repeats once", async () => {
    const ids = Array.from({ length: 10 }, (_, index) => `CHA-${index + 1}`);
    const teamOf = Object.fromEntries([...ids, "CHA-11"].map((id) => [id, CHARTERARC]));
    const many = teams(teamOf);
    await expect(check({ id: "CHA-1", relatedTo: [...ids.slice(1), "CHA-11"] }, many)).rejects.toThrow(new GuardRejection("This Linear request references more than 10 issues, so it was not sent."));
    expect(many.call).not.toHaveBeenCalled();
    const repeated = teams(teamOf);
    await expect(check({ id: "CHA-1", relatedTo: [...ids.slice(1), "cha-1"], blocks: ["Cha-2"] }, repeated)).resolves.toBeUndefined();
    expect(repeated.call).toHaveBeenCalledTimes(10);
  });

  it("accepts the empty lists and null references save_issue allows", async () => {
    const conn = teams({ "CHA-1": CHARTERARC });
    await expect(check({ id: "CHA-1", relatedTo: [], blocks: [], blockedBy: [], removeRelatedTo: [], removeBlocks: [], removeBlockedBy: [], parentId: null, duplicateOf: null }, conn)).resolves.toBeUndefined();
    expect(conn.call.mock.calls).toEqual([["get_issue", { id: "CHA-1" }]]);
    await expect(check({ title: "new", parentId: null, relatedTo: [] }, conn)).resolves.toBeUndefined();
    expect(conn.call).toHaveBeenCalledTimes(1);
  });

  it("fails closed on a reference that is not an issue id", async () => {
    const conn = teams({ "CHA-1": CHARTERARC, "CHA-2": CHARTERARC });
    await expect(check({ id: "CHA-1", blocks: ["CHA-2", 7] }, conn)).rejects.toThrow(new GuardRejection("Invalid Linear issue ID."));
    await expect(check({ id: "CHA-1", relatedTo: "CHA-2" }, conn)).rejects.toThrow(new GuardRejection("Invalid Linear issue ID."));
    await expect(check({ title: "new", parentId: "" }, conn)).rejects.toThrow(new GuardRejection("Invalid Linear issue ID."));
    expect(conn.call).not.toHaveBeenCalled();
  });

  it("refuses a scope with an empty alias", async () => {
    const conn = teams({ "CHA-1": CHARTERARC });
    await expect(issueInTeamGuard.check({ tool: "get_issue", arguments: { id: "CHA-1" }, bound, scope: { alias: "", teamId: CHARTERARC }, connection: conn }))
      .rejects.toThrow(new GuardRejection("The Linear team check could not run, so the request was not sent."));
    expect(conn.call).not.toHaveBeenCalled();
  });
});

describe("linear through the engine", () => {
  function memoryLedger(): Ledger & { records: Map<string, Invocation> } {
    const records = new Map<string, Invocation>();
    return {
      records,
      claim: async (record) => { if (records.has(record.requestId)) return false; records.set(record.requestId, record); return true; },
      get: async (id) => records.get(id),
      finish: async (record) => { records.set(record.requestId, record); },
    };
  }
  function fakeConnect(teamOf: Record<string, string>) {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const connect = vi.fn(async () => ({
      tools,
      call: vi.fn(async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        if (name === "get_issue" && teamOf[String(args.id)] === "garbage") return { content: [{ type: "text", text: "not json" }] };
        if (name === "get_issue") return teamOf[String(args.id)] ? text(issueIn(teamOf[String(args.id)]!)) : { isError: true, content: [] };
        return text({ ok: true });
      }),
      close: async () => undefined,
    }));
    return { connect, calls };
  }
  const definition = linearConnector({ issue: async () => ({ token: "lin_api_secret", bindings: {} }) });

  async function hashOf(name: string, connect: ReturnType<typeof fakeConnect>["connect"], access: "read" | "write" = "write") {
    const connection = await connect();
    return reviewTools(connection as never, definition, context([[name, access]])).tools[0]!.schemaHash;
  }

  it("creates with the team bound and the description signed", async () => {
    const { connect, calls } = fakeConnect({});
    const schemaHash = await hashOf("save_issue", connect);
    const result = await executeTool({ requestId: "11111111-1111-4111-8111-111111111111", scope: "charterarc", tool: "save_issue", schemaHash, arguments: { title: "Flaky login", description: "Steps" } },
      definition, context([["save_issue", "write"]]), { ledger: memoryLedger(), connect, attribution: "Requested by `Slack member U1` via AgentX" });
    expect(result.status).toBe("SUCCEEDED");
    expect(calls).toEqual([{ name: "save_issue", args: { title: "Flaky login", description: "Steps\n\n—\nRequested by `Slack member U1` via AgentX", team: CHARTERARC } }]);
  });

  it("never sends the update when the issue is in another team", async () => {
    const { connect, calls } = fakeConnect({ "OTH-9": OTHER });
    const schemaHash = await hashOf("save_issue", connect);
    const result = await executeTool({ requestId: "22222222-2222-4222-8222-222222222222", scope: "charterarc", tool: "save_issue", schemaHash, arguments: { id: "OTH-9", priority: 1 } },
      definition, context([["save_issue", "write"]]), { ledger: memoryLedger(), connect });
    expect(result).toMatchObject({ status: "FAILED", reason: "policy_denied" });
    expect(calls.map((call) => call.name)).toEqual(["get_issue"]);
  });

  it("comments without a team argument", async () => {
    const { connect, calls } = fakeConnect({ "CHA-1": CHARTERARC });
    const schemaHash = await hashOf("save_comment", connect);
    const result = await executeTool({ requestId: "33333333-3333-4333-8333-333333333333", scope: "charterarc", tool: "save_comment", schemaHash, arguments: { issueId: "CHA-1", body: "Deployed" } },
      definition, context([["save_comment", "write"]]), { ledger: memoryLedger(), connect, attribution: "Requested by x" });
    expect(result.status).toBe("SUCCEEDED");
    expect(calls).toEqual([{ name: "get_issue", args: { id: "CHA-1" } }, { name: "save_comment", args: { issueId: "CHA-1", body: "Deployed\n\n—\nRequested by x" } }]);
  });

  it("refuses a model-supplied team before connecting", async () => {
    const { connect } = fakeConnect({});
    await expect(executeTool({ requestId: "44444444-4444-4444-8444-444444444444", scope: "charterarc", tool: "save_issue", schemaHash: "0".repeat(64), arguments: { title: "x", team: OTHER } },
      definition, context([["save_issue", "write"]]), { ledger: memoryLedger(), connect })).rejects.toThrow("Linear routing arguments are server controlled");
    expect(connect).not.toHaveBeenCalled();
  });

  it.each([
    ["parentId", { title: "new", parentId: "OTH-9" }],
    ["duplicateOf", { id: "CHA-1", duplicateOf: "OTH-9" }],
    ["relatedTo", { id: "CHA-1", relatedTo: ["CHA-2", "OTH-9"] }],
  ])("never sends save_issue when %s names an issue in another team", async (_field, args) => {
    const { connect, calls } = fakeConnect({ "CHA-1": CHARTERARC, "CHA-2": CHARTERARC, "OTH-9": OTHER });
    const schemaHash = await hashOf("save_issue", connect);
    const result = await executeTool({ requestId: "55555555-5555-4555-8555-555555555555", scope: "charterarc", tool: "save_issue", schemaHash, arguments: args },
      definition, context([["save_issue", "write"]]), { ledger: memoryLedger(), connect });
    expect(result).toMatchObject({ status: "FAILED", reason: "policy_denied" });
    expect(calls.map((call) => call.name)).not.toContain("save_issue");
  });

  it.each([
    ["list_documents", "teamId", "declares"],
    ["save_issue", "team", "declares"],
    ["save_issue", "teamId", "lacks"],
    ["save_comment", "team", "lacks"],
  ])("refuses a model-supplied %s %s (the tool %s it) before connecting", async (tool, property) => {
    const { connect } = fakeConnect({});
    await expect(executeTool({ requestId: "66666666-6666-4666-8666-666666666666", scope: "charterarc", tool, schemaHash: "0".repeat(64), arguments: { [property]: OTHER } },
      definition, context([[tool, "write"]]), { ledger: memoryLedger(), connect })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(connect).not.toHaveBeenCalled();
  });

  it.each([["an error", {}], ["an unreadable answer", { "CHA-1": "garbage" }]])("denies the write when get_issue returns %s", async (_case, teamOf) => {
    const { connect, calls } = fakeConnect(teamOf);
    const schemaHash = await hashOf("save_issue", connect);
    const result = await executeTool({ requestId: "77777777-7777-4777-8777-777777777777", scope: "charterarc", tool: "save_issue", schemaHash, arguments: { id: "CHA-1", priority: 1 } },
      definition, context([["save_issue", "write"]]), { ledger: memoryLedger(), connect });
    expect(result).toMatchObject({ status: "FAILED", reason: "policy_denied" });
    expect(calls.map((call) => call.name)).toEqual(["get_issue"]);
  });

  it("never calls Linear for get_issue with includeRelations: true", async () => {
    const { connect, calls } = fakeConnect({ "CHA-1": CHARTERARC });
    const schemaHash = await hashOf("get_issue", connect, "read");
    const result = await executeTool({ requestId: "88888888-8888-4888-8888-888888888888", scope: "charterarc", tool: "get_issue", schemaHash, arguments: { id: "CHA-1", includeRelations: true } },
      definition, context([["get_issue", "read"]]), { ledger: memoryLedger(), connect });
    expect(result).toMatchObject({ status: "FAILED", reason: "policy_denied" });
    expect(calls).toEqual([]);
  });
});
