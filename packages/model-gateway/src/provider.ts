import https from "node:https";
import type { ClientRequest } from "node:http";
import type { TaskClaims } from "./model-gateway-token.js";
export const CALL_HARD_CEILING_MS = 60 * 60_000;
export const CALL_STARTUP_ALLOWANCE_MS = 60_000;
export const CONSERVATIVE_OUTPUT_TOKENS_PER_SECOND = 10;
export function callDurationMs(maxOutputTokens: number): number {
  return Math.min(CALL_HARD_CEILING_MS, CALL_STARTUP_ALLOWANCE_MS + Math.ceil(maxOutputTokens / CONSERVATIVE_OUTPUT_TOKENS_PER_SECOND) * 1000);
}
export const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
export class NotSentError extends Error { constructor() { super("provider unavailable"); this.name = "NotSentError"; } }
/** The provider's 2xx head arrived and the answer then broke before its first event: it accepted the request, so it may have billed the input (failed-call.ts). */
export class AnswerBrokeError extends Error { constructor() { super("provider unavailable"); this.name = "AnswerBrokeError"; } }
export interface ProviderKeys { keyFor(claims: TaskClaims, provider: "anthropic", signal?: AbortSignal): Promise<string> }
export interface ProviderRequest { body: Uint8Array; headers: Readonly<Record<string, string>>; key: string; signal: AbortSignal; /** Set by routes whose upstream path depends on the checked request (the product route). */ path?: string }
export interface ProviderResponse {
  status: number; body: AsyncIterable<Uint8Array>; cancel?: () => void;
  /** The provider's own reported cost of a completed call in micro-dollars (OpenRouter's usage.cost, agent-openai.ts), read after the body ends. settleAmount decides whether it is used. Absent: none. */
  reportedCostMicros?: () => number | undefined;
  /** Internal transport provenance: false means money is only a known floor; retain max(hold, floor) provisionally. */
  reportedCostComplete?: () => boolean;
  /** The complete cost arrived at or after the answer's end with no answer after it (agent-openai.ts): a stream that broke afterwards may settle at it. Absent: false. */
  reportedCostFinal?: () => boolean;
  /** How far the answer got, counted where it is read (before anything is dropped or held back): whole stream events, and bytes of answer content including reasoning (failed-call.ts). */
  progress?: () => { events: number; outputBytes: number };
}
/** An injected transport must stop on signal or cancel. A generic throw means possibly sent and is charged in full. */
export type ProviderTransport = (request: ProviderRequest) => Promise<ProviderResponse>;
/** Fixed endpoint, TLS, one attempt, no redirect following. Credentials are attached only here. */
export function createAnthropicTransport(request: typeof https.request = https.request): ProviderTransport {
  return async (input) => {
    if (input.signal.aborted) throw new NotSentError();
    return new Promise<ProviderResponse>((resolve, reject) => {
      let connected = false;
      const fail = () => reject(connected ? new Error("provider unavailable") : new NotSentError());
      let call: ClientRequest;
      try { call = request({ hostname: "api.anthropic.com", port: 443, path: "/v1/messages", method: "POST", agent: false, rejectUnauthorized: true, headers: { ...input.headers, "x-api-key": input.key, "content-length": String(input.body.byteLength) } }, (response) => {
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
/** Error words are fixed at the HTTP boundary; this helper is also usable by later diagnostics. */
export function scrubProviderText(text: string, secret: string): string {
  let clean = text.slice(0, 16384).replaceAll(/\p{Cc}+/gu, " ");
  if (secret.length >= 6) clean = clean.split(secret).join("[secret]");
  if (secret.length >= 16) {
    const ends = [secret.slice(0, 8), secret.slice(-8)];
    clean = clean.split(/(\s+)/u).map((w) => ends.some((end) => w.includes(end)) ? "[secret]" : w).join("");
  }
  return clean.replaceAll(/\b(?:sk|rk|pk|key|rvm)[-_][A-Za-z0-9_-]{6,}/gu, "[secret]").replaceAll(/\bBearer\s+\S+/giu, "Bearer [secret]").trim().slice(0, 300);
}
/** One call-local scanner. Withholds the longest needle's suffix, so split credentials cannot escape. */
export class SecretScanner {
  readonly #needles: Buffer[];
  readonly #keep: number;
  readonly #windows = new Set<string>();
  #pending = Buffer.alloc(0);
  #hit = false;
  constructor(secrets: readonly string[]) {
    this.#needles = [...new Set(secrets.flatMap((s) => [s, encodeURIComponent(s), JSON.stringify(s).slice(1, -1), Buffer.from(s).toString("base64")]))].filter((s) => s.length >= 6).map((s) => Buffer.from(s));
    for (const secret of secrets) {
      // JWT metadata (including the header and claims) is not distinctive secret material.
      const parts = secret.split(".");
      const material = parts.length === 3 ? parts[2]! : secret.replace(/^(?:sk-ant-(?:api\d+-)?|(?:sk|rk|pk|key|rvm)[-_](?:proj-)?)/u, "");
      const bytes = Buffer.from(material).toString("latin1");
      for (let i = 0; i + 24 <= bytes.length; i++) this.#windows.add(bytes.slice(i, i + 24));
    }
    this.#keep = Math.max(0, ...this.#needles.map((s) => s.length - 1));
  }
  push(bytes: Uint8Array): { bytes: Buffer; hit: boolean } {
    if (this.#hit) return { bytes: Buffer.alloc(0), hit: true };
    const all = Buffer.concat([this.#pending, bytes]);
    let at = -1;
    for (const needle of this.#needles) { const found = all.indexOf(needle); if (found >= 0 && (at < 0 || found < at)) at = found; }
    // Constant-sized window lookups: no secret-window × response-byte nested scan.
    const text = all.toString("latin1");
    for (let i = 0; i + 24 <= text.length && (at < 0 || i < at); i++) {
      if (this.#windows.has(text.slice(i, i + 24))) { at = i; break; }
    }
    if (at >= 0) { this.#hit = true; this.#pending = Buffer.alloc(0); return { bytes: all.subarray(0, at), hit: true }; }
    const end = Math.max(0, all.length - this.#keep);
    this.#pending = Buffer.from(all.subarray(end)); return { bytes: all.subarray(0, end), hit: false };
  }
  finish(): Buffer { const last = this.#pending; this.#pending = Buffer.alloc(0); return last; }
}
