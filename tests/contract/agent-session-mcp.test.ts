// Plan 5 Task 23: the MCP tools for sessions. `agentx_list_sessions`, `agentx_get_session` (which returns the session link), `agentx_comment_on_session`,
// `agentx_tell_session_agent` and `agentx_stop_session` reach the /v1/app/sessions routes. NO tool takes a session over, retries it or shares it with the
// company (a person does those, in a browser or on the CLI); a caller who may only view is refused with the server's exact words; everything the server
// wrote is made safe before it reaches the model.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { DEVELOPER_TOOLS, createAgentXMcpServer, httpControlPlaneClient, type ControlPlaneClient, type SessionListRead, type SessionMessageRead, type SessionViewRead, type ToolContext } from "../../packages/mcp/src/index.js";

const SES = "ses_aaaaaaaaaaaaaaaaaaaa";
const SES2 = "ses_bbbbbbbbbbbbbbbbbbbb";
const DEV = "d".repeat(64);
const CELL = "https://abc123.execute-api.us-west-2.amazonaws.com";
const LINK = `${CELL}/s/${SES}`;
const REQ = "33333333-3333-4333-8333-333333333333";
const structured = (result: unknown) => (result as { structuredContent?: Record<string, unknown> }).structuredContent ?? {};
const text = (result: unknown) => (result as { content?: Array<{ text: string }> }).content?.[0]?.text ?? "";
const isError = (result: unknown) => (result as { isError?: boolean }).isError === true;

const sessionView = (extra: Record<string, unknown> = {}): SessionViewRead => ({
  contractVersion: 1, sessionId: SES, kind: "task", mode: "delegate", title: "Fix the login bug", project: "payments", owner: { developerId: DEV, name: "Priya" },
  startedBy: { kind: "member", developerId: DEV }, where: { kind: "cloud" }, status: "running", step: "Writing the change", peek: "Reading auth.ts", lastRunFailed: undefined,
  cost: { spentUsd: 1.25, payer: { kind: "member", name: "Priya" } }, approvals: [], followers: 1, viewingNow: [],
  you: { level: "use", owner: false, following: false, actions: ["watch", "comment", "steer"] }, link: LINK, bindings: [], legs: [], revision: 3,
  createdAt: "2026-10-24T09:00:00.000Z", updatedAt: "2026-10-24T09:05:00.000Z", body: { kind: "local", tool: "codex" }, ...extra,
}) as unknown as SessionViewRead;
const tileOf = (sessionId: string, title: string) => ({
  contractVersion: 1, sessionId, kind: "task", title, project: "payments", owner: { developerId: DEV, name: "Priya" }, where: { kind: "cloud" }, level: "use", revision: 2,
  summary: { status: "running", step: "Coding", costUsd: 0.5, needsPeople: [], pendingApprovals: 0, digest: "d", computedAt: "2026-10-24T09:05:00.000Z" },
  createdAt: "2026-10-24T09:00:00.000Z", updatedAt: "2026-10-24T09:05:00.000Z",
});
const message = (kind: "comment" | "steer", delivery?: Record<string, unknown>): SessionMessageRead => ({
  messageId: "msg_aaaaaaaaaaaaaaaaaaaa", sessionId: SES, kind, source: "app", author: { developerId: DEV, name: "Priya" }, text: "hello", createdAt: "2026-10-24T09:06:00.000Z", rev: 1,
  ...(delivery === undefined ? {} : { delivery }),
}) as unknown as SessionMessageRead;
/** A page of the list, as the client reads it. */
const listOf = (sessions: unknown[], next?: string): SessionListRead => ({ sessions, ...(next === undefined ? {} : { next }) }) as unknown as SessionListRead;

async function connect(client: Partial<ControlPlaneClient>, newRequestId = () => REQ) {
  const context = (name: string | undefined): ToolContext => ({
    client: client as ControlPlaneClient, clientName: name, serverVersion: "0.4.0",
    adminSignedIn: async () => false, compatibility: async () => ({ env: "staging", apiVersion: "1.2" }),
    now: () => 0, sleep: async () => undefined, newRequestId,
  });
  const server = createAgentXMcpServer({ version: "0.4.0", context });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const mcp = new Client({ name: "claude-code", version: "1.0.0" });
  await mcp.connect(clientSide);
  return mcp;
}

/** The real HTTP client against a fetch that answers one thing, and the tools on top of it. */
async function overHttp(answer: (url: URL, init: RequestInit | undefined) => Response) {
  const calls: Array<{ method: string; path: string; query: string; body: unknown }> = [];
  const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push({ method: init?.method ?? "GET", path: url.pathname, query: url.search, body: typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined });
    return answer(url, init);
  });
  const client = httpControlPlaneClient({ session: async () => ({ baseUrl: CELL, accessToken: "tok", signInCommand: "npx x login" }), fetch: fetchImplementation, sleep: async () => undefined, tries: 1 });
  return { mcp: await connect(client), calls, client };
}

describe("the session tools in the list", () => {
  it("adds exactly the five session tools", async () => {
    const names = (await (await connect({})).listTools()).tools.map((tool) => tool.name);
    expect(names.filter((name) => /session/.test(name))).toEqual(["agentx_list_sessions", "agentx_get_session", "agentx_comment_on_session", "agentx_tell_session_agent", "agentx_stop_session"]);
  });

  it("has no tool that takes a session over, retries it, shares it or hands it off", async () => {
    const { tools } = await (await connect({})).listTools();
    for (const tool of tools) {
      if (!/session/.test(tool.name)) continue;
      expect(tool.name, tool.name).not.toMatch(/take.?over|retry|share|handoff|hand_off|owner|approve|confirm/i);
    }
    // The client the tools are written against has no call for them either: its session calls are the five reads and writes below.
    const client = httpControlPlaneClient({ session: async () => ({ baseUrl: CELL, accessToken: "t", signInCommand: "x" }), fetch: vi.fn<typeof fetch>() });
    expect(Object.keys(client).filter((name) => /session/i.test(name)).sort()).toEqual(["commentOnSession", "getSession", "listSessions", "stopSession", "tellSessionAgent"]);
    for (const tool of DEVELOPER_TOOLS.filter((definition) => /session/.test(definition.name))) {
      expect(Object.keys(tool.inputSchema), tool.name).not.toContain("principal");
      expect(Object.keys(tool.inputSchema), tool.name).not.toContain("level");
    }
  });

  it("gives every tool an output schema and no em dash", async () => {
    const { tools } = await (await connect({})).listTools();
    for (const tool of tools.filter((entry) => /session/.test(entry.name))) {
      expect(tool.outputSchema, tool.name).toBeDefined();
      expect(JSON.stringify(tool)).not.toContain("—");
    }
  });
});

describe("agentx_list_sessions", () => {
  it("lists the caller's own sessions by default, or a project's, or those shared with them", async () => {
    const listSessions = vi.fn(async () => listOf([tileOf(SES, "Fix the login bug"), tileOf(SES2, "Add a retry")]));
    const mcp = await connect({ listSessions });
    const result = await mcp.callTool({ name: "agentx_list_sessions", arguments: {} });
    expect(listSessions).toHaveBeenLastCalledWith({ owner: "me" });
    expect(structured(result)).toMatchObject({ sessions: [{ id: SES, title: "Fix the login bug", project: "payments", owner: "Priya", status: "running", step: "Coding", cost_usd: 0.5, your_level: "use" }, { id: SES2 }] });
    expect(text(result)).toContain(SES);
    await mcp.callTool({ name: "agentx_list_sessions", arguments: { project: "payments" } });
    expect(listSessions).toHaveBeenLastCalledWith({ project: "payments" });
    await mcp.callTool({ name: "agentx_list_sessions", arguments: { shared_with_me: true } });
    expect(listSessions).toHaveBeenLastCalledWith({ shared: "me" });
    await mcp.callTool({ name: "agentx_list_sessions", arguments: { status: "open", cursor: "abc.def" } });
    expect(listSessions).toHaveBeenLastCalledWith({ owner: "me", status: "open", cursor: "abc.def" });
  });

  it("refuses a project together with shared_with_me without asking", async () => {
    const listSessions = vi.fn();
    const result = await (await connect({ listSessions })).callTool({ name: "agentx_list_sessions", arguments: { project: "payments", shared_with_me: true } });
    expect(isError(result)).toBe(true);
    expect(text(result)).toContain("INVALID_REQUEST");
    expect(listSessions).not.toHaveBeenCalled();
  });

  it("says when there is more, and when there is nothing", async () => {
    const mcp = await connect({ listSessions: vi.fn(async () => listOf([], "sealed.cursor")) });
    const result = await mcp.callTool({ name: "agentx_list_sessions", arguments: {} });
    expect(structured(result)).toMatchObject({ sessions: [], next_cursor: "sealed.cursor" });
    expect(text(result)).toMatch(/no sessions/i);
  });

  it("reaches GET /v1/app/sessions with the one list asked for", async () => {
    const { mcp, calls } = await overHttp(() => Response.json({ sessions: [tileOf(SES, "Fix the login bug")] }));
    await mcp.callTool({ name: "agentx_list_sessions", arguments: {} });
    await mcp.callTool({ name: "agentx_list_sessions", arguments: { project: "payments", status: "ended" } });
    expect(calls.map((call) => `${call.method} ${call.path}${call.query}`)).toEqual(["GET /v1/app/sessions?owner=me", "GET /v1/app/sessions?project=payments&status=ended"]);
  });
});

describe("agentx_get_session", () => {
  it("returns the session with its link, owner, status, what the caller may do and what waits for them", async () => {
    const approval = { approvalId: "apr_cccccccccccccccccccc", title: "Approve the plan", confirmUrl: `${CELL}/v1/app/approve/apr_cccccccccccccccccccc` };
    const getSession = vi.fn(async () => sessionView({ approvals: [approval] }));
    const result = await (await connect({ getSession })).callTool({ name: "agentx_get_session", arguments: { session_id: SES } });
    expect(getSession).toHaveBeenCalledWith(SES);
    expect(structured(result)).toMatchObject({
      id: SES, title: "Fix the login bug", link: LINK, project: "payments", owner: "Priya", status: "running", step: "Writing the change", latest: "Reading auth.ts",
      cost: { spent_usd: 1.25 }, you: { level: "use", owner: false, actions: ["watch", "comment", "steer"] },
      approvals: [{ title: "Approve the plan", confirm_url: approval.confirmUrl }],
    });
    expect(text(result)).toContain(LINK);
  });

  it("refuses something that is not a session ID", async () => {
    const getSession = vi.fn();
    const result = await (await connect({ getSession })).callTool({ name: "agentx_get_session", arguments: { session_id: "../etc" } });
    expect(isError(result)).toBe(true);
    expect(getSession).not.toHaveBeenCalled();
  });

  it("reaches GET /v1/app/sessions/{id}, and a session that is not there has its own code", async () => {
    const found = await overHttp(() => Response.json({ session: sessionView() }));
    const result = await found.mcp.callTool({ name: "agentx_get_session", arguments: { session_id: SES } });
    expect(found.calls).toEqual([{ method: "GET", path: `/v1/app/sessions/${SES}`, query: "", body: undefined }]);
    expect(structured(result)).toMatchObject({ link: LINK });
    const missing = await overHttp(() => Response.json({ error: { code: "NOT_FOUND", message: "session not found" } }, { status: 404 }));
    const gone = await missing.mcp.callTool({ name: "agentx_get_session", arguments: { session_id: SES } });
    expect(isError(gone)).toBe(true);
    expect(text(gone)).toContain("SESSION_NOT_FOUND");
    expect(text(gone)).toContain("session not found");
  });
});

describe("agentx_comment_on_session and agentx_tell_session_agent", () => {
  it("comments with a fresh request id for each call, so a deliberate second comment is a second comment; a request_id the caller gives is kept", async () => {
    const commentOnSession = vi.fn(async () => message("comment"));
    const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
    const mcp = await connect({ commentOnSession }, () => ids.shift()!);
    const first = await mcp.callTool({ name: "agentx_comment_on_session", arguments: { session_id: SES, text: "Looks good" } });
    await mcp.callTool({ name: "agentx_comment_on_session", arguments: { session_id: SES, text: "Looks good" } });
    await mcp.callTool({ name: "agentx_comment_on_session", arguments: { session_id: SES, text: "Looks good", request_id: REQ } });
    expect(commentOnSession).toHaveBeenNthCalledWith(1, SES, { requestId: "11111111-1111-4111-8111-111111111111", text: "Looks good" });
    expect(commentOnSession).toHaveBeenNthCalledWith(2, SES, { requestId: "22222222-2222-4222-8222-222222222222", text: "Looks good" });
    expect(commentOnSession).toHaveBeenNthCalledWith(3, SES, { requestId: REQ, text: "Looks good" });
    expect(structured(first)).toMatchObject({ on_session: SES, message_id: "msg_aaaaaaaaaaaaaaaaaaaa", kind: "comment" });
  });

  it("tells the agent with a fresh request id for each call", async () => {
    const tellSessionAgent = vi.fn<ControlPlaneClient["tellSessionAgent"]>(async () => message("steer", { state: "queued", at: "2026-10-24T09:06:00.000Z" }));
    const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
    const mcp = await connect({ tellSessionAgent }, () => ids.shift()!);
    for (let n = 0; n < 2; n += 1) await mcp.callTool({ name: "agentx_tell_session_agent", arguments: { session_id: SES, text: "Keep it small" } });
    expect(tellSessionAgent.mock.calls.map((call) => call[1].requestId)).toEqual(["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"]);
  });

  it("tells the agent, and says whether the message was queued or delivered", async () => {
    const tellSessionAgent = vi.fn(async () => message("steer", { state: "queued", at: "2026-10-24T09:06:00.000Z" }));
    const mcp = await connect({ tellSessionAgent });
    const result = await mcp.callTool({ name: "agentx_tell_session_agent", arguments: { session_id: SES, text: "Keep the change under 50 lines", request_id: REQ } });
    expect(tellSessionAgent).toHaveBeenCalledWith(SES, { requestId: REQ, text: "Keep the change under 50 lines" });
    expect(structured(result)).toMatchObject({ kind: "steer", delivery: "queued" });
    expect(text(result)).toMatch(/queued/i);
  });

  it("reaches the messages route with the kind in the body", async () => {
    const comment = await overHttp(() => Response.json(message("comment"), { status: 201 }));
    await comment.mcp.callTool({ name: "agentx_comment_on_session", arguments: { session_id: SES, text: "Looks good", request_id: REQ } });
    expect(comment.calls).toEqual([{ method: "POST", path: `/v1/app/sessions/${SES}/messages`, query: "", body: { requestId: REQ, kind: "comment", text: "Looks good" } }]);
    const steer = await overHttp(() => Response.json(message("steer", { state: "delivered", at: "2026-10-24T09:06:00.000Z" }), { status: 201 }));
    await steer.mcp.callTool({ name: "agentx_tell_session_agent", arguments: { session_id: SES, text: "Go on", request_id: REQ } });
    expect(steer.calls).toEqual([{ method: "POST", path: `/v1/app/sessions/${SES}/messages`, query: "", body: { requestId: REQ, kind: "steer", text: "Go on" } }]);
  });

  it("refuses empty or over-long text without asking", async () => {
    const tellSessionAgent = vi.fn();
    const mcp = await connect({ tellSessionAgent });
    for (const bad of ["", "   ", "x".repeat(10_001)]) {
      const result = await mcp.callTool({ name: "agentx_tell_session_agent", arguments: { session_id: SES, text: bad } });
      expect(isError(result), bad.slice(0, 5)).toBe(true);
    }
    expect(tellSessionAgent).not.toHaveBeenCalled();
  });

  it("gives a caller who may only view the server's exact SESSION_LEVEL_REQUIRED words", async () => {
    const words = "You need \"can use\" on this session to send messages to the agent. Ask Priya to share it with you.";
    const { mcp } = await overHttp(() => Response.json({ error: { code: "SESSION_LEVEL_REQUIRED", message: words } }, { status: 403 }));
    const result = await mcp.callTool({ name: "agentx_tell_session_agent", arguments: { session_id: SES, text: "Go faster" } });
    expect(isError(result)).toBe(true);
    expect(text(result)).toContain(words.replace(/\.$/, ""));
    expect(text(result)).toContain("SESSION_REFUSED");
    expect(text(result)).not.toContain("CONTROL_PLANE_UNAVAILABLE");
  });

  it("gives the server's words for a session on a Mac the company has not allowed (LOCAL_AGENT_NOT_ALLOWED, stubbed)", async () => {
    const words = "claude-code isn't allowed in your company. Ask an admin to allow it.";
    const { mcp, calls } = await overHttp(() => Response.json({ error: { code: "LOCAL_AGENT_NOT_ALLOWED", message: words } }, { status: 403 }));
    const result = await mcp.callTool({ name: "agentx_tell_session_agent", arguments: { session_id: SES, text: "Go faster" } });
    expect(isError(result)).toBe(true);
    expect(text(result)).toContain(words.replace(/\.$/, ""));
    expect(text(result)).toContain("SESSION_REFUSED");
    expect(calls).toHaveLength(1);
  });
});

describe("agentx_stop_session", () => {
  it("stops a session with a request id and answers the session that carries on", async () => {
    const stopSession = vi.fn(async () => sessionView({ status: "stopped" }));
    const result = await (await connect({ stopSession })).callTool({ name: "agentx_stop_session", arguments: { session_id: SES } });
    expect(stopSession).toHaveBeenCalledWith(SES, REQ);
    expect(structured(result)).toMatchObject({ id: SES, status: "stopped", link: LINK });
  });

  it("says nothing was running, with the server's words, and never Stop requested, when the stop found nothing to stop", async () => {
    const stopSession = vi.fn(async () => ({ ...sessionView({ status: "needs_person" }), nothingRunning: "This task is blocked, not running. To end it, use Close task (it checks for unpublished work first)." }));
    const text = (await (await connect({ stopSession })).callTool({ name: "agentx_stop_session", arguments: { session_id: SES } })).content as Array<{ text: string }>;
    expect(text[0]!.text).toMatch(/^This task is blocked, not running\. To end it, use Close task/u);
    expect(text[0]!.text).not.toContain("Stop requested");
  });

  it("a second stop after the session was continued is a new request, not the first one's stored outcome", async () => {
    const stopSession = vi.fn<ControlPlaneClient["stopSession"]>(async () => sessionView({ status: "stopped" }));
    const made = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
    const queue = [...made];
    const mcp = await connect({ stopSession }, () => queue.shift()!);
    await mcp.callTool({ name: "agentx_stop_session", arguments: { session_id: SES } });
    await mcp.callTool({ name: "agentx_stop_session", arguments: { session_id: SES } });
    expect(stopSession.mock.calls.map((call) => call[1])).toEqual(made);
  });

  it("reaches POST /v1/app/sessions/{id}/stop with only a request id", async () => {
    const { mcp, calls } = await overHttp(() => Response.json({ session: sessionView({ status: "stopped" }) }));
    await mcp.callTool({ name: "agentx_stop_session", arguments: { session_id: SES, request_id: REQ } });
    expect(calls).toEqual([{ method: "POST", path: `/v1/app/sessions/${SES}/stop`, query: "", body: { requestId: REQ } }]);
  });
});

describe("links are the control plane's own: https, its origin, no userinfo, whole", () => {
  const ok = `${CELL}/v1/app/approve/apr_cccccccccccccccccccc`;
  const approval = (confirmUrl: string) => ({ approvalId: "apr_cccccccccccccccccccc", title: "Approve the plan", confirmUrl });

  it("keeps a link on the control plane's origin", async () => {
    const { mcp } = await overHttp(() => Response.json({ session: sessionView({ approvals: [approval(ok)] }) }));
    const result = await mcp.callTool({ name: "agentx_get_session", arguments: { session_id: SES } });
    expect(structured(result)).toMatchObject({ link: LINK, approvals: [{ title: "Approve the plan", confirm_url: ok }] });
  });

  it.each([
    ["another host", "https://evil.example/s/ses_aaaaaaaaaaaaaaaaaaaa"],
    ["userinfo", `${CELL.replace("https://", "https://x@")}/s/${SES}`],
    ["the real host as userinfo", `${CELL}@evil.example/s/${SES}`],
    ["a longer host", `${CELL}.evil.example/s/${SES}`],
    ["another port", `${CELL}:8443/s/${SES}`],
    ["http", `${CELL.replace("https", "http")}/s/${SES}`],
    ["a password only", `${CELL.replace("https://", "https://:pw@")}/s/${SES}`],
    ["a bidi character", `${CELL}/s/${SES}\u202e`],
    ["a space", `${CELL}/s/${SES} x`],
    ["javascript:", "javascript:alert(1)"],
    ["more than 1,000 characters", `${CELL}/s/${SES}?${"a".repeat(1_000)}`],
  ])("leaves the link and the decision links out for %s", async (_name, bad) => {
    const { mcp } = await overHttp(() => Response.json({ session: sessionView({ link: bad, approvals: [approval(bad), approval(ok)] }) }));
    for (const call of [{ name: "agentx_get_session", arguments: { session_id: SES } }, { name: "agentx_stop_session", arguments: { session_id: SES } }]) {
      const result = await mcp.callTool(call);
      expect(isError(result), call.name).toBe(false);
      const out = structured(result);
      expect(out, call.name).not.toHaveProperty("link");
      expect(out["approvals"], call.name).toEqual([{ title: "Approve the plan" }, { title: "Approve the plan", confirm_url: ok }]);
      expect(text(result), call.name).not.toContain("evil.example");
      expect(text(result), call.name).not.toContain("javascript:");
      expect(text(result), call.name).not.toContain("a".repeat(100));
    }
  });
});

describe("an install on this computer links to its local pages over plain http", () => {
  const LOCAL = "http://127.0.0.1:4410";
  const overLoopback = async (base: string, link: string) => {
    const client = httpControlPlaneClient({ session: async () => ({ baseUrl: base, accessToken: "tok", signInCommand: "npx x login" }), fetch: vi.fn<typeof fetch>(async () => Response.json({ session: sessionView({ link }) })), sleep: async () => undefined, tries: 1 });
    return structured(await (await connect(client)).callTool({ name: "agentx_get_session", arguments: { session_id: SES } }));
  };

  it("keeps an http link on the same loopback origin", async () => {
    expect(await overLoopback(LOCAL, `${LOCAL}/s/abc/plan/1`)).toMatchObject({ link: `${LOCAL}/s/abc/plan/1` });
  });

  it.each([
    ["another port", "http://127.0.0.1:4411/s/abc"],
    ["another host", "http://evil.example:4410/s/abc"],
    ["userinfo", "http://x@127.0.0.1:4410/s/abc"],
    ["a name that resolves to loopback", "http://localhost:4410/s/abc"],
  ])("leaves out %s", async (_name, bad) => {
    expect(await overLoopback(LOCAL, bad)).not.toHaveProperty("link");
  });

  it("does not turn a hosted install's origin into one that allows http", async () => {
    expect(await overLoopback(CELL, `${LOCAL}/s/abc`)).not.toHaveProperty("link");
  });
});

describe("rate limits and kinds", () => {
  it("gives a rate limit its own code and a step that says wait, not ask an admin", async () => {
    const words = "You are sending messages too fast. Try again in a few minutes.";
    const { mcp, calls } = await overHttp(() => Response.json({ error: { code: "TOO_MANY_REQUESTS", message: words } }, { status: 429 }));
    const result = await mcp.callTool({ name: "agentx_tell_session_agent", arguments: { session_id: SES, text: "Go on" } });
    expect(isError(result)).toBe(true);
    expect(text(result)).toContain("RATE_LIMITED");
    expect(text(result)).toContain(words.replace(/\.$/, ""));
    expect(text(result)).not.toMatch(/admin/i);
    expect(calls).toHaveLength(1);
  });

  it("cleans the kind of a session, a tile and a message", async () => {
    const bad = "task\u001b[2J";
    const mcp = await connect({
      getSession: vi.fn(async () => sessionView({ kind: bad })),
      listSessions: vi.fn(async () => listOf([{ ...tileOf(SES, "x"), kind: bad }])),
      commentOnSession: vi.fn(async () => ({ ...message("comment"), kind: bad }) as unknown as SessionMessageRead),
    });
    for (const call of [{ name: "agentx_get_session", arguments: { session_id: SES } }, { name: "agentx_list_sessions", arguments: {} }, { name: "agentx_comment_on_session", arguments: { session_id: SES, text: "hi" } }]) {
      const dump = JSON.stringify(structured(await mcp.callTool(call)));
      expect(dump, call.name).not.toContain("\\u001b");
      expect(dump, call.name).toContain("task");
    }
  });
});

describe("what the server wrote is made safe before it reaches the model", () => {
  const evil = `\u001b[2Jred\u202e\u200b agxr_${"b".repeat(43)}`;
  const dirty = (value: string) => ["\u001b", "agxr_"].some((bad) => value.includes(bad));

  it("cleans the title, step, owner and link of a session and the titles of a list", async () => {
    const mcp = await connect({
      getSession: vi.fn(async () => sessionView({ title: evil, step: evil, peek: evil, owner: { developerId: DEV, name: evil }, project: "payments" })),
      listSessions: vi.fn(async () => listOf([tileOf(SES, evil)])),
    });
    for (const call of [{ name: "agentx_get_session", arguments: { session_id: SES } }, { name: "agentx_list_sessions", arguments: {} }]) {
      const result = await mcp.callTool(call);
      expect(dirty(JSON.stringify(structured(result))), call.name).toBe(false);
      expect(dirty(text(result)), call.name).toBe(false);
    }
  });

  it("cleans the words of a refusal, and never lets an access token through", async () => {
    const { mcp } = await overHttp(() => Response.json({ error: { code: "SESSION_LEVEL_REQUIRED", message: `You need edit\u001b[2J tok agxr_${"c".repeat(43)}` } }, { status: 403 }));
    const result = await mcp.callTool({ name: "agentx_stop_session", arguments: { session_id: SES } });
    expect(isError(result)).toBe(true);
    expect(dirty(text(result))).toBe(false);
    expect(text(result)).not.toContain("tok agx");
  });

  it("marks a session's text as data, not instructions, in each tool's description", () => {
    for (const name of ["agentx_get_session", "agentx_list_sessions"]) {
      expect(DEVELOPER_TOOLS.find((tool) => tool.name === name)!.description, name).toMatch(/data|not instructions/i);
    }
  });
});
