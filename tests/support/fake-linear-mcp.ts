// A Streamable HTTP MCP server that answers like Linear's hosted server, from recorded fixtures:
// 5b's vendors/linear-tools.json (verbatim live tools/list entries, 2026-09-24, extended in phase 5)
// and vendors/linear-get-issue.json (the live get_issue result, free text replaced).
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { connectMcp } from "@agentx/gateway";
import type { ConnectorType } from "../../packages/broker/src/aws/connector-types.js";
import { linearConnectorType } from "../../packages/broker/src/aws/linear-connector-type.js";
import { vendorTools } from "./vendor-fixtures.js";

export const LINEAR_FIXTURE_TOOLS = vendorTools("linear");
const GET_ISSUE = JSON.parse(readFileSync(new URL("../fixtures/vendors/linear-get-issue.json", import.meta.url), "utf8")) as Record<string, unknown>;
export const CHARTERARC_TEAM_ID = "c408e946-78aa-4db8-923e-f78053dd954f";
export const OTHER_TEAM_ID = "0b6f3f7e-5d1a-4c1e-9a53-2f0f5a8f1c11";

export interface FakeLinearCall { name: string; arguments: Record<string, unknown> }

/** The live get_issue shape for `identifier`: `id` is the identifier, `teamId` the team UUID, `team` its name. */
function issueIn(identifier: string, teamId: string): Record<string, unknown> {
  return { ...structuredClone(GET_ISSUE), id: identifier, teamId, team: teamId === CHARTERARC_TEAM_ID ? "CharterArc" : "Other team" };
}

const text = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

function answer(name: string, args: Record<string, unknown>, issues: Readonly<Record<string, string>>): unknown {
  if (name === "get_issue") {
    const teamId = issues[String(args.id)];
    return teamId ? text(issueIn(String(args.id), teamId)) : { isError: true, content: [{ type: "text", text: "Entity not found: Issue" }] };
  }
  if (name === "list_issues") return text({ issues: [{ id: "CHA-1", title: "Flaky login test", status: "Todo" }] });
  if (name === "save_issue") return text({ id: args.id ?? "CHA-2", title: args.title ?? "Updated", url: "https://linear.app/example/issue/CHA-2" });
  if (name === "save_comment") return text({ id: "comment-1", issueId: args.issueId });
  return text({});
}

export async function startFakeLinearMcp(options: { issues?: Record<string, string> } = {}) {
  const issues = options.issues ?? { "CHA-1": CHARTERARC_TEAM_ID, "OTH-9": OTHER_TEAM_ID };
  const calls: FakeLinearCall[] = [];
  const headers: IncomingHttpHeaders[] = [];
  /** Set `value` to true to answer every later request with 401, as Linear does for a revoked key. */
  const unauthorized = { value: false };
  const server = createServer((request, response) => { void (async () => {
    headers.push(request.headers);
    if (unauthorized.value) { response.writeHead(401, { "www-authenticate": "Bearer" }).end(); return; }
    if (request.method !== "POST") { response.writeHead(405).end(); return; }
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const message = JSON.parse(body) as { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    if (message.id === undefined) { response.writeHead(202).end(); return; }
    let result: unknown;
    if (message.method === "initialize") result = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "linear-fixture", version: "1" } };
    else if (message.method === "tools/list") result = { tools: LINEAR_FIXTURE_TOOLS };
    else if (message.method === "tools/call") {
      const name = String(message.params?.name); const args = message.params?.arguments ?? {};
      calls.push({ name, arguments: args });
      result = answer(name, args, issues);
    } else {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  })().catch(() => { response.writeHead(500).end(); }); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake Linear server has no port");
  return {
    url: new URL(`http://127.0.0.1:${address.port}/mcp`),
    calls, headers, unauthorized,
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

/** The production linear type, whose connection goes to the fake server; records the endpoint it asked for. */
export function linearViaFake(fake: { url: URL }): { type: ConnectorType; requested: URL[] } {
  const requested: URL[] = [];
  const connect = ((input: Parameters<typeof connectMcp>[0]) => { requested.push(input.endpoint); return connectMcp({ ...input, endpoint: fake.url }); }) as typeof connectMcp;
  return { requested, type: { type: "linear", resolve: (config, project, context) => linearConnectorType.resolve(config, project, { ...context, connect }) } };
}
