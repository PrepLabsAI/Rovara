import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { connectMcp } from "../../packages/broker/src/mcp-client.js";

describe("MCP Streamable HTTP bridge", () => {
  it("initializes, follows discovery cursors, filters tools and forwards a native call with server-only credentials", async () => {
    const messages: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const headers: IncomingMessage["headers"][] = [];
    const server = createServer((request, response) => { void (async () => {
      headers.push(request.headers);
      if (request.method !== "POST") { response.writeHead(405).end(); return; }
      let body = "";
      for await (const chunk of request) body += String(chunk);
      const message = JSON.parse(body) as { id?: number; method: string; params?: Record<string, unknown> };
      messages.push(message);
      if (message.id === undefined) { response.writeHead(202).end(); return; }
      const result = message.method === "initialize"
        ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
        : message.method === "tools/list"
          ? message.params?.cursor
            ? { tools: [{ name: "issue_read", description: "Native description", inputSchema: { type: "object", properties: {} } }] }
            : { tools: [{ name: "push_files", inputSchema: { type: "object" } }], nextCursor: "page2" }
          : { content: [{ type: "text", text: "native result" }] };
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    })().catch(() => { response.writeHead(500).end(); }); });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing fixture port");
    try {
      const connection = await connectMcp({ endpoint: new URL(`http://127.0.0.1:${address.port}/mcp/`), token: "server-secret", tools: ["issue_read"], signal: AbortSignal.timeout(5000) });
      try {
        expect(connection.tools).toEqual([{ name: "issue_read", description: "Native description", inputSchema: { type: "object", properties: {} } }]);
        await expect(connection.call("push_files", {})).rejects.toThrow(/not allowed/);
        await expect(connection.call("issue_read", { owner: "example", repo: "demo", issue_number: 4, method: "get" })).resolves.toMatchObject({ content: [{ text: "native result" }] });
        expect(messages.filter((message) => message.method === "tools/call")).toEqual([expect.objectContaining({
          params: { name: "issue_read", arguments: { owner: "example", repo: "demo", issue_number: 4, method: "get" } },
        })]);
        expect(messages.filter((message) => message.method === "tools/list")).toHaveLength(2);
        expect(JSON.stringify(messages)).not.toContain("server-secret");
        expect(headers.every((entry) => entry.authorization === "Bearer server-secret" && entry["x-mcp-tools"] === "issue_read" && entry["x-mcp-toolsets"] === undefined)).toBe(true);
      } finally { await connection.close(); }
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  it("does not follow redirects or retry an ambiguous tool call", async () => {
    let calls = 0;
    const connection = await connectMcp({
      endpoint: new URL("https://mcp.example.test/"), token: "secret", tools: ["issue_write"], signal: AbortSignal.timeout(5000),
      fetchImplementation: async (_url, init) => {
        expect(init?.redirect).toBe("error");
        if (typeof init?.body !== "string") throw new Error("expected JSON body");
        const message = JSON.parse(init.body) as { method: string; id?: number };
        if (message.method === "tools/call") { calls += 1; throw new Error("connection lost after send"); }
        if (message.id === undefined) return new Response(null, { status: 202 });
        const result = message.method === "initialize"
          ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
          : { tools: [{ name: "issue_write", inputSchema: { type: "object" } }] };
        return Response.json({ jsonrpc: "2.0", id: message.id, result });
      },
    });
    try { await expect(connection.call("issue_write", {})).rejects.toThrow(); expect(calls).toBe(1); }
    finally { await connection.close(); }
  });
});
