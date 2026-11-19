// C1 (review): a source's text must not reach the task's event log. The worker sends every session event to the control plane, and the broker keeps the raw
// payload; the transcript stubs (transcript.ts) only cover the session file. So the results of the context tools are replaced by the same stub before an event
// is sent or kept as evidence. The event is copied only where it changes; Rovara's own sentences ("<source> is unavailable") are not a source's text and stay.
import { isContextToolName, stubFor } from "./frame.js";

const MAX_DEPTH = 8;

function textOf(content: unknown): string {
  return Array.isArray(content) ? content.map((block) => (typeof block === "object" && block !== null && typeof (block as { text?: unknown }).text === "string" ? (block as { text: string }).text : "")).join("\n") : "";
}

/** A result's content, stubbed if it holds a source's text; undefined when it holds none. */
function stubbed(content: unknown): unknown[] | undefined {
  const text = textOf(content);
  return text.includes("<source-result ") ? [{ type: "text", text: stubFor(text) }] : undefined;
}

function walk(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH || typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((entry) => { const next = walk(entry, depth + 1); if (next !== entry) changed = true; return next; });
    return changed ? out : value;
  }
  const record = value as Record<string, unknown>;
  // A tool-result message: { role: "toolResult", toolName, content, details }
  if (record.role === "toolResult" && isContextToolName(record.toolName)) {
    const content = stubbed(record.content);
    if (content === undefined) return value;
    const { details: _details, structuredContent: _structured, ...rest } = record;
    void _details; void _structured;
    return { ...rest, content };
  }
  // A tool-execution event: { toolName, result: { content, details } }
  if (isContextToolName(record.toolName) && typeof record.result === "object" && record.result !== null) {
    const result = record.result as Record<string, unknown>;
    const content = stubbed(result.content);
    if (content !== undefined) {
      const { details: _details, structuredContent: _structured, ...inner } = result;
      void _details; void _structured;
      return { ...record, result: { ...inner, content } };
    }
  }
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    const next = walk(entry, depth + 1);
    if (next !== entry) changed = true;
    out[key] = next;
  }
  return changed ? out : value;
}

/** `event` with every context-tool result in it replaced by its stub. The same object comes back when there is nothing to replace. */
export function stubContextEvent<T>(event: T): T {
  return walk(event, 0) as T;
}
