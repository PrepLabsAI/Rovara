// Shared fixtures for the context-source tests (lane E).
import type { ContextSource, OrgId } from "@agentx/contracts";
import { toolSchemaHash, type DiscoveredTool, type SourceEnvironment } from "../../../packages/broker/src/context-sources/settings.js";

export const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
export const CONNECTION = "con_aaaaaaaaaaaaaaaaaaaa";
export const NOW = Date.UTC(2026, 10, 1, 10, 0, 0);

export const SEARCH_TOOL: DiscoveredTool = {
  name: "search_tickets", description: "Search tickets", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  annotations: { readOnlyHint: true },
};
export const GET_TOOL: DiscoveredTool = {
  name: "get_ticket", description: "Read one ticket", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  annotations: { readOnlyHint: true, destructiveHint: false },
};
export const PLAIN_TOOL: DiscoveredTool = { name: "lookup_page", description: "Look up a page", inputSchema: { type: "object", properties: { title: { type: "string" } } } };
export const WRITE_TOOL: DiscoveredTool = { name: "close_ticket", description: "Close", inputSchema: { type: "object", properties: { id: { type: "string" } } }, annotations: { readOnlyHint: false } };

export function source(over: Partial<ContextSource> = {}, tools: DiscoveredTool[] = [SEARCH_TOOL, GET_TOOL]): ContextSource {
  return {
    sourceId: "sim", label: "SIM", server: { kind: "connection", connectionId: CONNECTION },
    tools: tools.map((tool, index) => ({ upstreamName: tool.name, role: index === 0 ? "search" as const : "read" as const, schemaHash: toolSchemaHash(tool) })),
    stages: ["UNDERSTAND", "PLAN", "PLAN_CRITIQUE", "REVIEW"], quotes: "citations_only", retention: "team_record",
    limits: { callsPerStage: 25, bytesPerResult: 16_384, bytesPerStage: 196_608 }, liveFacts: ["status"], sendCodeSnippets: false, ...over,
  };
}

export function environment(over: Partial<SourceEnvironment> & { tools?: DiscoveredTool[] } = {}): SourceEnvironment {
  const tools = over.tools ?? [SEARCH_TOOL, GET_TOOL];
  return {
    connection: async () => ({ type: "mcp", access: "read" }),
    registeredServer: async () => ({ status: "approved" }),
    discoverTools: async () => tools,
    perUserCheckAvailable: () => false,
    ...over,
  };
}

// ---- the broker route's world (E2)
import { vi } from "vitest";
import type { ContextToolsDependencies, ContextToolsRun, ContextServerSession } from "../../../packages/broker/src/context-sources/routes.js";
import { documentUsageStore } from "../../../packages/broker/src/context-sources/usage.js";
import type { ContextItemSeen } from "../../../packages/broker/src/context-sources/team-record.js";
import { INDEX_EXPIRY_ATTRIBUTE } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../../packages/broker/src/ports/memory-document-store.js";
import { TASK_FLOW_INDEXES } from "../../../packages/broker/src/core/task-flow/flow.js";
import type { Citation } from "@agentx/contracts";

export type Answer = { isError?: boolean; content?: Array<{ type: string; text?: string }>; structuredContent?: unknown };

export function routeWorld(options: {
  sources?: ContextSource[]; tools?: DiscoveredTool[]; answer?: (name: string, args: Record<string, unknown>) => Answer | Promise<Answer>; openFails?: boolean;
  hosts?: string[]; mode?: string; memberCheck?: () => Promise<void>;
} = {}) {
  const table = new MemoryDocumentStore({ indexes: TASK_FLOW_INDEXES, ttlAttribute: INDEX_EXPIRY_ATTRIBUTE });
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const seen: ContextItemSeen[] = [];
  const citations: Citation[] = [];
  const kept: Array<{ text: string; retention: string }> = [];
  const logs: string[] = [];
  let opens = 0;
  const tools = options.tools ?? [SEARCH_TOOL, GET_TOOL];
  const deps: ContextToolsDependencies = {
    now: () => NOW,
    requireAuthority: options.memberCheck ?? (async () => undefined),
    sources: async () => ({ revision: 1, sources: options.sources ?? [source()] }),
    servers: {
      open: async () => {
        opens += 1;
        if (options.openFails === true) throw new Error("connect ECONNREFUSED 10.0.0.9:443");
        const session: ContextServerSession = {
          hosts: options.hosts ?? ["sim.example.com"], tools,
          call: async (name, args) => { calls.push({ name, args }); return (await (options.answer ?? (() => ({ content: [{ type: "text", text: "ok" }] })))(name, args)); },
          close: async () => undefined,
        };
        return session;
      },
    },
    usage: documentUsageStore({ store: table, now: () => NOW }),
    teamSink: { seen: async (item) => { seen.push(item); } },
    teamSearch: { search: async () => [] },
    citations: { record: async (input) => { citations.push(input.citation); } },
    results: { keep: async (input) => { kept.push({ text: input.text, retention: input.retention }); } },
    log: (event) => { logs.push(event); },
  };
  const run = (over: Partial<ContextToolsRun["operation"]> = {}): ContextToolsRun => ({
    orgId: ORG, task: { taskId: "task1", project: "proj" },
    operation: { id: "op1", workflowMode: options.mode ?? "PLAN", ...over },
  });
  return { deps, run, calls, seen, citations, kept, logs, opens: () => opens, table };
}
void vi;
