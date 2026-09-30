// tests/contract/mcp-admin-offer.test.ts
// Spec 025 FR-028, A15: admin tools appear and disappear with the admin sign-in, with list_changed,
// and a direct call to a hidden one answers ADMIN_REQUIRED.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ToolListChangedNotificationSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DEVELOPER_TOOLS, ToolError, ToolOffer, createAgentXMcpServer, guardTransport, type AdminOffer, type ToolContext, type ToolDefinition } from "../../packages/mcp/src/index.js";
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
    await Promise.all([first, second]);
    expect(tool.enabled).toBe(true);
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
