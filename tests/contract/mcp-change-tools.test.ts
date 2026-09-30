// tests/contract/mcp-change-tools.test.ts
// Spec 025 FR-028, FR-030, FR-041: the change tools, offered only with a confirmation method, each
// planning, confirming and applying in one call.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ADMIN_AUDIT_TOOLS, ADMIN_CHANGE_TOOLS, ADMIN_READ_TOOLS, DEVELOPER_TOOLS, REQUIRED_CHANGE_ADMIN_MINOR, ToolError, adminApiFits, createAgentXMcpServer, type AdminControlPlaneClient, type AdminOffer, type ToolContext } from "../../packages/mcp/src/index.js";
import { agentxMcpServer } from "../../packages/cli/src/mcp/serve.js";
import { saveDeveloperEnvironment, developerTokenKey } from "../../packages/cli/src/developer/config.js";
import { InMemoryTokenStore } from "../../packages/cli/src/token-store.js";
import { toolError } from "../support/mcp-tool-error.js";

const CHANGE = "55555555-5555-4555-8555-555555555555";
const pending = { changeId: CHANGE, kind: "bind_channel" as const, status: "pending" as const, effect: "Bind channel #ledger-dev (C0LEDGER01) to project ledger.", methodsOffered: ["elicitation" as const], createdAt: "2026-10-02T09:00:00.000Z", expiresAt: "2026-10-02T09:10:00.000Z" };

interface ConnectOptions {
  admin?: Partial<AdminControlPlaneClient>;
  elicitation?: boolean;
  offer?: (client: { elicitation: boolean }) => Promise<AdminOffer>;
  answer?: "accept" | "decline";
  confirmation?: { elicitation: boolean; slack: boolean };
  newRequestId?: () => string;
  clock?: { now(): number; sleep(ms: number, signal: AbortSignal): Promise<void> };
}

async function connect(options: ConnectOptions) {
  const context = (): ToolContext => ({
    client: {} as never, clientName: "claude-code", clientVersion: "2.1.0", serverVersion: "0.0.7", adminSignedIn: async () => true,
    compatibility: async () => ({ env: "staging", apiVersion: "1.2", adminApiVersion: "1.1", confirm: { elicitation: true, slack: false } }),
    confirmation: async () => options.confirmation ?? { elicitation: true, slack: false },
    now: () => options.clock?.now() ?? Date.parse("2026-10-02T09:00:01.000Z"), sleep: async (ms, signal) => { await options.clock?.sleep(ms, signal); },
    newRequestId: options.newRequestId ?? (() => "88888888-8888-4888-8888-888888888888"),
    ...(options.admin === undefined ? {} : { admin: options.admin as AdminControlPlaneClient }),
  });
  const offer = options.offer ?? (async (client: { elicitation: boolean }) => ({ admin: undefined, audit: undefined, changes: client.elicitation ? undefined : new ToolError("CONFIRMATION_UNAVAILABLE", "no confirmation method is available in this session") }));
  const server = createAgentXMcpServer({ version: "0.0.7", context, adminTools: ADMIN_READ_TOOLS, auditTools: ADMIN_AUDIT_TOOLS, changeTools: ADMIN_CHANGE_TOOLS, adminOffer: offer });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "claude-code", version: "2.1.0" }, { capabilities: options.elicitation === false ? {} : { elicitation: { form: {} } } });
  const asked: string[] = [];
  if (options.elicitation !== false) client.setRequestHandler(ElicitRequestSchema, async (request) => { asked.push(String(request.params.message)); return options.answer === "decline" ? { action: "decline" } : { action: "accept", content: { confirm: true } }; });
  await client.connect(clientSide);
  return { client, asked };
}

const offered = async (client: Client, name: string) => {
  await expect.poll(async () => (await client.listTools()).tools.some((tool) => tool.name === name)).toBe(true);
};

describe("the change tools (FR-030)", () => {
  it("are FR-030's nine, in order, plus agentx_admin_changes", () => {
    expect(ADMIN_CHANGE_TOOLS.map((tool) => tool.name)).toEqual([
      "agentx_admin_register_project_revision", "agentx_admin_bind_channel", "agentx_admin_unbind_channel", "agentx_admin_register_credential", "agentx_admin_stop_workspace",
      "agentx_admin_grant_project_access", "agentx_admin_revoke_project_access", "agentx_admin_revoke_signin", "agentx_admin_set_workspace_limits",
    ]);
    expect(ADMIN_AUDIT_TOOLS.map((tool) => tool.name)).toEqual(["agentx_admin_changes"]);
    expect(JSON.stringify([...ADMIN_CHANGE_TOOLS, ...ADMIN_AUDIT_TOOLS].map((tool) => [tool.title, tool.description, Object.values(tool.inputSchema).map((field) => (field as { description?: string }).description)]))).not.toContain(String.fromCharCode(0x2014));
  });

  it("plans, shows the effect in the pop-up, applies on yes, and answers the change ID and outcome", async () => {
    const proposeChange = vi.fn(async () => pending);
    const applyChange = vi.fn(async () => ({ ...pending, status: "applied" as const, methodUsed: "elicitation" as const, result: { binding: { channelId: "C0LEDGER01" } } }));
    const { client, asked } = await connect({ admin: { proposeChange, applyChange } });
    await offered(client, "agentx_admin_bind_channel");
    const result = await client.callTool({ name: "agentx_admin_bind_channel", arguments: { channel: "#ledger-dev", project: "ledger" } });
    expect(proposeChange).toHaveBeenCalledWith({ requestId: expect.any(String) as unknown, change: { kind: "bind_channel", channel: "#ledger-dev", project: "ledger" }, client: { cliVersion: "0.0.7", mcpClient: { name: "claude-code", version: "2.1.0" } }, methods: ["elicitation"] }, "88888888-8888-4888-8888-888888888888");
    expect(asked[0]).toContain("Bind channel #ledger-dev (C0LEDGER01) to project ledger.");
    expect(result.structuredContent).toMatchObject({ change_id: CHANGE, outcome: "applied", method: "elicitation", effect: pending.effect });
  });

  it("answers CONFIRMATION_DECLINED naming the change when the admin says no", async () => {
    const { client } = await connect({ admin: { proposeChange: async () => pending, declineChange: async () => ({ ...pending, status: "declined" as const }) }, answer: "decline" });
    await offered(client, "agentx_admin_unbind_channel");
    expect(toolError(await client.callTool({ name: "agentx_admin_unbind_channel", arguments: { channel: "C0LEDGER01" } }))).toMatchObject({ code: "CONFIRMATION_DECLINED", message: expect.stringContaining(CHANGE) as unknown });
  });

  it("offers no change tool, and answers CONFIRMATION_UNAVAILABLE, in a client with neither method (FR-041)", async () => {
    const { client } = await connect({ admin: {}, elicitation: false });
    await offered(client, "agentx_admin_changes");
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names.filter((name) => ADMIN_CHANGE_TOOLS.some((tool) => tool.name === name))).toEqual([]);
    expect(toolError(await client.callTool({ name: "agentx_admin_set_workspace_limits", arguments: { per_person: 5 } }))).toMatchObject({ code: "CONFIRMATION_UNAVAILABLE", next_step: "use a client that supports elicitation, link a Slack user, or use the agentx CLI" });
  });

  it("maps the limits tool's snake_case input, and refuses an empty one before planning", async () => {
    const proposeChange = vi.fn(async () => pending);
    const { client } = await connect({ admin: { proposeChange, applyChange: async () => ({ ...pending, status: "applied" as const }) } });
    await offered(client, "agentx_admin_set_workspace_limits");
    await client.callTool({ name: "agentx_admin_set_workspace_limits", arguments: { per_person: 5 } });
    expect(proposeChange).toHaveBeenCalledWith(expect.objectContaining({ change: { kind: "set_workspace_limits", perPerson: 5 } }), expect.any(String));
    expect(toolError(await client.callTool({ name: "agentx_admin_set_workspace_limits", arguments: {} }))).toMatchObject({ code: "INVALID_REQUEST" });
    expect(proposeChange).toHaveBeenCalledTimes(1);
  });

  it("lists the audit records with agentx_admin_changes, newest first, with the next cursor", async () => {
    const changes = vi.fn(async () => ({ cursor: "more", changes: [{
      changeId: CHANGE, kind: "bind_channel" as const, traceId: "t", status: "applied" as const, outcome: "confirmed" as const, admin: { issuer: "i", subject: "s", displayName: "Ada" }, client: { cliVersion: "0.0.7", mcpClientName: "claude-code" },
      change: {}, effect: pending.effect, methodsOffered: ["elicitation" as const], methodUsed: "elicitation" as const, proposedAt: "2026-10-02T09:00:00.000Z", appliedAt: "2026-10-02T09:01:00.000Z",
    }] }));
    const { client } = await connect({ admin: { changes } });
    await offered(client, "agentx_admin_changes");
    const result = await client.callTool({ name: "agentx_admin_changes", arguments: { outcome: "confirmed", limit: 10 } });
    expect(changes).toHaveBeenCalledWith(expect.objectContaining({ outcome: "confirmed", limit: 10, since: expect.any(String) as unknown }));
    expect(result.structuredContent).toMatchObject({ next_cursor: "more", changes: [{ change_id: CHANGE, outcome: "confirmed", admin: "Ada", method_used: "elicitation", applied_at: "2026-10-02T09:01:00.000Z", trace_id: "t" }] });
  });
});

describe("a change tool's confirmation (FR-041, SC-005)", () => {
  it("asks again after a decline and gets a new change (B3, FR-049)", async () => {
    let next = 0;
    const newRequestId = () => `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`;
    const proposeChange = vi.fn(async () => pending);
    const { client } = await connect({ admin: { proposeChange, declineChange: async () => ({ ...pending, status: "declined" as const }) }, answer: "decline", newRequestId });
    await offered(client, "agentx_admin_bind_channel");
    const call = { name: "agentx_admin_bind_channel", arguments: { channel: "C0LEDGER01", project: "ledger" } };
    expect(toolError(await client.callTool(call))).toMatchObject({ code: "CONFIRMATION_DECLINED" });
    expect(toolError(await client.callTool(call))).toMatchObject({ code: "CONFIRMATION_DECLINED" });
    const [first, second] = proposeChange.mock.calls.map((entry) => (entry as unknown as [{ requestId: string }])[0].requestId);
    expect(first).toBeDefined();
    expect(second).not.toBe(first);
  });

  it("makes a new change after one that applied, or that a refusal ended, too", async () => {
    let next = 0;
    const newRequestId = () => `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`;
    const proposeChange = vi.fn()
      .mockRejectedValueOnce(new ToolError("INVALID_REQUEST", "project not found"))
      .mockResolvedValue(pending);
    const applyChange = vi.fn(async () => ({ ...pending, status: "applied" as const, methodUsed: "elicitation" as const }));
    const { client } = await connect({ admin: { proposeChange, applyChange }, newRequestId });
    await offered(client, "agentx_admin_revoke_signin");
    const call = { name: "agentx_admin_revoke_signin", arguments: { developer: "U0123456789" } };
    expect(toolError(await client.callTool(call))).toMatchObject({ code: "INVALID_REQUEST" });
    await client.callTool(call);
    await client.callTool(call);
    const ids = proposeChange.mock.calls.map((entry) => (entry as unknown as [{ requestId: string }])[0].requestId);
    expect(new Set(ids).size).toBe(3);
  });

  it("keeps the request ID of a change still waiting for its Slack Confirm, so an unchanged retry is the same change", async () => {
    let next = 0;
    const newRequestId = () => `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`;
    let now = Date.parse("2026-10-02T09:00:01.000Z");
    const sleeps: AbortSignal[] = [];
    const clock = { now: () => now, sleep: async (ms: number, signal: AbortSignal) => { sleeps.push(signal); now += ms; } };
    const slackPending = { ...pending, methodsOffered: ["slack" as const] };
    const proposeChange = vi.fn(async () => slackPending);
    const startSlackConfirmation = vi.fn(async () => slackPending);
    const getChange = vi.fn(async () => slackPending);
    const { client } = await connect({ admin: { proposeChange, startSlackConfirmation, getChange }, elicitation: false, confirmation: { elicitation: true, slack: true }, newRequestId, clock, offer: async () => ({ admin: undefined, audit: undefined, changes: undefined }) });
    await offered(client, "agentx_admin_grant_project_access");
    const call = { name: "agentx_admin_grant_project_access", arguments: { project: "ledger", developer: "ada@example.com" } };
    const result = await client.callTool(call);
    expect(result.structuredContent).toMatchObject({ change_id: CHANGE, outcome: "awaiting_confirmation" });
    // No pop-up in this client: Slack only, whatever the environment allows for elicitation.
    expect(proposeChange).toHaveBeenCalledWith(expect.objectContaining({ methods: ["slack"], change: { kind: "grant_project_access", project: "ledger", developer: "ada@example.com" } }), expect.any(String));
    // FR-052: one trace ID for the proposal, the Slack step and every poll.
    const trace = (proposeChange.mock.calls[0] as unknown as [unknown, string])[1];
    expect(startSlackConfirmation).toHaveBeenCalledWith(CHANGE, trace);
    for (const poll of getChange.mock.calls) expect((poll as unknown as [string, string])[1]).toBe(trace);
    // The sleep between polls gets the tool call's own signal.
    expect(sleeps.length).toBeGreaterThan(0);
    for (const signal of sleeps) expect(signal).toBeInstanceOf(AbortSignal);
    await client.callTool(call);
    const ids = proposeChange.mock.calls.map((entry) => (entry as unknown as [{ requestId: string }])[0].requestId);
    expect(ids[1]).toBe(ids[0]);
  });

  it("offers elicitation only when the environment allows it, and Slack only when the admin's link does", async () => {
    const proposeChange = vi.fn(async () => ({ ...pending, methodsOffered: ["slack" as const] }));
    const startSlackConfirmation = vi.fn(async () => ({ ...pending, status: "applied" as const, methodUsed: "slack" as const }));
    const { client, asked } = await connect({ admin: { proposeChange, startSlackConfirmation }, confirmation: { elicitation: false, slack: true }, offer: async () => ({ admin: undefined, audit: undefined, changes: undefined }) });
    await offered(client, "agentx_admin_stop_workspace");
    const result = await client.callTool({ name: "agentx_admin_stop_workspace", arguments: { workspace_id: "66666666-6666-4666-8666-666666666666" } });
    expect(proposeChange).toHaveBeenCalledWith(expect.objectContaining({ methods: ["slack"] }), expect.any(String));
    expect(asked).toEqual([]);
    expect(result.structuredContent).toMatchObject({ outcome: "applied", method: "slack" });
  });

  it("answers CONFIRMATION_UNAVAILABLE without planning when no method is left for this call", async () => {
    const proposeChange = vi.fn(async () => pending);
    const { client } = await connect({ admin: { proposeChange }, confirmation: { elicitation: false, slack: false }, offer: async () => ({ admin: undefined, audit: undefined, changes: undefined }) });
    await offered(client, "agentx_admin_revoke_signin");
    expect(toolError(await client.callTool({ name: "agentx_admin_revoke_signin", arguments: { developer: "U0123456789", confirm: true, method: "cli" } }))).toMatchObject({ code: "CONFIRMATION_UNAVAILABLE" });
    expect(proposeChange).not.toHaveBeenCalled();
  });

  it("never lets the tool input confirm, apply or decline a change (SC-005)", async () => {
    const proposeChange = vi.fn(async () => pending);
    const applyChange = vi.fn(async () => ({ ...pending, status: "applied" as const }));
    const declineChange = vi.fn(async () => ({ ...pending, status: "declined" as const }));
    const { client } = await connect({ admin: { proposeChange, applyChange, declineChange }, answer: "decline" });
    await offered(client, "agentx_admin_bind_channel");
    const listed = (await client.listTools()).tools;
    // No tool applies, declines or confirms a change directly, and no change tool takes such input.
    expect(listed.filter((tool) => /apply|decline|confirm/.test(tool.name))).toEqual([]);
    for (const tool of listed.filter((entry) => ADMIN_CHANGE_TOOLS.some((change) => change.name === entry.name))) {
      expect(Object.keys(tool.inputSchema.properties ?? {}).filter((key) => /confirm|method|apply|decline|answer|approved/.test(key))).toEqual([]);
    }
    const refused = toolError(await client.callTool({ name: "agentx_admin_bind_channel", arguments: { channel: "C0LEDGER01", project: "ledger", confirm: true, confirmed: true, method: "cli", methods: ["cli"], answer: "accept" } }));
    expect(refused.code).toBe("CONFIRMATION_DECLINED");
    expect(applyChange).not.toHaveBeenCalled();
    expect(declineChange).toHaveBeenCalledTimes(1);
    // The proposal carries only the change's own fields, and the methods this session has.
    expect(proposeChange).toHaveBeenCalledWith(expect.objectContaining({ change: { kind: "bind_channel", channel: "C0LEDGER01", project: "ledger" }, methods: ["elicitation"] }), expect.any(String));
  });

  it("names the change and says it is still waiting when AgentX is applying it already", async () => {
    const { client } = await connect({ admin: { proposeChange: async () => ({ ...pending, status: "applying" as const }) } });
    await offered(client, "agentx_admin_unbind_channel");
    const refused = toolError(await client.callTool({ name: "agentx_admin_unbind_channel", arguments: { channel: "C0LEDGER01" } }));
    expect(refused.message).toContain(CHANGE);
    expect(refused.next_step).toContain("agentx_admin_changes");
  });

  it("says channel names work with or without #", () => {
    const bind = ADMIN_CHANGE_TOOLS.find((tool) => tool.name === "agentx_admin_bind_channel")!;
    const unbind = ADMIN_CHANGE_TOOLS.find((tool) => tool.name === "agentx_admin_unbind_channel")!;
    for (const tool of [bind, unbind]) expect(tool.inputSchema.channel?.description).toContain("with or without #");
  });
});

describe("the change tools' admin API (C17, E18, Q11)", () => {
  it("need admin API 1.1", () => {
    expect(REQUIRED_CHANGE_ADMIN_MINOR).toBe(1);
    expect(adminApiFits("1.0")).toBe("fits");
    expect(adminApiFits("1.0", REQUIRED_CHANGE_ADMIN_MINOR)).toBe("too_old");
    expect(adminApiFits("1.1", REQUIRED_CHANGE_ADMIN_MINOR)).toBe("fits");
    expect(adminApiFits("2.1", REQUIRED_CHANGE_ADMIN_MINOR)).toBe("incompatible");
  });

  it("offers neither agentx_admin_changes nor the change tools to an offer that names only admin (25d's)", async () => {
    const { client } = await connect({ admin: {}, offer: async () => ({ admin: undefined }) });
    await offered(client, "agentx_admin_health");
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual([...DEVELOPER_TOOLS, ...ADMIN_READ_TOOLS].map((tool) => tool.name));
    expect(toolError(await client.callTool({ name: "agentx_admin_changes", arguments: {} }))).toMatchObject({ code: "UPGRADE_REQUIRED" });
  });
});

// `agentx mcp` itself: the offer reads the environment's methods and the admin's Slack link.
const URL_BASE = "https://abc123.execute-api.us-east-1.amazonaws.com";
const ISSUER = `${URL_BASE}/v1/auth`;
const ADMIN_TOKEN = "admin-access-token-planted-9c1e";

async function served(options: { adminApiVersion: string; confirm?: { elicitation: boolean; slack: boolean }; slackLinked?: boolean; elicitation: boolean }) {
  const home = await mkdtemp(join(tmpdir(), "agentx-change-mcp-"));
  const tokenStore = new InMemoryTokenStore();
  await saveDeveloperEnvironment(home, "staging", { url: URL_BASE, issuer: ISSUER, tokenEndpoint: `${ISSUER}/token`, revocationEndpoint: `${ISSUER}/revoke` });
  await tokenStore.set(developerTokenKey(ISSUER), { accessToken: "developer-token", refreshToken: `agxr_${"a".repeat(43)}`, expiresAt: Date.now() + 3_600_000 });
  const fetch = vi.fn(async (input: string | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/auth/.well-known/agentx-configuration") return Response.json({ env: "staging", apiVersion: "1.2", adminApiVersion: options.adminApiVersion, ...(options.confirm === undefined ? {} : { confirm: options.confirm }) });
    if (url.pathname === "/v1/admin/me") return Response.json({ issuer: ISSUER, subject: "s", slack: { linked: options.slackLinked === true, ...(options.slackLinked === true ? { userId: "U0123456789" } : { reason: "no_match" }) } });
    if (url.pathname === "/v1/admin/changes") return Response.json({ changes: [] });
    return Response.json({ developer: { id: "d".repeat(64), name: "Ada", provider: "slack" }, projects: [], notices: [] });
  });
  const stderr: string[] = [];
  const mcp = agentxMcpServer({
    home, tokenStore, fetch, stderr: { write: (text: string) => stderr.push(text) },
    adminSignedIn: async () => true,
    adminSession: async () => ({ baseUrl: URL_BASE, accessToken: ADMIN_TOKEN }),
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverSide);
  const client = new Client({ name: "claude-code", version: "2.1.0" }, { capabilities: options.elicitation ? { elicitation: { form: {} } } : {} });
  if (options.elicitation) client.setRequestHandler(ElicitRequestSchema, async () => ({ action: "decline" }));
  await client.connect(clientSide);
  return { client, fetch, stderr };
}

describe("agentx mcp's change tool offer (FR-028, FR-041)", () => {
  const all = DEVELOPER_TOOLS.length + ADMIN_READ_TOOLS.length + ADMIN_AUDIT_TOOLS.length + ADMIN_CHANGE_TOOLS.length;

  it("offers every change tool to a pop-up client where the environment allows the pop-up", async () => {
    const { client, stderr } = await served({ adminApiVersion: "1.1", confirm: { elicitation: true, slack: false }, elicitation: true });
    await expect.poll(async () => (await client.listTools()).tools.length).toBe(all);
    const result = await client.callTool({ name: "agentx_admin_changes", arguments: {} });
    expect(result.structuredContent).toEqual({ changes: [] });
    expect(JSON.stringify(result)).not.toContain(ADMIN_TOKEN);
    expect(stderr.join("")).not.toContain(ADMIN_TOKEN);
  });

  it("offers them to a client without the pop-up only when the admin's Slack user is linked and the environment allows Slack", async () => {
    const unlinked = await served({ adminApiVersion: "1.1", confirm: { elicitation: true, slack: true }, slackLinked: false, elicitation: false });
    await expect.poll(async () => (await unlinked.client.listTools()).tools.length).toBe(all - ADMIN_CHANGE_TOOLS.length);
    expect(toolError(await unlinked.client.callTool({ name: "agentx_admin_grant_project_access", arguments: { project: "ledger", developer: "U0123456789" } }))).toMatchObject({ code: "CONFIRMATION_UNAVAILABLE" });
    expect(unlinked.fetch.mock.calls.some((entry) => new URL(String(entry[0])).pathname === "/v1/admin/changes" && (entry as unknown as [string, RequestInit])[1].method === "POST")).toBe(false);
    const linked = await served({ adminApiVersion: "1.1", confirm: { elicitation: false, slack: true }, slackLinked: true, elicitation: false });
    await expect.poll(async () => (await linked.client.listTools()).tools.length).toBe(all);
  });

  it("offers no change tool where the environment turned the pop-up off and Slack is not linked", async () => {
    const { client } = await served({ adminApiVersion: "1.1", confirm: { elicitation: false, slack: true }, slackLinked: false, elicitation: true });
    await expect.poll(async () => (await client.listTools()).tools.length).toBe(all - ADMIN_CHANGE_TOOLS.length);
  });

  it("against a 1.0 control plane offers the admin read tools but neither agentx_admin_changes nor a change tool (E18, Q11)", async () => {
    const { client } = await served({ adminApiVersion: "1.0", elicitation: true });
    await expect.poll(async () => (await client.listTools()).tools.length).toBe(DEVELOPER_TOOLS.length + ADMIN_READ_TOOLS.length);
    expect(toolError(await client.callTool({ name: "agentx_admin_changes", arguments: {} }))).toMatchObject({ code: "UPGRADE_REQUIRED", next_step: "ask your AgentX admin to upgrade AgentX, or use an older CLI" });
    expect(toolError(await client.callTool({ name: "agentx_admin_grant_project_access", arguments: { project: "ledger", developer: "U0123456789" } }))).toMatchObject({ code: "UPGRADE_REQUIRED" });
  });
});
