// Deferring tools must not touch what is always direct: the rovara MCP server's tools (Pi's own MCP client, ROVARA_PI_MCP on, the default) and the structured-answer
// tools. With more than 20 source tools the rovara tools are all still declared and callable, no Pi host tool appears, and an answer tool stays declared next to
// deferred connector tools. A real Pi session on a scripted model against the broker's MCP endpoint. No network beyond loopback, no Docker.
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, getCurrentTools, type TranscriptContext } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_STEP_PREAMBLE, DEFERRED_TOOLS_ABOVE, type ConnectorCatalog, type ContextToolCallRequest, type ContextToolCatalog } from "../../packages/contracts/src/index.js";
import { answerMcp } from "../../packages/broker/src/context-sources/mcp-endpoint.js";
import { createConnectorBridgeTools } from "../../packages/worker/src/agent-run/connector-bridge.js";
import { ROVARA_MCP_TOOL_PREFIX } from "../../packages/worker/src/context-sources/pi-mcp.js";
import { createDefaultPiSessionAdapter, createWorkspacePiSession } from "../../packages/worker/src/pi-session.js";
import { PI_BUILT_IN_TOOL_NAMES } from "../../packages/model-runtime/src/deferred-tools.js";
import { FAUX_MODEL, fauxModelRuntime } from "../support/faux-model.js";

const CAPABILITY = ["v1", "eyJ3cyI6IndzIn0", "c2lnbmF0dXJl"].join(".");
const TOOL_COUNT = DEFERRED_TOOLS_ABOVE + 10;
const catalog: ContextToolCatalog = {
  sources: [{ sourceId: "sim", label: "SIM", quotes: "citations_only" }],
  tools: Array.from({ length: TOOL_COUNT }, (_, index) => ({
    name: `src_sim_tool_${String(index)}`, sourceId: "sim", upstreamName: `tool_${String(index)}`, role: "search" as const, description: `Search part ${String(index)}`,
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  })),
  searchTeamKnowledge: false, unavailable: [], disabled: [],
};
const toolNames = (context: TranscriptContext) => getCurrentTools(context.messages).map((tool) => tool.name).sort();

async function endpoint(calls: ContextToolCallRequest[]): Promise<{ url: string; close(): Promise<void> }> {
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      void answerMcp({ list: async () => catalog, call: async (call) => { calls.push(call); return { status: "OK", text: "a result" }; } }, body, () => "00000000-0000-4000-8000-000000000001").then((reply) => {
        if (reply.body === undefined) { response.writeHead(202).end(); return; }
        response.writeHead(reply.statusCode, { "content-type": "application/json" }).end(JSON.stringify(reply.body));
      }, (error: unknown) => { response.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: String(error) } })); });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${String(port)}`, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

const cleanup: Array<() => Promise<void>> = [];
beforeEach(async () => {
  const state = await mkdtemp(join(tmpdir(), "deferred-mcp-state-"));
  cleanup.push(() => rm(state, { recursive: true, force: true }));
  vi.stubEnv("AGENTX_WORKER_STATE_DIR", state);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const step of cleanup.splice(0).reverse()) await step();
});

const answerTool = (name: string) => defineTool({ name, label: name, description: "Deliver the answer.", parameters: Type.Object({ verdict: Type.String() }), execute: async () => ({ content: [{ type: "text", text: "recorded" }], details: {} }) });

describe("with the rovara MCP server and more than 20 source tools", () => {
  it("declares every rovara tool directly, calls one, adds no host tool, and keeps the answer tool direct", async () => {
    const calls: ContextToolCallRequest[] = [];
    const server = await endpoint(calls);
    cleanup.push(() => server.close());
    const rootPath = await mkdtemp(join(tmpdir(), "deferred-mcp-root-"));
    cleanup.push(() => rm(rootPath, { recursive: true, force: true }));
    const { modelRuntime, faux } = await fauxModelRuntime();
    const offered: string[][] = [];
    faux.setResponses([
      (context) => { offered.push(toolNames(context)); return fauxAssistantMessage([fauxToolCall(`${ROVARA_MCP_TOOL_PREFIX}src_sim_tool_25`, { query: "login" }, { id: "t1" })], { stopReason: "toolUse" }); },
      fauxAssistantMessage("Done."),
    ]);
    const adapter = createDefaultPiSessionAdapter({ modelRuntime: async () => ({ runtime: modelRuntime, model: FAUX_MODEL }) });
    const handle = await createWorkspacePiSession({
      rootPath, model: FAUX_MODEL, workflowMode: "REVIEW", localFileTools: true, answerTools: [answerTool("submit_review")],
      contextMcp: { brokerUrl: server.url, capability: CAPABILITY, catalog, onText: () => undefined, readyTimeoutMs: 2_000 },
    }, adapter);
    try { await handle.prompt("review it"); } finally { handle.dispose(); }
    const mcp = offered[0]!.filter((name) => name.startsWith(ROVARA_MCP_TOOL_PREFIX));
    expect(mcp).toHaveLength(TOOL_COUNT);
    expect(offered[0]).toContain("submit_review");
    expect(offered[0]).not.toContain("tool_search");
    expect(offered[0]!.filter((name) => PI_BUILT_IN_TOOL_NAMES.includes(name))).toEqual(["find", "grep", "ls", "read"]);
    expect(offered[0]!.filter((name) => !name.startsWith(ROVARA_MCP_TOOL_PREFIX))).toEqual(["find", "grep", "ls", "read", "submit_review"]);
    expect(calls).toEqual([expect.objectContaining({ tool: "src_sim_tool_25", arguments: { query: "login" } })]);
  });
});

describe("answer tools next to deferred connector tools", () => {
  it("stay declared, while the connector tools are found with tool_search", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "deferred-answer-root-"));
    cleanup.push(() => rm(rootPath, { recursive: true, force: true }));
    const { modelRuntime, faux } = await fauxModelRuntime();
    const offered: string[][] = [];
    faux.setResponses([(context) => { offered.push(toolNames(context)); return fauxAssistantMessage("ok"); }]);
    const adapter = createDefaultPiSessionAdapter({ modelRuntime: async () => ({ runtime: modelRuntime, model: FAUX_MODEL }) });
    const grants: ConnectorCatalog = {
      connector: "tracker", skipped: [],
      tools: Array.from({ length: DEFERRED_TOOLS_ABOVE + 1 }, (_, index) => ({
        name: `tracker__tool_${String(index)}`, upstreamName: `tool_${String(index)}`, description: "Read.", access: "read" as const,
        inputSchema: { type: "object", properties: {}, required: [] }, scopes: [{ alias: "main", schemaHash: "a".repeat(64) }],
      })),
    };
    const bridge = createConnectorBridgeTools([grants], async () => ({ status: "SUCCEEDED" }), { workspaceId: "ws", conversationId: "conv", operationId: "op" });
    const handle = await createWorkspacePiSession({
      rootPath, model: FAUX_MODEL, localFileTools: true, agentRun: { systemPrompt: AGENT_STEP_PREAMBLE, tools: bridge },
      answerTools: [answerTool("submit_review"), answerTool("submit_design_review")],
    }, adapter);
    try { await handle.prompt("review"); } finally { handle.dispose(); }
    expect(offered[0]).toEqual(["find", "grep", "ls", "read", "submit_design_review", "submit_review", "tool_search"]);
  });
});
