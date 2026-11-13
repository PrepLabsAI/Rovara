// TE-F2 part B (M2, release 0.5.19; DECISIONS 158; te-f1 design 2.3, 3.2, 7): the model helper's HTTP loop. A `node:http` listener ONLY on `--listen` (the helper network's `.9` hosted, `127.0.0.1` on the laptop) that answers ONLY the
// `--caller` address (any other source gets the fixed refusal and is counted apart), refuses CONNECT, upgrades, absolute-form targets, a second `?`, control characters and encoded slashes, holds the design's limits (request line plus
// headers 16 KB, body 5 MB, header read 10 s, total 10 minutes, one written chunk 1 MB), and serves a call from the reply set through Part A's `serveModelRequestWithReplies`.
//
// NO OUTBOUND SOCKET ANYWHERE in the helper program: nothing here imports `net.connect`, `fetch`, `dns`, `tls`, `https`, `child_process` or an HTTP client (a test greps the program's files, and a stubbed run proves it). The only
// `node:net` use is the 443/80 listeners that record who dialed a model host by name (`createServer`, never a connect).
//
// Paths: `/p/<rowId>/<the API's own path>` (ANY version prefix), and after the row id, in this fixed order and each optional: `/f/<mode>[.<variant>]` (a failure-pack run), `/n/<afterCalls>` (only after `/f/`), `/x/<token>` (F1-c's
// real-call token: parsed and passed to the backend, never acted on here). The mode (`scripted`, `replay`, `record`, `real`) comes from the arguments the worker built, never from the request. `replay`, `record` and `real` are
// F1-c's: the loop calls an injected `ModelBackend`; with none, those modes answer the fixed "not run: real model checks need a fresh check sandbox".
//
// Every call is written to the ledger BEFORE its answer is sent. A ledger that is full refuses the call (`ledger_full`). Credentials a client sent are never copied into an answer, a ledger row or a backend request (the
// credential headers are dropped before a backend sees the call).
import { createHash } from "node:crypto";
import { createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  FailureSpecSchema,
  INITIAL_SERVE_STATE,
  MODEL_ECHO_PATTERN,
  SSE_CONTENT_TYPE,
  checkModelHost,
  readModelRequestFacts,
  serveModelRequestWithReplies,
  type FailureSpec,
  type ModelAnswer,
  type ModelReplySet,
  type ServableRow,
  type ServeState,
  type ServedModelFamily,
} from "@agentx/contracts/model-helper";
import { MODEL_ESCAPE_READ_MAX_BYTES, MODEL_ESCAPE_READ_TIMEOUT_MS, type ModelEscapePort, type ModelHostRecorderPort } from "./model-helper-recorder-port.js";
import type { ModelLedgerRow, ModelLedgerWriter, ModelRefusalReason } from "./model-helper-ledger.js";
import type { ModelHelperMode } from "./model-helper-args.js";
import { createModelMetadataServer } from "./model-helper-metadata.js";

/** The design's limits (te-f1 design 7). */
export const MODEL_HELPER_LIMITS = {
  headerBytes: 16 * 1024,
  bodyBytes: 5 * 1024 * 1024,
  headerReadMs: 10_000,
  totalMs: 10 * 60 * 1000,
  chunkBytes: 1024 * 1024,
  targetChars: 2048,
  /** The time one request has to send its whole body once its headers are in. */
  bodyReadMs: 30_000,
  /** Sockets the main listener holds at once (one sandbox is the only caller; a flood is dropped, not queued). */
  maxConnections: 256,
  /** The same bound for the metadata server and each of the 443/80 escape listeners. */
  sideMaxConnections: 64,
} as const;

/** What the helper says when real, record or replay is asked and no backend is wired (F1-c's `ModelBackend` is not there yet, or the round is not a fresh check sandbox). */
export const REAL_NOT_AVAILABLE_SENTENCE = "not run: real model checks need a fresh check sandbox";
const REFUSAL_BODY = '{"error":{"code":"refused","message":"the model helper does not answer this caller"}}';
const FIXED_JSON = { "content-type": "application/json", "cache-control": "no-store" } as const;

// ---- the backend seam (F1-c implements it for `real`, `record` and `replay`)

export interface ModelBackendRequest {
  readonly mode: Exclude<ModelHelperMode, "scripted">;
  readonly rowId: string;
  readonly method: string;
  /** The API's own path after `/p/<rowId>` (and after any `/f`, `/n` and `/x` segment). */
  readonly path: string;
  readonly query: string;
  /** Lowercase names, every credential header already dropped. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  /** F1-c's `/x/<token>` segment, parsed and passed on; this loop never acts on it. */
  readonly token: string | undefined;
}
export interface ModelBackendAnswer {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | Uint8Array;
}
export interface ModelBackend {
  /** One answer, or undefined for "not run" (the loop then answers the fixed sentence). May throw: the loop answers a fixed 502. */
  serve(request: ModelBackendRequest, signal: AbortSignal): Promise<ModelBackendAnswer | undefined>;
}

// ---- the target

export interface ParsedModelTarget {
  readonly rowId: string;
  readonly failure: FailureSpec | undefined;
  readonly token: string | undefined;
  /** The API's own path (starts with `/`). */
  readonly rest: string;
  readonly query: string;
}
export type ParsedModelTargetResult = { readonly ok: true; readonly target: ParsedModelTarget } | { readonly ok: false };

const ROW_ID = /^[a-z][a-z0-9-]{0,39}$/u;
const TOKEN = /^[A-Za-z0-9_-]{16,128}$/u;
// A control character, a space, a backslash, a fragment, a NUL or an encoded slash, backslash, dot or NUL in the PATH: none is a path an SDK sends.
// eslint-disable-next-line no-control-regex -- the point is to refuse control characters
const BAD_PATH = /[\u0000- \u007f\\#]|%2f|%5c|%2e|%00/iu;
// eslint-disable-next-line no-control-regex -- the point is to refuse control characters
const BAD_QUERY = /[\u0000- \u007f\\#]/u;

/** Reads a request target. Origin-form only: an absolute-form target (`http://host/...`), a leading `//`, a second `?`, a control character, an encoded slash and a `..` segment are refused. */
export function parseModelTarget(raw: unknown): ParsedModelTargetResult {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MODEL_HELPER_LIMITS.targetChars || !raw.startsWith("/") || raw.startsWith("//")) return { ok: false };
  const parts = raw.split("?");
  if (parts.length > 2) return { ok: false };
  const path = parts[0] as string;
  const query = parts[1] ?? "";
  if (BAD_PATH.test(path) || BAD_QUERY.test(query)) return { ok: false };
  const segments = path.split("/").slice(1);
  if (segments[0] !== "p" || segments.some((segment, index) => (segment === "" && index < segments.length - 1) || segment === "." || segment === "..")) return { ok: false };
  const rowId = segments[1];
  if (rowId === undefined || !ROW_ID.test(rowId)) return { ok: false };
  let at = 2;
  let failure: FailureSpec | undefined;
  let token: string | undefined;
  if (segments[at] === "f") {
    const word = segments[at + 1] ?? "";
    const match = /^([a-z_]+)(?:\.([a-z]+))?$/u.exec(word);
    if (match === null) return { ok: false };
    at += 2;
    let afterCalls: number | undefined;
    if (segments[at] === "n") {
      const digits = segments[at + 1] ?? "";
      if (!/^\d{1,5}$/u.test(digits)) return { ok: false };
      afterCalls = Number(digits);
      at += 2;
    }
    const parsed = FailureSpecSchema.safeParse({ mode: match[1], ...(afterCalls === undefined ? {} : { afterCalls }), ...(match[2] === undefined ? {} : { variant: match[2] }) });
    if (!parsed.success) return { ok: false };
    failure = parsed.data;
  } else if (segments[at] === "n") {
    return { ok: false };
  }
  if (segments[at] === "x") {
    const value = segments[at + 1] ?? "";
    if (!TOKEN.test(value)) return { ok: false };
    token = value;
    at += 2;
  }
  // The fixed order: nothing of ours follows the token, and a failure segment after it is not a form.
  if (segments[at] === "f" || segments[at] === "n" || segments[at] === "x") return { ok: false };
  const restPath = `/${segments.slice(at).join("/")}`;
  return { ok: true, target: { rowId, failure, token, rest: restPath, query } };
}

// ---- headers

const CREDENTIAL_HEADERS = new Set(["authorization", "proxy-authorization", "x-api-key", "x-goog-api-key", "api-key", "x-goog-user-project", "cookie", "set-cookie"]);
const isCredentialHeader = (name: string): boolean => CREDENTIAL_HEADERS.has(name) || name.startsWith("proxy-") || name.startsWith("x-amz-");

/** The request's headers for a backend: lowercase names, one value each (at most 4 KB), every credential header (a bearer token, an API key, a cookie, a proxy header, an AWS header) dropped. */
export function headersForBackend(headers: IncomingMessage["headers"]): Record<string, string> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  let count = 0;
  for (const [name, value] of Object.entries(headers)) {
    if (count >= 100 || isCredentialHeader(name.toLowerCase())) continue;
    const first = typeof value === "string" ? value : Array.isArray(value) ? value[0] : undefined;
    if (typeof first !== "string") continue;
    out[name.toLowerCase()] = first.length > 4096 ? first.slice(0, 4096) : first;
    count += 1;
  }
  return out;
}

// ---- the loop

export interface ModelHelperLoopOptions {
  readonly listen: string;
  /** 0 for an ephemeral port (the laptop's loopback helper). */
  readonly port: number;
  /** Absent: no metadata server. */
  readonly metaPort?: number | undefined;
  readonly caller: string;
  readonly mode: ModelHelperMode;
  readonly rows: readonly ServableRow[];
  /** The reply set of each served family; a family with none answers "unmatched" to every call. */
  readonly replySets: ReadonlyMap<ServedModelFamily, ModelReplySet>;
  readonly ledger: ModelLedgerWriter;
  /** The connected Google project id (not secret) the metadata server answers; absent: the metadata project route answers 500. */
  readonly projectId?: string | undefined;
  readonly backend?: ModelBackend | undefined;
  /** Bind 443 and 80 on `listen` and call the recorder (hosted). `ports` is for tests (443 and 80 are privileged). */
  readonly escapes?: { readonly recorder: ModelHostRecorderPort; readonly ports?: { readonly tls: number; readonly plain: number } } | undefined;
  readonly now?: (() => number) | undefined;
  /** Tests: shorter limits. */
  readonly limits?: { readonly bodyReadMs?: number; readonly maxConnections?: number } | undefined;
}
export interface RunningModelHelperLoop {
  readonly port: number;
  readonly metaPort: number | undefined;
  readonly escapePorts: { readonly tls: number; readonly plain: number } | undefined;
  close(): Promise<void>;
}

const normalizeAddress = (address: string | undefined): string => (address ?? "").replace(/^::ffff:/iu, "");

/** The echo-safe model name of a result, or undefined. */
const safeModel = (model: string | undefined): string | undefined => (model !== undefined && MODEL_ECHO_PATTERN.test(model) ? model : undefined);
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

function listenOn(server: Server | NetServer, port: number, host: string): Promise<number> {
  return new Promise((resolveListen, rejectListen) => {
    const failed = (error: Error): void => rejectListen(error);
    server.once("error", failed);
    server.listen(port, host, () => {
      server.off("error", failed);
      const address = server.address();
      resolveListen(typeof address === "object" && address !== null ? address.port : port);
    });
  });
}
const closeServer = (server: Server | NetServer): Promise<void> =>
  new Promise((resolveClose) => {
    server.close(() => resolveClose());
    if ("closeAllConnections" in server) server.closeAllConnections();
  });

function sendFixed(res: ServerResponse, status: number, body: string, extra: Record<string, string> = {}): void {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, { ...FIXED_JSON, ...extra, "content-length": String(Buffer.byteLength(body)), connection: "close" });
  res.end(body);
}

/** Sends an answer: a stream (`text/event-stream`) chunked, anything else with a length; every write is at most 1 MB. */
function sendAnswer(res: ServerResponse, answer: { readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly body: string | Uint8Array }, kind: string): void {
  if (res.headersSent || res.destroyed) return;
  const bytes = typeof answer.body === "string" ? Buffer.from(answer.body, "utf8") : Buffer.from(answer.body);
  const headers: Record<string, string> = { "cache-control": "no-store" };
  for (const [name, value] of Object.entries(answer.headers)) if (!/[\r\n]/u.test(name + value)) headers[name.toLowerCase()] = value;
  headers["x-rovara-model-helper"] = kind;
  const streamed = (headers["content-type"] ?? "").startsWith(SSE_CONTENT_TYPE);
  if (!streamed) headers["content-length"] = String(bytes.length);
  res.writeHead(answer.status, headers);
  for (let offset = 0; offset < bytes.length; offset += MODEL_HELPER_LIMITS.chunkBytes) res.write(bytes.subarray(offset, offset + MODEL_HELPER_LIMITS.chunkBytes));
  res.end();
}

/** Starts the helper's listeners. Rejects when a port cannot be bound. */
export async function startModelHelperLoop(options: ModelHelperLoopOptions): Promise<RunningModelHelperLoop> {
  const now = options.now ?? Date.now;
  const states = new Map<string, ServeState>();
  let calls = 0;

  const refusedRow = (reason: ModelRefusalReason, status: number): ModelLedgerRow => ({ t: now(), kind: "refused", reason, status });
  const writeRefusal = (res: ServerResponse, reason: ModelRefusalReason, status: number): void => {
    // The refusal is answered even when the ledger cannot take the row (a full ledger makes the summary untrusted).
    options.ledger.append(refusedRow(reason, status));
    sendFixed(res, status, REFUSAL_BODY, { "x-rovara-model-helper": "refused" });
  };

  async function readBody(req: IncomingMessage): Promise<Buffer | "too_large" | "timeout"> {
    const chunks: Buffer[] = [];
    let total = 0;
    let timedOut = false;
    // The whole body must arrive within the body timeout (a stalled or trickling client is cut, not waited for).
    const timer = setTimeout(() => {
      timedOut = true;
      // answer first, then drop the connection (a destroy before the write is flushed would lose the answer)
      req.socket.end("HTTP/1.1 408 Request Timeout\r\ncontent-length: 0\r\nconnection: close\r\n\r\n", () => req.destroy());
    }, options.limits?.bodyReadMs ?? MODEL_HELPER_LIMITS.bodyReadMs);
    try {
      for await (const chunk of req as AsyncIterable<Buffer>) {
        total += chunk.length;
        if (total > MODEL_HELPER_LIMITS.bodyBytes) return "too_large";
        chunks.push(chunk);
      }
    } catch {
      return timedOut ? "timeout" : "too_large";
    } finally {
      clearTimeout(timer);
    }
    return timedOut ? "timeout" : Buffer.concat(chunks);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const timer = setTimeout(() => req.socket.destroy(), MODEL_HELPER_LIMITS.totalMs);
    timer.unref();
    res.once("close", () => clearTimeout(timer));
    // 1. Only the caller. Any other source gets the fixed refusal, counted apart.
    if (normalizeAddress(req.socket.remoteAddress) !== options.caller) return writeRefusal(res, "caller", 403);
    // 2. The target: origin-form only.
    const parsed = parseModelTarget(req.url);
    if (!parsed.ok) return writeRefusal(res, "target", 400);
    const { target } = parsed;
    if (!options.ledger.open) return sendFixed(res, 503, REFUSAL_BODY, { "x-rovara-model-helper": "refused" });
    // 3. The body, bounded.
    const body = await readBody(req);
    if (body === "timeout") {
      options.ledger.append(refusedRow("timeout", 408));
      return;
    }
    if (body === "too_large") return writeRefusal(res, "too_large", 413);
    calls += 1;

    // 4. The modes that are not scripted are F1-c's.
    if (options.mode !== "scripted") {
      const answer = await backendAnswer(req, target, body).catch(() => "failed" as const);
      const fixed = answer === undefined || answer === "failed";
      const toSend = fixed ? { status: answer === "failed" ? 502 : 503, headers: FIXED_JSON, body: JSON.stringify({ error: { code: "not_run", message: REAL_NOT_AVAILABLE_SENTENCE } }) } : answer;
      const row: ModelLedgerRow = { t: now(), kind: fixed ? "not_served" : "backend", row: target.rowId, status: toSend.status };
      if (!options.ledger.append(row)) return sendFixed(res, 503, REFUSAL_BODY, { "x-rovara-model-helper": "refused" });
      return sendAnswer(res, toSend, fixed ? "not_served" : "backend");
    }

    // 5. Scripted: the family of the row picks the reply set.
    const row = options.rows.find((candidate) => candidate.id === target.rowId);
    const family = row?.family;
    const replySet = family === undefined ? undefined : options.replySets.get(family as ServedModelFamily);
    const stateKey = `${target.rowId}|${target.failure === undefined ? "-" : `${target.failure.mode}.${target.failure.variant ?? ""}.${String(target.failure.afterCalls ?? 0)}`}`;
    const state = states.get(stateKey) ?? INITIAL_SERVE_STATE;
    const headers = req.headers;
    const result = serveModelRequestWithReplies(options.rows, replySet, { method: req.method ?? "GET", path: `/p/${target.rowId}${target.rest}`, query: target.query, headers, body }, {
      seed: `call-${String(calls)}`,
      state,
      ...(target.failure === undefined ? {} : { failure: target.failure }),
    });
    states.set(stateKey, result.nextState);
    const model = safeModel(result.model);
    const kind = result.kind === "scripted" ? "scripted" : result.kind === "failure_pack" ? "failure_pack" : result.kind === "unmatched" ? "unmatched" : "not_served";
    const ledgerRow: ModelLedgerRow = {
      t: now(),
      kind,
      ...(result.rowId === undefined ? (row === undefined ? {} : { row: row.id }) : { row: result.rowId }),
      ...(result.family === undefined ? {} : { family: result.family }),
      ...(result.operation === undefined ? {} : { operation: result.operation }),
      ...(model === undefined ? {} : { model }),
      ...(result.replyId === undefined ? {} : { replyId: result.replyId }),
      ...(kind === "scripted" ? { provenance: result.provenance ?? "task_made" } : {}),
      ...(result.replySha256 === undefined ? {} : { replySha256: result.replySha256 }),
      ...(kind === "scripted" || kind === "unmatched" ? promptHash(body) : {}),
      ...(result.failureMode === undefined ? {} : { failureMode: result.failureMode }),
      status: result.answer.status,
    };
    if (!options.ledger.append(ledgerRow)) return sendFixed(res, 503, REFUSAL_BODY, { "x-rovara-model-helper": "refused" });
    sendAnswer(res, result.answer, kind);
  }

  function promptHash(body: Buffer): { promptSha256?: string } {
    try {
      const facts = readModelRequestFacts(body.toString("utf8"));
      return facts.promptText === undefined ? {} : { promptSha256: sha256(facts.promptText) };
    } catch {
      return {};
    }
  }

  async function backendAnswer(req: IncomingMessage, target: ParsedModelTarget, body: Buffer): Promise<ModelBackendAnswer | undefined> {
    const backend = options.backend;
    // A failure-pack path is scripted-only; and with no backend, real, record and replay are not available here.
    if (backend === undefined || target.failure !== undefined) return undefined;
    const abort = new AbortController();
    req.socket.once("close", () => abort.abort());
    return backend.serve({ mode: options.mode as Exclude<ModelHelperMode, "scripted">, rowId: target.rowId, method: req.method ?? "GET", path: target.rest, query: target.query, headers: headersForBackend(req.headers), body, token: target.token }, abort.signal);
  }

  const main = createServer({ maxHeaderSize: MODEL_HELPER_LIMITS.headerBytes, requestTimeout: MODEL_HELPER_LIMITS.totalMs, headersTimeout: MODEL_HELPER_LIMITS.headerReadMs, keepAliveTimeout: 5_000 }, (req, res) => {
    handle(req, res).catch(() => sendFixed(res, 500, '{"error":{"code":"internal_error","message":"the model helper could not build this answer"}}'));
  });
  // CONNECT and every upgrade are refused (the proxy form and the WebSocket form): a model helper is neither.
  main.on("connect", (_req, socket) => {
    options.ledger.append(refusedRow("connect", 405));
    socket.end("HTTP/1.1 405 Method Not Allowed\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
  });
  main.on("upgrade", (_req, socket) => {
    options.ledger.append(refusedRow("upgrade", 426));
    socket.end("HTTP/1.1 426 Upgrade Required\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
  });
  main.on("clientError", (error: Error & { code?: string }, socket) => {
    if (socket.writable) {
      options.ledger.append(refusedRow("headers", error.code === "HPE_HEADER_OVERFLOW" ? 431 : 400));
      socket.end(`HTTP/1.1 ${error.code === "HPE_HEADER_OVERFLOW" ? "431 Request Header Fields Too Large" : "400 Bad Request"}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n`);
    } else socket.destroy();
  });

  main.maxConnections = options.limits?.maxConnections ?? MODEL_HELPER_LIMITS.maxConnections;
  const servers: Array<Server | NetServer> = [main];
  const port = await listenOn(main, options.port, options.listen);

  let metaPort: number | undefined;
  if (options.metaPort !== undefined) {
    const meta = createModelMetadataServer({ caller: options.caller, projectId: options.projectId, maxConnections: options.limits?.maxConnections ?? MODEL_HELPER_LIMITS.sideMaxConnections });
    servers.push(meta);
    metaPort = await listenOn(meta, options.metaPort, options.listen).catch(async (error: unknown) => {
      await Promise.all(servers.map(closeServer));
      throw error;
    });
  }

  let escapePorts: { tls: number; plain: number } | undefined;
  if (options.escapes !== undefined) {
    const recorder = options.escapes.recorder;
    const open = (escapePort: ModelEscapePort): NetServer =>
      createNetServer((socket: Socket) => {
        // Reading only: this server never connects out and never answers a body. It reads the first bytes, asks the recorder for a NAME, writes the ledger row, and closes.
        if (normalizeAddress(socket.remoteAddress) !== options.caller) {
          options.ledger.append(refusedRow("caller", 0));
          socket.destroy();
          return;
        }
        // The connection IS the escape: it is in the ledger now, before anything is read (a client that sends nothing, or that is killed, is still counted).
        options.ledger.append({ t: now(), kind: "escape", status: 0 });
        let settled = false;
        const chunks: Buffer[] = [];
        let size = 0;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(readTimer);
          let host: string | undefined;
          try {
            const observed = recorder.observe({ port: escapePort, firstBytes: Buffer.concat(chunks) }).host;
            const checked = typeof observed === "string" ? checkModelHost(observed.toLowerCase()) : undefined;
            host = checked?.ok === true ? checked.host : undefined;
          } catch {
            host = undefined;
          }
          if (host !== undefined) options.ledger.append({ t: now(), kind: "escape_host", status: 0, host });
          if (escapePort === 80) socket.end("HTTP/1.1 421 Misdirected Request\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
          else socket.destroy();
        };
        const readTimer = setTimeout(finish, MODEL_ESCAPE_READ_TIMEOUT_MS);
        readTimer.unref();
        socket.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
          size += chunk.length;
          // A TLS hello or an HTTP request line plus headers is in the first record; a client that sends more is not read further.
          if (size >= MODEL_ESCAPE_READ_MAX_BYTES || hasHelloOrHeaders(escapePort, Buffer.concat(chunks))) finish();
        });
        socket.on("error", () => finish());
        socket.on("close", () => finish());
      });
    const tlsServer = open(443);
    const plainServer = open(80);
    tlsServer.maxConnections = options.limits?.maxConnections ?? MODEL_HELPER_LIMITS.sideMaxConnections;
    plainServer.maxConnections = options.limits?.maxConnections ?? MODEL_HELPER_LIMITS.sideMaxConnections;
    servers.push(tlsServer, plainServer);
    try {
      const tlsPort = await listenOn(tlsServer, options.escapes.ports?.tls ?? 443, options.listen);
      const plain = await listenOn(plainServer, options.escapes.ports?.plain ?? 80, options.listen);
      escapePorts = { tls: tlsPort, plain };
    } catch (error) {
      await Promise.all(servers.map(closeServer));
      throw error;
    }
  }

  return {
    port,
    metaPort,
    escapePorts,
    async close() {
      await Promise.all(servers.map(closeServer));
    },
  };
}

/** Whether the first bytes already hold what a recorder reads: a whole TLS record (5-byte header plus its length) or the end of an HTTP header block. */
function hasHelloOrHeaders(port: ModelEscapePort, bytes: Buffer): boolean {
  if (port === 80) return bytes.includes("\r\n\r\n") || bytes.includes("\n\n");
  return bytes.length >= 5 && bytes.length >= 5 + bytes.readUInt16BE(3);
}

/** The answer shape the tests and the evidence read: only what a `ModelAnswer` is. */
export type { ModelAnswer };
