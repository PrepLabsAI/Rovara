// OpenAI Chat Completions for the learning route (DEC 226 follow-up): the company's own OpenAI key, text only. The body guard,
// the usage reader and the transport, in the shape of the Gemini ones (product-gemini.ts): fixed host, TLS, port 443, one attempt,
// no redirects; the key is attached only in the transport, as a bearer token. Learning calls are reflection and judging: plain
// text in, text (or JSON text, or a function call) out. Anything else (images, audio, files, built-in tools, a priority tier,
// several answers) is refused as a whole, so the hold's input bound (bytes) and output bound (one answer, max_completion_tokens)
// both hold, and the price is the model's plain text price.
import https from "node:https";
import type { ClientRequest } from "node:http";
import { record, whole } from "./model-gateway-token.js";
import { MAX_BODY_BYTES, tooLarge, type GuardFailure, type ModelLimitsSource } from "./guard.js";
import { NotSentError, type ProviderTransport } from "./provider.js";
import type { RouteCall, UsageReader } from "./server.js";
import type { TokenUsage } from "./usage.js";

export const OPENAI_HOST = "api.openai.com";
export const OPENAI_UPSTREAM_PATH = "/v1/chat/completions";
/** For a model with no known output limit: the most a request may ask for, and what one that names none is held at. */
export const OPENAI_DEFAULT_MAX_OUTPUT_TOKENS = 32_768;
const bad = (): GuardFailure => ({ ok: false, status: 400, code: "invalid_request", message: "request not allowed" });
const FIELDS = new Set(["model", "messages", "max_tokens", "max_completion_tokens", "temperature", "top_p", "stream", "stream_options", "stop", "response_format", "seed", "frequency_penalty", "presence_penalty", "reasoning_effort", "tools", "tool_choice", "n"]);
const ROLES = new Set(["system", "developer", "user", "assistant", "tool"]);
const MESSAGE_KEYS = new Set(["role", "content", "name", "tool_calls", "tool_call_id"]);
const EFFORTS = new Set(["minimal", "low", "medium", "high"]);
const TOOL_CHOICES = new Set(["auto", "none", "required"]);
const FORMATS = new Set(["text", "json_object", "json_schema"]);

const textContent = (v: unknown): boolean => v === null || typeof v === "string" || (Array.isArray(v) && v.every((part: unknown) => { const p = record(part); return p !== undefined && p.type === "text" && typeof p.text === "string" && Object.keys(p).every((k) => k === "type" || k === "text"); }));
function messageOk(value: unknown): boolean {
  const m = record(value);
  if (m === undefined || !Object.keys(m).every((k) => MESSAGE_KEYS.has(k)) || typeof m.role !== "string" || !ROLES.has(m.role) || !textContent(m.content)) return false;
  if (m.name !== undefined && typeof m.name !== "string") return false;
  if (m.tool_call_id !== undefined && typeof m.tool_call_id !== "string") return false;
  if (m.tool_calls !== undefined && (!Array.isArray(m.tool_calls) || !m.tool_calls.every((call: unknown) => {
    const c = record(call); const f = record(c?.function);
    return c !== undefined && c.type === "function" && typeof c.id === "string" && f !== undefined && typeof f.name === "string" && typeof f.arguments === "string" && Object.keys(c).every((k) => ["id", "type", "function"].includes(k));
  }))) return false;
  return m.content !== null || m.tool_calls !== undefined;
}
const toolOk = (v: unknown): boolean => { const t = record(v); return t !== undefined && t.type === "function" && record(t.function) !== undefined && Object.keys(t).every((k) => k === "type" || k === "function"); };

/** `POST /v1/learning/openai/chat/completions` only; the upstream path is fixed. */
export function guardOpenAi(bytes: Buffer, headers: Readonly<Record<string, string | undefined>>, modelLimits: ModelLimitsSource): RouteCall | GuardFailure {
  if (bytes.length > MAX_BODY_BYTES) return tooLarge();
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(headers["content-type"] ?? "")) return bad();
  if (Object.keys(headers).some((h) => h.startsWith("x-litellm-") || h === "openai-organization" || h === "openai-project" || h === "x-api-key-override")) return bad();
  if (Object.keys(headers).length > 64 || Object.entries(headers).reduce((total, [name, value]) => total + name.length + (value?.length ?? 0), 0) > 16384) return bad();
  let b: Record<string, unknown> | undefined;
  try { b = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown); } catch { return bad(); }
  if (b === undefined || Object.keys(b).some((k) => !FIELDS.has(k))) return bad();
  if (typeof b.model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/u.test(b.model)) return bad();
  if (!Array.isArray(b.messages) || b.messages.length === 0 || !b.messages.every(messageOk)) return bad();
  if (b.n !== undefined && b.n !== 1) return bad();
  for (const k of ["temperature", "top_p", "frequency_penalty", "presence_penalty"]) if (b[k] !== undefined && (typeof b[k] !== "number" || !Number.isFinite(b[k]))) return bad();
  if (b.seed !== undefined && !Number.isSafeInteger(b.seed)) return bad();
  if (b.reasoning_effort !== undefined && (typeof b.reasoning_effort !== "string" || !EFFORTS.has(b.reasoning_effort))) return bad();
  if (b.stop !== undefined && b.stop !== null && !(typeof b.stop === "string" || (Array.isArray(b.stop) && b.stop.length <= 4 && b.stop.every((s: unknown) => typeof s === "string")))) return bad();
  if (b.response_format !== undefined) { const f = record(b.response_format); if (f === undefined || typeof f.type !== "string" || !FORMATS.has(f.type)) return bad(); }
  if (b.tools !== undefined && (!Array.isArray(b.tools) || b.tools.length > 128 || !b.tools.every(toolOk))) return bad();
  const choice = b.tool_choice;
  if (choice !== undefined && !(typeof choice === "string" ? TOOL_CHOICES.has(choice) : record(choice)?.type === "function" && record(record(choice)!.function) !== undefined)) return bad();
  if (b.stream !== undefined && typeof b.stream !== "boolean") return bad();
  const streaming = b.stream === true;
  if (b.stream_options !== undefined) {
    const o = record(b.stream_options);
    if (!streaming || o === undefined || Object.keys(o).some((k) => k !== "include_usage") || (o.include_usage !== undefined && o.include_usage !== true)) return bad();
  }
  // The output ceiling: the model row's own, else the default. Reasoning tokens count inside it, so it bounds the whole answer.
  const asked = [b.max_completion_tokens, b.max_tokens].filter((v) => v !== undefined);
  if (asked.some((v) => !whole(v) || v < 1) || (asked.length === 2 && asked[0] !== asked[1])) return bad();
  let rowMax: unknown;
  try { rowMax = modelLimits.maxOutputTokens("openai", b.model); } catch { rowMax = undefined; }
  const limit = whole(rowMax) && rowMax >= 1 ? rowMax : OPENAI_DEFAULT_MAX_OUTPUT_TOKENS;
  if (typeof asked[0] === "number" && asked[0] > limit) return bad();
  const maxTokens = typeof asked[0] === "number" ? asked[0] : limit;
  const { max_tokens: _legacy, ...rest } = b; void _legacy;
  // Deeply nested tools or schemas can overflow the serializer: refuse as a whole, before any hold.
  let forwarded: Buffer;
  try { forwarded = Buffer.from(JSON.stringify({ ...rest, max_completion_tokens: maxTokens, ...(streaming ? { stream_options: { include_usage: true } } : {}) })); } catch { return bad(); }
  return { ok: true, hasTools: Array.isArray(b.tools), inputBounded: true, model: b.model, maxTokens, streaming, bytes: forwarded, headers: { "content-type": "application/json" }, path: OPENAI_UPSTREAM_PATH };
}

const MAX_EVENT = 4 * 1024 * 1024;
const MAX_STREAM = 10 * 1024 * 1024;
/**
 * Reads `usage` (the last chunk of a stream asked with include_usage, or a whole answer's) and requires the stream to end with
 * `[DONE]`. Counts only, never text. Anything malformed or incomplete makes the whole call fall back to its hold.
 */
export class OpenAiUsageCollector implements UsageReader {
  #pending = ""; #data: string[] = []; #eventBytes = 0; #total = 0;
  #failed = false; #done = false; #usage: TokenUsage | undefined;
  #decoder = new TextDecoder("utf-8", { fatal: true });
  push(bytes: Uint8Array): void {
    if (this.#failed) return;
    this.#total += bytes.length;
    if (this.#total > MAX_STREAM) { this.#failed = true; return; }
    try {
      this.#pending += this.#decoder.decode(bytes, { stream: true });
      let at: number;
      while ((at = this.#pending.indexOf("\n")) >= 0) {
        const line = this.#pending.slice(0, at).replace(/\r$/u, ""); this.#pending = this.#pending.slice(at + 1);
        this.#eventBytes += line.length; if (this.#eventBytes > MAX_EVENT) { this.#failed = true; break; }
        if (line === "") { this.#frame(); this.#eventBytes = 0; }
        else if (line.startsWith("data:")) this.#data.push(line.slice(5).replace(/^ /u, ""));
        else if (!line.startsWith(":") && !/^(event|id|retry):/u.test(line)) this.#failed = true;
      }
      if (this.#pending.length > MAX_EVENT) this.#failed = true;
    } catch { this.#failed = true; }
    if (this.#failed) { this.#pending = ""; this.#data = []; }
  }
  #frame(): void {
    if (this.#data.length === 0) return;
    const text = this.#data.join("\n");
    this.#data = [];
    // Nothing may follow [DONE].
    if (this.#done) { this.#failed = true; return; }
    if (text.trim() === "[DONE]") { this.#done = true; return; }
    try { this.#chunk(JSON.parse(text) as unknown); } catch { this.#failed = true; }
  }
  #chunk(value: unknown): void {
    const r = record(value);
    if (r === undefined || r.error !== undefined) { this.#failed = true; return; }
    if (r.usage !== undefined && r.usage !== null) {
      const usage = openAiUsage(r.usage);
      if (usage === undefined || (this.#usage !== undefined && usage.output < this.#usage.output)) { this.#failed = true; return; }
      this.#usage = usage;
    }
  }
  whole(value: unknown): void { this.#chunk(value); this.#done = true; }
  finish(): TokenUsage | undefined {
    try { this.#pending += this.#decoder.decode(); } catch { this.#failed = true; }
    if (this.#pending.trim() !== "" && this.#data.length === 0 && !this.#failed) { this.#data.push(this.#pending.replace(/^data: ?/u, "")); this.#frame(); }
    const complete = !this.#failed && this.#data.length === 0 && this.#done && this.#usage !== undefined;
    this.#pending = ""; this.#data = [];
    return complete ? { ...this.#usage! } : undefined;
  }
}
/** Cached prompt tokens at the cache-read rate, the rest of the prompt at input, completion (reasoning included) at output. */
export function openAiUsage(value: unknown): TokenUsage | undefined {
  const u = record(value); if (u === undefined) return undefined;
  const prompt = u.prompt_tokens; const completion = u.completion_tokens;
  if (!whole(prompt) || prompt > 1_000_000_000 || !whole(completion) || completion > 1_000_000_000) return undefined;
  let cached = 0;
  if (u.prompt_tokens_details !== undefined) {
    const d = record(u.prompt_tokens_details);
    const c = d?.cached_tokens === undefined ? 0 : d?.cached_tokens;
    if (d === undefined || !whole(c) || c > prompt) return undefined;
    cached = c;
  }
  return { input: prompt - cached, output: completion, cacheRead: cached, cacheWrite: 0 };
}

/** Fixed host, TLS, one attempt, no redirect following. The path comes from guardOpenAi only. */
export function createOpenAiTransport(request: typeof https.request = https.request): ProviderTransport {
  return async (input) => {
    if (input.signal.aborted) throw new NotSentError();
    if (input.path !== OPENAI_UPSTREAM_PATH) throw new NotSentError();
    return new Promise((resolve, reject) => {
      let connected = false;
      const fail = () => reject(connected ? new Error("provider unavailable") : new NotSentError());
      let call: ClientRequest;
      try { call = request({ hostname: OPENAI_HOST, port: 443, path: input.path, method: "POST", agent: false, rejectUnauthorized: true, headers: { ...input.headers, authorization: `Bearer ${input.key}`, "content-length": String(input.body.byteLength) } }, (response) => {
        resolve({ status: response.statusCode ?? 0, body: response as AsyncIterable<Uint8Array>, cancel: () => response.destroy() });
      }); } catch { reject(new NotSentError()); return; }
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
