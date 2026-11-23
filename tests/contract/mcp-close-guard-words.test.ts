// The MCP/CLI close (`agentx_close_task`) sends an UNBOUND close and has no bound path yet: on an install with the close guard every machine-backed task answers one of the guard's exact sentences. The tool's
// result must carry that sentence unchanged. The control plane here is a stub that answers with the shared fixture's bodies.
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { createAgentXMcpServer, httpControlPlaneClient, type ControlPlaneClient, type ToolContext } from "../../packages/mcp/src/index.js";
import { toolError as parseToolError } from "../support/mcp-tool-error.js";

const TASK = "11111111-1111-4111-8111-111111111111";
const fixture = JSON.parse(readFileSync(new URL("../fixtures/close-envelopes.json", import.meta.url), "utf8")) as { refusals: Record<string, { status: number; body: { error: { code: string; message: string } } }> };

async function connect(client: ControlPlaneClient) {
  const context = (name: string | undefined): ToolContext => ({
    client, clientName: name, serverVersion: "0.4.0", adminSignedIn: async () => false, compatibility: async () => ({ env: "staging", apiVersion: "1.2" }),
    now: () => 0, sleep: async () => undefined, newRequestId: () => "33333333-3333-4333-8333-333333333333",
  });
  const server = createAgentXMcpServer({ version: "0.4.0", context });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const mcp = new Client({ name: "claude-code", version: "1.0.0" });
  await mcp.connect(clientSide);
  return mcp;
}

describe("agentx_close_task on a guarded install", () => {
  for (const name of ["retained", "checking", "cannot_check", "try_again"] as const) {
    it(`carries the ${name} sentence to the person, byte for byte, as a busy answer (nothing was closed)`, async () => {
      const { status, body } = fixture.refusals[name]!;
      const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
      const client = httpControlPlaneClient({ session: async () => ({ baseUrl: "https://agentx.example.test", accessToken: "token", signInCommand: "login" }), fetch, sleep: async () => undefined, traceId: () => "trace-1" });
      const mcp = await connect(client);
      const result = await mcp.callTool({ name: "agentx_close_task", arguments: { task_id: TASK } });
      expect(result.isError).toBe(true);
      const error = parseToolError(CallToolResultSchema.parse(result));
      expect(error.code).toBe("TASK_BUSY");
      // The tool prints `CODE: message. Next step: ...`: it takes the message's own full stop off and puts one back, so the sentence is whole in the text.
      expect(error.message).toBe(body.error.message.replace(/\.+$/u, ""));
      const printed = (result.content as Array<{ text: string }>)[0]!.text;
      expect(printed).toContain(body.error.message);
      // Sent once, unbound: no digest, no discard.
      const sent = JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string) as Record<string, unknown>;
      expect(Object.keys(sent)).toEqual(["requestId"]);
    });
  }
});
