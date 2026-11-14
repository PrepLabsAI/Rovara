// TE-F1c (M2, release 0.5.19): the helper's side of the bridge socket. The small module the helper loop (TE-F2-B's `model-helper.ts`, not on this base) calls for the modes `real`, `record` and `replay`: it sends ONE frame to
// the worker's bridge over the per-run Unix socket and hands back the events of the answer. It holds no key and no cap, parses nothing a provider sent (the bridge sends checked events), and never retries.
//
// Wire (one request per connection, `connection: close`):
//   request   POST /call, header `x-rovara-mode: real|record|replay`, header `x-rovara-token: <per-exec token>` (real and record only), body = JSON envelope
//             `{ row, method, path, query, headers, bodyB64 }`: the frame, with its body as base64. Every key the caller's frame has is sent: the bridge refuses a key it does not know.
//   response  NDJSON, one event per line: `{t:"head",status,headers}`, `{t:"chunk",b}` (base64), `{t:"settle",...}`, `{t:"scripted"}` (no recording or no changed prompt: answer from the scripted replies), `{t:"not_run",reason,sentence}`,
//             `{t:"cut",why}` (the answer ended early: `time`, `fault`, `response_too_large`, `gone`).
import http from "node:http";
import { StringDecoder } from "node:string_decoder";
import type { ModelEgressEvent, ModelEgressSettle } from "@agentx/contracts";

export type ModelBridgeMode = "real" | "record" | "replay";
export const MODEL_BRIDGE_MODES: readonly ModelBridgeMode[] = ["real", "record", "replay"];
export const MODEL_BRIDGE_CUT_REASONS = ["time", "fault", "response_too_large", "gone"] as const;
export type ModelBridgeCutReason = (typeof MODEL_BRIDGE_CUT_REASONS)[number];

export type ModelBridgeClientEvent =
  | ModelEgressEvent
  | { readonly kind: "scripted" }
  | { readonly kind: "not_run"; readonly reason: string; readonly sentence: string }
  | { readonly kind: "cut"; readonly why: ModelBridgeCutReason };

export interface ModelBridgeCall {
  readonly socketPath: string;
  readonly mode: ModelBridgeMode;
  /** The per-exec token (the `/x/<token>` segment of the sandbox's base URL). Not needed for `replay`. */
  readonly token?: string;
  /** The frame as the helper parsed it: `{ row, method, path, query, headers, body }`. */
  readonly frame: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
  /** Gives up on the whole call after this long. Default 10 minutes (the design's total). */
  readonly timeoutMs?: number;
}

/** A line longer than this is a protocol fault (a 1 MB chunk is 1.4 MB as base64). */
const LINE_MAX = 2 * 1024 * 1024;

export function envelopeOf(frame: Readonly<Record<string, unknown>>): string {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(frame)) {
    if (key === "body") continue;
    Object.defineProperty(out, key, { value: frame[key], enumerable: true, writable: true, configurable: true });
  }
  const body = frame.body;
  if (body instanceof Uint8Array) out.bodyB64 = Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("base64");
  return JSON.stringify(out);
}

function eventOf(line: string): ModelBridgeClientEvent | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const event = parsed as Record<string, unknown>;
  switch (event.t) {
    case "head":
      return typeof event.status === "number" && Array.isArray(event.headers) ? { kind: "head", status: event.status, headers: (event.headers as unknown[]).flatMap((pair) => (Array.isArray(pair) && typeof pair[0] === "string" && typeof pair[1] === "string" ? [[pair[0], pair[1]] as const] : [])) } : undefined;
    case "chunk":
      return typeof event.b === "string" ? { kind: "chunk", bytes: new Uint8Array(Buffer.from(event.b, "base64")) } : undefined;
    case "settle": {
      const { t: _t, ...rest } = event;
      void _t;
      return { kind: "settle", ...(rest as Omit<ModelEgressSettle, "kind">) };
    }
    case "scripted":
      return { kind: "scripted" };
    case "not_run":
      return typeof event.sentence === "string" ? { kind: "not_run", reason: typeof event.reason === "string" ? event.reason : "not_run", sentence: event.sentence } : undefined;
    case "cut":
      return (MODEL_BRIDGE_CUT_REASONS as readonly unknown[]).includes(event.why) ? { kind: "cut", why: event.why as ModelBridgeCutReason } : undefined;
    default:
      return undefined;
  }
}

/** Sends the frame and yields the events. Throws a fixed sentence when the socket cannot be reached or the stream is not the bridge's protocol; it never carries text from the answer. */
export async function* callModelBridge(call: ModelBridgeCall): AsyncGenerator<ModelBridgeClientEvent> {
  const body = envelopeOf(call.frame);
  const timeoutMs = call.timeoutMs ?? 10 * 60 * 1000;
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  call.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(onAbort, timeoutMs);
  try {
    if (call.signal?.aborted === true) throw new Error("the model call was stopped");
    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const request = http.request({
        socketPath: call.socketPath, method: "POST", path: "/call", agent: false, signal: controller.signal,
        headers: { "x-rovara-mode": call.mode, ...(call.token === undefined ? {} : { "x-rovara-token": call.token }), "content-type": "application/json", "content-length": Buffer.byteLength(body), connection: "close" },
      }, resolve);
      request.on("error", () => reject(new Error("the model bridge could not be reached")));
      request.end(body);
    });
    if (response.statusCode !== 200) {
      response.resume();
      throw new Error("the model bridge refused the request");
    }
    let pending = "";
    // A character can be split between two reads: the decoder holds the half until the rest comes.
    const decoder = new StringDecoder("utf8");
    for await (const part of response as AsyncIterable<Buffer>) {
      pending += decoder.write(part);
      for (let at = pending.indexOf("\n"); at >= 0; at = pending.indexOf("\n")) {
        const line = pending.slice(0, at);
        pending = pending.slice(at + 1);
        const event = line.length === 0 ? undefined : eventOf(line);
        if (event === undefined) throw new Error("the model bridge sent something that is not its protocol");
        yield event;
      }
      if (pending.length > LINE_MAX) throw new Error("the model bridge sent something that is not its protocol");
    }
  } catch (error) {
    if (error instanceof Error && /^the model /u.test(error.message)) throw error;
    throw new Error("the model bridge could not be reached", { cause: error });
  } finally {
    clearTimeout(timer);
    call.signal?.removeEventListener("abort", onAbort);
    controller.abort();
  }
}

export interface CollectedBridgeAnswer {
  readonly events: readonly ModelBridgeClientEvent[];
  readonly status: number | undefined;
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly bytes: Uint8Array;
  readonly body: string;
  readonly text: string;
  readonly settle: ModelEgressSettle | undefined;
  readonly scripted: boolean;
  readonly notRun: string | undefined;
  readonly cut: ModelBridgeCutReason | undefined;
}

/** Reads a whole answer (for tests and for callers that do not stream). */
export async function collectModelBridge(call: ModelBridgeCall): Promise<CollectedBridgeAnswer> {
  const events: ModelBridgeClientEvent[] = [];
  for await (const event of callModelBridge(call)) events.push(event);
  const chunks = events.flatMap((event) => (event.kind === "chunk" ? [event.bytes] : []));
  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  const head = events.find((event): event is Extract<ModelEgressEvent, { kind: "head" }> => event.kind === "head");
  const text = new TextDecoder().decode(bytes);
  return {
    events, status: head?.status, headers: head?.headers ?? [], bytes, body: text, text,
    settle: events.find((event): event is ModelEgressSettle => event.kind === "settle"),
    scripted: events.some((event) => event.kind === "scripted"),
    notRun: events.find((event): event is Extract<ModelBridgeClientEvent, { kind: "not_run" }> => event.kind === "not_run")?.sentence,
    cut: events.find((event): event is Extract<ModelBridgeClientEvent, { kind: "cut" }> => event.kind === "cut")?.why,
  };
}
