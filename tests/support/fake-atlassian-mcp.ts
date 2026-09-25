// A local Streamable HTTP MCP server that answers like Atlassian's Rovo MCP server, from 5b's
// recorded tools/list (vendors/jira-tools.json) and the live getJiraIssue shape
// (vendors/jira-get-issue.json). It answers 401 unless the exact Bearer token is sent, or always
// when tokenAuth is false (API token authentication disabled at Atlassian).
import { createServer } from "node:http";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import type { McpConnection } from "@agentx/gateway";
import { vendorTools } from "./vendor-fixtures.js";

const GET_ISSUE = JSON.parse(readFileSync(new URL("../fixtures/vendors/jira-get-issue.json", import.meta.url), "utf8")) as { data: Record<string, unknown> };
/** The live getJiraIssue shape for an issue whose current key is `key`. */
const issueWithKey = (key: string) => ({ ...GET_ISSUE, data: { ...GET_ISSUE.data, key } });

export interface FakeAtlassian {
  url: URL;
  calls: Array<{ name: string; arguments: Record<string, unknown> }>;
  authorizations: Array<string | undefined>;
  close(): Promise<void>;
}

export function atlassianTools(): McpConnection["tools"] {
  return vendorTools("jira");
}

export async function startFakeAtlassian(options: { token: string; tokenAuth?: boolean; issues: Record<string, string> }): Promise<FakeAtlassian> {
  const calls: FakeAtlassian["calls"] = [];
  const authorizations: FakeAtlassian["authorizations"] = [];
  const tools = atlassianTools();
  const text = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
  const answer = (name: string, args: Record<string, unknown>) => {
    calls.push({ name, arguments: args });
    if (name === "getJiraIssue") {
      const key = options.issues[String(args.issueIdOrKey)];
      return key ? text(issueWithKey(key)) : { isError: true, content: [{ type: "text", text: "Issue does not exist or you do not have permission to see it." }] };
    }
    if (name === "searchJiraIssuesUsingJql") return text({ issues: [...new Set(Object.values(options.issues))].map((key) => ({ key })), isLast: true });
    if (name === "createJiraIssue") return text({ id: "10009", key: "KAN-9" });
    if (name === "addOrEditJiraIssueComment") return text({ commentId: "20001" });
    return text({ ok: true });
  };
  const server = createServer((request, response) => { void (async () => {
    authorizations.push(request.headers.authorization);
    if (request.method !== "POST") { response.writeHead(405).end(); return; }
    if (options.tokenAuth === false || request.headers.authorization !== `Bearer ${options.token}`) { response.writeHead(401).end(); return; }
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const message = JSON.parse(body) as { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    if (message.id === undefined) { response.writeHead(202).end(); return; }
    const result = message.method === "initialize"
      ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fake-atlassian", version: "1" } }
      : message.method === "tools/list" ? { tools } : answer(message.params?.name ?? "", message.params?.arguments ?? {});
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  })().catch(() => { response.writeHead(500).end(); }); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing fake Atlassian port");
  return {
    url: new URL(`http://127.0.0.1:${address.port}/v2/mcp`), calls, authorizations,
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}
