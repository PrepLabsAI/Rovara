// FR-001, FR-002, FR-010 and FR-011: the wizard's HTTP server. It binds 127.0.0.1 on an ephemeral
// port and nothing else, it exits with the run, and every single request has to get past four
// checks before it is routed:
//
//   1. `Host` is this listener's own `127.0.0.1:<port>`, so a name that resolves to 127.0.0.1
//      cannot rebind onto it.
//   2. `Sec-Fetch-Site`, when the browser sends one, is `same-origin` or `none` (a typed or opened
//      address). `cross-site` and `same-site` -- another loopback port is same-site -- are refused.
//   3. `Origin` and `Referer`, when present, are this listener's own origin.
//   4. The session token, minted for this run, matches. No token, no answer.
//
// No response ever carries a CORS header, so a page on another origin cannot read one either way.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { agentXError } from "@agentx/contracts";
import { WIZARD_CSP, WIZARD_CSS, WIZARD_JS, wizardHtml } from "./page.js";
import { WIZARD_TOKEN_HEADER, WIZARD_TOKEN_QUERY, type AnswerReply } from "./protocol.js";
import type { WizardHub, WizardListener } from "./state.js";

/** An answer body larger than this is refused unread; the biggest real one is a PEM private key. */
const MAX_BODY_BYTES = 64 * 1024;
/** Keeps a browser from dropping an idle event stream while a deploy step runs for minutes. */
const HEARTBEAT_MS = 20_000;

export interface WizardServer {
  /** The address to open, session token and all. */
  url: string;
  port: number;
  token: string;
  /** Ends every event stream and stops listening. The process must be able to exit afterwards. */
  close(): Promise<void>;
}

const SECURITY_HEADERS: Record<string, string> = {
  "cache-control": "no-store",
  "content-security-policy": WIZARD_CSP,
  "referrer-policy": "same-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

function tokensMatch(provided: string | undefined, expected: string): boolean {
  if (provided === undefined) return false;
  const given = Buffer.from(provided, "utf8");
  const want = Buffer.from(expected, "utf8");
  return given.length === want.length && timingSafeEqual(given, want);
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Why the request is refused, or undefined when it may be routed. Order matters only for the
 * message a test reads back; any one failing is a refusal. */
export function refusalReason(input: {
  host: string | undefined; origin: string | undefined; referer: string | undefined; secFetchSite: string | undefined;
  token: string | undefined; expectedOrigin: string; expectedToken: string;
}): { status: number; reason: string } | undefined {
  const expectedHost = input.expectedOrigin.slice("http://".length);
  if (input.host !== expectedHost) return { status: 403, reason: "wrong Host" };
  if (input.secFetchSite !== undefined && input.secFetchSite !== "same-origin" && input.secFetchSite !== "none") {
    return { status: 403, reason: "cross-site request" };
  }
  if (input.origin !== undefined && input.origin !== input.expectedOrigin) return { status: 403, reason: "wrong Origin" };
  if (input.referer !== undefined) {
    let refererOrigin: string;
    try {
      refererOrigin = new URL(input.referer).origin;
    } catch {
      return { status: 403, reason: "unreadable Referer" };
    }
    if (refererOrigin !== input.expectedOrigin) return { status: 403, reason: "wrong Referer" };
  }
  if (!tokensMatch(input.token, input.expectedToken)) return { status: 401, reason: "wrong or missing session token" };
  return undefined;
}

async function readBody(request: IncomingMessage): Promise<string | undefined> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return undefined;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** `port` is for tests; the default 0 asks the system for a free one. `token` likewise. */
export async function startWizardServer(input: { hub: WizardHub; port?: number; token?: string }): Promise<WizardServer> {
  const token = input.token ?? randomBytes(32).toString("base64url");
  const streams = new Set<ServerResponse>();
  let expectedOrigin = "";

  const send = (response: ServerResponse, status: number, type: string, body: string) => {
    response.writeHead(status, { ...SECURITY_HEADERS, "content-type": type, "content-length": Buffer.byteLength(body) });
    response.end(body);
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? "/", expectedOrigin);
    const refusal = refusalReason({
      host: headerValue(request, "host"),
      origin: headerValue(request, "origin"),
      referer: headerValue(request, "referer"),
      secFetchSite: headerValue(request, "sec-fetch-site"),
      token: headerValue(request, WIZARD_TOKEN_HEADER) ?? url.searchParams.get(WIZARD_TOKEN_QUERY) ?? undefined,
      expectedOrigin,
      expectedToken: token,
    });
    if (refusal !== undefined) return send(response, refusal.status, "text/plain; charset=utf-8", `${refusal.reason}\n`);

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return send(response, 200, "text/html; charset=utf-8", wizardHtml(token));
    }
    if (request.method === "GET" && url.pathname === "/app.css") return send(response, 200, "text/css; charset=utf-8", WIZARD_CSS);
    if (request.method === "GET" && url.pathname === "/app.js") return send(response, 200, "text/javascript; charset=utf-8", WIZARD_JS);
    if (request.method === "GET" && url.pathname === "/state") {
      return send(response, 200, "application/json; charset=utf-8", JSON.stringify(input.hub.snapshot()));
    }
    if (request.method === "GET" && url.pathname === "/events") return openStream(response);
    if (request.method === "POST" && url.pathname === "/answer") return answer(request, response);
    return send(response, 404, "text/plain; charset=utf-8", "not found\n");
  };

  const openStream = (response: ServerResponse): void => {
    response.writeHead(200, { ...SECURITY_HEADERS, "content-type": "text/event-stream; charset=utf-8", connection: "keep-alive" });
    // Node buffers small writes by default; an event stream has to leave at once.
    response.socket?.setNoDelay(true);
    response.write(sse("snapshot", input.hub.snapshot()));
    streams.add(response);
    const listener: WizardListener = {
      state: (state) => { response.write(sse("state", state)); },
      log: (line) => { response.write(sse("log", line)); },
      closed: () => { response.write(sse("closed", {})); response.end(); },
    };
    const unsubscribe = input.hub.subscribe(listener);
    const heartbeat = setInterval(() => response.write(": ping\n\n"), HEARTBEAT_MS);
    heartbeat.unref();
    const stop = () => { clearInterval(heartbeat); unsubscribe(); streams.delete(response); };
    response.on("close", stop);
    response.on("error", stop);
  };

  const answer = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const refuse = (error: string) => send(response, 400, "application/json; charset=utf-8", JSON.stringify({ ok: false, error } satisfies AnswerReply));
    const body = await readBody(request);
    if (body === undefined) return refuse("that answer is too large");
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return refuse("that answer could not be read");
    }
    const value = parsed as { id?: unknown; value?: unknown };
    if (typeof value.id !== "string" || typeof value.value !== "string") return refuse("that answer could not be read");
    const problem = input.hub.answer(value.id, value.value);
    if (problem !== undefined) return refuse(problem);
    return send(response, 200, "application/json; charset=utf-8", JSON.stringify({ ok: true } satisfies AnswerReply));
  };

  const server: Server = createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) send(response, 500, "text/plain; charset=utf-8", "the install wizard could not answer that\n");
      else response.end();
    });
  });

  await new Promise<void>((resolvePromise, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      reject(agentXError("CONFIG_INVALID", `could not open a local port on 127.0.0.1 for the install wizard (${error.code ?? error.name}); check that no firewall or security tool blocks local ports, or run agentx init --no-ui`));
    };
    server.once("error", onError);
    server.listen(input.port ?? 0, "127.0.0.1", () => { server.removeListener("error", onError); resolvePromise(); });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw agentXError("CONFIG_INVALID", "the install wizard's listener did not bind a TCP port; run agentx init --no-ui");
  const { port } = address;
  expectedOrigin = `http://127.0.0.1:${port}`;

  return {
    port,
    token,
    url: `${expectedOrigin}/?${WIZARD_TOKEN_QUERY}=${encodeURIComponent(token)}`,
    async close() {
      // Every stream is ended rather than destroyed, so the page sees the "closed" event it was
      // sent before the socket goes; closeAllConnections then frees the keep-alive sockets a
      // browser holds open, which would otherwise keep the process alive.
      for (const stream of streams) stream.end();
      streams.clear();
      await new Promise<void>((resolvePromise) => {
        server.close(() => resolvePromise());
        server.closeAllConnections();
      });
    },
  };
}
