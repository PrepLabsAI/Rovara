// Spec 025 A14: agentx mcp offers the admin tools with this computer's unexpired admin sign-in, and
// hides them once it expires.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { executeCli } from "../../packages/cli/src/main.js";
import { tokenStoreKey } from "../../packages/cli/src/auth.js";
import { cacheFromSettings, writeEnvironmentCache } from "../../packages/cli/src/environments/cache.js";
import { stagingSettings } from "../support/environment-fixtures.js";
import { agentxMcpServer } from "../../packages/cli/src/mcp/serve.js";
import { saveDeveloperEnvironment, developerTokenKey } from "../../packages/cli/src/developer/config.js";
import { InMemoryTokenStore } from "../../packages/cli/src/token-store.js";
import { toolError } from "../support/mcp-tool-error.js";
import { NEXT_STEPS, UPGRADE_AGENTX_STEP } from "../../packages/mcp/src/errors.js";

const URL_BASE = "https://abc123.execute-api.us-east-1.amazonaws.com";
const ISSUER = `${URL_BASE}/v1/auth`;
const ADMIN_TOKEN = "admin-access-token-planted-4f2a";

async function server(options: { admin?: { expiresAt: number }; adminApiVersion?: string; developerSignIn?: false }) {
  const home = await mkdtemp(join(tmpdir(), "agentx-admin-mcp-"));
  const tokenStore = new InMemoryTokenStore();
  if (options.developerSignIn !== false) {
    await saveDeveloperEnvironment(home, "staging", { url: URL_BASE, issuer: ISSUER, tokenEndpoint: `${ISSUER}/token`, revocationEndpoint: `${ISSUER}/revoke` });
    await tokenStore.set(developerTokenKey(ISSUER), { accessToken: "developer-token", refreshToken: `agxr_${"a".repeat(43)}`, expiresAt: Date.now() + 3_600_000 });
  }
  const fetch = vi.fn(async (input: string | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/auth/.well-known/agentx-configuration") return Response.json({ env: "staging", apiVersion: "1.2", ...(options.adminApiVersion === undefined ? {} : { adminApiVersion: options.adminApiVersion }) });
    if (url.pathname === "/v1/admin/projects") return Response.json({ projects: [] });
    return Response.json({ developer: { id: "d".repeat(64), name: "Ada", provider: "slack" }, projects: [], notices: [] });
  });
  const stderr: string[] = [];
  const mcp = agentxMcpServer({
    home, tokenStore, fetch, stderr: { write: (text: string) => stderr.push(text) },
    adminSignedIn: async () => options.admin !== undefined && options.admin.expiresAt > Date.now(),
    adminSession: async () => (options.admin !== undefined && options.admin.expiresAt > Date.now() ? { baseUrl: URL_BASE, accessToken: ADMIN_TOKEN } : undefined),
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverSide);
  const client = new Client({ name: "claude-code", version: "2.1.0" });
  await client.connect(clientSide);
  return { client, fetch, stderr };
}

describe("agentx mcp and the admin sign-in (A14)", () => {
  it("offers the admin tools with an unexpired admin sign-in, and calls /v1/admin/* with it", async () => {
    const admin = { expiresAt: Date.now() + 600_000 };
    const { client, fetch, stderr } = await server({ admin, adminApiVersion: "1.0" });
    await expect.poll(async () => (await client.listTools()).tools.some((tool) => tool.name === "agentx_admin_list_projects")).toBe(true);
    const result = await client.callTool({ name: "agentx_admin_list_projects", arguments: {} });
    expect(result.structuredContent).toEqual({ projects: [] });
    const call = fetch.mock.calls.find((entry) => String(entry[0]).endsWith("/v1/admin/projects")) as unknown as [string, RequestInit];
    expect(new Headers(call[1].headers).get("authorization")).toBe(`Bearer ${ADMIN_TOKEN}`);
    expect(stderr.join("")).not.toContain(ADMIN_TOKEN);
  });

  it("hides them, and answers ADMIN_REQUIRED, once the admin sign-in has expired", async () => {
    const admin = { expiresAt: Date.now() + 600_000 };
    const { client } = await server({ admin, adminApiVersion: "1.0" });
    await expect.poll(async () => (await client.listTools()).tools.length).toBe(19);
    admin.expiresAt = Date.now() - 1;
    await client.callTool({ name: "agentx_whoami", arguments: {} });
    await expect.poll(async () => (await client.listTools()).tools.length).toBe(11);
    expect(toolError(await client.callTool({ name: "agentx_admin_list_projects", arguments: {} }))).toMatchObject({ code: "ADMIN_REQUIRED", next_step: "run npx @preplabsai/rovara-code login --admin" });
  });

  it("offers no admin tool against a control plane without the admin API, and whoami says why", async () => {
    const { client } = await server({ admin: { expiresAt: Date.now() + 600_000 } });
    expect((await client.listTools()).tools).toHaveLength(11);
    const whoami = await client.callTool({ name: "agentx_whoami", arguments: {} });
    expect(JSON.stringify(whoami.content)).toContain("AgentX has no admin tools yet; ask your AgentX admin to upgrade AgentX");
    expect(toolError(await client.callTool({ name: "agentx_admin_health", arguments: {} }))).toMatchObject({ code: "UPGRADE_REQUIRED", next_step: UPGRADE_AGENTX_STEP });
  });

  it("offers no admin tool against a control plane whose admin API major differs, and a direct call says to upgrade the CLI", async () => {
    const { client } = await server({ admin: { expiresAt: Date.now() + 600_000 }, adminApiVersion: "2.0" });
    await client.callTool({ name: "agentx_whoami", arguments: {} });
    expect((await client.listTools()).tools).toHaveLength(11);
    expect(toolError(await client.callTool({ name: "agentx_admin_health", arguments: {} }))).toMatchObject({ code: "UPGRADE_REQUIRED", next_step: NEXT_STEPS.UPGRADE_REQUIRED });
  });

  // Final review, item 5: the offer's compatibility check needs the developer sign-in; without it
  // the admin is told to sign in as a developer, not to run login --admin again.
  it("answers the compatibility check's SIGN_IN_REQUIRED for an admin with no developer sign-in", async () => {
    const { client } = await server({ admin: { expiresAt: Date.now() + 600_000 }, adminApiVersion: "1.0", developerSignIn: false });
    await client.callTool({ name: "agentx_whoami", arguments: {} });
    expect((await client.listTools()).tools).toHaveLength(11);
    const refused = toolError(await client.callTool({ name: "agentx_admin_health", arguments: {} }));
    expect(refused).toMatchObject({ code: "SIGN_IN_REQUIRED" });
    expect(JSON.stringify(refused)).not.toContain("login --admin");
  });
});

/** A client transport over the in-process `agentx mcp` command's stdin and stdout. */
function streamTransport(toServer: PassThrough, fromServer: PassThrough): Transport {
  const buffer = new ReadBuffer();
  const transport: Transport = {
    start: async () => {
      fromServer.on("data", (chunk: Buffer) => {
        buffer.append(chunk);
        for (let message = buffer.readMessage(); message !== null; message = buffer.readMessage()) transport.onmessage?.(message);
      });
    },
    send: async (message: JSONRPCMessage) => { toServer.write(serializeMessage(message)); },
    close: async () => { toServer.end(); transport.onclose?.(); },
  };
  return transport;
}

describe("agentx mcp's own admin sign-in (main.ts, A14)", () => {
  async function cli(admin: { expiresAt: number }) {
    const home = await mkdtemp(join(tmpdir(), "agentx-admin-mcp-cli-"));
    const tokenStore = new InMemoryTokenStore();
    // The recorded environment's cache, with a trailing slash on the control plane's URL.
    const settings = { ...stagingSettings, controlPlaneUrl: `${URL_BASE}/` };
    await writeEnvironmentCache(home, settings);
    await saveDeveloperEnvironment(home, "staging", { url: URL_BASE, issuer: ISSUER, tokenEndpoint: `${ISSUER}/token`, revocationEndpoint: `${ISSUER}/revoke` });
    await tokenStore.set(developerTokenKey(ISSUER), { accessToken: "developer-token", refreshToken: `agxr_${"a".repeat(43)}`, expiresAt: Date.now() + 3_600_000 });
    await tokenStore.set(tokenStoreKey(cacheFromSettings(settings).auth), { accessToken: ADMIN_TOKEN, expiresAt: admin.expiresAt });
    const fetch = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/auth/.well-known/agentx-configuration") return Response.json({ env: "staging", apiVersion: "1.2", adminApiVersion: "1.0" });
      if (url.pathname === "/v1/admin/projects") return Response.json({ projects: [] });
      return Response.json({ developer: { id: "d".repeat(64), name: "Ada", provider: "slack" }, projects: [], notices: [] });
    });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr: string[] = [];
    // Issue #218 follow-up (owner decision 2026-10-02): an expired sign-in's command is shown bare,
    // as if this computer ran the published package's installed command, not through npx.
    const running = executeCli(["mcp"], {
      environments: { home }, tokenStore, fetchImplementation: fetch, stdin, stdout, stderr: { write: (text: string) => stderr.push(text) },
      cliInvocation: { published: true, version: "1.4.0", cliPath: "/opt/node_modules/@charterarc/agentx/dist/main.js", invokedViaNpx: false },
    });
    const client = new Client({ name: "claude-code", version: "2.1.0" });
    await client.connect(streamTransport(stdin, stdout));
    return { client, fetch, stderr, stop: async () => { await client.close(); return running; } };
  }

  it("reads the recorded environment's admin token, and calls the control plane's URL without its trailing slash", async () => {
    const { client, fetch, stderr, stop } = await cli({ expiresAt: Date.now() + 600_000 });
    await expect.poll(async () => (await client.listTools()).tools.length).toBe(19);
    const result = await client.callTool({ name: "agentx_admin_list_projects", arguments: {} });
    expect(result.structuredContent).toEqual({ projects: [] });
    const call = fetch.mock.calls.find((entry) => new URL(String(entry[0])).pathname.endsWith("/admin/projects")) as unknown as [string, RequestInit];
    expect(String(call[0])).toBe(`${URL_BASE}/v1/admin/projects`);
    expect(new Headers(call[1].headers).get("authorization")).toBe(`Bearer ${ADMIN_TOKEN}`);
    expect(await stop()).toBe(0);
    expect(stderr.join("")).not.toContain(ADMIN_TOKEN);
  });

  it("answers no admin sign-in for an expired admin token, and never refreshes it", async () => {
    const { client, fetch, stderr, stop } = await cli({ expiresAt: Date.now() - 1 });
    const whoami = await client.callTool({ name: "agentx_whoami", arguments: {} });
    expect(whoami.structuredContent).toMatchObject({ admin: false });
    expect((await client.listTools()).tools).toHaveLength(11);
    // Issue #218: an expired sign-in names its environment and the exact command.
    expect(toolError(await client.callTool({ name: "agentx_admin_list_projects", arguments: {} }))).toMatchObject({ code: "ADMIN_REQUIRED", next_step: "run agentx --env staging login --admin" });
    expect(fetch.mock.calls.some((entry) => new URL(String(entry[0])).pathname.includes("/token") || new URL(String(entry[0])).pathname.startsWith("/v1/admin/"))).toBe(false);
    expect(await stop()).toBe(0);
    expect(stderr.join("")).not.toContain(ADMIN_TOKEN);
  });
});
