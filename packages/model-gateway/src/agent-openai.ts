// DEC 254t (a), row A2: the company's own OpenAI key (`openai_key`) or OpenRouter key (`openrouter_key`) as its agents' AI. The agent
// route speaks Anthropic Messages (Code's engine); these providers speak OpenAI Chat Completions. This module:
//   - translates the checked Anthropic request (guard.ts) into a Chat Completions request: system, messages, tools, tool_choice, tool
//     results, max tokens, temperature, stop sequences. Anything with no faithful Chat Completions form (images, documents, thinking,
//     server tools, strict tools, structured output, top_k) is refused as a whole (free, before any hold), never guessed in part;
//   - translates the streamed (or whole) answer back into Anthropic SSE (or an Anthropic message): text, tool_use, the stop reason and
//     usage, cached prompt tokens as cache reads, so the money core's UsageCollector reads it as it reads Anthropic's;
//   - is the transport: fixed host per provider, TLS, port 443, one attempt, no redirect following, the key only as a bearer token here.
// OpenRouter: the request asks for usage accounting (`usage: {include: true}`), so its final usage carries `cost` (USD); that is read
// with parseReportedCost and handed to the money core (ProviderResponse.reportedCostMicros), which applies settleAmount's rules.
// Every converter is total over untrusted data: a malformed or incomplete answer throws (the call is then a broken stream: charged
// at its hold, never a silent partial success).
import { openRouterRequest, type OpenRouterPolicy } from "./openrouter-policy.js";
import { randomUUID } from "node:crypto";
import https from "node:https";
import type { ClientRequest } from "node:http";
import { record, whole } from "./model-gateway-token.js";
import { MAX_RESPONSE_BYTES, NotSentError, type ProviderResponse, type ProviderTransport } from "./provider.js";
import { parseReportedCost, reportedCostFloor } from "./reported-cost.js";

export type OpenAiAgentProvider = "openai" | "openrouter";
/** The Chat Completions dialects: the two fixed providers and a company's own OpenAI-compatible endpoint (A3, endpoint-source.ts). */
export type ChatDialect = OpenAiAgentProvider | "endpoint";
/** Fixed upstreams. Nothing in a request can change the host or the path. */
export const OPENAI_AGENT_UPSTREAM: Readonly<Record<OpenAiAgentProvider, { host: string; path: string }>> = Object.freeze({
  openai: { host: "api.openai.com", path: "/v1/chat/completions" },
  openrouter: { host: "openrouter.ai", path: "/api/v1/chat/completions" },
});
/** For a model with no known output limit: the most a call is held to. */
export const OPENAI_AGENT_DEFAULT_MAX_OUTPUT_TOKENS = 16_384;
/** The model names these sources accept (OpenAI ids; OpenRouter `vendor/model[:variant]`). */
export const OPENAI_AGENT_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;

type Json = Record<string, unknown>;
const text = (v: unknown): v is string => typeof v === "string";

/** Anthropic text parts (a string, or text blocks; cache markers carry no meaning and are dropped). undefined: anything else. */
function textOf(value: unknown): string | undefined {
  if (text(value)) return value;
  if (!Array.isArray(value)) return undefined;
  const parts: string[] = [];
  for (const each of value) {
    const b = record(each);
    if (b === undefined || b.type !== "text" || !text(b.text) || Object.keys(b).some((k) => !["type", "text", "cache_control"].includes(k))) return undefined;
    parts.push(b.text);
  }
  return parts.join("\n\n");
}

/** One Anthropic message to Chat Completions messages (a user turn with tool results becomes the tool messages, then its text). */
function messagesOf(m: Json): Json[] | undefined {
  const role = m.role;
  if (role !== "user" && role !== "assistant") return undefined;
  if (text(m.content)) return [{ role, content: m.content }];
  if (!Array.isArray(m.content) || m.content.length === 0) return undefined;
  const tools: Json[] = []; const texts: string[] = []; const calls: Json[] = [];
  for (const each of m.content) {
    const b = record(each);
    if (b === undefined) return undefined;
    const keys = Object.keys(b);
    if (b.type === "text" && text(b.text) && keys.every((k) => ["type", "text", "cache_control"].includes(k))) { if (b.text !== "") texts.push(b.text); continue; }
    if (role === "assistant" && b.type === "tool_use" && text(b.id) && text(b.name) && record(b.input) !== undefined && keys.every((k) => ["type", "id", "name", "input", "cache_control"].includes(k))) {
      let args: string;
      try { args = JSON.stringify(b.input); } catch { return undefined; }
      calls.push({ id: b.id, type: "function", function: { name: b.name, arguments: args } });
      continue;
    }
    if (role === "user" && b.type === "tool_result" && text(b.tool_use_id) && keys.every((k) => ["type", "tool_use_id", "content", "is_error", "cache_control"].includes(k))) {
      const content = b.content === undefined ? "" : textOf(b.content);
      if (content === undefined || (b.is_error !== undefined && typeof b.is_error !== "boolean")) return undefined;
      // Chat Completions has no error flag on a tool message: the words say it, so the model is told the same thing.
      tools.push({ role: "tool", tool_call_id: b.tool_use_id, content: b.is_error === true ? `Error: ${content}` : content });
      continue;
    }
    // Images, documents, thinking, server tool blocks and anything unknown: no faithful form.
    return undefined;
  }
  if (role === "user") {
    // Tool results answer the previous assistant turn's calls and must come first; any text after them is a user message.
    if (tools.length === 0 && texts.length === 0) return undefined;
    return [...tools, ...(texts.length === 0 ? [] : [{ role: "user", content: texts.join("\n\n") }])];
  }
  if (texts.length === 0 && calls.length === 0) return undefined;
  return [{ role: "assistant", content: texts.length === 0 ? null : texts.join("\n\n"), ...(calls.length === 0 ? {} : { tool_calls: calls }) }];
}

/**
 * The checked Anthropic body as a Chat Completions request for `model`, held to `maxTokens`. undefined: something these sources are
 * not offered with (refused before any hold). `metadata` (a user id for Anthropic's abuse checks) and cache markers are dropped:
 * they carry no meaning for the answer. `thinking` is accepted only as disabled, except on OpenRouter, where an enabled or adaptive request is
 * DROPPED: the translated body is built field by field (so no client thinking or budget_tokens is forwarded), and with a reviewed row
 * openRouterRequest sets the only reasoning field the upstream carries (bounded at the row's max_tokens, or disabled). Pi sends
 * `thinking: {type:"enabled", ...}` for OpenRouter reasoning models and cannot be told to stop.
 */
export function toChatCompletions(body: Json, model: string, maxTokens: number, provider: ChatDialect, policy?: OpenRouterPolicy): Json | undefined {
  if ((provider === "openrouter" && model.includes(":")) || !OPENAI_AGENT_MODEL.test(model) || !whole(maxTokens) || maxTokens < 1) return undefined;
  const allowed = new Set(["model", "messages", "max_tokens", "stream", "system", "temperature", "top_p", "stop_sequences", "metadata", "tools", "tool_choice", "thinking"]);
  if (Object.keys(body).some((k) => !allowed.has(k))) return undefined;
  if (body.thinking !== undefined && record(body.thinking)?.type !== "disabled" && provider !== "openrouter") return undefined;
  if (!Array.isArray(body.messages) || body.messages.length === 0) return undefined;
  const messages: Json[] = [];
  if (body.system !== undefined) {
    const system = textOf(body.system);
    if (system === undefined) return undefined;
    if (system !== "") messages.push({ role: "system", content: system });
  }
  for (const m of body.messages) {
    const message = record(m);
    if (message === undefined || Object.keys(message).some((k) => k !== "role" && k !== "content")) return undefined;
    const converted = messagesOf(message);
    if (converted === undefined) return undefined;
    messages.push(...converted);
  }
  const out: Json = { model, messages, stream: body.stream === true };
  if (provider === "openai") out.max_completion_tokens = maxTokens; else out.max_tokens = maxTokens;
  if (body.temperature !== undefined) { if (typeof body.temperature !== "number" || !Number.isFinite(body.temperature)) return undefined; out.temperature = body.temperature; }
  if (body.top_p !== undefined) { if (typeof body.top_p !== "number" || !Number.isFinite(body.top_p)) return undefined; out.top_p = body.top_p; }
  // Stop sequences are refused (unless empty): Chat Completions answers a matched one as a plain "stop", so the agent could not tell it
  // from a natural end (Anthropic's stop_reason "stop_sequence" with the matched text). Never a quiet partial translation.
  if (body.stop_sequences !== undefined && (!Array.isArray(body.stop_sequences) || body.stop_sequences.length > 0)) return undefined;
  const tools = body.tools;
  if (tools !== undefined && tools !== null) {
    if (!Array.isArray(tools)) return undefined;
    const converted: Json[] = [];
    for (const t of tools) {
      const tool = record(t);
      // Client tools only: a server tool (a `type` other than "custom") or a strict tool has no faithful form here.
      // `eager_input_streaming` (Pi 1.5.2 sends it on every tool) is Anthropic's hint to stream tool arguments early: it changes neither the
      // answer, the token counts nor the price, and Chat Completions has no such field, so it is dropped (only when a boolean; the converted
      // tool below is built field by field, so nothing else can ride along with it).
      if (tool === undefined || !text(tool.name) || record(tool.input_schema) === undefined || (tool.description !== undefined && !text(tool.description)) || tool.strict === true
        || (tool.type !== undefined && tool.type !== null && tool.type !== "custom") || (tool.eager_input_streaming !== undefined && typeof tool.eager_input_streaming !== "boolean")
        || Object.keys(tool).some((k) => !["name", "description", "input_schema", "type", "cache_control", "strict", "eager_input_streaming"].includes(k))) return undefined;
      converted.push({ type: "function", function: { name: tool.name, ...(tool.description === undefined ? {} : { description: tool.description }), parameters: tool.input_schema } });
    }
    if (converted.length > 0) out.tools = converted;
  }
  const choice = text(body.tool_choice) ? { type: body.tool_choice } : body.tool_choice === undefined || body.tool_choice === null ? undefined : record(body.tool_choice);
  if (body.tool_choice !== undefined && body.tool_choice !== null && choice === undefined) return undefined;
  if (choice !== undefined) {
    if (Object.keys(choice).some((k) => !["type", "name", "disable_parallel_tool_use"].includes(k)) || (choice.disable_parallel_tool_use !== undefined && typeof choice.disable_parallel_tool_use !== "boolean")) return undefined;
    if (out.tools === undefined && choice.type !== "none" && choice.type !== "auto") return undefined;
    if (choice.type === "auto") out.tool_choice = "auto";
    else if (choice.type === "any" || choice.type === "required") out.tool_choice = "required";
    else if (choice.type === "none") out.tool_choice = "none";
    else if (choice.type === "tool" && text(choice.name)) out.tool_choice = { type: "function", function: { name: choice.name } };
    else return undefined;
    if (choice.disable_parallel_tool_use === true && out.tools !== undefined) out.parallel_tool_calls = false;
  }
  // Tool history needs the tools it used (the provider refuses a tool message otherwise): refused here, free.
  if (out.tools === undefined && messages.some((m) => m.role === "tool" || m.tool_calls !== undefined)) return undefined;
  if (out.stream === true) out.stream_options = { include_usage: true };
  // OpenRouter's usage accounting: the final usage then carries the call's cost.
  if (provider === "openrouter") { out.usage = { include: true }; if (policy !== undefined) return openRouterRequest(out, policy); }
  return out;
}

const STOP: Readonly<Record<string, string>> = Object.freeze({ stop: "end_turn", tool_calls: "tool_use", function_call: "tool_use", length: "max_tokens", content_filter: "refusal" });
/** Chat Completions' finish reason in Anthropic's words. Unknown: throws (never a guessed stop). */
export function anthropicStopOf(reason: unknown): string {
  if (!text(reason) || !Object.hasOwn(STOP, reason)) throw new Error("unreadable answer");
  return STOP[reason]!;
}

/** Chat Completions usage in Anthropic's fields: cached prompt tokens as cache reads, the rest as input; reasoning inside output. */
/**
 * OpenRouter reports a cache WRITE either as prompt_tokens_details.cache_write_tokens or as a cost part named for it. A no-write route (an absent write price)
 * stops and settles safely on EITHER, so a cost part for a write with no token count is still a write. Any cache-write / cache-creation key in usage.cost_details,
 * or a top-level usage key of that name, whose value is not exactly zero (a positive number, or anything unreadable) counts.
 */
export function cacheWriteCostReported(value: unknown): boolean {
  const u = record(value);
  if (u === undefined) return false;
  const named = (k: string) => /cache[_-]?(write|creat)/iu.test(k);
  const nonzero = (v: unknown) => !(v === 0 || v === "0" || v === null || v === undefined);
  const details = record(u.cost_details);
  return Object.entries(u).some(([k, v]) => named(k) && typeof v !== "object" && nonzero(v)) || (details !== undefined && Object.entries(details).some(([k, v]) => named(k) && nonzero(v)));
}
export function anthropicUsageOf(value: unknown, provider?: ChatDialect): Json {
  const u = record(value);
  if (u === undefined || !whole(u.prompt_tokens) || !whole(u.completion_tokens) || u.prompt_tokens > 1_000_000_000 || u.completion_tokens > 1_000_000_000) throw new Error("unreadable answer");
  let cached = 0; let written = 0;
  const details = u.prompt_tokens_details;
  if (details !== undefined && details !== null) {
    const d = record(details);
    const c = d?.cached_tokens ?? 0;
    if (d === undefined || !whole(c) || c > u.prompt_tokens) throw new Error("unreadable answer");
    const w = d.cache_write_tokens ?? 0;
    if (!whole(w) || w > u.prompt_tokens - c) throw new Error("unreadable answer");
    cached = c; written = w;
  }
  // A write cost with no write token count: one marker token, taken from the input count (the money is in usage.cost; the marker only makes the write visible).
  if (provider === "openrouter" && written === 0 && cacheWriteCostReported(u)) written = 1;
  return { input_tokens: Math.max(0, u.prompt_tokens - cached - written), output_tokens: u.completion_tokens, cache_read_input_tokens: cached, cache_creation_input_tokens: written };
}

const event = (type: string, data: Json): Buffer => Buffer.from(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`, "utf8");
const MAX_EVENT = 4 * 1024 * 1024;
const MAX_TOOL_CALLS = 128;
/**
 * The most upstream bytes one streamed answer may carry, output or not (comments, `usage: null` chunks and empty deltas make no output,
 * so the money core's MAX_RESPONSE_BYTES on the translated output does not bound them). Twice that limit.
 */
export const MAX_UPSTREAM_STREAM_BYTES = 2 * MAX_RESPONSE_BYTES;

/**
 * Chat Completions SSE to Anthropic SSE. message_start carries zero counts; the final message_delta carries the real ones (from the
 * usage chunk asked for with include_usage), then message_stop, once `[DONE]` arrives. Text and each tool call are Anthropic blocks in
 * order (a new kind or a new tool index closes the open block). Reasoning fields some models send are dropped. `reportedCost` holds
 * OpenRouter's `usage.cost` in micro-dollars, read with parseReportedCost.
 */
export class ChatStreamToSse {
  readonly #provider: ChatDialect; readonly #model: string; readonly #id: string;
  #pending = ""; #data: string[] = []; #eventBytes = 0; #upstreamBytes = 0;
  #started = false; #done = false; #finish: string | undefined; #finishRepeated = false; #usage: Json | undefined; #cost: number | undefined; #costComplete = false; #costRegressed = false; #costLast = false;
  #open: { kind: "text" } | { kind: "tool"; index: number } | undefined; #next = 0;
  readonly #tools = new Map<number, number>();
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  constructor(provider: ChatDialect, model: string, id: string) { this.#provider = provider; this.#model = model; this.#id = id; }
  get reportedCost(): number | undefined { return this.#cost; }
  get reportedCostComplete(): boolean { return this.#costComplete; }
  /** The complete cost arrived at or after the finish reason and no answer followed it: the whole call's money, usable for a stream that broke afterwards. */
  get reportedCostFinal(): boolean { return this.#costComplete && this.#costLast; }
  push(bytes: Uint8Array): Buffer {
    const out: Buffer[] = [];
    this.#upstreamBytes += bytes.byteLength;
    if (this.#upstreamBytes > MAX_UPSTREAM_STREAM_BYTES) throw new Error("unreadable answer");
    this.#pending += this.#decoder.decode(bytes, { stream: true });
    let at: number;
    while ((at = this.#pending.indexOf("\n")) >= 0) {
      const line = this.#pending.slice(0, at).replace(/\r$/u, ""); this.#pending = this.#pending.slice(at + 1);
      this.#eventBytes += line.length;
      if (this.#eventBytes > MAX_EVENT) throw new Error("unreadable answer");
      if (line === "") { this.#frame(out); this.#eventBytes = 0; }
      else if (line.startsWith("data:")) this.#data.push(line.slice(5).replace(/^ /u, ""));
      // OpenRouter sends ": OPENROUTER PROCESSING" comments while it waits; other SSE metadata is ignored; anything else is broken.
      else if (!line.startsWith(":") && !/^(event|id|retry):/u.test(line)) throw new Error("unreadable answer");
    }
    if (this.#pending.length > MAX_EVENT) throw new Error("unreadable answer");
    return Buffer.concat(out);
  }
  /** The end of the upstream body: the stream must have ended with [DONE] after a finish reason and usage. */
  finish(): Buffer {
    this.#pending += this.#decoder.decode();
    const out: Buffer[] = [];
    if (this.#pending.trim() !== "") { if (this.#pending.startsWith("data:")) this.#data.push(this.#pending.slice(5).replace(/^ /u, "")); else throw new Error("unreadable answer"); }
    this.#pending = "";
    this.#frame(out);
    if (!this.#done) throw new Error("unreadable answer");
    return Buffer.concat(out);
  }
  #start(out: Buffer[]): void {
    if (this.#started) return;
    this.#started = true;
    out.push(event("message_start", { message: { id: this.#id, type: "message", role: "assistant", model: this.#model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } }));
  }
  #close(out: Buffer[]): void {
    if (this.#open === undefined) return;
    out.push(event("content_block_stop", { index: this.#next - 1 }));
    this.#open = undefined;
  }
  #frame(out: Buffer[]): void {
    if (this.#data.length === 0) return;
    const data = this.#data.join("\n"); this.#data = [];
    if (this.#done) throw new Error("unreadable answer");
    if (data.trim() === "[DONE]") { this.#end(out); return; }
    let chunk: Json | undefined;
    try { chunk = record(JSON.parse(data) as unknown); } catch { throw new Error("unreadable answer"); }
    if (chunk === undefined || chunk.error !== undefined) throw new Error("unreadable answer");
    this.#start(out);
    const withUsage = chunk.usage !== undefined && chunk.usage !== null;
    // A cost read before the answer ended (a partial, cumulative figure) is not the call's money: only a cost at or after the finish reason, with nothing after it.
    if (withUsage) this.#costLast = this.#finish !== undefined;
    if (withUsage) {
      if (this.#provider === "openrouter") {
        const complete = parseReportedCost("openrouter", chunk.usage);
        const amount = complete ?? reportedCostFloor(chunk.usage);
        if (this.#cost !== undefined && (amount === undefined || amount < this.#cost)) this.#costRegressed = true;
        if (amount !== undefined) this.#cost = Math.max(this.#cost ?? 0, amount);
        this.#costComplete = complete !== undefined && !this.#costRegressed;
      }
      const usage = anthropicUsageOf(chunk.usage, this.#provider);
      if (this.#provider === "openrouter") {
        // A later zero/omission cannot erase a write already reported on this call.
        const written = Math.max(Number(this.#usage?.cache_creation_input_tokens ?? 0), Number(usage.cache_creation_input_tokens));
        usage.input_tokens = Math.max(0, Number(usage.input_tokens) + Number(usage.cache_creation_input_tokens) - written);
        usage.cache_creation_input_tokens = written;
      }
      this.#usage = usage;
    }
    const choices = chunk.choices;
    if (choices === undefined || choices === null) return;
    const outBefore = out.length; const finishBefore = this.#finish;
    try { this.#choices(chunk, choices, out); } finally {
      // The last answer chunk may carry the finish reason and the usage together: that cost covers it.
      if (withUsage && finishBefore === undefined && this.#finish !== undefined) this.#costLast = true;
      // Answer output on any other chunk after the cost (more text or tool input, even on a chunk that then breaks) makes that cost partial.
      else if (out.length > outBefore) this.#costLast = false;
    }
  }
  #choices(chunk: Json, choices: unknown, out: Buffer[]): void {
    if (!Array.isArray(choices) || choices.length > 1) throw new Error("unreadable answer");
    const choice = record(choices[0]);
    if (choices.length === 0) return;
    if (choice === undefined || (choice.index !== undefined && choice.index !== 0)) throw new Error("unreadable answer");
    const delta = choice.delta === undefined || choice.delta === null ? {} : record(choice.delta);
    if (delta === undefined) throw new Error("unreadable answer");
    if (delta.content !== undefined && delta.content !== null) {
      if (!text(delta.content)) throw new Error("unreadable answer");
      if (delta.content !== "") {
        if (this.#open?.kind !== "text") { this.#close(out); this.#open = { kind: "text" }; out.push(event("content_block_start", { index: this.#next++, content_block: { type: "text", text: "" } })); }
        out.push(event("content_block_delta", { index: this.#next - 1, delta: { type: "text_delta", text: delta.content } }));
      }
    }
    // A refusal (OpenAI's own field) is text the model wrote: passed on as text, never dropped.
    if (delta.refusal !== undefined && delta.refusal !== null) {
      if (!text(delta.refusal)) throw new Error("unreadable answer");
      if (delta.refusal !== "") {
        if (this.#open?.kind !== "text") { this.#close(out); this.#open = { kind: "text" }; out.push(event("content_block_start", { index: this.#next++, content_block: { type: "text", text: "" } })); }
        out.push(event("content_block_delta", { index: this.#next - 1, delta: { type: "text_delta", text: delta.refusal } }));
      }
    }
    if (delta.tool_calls !== undefined && delta.tool_calls !== null) {
      if (!Array.isArray(delta.tool_calls)) throw new Error("unreadable answer");
      for (const each of delta.tool_calls) {
        const call = record(each); const fn = record(call?.function);
        const index = call?.index;
        if (call === undefined || !whole(index) || index >= MAX_TOOL_CALLS || (call.function !== undefined && fn === undefined)) throw new Error("unreadable answer");
        if (!this.#tools.has(index)) {
          // A new call: it must name itself before any arguments.
          if (!text(call.id) || call.id === "" || !text(fn?.name) || fn.name === "") throw new Error("unreadable answer");
          this.#close(out);
          this.#tools.set(index, this.#next); this.#open = { kind: "tool", index };
          out.push(event("content_block_start", { index: this.#next++, content_block: { type: "tool_use", id: call.id, name: fn.name, input: {} } }));
        } else if (this.#open?.kind !== "tool" || this.#open.index !== index) throw new Error("unreadable answer");
        const args = fn?.arguments;
        if (args !== undefined && args !== null) {
          if (!text(args)) throw new Error("unreadable answer");
          if (args !== "") out.push(event("content_block_delta", { index: this.#tools.get(index)!, delta: { type: "input_json_delta", partial_json: args } }));
        }
      }
    }
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      const stop = anthropicStopOf(choice.finish_reason);
      if (this.#finish === undefined) this.#finish = stop;
      // OpenRouter repeats the finish reason on its final usage chunk (one choice with a content-free delta): accounting, not a second end.
      // Only the SAME reason, on a chunk that carries usage, with no content, refusal or tool call in its delta; anything else is still broken.
      // The repeat is allowed ONCE.
      else if (this.#finishRepeated || stop !== this.#finish || chunk.usage === undefined || chunk.usage === null
        || (delta.content !== undefined && delta.content !== null && delta.content !== "")
        || (delta.refusal !== undefined && delta.refusal !== null && delta.refusal !== "")
        || (delta.tool_calls !== undefined && delta.tool_calls !== null && (!Array.isArray(delta.tool_calls) || delta.tool_calls.length > 0))) throw new Error("unreadable answer");
      else this.#finishRepeated = true;
    }
  }
  #end(out: Buffer[]): void {
    if (!this.#started || this.#finish === undefined || this.#usage === undefined) throw new Error("unreadable answer");
    this.#close(out);
    out.push(event("message_delta", { delta: { stop_reason: this.#finish, stop_sequence: null }, usage: this.#usage }));
    out.push(event("message_stop", {}));
    this.#done = true;
  }
}

/** A whole Chat Completions answer as an Anthropic message (and OpenRouter's reported cost). Anything unreadable throws. */
export function fromChatCompletion(answer: unknown, provider: ChatDialect, model: string, id: string): { message: Json; reportedCost?: number } {
  const a = record(answer);
  if (a === undefined || a.error !== undefined || !Array.isArray(a.choices) || a.choices.length !== 1) throw new Error("unreadable answer");
  const choice = record(a.choices[0]);
  const message = record(choice?.message);
  if (choice === undefined || message === undefined) throw new Error("unreadable answer");
  const content: Json[] = [];
  for (const piece of [message.content, message.refusal]) {
    if (piece === undefined || piece === null) continue;
    if (!text(piece)) throw new Error("unreadable answer");
    if (piece !== "") content.push({ type: "text", text: piece });
  }
  if (message.tool_calls !== undefined && message.tool_calls !== null) {
    if (!Array.isArray(message.tool_calls) || message.tool_calls.length > MAX_TOOL_CALLS) throw new Error("unreadable answer");
    for (const each of message.tool_calls) {
      const call = record(each); const fn = record(call?.function);
      if (call === undefined || !text(call.id) || fn === undefined || !text(fn.name) || !text(fn.arguments)) throw new Error("unreadable answer");
      let input: unknown;
      try { input = fn.arguments === "" ? {} : JSON.parse(fn.arguments) as unknown; } catch { throw new Error("unreadable answer"); }
      if (record(input) === undefined) throw new Error("unreadable answer");
      content.push({ type: "tool_use", id: call.id, name: fn.name, input });
    }
  }
  const usage = anthropicUsageOf(a.usage, provider);
  const cost = provider === "openrouter" ? (parseReportedCost("openrouter", a.usage) ?? reportedCostFloor(a.usage)) : undefined;
  return { message: { id, type: "message", role: "assistant", model, content, stop_reason: anthropicStopOf(choice.finish_reason), stop_sequence: null, usage }, ...(cost === undefined ? {} : { reportedCost: cost }) };
}

/** A 2xx Chat Completions answer as the agent route reads it: Anthropic SSE (streamed) or an Anthropic message (whole), and the reported cost. */
export function translatedAnswer(provider: ChatDialect, facts: { model: string; streaming: boolean }, status: number, raw: AsyncIterable<Uint8Array>, cancel: () => void): ProviderResponse {
  const id = `msg_${randomUUID().replaceAll("-", "")}`;
  if (facts.streaming) {
    const converter = new ChatStreamToSse(provider, facts.model, id);
    return {
      status, cancel, reportedCostMicros: () => converter.reportedCost, reportedCostComplete: () => converter.reportedCostComplete, reportedCostFinal: () => converter.reportedCostFinal,
      body: (async function* () {
        for await (const chunk of raw) { const out = converter.push(chunk); if (out.length > 0) yield out; }
        const last = converter.finish(); if (last.length > 0) yield last;
      })(),
    };
  }
  let cost: number | undefined; let costComplete = false;
  return {
    status, cancel, reportedCostMicros: () => cost, reportedCostComplete: () => costComplete, reportedCostFinal: () => costComplete,
    body: (async function* () {
      const parts: Buffer[] = []; let size = 0;
      for await (const chunk of raw) { size += chunk.byteLength; if (size > MAX_WHOLE_ANSWER) throw new Error("unreadable answer"); parts.push(Buffer.from(chunk)); }
      let parsed: unknown;
      try { parsed = JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown; } catch { throw new Error("unreadable answer"); }
      if (provider === "openrouter") {
        const complete = parseReportedCost("openrouter", record(parsed)?.usage);
        cost = complete ?? reportedCostFloor(record(parsed)?.usage); costComplete = complete !== undefined;
      }
      const whole = fromChatCompletion(parsed, provider, facts.model, id);
      yield Buffer.from(JSON.stringify(whole.message));
    })(),
  };
}

/** The model a Chat Completions body names, and whether it streams (the body is the guard's own output). */
export function bodyFacts(body: Uint8Array): { model: string; streaming: boolean } {
  const parsed = record(JSON.parse(Buffer.from(body).toString("utf8")) as unknown);
  if (parsed === undefined || !text(parsed.model)) throw new NotSentError();
  return { model: parsed.model, streaming: parsed.stream === true };
}

const MAX_WHOLE_ANSWER = 10 * 1024 * 1024;

/**
 * The Chat Completions transport for `provider`: fixed host and path, TLS, one attempt, no redirect following; the key as a bearer
 * token. A 2xx answer is translated (streamed: ChatStreamToSse; whole: fromChatCompletion); any other status passes through for the
 * route's providerFailure (its body is read only to classify, never echoed). The response's reportedCostMicros is OpenRouter's cost.
 */
export function createChatCompletionsTransport(provider: OpenAiAgentProvider, request: typeof https.request = https.request): ProviderTransport {
  const upstream = OPENAI_AGENT_UPSTREAM[provider];
  return async (input) => {
    if (input.signal.aborted) throw new NotSentError();
    if (input.path !== upstream.path) throw new NotSentError();
    let facts: { model: string; streaming: boolean };
    try { facts = bodyFacts(input.body); } catch { throw new NotSentError(); }
    return new Promise((resolve, reject) => {
      let connected = false;
      const fail = () => reject(connected ? new Error("provider unavailable") : new NotSentError());
      let call: ClientRequest;
      try {
        call = request({ hostname: upstream.host, port: 443, path: upstream.path, method: "POST", agent: false, rejectUnauthorized: true, headers: { "content-type": "application/json", authorization: `Bearer ${input.key}`, "content-length": String(input.body.byteLength) } }, (response) => {
          const status = response.statusCode ?? 0;
          const cancel = () => response.destroy();
          const raw = response as AsyncIterable<Uint8Array>;
          if (status < 200 || status >= 300) { resolve({ status, body: raw, cancel }); return; }
          resolve(translatedAnswer(provider, facts, status, raw, cancel));
        });
      } catch { reject(new NotSentError()); return; }
      const abort = () => { call.destroy(); fail(); };
      call.once("socket", (socket) => socket.once("secureConnect", () => { connected = true; }));
      call.once("error", fail);
      call.once("close", () => input.signal.removeEventListener("abort", abort));
      input.signal.addEventListener("abort", abort, { once: true });
      if (input.signal.aborted) abort();
      else { try { call.end(input.body); } catch { call.destroy(); fail(); } }
    });
  };
}
