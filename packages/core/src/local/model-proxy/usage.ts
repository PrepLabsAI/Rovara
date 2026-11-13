// Port lane L9a, K1: reading what a call used from the provider's answer as it passes through, so the Metering port can price it.
//
// Anthropic reports usage in `message_start` (input and cache) and `message_delta` (output so far); OpenAI's chat shape in a last chunk when
// `stream_options.include_usage` is on (the proxy turns it on); OpenAI's responses shape in the `response.completed` event. A non-streamed answer
// carries `usage` at the top. Only numbers are read; nothing of the text is kept.
import type { ProxyApi } from "./types.js";

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const LINE_MAX = 4 * 1_048_576;

const count = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined);
const record = (value: unknown): Record<string, unknown> | undefined => (value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined);

/** The usage one `usage` object states, in Rovara's four counts, or undefined when it states none. Cached tokens are not input tokens twice. */
export function usageOf(api: ProxyApi, value: unknown): Partial<TokenUsage> | undefined {
  const usage = record(value);
  if (usage === undefined) return undefined;
  if (api === "anthropic-messages") {
    const parts: Partial<TokenUsage> = {};
    const input = count(usage.input_tokens), output = count(usage.output_tokens), read = count(usage.cache_read_input_tokens), write = count(usage.cache_creation_input_tokens);
    if (input !== undefined) parts.input = input;
    if (output !== undefined) parts.output = output;
    if (read !== undefined) parts.cacheRead = read;
    if (write !== undefined) parts.cacheWrite = write;
    return Object.keys(parts).length === 0 ? undefined : parts;
  }
  const total = count(usage.prompt_tokens ?? usage.input_tokens);
  const output = count(usage.completion_tokens ?? usage.output_tokens);
  if (total === undefined && output === undefined) return undefined;
  const details = record(usage.prompt_tokens_details ?? usage.input_tokens_details);
  const cached = Math.min(count(details?.cached_tokens) ?? 0, total ?? 0);
  const written = count(details?.cache_write_tokens) ?? 0;
  const parts: Partial<TokenUsage> = { cacheRead: cached, cacheWrite: written };
  if (total !== undefined) parts.input = Math.max(0, total - cached - written);
  if (output !== undefined) parts.output = output;
  return parts;
}

/** The usage an event or a whole answer carries, wherever its shape puts it. */
function usageIn(api: ProxyApi, event: unknown): Partial<TokenUsage> | undefined {
  const top = record(event);
  if (top === undefined) return undefined;
  return usageOf(api, top.usage) ?? usageOf(api, record(top.message)?.usage) ?? usageOf(api, record(top.response)?.usage);
}

/** Collects usage over a whole call: later numbers replace earlier ones field by field (output grows as the answer streams). */
export class UsageCollector {
  readonly #api: ProxyApi;
  #usage: Partial<TokenUsage> | undefined;
  #pending = "";
  #skipping = false;
  readonly #decoder = new TextDecoder("utf-8");

  constructor(api: ProxyApi) {
    this.#api = api;
  }

  /** A streamed answer's next bytes (server-sent events). */
  push(chunk: Uint8Array): void {
    this.#pending += this.#decoder.decode(chunk, { stream: true });
    let newline = this.#pending.indexOf("\n");
    while (newline >= 0) {
      const line = this.#pending.slice(0, newline).replace(/\r$/u, "");
      this.#pending = this.#pending.slice(newline + 1);
      if (this.#skipping) this.#skipping = false;
      else this.#line(line);
      newline = this.#pending.indexOf("\n");
    }
    if (this.#pending.length > LINE_MAX) {
      // One enormous line: not an event worth reading; drop it up to its newline.
      this.#pending = "";
      this.#skipping = true;
    }
  }

  /** A whole non-streamed answer. */
  whole(body: unknown): void {
    this.#merge(usageIn(this.#api, body));
  }

  #line(line: string): void {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (data === "" || data === "[DONE]") return;
    try {
      this.#merge(usageIn(this.#api, JSON.parse(data)));
    } catch {
      // Not JSON: not an event with usage.
    }
  }

  #merge(parts: Partial<TokenUsage> | undefined): void {
    if (parts === undefined) return;
    this.#usage = { ...this.#usage, ...parts };
  }

  /** The usage seen, or undefined when the provider reported none (the call died before it said). */
  finish(): TokenUsage | undefined {
    if (this.#pending !== "" && !this.#skipping) this.#line(this.#pending.replace(/\r$/u, ""));
    this.#pending = "";
    if (this.#usage === undefined) return undefined;
    return { input: this.#usage.input ?? 0, output: this.#usage.output ?? 0, cacheRead: this.#usage.cacheRead ?? 0, cacheWrite: this.#usage.cacheWrite ?? 0 };
  }
}
