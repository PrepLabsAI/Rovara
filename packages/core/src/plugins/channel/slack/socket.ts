// The socket connection to the chat tool (its "socket mode"): the tool pushes what happens to a connection Rovara opens, so a laptop needs no public address. Every envelope is acknowledged at once (the tool sends it
// again when it is not), then handed to the handler one at a time. A lost connection is opened again after a growing wait; a request to disconnect (the tool does this every few hours) opens a new one at once.
// Nothing here logs a token, an address or what was said: only fixed words and counts.
import type { SlackWeb } from "./web.js";

/** The part of a web socket this uses, so a test can stand in for the network. */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}
export type SocketFactory = (url: string) => SocketLike;

export interface SocketOptions {
  web: Pick<SlackWeb, "openConnection">;
  /** Sets up a socket for an address; default: the runtime's own `WebSocket`. */
  connect?: SocketFactory;
  /**
   * What an envelope is answered with besides its acknowledgement, decided at once (the tool waits for it): the box that asks what should change shows an error when nothing was typed. Absent, or nothing returned: a plain
   * acknowledgement. A throw is a plain acknowledgement too.
   */
  answer?: (envelope: { type: string; payload: unknown }) => unknown;
  /** Handles one envelope's payload after it was acknowledged. A throw is logged by name and the next envelope is read. */
  handle: (envelope: { type: string; payload: unknown }) => Promise<void>;
  log?: (entry: Record<string, unknown>) => void;
  /** Waits; a test replaces it. */
  sleep?: (ms: number) => Promise<void>;
}

const FRAME_MAX_BYTES = 512 * 1024;
/** The most envelopes waiting for the handler: a busy channel cannot grow the queue (and the memory behind it) without end; an envelope past it is acknowledged and dropped with a log line. */
export const SOCKET_QUEUE_MAX = 100;
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

export const runtimeSocket: SocketFactory = (url) => new (globalThis as unknown as { WebSocket: new (url: string) => SocketLike }).WebSocket(url);

export interface SocketRun { stop(): Promise<void> }

export function startSocket(options: SocketOptions): SocketRun {
  const log = options.log ?? (() => undefined);
  const connect = options.connect ?? runtimeSocket;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref(); }));
  let stopped = false;
  let current: SocketLike | undefined;
  let finished: () => void = () => undefined;
  let queue: Promise<void> = Promise.resolve();
  let waiting = 0;
  let wake: () => void = () => undefined;

  /** One connection, from opening to its end. Resolves true when it reached `hello`, so the wait before the next try starts over. */
  async function session(): Promise<boolean> {
    const url = await options.web.openConnection();
    return new Promise<boolean>((resolve) => {
      let hello = false;
      const socket = connect(url);
      current = socket;
      const end = (): void => { if (current === socket) current = undefined; finished = () => undefined; resolve(hello); };
      finished = end;
      socket.onerror = () => { log({ event: "slack.socket_error" }); };
      socket.onclose = end;
      socket.onmessage = (frame) => {
        if (typeof frame.data !== "string" || frame.data.length > FRAME_MAX_BYTES) return;
        let envelope: { type?: unknown; envelope_id?: unknown; payload?: unknown };
        try { envelope = JSON.parse(frame.data) as typeof envelope; } catch { return; }
        if (typeof envelope.type !== "string") return;
        if (envelope.type === "hello") { hello = true; return; }
        if (envelope.type === "disconnect") { try { socket.close(); } catch { /* already closed */ } return; }
        // Acknowledged before anything is done with it.
        if (typeof envelope.envelope_id === "string" && envelope.envelope_id.length <= 128) {
          let reply: unknown;
          try { reply = options.answer?.({ type: envelope.type, payload: envelope.payload }); } catch { reply = undefined; }
          try { socket.send(JSON.stringify(reply === undefined ? { envelope_id: envelope.envelope_id } : { envelope_id: envelope.envelope_id, payload: reply })); } catch { log({ event: "slack.ack_failed" }); }
        }
        const type = envelope.type, payload = envelope.payload;
        if (waiting >= SOCKET_QUEUE_MAX) { log({ event: "slack.queue_full" }); return; }
        waiting += 1;
        queue = queue.then(() => options.handle({ type, payload })).catch((error: unknown) => { log({ event: "slack.handler_failed", errorName: error instanceof Error ? error.name : "unknown" }); }).finally(() => { waiting -= 1; });
      };
    });
  }

  const loop = (async () => {
    let failures = 0;
    while (!stopped) {
      let connected = false;
      try {
        connected = await session();
      } catch (error) {
        log({ event: "slack.connect_failed", errorName: error instanceof Error ? error.name : "unknown", code: (error as { code?: unknown } | null)?.code });
      }
      if (stopped) break;
      failures = connected ? 0 : failures + 1;
      // A connection that was good and ended (the tool asked, or the network dropped) is opened again at once; one that never got going waits a growing time.
      if (!connected) await Promise.race([sleep(BACKOFF_MS[Math.min(failures - 1, BACKOFF_MS.length - 1)]!), new Promise<void>((resolve) => { wake = resolve; })]);
    }
  })();

  return {
    async stop() {
      stopped = true;
      const open = current;
      current = undefined;
      if (open !== undefined) { try { open.close(); } catch { /* already closed */ } }
      finished();
      wake();
      await loop.catch(() => undefined);
      await queue;
    },
  };
}
