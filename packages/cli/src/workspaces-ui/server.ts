// Spec 041 FR-010..FR-012: the workspaces page's HTTP server. It binds 127.0.0.1 on an ephemeral
// port and nothing else, it exits with the command, and every request has to get past four checks
// before it is routed:
//
//   1. `Host` is this listener's own `127.0.0.1:<port>`, so a name that resolves to 127.0.0.1
//      cannot rebind onto it.
//   2. `Sec-Fetch-Site`, when the browser sends one, is `same-origin` or `none` (a typed or opened
//      address). `cross-site` and `same-site` -- another loopback port is same-site -- are refused.
//   3. `Origin` and `Referer`, when present, are this listener's own origin.
//   4. The session token, minted for this run, matches. No token, no answer.
//
// No response ever carries a CORS header, so a page on another origin cannot read one either way.
// The page is read-only: it has no route that changes anything, and the developer's AgentX tokens
// stay in the CLI process -- the browser is never given one.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AgentXError, agentXError } from "@agentx/contracts";
import { WORKSPACES_CSP, WORKSPACES_CSS, WORKSPACES_JS, workspacesHtml } from "./page.js";
import { UI_TOKEN_HEADER, UI_TOKEN_QUERY, type UiData, type UiDataReply } from "./protocol.js";

export interface WorkspacesUiServer {
  /** The address to open, session token and all. */
  url: string;
  port: number;
  token: string;
  /** Stops listening. The process must be able to exit afterwards. */
  close(): Promise<void>;
}

const SECURITY_HEADERS: Record<string, string> = {
  "cache-control": "no-store",
  "content-security-policy": WORKSPACES_CSP,
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

/**
 * `read` is the control plane call. It runs per request rather than once at startup, so the page's
 * refresh shows what is there now and a token refresh happens in the CLI, where the tokens live.
 * `port` and `token` are for tests; the defaults ask the system for a free port and mint a token.
 */
export async function startWorkspacesUiServer(input: {
  read: () => Promise<UiData>;
  port?: number;
  token?: string;
}): Promise<WorkspacesUiServer> {
  const token = input.token ?? randomBytes(32).toString("base64url");
  let expectedOrigin = "";

  const send = (response: ServerResponse, status: number, type: string, body: string) => {
    response.writeHead(status, { ...SECURITY_HEADERS, "content-type": type, "content-length": Buffer.byteLength(body) });
    response.end(body);
  };
  const json = (response: ServerResponse, status: number, reply: UiDataReply) =>
    send(response, status, "application/json; charset=utf-8", JSON.stringify(reply));

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? "/", expectedOrigin);
    const refusal = refusalReason({
      host: headerValue(request, "host"),
      origin: headerValue(request, "origin"),
      referer: headerValue(request, "referer"),
      secFetchSite: headerValue(request, "sec-fetch-site"),
      token: headerValue(request, UI_TOKEN_HEADER) ?? url.searchParams.get(UI_TOKEN_QUERY) ?? undefined,
      expectedOrigin,
      expectedToken: token,
    });
    if (refusal !== undefined) return send(response, refusal.status, "text/plain; charset=utf-8", `${refusal.reason}\n`);

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return send(response, 200, "text/html; charset=utf-8", workspacesHtml(token));
    }
    if (request.method === "GET" && url.pathname === "/app.css") return send(response, 200, "text/css; charset=utf-8", WORKSPACES_CSS);
    if (request.method === "GET" && url.pathname === "/app.js") return send(response, 200, "text/javascript; charset=utf-8", WORKSPACES_JS);
    if (request.method === "GET" && url.pathname === "/data") {
      try {
        return json(response, 200, { ok: true, data: await input.read() });
      } catch (error) {
        // An AgentX error already says what to do about it ("run agentx login <url>"), without its
        // code prefix, which means nothing to whoever is reading the page; anything else is this
        // CLI's own fault and is not repeated back to the page.
        const message = error instanceof AgentXError
          ? error.message.slice(error.code.length + 2)
          : "AgentX could not be read; check the terminal";
        return json(response, 200, { ok: false, error: message });
      }
    }
    return send(response, 404, "text/plain; charset=utf-8", "not found\n");
  };

  const server: Server = createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) send(response, 500, "text/plain; charset=utf-8", "agentx could not answer that\n");
      else response.end();
    });
  });

  await new Promise<void>((resolvePromise, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      reject(agentXError("CONFIG_INVALID", `could not open a local port on 127.0.0.1 to show your workspaces (${error.code ?? error.name}); check that no firewall or security tool blocks local ports, or run agentx workspaces --no-ui`));
    };
    server.once("error", onError);
    server.listen(input.port ?? 0, "127.0.0.1", () => { server.removeListener("error", onError); resolvePromise(); });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw agentXError("CONFIG_INVALID", "the workspaces page's listener did not bind a TCP port; run agentx workspaces --no-ui");
  const { port } = address;
  expectedOrigin = `http://127.0.0.1:${port}`;

  return {
    port,
    token,
    url: `${expectedOrigin}/?${UI_TOKEN_QUERY}=${encodeURIComponent(token)}`,
    async close() {
      await new Promise<void>((resolvePromise) => {
        server.close(() => resolvePromise());
        // A browser holds keep-alive sockets open, which would otherwise keep the process alive.
        server.closeAllConnections();
      });
    },
  };
}
