// The eval stand-in's HTTP and HTTPS servers (L4-E56, rows E5 and E6). ONE module both homes use: the hosted helper container (eval-standin-helper.ts) builds its servers here, and the tests drive the same code in process.
//
// What it does, and what it never does:
//   - it answers EVERY request: a host the plan names, a host nobody named (the catch-all: "new connection") and an operation no contract lists all get an answer made by the engine (eval-standin-engine.ts) from the ONE
//     round answer book. The answer for a request is the same bytes on both sides of a comparison. It never stops, never returns "cannot answer", and never forwards, fetches or records anything from outside;
//   - EVERY answer carries `x-rovara-label: madeByRovara` and `x-rovara-standin: <class>`: a Rovara-made answer is never taken for the real vendor's, and never counts as change proof;
//   - the host a request is for is the Host header (the name the client asked for: sealed DNS and the box's host table send every vendor name to this one address). HTTPS: the certificate is made for the name the client sent
//     in the TLS handshake (SNI) by the round's authority (run-ca.ts); a client that does not trust it, or one that pins a certificate, abandons the handshake and is counted (`tlsFailed`), never answered;
//   - a request body is read only up to 64 KiB; a bigger one is refused with 413 and the connection closed. A request head is limited by node; both are counted;
//   - `callers`, when given, is the allow-list of remote addresses: a connection from any other address is closed before one byte is read and counted as foreign (the helper serves one sandbox address only);
//   - nothing here opens a connection: it imports no client. The helper's import graph is walked by a test.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createTlsServer, type Server as TlsServer } from "node:https";
import type { Socket } from "node:net";
import { createSecureContext, type SecureContext } from "node:tls";
import {
  EVAL_STAND_IN_BODY_MAX_BYTES, EVAL_STAND_IN_CLASS_HEADER, EVAL_STAND_IN_GAP_NAMES_MAX, EVAL_STAND_IN_LABEL, EVAL_STAND_IN_LABEL_HEADER, EVAL_STAND_IN_NEW_HOSTS_MAX,
  answerEvalStandInRequest, evalStandInPathName, isEvalStandInHostName,
  type EvalAnswerBook, type EvalStandInGapName, type EvalStandInPlan, type EvalStandInRequest,
} from "@agentx/contracts/eval-standin-helper";
import type { LeafMinter } from "./run-ca.js";

export interface EvalStandInServerStats {
  foreign: number;
  refused: number;
  tlsFailed: number;
  /** The first distinct gap requests, named by method, host and a path with its ids blanked. */
  gaps: EvalStandInGapName[];
  /** The first distinct hosts nobody had named. */
  newHosts: string[];
}

export interface EvalStandInServersOptions {
  readonly plan: EvalStandInPlan;
  readonly book: EvalAnswerBook;
  /** Makes the certificates of the TLS server. Absent: no TLS server is built. */
  readonly minter?: LeafMinter | undefined;
  /** The name a TLS client that sent no name gets a certificate for (the helper's own address). */
  readonly defaultName?: string | undefined;
  /** When given, only these remote addresses are served (IPv4, `::ffff:` form accepted). */
  readonly callers?: readonly string[];
  /** Called after the counters change and BEFORE the answer is sent (the helper writes its summary here, so a summary read after an answer arrived always includes it). A throw stops the servers' answering at the caller's choice. */
  readonly beforeSend?: (() => void) | undefined;
}

export interface EvalStandInServers {
  readonly http: Server;
  readonly tls: TlsServer | undefined;
  stats(): EvalStandInServerStats;
}

const plainAddress = (address: string | undefined): string | undefined => (address === undefined ? undefined : address.replace(/^::ffff:/iu, ""));
const HOST_HEADER = /^([^:[\]/@\s]{1,253})(?::\d{1,5})?$/u;

/** The host a request is for: the Host header without its port, lowercased, only when it is a plain host name (an address or anything else is an unnamed host). */
export function hostOfRequest(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = HOST_HEADER.exec(header);
  const host = match?.[1]?.toLowerCase();
  return host !== undefined && isEvalStandInHostName(host) && !/^\d+(?:\.\d+){3}$/u.test(host) ? host : null;
}

export function createEvalStandInServers(options: EvalStandInServersOptions): EvalStandInServers {
  const stats: EvalStandInServerStats = { foreign: 0, refused: 0, tlsFailed: 0, gaps: [], newHosts: [] };
  const seenGaps = new Set<string>();

  const changed = (): void => { options.beforeSend?.(); };
  const note = (request: EvalStandInRequest, cls: string): void => {
    if (cls === "recorded") return;
    const method = /^[A-Z]{1,16}$/u.test(request.method) ? request.method : "GET";
    const path = evalStandInPathName(request.path);
    const host = request.host ?? "unnamed";
    const id = `${method} ${host} ${path} ${cls}`;
    if (!seenGaps.has(id) && stats.gaps.length < EVAL_STAND_IN_GAP_NAMES_MAX) { seenGaps.add(id); stats.gaps.push({ method, host: host.slice(0, 253), path, cls: cls as EvalStandInGapName["cls"] }); }
    if (cls === "new_connection" && !stats.newHosts.includes(host) && stats.newHosts.length < EVAL_STAND_IN_NEW_HOSTS_MAX) stats.newHosts.push(host);
  };

  const answer = (request: IncomingMessage, response: ServerResponse, body: string): void => {
    const url = (() => {
      const raw = request.url ?? "/";
      // Origin form (`/path?query`). An absolute form (`http://host/path`, what a proxy client sends) is read for its path and query too; the Host header still names the host.
      try { const parsed = raw.startsWith("/") ? new URL(raw, "http://x") : new URL(raw); return { path: parsed.pathname, query: parsed.search.startsWith("?") ? parsed.search.slice(1) : "" }; } catch { return { path: "/", query: "" }; }
    })();
    const standIn: EvalStandInRequest = {
      method: (request.method ?? "GET").toUpperCase(), host: hostOfRequest(request.headers.host), path: url.path, query: url.query,
      contentType: String(request.headers["content-type"] ?? ""), body,
    };
    const result = answerEvalStandInRequest(options.book, options.plan, standIn);
    note(standIn, result.cls);
    changed();
    const bytes = new TextEncoder().encode(result.body).length;
    const noBody = standIn.method === "HEAD" || result.status === 204 || result.body === "";
    response.writeHead(result.status, {
      "content-type": result.contentType, [EVAL_STAND_IN_LABEL_HEADER]: EVAL_STAND_IN_LABEL, [EVAL_STAND_IN_CLASS_HEADER]: result.cls,
      ...(result.status === 204 ? {} : { "content-length": String(bytes) }), connection: "close",
    });
    response.end(noBody ? undefined : result.body);
  };

  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    const chunks: Buffer[] = [];
    let size = 0;
    let refused = false;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (refused) return;
      if (size > EVAL_STAND_IN_BODY_MAX_BYTES) {
        refused = true;
        stats.refused += 1;
        changed();
        response.writeHead(413, { [EVAL_STAND_IN_LABEL_HEADER]: EVAL_STAND_IN_LABEL, "content-length": "0", connection: "close" }).end();
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => { if (!refused) answer(request, response, Buffer.concat(chunks).toString("utf8")); });
    request.on("error", () => undefined);
  };

  const harden = (server: Server | TlsServer): void => {
    // Node answers a request it cannot parse (400), headers past its limit (431) or a timeout (408) itself, without calling the handler: those are counted, and answered with the label.
    server.on("clientError", (error: NodeJS.ErrnoException, socket) => {
      if (!socket.writable || socket.destroyed) { socket.destroy(); return; }
      const parse = typeof error.code === "string" && (error.code.startsWith("HPE_") || error.code === "ERR_HTTP_REQUEST_TIMEOUT" || error.code === "ERR_HTTP_HEADERS_TIMEOUT");
      if (parse) { stats.refused += 1; changed(); }
      socket.end(`HTTP/1.1 ${error.code === "HPE_HEADER_OVERFLOW" ? "431 Request Header Fields Too Large" : "400 Bad Request"}\r\n${EVAL_STAND_IN_LABEL_HEADER}: ${EVAL_STAND_IN_LABEL}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
    });
    if (options.callers !== undefined) {
      const allowed = new Set(options.callers);
      // Before one byte is read: a connection from another address is closed and counted; neither the TLS handshake nor the HTTP parser ever sees it.
      server.on("connection", (socket: Socket) => {
        socket.on("error", () => undefined);
        const from = plainAddress(socket.remoteAddress);
        if (from === undefined || !allowed.has(from)) { stats.foreign += 1; changed(); socket.destroy(); }
      });
    }
    server.maxConnections = 64;
    server.headersTimeout = 10_000;
    server.requestTimeout = 30_000;
    server.keepAliveTimeout = 1_000;
  };

  const http = createServer(handler);
  harden(http);

  let tls: TlsServer | undefined;
  if (options.minter !== undefined) {
    const minter = options.minter;
    const contexts = new Map<string, SecureContext>();
    const contextFor = (servername: string | undefined): SecureContext | undefined => {
      const name = (servername === undefined || servername === "" ? options.defaultName : servername)?.toLowerCase();
      if (name === undefined) return undefined;
      const cached = contexts.get(name);
      if (cached !== undefined) return cached;
      const leaf = minter.mint(name);
      if (leaf === undefined) return undefined;
      if (contexts.size >= 256) contexts.clear();
      const context = createSecureContext({ key: leaf.keyPem, cert: leaf.certPem, minVersion: "TLSv1.2" });
      contexts.set(name, context);
      return context;
    };
    // The server's own default context is for a client that sends no usable name: a certificate for the helper's own address.
    const fallback = options.defaultName === undefined ? undefined : minter.mint(options.defaultName);
    tls = createTlsServer({
      ...(fallback === undefined ? {} : { key: fallback.keyPem, cert: fallback.certPem }), minVersion: "TLSv1.2", handshakeTimeout: 10_000,
      SNICallback: (servername, callback) => {
        // A name that is not a plain host name gets the default certificate: the handshake completes only for a client that does not check the name, and it is answered as an unnamed host.
        callback(null, contextFor(servername) ?? contextFor(undefined));
      },
    }, handler);
    harden(tls);
    tls.on("tlsClientError", () => { stats.tlsFailed += 1; changed(); });
  }
  return { http, tls, stats: () => ({ ...stats, gaps: [...stats.gaps], newHosts: [...stats.newHosts] }) };
}
