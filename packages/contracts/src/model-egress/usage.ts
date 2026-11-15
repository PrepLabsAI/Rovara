// TE-F1a: the token usage a provider reports, read from a whole body and from a stream (SSE events, or a JSON array or JSON lines of events). OpenAI `usage`, Anthropic `usage`, Gemini and Vertex `usageMetadata`, Cohere
// `meta.billed_units` (and v2 `usage.billed_units`). A number is used only when it is a whole non-negative number of a plausible size; anything else is no usage at all, never a guess.
import type { ModelEgressFamily } from "./schemes.js";

export interface ModelEgressUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** Larger than any real request; a bigger reported number is ignored as not credible. */
const MAX_TOKENS = 10_000_000_000;
/** The most text a stream scan keeps unparsed at once. A stream with an unterminated event longer than this reports no usage. */
export const MODEL_USAGE_SCAN_MAX_CHARS = 8 * 1024 * 1024;

type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec | undefined => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Rec) : undefined);
const field = (object: Rec | undefined, key: string): unknown => (object !== undefined && Object.hasOwn(object, key) ? object[key] : undefined);
const sum = (...values: Array<number | undefined>): number | undefined => (values.every((value) => value === undefined) ? undefined : values.reduce<number>((total, value) => total + (value ?? 0), 0));

interface Partial2 {
  input?: number;
  output?: number;
  /** A count was PRESENT but not a whole number of a plausible size (negative, fractional, over 10^10, not a number): the whole report is then not credible and settles as no usage, never as a smaller one. */
  bad?: boolean;
}

/** The usage one parsed JSON value carries, for the family. Fields it does not carry are undefined. */
export function usageFromJson(family: ModelEgressFamily, value: unknown): Partial2 {
  const top = rec(value);
  if (top === undefined) return {};
  let bad = false;
  const count = (held: unknown): number | undefined => {
    if (held === undefined) return undefined;
    if (typeof held === "number" && Number.isSafeInteger(held) && held >= 0 && held <= MAX_TOKENS) return held;
    bad = true;
    return undefined;
  };
  const result = usageOf(family, top, count);
  return bad ? { ...result, bad: true } : result;
}

function usageOf(family: ModelEgressFamily, top: Rec, count: (held: unknown) => number | undefined): Partial2 {
  switch (family) {
    case "openai_compatible": {
      // Chat completions: `usage.prompt_tokens`/`completion_tokens`; Responses and embeddings: `usage.input_tokens`/`output_tokens`; a Responses stream event nests it in `response.usage`.
      const usage = rec(field(top, "usage")) ?? rec(field(rec(field(top, "response")), "usage"));
      const input = count(field(usage, "prompt_tokens")) ?? count(field(usage, "input_tokens"));
      const output = count(field(usage, "completion_tokens")) ?? count(field(usage, "output_tokens"));
      return { ...(input === undefined ? {} : { input }), ...(output === undefined ? {} : { output }) };
    }
    case "anthropic_messages": {
      // `message_start` nests it in `message.usage`; `message_delta` and a whole body carry `usage` (output tokens are cumulative). Cache tokens are input too: counting them can only err high.
      const usage = rec(field(top, "usage")) ?? rec(field(rec(field(top, "message")), "usage"));
      const input = sum(count(field(usage, "input_tokens")), count(field(usage, "cache_creation_input_tokens")), count(field(usage, "cache_read_input_tokens")));
      const output = count(field(usage, "output_tokens"));
      // `count_tokens` answers `{ "input_tokens": n }` at the top.
      const bare = usage === undefined ? count(field(top, "input_tokens")) : undefined;
      const finalInput = input ?? bare;
      return { ...(finalInput === undefined ? {} : { input: finalInput }), ...(output === undefined ? {} : { output }) };
    }
    case "gemini":
    case "vertex": {
      const meta = rec(field(top, "usageMetadata"));
      // Thinking tokens are billed as output; tool-use prompt tokens as input.
      const input = sum(count(field(meta, "promptTokenCount")), count(field(meta, "toolUsePromptTokenCount")));
      const output = sum(count(field(meta, "candidatesTokenCount")), count(field(meta, "thoughtsTokenCount")));
      // `countTokens` answers `{ "totalTokens": n }`.
      const total = meta === undefined ? count(field(top, "totalTokens")) : undefined;
      const finalInput = input ?? total;
      return { ...(finalInput === undefined ? {} : { input: finalInput }), ...(output === undefined ? {} : { output }) };
    }
    case "cohere": {
      const billed =
        rec(field(rec(field(top, "meta")), "billed_units")) ??
        rec(field(rec(field(top, "usage")), "billed_units")) ??
        rec(field(rec(field(rec(field(top, "delta")), "usage")), "billed_units")) ??
        rec(field(rec(field(rec(field(top, "response")), "meta")), "billed_units"));
      const input = count(field(billed, "input_tokens"));
      const output = count(field(billed, "output_tokens"));
      return { ...(input === undefined ? {} : { input }), ...(output === undefined ? {} : { output }) };
    }
    default:
      return {};
  }
}

const complete = (partial: Partial2): ModelEgressUsage | undefined => (partial.bad === true || (partial.input === undefined && partial.output === undefined) ? undefined : { inputTokens: partial.input ?? 0, outputTokens: partial.output ?? 0 });

/** The usage in one whole (non-streamed) JSON body. Undefined when the body is not JSON or reports none. */
export function usageFromBody(family: ModelEgressFamily, body: Uint8Array | string): ModelEgressUsage | undefined {
  try {
    const text = typeof body === "string" ? body : new TextDecoder().decode(body);
    const parsed: unknown = JSON.parse(text);
    // Gemini's non-SSE stream is a JSON array of events: the last one with usage wins.
    const events = Array.isArray(parsed) ? parsed : [parsed];
    const merged: Partial2 = {};
    for (const event of events) Object.assign(merged, definedOnly(usageFromJson(family, event)));
    return complete(merged);
  } catch {
    return undefined;
  }
}

const definedOnly = (partial: Partial2): Partial2 => ({ ...(partial.input === undefined ? {} : { input: partial.input }), ...(partial.output === undefined ? {} : { output: partial.output }), ...(partial.bad === true ? { bad: true } : {}) });

export interface UsageScanner {
  push(chunk: Uint8Array | string): void;
  /** The usage seen so far (the latest value of each count; both Anthropic's cumulative output and Gemini's per-chunk metadata end at the final figure). */
  finish(): ModelEgressUsage | undefined;
}

/**
 * A scanner for a streamed body, in whichever framing it uses: SSE events (`data: {...}` lines, a `[DONE]` sentinel ignored), a JSON array of events, or JSON lines. It keeps only an unfinished tail, never the whole stream. A frame it
 * cannot parse is skipped; the figures it did read stand.
 */
export function createUsageScanner(family: ModelEgressFamily): UsageScanner {
  const decoder = new TextDecoder();
  const seen: Partial2 = {};
  let tail = "";
  let overflow = false;
  /** JSON-array / JSON-lines mode: depth tracking over top-level values. */
  let mode: "unknown" | "sse" | "json" = "unknown";
  let depth = 0;
  let inString = false;
  let escaped = false;
  let objectText = "";

  const take = (event: string): void => {
    try {
      Object.assign(seen, definedOnly(usageFromJson(family, JSON.parse(event) as unknown)));
    } catch {
      /* a frame that is not JSON carries no usage */
    }
  };

  const feedSse = (text: string): void => {
    tail += text;
    // Events end at a blank line; a data line is read as soon as its line ends, so a long idle gap loses nothing.
    const lines = tail.split(/\r\n|\n|\r/u);
    tail = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trimStart();
      if (payload === "" || payload === "[DONE]") continue;
      take(payload);
    }
    if (tail.length > MODEL_USAGE_SCAN_MAX_CHARS) {
      overflow = true;
      tail = "";
    }
  };

  const feedJson = (text: string): void => {
    for (const char of text) {
      if (depth === 0 && !inString && char !== "{") continue; // array brackets, commas and white space between events
      if (inString) {
        objectText += char;
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === "{" || char === "[") depth += 1;
      else if (char === "}" || char === "]") depth -= 1;
      objectText += char;
      if (depth === 0) {
        take(objectText);
        objectText = "";
      } else if (objectText.length > MODEL_USAGE_SCAN_MAX_CHARS) {
        overflow = true;
        objectText = "";
        depth = 0;
        inString = false;
      }
    }
  };

  return {
    push(chunk) {
      if (overflow) return;
      const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      if (mode === "unknown") {
        const first = text.trimStart().charAt(0);
        if (first === "") return;
        mode = first === "[" || first === "{" ? "json" : "sse";
      }
      if (mode === "json") feedJson(text);
      else feedSse(text);
    },
    finish() {
      if (mode === "sse" && !overflow && tail.startsWith("data:")) {
        const payload = tail.slice(5).trimStart();
        if (payload !== "" && payload !== "[DONE]") take(payload);
      }
      return complete(seen);
    },
  };
}
