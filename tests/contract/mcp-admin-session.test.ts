// Spec 025 A14: agentx mcp offers the admin tools with this computer's unexpired admin sign-in, and
// hides them once it expires.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { agentxMcpServer } from "../../packages/cli/src/mcp/serve.js";
import { saveDeveloperEnvironment, developerTokenKey } from "../../packages/cli/src/developer/config.js";
import { InMemoryTokenStore } from "../../packages/cli/src/token-store.js";
import { toolError } from "../support/mcp-tool-error.js";

const URL_BASE = "https://abc123.execute-api.us-east-1.amazonaws.com";
const ISSUER = `${URL_BASE}/v1/auth`;
const ADMIN_TOKEN = "admin-access-token-planted-4f2a";

async function server(options: { admin?: { expiresAt: number }; adminApiVersion?: string }) {
  const home = await mkdtemp(join(tmpdir(), "agentx-admin-mcp-"));
  const tokenStore = new InMemoryTokenStore();
  await saveDeveloperEnvironment(home, "staging", { url: URL_BASE, issuer: ISSUER, tokenEndpoint: `${ISSUER}/token`, revocationEndpoint: `${ISSUER}/revoke` });
  await tokenStore.set(developerTokenKey(ISSUER), { accessToken: "developer-token", refreshToken: `agxr_${"a".repeat(43)}`, expiresAt: Date.now() + 3_600_000 });
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
    expect(toolError(await client.callTool({ name: "agentx_admin_list_projects", arguments: {} }))).toMatchObject({ code: "ADMIN_REQUIRED", next_step: "run npx @charterarc/agentx login --admin" });
  });

  it("offers no admin tool against a control plane without the admin API, and whoami says why", async () => {
    const { client } = await server({ admin: { expiresAt: Date.now() + 600_000 } });
    expect((await client.listTools()).tools).toHaveLength(11);
    const whoami = await client.callTool({ name: "agentx_whoami", arguments: {} });
    expect(JSON.stringify(whoami.content)).toContain("AgentX has no admin tools yet; ask your AgentX admin to upgrade AgentX");
    expect(toolError(await client.callTool({ name: "agentx_admin_health", arguments: {} }))).toMatchObject({ code: "UPGRADE_REQUIRED" });
  });
});
