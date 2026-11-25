import { record, whole } from "./model-gateway-token.js";
/**
 * Provider-reported counts. The media fields (Gemini, product route) are PARTS of `input` and `cacheRead`: audio and video
 * prompt tokens priced at their own rates (media-price.ts). Absent = 0; text-only usage never carries them.
 */
export interface TokenUsage { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite5m?: number; cacheWrite1h?: number; audioInput?: number; videoInput?: number; audioCacheRead?: number; videoCacheRead?: number }
export const MEDIA_USAGE_KEYS = ["audioInput", "videoInput", "audioCacheRead", "videoCacheRead"] as const;
export const hasMediaUsage = (u: TokenUsage): boolean => MEDIA_USAGE_KEYS.some((k) => (u[k] ?? 0) > 0);
const MAX_EVENT = 4 * 1024 * 1024;
const MAX_STREAM = 10 * 1024 * 1024;
/** Only counts persist between SSE frames. Invalid/incomplete usage makes the ENTIRE call estimated. */
export class UsageCollector {
  #pending = "";
  #data: string[] = [];
  #eventBytes = 0;
  #total = 0;
  #failed = false;
  #started = false;
  #output = false;
  #stopped = false;
  #usage: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  #actualInput: number | undefined;
  #events = 0; #outputBytes = 0;
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
        // SSE comments, event, id and retry are metadata. Unknown lines are not silently treated as usage.
        else if (!line.startsWith(":") && !/^(event|id|retry):/u.test(line)) this.#failed = true;
      }
      if (this.#pending.length > MAX_EVENT) this.#failed = true;
    } catch { this.#failed = true; }
    if (this.#failed) { this.#pending = ""; this.#data = []; }
  }
  #merge(v: unknown, start: boolean): void {
    const u = record(v); if (u === undefined) { this.#failed = true; return; }
    const fields = [["input_tokens", "input"], ["output_tokens", "output"], ["cache_read_input_tokens", "cacheRead"], ["cache_creation_input_tokens", "cacheWrite"]] as const;
    if ((start && !whole(u.input_tokens)) || (!start && !whole(u.output_tokens))) { this.#failed = true; return; }
    for (const [wire, name] of fields) {
      const n = u[wire]; if (n === undefined) continue;
      if (!whole(n) || n > 1_000_000_000 || (name === "output" && n < this.#usage.output)) { this.#failed = true; return; }
      this.#usage[name] = n;
    }
    const inputTotal = this.#usage.input + this.#usage.cacheRead + this.#usage.cacheWrite;
    if (whole(u.input_tokens) && inputTotal > 0) this.#actualInput = inputTotal;
    if (u.cache_creation !== undefined) {
      const tiers = record(u.cache_creation);
      const five = tiers?.ephemeral_5m_input_tokens;
      const hour = tiers?.ephemeral_1h_input_tokens;
      if (tiers === undefined || Object.keys(tiers).some((k) => !["ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens"].includes(k)) || !whole(five) || !whole(hour) || five + hour !== this.#usage.cacheWrite) { this.#failed = true; return; }
      this.#usage.cacheWrite5m = five; this.#usage.cacheWrite1h = hour;
    } else if (u.cache_creation_input_tokens !== undefined) {
      delete this.#usage.cacheWrite5m; delete this.#usage.cacheWrite1h;
    }
  }
  /** How far the stream got (failed-call.ts): complete events read, and bytes of answer content (text, reasoning, tool name and input). */
  progress(): { events: number; outputBytes: number } { return { events: this.#events, outputBytes: this.#outputBytes }; }
  #content(event: Record<string, unknown>): void {
    const bytes = (v: unknown): number => typeof v === "string" ? Buffer.byteLength(v, "utf8") : 0;
    if (event.type === "content_block_start") { const b = record(event.content_block); this.#outputBytes += Math.max(1, bytes(b?.name) + bytes(b?.text) + bytes(b?.thinking)); }
    else { const d = record(event.delta); this.#outputBytes += Math.max(1, bytes(d?.text) + bytes(d?.partial_json) + bytes(d?.thinking)); }
  }
  /** Start zero can be adapter-synthetic. Only positive provider input evidence survives a cut-off. */
  actualInputTokens(): number | undefined { return this.#failed ? undefined : this.#actualInput; }
  #frame(): void {
    if (this.#data.length === 0) return;
    try {
      const event = record(JSON.parse(this.#data.join("\n")) as unknown);
      if (event === undefined || typeof event.type !== "string" || this.#stopped) this.#failed = true;
      else if (event.type === "content_block_start" || event.type === "content_block_delta") { this.#events++; this.#content(event); }
      else if (event.type === "message_start") { if (this.#started) this.#failed = true; this.#started = true; this.#events++; this.#merge(record(event.message)?.usage, true); }
      else if (event.type === "message_delta") { if (!this.#started) this.#failed = true; this.#output = true; this.#events++; this.#merge(event.usage, false); }
      else if (event.type === "message_stop") this.#stopped = true;
      else if (!["content_block_stop", "ping"].includes(event.type)) this.#failed = true;
      else this.#events++;
    } catch { this.#failed = true; }
    this.#data = [];
  }
  whole(value: unknown): void {
    const usage = record(value)?.usage; this.#merge(usage, true); this.#merge(usage, false); this.#started = true; this.#output = true; this.#stopped = true;
  }
  finish(): TokenUsage | undefined {
    try { this.#pending += this.#decoder.decode(); } catch { this.#failed = true; }
    const complete = !this.#failed && this.#pending.trim() === "" && this.#data.length === 0 && this.#started && this.#output && this.#stopped;
    this.#pending = ""; this.#data = [];
    return complete ? { ...this.#usage } : undefined;
  }
}
