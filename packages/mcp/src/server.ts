// Spec 025 FR-026 to FR-029: registers the tools on an MCP server, checks the API version first,
// and passes every result, every error and every progress message through redaction and a cap,
// since all of it goes into the AI tool's model context.
import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ElicitResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { DEVELOPER_TASK_SUMMARY_MAX, redactSecrets, redactText } from "@agentx/contracts";
import { ToolError } from "./errors.js";
import { FIRST_LIST_WAIT_MS, NOT_OFFERED, ToolOffer, guardTransport, type AdminOffer, type AdminToolGroup } from "./offer.js";
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
/** Spec 025 FR-041: the pop-up's message, the change's effect (at most 4,000 characters) and a question. */
const LONGEST_ELICITATION = 4_200;
/** The pop-up asks one yes or no question; no is the default. */
const CONFIRM_SCHEMA = { type: "object" as const, properties: { confirm: { type: "boolean" as const, title: "Apply this change", default: false } }, required: ["confirm"] };

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
  /** Spec 025 FR-051: the client's version too, as it reported it at initialize. */
  context(clientName: string | undefined, clientVersion?: string): ToolContext;
  log?(entry: Record<string, unknown>): void;
  /** Spec 025 A15: registered once, disabled until the offer says the admin sign-in fits. */
  adminTools?: readonly ToolDefinition[];
  /** Spec 025 FR-052: agentx_admin_changes, registered and switched like the admin tools (group audit). */
  auditTools?: readonly ToolDefinition[];
  /** Spec 025 FR-030: the change tools, registered and switched like the admin tools (group changes). */
  changeTools?: readonly ToolDefinition[];
  /**
   * Spec 025 A15, FR-041: whether the admin tools are offered; absent, they never are. It learns
   * whether the client declared form elicitation, so the change tools can need a method it has.
   */
  adminOffer?: (client: { elicitation: boolean }) => Promise<AdminOffer>;
  /** How often the offer is checked while connected; 30 seconds by default. */
  recheckMs?: number;
  /** Issue 203: how long the first tools/list waits for the first offer check; FIRST_LIST_WAIT_MS by default. */
  firstListWaitMs?: number;
}): McpServer {
  // Issue 203: one list_changed per offer change, not one per tool switched (see offer.ts).
  const server = new McpServer({ name: "agentx", version: options.version }, { debouncedNotificationMethods: ["notifications/tools/list_changed"] });
  // One memory per server (one per AI tool session), so a retried call reuses its request ID.
  const requestIds = new RequestIdMemory();
  // Filled below; the offer switches whatever the map holds.
  const adminRegistered = new Map<string, { tool: RegisteredTool; group: AdminToolGroup }>();
  /** FR-041: the pop-up needs a client that declared form elicitation (the same test as `elicit` below). */
  const clientElicits = (): boolean => server.server.getClientCapabilities()?.elicitation?.form !== undefined;
  const readOffer = options.adminOffer;
  const offer = new ToolOffer({
    tools: adminRegistered,
    read: readOffer === undefined ? async () => ({ admin: NOT_OFFERED }) : () => readOffer({ elicitation: clientElicits() }),
    ...(options.log === undefined ? {} : { log: (entry: Record<string, unknown>) => options.log?.(entry) }),
  });
  // Issue #218: an admin tool's result also says when the admin sign-in is about to expire.
  const register = (tool: ToolDefinition, admin = false): RegisteredTool => server.registerTool(tool.name, { title: tool.title, description: tool.description, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema }, async (input: Record<string, unknown>, extra) => {
    try {
      const client = server.server.getClientVersion();
      const context = options.context(client?.name, client?.version);
      const progressToken = extra._meta?.progressToken;
      // Spec 025 FR-041: a pop-up only for a client that declared form elicitation (the SDK reads
      // an older client's empty elicitation object as form). It is sent without a mode, the
      // original shape every form client reads, and tied to this tool call's request.
      const elicit = !clientElicits() ? undefined : async (message: string, timeoutMs: number, signal: AbortSignal) => {
        try {
          const answer = await extra.sendRequest(
            { method: "elicitation/create", params: { message: safeText(message, LONGEST_ELICITATION), requestedSchema: CONFIRM_SCHEMA } },
            ElicitResultSchema,
            { signal, timeout: timeoutMs },
          );
          if (answer.action === "accept") return answer.content?.confirm === true ? "accept" as const : "decline" as const;
          return answer.action;
        } catch (error) {
          // The client's error, its timeout or a cancel: the error's name only, never its words,
          // which can quote the message.
          options.log?.({ event: "elicitation.failed", error: error instanceof Error ? error.name : "unknown" });
          return "failed" as const;
        }
      };
      const call: ToolCall = {
        signal: extra.signal,
        requestIds,
        ...(elicit === undefined ? {} : { elicit }),
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
        const notice = admin ? await context.adminSignInNotice?.() : undefined;
        // First, so the length cap never cuts it off a long result.
        const text = notice === undefined ? result.text : `${notice} ${result.text}`;
        return { content: [{ type: "text" as const, text: safeText(text, LONGEST_TEXT) }], structuredContent: safeStructured(result.structured) };
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
  const groups: Array<[AdminToolGroup, readonly ToolDefinition[]]> = [["admin", options.adminTools ?? []], ["audit", options.auditTools ?? []], ["changes", options.changeTools ?? []]];
  for (const [group, tools] of groups) {
    for (const tool of tools) {
      const registered = register(tool, true);
      registered.disable();
      adminRegistered.set(tool.name, { tool: registered, group });
    }
  }
  // A15: checked when the client initializes, then on a timer, and after every call (above). The
  // first tools/list may have started that check already (issue 203 review); one read serves both.
  const initialized = server.server.oninitialized;
  server.server.oninitialized = () => {
    initialized?.();
    offer.begin();
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
  // A15: the guard answers a direct call to a hidden admin tool; see offer.ts. Issue 203: it also
  // holds the first tools/list until the first offer check answers, at most firstListWaitMs.
  const firstListWaitMs = options.firstListWaitMs ?? FIRST_LIST_WAIT_MS;
  const connect = server.connect.bind(server);
  server.connect = (transport: Transport) => connect(guardTransport(transport, (name) => offer.refusal(name), errorResult, () => offer.ready(firstListWaitMs)));
  return server;
}
