// TE-F11: bounded, non-streaming readers. No provider payload or parser error leaves the checker.
import type { ModelReplyResponse } from "./model-reply-set.js";
export const REPLY_CHECK_MAX_BYTES = 1024 * 1024;
export const REPLY_CHECK_MAX_DEPTH = 16;
export type ReplyCheckObject = Record<string, unknown>;
export const objectOf = (value: unknown): ReplyCheckObject | undefined => typeof value === "object" && value !== null && !Array.isArray(value) ? value as ReplyCheckObject : undefined;

/** Depth and node limits apply to every field, including fields we do not use. Never assigns unknown keys. */
export function boundedJson(text: string): { value: unknown } | undefined {
  try {
    if (typeof text !== "string" || text.length > REPLY_CHECK_MAX_BYTES || new TextEncoder().encode(text).byteLength > REPLY_CHECK_MAX_BYTES) return undefined;
    const value: unknown = JSON.parse(text);
    let nodes = 0;
    const safe = (v: unknown, depth: number): boolean => {
      if (++nodes > 100_000 || depth > REPLY_CHECK_MAX_DEPTH) return false;
      if (typeof v === "number") return Number.isFinite(v);
      if (v === null || typeof v !== "object") return true;
      return Object.entries(v).every(([key, item]) => key !== "__proto__" && safe(item, depth + 1));
    };
    return safe(value, 0) ? { value } : undefined;
  } catch { return undefined; }
}

export interface CheckedAnswer {
  text: string;
  toolCalls: { name: string; args: ReplyCheckObject; argsSkeleton: string }[];
  finish: ModelReplyResponse["finish"];
}
/** Canonical key/type skeleton; only intermediate data, never copied into a report. Array element types form a set. */
export function argsSkeleton(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${[...new Set(value.map(argsSkeleton))].sort().join(",")}]`;
  if (typeof value !== "object") return typeof value;
  return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${argsSkeleton(v)}`).join(",")}}`;
}
const tool = (name: unknown, args: unknown): CheckedAnswer["toolCalls"][number] | undefined => {
  const record = objectOf(args);
  return typeof name === "string" && name.length > 0 && name.length <= 128 && record !== undefined ? { name, args: record, argsSkeleton: argsSkeleton(record) } : undefined;
};
const finishOf = (raw: unknown, hasTools: boolean): CheckedAnswer["finish"] | undefined => {
  if (typeof raw !== "string" || raw.length > 64) return undefined;
  if (["length", "max_tokens", "MAX_TOKENS"].includes(raw)) return "length";
  if (["content_filter", "refusal", "safety", "SAFETY", "RECITATION", "ERROR_TOXIC"].includes(raw)) return "safety";
  if (["tool_calls", "tool_use", "TOOL_CALL"].includes(raw)) return "tool_calls";
  if (["stop", "end_turn", "stop_sequence", "STOP", "COMPLETE"].includes(raw)) return hasTools ? "tool_calls" : "stop";
  return "other";
};

export function supportedReplyCheckOperation(wire: string, operation: string, path: string): boolean {
  return (wire === "openai" && operation === "chat_completions") || (wire === "anthropic" && operation === "messages") || (wire === "gemini" && operation === "generateContent") || (wire === "cohere" && operation === "chat" && path === "/v2/chat");
}

/** Other operations (Responses, embeddings, token counting, rerank, Cohere v1, Bedrock) are deferred. */
export function readReplyCheckAnswer(wire: string, text: string): CheckedAnswer | undefined {
  try {
    const root = objectOf(boundedJson(text)?.value);
    if (root === undefined) return undefined;
    const calls: CheckedAnswer["toolCalls"] = [];
    const texts: string[] = [];
    let rawFinish: unknown;
    let valid = true;
    const add = (name: unknown, args: unknown): void => { const found = tool(name, args); if (found === undefined || calls.length >= 32) valid = false; else calls.push(found); };
    if (wire === "openai") {
      if (!Array.isArray(root.choices) || root.choices.length !== 1) return undefined;
      const choice = objectOf(root.choices[0]); const message = objectOf(choice?.message);
      if (message === undefined) return undefined;
      rawFinish = choice?.finish_reason;
      if (typeof message.content === "string") texts.push(message.content);
      else if (message.content !== null && message.content !== undefined) return undefined;
      if (message.tool_calls !== undefined) {
        if (!Array.isArray(message.tool_calls)) return undefined;
        for (const entry of message.tool_calls) { const fn = objectOf(objectOf(entry)?.function); add(fn?.name, typeof fn?.arguments === "string" ? boundedJson(fn.arguments)?.value : undefined); }
      }
      if (message.content === undefined && calls.length === 0) return undefined;
    } else if (wire === "anthropic" || wire === "cohere") {
      const message = wire === "anthropic" ? root : objectOf(root.message);
      if (message === undefined) return undefined;
      rawFinish = wire === "anthropic" ? root.stop_reason : root.finish_reason;
      if (message.content !== undefined && !Array.isArray(message.content)) return undefined;
      for (const entry of Array.isArray(message.content) ? message.content : []) {
        const part = objectOf(entry);
        if (part?.type === "text" && typeof part.text === "string") texts.push(part.text);
        else if (wire === "anthropic" && part?.type === "tool_use") add(part.name, part.input);
        else return undefined;
      }
      if (wire === "cohere" && message.tool_calls !== undefined) {
        if (!Array.isArray(message.tool_calls)) return undefined;
        for (const entry of message.tool_calls) { const fn = objectOf(objectOf(entry)?.function); add(fn?.name, typeof fn?.arguments === "string" ? boundedJson(fn.arguments)?.value : fn?.arguments); }
      }
      if (!Array.isArray(message.content) && calls.length === 0) return undefined;
    } else if (wire === "gemini") {
      if (!Array.isArray(root.candidates) || root.candidates.length !== 1) return undefined;
      const candidate = objectOf(root.candidates[0]); const content = objectOf(candidate?.content);
      if (!Array.isArray(content?.parts)) return undefined;
      rawFinish = candidate?.finishReason;
      for (const entry of content.parts) {
        const part = objectOf(entry); const fn = objectOf(part?.functionCall);
        if (typeof part?.text === "string") texts.push(part.text);
        else if (fn !== undefined) add(fn.name, fn.args);
        else return undefined;
      }
    } else return undefined;
    const joined = texts.join("");
    // JSON inside a text block is still untrusted JSON. Unsafe objects must not become plain-text matches.
    try {
      const embedded: unknown = JSON.parse(joined);
      if (objectOf(embedded) !== undefined && boundedJson(joined) === undefined) return undefined;
    } catch { /* Ordinary non-JSON prose has no declared object shape. */ }
    const finish = finishOf(rawFinish, calls.length > 0);
    return valid && finish !== undefined ? { text: joined, toolCalls: calls, finish } : undefined;
  } catch { return undefined; }
}
