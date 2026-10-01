// tests/contract/mcp-admin-offer.test.ts
// Spec 025 FR-028, A15: admin tools appear and disappear with the admin sign-in, with list_changed,
// and a direct call to a hidden one answers ADMIN_REQUIRED.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ToolListChangedNotificationSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DEVELOPER_TOOLS, FIRST_LIST_WAIT_MS, OFFER_READ_TIMEOUT_MS, ToolError, ToolOffer, createAgentXMcpServer, guardTransport, type AdminOffer, type ToolContext, type ToolDefinition } from "../../packages/mcp/src/index.js";
import { toolError } from "../support/mcp-tool-error.js";

const probe: ToolDefinition = {
  name: "agentx_admin_probe", title: "Probe", description: "A test admin tool.", inputSchema: {}, outputSchema: { ok: z.boolean() },
  handler: async () => ({ structured: { ok: true }, text: "ok" }),
};

async function connect(offer: { current: AdminOffer }) {
  const context = (): ToolContext => ({
    client: {} as never, clientName: "claude-code", serverVersion: "0.5.0", adminSignedIn: async () => offer.current.admin === undefined,
    compatibility: async () => ({ env: "staging", apiVersion: "1.2", adminApiVersion: "1.0" }), now: () => 0, sleep: async () => undefined, newRequestId: () => "33333333-3333-4333-8333-333333333333",
  });
  const server = createAgentXMcpServer({ version: "0.5.0", context, adminTools: [probe], adminOffer: async () => offer.current, recheckMs: 60_000 });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "claude-code", version: "1.0.0" });
  let changes = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => { changes += 1; });
  await client.connect(clientSide);
  const names = async () => (await client.listTools()).tools.map((tool) => tool.name);
  return { client, names, changes: () => changes, server };
}
const signedOut = { admin: new ToolError("ADMIN_REQUIRED", "this computer holds no unexpired admin sign-in for AgentX", "run npx @charterarc/agentx login --admin") };

describe("the admin tool offer (FR-028, A15)", () => {
  it("offers only the developer tools without an admin sign-in", async () => {
    const { names } = await connect({ current: signedOut });
    expect(await names()).toEqual(DEVELOPER_TOOLS.map((tool) => tool.name));
  });

  it("offers the admin tools once the admin signs in, and sends list_changed each way", async () => {
    const offer = { current: signedOut as AdminOffer };
    const { client, names, changes } = await connect(offer);
    offer.current = { admin: undefined };
    // A15: any tool call rechecks, so the change shows at once.
    await client.callTool({ name: "agentx_whoami", arguments: {} }).catch(() => undefined);
    await expect.poll(async () => (await names()).includes("agentx_admin_probe")).toBe(true);
    expect(changes()).toBeGreaterThanOrEqual(1);
    offer.current = signedOut;
    await client.callTool({ name: "agentx_admin_probe", arguments: {} });
    await expect.poll(async () => (await names()).includes("agentx_admin_probe")).toBe(false);
    expect(changes()).toBeGreaterThanOrEqual(2);
  });

  it("answers a direct call to a hidden admin tool with ADMIN_REQUIRED, not the SDK's own refusal", async () => {
    const { client } = await connect({ current: signedOut });
    const result = await client.callTool({ name: "agentx_admin_probe", arguments: {} });
    expect(result.isError).toBe(true);
    expect(toolError(result)).toEqual({ code: "ADMIN_REQUIRED", message: "this computer holds no unexpired admin sign-in for AgentX", next_step: "run npx @charterarc/agentx login --admin" });
  });

  it("says UPGRADE_REQUIRED when AgentX is too old for the admin tools", async () => {
    const tooOld = { admin: new ToolError("UPGRADE_REQUIRED", "AgentX at https://x has no admin API", "ask your AgentX admin to upgrade AgentX, or use an older CLI") };
    const { client, names } = await connect({ current: tooOld });
    expect(await names()).not.toContain("agentx_admin_probe");
    expect(toolError(await client.callTool({ name: "agentx_admin_probe", arguments: {} }))).toMatchObject({ code: "UPGRADE_REQUIRED" });
  });

  it("keeps offering what it last knew when the check itself fails", async () => {
    const offer = { current: { admin: undefined } as AdminOffer };
    const flaky = { get current(): AdminOffer { if (failing) throw new Error("keychain locked"); return offer.current; } };
    let failing = false;
    const { names, client } = await connect(flaky);
    await expect.poll(async () => (await names()).includes("agentx_admin_probe")).toBe(true);
    failing = true;
    await client.callTool({ name: "agentx_whoami", arguments: {} }).catch(() => undefined);
    expect(await names()).toContain("agentx_admin_probe");
  });
});

describe("the offer without an admin check, and its timer (A15)", () => {
  it("never offers the admin tools when the server has no adminOffer", async () => {
    const context = (): ToolContext => ({
      client: {} as never, clientName: "claude-code", serverVersion: "0.5.0", adminSignedIn: async () => true,
      compatibility: async () => ({ env: "staging", apiVersion: "1.2" }), now: () => 0, sleep: async () => undefined, newRequestId: () => "33333333-3333-4333-8333-333333333333",
    });
    const server = createAgentXMcpServer({ version: "0.5.0", context, adminTools: [probe] });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "claude-code", version: "1.0.0" });
    await client.connect(clientSide);
    await client.callTool({ name: "agentx_whoami", arguments: {} }).catch(() => undefined);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(DEVELOPER_TOOLS.map((tool) => tool.name));
    expect(toolError(await client.callTool({ name: "agentx_admin_probe", arguments: {} }))).toMatchObject({ code: "ADMIN_REQUIRED" });
    await server.close();
  });

  it("rechecks on its interval, logs a failed check by the error's name only, and stops", async () => {
    vi.useFakeTimers();
    try {
      const tool = { enabled: false, enable: vi.fn(() => { tool.enabled = true; }), disable: vi.fn(() => { tool.enabled = false; }) };
      const read = vi.fn(async (): Promise<AdminOffer> => { throw new Error("secret-words-planted-in-the-message"); });
      const log = vi.fn();
      const offer = new ToolOffer({ tools: new Map([["agentx_admin_probe", tool]]), read, log });
      offer.start(30_000);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(read).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith({ event: "offer.check_failed", error: "Error" });
      expect(JSON.stringify(log.mock.calls)).not.toContain("secret-words-planted");
      read.mockResolvedValue({ admin: undefined });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(tool.enabled).toBe(true);
      expect(tool.enable).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(tool.enable).toHaveBeenCalledTimes(1);
      offer.stop();
      await vi.advanceTimersByTimeAsync(90_000);
      expect(read).toHaveBeenCalledTimes(3);
      expect(offer.refusal("agentx_whoami")).toBeUndefined();
      expect(offer.refusal("agentx_admin_probe")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs one check at a time", async () => {
    let release: () => void = () => undefined;
    const read = vi.fn(() => new Promise<AdminOffer>((resolve) => { release = () => resolve({ admin: undefined }); }));
    const tool = { enabled: false, enable: () => { tool.enabled = true; }, disable: () => { tool.enabled = false; } };
    const offer = new ToolOffer({ tools: new Map([["t", tool]]), read });
    const first = offer.refresh();
    const second = offer.refresh();
    expect(read).toHaveBeenCalledTimes(1);
    release();
    // Review fix: the second refresh, asked for during the first read, is one more read after it.
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    release();
    await Promise.all([first, second]);
    expect(read).toHaveBeenCalledTimes(2);
    expect(tool.enabled).toBe(true);
  });
});

describe("the offer's queued recheck (A15, review fix)", () => {
  it("reads once more after the current read when a refresh is asked for during it, queueing at most one", async () => {
    const releases: Array<(offer: AdminOffer) => void> = [];
    const read = vi.fn(() => new Promise<AdminOffer>((resolve) => { releases.push(resolve); }));
    const tool = { enabled: false, enable: () => { tool.enabled = true; }, disable: () => { tool.enabled = false; } };
    const offer = new ToolOffer({ tools: new Map([["t", tool]]), read });
    const first = offer.refresh();
    const second = offer.refresh();
    const third = offer.refresh();
    expect(read).toHaveBeenCalledTimes(1);
    releases[0]!({ admin: undefined });
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(tool.enabled).toBe(true);
    // The queued read's answer is the one kept: the sign-in expired meanwhile.
    releases[1]!({ admin: new ToolError("ADMIN_REQUIRED", "expired") });
    await Promise.all([first, second, third]);
    expect(read).toHaveBeenCalledTimes(2);
    expect(tool.enabled).toBe(false);
  });
});

describe("the offer's last-moment refresh (A15, review fix 2)", () => {
  it("never loses a refresh that lands just as a read finishes: every refresh is followed by a read that starts after it", async () => {
    // A refresh asked for on each of many microtask ticks around the end of a read: whichever tick
    // falls between the loop's last check and the clearing of the running read, its read must run.
    for (let ticks = 0; ticks < 12; ticks += 1) {
      let asked = 0;
      let seen = -1;
      const read = vi.fn(async (): Promise<AdminOffer> => { seen = asked; return { admin: undefined }; });
      const tool = { enabled: false, enable: () => { tool.enabled = true; }, disable: () => { tool.enabled = false; } };
      const offer = new ToolOffer({ tools: new Map([["t", tool]]), read });
      const pending: Array<Promise<void>> = [offer.refresh()];
      for (let tick = 0; tick < ticks; tick += 1) await Promise.resolve();
      asked += 1;
      pending.push(offer.refresh());
      await Promise.all(pending);
      await vi.waitFor(() => expect(seen).toBe(asked));
    }
  });
});

/** An inner transport that records what is sent, and lets the test deliver messages. */
function fakeTransport() {
  const sent: JSONRPCMessage[] = [];
  const calls: string[] = [];
  const start = vi.fn(async () => { calls.push("start"); });
  const send = vi.fn(async (message: JSONRPCMessage) => { sent.push(message); });
  const close = vi.fn(async () => { calls.push("close"); inner.onclose?.(); });
  const setProtocolVersion = vi.fn();
  const inner: Transport = { start, send, close, setProtocolVersion, sessionId: "session-1" };
  return { inner, sent, calls, spies: { start, send, close, setProtocolVersion } };
}
const answer = (error: ToolError) => ({ isError: true, content: [{ type: "text", text: `${error.code}: ${error.message}` }] });

describe("the hidden-tool guard (A15)", () => {
  it("answers a call to a refused tool itself, and passes every other message through unchanged and in order", async () => {
    const { inner, sent, spies } = fakeTransport();
    const refused = new ToolError("ADMIN_REQUIRED", "no admin sign-in", "run npx @charterarc/agentx login --admin");
    const guarded = guardTransport(inner, (name) => (name === "agentx_admin_probe" ? refused : undefined), answer);
    const seen: JSONRPCMessage[] = [];
    guarded.onmessage = (message) => { seen.push(message); };
    const messages: JSONRPCMessage[] = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "c", version: "1" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "agentx_whoami", arguments: {} } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "agentx_admin_probe", arguments: {} } },
      { jsonrpc: "2.0", id: 4, method: "tools/list" },
      { jsonrpc: "2.0", id: 9, result: {} },
    ];
    for (const message of messages) inner.onmessage?.(message);
    expect(seen).toEqual([messages[0], messages[1], messages[2], messages[4], messages[5]]);
    await vi.waitFor(() => expect(sent).toEqual([{ jsonrpc: "2.0", id: 3, result: answer(refused) }]));
    const outgoing: JSONRPCMessage = { jsonrpc: "2.0", id: 1, result: { ok: true } };
    await guarded.send(outgoing, { relatedRequestId: 1 });
    expect(spies.send).toHaveBeenLastCalledWith(outgoing, { relatedRequestId: 1 });
    guarded.setProtocolVersion?.("2025-06-18");
    expect(spies.setProtocolVersion).toHaveBeenCalledWith("2025-06-18");
    expect(guarded.sessionId).toBe("session-1");
    await guarded.start();
    expect(spies.start).toHaveBeenCalledTimes(1);
  });

  it("keeps the callbacks set on the inner transport before, and still calls them", async () => {
    const { inner, spies } = fakeTransport();
    const order: string[] = [];
    const earlierMessages: JSONRPCMessage[] = [];
    inner.onclose = () => order.push("earlier close");
    inner.onerror = (error) => order.push(`earlier error ${error.message}`);
    inner.onmessage = (message) => { earlierMessages.push(message); };
    const guarded = guardTransport(inner, () => undefined, answer);
    guarded.onclose = () => order.push("guarded close");
    guarded.onerror = (error) => order.push(`guarded error ${error.message}`);
    inner.onerror?.(new Error("boom"));
    const message: JSONRPCMessage = { jsonrpc: "2.0", method: "notifications/initialized" };
    inner.onmessage?.(message);
    await guarded.close();
    expect(order).toEqual(["earlier error boom", "guarded error boom", "earlier close", "guarded close"]);
    expect(earlierMessages).toEqual([message]);
    // The earlier onmessage observes every inbound message, a refused tools/call too.
    const refusing = fakeTransport();
    const seenBefore: JSONRPCMessage[] = [];
    const passedOn: JSONRPCMessage[] = [];
    refusing.inner.onmessage = (inbound) => { seenBefore.push(inbound); };
    const guardedRefusing = guardTransport(refusing.inner, () => new ToolError("ADMIN_REQUIRED", "no"), answer);
    guardedRefusing.onmessage = (inbound) => { passedOn.push(inbound); };
    const refusedCall: JSONRPCMessage = { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "agentx_admin_probe" } };
    refusing.inner.onmessage?.(refusedCall);
    expect(seenBefore).toEqual([refusedCall]);
    expect(passedOn).toEqual([]);
    expect(spies.close).toHaveBeenCalledTimes(1);
  });

  it("keeps runMcpServer's onclose through a real server connect and close", async () => {
    const context = (): ToolContext => ({
      client: {} as never, clientName: "claude-code", serverVersion: "0.5.0", adminSignedIn: async () => false,
      compatibility: async () => ({ env: "staging", apiVersion: "1.2" }), now: () => 0, sleep: async () => undefined, newRequestId: () => "33333333-3333-4333-8333-333333333333",
    });
    const server = createAgentXMcpServer({ version: "0.5.0", context, adminTools: [probe], adminOffer: async () => ({ admin: undefined }) });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const closed = vi.fn();
    serverSide.onclose = closed;
    await server.connect(serverSide);
    const client = new Client({ name: "claude-code", version: "1.0.0" });
    await client.connect(clientSide);
    await server.close();
    // InMemoryTransport closes its pair from both ends, so the SDK itself calls it more than once.
    expect(closed).toHaveBeenCalled();
  });

  it("reports a failed refusal answer through onerror", async () => {
    const { inner } = fakeTransport();
    inner.send = vi.fn(async () => { throw new Error("pipe broken"); });
    const guarded = guardTransport(inner, () => new ToolError("ADMIN_REQUIRED", "no"), answer);
    const errors: string[] = [];
    guarded.onerror = (error) => errors.push(error.message);
    inner.onmessage?.({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "agentx_admin_probe" } });
    await vi.waitFor(() => expect(errors).toEqual(["pipe broken"]));
  });
});

/** A test tool with the given name, in any group. */
const testTool = (name: string): ToolDefinition => ({ ...probe, name });
const ADMIN_GROUP = ["agentx_admin_probe", "agentx_admin_probe_2", "agentx_admin_probe_3"].map(testTool);
const AUDIT_GROUP = [testTool("agentx_admin_audit_probe")];
const CHANGE_GROUP = ["agentx_admin_change_probe", "agentx_admin_change_probe_2"].map(testTool);
const ALL_ADMIN = [...ADMIN_GROUP, ...AUDIT_GROUP, ...CHANGE_GROUP].map((tool) => tool.name);
const allOffered: AdminOffer = { admin: undefined, audit: undefined, changes: undefined };

/**
 * Issue 203: a client spoken to with raw JSON-RPC, the way Codex speaks: initialize with no
 * capabilities, notifications/initialized, then tools/list at once. Every message the server sends
 * is kept, so the test can count list_changed exactly.
 */
async function rawClient(options: { adminOffer: (client: { elicitation: boolean }) => Promise<AdminOffer>; recheckMs?: number; firstListWaitMs?: number; capabilities?: Record<string, unknown>; log?: (entry: Record<string, unknown>) => void }) {
  const context = (): ToolContext => ({
    client: {} as never, clientName: "codex", serverVersion: "0.5.0", adminSignedIn: async () => true,
    compatibility: async () => ({ env: "staging", apiVersion: "1.2", adminApiVersion: "1.1" }), now: () => 0, sleep: async () => undefined, newRequestId: () => "33333333-3333-4333-8333-333333333333",
  });
  const server = createAgentXMcpServer({
    version: "0.5.0", context, adminTools: ADMIN_GROUP, auditTools: AUDIT_GROUP, changeTools: CHANGE_GROUP, adminOffer: options.adminOffer, recheckMs: options.recheckMs ?? 60_000,
    ...(options.firstListWaitMs === undefined ? {} : { firstListWaitMs: options.firstListWaitMs }),
    ...(options.log === undefined ? {} : { log: options.log }),
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const received: JSONRPCMessage[] = [];
  const waiting = new Map<number, (message: JSONRPCMessage) => void>();
  clientSide.onmessage = (message) => {
    received.push(message);
    if ("id" in message && typeof message.id === "number" && ("result" in message || "error" in message)) waiting.get(message.id)?.(message);
  };
  await server.connect(serverSide);
  await clientSide.start();
  let nextId = 1;
  const request = (method: string, params?: Record<string, unknown>): Promise<JSONRPCMessage> => {
    const id = nextId;
    nextId += 1;
    const answered = new Promise<JSONRPCMessage>((resolve) => { waiting.set(id, resolve); });
    void clientSide.send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    return answered;
  };
  const listNames = async (): Promise<string[]> => {
    const answer = await request("tools/list");
    return ((answer as unknown as { result: { tools: Array<{ name: string }> } }).result.tools).map((tool) => tool.name);
  };
  const listChanged = () => received.filter((message) => "method" in message && message.method === "notifications/tools/list_changed").length;
  await request("initialize", { protocolVersion: "2025-06-18", capabilities: options.capabilities ?? {}, clientInfo: { name: "codex", version: "0.1.0" } });
  await clientSide.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  return { server, request, listNames, listChanged };
}
const settle = () => new Promise<void>((resolve) => { setTimeout(resolve, 50); });

describe("the first tools/list and list_changed (issue 203)", () => {
  it("answers a client that lists once, right after initialize, with the admin tools the sign-in allows", async () => {
    const { server, listNames } = await rawClient({ adminOffer: async () => { await new Promise((resolve) => { setTimeout(resolve, 100); }); return allOffered; } });
    expect(await listNames()).toEqual([...DEVELOPER_TOOLS.map((tool) => tool.name), ...ALL_ADMIN]);
    await server.close();
  });

  it("sends exactly one list_changed when one refresh adds many tools", async () => {
    const offer = { current: signedOut as AdminOffer };
    const { server, request, listNames, listChanged } = await rawClient({ adminOffer: async () => offer.current });
    expect(await listNames()).toEqual(DEVELOPER_TOOLS.map((tool) => tool.name));
    await settle();
    expect(listChanged()).toBe(0);
    offer.current = allOffered;
    // A15: any tool call rechecks.
    await request("tools/call", { name: "agentx_whoami", arguments: {} });
    await vi.waitFor(async () => expect(await listNames()).toEqual([...DEVELOPER_TOOLS.map((tool) => tool.name), ...ALL_ADMIN]));
    await settle();
    expect(listChanged()).toBe(1);
    await server.close();
  });

  it("sends exactly one list_changed when the sign-in expires and the timer removes every admin tool", async () => {
    const offer = { current: allOffered };
    const { server, listNames, listChanged } = await rawClient({ adminOffer: async () => offer.current, recheckMs: 25 });
    expect(await listNames()).toEqual([...DEVELOPER_TOOLS.map((tool) => tool.name), ...ALL_ADMIN]);
    await settle();
    const before = listChanged();
    offer.current = signedOut;
    await vi.waitFor(async () => expect(await listNames()).toEqual(DEVELOPER_TOOLS.map((tool) => tool.name)));
    // Several more timer rechecks, none of which changes anything.
    await new Promise((resolve) => { setTimeout(resolve, 150); });
    expect(listChanged() - before).toBe(1);
    await server.close();
  });

  it("answers the first tools/list with the developer tools within the bound when the check hangs, then announces the admin tools once", async () => {
    let release: (offer: AdminOffer) => void = () => undefined;
    const { server, listNames, listChanged } = await rawClient({ adminOffer: () => new Promise<AdminOffer>((resolve) => { release = resolve; }), firstListWaitMs: 200 });
    const started = Date.now();
    expect(await listNames()).toEqual(DEVELOPER_TOOLS.map((tool) => tool.name));
    expect(Date.now() - started).toBeLessThan(2_000);
    release(allOffered);
    await vi.waitFor(() => expect(listChanged()).toBe(1));
    expect(await listNames()).toEqual([...DEVELOPER_TOOLS.map((tool) => tool.name), ...ALL_ADMIN]);
    await server.close();
  });

  it("answers the first tools/list with the developer tools at once when the check fails", async () => {
    const { server, listNames } = await rawClient({ adminOffer: async () => { throw new Error("keychain locked"); }, firstListWaitMs: 10_000 });
    const started = Date.now();
    expect(await listNames()).toEqual(DEVELOPER_TOOLS.map((tool) => tool.name));
    expect(Date.now() - started).toBeLessThan(2_000);
    await server.close();
  });

  it("lists the change tools first time for a client that declared form elicitation, and reads the offer once at start", async () => {
    const reads: Array<{ elicitation: boolean }> = [];
    const adminOffer = async (client: { elicitation: boolean }): Promise<AdminOffer> => {
      reads.push(client);
      return { admin: undefined, audit: undefined, changes: client.elicitation ? undefined : new ToolError("CONFIRMATION_UNAVAILABLE", "no confirmation method is available in this session") };
    };
    const { server, listNames } = await rawClient({ adminOffer, capabilities: { elicitation: { form: {} } } });
    expect(await listNames()).toEqual([...DEVELOPER_TOOLS.map((tool) => tool.name), ...ALL_ADMIN]);
    await settle();
    // Review fix: the first tools/list and notifications/initialized share one read.
    expect(reads).toEqual([{ elicitation: true }]);
    await server.close();
  });

  it("hides the change tools in the first list for a client without elicitation when Slack is not available (CONFIRMATION_UNAVAILABLE)", async () => {
    const adminOffer = async (client: { elicitation: boolean }): Promise<AdminOffer> => ({ admin: undefined, audit: undefined, changes: client.elicitation ? undefined : new ToolError("CONFIRMATION_UNAVAILABLE", "no confirmation method is available in this session") });
    const { server, listNames, request } = await rawClient({ adminOffer });
    expect(await listNames()).toEqual([...DEVELOPER_TOOLS, ...ADMIN_GROUP, ...AUDIT_GROUP].map((tool) => tool.name));
    const refused = await request("tools/call", { name: "agentx_admin_change_probe", arguments: {} });
    expect(toolError((refused as unknown as { result: Parameters<typeof toolError>[0] }).result)).toMatchObject({ code: "CONFIRMATION_UNAVAILABLE" });
    await server.close();
  });

  it("logs when the first tools/list is answered before the check, by event and wait only", async () => {
    const log = vi.fn();
    const { server, listNames } = await rawClient({ adminOffer: () => new Promise<AdminOffer>(() => undefined), firstListWaitMs: 50, log });
    expect(await listNames()).toEqual(DEVELOPER_TOOLS.map((tool) => tool.name));
    expect(log).toHaveBeenCalledWith({ event: "offer.first_list_timeout", waitMs: 50 });
    await server.close();
  });

  it("waits a few seconds by default for the first check, never longer", () => {
    expect(FIRST_LIST_WAIT_MS).toBe(5_000);
  });
});

describe("the guard's hold on the first tools/list (issue 203)", () => {
  it("holds the first tools/list and everything after it until the check settles, then delivers them in order; later lists pass at once", async () => {
    const { inner } = fakeTransport();
    let release: () => void = () => undefined;
    const ready = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const guarded = guardTransport(inner, () => undefined, answer, ready);
    const seen: JSONRPCMessage[] = [];
    guarded.onmessage = (message) => { seen.push(message); };
    const before: JSONRPCMessage = { jsonrpc: "2.0", method: "notifications/initialized" };
    const list: JSONRPCMessage = { jsonrpc: "2.0", id: 2, method: "tools/list" };
    const after: JSONRPCMessage = { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "agentx_whoami", arguments: {} } };
    inner.onmessage?.(before);
    inner.onmessage?.(list);
    inner.onmessage?.(after);
    expect(seen).toEqual([before]);
    release();
    await vi.waitFor(() => expect(seen).toEqual([before, list, after]));
    const again: JSONRPCMessage = { jsonrpc: "2.0", id: 4, method: "tools/list" };
    inner.onmessage?.(again);
    expect(seen).toEqual([before, list, after, again]);
    expect(ready).toHaveBeenCalledTimes(1);
  });

  it("still delivers what it held when the check's promise rejects", async () => {
    const { inner } = fakeTransport();
    const guarded = guardTransport(inner, () => undefined, answer, () => Promise.reject(new Error("no")));
    const seen: JSONRPCMessage[] = [];
    guarded.onmessage = (message) => { seen.push(message); };
    const list: JSONRPCMessage = { jsonrpc: "2.0", id: 2, method: "tools/list" };
    inner.onmessage?.(list);
    await vi.waitFor(() => expect(seen).toEqual([list]));
  });

  it("reports a throw while delivering held messages through onerror, and still delivers the rest", async () => {
    const { inner } = fakeTransport();
    const guarded = guardTransport(inner, () => undefined, answer, async () => undefined);
    const seen: JSONRPCMessage[] = [];
    const errors: string[] = [];
    guarded.onerror = (error) => errors.push(error.message);
    guarded.onmessage = (message) => {
      if ("id" in message && message.id === 2) throw new Error("handler broke");
      seen.push(message);
    };
    const after: JSONRPCMessage = { jsonrpc: "2.0", id: 3, method: "tools/list" };
    inner.onmessage?.({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    inner.onmessage?.(after);
    await vi.waitFor(() => expect(seen).toEqual([after]));
    expect(errors).toEqual(["handler broke"]);
  });

  it("delivers nothing held once the connection closes", async () => {
    const { inner } = fakeTransport();
    let release: () => void = () => undefined;
    const guarded = guardTransport(inner, () => undefined, answer, () => new Promise<void>((resolve) => { release = resolve; }));
    const seen: JSONRPCMessage[] = [];
    guarded.onmessage = (message) => { seen.push(message); };
    inner.onmessage?.({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    await guarded.close();
    release();
    await new Promise((resolve) => { setTimeout(resolve, 10); });
    expect(seen).toEqual([]);
  });
});

describe("an offer read that never answers (issue 203 review)", () => {
  it("counts as a failed check after the read timeout, so later rechecks still run", async () => {
    vi.useFakeTimers();
    try {
      expect(OFFER_READ_TIMEOUT_MS).toBe(15_000);
      const tool = { enabled: false, enable: () => { tool.enabled = true; }, disable: () => { tool.enabled = false; } };
      const read = vi.fn((): Promise<AdminOffer> => new Promise<AdminOffer>(() => undefined));
      const log = vi.fn();
      const offer = new ToolOffer({ tools: new Map([["t", tool]]), read, log });
      const first = offer.refresh();
      await vi.advanceTimersByTimeAsync(OFFER_READ_TIMEOUT_MS);
      await first;
      expect(log).toHaveBeenCalledWith({ event: "offer.check_failed", error: "TimeoutError" });
      read.mockResolvedValue({ admin: undefined });
      await offer.refresh();
      expect(read).toHaveBeenCalledTimes(2);
      expect(tool.enabled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
