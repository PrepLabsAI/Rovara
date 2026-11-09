// E3: the context tools of a stage: one worker tool for each tool the broker presents, and `search_team_knowledge`. A tool call goes to the broker's
// context-tools route with the operation's capability and nowhere else: the server, its credential, the stage rules and every limit are the broker's.
// The tools run in the worker, never in the task's container, and give no way to read or write a file.
import { createHash } from "node:crypto";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  ContextToolCallResponseSchema,
  ContextToolCatalogSchema,
  SEARCH_TEAM_KNOWLEDGE_TOOL,
  agentXError,
  type ContextToolCallRequest,
  type ContextToolCallResponse,
  type ContextToolCatalog,
} from "@agentx/contracts";
import { frameForModel } from "./frame.js";

const CAPABILITY_HEADER = "x-agentx-callback-capability";
const TOOLS_PATH = "/v1/internal/context-tools";
const CALL_PATH = "/v1/internal/context-tools/call";
export const CONTEXT_CATALOG_TIMEOUT_MS = 30_000;
export const CONTEXT_CALL_TIMEOUT_MS = 30_000;
/** The most of a broker answer the worker reads. The broker's own cap is far below it. */
const ANSWER_MAX_BYTES = 262_144;

export type ContextBridgeCall = (request: ContextToolCallRequest, signal?: AbortSignal) => Promise<ContextToolCallResponse>;

interface BrokerInput { brokerUrl: string; capability: string; fetch?: typeof fetch; signal?: AbortSignal }

const urlOf = (brokerUrl: string, path: string): string => `${brokerUrl.replace(/\/$/u, "")}${path}`;
const bounded = (timeoutMs: number, ...signals: Array<AbortSignal | undefined>): AbortSignal =>
  AbortSignal.any([AbortSignal.timeout(timeoutMs), ...signals.filter((signal): signal is AbortSignal => signal !== undefined)]);

async function boundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > ANSWER_MAX_BYTES) throw new Error("answer too large");
  if (response.body === null) return undefined;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > ANSWER_MAX_BYTES) throw new Error("answer too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

/**
 * The stage's tools from the broker. A refusal of the capability fails the stage (a capability was issued, so a refusal is a fault to see, not a reason to
 * run without sources). Any other failure gives no tools: the stage goes on without sources and says so (`onDiagnostic`).
 */
export function contextToolsCatalogSource(input: BrokerInput & { onDiagnostic?: (message: string) => void }): () => Promise<ContextToolCatalog | undefined> {
  const transport = input.fetch ?? fetch;
  return async () => {
    let response: Response;
    try {
      response = await transport(urlOf(input.brokerUrl, TOOLS_PATH), { method: "GET", headers: { [CAPABILITY_HEADER]: input.capability }, signal: bounded(CONTEXT_CATALOG_TIMEOUT_MS, input.signal) });
    } catch (error) {
      if (input.signal?.aborted === true) throw error;
      input.onDiagnostic?.("context sources: the tool list could not be read; the stage runs without sources");
      return undefined;
    }
    if (response.status === 401 || response.status === 403) throw agentXError("CALLBACK_FORBIDDEN", `the control plane refused this stage's source list (HTTP ${response.status})`);
    if (!response.ok) { input.onDiagnostic?.(`context sources: the tool list request failed with HTTP ${response.status}; the stage runs without sources`); return undefined; }
    const parsed = ContextToolCatalogSchema.safeParse(await boundedJson(response).catch(() => undefined));
    if (!parsed.success) { input.onDiagnostic?.("context sources: the broker's tool list was not understood; the stage runs without sources"); return undefined; }
    return parsed.data;
  };
}

/** One call to the broker. A refusal of the capability throws; anything else is an answer the model reads (a fixed sentence), so one source's trouble never fails the stage. */
export function brokerContextCall(input: BrokerInput): ContextBridgeCall {
  const transport = input.fetch ?? fetch;
  return async (request, signal) => {
    const response = await transport(urlOf(input.brokerUrl, CALL_PATH), {
      method: "POST", headers: { [CAPABILITY_HEADER]: input.capability, "content-type": "application/json" }, body: JSON.stringify(request),
      signal: bounded(CONTEXT_CALL_TIMEOUT_MS, input.signal, signal),
    });
    if (response.status === 401 || response.status === 403) throw agentXError("CALLBACK_FORBIDDEN", `the control plane refused a source call (HTTP ${response.status})`);
    if (!response.ok) return { status: "UNAVAILABLE", text: "That source could not be asked right now. Carry on without it and say so in your answer." };
    const parsed = ContextToolCallResponseSchema.safeParse(await boundedJson(response).catch(() => undefined));
    return parsed.success ? parsed.data : { status: "UNAVAILABLE", text: "That source's answer could not be read. Carry on without it and say so in your answer." };
  };
}

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: {} });

/** The request id a redelivered step repeats: the same call id gives the same id. */
function requestIdFor(context: { workspaceId: string; conversationId: string; operationId: string }, tool: string, callId: string): string {
  const hash = createHash("sha256").update(JSON.stringify([context.workspaceId, context.conversationId, context.operationId, tool, callId])).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export function createContextTools(catalog: ContextToolCatalog, call: ContextBridgeCall, context: { workspaceId: string; conversationId: string; operationId: string }, options: { onText?: (text: string) => void } = {}): ToolDefinition[] {
  const labelOf = new Map(catalog.sources.map((source) => [source.sourceId, source.label]));
  const run = async (name: string, label: string, callId: string, args: Record<string, unknown>, signal: AbortSignal | undefined) => {
    try {
      const answer = await call({ requestId: requestIdFor(context, name, callId), tool: name, arguments: args }, signal);
      // What a source returned is remembered for the stage, so that the model cannot copy it out word for word into stored text (text-guard.ts).
      if (answer.status === "OK") options.onText?.(answer.text);
      return text(frameForModel(answer, label));
    } catch (error) {
      // A stopped stage or a refused capability ends the stage; anything else is one source being down.
      if (signal?.aborted === true || (error as { code?: unknown } | null)?.code === "CALLBACK_FORBIDDEN") throw error;
      return text(`${label} is unavailable right now. Carry on without it and say in your answer that it was not reachable.`);
    }
  };
  const tools: ToolDefinition[] = catalog.tools.map((tool) => {
    const label = labelOf.get(tool.sourceId) ?? tool.sourceId;
    return defineTool({
      name: tool.name, label: `${label} / ${tool.upstreamName}`, description: tool.description,
      parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema),
      execute: async (callId, parameters, signal) => run(tool.name, label, callId, parameters, signal),
    });
  });
  if (catalog.searchTeamKnowledge) {
    tools.push(defineTool({
      name: SEARCH_TEAM_KNOWLEDGE_TOOL, label: "Search team knowledge",
      description: "Search every source of this project (and Rovara's record of past work) for a short query. Each answer comes back separately, framed as data from its source.",
      parameters: Type.Object({ query: Type.String({ maxLength: 300 }), sources: Type.Optional(Type.Array(Type.String({ maxLength: 16 }), { maxItems: 16 })) }),
      execute: async (callId, parameters, signal) => run(SEARCH_TEAM_KNOWLEDGE_TOOL, "Team knowledge", callId, parameters as Record<string, unknown>, signal),
    }) as ToolDefinition);
  }
  return tools;
}
