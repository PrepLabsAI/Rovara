// Spec 025 FR-026 to FR-029: registers the tools on an MCP server, checks the API version first,
// and passes every result, every error and every progress message through redaction and a cap,
// since all of it goes into the AI tool's model context.
import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { DEVELOPER_TASK_SUMMARY_MAX, redactSecrets, redactText } from "@agentx/contracts";
import { ADMIN_SIGN_IN_STEP } from "./admin-client.js";
import { ToolError } from "./errors.js";
import { ToolOffer, guardTransport, type AdminOffer } from "./offer.js";
import { RequestIdMemory } from "./request-ids.js";
import { DEVELOPER_TOOLS, type ToolCall, type ToolContext, type ToolDefinition } from "./tools.js";

/** The longest string a result carries: the summary, the longest field AgentX sends. */
const LONGEST_STRING = DEVELOPER_TASK_SUMMARY_MAX;
/** The most items a list carries (the broker's changed-file list is at most 200). */
const MOST_ITEMS = 200;
/** A result's text summary: 50 listed tasks fit. */
const LONGEST_TEXT = 20_000;
const LONGEST_ERROR = 2_000;
const LONGEST_PROGRESS = 300;

/** Redacted first, then cut, so a cut never leaves part of a secret that redaction would miss. */
const safeText = (text: string, limit: number): string => redactText(text).slice(0, limit);

function capped(value: unknown): unknown {
  if (typeof value === "string") return value.slice(0, LONGEST_STRING);
  if (Array.isArray(value)) return value.slice(0, MOST_ITEMS).map(capped);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, capped(child)]));
  return value;
}

/** FR-029: what a successful tool returns, redacted and capped. */
function safeStructured(value: Record<string, unknown>): Record<string, unknown> {
  return capped(redactSecrets(value)) as Record<string, unknown>;
}

const withoutFullStop = (text: string) => text.replace(/\.+$/, "");

/**
 * FR-049 and ruling F3: an error is `isError` with its code, message and next step in the text,
 * and no structuredContent, which SDK clients validate against the tool's output schema.
 */
function errorResult(failure: ToolError) {
  const text = `${failure.code}: ${withoutFullStop(failure.message)}. Next step: ${withoutFullStop(failure.nextStep)}.`;
  return { isError: true, content: [{ type: "text" as const, text: safeText(text, LONGEST_ERROR) }] };
}

export function createAgentXMcpServer(options: {
  version: string;
  context(clientName: string | undefined): ToolContext;
  log?(entry: Record<string, unknown>): void;
  /** Spec 025 A15: registered once, disabled until the offer says the admin sign-in fits. */
  adminTools?: readonly ToolDefinition[];
  /** Spec 025 A15: whether the admin tools are offered; absent, they never are. */
  adminOffer?: () => Promise<AdminOffer>;
  /** How often the offer is checked while connected; 30 seconds by default. */
  recheckMs?: number;
}): McpServer {
  const server = new McpServer({ name: "agentx", version: options.version });
  // One memory per server (one per AI tool session), so a retried call reuses its request ID.
  const requestIds = new RequestIdMemory();
  // Filled below; the offer switches whatever the map holds.
  const adminRegistered = new Map<string, RegisteredTool>();
  const hidden = new ToolError("ADMIN_REQUIRED", "this computer holds no unexpired admin sign-in for AgentX", ADMIN_SIGN_IN_STEP);
  const offer = new ToolOffer({
    tools: adminRegistered,
    read: options.adminOffer ?? (async () => ({ admin: hidden })),
    ...(options.log === undefined ? {} : { log: (entry: Record<string, unknown>) => options.log?.(entry) }),
  });
  const register = (tool: ToolDefinition): RegisteredTool => server.registerTool(tool.name, { title: tool.title, description: tool.description, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema }, async (input: Record<string, unknown>, extra) => {
    try {
      const context = options.context(server.server.getClientVersion()?.name);
      const progressToken = extra._meta?.progressToken;
      const call: ToolCall = {
        signal: extra.signal,
        requestIds,
        ...(options.log === undefined ? {} : { log: (entry: Record<string, unknown>) => options.log?.(entry) }),
        ...(progressToken === undefined ? {} : {
          progress: async (progress: number, total: number | undefined, message: string) => {
            await extra.sendNotification({ method: "notifications/progress", params: { progressToken, progress, ...(total === undefined ? {} : { total }), message: safeText(message, LONGEST_PROGRESS) } });
          },
        }),
      };
      try {
        await context.compatibility();
        const result = await tool.handler(context, input, call);
        return { content: [{ type: "text" as const, text: safeText(result.text, LONGEST_TEXT) }], structuredContent: safeStructured(result.structured) };
      } catch (error) {
        const failure = error instanceof ToolError ? error : new ToolError("CONTROL_PLANE_UNAVAILABLE", "the AgentX MCP server hit an unexpected problem");
        // The code and tool only: never the message, which can quote the developer's text.
        options.log?.({ event: "tool.failed", tool: tool.name, code: failure.code, ...(error instanceof ToolError ? {} : { error: error instanceof Error ? error.name : "unknown" }) });
        return errorResult(failure);
      }
    } finally {
      // A15: a sign-in, or its expiry, shows after any call.
      void offer.refresh();
    }
  });
  for (const tool of DEVELOPER_TOOLS) register(tool);
  // Disabled at once: not connected yet, so nothing is sent.
  for (const tool of options.adminTools ?? []) {
    const registered = register(tool);
    registered.disable();
    adminRegistered.set(tool.name, registered);
  }
  // A15: checked when the client initializes, then on a timer, and after every call (above).
  const initialized = server.server.oninitialized;
  server.server.oninitialized = () => {
    initialized?.();
    void offer.refresh();
    offer.start(options.recheckMs ?? 30_000);
  };
  // The timer ends with the connection, however it ends.
  const closedBefore = server.server.onclose;
  server.server.onclose = () => {
    offer.stop();
    closedBefore?.();
  };
  const closeServer = server.close.bind(server);
  server.close = async () => {
    offer.stop();
    await closeServer();
  };
  // A15: the guard answers a direct call to a hidden admin tool; see offer.ts.
  const connect = server.connect.bind(server);
  server.connect = (transport: Transport) => connect(guardTransport(transport, (name) => offer.refusal(name), errorResult));
  return server;
}
