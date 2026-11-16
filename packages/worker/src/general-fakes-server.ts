// General fakes: the ONE HTTP server both homes of a fake use (owner decision 234 and 252a). The worker's loopback server on the local shell (general-fakes-round.ts, slice 1) and the hosted fake-helper container
// (general-fakes-helper.ts, slice 2b) both build their server here, so an answer, a "cannot answer" and a size limit are the same words and the same bytes wherever the fake runs.
//
// What it does, and what it never does:
//   - routes only `/s/<n>` (n from 0 to 7): service n's fake answers the call through the pure `answerOpenApiFake`; anything else is a fixed 404. No fake is ever asked to forward, fetch or record anything.
//   - EVERY answer, including the fixed "cannot answer" ones, carries `x-rovara-label: madeByRovara`: an answer from a Rovara-made fake is never taken for the real service's.
//   - a request body is read only up to REQUEST_BODY_MAX_BYTES; a bigger one is refused with 413 and the connection closed. No body is parsed, stored or echoed.
//   - `callers`, when given, is the allow-list of remote addresses: a connection from any other address is closed before one byte is read, and counted as "foreign" (the hosted helper serves one sandbox address only).
//   - nothing here opens a connection: it imports no client. The hosted helper's import graph is walked by a test.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  GENERAL_FAKE_ANSWER_HEADER, GENERAL_FAKE_ANSWER_LABEL, GENERAL_FAKE_CANNOT_ANSWER_BODY, answerOpenApiFake,
  type GeneralFakeServiceFake,
} from "@agentx/contracts/general-fakes-helper";

export const GENERAL_FAKES_REQUEST_BODY_MAX_BYTES = 64 * 1024;
export type GeneralFakeCallReason = "no_spec" | "spec_unreadable" | "spec_ambiguous" | "operation_unknown" | "operation_unsupported";
/** What one call came to: the fake's answer, a call it could not answer (and why), an address that was not the caller's, or a request refused before it was answered. */
export type GeneralFakeCallOutcome = "served" | GeneralFakeCallReason | "foreign" | "refused";
/** `unattributed`: a request no service answers (a path outside `/s/<n>`). It counts toward the round, never toward one reason. */
export type GeneralFakeServerCall = GeneralFakeCallOutcome | "unattributed";

export interface GeneralFakesServerOptions {
  readonly fakes: readonly GeneralFakeServiceFake[];
  /** Told once per call, before the answer is sent. */
  onCall(outcome: GeneralFakeServerCall): void;
  /** When given, only these remote addresses are served (IPv4, `::ffff:` form accepted). */
  readonly callers?: readonly string[];
}

const SERVICE_PATH = /^\/s\/(0|[1-7])([/?#].*|)$/u;
const plainAddress = (address: string | undefined): string | undefined => (address === undefined ? undefined : address.replace(/^::ffff:/iu, ""));

const labelled = (headers: Record<string, string> = {}): Record<string, string> => ({ ...headers, [GENERAL_FAKE_ANSWER_HEADER]: GENERAL_FAKE_ANSWER_LABEL });

/** The server, not yet listening. The caller listens on the address it owns and never on a wildcard. */
export function createGeneralFakesServer(options: GeneralFakesServerOptions): Server {
  const answer = (request: IncomingMessage, response: ServerResponse): void => {
    const match = SERVICE_PATH.exec(request.url ?? "");
    const fake = match === null ? undefined : options.fakes[Number(match[1])];
    const send = (status: number, body: string | undefined) => {
      response.writeHead(status, labelled(body === undefined ? {} : { "content-type": "application/json" }));
      response.end(body);
    };
    if (match === null || fake === undefined) { options.onCall("unattributed"); send(404, GENERAL_FAKE_CANNOT_ANSWER_BODY); return; }
    if (fake.status !== "built") { options.onCall(fake.reason === "start_failed" ? "operation_unsupported" : fake.reason); send(501, GENERAL_FAKE_CANNOT_ANSWER_BODY); return; }
    const rest = match[2] ?? "";
    const result = answerOpenApiFake(fake.fake, request.method ?? "", rest.startsWith("/") ? rest : `/${rest}`);
    if (result.kind === "cannot_answer") { options.onCall(result.reason); send(501, GENERAL_FAKE_CANNOT_ANSWER_BODY); return; }
    options.onCall("served");
    send(result.status, result.body === undefined || result.status === 204 ? undefined : JSON.stringify(result.body));
  };
  const server: Server = createServer((request, response) => {
    let size = 0;
    let refused = false;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > GENERAL_FAKES_REQUEST_BODY_MAX_BYTES && !refused) { refused = true; options.onCall("refused"); response.writeHead(413, labelled()).end(); request.destroy(); }
    });
    request.on("end", () => { if (!refused) answer(request, response); });
    request.on("error", () => undefined);
  });
  // Node answers a request it cannot parse (400), headers past its limit (431) or a timeout (408) itself, without calling the handler: those too are counted, and answered with the label.
  server.on("clientError", (error: NodeJS.ErrnoException, socket) => {
    if (!socket.writable || socket.destroyed) { socket.destroy(); return; }
    const parse = typeof error.code === "string" && (error.code.startsWith("HPE_") || error.code === "ERR_HTTP_REQUEST_TIMEOUT" || error.code === "ERR_HTTP_HEADERS_TIMEOUT");
    if (parse) options.onCall("refused");
    socket.end(`HTTP/1.1 ${error.code === "HPE_HEADER_OVERFLOW" ? "431 Request Header Fields Too Large" : "400 Bad Request"}\r\n${GENERAL_FAKE_ANSWER_HEADER}: ${GENERAL_FAKE_ANSWER_LABEL}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
  });
  if (options.callers !== undefined) {
    const allowed = new Set(options.callers);
    // Before one byte is read: a connection from another address is closed and counted, and the HTTP parser never sees it.
    server.on("connection", (socket) => {
      socket.on("error", () => undefined);
      const from = plainAddress(socket.remoteAddress);
      if (from === undefined || !allowed.has(from)) { options.onCall("foreign"); socket.destroy(); }
    });
  }
  server.maxConnections = 32;
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 1_000;
  return server;
}
