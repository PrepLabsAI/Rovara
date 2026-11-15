// TE-F2 part A: SSE with named events (`event: <name>` then `data: <json>`, a blank line after each), the framing Anthropic, Cohere and OpenAI's Responses API use. F0a's `sseBody` (model-family-common.ts) writes
// `data:` lines only; this is the same idea with the event line. PURE: no Node module, no clock, no randomness.
import type { SseLineEnding } from "./model-family-common.js";

export const NAMED_SSE_PARSE_MAX_CHARS = 8 * 1024 * 1024;

export interface NamedSseEvent {
  /** The event name (no newline). */
  readonly event: string;
  /** The payload: JSON text, which never holds a raw newline. */
  readonly data: string;
}

const EOL: Record<SseLineEnding, string> = { lf: "\n", crlf: "\r\n" };

/** One SSE body: `event: <name>`, `data: <payload>`, then a blank line, for each event. The name and the payload must not hold a newline (JSON text and the fixed event names never do). */
export function sseNamedBody(events: readonly NamedSseEvent[], lineEnding: SseLineEnding): string {
  const eol = EOL[lineEnding];
  return events.map((entry) => `event: ${entry.event}${eol}data: ${entry.data}${eol}${eol}`).join("");
}

export type ParsedNamedSse = { ok: true; events: NamedSseEvent[]; complete: boolean } | { ok: false; reason: "too_large" };

/**
 * The events of a named-SSE text the way a client reads it: events end at a blank line (`\n\n`, `\r\r` or `\r\n\r\n`); `event:` sets the name, `data:` lines are joined with a newline. `complete` is false when the text
 * does not end at a blank line (a cut-off stream). Used by the tests and the helper's own checks; bounded.
 */
export function parseNamedSseText(text: string): ParsedNamedSse {
  if (text.length > NAMED_SSE_PARSE_MAX_CHARS) return { ok: false, reason: "too_large" };
  const events: NamedSseEvent[] = [];
  const blocks = text.split(/\r\n\r\n|\n\n|\r\r/u);
  const complete = /(?:\r\n\r\n|\n\n|\r\r)$/u.test(text);
  blocks.forEach((block, index) => {
    if (block.length === 0) return;
    if (index === blocks.length - 1 && !complete) return;
    let name = "message";
    const data: string[] = [];
    for (const line of block.split(/\r\n|\n|\r/u)) {
      if (line.startsWith("event:")) name = line.slice(6).trimStart();
      else if (line.startsWith("data:")) data.push(line.startsWith("data: ") ? line.slice(6) : line.slice(5));
    }
    if (data.length > 0) events.push({ event: name, data: data.join("\n") });
  });
  return { ok: true, events, complete };
}
