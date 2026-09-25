import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

export interface McpToolResult {
  isError?: boolean | undefined;
  content?: Array<{ type: string; text?: string | undefined }> | undefined;
  structuredContent?: unknown;
}

/** MCP tool annotations as a vendor sends them. Only the two hints the action gate reads are typed. */
export interface McpToolAnnotations {
  readOnlyHint?: unknown;
  destructiveHint?: unknown;
  [key: string]: unknown;
}

export interface McpConnection {
  tools: Array<{ name: string; description?: string | undefined; inputSchema: Record<string, unknown>; annotations?: McpToolAnnotations | undefined }>;
  call(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
  close(): Promise<void>;
}

/** The MCP server answered HTTP 401: the credential was rejected. Carries no server text. */
export class McpUnauthorized extends Error {
  constructor() { super("MCP server rejected the credential"); this.name = "McpUnauthorized"; }
}

/** Server-owned endpoint/credentials only. Never expose these options to the model. */
export async function connectMcp(options: {
  endpoint: URL;
  token: string;
  tools: readonly string[];
  signal: AbortSignal;
  fetchImplementation?: typeof fetch;
}): Promise<McpConnection> {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  let unauthorized = false;
  const transport = new StreamableHTTPClientTransport(options.endpoint, {
    requestInit: { headers: { Authorization: `Bearer ${options.token}`, "X-MCP-Tools": options.tools.join(",") } },
    reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 0, initialReconnectionDelay: 0, reconnectionDelayGrowFactor: 1 },
    fetch: async (url, init) => {
      const response = await fetchImplementation(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.any([options.signal, ...(init?.signal ? [init.signal] : [])]),
      });
      if (response.status === 401) unauthorized = true;
      if (!response.body) return response;
      let bytes = 0;
      const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          bytes += chunk.byteLength;
          if (bytes > 1_000_000) throw new Error("MCP response exceeded limit");
          controller.enqueue(chunk);
        },
      }));
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    },
  });
  const client = new Client({ name: "agentx-control-plane", version: "0.1.0" });
  const requestOptions = { signal: options.signal, timeout: 15_000, maxTotalTimeout: 15_000 };
  try {
    // SDK's sessionId getter includes undefined; its Transport interface omits it under exactOptionalPropertyTypes.
    await client.connect(transport as Transport, requestOptions);
    const discovered: McpConnection["tools"] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const listing = await client.listTools(cursor ? { cursor } : {}, requestOptions);
      listing.tools.forEach((tool) => { if (options.tools.includes(tool.name)) discovered.push(tool); });
      cursor = listing.nextCursor;
      if (!cursor) break;
    }
    if (cursor) throw new Error("MCP discovery pagination exceeded limit");
    if (new Set(discovered.map((tool) => tool.name)).size !== discovered.length) throw new Error("Duplicate MCP tool name");
    return {
      tools: discovered,
      async call(name, args) {
        if (!discovered.some((tool) => tool.name === name)) throw new Error("MCP tool not allowed or unavailable");
        return CallToolResultSchema.parse(await client.callTool({ name, arguments: args }, CallToolResultSchema, requestOptions));
      },
      async close() { await client.close(); },
    };
  } catch (error) {
    await client.close().catch(() => undefined);
    throw unauthorized ? new McpUnauthorized() : error;
  }
}
