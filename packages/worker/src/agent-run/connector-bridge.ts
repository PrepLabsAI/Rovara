// The connector tools of an agent step (Task 23). The worker does not depend on @agentx/orchestrator, so this is its own copy
// of createConnectorTools' logic (presented names, the `target` argument, request ids from workspace, conversation and call
// id; a test feeds one catalog to both and compares). The only place a call goes is the broker's agent-tools route, with the
// step's capability: the vendor, its credential, the grant and the approval of a write are all the broker's.
import { createHash } from "node:crypto";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ConnectorCatalogSchema, agentXError, type ConnectorCallRequest, type ConnectorCatalog } from "@rovara-code/contracts";
import { z } from "zod";

const CAPABILITY_HEADER = "x-agentx-callback-capability";
const TOOLS_PATH = "/v1/internal/agent-tools";
const CALL_PATH = "/v1/internal/agent-tools/call";

/** One call to the broker: the request the model's tool call made, for one connector. */
export type ConnectorBridgeCall = (input: ConnectorCallRequest & { workspaceId: string; connector: string }, signal?: AbortSignal) => Promise<unknown>;

/** One bridge for every presented connector tool. No per-vendor tool implementations. */
export function createConnectorBridgeTools(
  catalogs: readonly ConnectorCatalog[],
  call: ConnectorBridgeCall,
  context: { workspaceId: string; conversationId: string; operationId?: string },
  options: { requestId?: () => string } = {},
): ToolDefinition[] {
  const requestIds = new Map<string, string>();
  return catalogs.flatMap((catalog) => catalog.tools.map((tool) => {
    const properties = tool.inputSchema.properties;
    const targeted = Boolean(properties && typeof properties === "object" && Object.hasOwn(properties, "target"));
    return defineTool({
      name: tool.name,
      label: `${catalog.connector} / ${tool.upstreamName}`,
      description: tool.description,
      parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema),
      execute: async (callId, parameters, signal) => {
        const { target, ...rest } = parameters;
        const scope = targeted ? tool.scopes.find((entry) => entry.alias === target) : tool.scopes[0];
        if (!scope) {
          return text({ status: "FAILED", text: `target must be one of ${tool.scopes.map((entry) => entry.alias).join(", ")}.` });
        }
        const args = targeted ? rest : parameters;
        // A redelivered step regenerates model call ids; the same call id gives the same request id, so the broker's ledger replays it.
        const key = JSON.stringify([catalog.connector, tool.name, scope.alias, callId]);
        // The operation is part of it (every step of a task shares the workspace and conversation, and a model source may repeat call ids across sessions); a redelivered
        // operation keeps its id, so the broker's ledger still replays it. Without one (the orchestrator's own tools) the id is what it always was.
        const hash = createHash("sha256").update(JSON.stringify(context.operationId === undefined ? [context.workspaceId, context.conversationId, key] : [context.workspaceId, context.conversationId, key, context.operationId])).digest("hex");
        const requestId = requestIds.get(key) ?? options.requestId?.()
          ?? `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
        requestIds.set(key, requestId);
        return text(await call({
          workspaceId: context.workspaceId, connector: catalog.connector, requestId,
          scope: scope.alias, tool: tool.upstreamName, schemaHash: scope.schemaHash, arguments: args,
        }, signal));
      },
    });
  }));
}

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} };
}

const CatalogsResponseSchema = z.object({ catalogs: z.array(ConnectorCatalogSchema).max(32) });

/** The longest a broker request may take, whatever the step's own limit is. */
export const BROKER_CATALOGS_TIMEOUT_MS = 30_000;
export const BROKER_CALL_TIMEOUT_MS = 120_000;
/** The most of a tool's answer that is shown to the model. */
export const TOOL_ANSWER_MAX_BYTES = 1_048_576;

interface BrokerInput {
  brokerUrl: string;
  capability: string;
  fetch?: typeof fetch;
  /** Ends every request when the step does (its time limit, a cancellation). */
  signal?: AbortSignal;
}
const urlOf = (brokerUrl: string, path: string): string => `${brokerUrl.replace(/\/$/u, "")}${path}`;
const bounded = (timeoutMs: number, ...signals: Array<AbortSignal | undefined>): AbortSignal =>
  AbortSignal.any([AbortSignal.timeout(timeoutMs), ...signals.filter((signal): signal is AbortSignal => signal !== undefined)]);

/** The broker's reason for a refusal, for the model to read: its own message, bounded, and never the body of anything else. */
async function refusal(response: Response): Promise<Error> {
  const body = await response.json().catch(() => undefined) as { error?: { code?: unknown; message?: unknown } } | undefined;
  const message = typeof body?.error?.message === "string" ? body.error.message.slice(0, 1_000) : `the broker refused the tool call with HTTP ${response.status}`;
  return Object.assign(new Error(message), typeof body?.error?.code === "string" ? { code: body.error.code } : {});
}

/** The body as JSON, read at most TOOL_ANSWER_MAX_BYTES deep: a larger answer is a tool error, never model context. */
async function boundedJson(response: Response): Promise<unknown> {
  const tooLarge = () => new Error("The tool's answer is larger than 1 MiB, so Rovara did not show it. Ask for less, or narrow the request.");
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > TOOL_ANSWER_MAX_BYTES) throw tooLarge();
  if (response.body === null) return undefined;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    // Leaving the loop cancels the stream.
    if (total > TOOL_ANSWER_MAX_BYTES) throw tooLarge();
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

/**
 * The tools this step's agent may call, as the broker presents them (only the granted ones), with the step's capability. A step
 * with no grants gets an empty list from the broker. Anything else, a refusal included, fails the step: a half-known tool list
 * is not one to run on, and a tools-less run would end with a report that looks like a success.
 */
export function agentToolCatalogsSource(input: BrokerInput): () => Promise<ConnectorCatalog[]> {
  const transport = input.fetch ?? fetch;
  return async () => {
    const response = await transport(urlOf(input.brokerUrl, TOOLS_PATH), {
      method: "GET", headers: { [CAPABILITY_HEADER]: input.capability }, signal: bounded(BROKER_CATALOGS_TIMEOUT_MS, input.signal),
    });
    if (response.status === 401 || response.status === 403) {
      throw agentXError("CALLBACK_FORBIDDEN", `the control plane refused this step's tool list (HTTP ${response.status})`);
    }
    if (!response.ok) throw agentXError("RUNTIME_UNAVAILABLE", `agent tools request failed with HTTP ${response.status}`);
    const parsed = CatalogsResponseSchema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) throw agentXError("RUNTIME_UNAVAILABLE", "the broker answered the agent tools request with something unexpected");
    return parsed.data.catalogs;
  };
}

/**
 * A call to the broker's agent-tools route: `ConnectorCallRequest & { connector }` with the step's capability, and nothing else
 * (the workspace id is the capability's). The answer, including a wait for approval, is the broker's to word. The request ends
 * with the step, with the tool call's own signal, and after BROKER_CALL_TIMEOUT_MS.
 */
export function brokerToolCall(input: BrokerInput): ConnectorBridgeCall {
  const transport = input.fetch ?? fetch;
  return async (callInput, signal) => {
    const request: Omit<typeof callInput, "workspaceId"> & { workspaceId?: string } = { ...callInput };
    delete request.workspaceId;
    const response = await transport(urlOf(input.brokerUrl, CALL_PATH), {
      method: "POST",
      headers: { [CAPABILITY_HEADER]: input.capability, "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: bounded(BROKER_CALL_TIMEOUT_MS, input.signal, signal),
    });
    if (!response.ok) throw await refusal(response);
    return boundedJson(response);
  };
}
