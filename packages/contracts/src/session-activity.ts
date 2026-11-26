// #1548: what a person watching a running task sees (`rovara session watch` in the terminal, the session page on the web). The worker saves the agent's session events as they
// happen (pi's own events, each the payload of a `progress`, `tool_start` or `tool_end` event) and Rovara's own (`progress` notes, `lifecycle`, `error`). This module is the page the
// broker answers with, and the one function both clients use to turn the saved events into a list of items, so the terminal and the web show the same thing.
// It imports nothing but zod, so the web app can use it. It never throws on an event it does not know or one the worker cut to size: such an event is skipped, or shown with what it still has.
import { z } from "zod";

/** The most events one page of activity holds. */
export const SESSION_ACTIVITY_PAGE_MAX = 200;
/** The most steps (worker operations) a task's activity lists. */
export const SESSION_ACTIVITY_OPERATIONS_MAX = 200;
/** The longest text an item keeps (a message, a tool's arguments or result). A client may show less. */
export const SESSION_ACTIVITY_TEXT_MAX = 4_000;

/** One step of the task: one worker operation, in the order the task ran them. */
export const SessionActivityOperationSchema = z.object({
  operationId: z.string().min(1).max(128),
  /** What the step was (the operation's kind), and the workflow step it ran when it has one. */
  kind: z.string().min(1).max(64),
  step: z.string().min(1).max(128).optional(),
  status: z.string().min(1).max(32),
  createdAt: z.string().min(1).max(40),
}).strict();
export type SessionActivityOperation = z.infer<typeof SessionActivityOperationSchema>;

/** One saved event, as the worker sent it. `sequence` counts from 1 within its operation. */
export const SessionActivityEventSchema = z.object({
  operationId: z.string().min(1).max(128),
  sequence: z.number().int().min(1),
  type: z.string().min(1).max(32),
  timestamp: z.string().min(1).max(40),
  payload: z.unknown(),
}).strict();
export type SessionActivityEvent = z.infer<typeof SessionActivityEventSchema>;

/**
 * A page of a task's activity (`GET /v1/app/sessions/<id>/activity?after=<cursor>`): every step so far, the events after the cursor, oldest first, and the cursor to ask from next.
 * `active` is whether more may come (a step is running or the session has not ended): a client stops asking when it is false.
 */
export const SessionActivityPageSchema = z.object({
  operations: z.array(SessionActivityOperationSchema).max(SESSION_ACTIVITY_OPERATIONS_MAX),
  events: z.array(SessionActivityEventSchema).max(SESSION_ACTIVITY_PAGE_MAX),
  cursor: z.string().min(1).max(256).optional(),
  active: z.boolean(),
}).strict();
export type SessionActivityPage = z.infer<typeof SessionActivityPageSchema>;

interface ItemBase { operationId: string; sequence: number; at: string }
/** One thing to show. `step` starts each operation; `tool` is one call, from its start to its end. */
export type SessionActivityItem =
  | ItemBase & { kind: "step"; label: string; status?: string }
  | ItemBase & { kind: "message"; role: "assistant" | "user"; text: string; thinking?: string; model?: string }
  | ItemBase & { kind: "tool"; toolCallId: string; name: string; args: string; status: "running" | "done" | "failed"; result?: string; durationMs?: number }
  | ItemBase & { kind: "note" | "retry" | "compaction" | "error" | "status"; text: string };
type Draft = SessionActivityItem extends infer Item ? Item extends unknown ? Omit<Item, keyof ItemBase> : never : never;

type Fields = Record<string, unknown>;
const record = (value: unknown): Fields | undefined => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Fields) : undefined);
const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value : undefined);

/** `value` cut to `max` characters, ending in an ellipsis when it was cut. */
export function clipActivityText(value: string, max: number = SESSION_ACTIVITY_TEXT_MAX): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

/** The text blocks of a message's or a tool result's content (a string, or a list of blocks), joined. */
function blocksOf(content: unknown, type: "text" | "thinking"): string | undefined {
  if (typeof content === "string") return type === "text" ? text(content) : undefined;
  if (!Array.isArray(content)) return undefined;
  const parts = content.map(record).filter((block): block is Fields => block?.["type"] === type).map((block) => block[type]).filter((part): part is string => typeof part === "string" && part.trim() !== "");
  return parts.length === 0 ? undefined : parts.join("\n");
}

function json(value: unknown): string {
  try { return JSON.stringify(value) ?? ""; } catch { return ""; }
}

/** A message the agent wrote or was given. Tool results are left out: the tool's own item shows them. A message with nothing to read (only tool calls) is left out too. */
function messageItem(payload: Fields): Draft | undefined {
  const message = record(payload["message"]);
  const role = message?.["role"];
  if (message === undefined || (role !== "assistant" && role !== "user")) return undefined;
  const said = blocksOf(message["content"], "text");
  const thinking = role === "assistant" ? blocksOf(message["content"], "thinking") : undefined;
  if (said === undefined && thinking === undefined) return undefined;
  const model = text(message["model"]);
  return { kind: "message", role, text: clipActivityText(said ?? ""), ...(thinking === undefined ? {} : { thinking: clipActivityText(thinking) }), ...(model === undefined ? {} : { model }) };
}

function toolStart(payload: Fields): Draft | undefined {
  const toolCallId = text(payload["toolCallId"]);
  if (toolCallId === undefined) return undefined;
  return { kind: "tool", toolCallId, name: text(payload["toolName"]) ?? "tool", args: clipActivityText(json(payload["args"])), status: "running" };
}

function toolResultText(result: unknown): string | undefined {
  const content = blocksOf(record(result)?.["content"], "text");
  if (content !== undefined) return clipActivityText(content);
  const raw = typeof result === "string" ? result : result === undefined ? "" : json(result);
  return raw === "" ? undefined : clipActivityText(raw);
}

function retryItem(payload: Fields): Draft {
  const attempt = typeof payload["attempt"] === "number" ? payload["attempt"] : undefined;
  const of = typeof payload["maxAttempts"] === "number" ? ` of ${payload["maxAttempts"]}` : "";
  const why = text(payload["errorMessage"]);
  return { kind: "retry", text: `The model call failed; retrying${attempt === undefined ? "" : ` (attempt ${attempt}${of})`}${why === undefined ? "" : `: ${clipActivityText(why, 300)}`}` };
}

/** pi's events that become an item of their own. Every other pi event (turns, message starts, queue changes...) adds nothing a person needs. */
const PI_EVENTS: Record<string, (payload: Fields) => Draft | undefined> = {
  message_end: messageItem,
  tool_execution_start: toolStart,
  auto_retry_start: retryItem,
  auto_retry_end: (payload) => (payload["success"] === false ? { kind: "error", text: "The model call kept failing; the retries ran out." } : undefined),
  compaction_start: (payload) => ({ kind: "compaction", text: `Compacting the conversation${text(payload["reason"]) === undefined ? "" : ` (${String(payload["reason"])})`}.` }),
};

/** Rovara's own events (no pi event in the payload). `usage` and `result` are bookkeeping and add nothing. */
function rovaraItem(type: string, payload: Fields | undefined): Draft | undefined {
  const message = text(payload?.["message"]);
  if (type === "progress" && message !== undefined) return { kind: "note", text: clipActivityText(message) };
  if (type === "error") return { kind: "error", text: clipActivityText(message ?? "The step failed.") };
  const status = text(payload?.["status"]);
  if (type === "lifecycle" && status !== undefined) return { kind: "status", text: `Step ${status.toLowerCase()}.` };
  return undefined;
}

function stepItem(operation: SessionActivityOperation | undefined, event: SessionActivityEvent): SessionActivityItem {
  const label = operation === undefined ? "Step" : operation.step ?? operation.kind;
  return { kind: "step", operationId: event.operationId, sequence: 0, at: operation?.createdAt ?? event.timestamp, label, ...(operation === undefined ? {} : { status: operation.status }) };
}

/** A tool's end, written onto its start's item. An end whose start is not in the list (cut, or before the page) makes an item of its own. */
function endTool(items: SessionActivityItem[], open: Map<string, number>, event: SessionActivityEvent, payload: Fields): void {
  const toolCallId = text(payload["toolCallId"]) ?? "";
  const ended = { status: payload["isError"] === true ? "failed" as const : "done" as const, ...optional("result", toolResultText(payload["result"])), ...optional("durationMs", typeof payload["durationMs"] === "number" ? payload["durationMs"] : undefined) };
  const index = open.get(`${event.operationId}\u0000${toolCallId}`);
  const started = index === undefined ? undefined : items[index];
  if (index !== undefined && started?.kind === "tool") {
    items[index] = { ...started, ...ended };
    return;
  }
  items.push({ kind: "tool", operationId: event.operationId, sequence: event.sequence, at: event.timestamp, toolCallId, name: text(payload["toolName"]) ?? "tool", args: "", ...ended });
}

function optional<Key extends string, Value>(key: Key, value: Value | undefined): { [K in Key]?: Value } {
  return (value === undefined ? {} : { [key]: value }) as { [K in Key]?: Value };
}

/**
 * The items to show for a task's events so far, oldest first. Each operation starts with a `step` item (its label from `operations`, when it is listed). A client that polls keeps every
 * event it has read and calls this again with all of them: the items are rebuilt, so a tool that has since ended shows as ended.
 */
export function sessionActivityView(events: readonly SessionActivityEvent[], operations: readonly SessionActivityOperation[] = []): SessionActivityItem[] {
  const byId = new Map(operations.map((operation) => [operation.operationId, operation]));
  const items: SessionActivityItem[] = [];
  const open = new Map<string, number>();
  let current: string | undefined;
  for (const event of events) {
    if (event.operationId !== current) {
      current = event.operationId;
      items.push(stepItem(byId.get(current), event));
    }
    const payload = record(event.payload);
    const piType = typeof payload?.["type"] === "string" ? payload["type"] : undefined;
    if (piType === "tool_execution_end" && payload !== undefined) {
      endTool(items, open, event, payload);
      continue;
    }
    const draft = piType !== undefined && payload !== undefined ? PI_EVENTS[piType]?.(payload) : rovaraItem(event.type, payload);
    if (draft === undefined) continue;
    if (draft.kind === "tool") open.set(`${event.operationId}\u0000${draft.toolCallId}`, items.length);
    items.push({ ...draft, operationId: event.operationId, sequence: event.sequence, at: event.timestamp });
  }
  return items;
}
