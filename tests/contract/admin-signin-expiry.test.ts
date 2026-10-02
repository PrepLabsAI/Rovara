// Issue #218: an admin sign-in that expired (it lasts an hour and is never refreshed) says it
// expired and when, with the exact command, in the CLI and in the MCP tools; one about to expire
// says so in the admin tools' results and in agentx_whoami.
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
import { agentxMcpServer } from "../../packages/cli/src/mcp/serve.js";
import { saveDeveloperEnvironment, developerTokenKey } from "../../packages/cli/src/developer/config.js";
import { InMemoryTokenStore } from "../../packages/cli/src/token-store.js";
import { ADMIN_EXPIRY_WARNING_MS, adminSignInExpiredText, adminSignInExpiringText, localClockTime } from "../../packages/mcp/src/admin-expiry.js";
import { stagingSettings } from "../support/environment-fixtures.js";
import { toolError } from "../support/mcp-tool-error.js";

const URL_BASE = "https://abc123.execute-api.us-east-1.amazonaws.com";
const ISSUER = `${URL_BASE}/v1/auth`;
const ADMIN_TOKEN = "admin-access-token-planted-218";

describe("the admin sign-in's expiry, in words (#218)", () => {
  it("names a time today by its local hour and minute, and another day's with its date", () => {
    const now = new Date(2026, 9, 1, 13, 0, 0).getTime();
    expect(localClockTime(new Date(2026, 9, 1, 12, 31, 40).getTime(), now)).toBe("12:31");
    expect(localClockTime(new Date(2026, 8, 30, 9, 5).getTime(), now)).toBe("2026-09-30 09:05");
  });

  it("says it expired, when, and the exact command", () => {
    const now = new Date(2026, 9, 1, 13, 0).getTime();
    expect(adminSignInExpiredText("livefinal", new Date(2026, 9, 1, 12, 31).getTime(), now)).toBe("Your admin sign-in for livefinal expired at 12:31. Run agentx --env livefinal login --admin.");
    expect(adminSignInExpiringText("livefinal", new Date(2026, 9, 1, 13, 4).getTime(), now)).toBe("Your admin sign-in for livefinal expires at 13:04; run agentx --env livefinal login --admin to sign in again.");
  });
});

describe("agentx admin commands with an expired admin sign-in (#218)", () => {
  async function run(token: { expiresAt: number } | undefined) {
    const home = await mkdtemp(join(tmpdir(), "agentx-admin-expiry-"));
    const tokenStore = new InMemoryTokenStore();
    await writeEnvironmentCache(home, stagingSettings);
    if (token !== undefined) await tokenStore.set(tokenStoreKey(cacheFromSettings(stagingSettings).auth), { accessToken: ADMIN_TOKEN, expiresAt: token.expiresAt });
    const err: string[] = [];
    const code = await executeCli(["--env", "staging", "admin", "credential", "list"], {
      environments: { home }, tokenStore, stdout: { write: () => true }, stderr: { write: (text: string) => { err.push(text); return true; } },
      fetchImplementation: vi.fn(async () => { throw new Error("no request is expected"); }),
    });
    return { code, err: err.join("") };
  }

  it("says the sign-in expired, when, and the exact command, not to run agentx login", async () => {
    const expiresAt = Date.now() - 60_000;
    const { code, err } = await run({ expiresAt });
    expect(code).toBe(3);
    expect(err).toBe(`AgentX error [AUTH_REQUIRED]: Your admin sign-in for staging expired at ${localClockTime(expiresAt, Date.now())}. Run agentx --env staging login --admin.\n`);
    expect(err).not.toContain(ADMIN_TOKEN);
  });

  it("says this computer has no admin sign-in for the environment, with the admin command, when none was ever stored", async () => {
    const { code, err } = await run(undefined);
    expect(code).toBe(3);
    expect(err).toBe("AgentX error [AUTH_REQUIRED]: this computer holds no admin sign-in for staging; run agentx --env staging login --admin\n");
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

const controlPlane = () => vi.fn<typeof fetch>(async (input) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.pathname === "/v1/auth/.well-known/agentx-configuration") return Response.json({ env: "staging", apiVersion: "1.2", adminApiVersion: "1.0" });
  if (url.pathname === "/v1/admin/projects") return Response.json({ projects: [] });
  return Response.json({ developer: { id: "d".repeat(64), name: "Ada", provider: "slack" }, projects: [], notices: [] });
});

describe("agentx mcp with an expired admin sign-in (#218)", () => {
  async function cli(admin: { expiresAt: number }) {
    const home = await mkdtemp(join(tmpdir(), "agentx-admin-expiry-mcp-"));
    const tokenStore = new InMemoryTokenStore();
    await writeEnvironmentCache(home, stagingSettings);
    await saveDeveloperEnvironment(home, "staging", { url: URL_BASE, issuer: ISSUER, tokenEndpoint: `${ISSUER}/token`, revocationEndpoint: `${ISSUER}/revoke` });
    await tokenStore.set(developerTokenKey(ISSUER), { accessToken: "developer-token", refreshToken: `agxr_${"a".repeat(43)}`, expiresAt: Date.now() + 3_600_000 });
    await tokenStore.set(tokenStoreKey(cacheFromSettings(stagingSettings).auth), { accessToken: ADMIN_TOKEN, expiresAt: admin.expiresAt });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const running = executeCli(["mcp"], { environments: { home }, tokenStore, fetchImplementation: controlPlane(), stdin, stdout, stderr: { write: () => true } });
    const client = new Client({ name: "claude-code", version: "2.1.0" });
    await client.connect(streamTransport(stdin, stdout));
    return { client, stop: async () => { await client.close(); return running; } };
  }

  it("answers ADMIN_REQUIRED saying it expired and when, with the exact command, and whoami says the same", async () => {
    const expiresAt = Date.now() - 60_000;
    const { client, stop } = await cli({ expiresAt });
    // The format itself is checked above; this stays right across local midnight.
    const time = localClockTime(expiresAt, Date.now());
    const whoami = await client.callTool({ name: "agentx_whoami", arguments: {} });
    // A direct call to the hidden tool is answered with the offer's refusal, once its first check has answered.
    const refusal = async () => toolError((await client.callTool({ name: "agentx_admin_list_projects", arguments: {} })) as Parameters<typeof toolError>[0]);
    await expect.poll(refusal).toEqual({
      code: "ADMIN_REQUIRED", message: `Your admin sign-in for staging expired at ${time}`, next_step: "run agentx --env staging login --admin",
    });
    expect(whoami.structuredContent).toMatchObject({ admin: false });
    const text = JSON.stringify(whoami.content);
    expect(text).toContain(`Your admin sign-in for staging expired at ${time}. Run agentx --env staging login --admin.`);
    expect(text).not.toContain("holds no admin sign-in");
    expect(await stop()).toBe(0);
  });
});

describe("an admin sign-in about to expire (#218)", () => {
  async function server(expiresAt: number) {
    const home = await mkdtemp(join(tmpdir(), "agentx-admin-expiring-"));
    const tokenStore = new InMemoryTokenStore();
    await saveDeveloperEnvironment(home, "staging", { url: URL_BASE, issuer: ISSUER, tokenEndpoint: `${ISSUER}/token`, revocationEndpoint: `${ISSUER}/revoke` });
    await tokenStore.set(developerTokenKey(ISSUER), { accessToken: "developer-token", refreshToken: `agxr_${"a".repeat(43)}`, expiresAt: Date.now() + 3_600_000 });
    const mcp = agentxMcpServer({
      home, tokenStore, fetch: controlPlane(), stderr: { write: () => true },
      adminSignedIn: async () => expiresAt > Date.now(),
      adminSession: async () => (expiresAt > Date.now() ? { baseUrl: URL_BASE, accessToken: ADMIN_TOKEN } : undefined),
      adminSignInExpiry: async () => ({ env: "staging", expiresAt }),
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await mcp.connect(serverSide);
    const client = new Client({ name: "claude-code", version: "2.1.0" });
    await client.connect(clientSide);
    return client;
  }

  it("warns in an admin tool's result and in whoami, a few minutes before it expires", async () => {
    const expiresAt = Date.now() + 120_000;
    const client = await server(expiresAt);
    await expect.poll(async () => (await client.listTools()).tools.some((tool) => tool.name === "agentx_admin_list_projects")).toBe(true);
    const warning = `Your admin sign-in for staging expires at ${localClockTime(expiresAt, Date.now())}; run agentx --env staging login --admin to sign in again.`;
    const result = await client.callTool({ name: "agentx_admin_list_projects", arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ projects: [] });
    expect(JSON.stringify(result.content)).toContain(warning);
    expect(JSON.stringify((await client.callTool({ name: "agentx_whoami", arguments: {} })).content)).toContain(warning);
  });

  it("says nothing of the expiry while it is further off than the warning window", async () => {
    const client = await server(Date.now() + ADMIN_EXPIRY_WARNING_MS + 600_000);
    await expect.poll(async () => (await client.listTools()).tools.some((tool) => tool.name === "agentx_admin_list_projects")).toBe(true);
    expect(JSON.stringify((await client.callTool({ name: "agentx_admin_list_projects", arguments: {} })).content)).not.toContain("expires at");
    expect(JSON.stringify((await client.callTool({ name: "agentx_whoami", arguments: {} })).content)).not.toContain("expires at");
  });
});
