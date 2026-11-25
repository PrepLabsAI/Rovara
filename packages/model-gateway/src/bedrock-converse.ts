// Rovara's AI on non-Claude Bedrock models (DEC 243c): the agent route speaks Anthropic Messages; these models are called through
// Bedrock's Converse / ConverseStream. This module translates the checked Anthropic request into a Converse body, a Converse answer
// back into an Anthropic message, and ConverseStream's event stream into Anthropic SSE (the meter's UsageCollector reads it as it
// reads Anthropic's). Text and client tools only: images, documents, thinking blocks and server tools are refused (free, before
// any hold). Everything is total over untrusted data; a malformed answer throws (the call is then treated as a broken stream).
// Exception (REASONING_CARRYOVER_MODEL): five reasoning models need their earlier reasoning sent back on a later tool turn. For
// those only, Converse reasoningContent (text, and a signature when there is one) becomes an Anthropic `thinking` block in the
// answer, and a `thinking` block in the history becomes reasoningContent again.
import { record } from "./model-gateway-token.js";
import { EventStreamError, type EventStreamMessage } from "./bedrock-event-stream.js";

/** A non-Claude Bedrock model or system inference profile id (`<provider>.<model>` or `<geo>.<provider>.<model>`). */
export const BEDROCK_CONVERSE_ID = /^(?!global\.)(?!(?:(?:us|eu|apac|jp|au|ca)\.)?anthropic\.)(?:(?:us|eu|apac|jp|au|ca)\.)?[a-z][a-z0-9-]{1,30}\.[a-z0-9][a-z0-9.:-]{0,100}$/u;
/**
 * Amazon Nova Pro writes its reasoning as plain text: the answer starts with "<thinking>...</thinking>". For these models only, exactly
 * that leading, well-formed block (the message's first text block starting with "<thinking>", up to the first "</thinking>") is
 * left out of what the agent gets. Anything else, including a block that never closes, is passed on unchanged.
 */
export const LEADING_THINKING_TEXT_MODEL = /^(?:us\.)?amazon\.nova-pro-v1:0$/u;
/**
 * The reasoning models whose earlier reasoning must be sent back on the next turn of a tool loop (DeepSeek V3.2, Kimi K2 Thinking /
 * K3 / K3.1, MiniMax M2.5; their providers' docs, quoted in Rovara-cloud #70). For these ids only, reasoning is carried both ways
 * as Anthropic `thinking` blocks (unsigned when Bedrock sends no signature); for every other model it is dropped and a `thinking`
 * block in the history is refused. Being here does not list a model: the allow-list (agent-ai.ts) does that, after a real two-turn call.
 */
export const REASONING_CARRYOVER_MODEL = /^(?:us\.)?(?:deepseek\.v3\.2|moonshot\.kimi-k2-thinking|minimax\.minimax-m2\.5|moonshotai\.kimi-k3(?:\.1)?)$/u;
const THINK_OPEN = "<thinking>"; const THINK_CLOSE = "</thinking>";
/** The most text held back while deciding whether a leading thinking block is well formed; past it, the text goes out unchanged. */
export const LEADING_THINKING_MAX_CHARS = 64 * 1024;
/** `text` without its leading, well-formed thinking block, or unchanged. */
export function withoutLeadingThinking(text: string): string {
  if (!text.startsWith(THINK_OPEN)) return text;
  const end = text.indexOf(THINK_CLOSE, THINK_OPEN.length);
  return end < 0 ? text : text.slice(end + THINK_CLOSE.length);
}

/** Sent for a tool result with no output (Converse refuses an empty one). */
export const EMPTY_TOOL_RESULT = "(no output)";
/** What a non-Claude call is held to when the price snapshot names no output limit for the model. */
export const CONVERSE_DEFAULT_MAX_OUTPUT_TOKENS = 4_096;

type Json = Record<string, unknown>;
const text = (v: unknown): v is string => typeof v === "string";

/** A `text` block of whitespace only. */
function isBlankText(value: unknown): boolean {
  const b = record(value);
  return b?.type === "text" && text(b.text) && b.text.trim() === "";
}

/** A `thinking` block with no text beyond whitespace and no signature. */
function isUnsignedBlankThinking(value: unknown): boolean {
  const b = record(value);
  return b?.type === "thinking" && text(b.thinking) && b.thinking.trim() === "" && (b.signature === undefined || b.signature === "");
}

/** One Anthropic content block to Converse. undefined: a block Rovara's AI does not offer for these models. */
function block(value: unknown, role: "user" | "assistant", carryReasoning: boolean): Json | undefined {
  if (text(value)) return { text: value };
  const b = record(value);
  if (b === undefined) return undefined;
  if (b.type === "text" && text(b.text)) return { text: b.text };
  // An earlier answer's reasoning, sent back (REASONING_CARRYOVER_MODEL). An empty signature is no signature (an unsigned block).
  if (carryReasoning && role === "assistant" && b.type === "thinking" && text(b.thinking) && b.thinking.trim() !== "" && (b.signature === undefined || text(b.signature))) {
    return { reasoningContent: { reasoningText: { text: b.thinking, ...(b.signature === undefined || b.signature === "" ? {} : { signature: b.signature }) } } };
  }
  if (role === "assistant" && b.type === "tool_use" && text(b.id) && text(b.name) && record(b.input) !== undefined) return { toolUse: { toolUseId: b.id, name: b.name, input: b.input } };
  if (role === "user" && b.type === "tool_result" && text(b.tool_use_id)) {
    const parts = b.content === undefined ? [] : text(b.content) ? [b.content] : Array.isArray(b.content) ? b.content : undefined;
    if (parts === undefined) return undefined;
    const content: Json[] = [];
    for (const part of parts) {
      const p = text(part) ? part : record(part)?.type === "text" && text(record(part)!.text) ? record(part)!.text as string : undefined;
      if (p === undefined) return undefined;
      // Converse refuses blank text: an empty part is left out.
      if (p !== "") content.push({ text: p });
    }
    // A silent tool (no output): Converse needs at least one non-blank content item in a tool result.
    return { toolResult: { toolUseId: b.tool_use_id, content: content.length === 0 ? [{ text: EMPTY_TOOL_RESULT }] : content, status: b.is_error === true ? "error" : "success" } };
  }
  return undefined;
}

/**
 * The checked Anthropic body (guard.ts) as a Converse request, with `maxTokens` the hold is sized from. undefined: something these
 * models are not offered with (refused before any hold). `thinking`, `output_config`, `metadata` and cache markers are dropped:
 * they shape Claude's answer only.
 */
export function toConverse(body: Json, maxTokens: number, carryReasoning = false): Json | undefined {
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return undefined;
  // Fields that change the answer's meaning and have no Converse form are refused, never dropped: structured output, and
  // "one tool call at a time" (dropping it could let the model make several).
  if (record(body.output_config)?.format !== undefined) return undefined;
  if (record(body.tool_choice)?.disable_parallel_tool_use === true) return undefined;
  const out: Json[] = [];
  for (const m of messages) {
    const message = record(m);
    const role = message?.role;
    if (message === undefined || (role !== "user" && role !== "assistant")) return undefined;
    const blocks = text(message.content) ? [message.content] : Array.isArray(message.content) ? message.content : undefined;
    if (blocks === undefined) return undefined;
    const content: Json[] = [];
    for (const each of blocks) {
      // An empty text block is dropped (Converse refuses blank text); anything else must translate.
      if (record(each)?.type === "text" && record(each)!.text === "") continue;
      // These models can write a whitespace-only text block between their reasoning and a tool call (MiniMax M2.5: "\n\n\n"); Converse refuses blank text, so it is left out of what goes back.
      if (carryReasoning && role === "assistant" && isBlankText(each)) continue;
      // Blank reasoning carries nothing and Converse refuses blank text: left out, unless a signature goes with it (then refused).
      if (carryReasoning && role === "assistant" && isUnsignedBlankThinking(each)) continue;
      const converted = block(each, role, carryReasoning);
      if (converted === undefined) return undefined;
      content.push(converted);
    }
    if (content.length === 0) return undefined;
    out.push({ role, content });
  }
  const system = body.system === undefined ? [] : text(body.system) ? [body.system] : Array.isArray(body.system) ? body.system.map((s) => record(s)?.type === "text" && text(record(s)!.text) ? record(s)!.text : undefined) : [undefined];
  if (system.some((s) => !text(s))) return undefined;
  const inferenceConfig: Json = { maxTokens, ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}) };
  let toolConfig: Json | undefined;
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    const tools: Json[] = [];
    for (const t of body.tools) {
      const tool = record(t);
      if (tool === undefined || !text(tool.name) || record(tool.input_schema) === undefined || (tool.description !== undefined && !text(tool.description)) || tool.strict === true) return undefined;
      tools.push({ toolSpec: { name: tool.name, ...(tool.description === undefined ? {} : { description: tool.description }), inputSchema: { json: tool.input_schema } } });
    }
    const choice = text(body.tool_choice) ? { type: body.tool_choice } : record(body.tool_choice);
    let toolChoice: Json | undefined;
    if (choice === undefined || choice.type === "auto") toolChoice = undefined;
    else if (choice.type === "any" || choice.type === "required") toolChoice = { any: {} };
    else if (choice.type === "tool" && text(choice.name)) toolChoice = { tool: { name: choice.name } };
    else return undefined; // "none" and anything else: not offered.
    toolConfig = { tools, ...(toolChoice === undefined ? {} : { toolChoice }) };
  } else if (body.tool_choice !== undefined && body.tool_choice !== null) return undefined;
  // Converse refuses tool blocks without a tool configuration (a turn that resends tool history with no tools): refused here, free.
  else if (out.some((m) => (m.content as Json[]).some((c) => c.toolUse !== undefined || c.toolResult !== undefined))) return undefined;
  return { messages: out, ...(system.length === 0 ? {} : { system: (system as string[]).map((s) => ({ text: s })) }), inferenceConfig, ...(toolConfig === undefined ? {} : { toolConfig }) };
}

const STOP: Readonly<Record<string, string>> = Object.freeze({ end_turn: "end_turn", tool_use: "tool_use", max_tokens: "max_tokens", stop_sequence: "stop_sequence", model_context_window_exceeded: "model_context_window_exceeded" });
/** Converse's stop reason in Anthropic's words; a filtered or blocked answer is a refusal. */
export function anthropicStop(reason: unknown): string {
  return text(reason) ? STOP[reason] ?? (reason === "content_filtered" || reason === "guardrail_intervened" ? "refusal" : "end_turn") : "end_turn";
}
/** Converse usage in Anthropic's fields. Throws unless input and output are whole numbers (usage then can't be read: full hold). */
export function anthropicUsage(value: unknown): Json {
  const u = record(value);
  const whole = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  if (u === undefined || !whole(u.inputTokens) || !whole(u.outputTokens)) throw new EventStreamError();
  const cacheRead = whole(u.cacheReadInputTokens) ? u.cacheReadInputTokens : 0;
  const cacheWrite = whole(u.cacheWriteInputTokens) ? u.cacheWriteInputTokens : 0;
  return { input_tokens: u.inputTokens, output_tokens: u.outputTokens, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite };
}

/**
 * One Converse reasoning piece as Anthropic's: `text` and `signature` only, each a string when present. Anything else (redacted
 * content, an unknown field, a wrong type) throws: a reasoning block that could not be sent back whole is never passed on in part.
 */
function reasoningPiece(value: unknown): { text?: string; signature?: string } {
  const r = record(value);
  if (r === undefined || Object.keys(r).some((k) => k !== "text" && k !== "signature") || (r.text !== undefined && !text(r.text)) || (r.signature !== undefined && !text(r.signature))) throw new EventStreamError();
  return { ...(r.text === undefined ? {} : { text: r.text }), ...(r.signature === undefined ? {} : { signature: r.signature }) };
}

/** A Converse answer as an Anthropic message. Reasoning blocks are dropped (carried as `thinking` blocks for REASONING_CARRYOVER_MODEL); anything else unknown throws. */
export function fromConverse(answer: unknown, model: string, id: string, stripLeadingThinking = false, carryReasoning = false): Json {
  const a = record(answer);
  const message = record(record(a?.output)?.message);
  if (a === undefined || message === undefined || !Array.isArray(message.content)) throw new EventStreamError();
  const content: Json[] = [];
  let firstText = stripLeadingThinking;
  for (const c of message.content) {
    const b = record(c);
    // A content element that is reasoning and something else at once is not a shape Converse sends; carried reasoning is never dropped beside it.
    if (carryReasoning && b !== undefined && b.reasoningContent !== undefined && Object.keys(b).length !== 1) throw new EventStreamError();
    if (b !== undefined && text(b.text)) {
      const t = firstText ? withoutLeadingThinking(b.text) : b.text; firstText = false;
      if (t !== "" || t === b.text) content.push({ type: "text", text: t });
    } else if (b !== undefined && record(b.toolUse) !== undefined && firstText) { firstText = false; content.push(...toolUse(b)); }
    else if (b !== undefined && record(b.toolUse) !== undefined) content.push(...toolUse(b));
    else if (b !== undefined && b.reasoningContent !== undefined && carryReasoning) {
      const piece = reasoningPiece(record(b.reasoningContent)?.reasoningText);
      if (piece.text === undefined || Object.keys(record(b.reasoningContent)!).length !== 1) throw new EventStreamError();
      content.push({ type: "thinking", thinking: piece.text, signature: piece.signature ?? "" });
    }
    else if (b !== undefined && b.reasoningContent !== undefined) continue;
    else throw new EventStreamError();
  }
  return { id, type: "message", role: "assistant", model, content, stop_reason: anthropicStop(a.stopReason), stop_sequence: null, usage: anthropicUsage(a.usage) };
}

function toolUse(b: Json): Json[] {
  const t = record(b.toolUse)!;
  if (!text(t.toolUseId) || !text(t.name)) throw new EventStreamError();
  return [{ type: "tool_use", id: t.toolUseId, name: t.name, input: record(t.input) ?? {} }];
}

/**
 * ConverseStream events to Anthropic SSE, in order. Converse sends usage last (metadata, after messageStop), so message_start carries
 * zero counts and the final message_delta carries the real ones (the UsageCollector takes both). Converse's block indexes are
 * renumbered from 0 over the blocks passed on (reasoning blocks are dropped, or for REASONING_CARRYOVER_MODEL passed on as `thinking`
 * blocks: thinking_delta for its text, signature_delta for its signature). Every event is re-serialised as one line of JSON.
 */
export class ConverseStreamToSse {
  readonly #model: string; readonly #id: string;
  #started = false; #stopReason: string | undefined; #ended = false;
  // How far the answer got, counted as it is read: before reasoning is dropped or leading text is held back (failed-call.ts).
  #events = 0; #outputBytes = 0;
  /** Whole events read, and bytes of answer content: text, tool name and input, and reasoning (text, signature, redacted data), whether or not it is passed on. */
  progress(): { events: number; outputBytes: number } { return { events: this.#events, outputBytes: this.#outputBytes }; }
  #count(type: unknown, p: Json): void {
    this.#events++;
    const bytes = (v: unknown): number => text(v) ? Buffer.byteLength(v, "utf8") : 0;
    if (type === "contentBlockStart") this.#outputBytes += bytes(record(record(p.start)?.toolUse)?.name);
    else if (type === "contentBlockDelta") {
      const d = record(p.delta);
      const reasoning = record(d?.reasoningContent);
      this.#outputBytes += bytes(d?.text) + bytes(record(d?.toolUse)?.input) + (reasoning === undefined ? 0 : Object.values(reasoning).reduce<number>((n, v) => n + bytes(v), 0));
    }
  }
  readonly #open = new Map<number, number>(); readonly #dropped = new Set<number>(); #next = 0;
  // Carried reasoning: the Converse indexes of the open thinking blocks, and those that have had their signature (nothing follows it).
  readonly #carry: boolean; readonly #thinking = new Set<number>(); readonly #signed = new Set<number>();
  // The leading thinking block (LEADING_THINKING_TEXT_MODEL): "pending" until the first text block decides; its text held meanwhile.
  #strip: "pending" | "done"; #held = ""; #heldIndex: number | undefined; readonly #stripped = new Set<number>();
  constructor(model: string, id: string, stripLeadingThinking = false, carryReasoning = false) { this.#model = model; this.#id = id; this.#strip = stripLeadingThinking ? "pending" : "done"; this.#carry = carryReasoning; }
  /** One reasoning delta (carried): the block opens with its first delta; text and signature only, the signature last. */
  #reasoning(index: number, value: unknown, out: Buffer[]): void {
    const piece = reasoningPiece(value);
    if (this.#open.has(index) && !this.#thinking.has(index)) throw new EventStreamError();
    if (this.#signed.has(index)) throw new EventStreamError();
    if (!this.#open.has(index)) {
      const at = this.#next++; this.#open.set(index, at); this.#thinking.add(index);
      out.push(this.#event("content_block_start", { index: at, content_block: { type: "thinking", thinking: "", signature: "" } }));
    }
    const at = this.#open.get(index)!;
    if (piece.text !== undefined && piece.text !== "") out.push(this.#event("content_block_delta", { index: at, delta: { type: "thinking_delta", thinking: piece.text } }));
    if (piece.signature !== undefined && piece.signature !== "") { this.#signed.add(index); out.push(this.#event("content_block_delta", { index: at, delta: { type: "signature_delta", signature: piece.signature } })); }
  }
  #text(index: number, value: string, out: Buffer[]): void {
    if (value === "" && this.#open.has(index)) return;
    if (!this.#open.has(index)) { const at = this.#next++; this.#open.set(index, at); out.push(this.#event("content_block_start", { index: at, content_block: { type: "text", text: "" } })); }
    if (value !== "") out.push(this.#event("content_block_delta", { index: this.#open.get(index)!, delta: { type: "text_delta", text: value } }));
  }
  /** Ends the decision: what was held goes out as it came (`keep`), or only what follows the closed thinking block. */
  #release(out: Buffer[], keep: string): void {
    const index = this.#heldIndex; this.#strip = "done"; this.#held = ""; this.#heldIndex = undefined;
    if (index === undefined) return;
    if (keep === "") this.#stripped.add(index); else this.#text(index, keep, out);
  }
  #event(type: string, data: Json): Buffer { return Buffer.from(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`, "utf8"); }
  convert(messages: readonly EventStreamMessage[]): Buffer {
    const out: Buffer[] = [];
    for (const message of messages) {
      if (message.headers[":message-type"] !== "event" || this.#ended) throw new EventStreamError();
      let p: Json | undefined;
      try { p = record(JSON.parse(message.payload.toString("utf8")) as unknown); } catch { throw new EventStreamError(); }
      if (p === undefined) throw new EventStreamError();
      this.#count(message.headers[":event-type"], p);
      const index = p.contentBlockIndex;
      const validIndex = typeof index === "number" && Number.isSafeInteger(index) && index >= 0 && index < 1_000;
      switch (message.headers[":event-type"]) {
        case "messageStart":
          if (this.#started) throw new EventStreamError();
          this.#started = true;
          out.push(this.#event("message_start", { message: { id: this.#id, type: "message", role: "assistant", model: this.#model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } }));
          break;
        case "contentBlockStart": {
          const tool = record(record(p.start)?.toolUse);
          if (!this.#started || !validIndex || this.#open.has(index) || tool === undefined || !text(tool.toolUseId) || !text(tool.name)) throw new EventStreamError();
          // Output that is not text first: there is no leading thinking block to look for.
          if (this.#strip === "pending" && this.#heldIndex === undefined) this.#strip = "done";
          const at = this.#next++; this.#open.set(index, at);
          out.push(this.#event("content_block_start", { index: at, content_block: { type: "tool_use", id: tool.toolUseId, name: tool.name, input: {} } }));
          break;
        }
        case "contentBlockDelta": {
          const delta = record(p.delta);
          if (!this.#started || !validIndex || delta === undefined) throw new EventStreamError();
          if (delta.reasoningContent !== undefined && this.#carry) { this.#reasoning(index, delta.reasoningContent, out); break; }
          if (delta.reasoningContent !== undefined) { if (!this.#open.has(index)) this.#dropped.add(index); break; }
          // Text or tool input into a block of reasoning (or into one whose reasoning was dropped) is not a valid stream.
          if (this.#dropped.has(index) || this.#thinking.has(index)) throw new EventStreamError();
          if (text(delta.text)) {
            if (this.#strip === "pending" && (this.#heldIndex === undefined || this.#heldIndex === index) && !this.#open.has(index)) {
              // Hold the first text block's start until it is clear whether it opens with a well-formed thinking block.
              this.#heldIndex = index; this.#held += delta.text;
              const held = this.#held;
              if (held.length <= THINK_OPEN.length ? !THINK_OPEN.startsWith(held) : !held.startsWith(THINK_OPEN)) this.#release(out, held);
              else if (held.length > LEADING_THINKING_MAX_CHARS) this.#release(out, held);
              else if (held.indexOf(THINK_CLOSE, THINK_OPEN.length) >= 0) this.#release(out, withoutLeadingThinking(held));
              break;
            }
            if (this.#stripped.has(index)) { this.#stripped.delete(index); }
            // Converse starts text blocks with their first delta (an empty one included).
            if (!this.#open.has(index)) { const at = this.#next++; this.#open.set(index, at); out.push(this.#event("content_block_start", { index: at, content_block: { type: "text", text: "" } })); }
            out.push(this.#event("content_block_delta", { index: this.#open.get(index)!, delta: { type: "text_delta", text: delta.text } }));
          } else if (text(record(delta.toolUse)?.input) && this.#open.has(index)) {
            out.push(this.#event("content_block_delta", { index: this.#open.get(index)!, delta: { type: "input_json_delta", partial_json: record(delta.toolUse)!.input } }));
          } else throw new EventStreamError();
          break;
        }
        case "contentBlockStop":
          if (!validIndex) throw new EventStreamError();
          if (this.#dropped.delete(index)) break;
          if (this.#thinking.delete(index)) { this.#signed.delete(index); out.push(this.#event("content_block_stop", { index: this.#open.get(index)! })); this.#open.delete(index); break; }
          // The held block ends before its thinking block closed: not well formed, so all of it goes out unchanged.
          if (this.#strip === "pending" && this.#heldIndex === index) this.#release(out, this.#held);
          if (this.#stripped.delete(index)) break;
          if (!this.#open.has(index)) throw new EventStreamError();
          out.push(this.#event("content_block_stop", { index: this.#open.get(index)! })); this.#open.delete(index);
          break;
        case "messageStop":
          if (!this.#started || this.#stopReason !== undefined || this.#strip === "pending" && this.#heldIndex !== undefined) throw new EventStreamError();
          this.#stopReason = anthropicStop(p.stopReason);
          break;
        case "metadata":
          if (this.#stopReason === undefined) throw new EventStreamError();
          out.push(this.#event("message_delta", { delta: { stop_reason: this.#stopReason, stop_sequence: null }, usage: anthropicUsage(p.usage) }));
          out.push(this.#event("message_stop", {}));
          this.#ended = true;
          break;
        default: throw new EventStreamError();
      }
    }
    return Buffer.concat(out);
  }
}
