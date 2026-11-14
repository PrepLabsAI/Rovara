import { randomUUID } from "node:crypto";
import { closeSync, openSync, writeSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

// The hardened HTTP substrate every fake and mock in a run is served by (test services TS23): the sockets, the limits and the request ledger. What a request is ANSWERED with is a strategy handed in:
//   - the E2E checker's approved-origin mock (`executor/mock-server.ts`) and its sinkhole,
//   - the fake server (`service-mocks/fake-server.ts`): v2 fixture replay and the record-only sinkhole.
// This file imports no package and no sibling module: it runs inside the 128 MiB executor image where loading the contracts barrel takes ten seconds and most of that memory. It makes no outbound
// connection of any kind and imports nothing that could (no `http.request`, no `net.connect`, no `fetch`): a request is answered or recorded here, never forwarded. A test reads this source for that.
//
// Rules (from System B's hardening, kept as they were):
//   - the ledger is opened for appending first, so a ledger that cannot be written never serves a request;
//   - every request is written to the ledger BEFORE it is answered, so no answer can be seen without its record; when the ledger can no longer be written the server stops answering;
//   - every connection ends up in the ledger: a parsed request as the request it was, and anything that never becomes one (TLS, h2c, CONNECT, an Upgrade, a malformed or oversized request, a header timeout,
//     a silent connection, a connection past the cap) as an unmatched call;
//   - the ledger holds at most `maxLines` lines; the last slot records the overflow as an unmatched call and nothing is answered from a fixture any more, so a flood is never silent;
//   - the sockets are bounded: connection cap, header size and count, request and header time limits, a body cap when a body is read at all.

export const CORE_LEDGER_MAX_LINES = 2048;
const MAX_PATH_CHARS = 512;
const MAX_METHOD_CHARS = 16;
const MAX_CONNECTIONS = 64;
/** The largest request head (request line and headers) a connection may send; Node's default is 16 KiB, written down so it cannot drift. */
export const CORE_MAX_HEADER_BYTES = 16 * 1024;
const CONNECTION_GRACE_MS = 1_000;

export const clip = (value: string, max: number): string => (value.length <= max ? value : value.slice(0, max));
/** The address a connection came from, as the host compares it with the application container's (an IPv4-mapped IPv6 address is written as IPv4). */
export const callerAddress = (raw: string | undefined): string => clip(raw === undefined ? "unknown" : raw.startsWith("::ffff:") ? raw.slice(7) : raw, 64);

/** One parsed request, as the strategy sees it. `method` and `rawPath` are exactly as sent (no decoding, no normalising); the ledger clips them, the strategy does not. */
export type CoreRequest = Readonly<{
  method: string;
  /** The request target as sent. */
  rawUrl: string;
  /** The path part of an origin-form target; the whole target for any other form. */
  rawPath: string;
  /** The text after the first `?` of an origin-form target (empty when none). */
  rawQuery: string;
  originForm: boolean;
  headers: IncomingHttpHeaders;
  /** The body, when the strategy asked for one (`maxBodyBytes > 0`); empty otherwise. */
  body: string;
  remote: string | undefined;
}>;

/** What to answer, and what to write about it. The ledger line is `requestId`, the clipped method and path, `ledger`, `status`, `observedAt` and `remoteAddress`. */
export type CoreAnswer = Readonly<{
  status: number;
  contentType: string;
  text: string;
  headers?: Readonly<Record<string, string>>;
  /** The strategy's own ledger fields (and digests); never `requestId`, `method`, `path`, `status`, `observedAt` or `remoteAddress`. */
  ledger: Readonly<Record<string, unknown>>;
  /** Wait this long, after the ledger line is written, before answering. */
  delayMs?: number;
  /** Close the connection instead of answering (a timeout fault), after the delay. */
  destroy?: boolean;
}>;

export type CoreRefusal = Readonly<{ kind: "unparsed" | "refused" | "dropped" | "body-too-large"; method: string; rawPath: string; rawQuery: string; remote: string | undefined }>;

export type CoreStrategy = Readonly<{
  /** The most body bytes read per request (0: the body is never read, only drained). A larger body is refused with 413 and recorded. */
  maxBodyBytes: number;
  /** `full` is true at the ledger bound: the strategy must answer as for a call nothing matched and change no state. */
  decide(request: CoreRequest, context: Readonly<{ full: boolean }>): CoreAnswer | Promise<CoreAnswer>;
  /** The answer, and ledger fields, for anything that never became a servable request. */
  refuse(call: CoreRefusal): CoreAnswer;
  /**
   * Paths under `prefix` are not requests of the fake: `handle` answers them and nothing is recorded, EXCEPT a request `authorised` turns away: that one is written to the ledger as a refused call (status 403)
   * before the 403 is sent, so someone probing the control paths without the run's token leaves a trace.
   */
  control?: Readonly<{ prefix: string; authorised?(request: IncomingMessage): boolean; handle(request: IncomingMessage, response: ServerResponse, path: string): Promise<void> }>;
}>;

export type CoreOptions = Readonly<{
  strategy: CoreStrategy;
  /** Null keeps no file (the line count still bounds the server). */
  ledgerPath: string | null;
  host: string;
  port: number;
  /** More ports the same server listens on. */
  additionalPorts?: readonly number[];
  maxLines?: number;
  maxConnections?: number;
  /** How long a connection may stay quiet (no byte received) without a parsed request before it is recorded as one. */
  connectionGraceMs?: number;
  /** The longest a connection may stay open without having become a request before it is recorded, however steadily it sends; default three times the grace. */
  connectionCeilingMs?: number;
  keepAliveMs?: number;
  now?: () => Date;
  /** Called once when the ledger cannot be written; the server has already stopped answering. */
  onFatal?: (error: unknown) => void;
}>;

export type RunningCore = Readonly<{ server: Server; servers: readonly Server[]; port: number; ports: readonly number[]; close(): Promise<void> }>;

class BodyTooLarge extends Error {}
export async function readBoundedBody(request: IncomingMessage, max: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > max) throw new BodyTooLarge();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

type SocketState = { parsed: boolean; recorded: boolean };

/** Splits an origin-form request target; any other form (an absolute URL, `*`, an authority) is one opaque path with no query. */
export function splitRequestTarget(rawUrl: string): { rawPath: string; rawQuery: string; originForm: boolean } {
  const originForm = rawUrl.startsWith("/") && !rawUrl.startsWith("//");
  if (!originForm) return { rawPath: clip(rawUrl, MAX_PATH_CHARS), rawQuery: "", originForm };
  const queryStart = rawUrl.indexOf("?");
  return queryStart === -1 ? { rawPath: rawUrl, rawQuery: "", originForm } : { rawPath: rawUrl.slice(0, queryStart), rawQuery: rawUrl.slice(queryStart + 1), originForm };
}

export async function startCore(options: CoreOptions): Promise<RunningCore> {
  const { strategy } = options;
  const maxLines = options.maxLines ?? CORE_LEDGER_MAX_LINES;
  const grace = options.connectionGraceMs ?? CONNECTION_GRACE_MS;
  const ceilingMs = options.connectionCeilingMs ?? grace * 3;
  const now = options.now ?? (() => new Date());
  const fd = options.ledgerPath === null ? null : openSync(options.ledgerPath, "a", 0o644);
  let lines = 0;
  let overflowed = false;
  let failed = false;
  const servers: Server[] = [];
  const states = new WeakMap<Socket, SocketState>();

  const stop = (error: unknown): void => {
    if (failed) return;
    failed = true;
    for (const server of servers) server.close();
    options.onFatal?.(error);
  };

  /** Writes one line; false when the ledger could not be written (the server has then stopped). At the bound the last slot is written once, and later calls write nothing. */
  const write = (call: { method: string; rawPath: string; remote: string | undefined }, answer: CoreAnswer, full: boolean): boolean => {
    try {
      if (!full || !overflowed) {
        const line = { requestId: `req-${randomUUID()}`, method: clip(call.method, MAX_METHOD_CHARS), path: clip(call.rawPath, MAX_PATH_CHARS), ...answer.ledger, status: answer.status,
          observedAt: now().toISOString(), remoteAddress: callerAddress(call.remote) };
        if (fd !== null) writeSync(fd, `${JSON.stringify(line)}\n`);
        lines += 1;
        if (full) overflowed = true;
      }
      return true;
    } catch (error) {
      stop(error);
      return false;
    }
  };
  const isFull = (): boolean => lines >= maxLines - 1;

  /** A call that never became a servable request. */
  const unparsed = (socket: Socket, method: string, force = false): void => {
    const state = states.get(socket);
    if (state !== undefined && (state.recorded || (state.parsed && !force))) return;
    if (state !== undefined) state.recorded = true;
    const call = { kind: "unparsed" as const, method, rawPath: "/", rawQuery: "", remote: socket.remoteAddress };
    write(call, strategy.refuse(call), isFull());
  };

  const send = (response: ServerResponse, answer: CoreAnswer, socket: Socket): void => {
    const finish = (): void => {
      if (answer.destroy === true) { socket.destroy(); return; }
      response.writeHead(answer.status, { ...answer.headers, "content-type": answer.contentType, "content-length": Buffer.byteLength(answer.text) });
      response.end(answer.text);
    };
    if (answer.delayMs !== undefined && answer.delayMs > 0) setTimeout(finish, answer.delayMs).unref(); else finish();
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    // Taken now: an incoming message that was cut short (a body over the cap) lets go of its socket.
    const socket = request.socket;
    const remote = socket.remoteAddress;
    const state = states.get(socket);
    if (state !== undefined) state.parsed = true;
    const target = splitRequestTarget(String(request.url ?? ""));
    if (strategy.control !== undefined && target.originForm && target.rawPath.startsWith(strategy.control.prefix)) {
      if (failed) { response.destroy(); return; }
      if (strategy.control.authorised !== undefined && !strategy.control.authorised(request)) {
        const call: CoreRefusal = { kind: "refused", method: String(request.method ?? ""), rawPath: target.rawPath, rawQuery: "", remote };
        const refused = { ...strategy.refuse(call), status: 403, contentType: "text/plain; charset=utf-8", text: "control token required" };
        request.resume();
        if (!write(call, refused, isFull())) { response.destroy(); return; }
        send(response, refused, socket);
        return;
      }
      await strategy.control.handle(request, response, target.rawPath);
      return;
    }
    let body = "";
    let tooLarge = false;
    if (strategy.maxBodyBytes > 0) {
      try { body = await readBoundedBody(request, strategy.maxBodyBytes); } catch (error) { if (error instanceof BodyTooLarge) tooLarge = true; else throw error; }
    } else {
      // The body is never read; it is drained so the connection ends.
      request.resume();
    }
    if (failed) { response.destroy(); return; }
    const parsed: CoreRequest = { method: String(request.method ?? ""), rawUrl: clip(String(request.url ?? ""), 4_096), ...target, headers: request.headers, body, remote };
    const full = isFull();
    let answer: CoreAnswer;
    if (tooLarge) {
      request.resume();
      answer = strategy.refuse({ kind: "body-too-large", method: parsed.method, rawPath: parsed.rawPath, rawQuery: parsed.rawQuery, remote: parsed.remote });
    } else {
      answer = await strategy.decide(parsed, { full });
    }
    if (!write(parsed, answer, full)) { response.destroy(); return; }
    send(response, answer, socket);
  };

  const build = (): Server => {
    const server = createServer({ maxHeaderSize: CORE_MAX_HEADER_BYTES }, (request, response) => {
      handle(request, response).catch(() => { if (!response.headersSent) { response.writeHead(500, { "content-type": "text/plain; charset=utf-8", connection: "close" }); response.end("mock error"); } else response.destroy(); });
    });
    server.maxConnections = options.maxConnections ?? MAX_CONNECTIONS;
    server.requestTimeout = 10_000;
    server.headersTimeout = 10_000;
    server.keepAliveTimeout = options.keepAliveMs ?? 1_000;
    server.maxHeadersCount = 64;
    server.on("connection", (socket: Socket) => {
      states.set(socket, { parsed: false, recorded: false });
      // The connection is a call that never became a request when it has been quiet for the grace after its last byte, or has been open for the ceiling whatever it sends.
      // The check is made after the loop has read what is waiting: a stall that outlasts the timer must not turn a request already in the socket into an unparsed call.
      const fire = (): void => { setImmediate(() => unparsed(socket, "UNPARSED")); };
      const quiet = setTimeout(fire, grace);
      const ceiling = setTimeout(fire, ceilingMs);
      quiet.unref(); ceiling.unref();
      socket.on("data", () => { quiet.refresh(); });
      socket.once("close", () => { clearTimeout(quiet); clearTimeout(ceiling); unparsed(socket, "UNPARSED"); });
      socket.on("error", () => undefined);
    });
    // Anything the HTTP parser refuses (TLS, h2c, a malformed or oversized request) is a call, not a silence.
    server.on("clientError", (_error: Error, socket: Socket) => {
      unparsed(socket, "UNPARSED", true);
      if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n"); else socket.destroy();
    });
    // CONNECT and Upgrade are never answered from a fixture, however well the rest of the request matches it.
    const refuse = (request: IncomingMessage, socket: Socket): void => {
      const state = states.get(socket);
      if (state !== undefined) state.parsed = true;
      const target = splitRequestTarget(String(request.url ?? ""));
      const answer = strategy.refuse({ kind: "refused", method: String(request.method ?? ""), rawPath: target.rawPath, rawQuery: target.rawQuery, remote: socket.remoteAddress });
      write({ method: String(request.method ?? ""), rawPath: target.rawPath, remote: socket.remoteAddress }, answer, isFull());
      if (socket.writable) socket.end(`HTTP/1.1 ${String(answer.status)} Unmocked\r\ncontent-type: ${answer.contentType}\r\ncontent-length: ${String(Buffer.byteLength(answer.text))}\r\nconnection: close\r\n\r\n${answer.text}`);
      else socket.destroy();
    };
    server.on("connect", refuse);
    server.on("upgrade", refuse);
    // A connection past the cap is dropped by the server; the drop is recorded.
    server.on("drop", (data?: { remoteAddress?: string }) => {
      const call = { kind: "dropped" as const, method: "DROPPED", rawPath: "/", rawQuery: "", remote: data?.remoteAddress };
      write(call, strategy.refuse(call), isFull());
    });
    servers.push(server);
    return server;
  };

  const ports = [options.port, ...(options.additionalPorts ?? [])];
  const listening: number[] = [];
  try {
    for (const port of ports) {
      const server = build();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, options.host, () => { server.off("error", reject); resolve(); });
      });
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("mock server has no listening port");
      listening.push(address.port);
    }
  } catch (error) {
    for (const server of servers) server.close();
    if (fd !== null) { try { closeSync(fd); } catch { /* already closed */ } }
    throw error;
  }
  return Object.freeze({ server: servers[0]!, servers: Object.freeze([...servers]), port: listening[0]!, ports: Object.freeze(listening), close: async () => {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); })));
    if (fd !== null) { try { closeSync(fd); } catch { /* already closed */ } }
  } });
}
