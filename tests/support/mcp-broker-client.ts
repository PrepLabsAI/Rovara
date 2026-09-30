// The MCP SDK's client driving `agentx mcp`'s server against the developer task broker in process
// (spec 025 Testing section). Moved from mcp-developer-flow.test.ts for Task 16's shared-task flow.
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect } from "vitest";
import { agentxMcpServer } from "../../packages/cli/src/mcp/serve.js";
import { developerTokenKey, saveDeveloperEnvironment } from "../../packages/cli/src/developer/config.js";
import { InMemoryTokenStore } from "../../packages/cli/src/token-store.js";
import { DEV_ISSUER, bearerFor, type createDeveloperTaskBroker, type Developer } from "./developer-task-broker.js";
import { toolError, type ParsedToolError } from "./mcp-tool-error.js";

type Harness = Awaited<ReturnType<typeof createDeveloperTaskBroker>>;

export const URL_BASE = "https://abc123.execute-api.us-east-1.amazonaws.com";
export const REFRESH_TOKEN = `agxr_${"a".repeat(43)}`;

/** The control plane as the MCP server sees it: agentx-configuration, and /v1/dev/* on the broker. */
export function mcpBrokerFetch(harness: Harness): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === "/v1/auth/.well-known/agentx-configuration") return Response.json({ env: "staging", apiVersion: "1.2", issuer: DEV_ISSUER });
    const response = await harness.handler({
      version: "2.0", rawPath: url.pathname, rawQueryString: url.search.slice(1),
      headers: { authorization: new Headers(init?.headers).get("authorization") ?? "" },
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
      requestContext: { requestId: randomUUID(), http: { method: init?.method ?? "GET" } },
    });
    return new Response(response.body, { status: response.statusCode, headers: { "content-type": "application/json" } });
  };
}

export interface ToolAnswer { isError: boolean; value: Record<string, unknown>; error?: ParsedToolError }

export async function signedInClient(harness: Harness, who: Developer | undefined, onSleep: () => Promise<void> = async () => undefined) {
  const home = await mkdtemp(join(tmpdir(), "agentx-mcp-"));
  const tokenStore = new InMemoryTokenStore();
  await saveDeveloperEnvironment(home, "staging", { url: URL_BASE, issuer: DEV_ISSUER, tokenEndpoint: `${DEV_ISSUER}/token`, revocationEndpoint: `${DEV_ISSUER}/revoke` });
  const accessToken = who === undefined ? undefined : (await bearerFor(who)).slice("Bearer ".length);
  if (accessToken !== undefined) await tokenStore.set(developerTokenKey(DEV_ISSUER), { accessToken, refreshToken: REFRESH_TOKEN, expiresAt: Date.now() + 3_600_000 });
  const stderr: string[] = [];
  let now = 0;
  const server = agentxMcpServer({
    home, tokenStore, fetch: mcpBrokerFetch(harness), adminSignedIn: async () => false, adminSession: async () => undefined, stderr: { write: (text: string) => stderr.push(text) },
    clock: { now: () => now, sleep: async (ms) => { now += ms; await onSleep(); } },
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "claude-code", version: "2.1.0" });
  await client.connect(clientSide);
  // Ruling F3: listing first makes the client validate every structuredContent it gets back.
  expect((await client.listTools()).tools).toHaveLength(11);
  const answers: string[] = [];
  const tool = async (name: string, args: Record<string, unknown> = {}): Promise<ToolAnswer> => {
    const result = await client.callTool({ name, arguments: args });
    answers.push(JSON.stringify(result));
    if (result.isError === true) return { isError: true, value: {}, error: toolError(result) };
    return { isError: false, value: result.structuredContent as Record<string, unknown> };
  };
  /** FR-026 and the global constraints: neither token appears in any tool result or log line. */
  const expectNoTokenLeaked = () => {
    for (const secret of [accessToken, REFRESH_TOKEN].filter((value): value is string => value !== undefined)) {
      expect(answers.join("\n")).not.toContain(secret);
      expect(stderr.join("")).not.toContain(secret);
    }
  };
  return { tool, home, stderr, expectNoTokenLeaked };
}
