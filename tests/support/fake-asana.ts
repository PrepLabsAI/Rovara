// tests/support/fake-asana.ts
// A local server that answers like Asana: an OAuth token endpoint (refresh grant only) at
// /-/oauth_token and a Streamable HTTP MCP server at /v2/mcp serving the recorded tools/list
// (vendors/asana-tools.json) and the get_task shape (vendors/asana-get-task.json). The MCP server
// answers 401 unless the Bearer token is an access token it issued and has not revoked.
import { createServer } from "node:http";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { vendorTools } from "./vendor-fixtures.js";

const GET_TASK = JSON.parse(readFileSync(new URL("../fixtures/vendors/asana-get-task.json", import.meta.url), "utf8")) as { data: Record<string, unknown> };

export interface FakeAsanaTask { projects: string[]; parent?: string }

export interface FakeAsana {
  mcpUrl: URL;
  tokenUrl: URL;
  calls: Array<{ name: string; arguments: Record<string, unknown> }>;
  authorizations: Array<string | undefined>;
  /** Every refresh token presented to the token endpoint, in order. */
  refreshes: string[];
  /** When true, each refresh issues a new refresh token and revokes the one presented. */
  rotate: boolean;
  /** When set, the token endpoint answers every request with this HTTP status, as in an outage. */
  tokenOutageStatus: number | undefined;
  /** Revokes every access token issued so far, as if they had expired. */
  expireAccessTokens(): void;
  /** Revokes the current refresh token, as if the bot user's grant was removed in Asana. */
  revokeRefreshToken(): void;
  close(): Promise<void>;
}

export async function startFakeAsana(options: { clientId: string; clientSecret: string; refreshToken: string; tasks: Record<string, FakeAsanaTask> }): Promise<FakeAsana> {
  const tools = vendorTools("asana");
  const issued = new Set<string>();
  let validRefresh: string | undefined = options.refreshToken;
  let serial = 0;
  const text = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
  const fake = {
    calls: [] as FakeAsana["calls"],
    authorizations: [] as FakeAsana["authorizations"],
    refreshes: [] as string[],
    rotate: false,
    tokenOutageStatus: undefined as number | undefined,
    expireAccessTokens: () => { issued.clear(); },
    revokeRefreshToken: () => { validRefresh = undefined; },
  };
  const answer = (name: string, args: Record<string, unknown>) => {
    fake.calls.push({ name, arguments: args });
    if (name === "get_task") {
      const gid = String(args.task_id);
      const task = options.tasks[gid];
      if (!task) return { isError: true, content: [{ type: "text", text: "Error: task not found" }] };
      return text({ data: {
        ...GET_TASK.data, gid,
        projects: task.projects.map((project) => ({ gid: project, name: "Project", resource_type: "project" })),
        memberships: task.projects.map((project) => ({ project: { gid: project, name: "Project" } })),
        parent: task.parent === undefined ? null : { gid: task.parent, name: "Parent" },
      } });
    }
    if (name === "create_tasks") return text({ data: { succeeded: [{ gid: "1210000000000901", name: "created" }], failed: [] } });
    if (name === "add_comment") return text({ data: { gid: "1210000000000950", resource_subtype: "comment_added" } });
    if (name === "search_tasks" || name === "get_tasks") return text({ data: Object.keys(options.tasks).map((gid) => ({ gid, name: `Task ${gid}` })) });
    return text({ data: {} });
  };
  const server = createServer((request, response) => { void (async () => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/-/oauth_token" && request.method === "POST") {
      const form = new URLSearchParams(body);
      const json = (status: number, value: unknown) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
      if (fake.tokenOutageStatus !== undefined) { json(fake.tokenOutageStatus, { error: "service_unavailable" }); return; }
      if (form.get("client_id") !== options.clientId || form.get("client_secret") !== options.clientSecret) { json(401, { error: "invalid_client" }); return; }
      if (form.get("grant_type") !== "refresh_token") { json(400, { error: "unsupported_grant_type" }); return; }
      const presented = form.get("refresh_token") ?? "";
      fake.refreshes.push(presented);
      if (validRefresh === undefined || presented !== validRefresh) { json(400, { error: "invalid_grant", error_description: `refresh token ${presented} is not valid` }); return; }
      serial += 1;
      const accessToken = `asana-access-${serial}-${"x".repeat(48)}`;
      issued.add(accessToken);
      if (fake.rotate) validRefresh = `asana-refresh-rotated-${serial}-${"y".repeat(40)}`;
      json(200, { access_token: accessToken, token_type: "bearer", expires_in: 3600, refresh_token: validRefresh, data: { id: 1, name: "AgentX bot" } });
      return;
    }
    if (url.pathname !== "/v2/mcp") { response.writeHead(404).end(); return; }
    fake.authorizations.push(request.headers.authorization);
    if (request.method !== "POST") { response.writeHead(405).end(); return; }
    const bearer = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1];
    if (bearer === undefined || !issued.has(bearer)) { response.writeHead(401).end(); return; }
    const message = JSON.parse(body) as { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    if (message.id === undefined) { response.writeHead(202).end(); return; }
    const result = message.method === "initialize"
      ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fake-asana", version: "1" } }
      : message.method === "tools/list" ? { tools } : answer(message.params?.name ?? "", message.params?.arguments ?? {});
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  })().catch(() => { response.writeHead(500).end(); }); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing fake Asana port");
  const origin = `http://127.0.0.1:${address.port}`;
  return Object.assign(fake, {
    mcpUrl: new URL(`${origin}/v2/mcp`),
    tokenUrl: new URL(`${origin}/-/oauth_token`),
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  });
}
