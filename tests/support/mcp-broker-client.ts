// The MCP SDK's client driving `agentx mcp`'s server against the developer task broker in process
// (spec 025 Testing section). Moved from mcp-developer-flow.test.ts for Task 16's shared-task flow.
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { expect } from "vitest";
import { agentxMcpServer } from "../../packages/cli/src/mcp/serve.js";
import { developerTokenKey, saveDeveloperEnvironment } from "../../packages/cli/src/developer/config.js";
import { InMemoryTokenStore } from "../../packages/cli/src/token-store.js";
import { ADMIN_SUBJECT } from "./admin-read-broker.js";
import { DEV_ISSUER, MAYA, bearerFor, type createDeveloperTaskBroker, type Developer } from "./developer-task-broker.js";
import { toolError, type ParsedToolError } from "./mcp-tool-error.js";
import { issuer } from "./slack-broker.js";

type Harness = Awaited<ReturnType<typeof createDeveloperTaskBroker>>;

export const URL_BASE = "https://abc123.execute-api.us-east-1.amazonaws.com";
export const REFRESH_TOKEN = `agxr_${"a".repeat(43)}`;
export const ADMIN_TOKEN = "admin-token-for-mcp-tests-7d1c";
export const NON_ADMIN_TOKEN = "cognito-user-without-admin-group-2b9e";

/** What one request to the control plane carried, for tests that follow a trace ID (FR-052). */
export interface SentRequest { method: string; path: string; traceId?: string }

/** Spec 025 phase 25e: the configuration's admin API version and confirmation methods, and a request log. */
export interface McpBrokerFetchOptions {
  adminApiVersion?: string;
  confirm?: { elicitation: boolean; slack: boolean };
  onRequest?(request: SentRequest): void;
}

/**
 * The control plane as the MCP server sees it: agentx-configuration, /v1/dev/* on the broker, and
 * /v1/admin/* behind API Gateway's JWT authorizer (ADMIN_TOKEN carries the admins group,
 * NON_ADMIN_TOKEN none, and any other bearer is refused before the broker). The MCP server's
 * `x-agentx-trace-id` reaches the broker as API Gateway passes it (FR-052, 25e ruling C20).
 */
export function mcpBrokerFetch(harness: Harness, options: McpBrokerFetchOptions = {}): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === "/v1/auth/.well-known/agentx-configuration") {
      return Response.json({ env: "staging", apiVersion: "1.2", adminApiVersion: options.adminApiVersion ?? "1.0", issuer: DEV_ISSUER, ...(options.confirm === undefined ? {} : { confirm: options.confirm }) });
    }
    const headers = new Headers(init?.headers);
    const authorization = headers.get("authorization") ?? "";
    const traceId = headers.get("x-agentx-trace-id") ?? undefined;
    options.onRequest?.({ method: init?.method ?? "GET", path: url.pathname, ...(traceId === undefined ? {} : { traceId }) });
    let authorizer: { jwt: { claims: Record<string, unknown> } } | undefined;
    if (url.pathname.startsWith("/v1/admin/")) {
      const bearer = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
      if (bearer !== ADMIN_TOKEN && bearer !== NON_ADMIN_TOKEN) return Response.json({ message: "Unauthorized" }, { status: 401 });
      authorizer = { jwt: { claims: { iss: issuer, sub: ADMIN_SUBJECT, groups: bearer === ADMIN_TOKEN ? ["admins"] : [] } } };
    }
    const response = await harness.handler({
      version: "2.0", rawPath: url.pathname, rawQueryString: url.search.slice(1),
      headers: { authorization, ...(traceId === undefined ? {} : { "x-agentx-trace-id": traceId }) },
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
      requestContext: { requestId: randomUUID(), http: { method: init?.method ?? "GET" }, ...(authorizer === undefined ? {} : { authorizer }) },
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
  expect((await client.listTools()).tools).toHaveLength(15);
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

/**
 * Spec 025 phase 25d: `agentx mcp` with a developer sign-in and, unless `adminToken` is null, an admin
 * sign-in. Phase 25e: a client that declares form elicitation (unless `elicitation` is false) and
 * answers each pop-up yes or no, the MCP server's clock (a sleep advances it, then runs `onSleep`),
 * and the configuration's options.
 */
export async function adminSignedInClient(harness: Harness, options: {
  adminToken?: string | null;
  who?: Developer;
  elicitation?: "accept" | "decline" | false;
  clock?: { now(): number; advance(ms: number): void };
  onSleep?: () => Promise<void>;
  config?: McpBrokerFetchOptions;
} = {}) {
  const home = await mkdtemp(join(tmpdir(), "agentx-mcp-admin-"));
  const tokenStore = new InMemoryTokenStore();
  await saveDeveloperEnvironment(home, "staging", { url: URL_BASE, issuer: DEV_ISSUER, tokenEndpoint: `${DEV_ISSUER}/token`, revocationEndpoint: `${DEV_ISSUER}/revoke` });
  const developerToken = (await bearerFor(options.who ?? MAYA)).slice("Bearer ".length);
  await tokenStore.set(developerTokenKey(DEV_ISSUER), { accessToken: developerToken, refreshToken: REFRESH_TOKEN, expiresAt: Date.now() + 3_600_000 });
  const adminToken = options.adminToken === null ? undefined : options.adminToken ?? ADMIN_TOKEN;
  const stderr: string[] = [];
  const sent: SentRequest[] = [];
  const clock = options.clock;
  const server = agentxMcpServer({
    home, tokenStore, stderr: { write: (text: string) => stderr.push(text) },
    fetch: mcpBrokerFetch(harness, { ...options.config, onRequest: (request) => { sent.push(request); options.config?.onRequest?.(request); } }),
    adminSignedIn: async () => adminToken !== undefined,
    adminSession: async () => (adminToken === undefined ? undefined : { baseUrl: URL_BASE, accessToken: adminToken }),
    ...(clock === undefined ? {} : { clock: { now: () => clock.now(), sleep: async (ms: number) => { clock.advance(ms); await options.onSleep?.(); } } }),
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  // No pop-up unless asked for, so 25d's clients (which pass no option) stay exactly as they were.
  const elicitation = options.elicitation ?? false;
  const client = new Client({ name: "claude-code", version: "2.1.0" }, { capabilities: elicitation === false ? {} : { elicitation: { form: {} } } });
  /** Every pop-up's message, as the admin saw it. */
  const asked: string[] = [];
  if (elicitation !== false) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      asked.push(String(request.params.message));
      return elicitation === "accept" ? { action: "accept", content: { confirm: true } } : { action: "decline" };
    });
  }
  await client.connect(clientSide);
  const answers: string[] = [];
  const tool = async (name: string, args: Record<string, unknown> = {}): Promise<ToolAnswer> => {
    const result = await client.callTool({ name, arguments: args });
    answers.push(JSON.stringify(result));
    return result.isError === true ? { isError: true, value: {}, error: toolError(result) } : { isError: false, value: result.structuredContent as Record<string, unknown> };
  };
  const names = async () => (await client.listTools()).tools.map((entry) => entry.name);
  return { tool, names, stderr, answers, asked, sent, developerToken };
}
