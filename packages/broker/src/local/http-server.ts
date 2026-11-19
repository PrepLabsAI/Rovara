// Port lane L4: the HTTP server of `rovara up`. It listens on 127.0.0.1 only (a random free port unless one is asked for) and
// refuses anything that is not a request from this machine to this server: a peer that is not loopback, a Host header that is not
// this server's own name (DNS rebinding), and a browser request from another origin. Bodies are capped.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { BrokerRequest, BrokerResponse } from "../handler.js";

export const LOCAL_HOST = "127.0.0.1";
export const MAX_REQUEST_BYTES = 1_048_576;

export type LocalRequestHandler = (request: BrokerRequest) => Promise<BrokerResponse>;

export interface LocalHttpServer {
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

export interface LocalHttpServerOptions {
  handler: LocalRequestHandler;
  /** 0 (the default) asks the system for a free port. */
  port?: number;
}

const isLoopback = (address: string | undefined): boolean => address === "127.0.0.1" || address === "::ffff:127.0.0.1";

function send(response: ServerResponse, statusCode: number, body: string, headers: Record<string, string> = {}): void {
  response.writeHead(statusCode, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers });
  response.end(body);
}

const refuse = (response: ServerResponse, statusCode: number, code: string): void => send(response, statusCode, JSON.stringify({ error: { code, message: code.replaceAll("_", " ") } }));

async function readBody(request: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).byteLength;
    if (size > MAX_REQUEST_BYTES) return undefined;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function startLocalHttpServer(options: LocalHttpServerOptions): Promise<LocalHttpServer> {
  let allowedHosts = new Set<string>();
  let allowedOrigins = new Set<string>();
  const server: Server = createServer({ maxHeaderSize: 16_384 }, (request, response) => {
    void (async () => {
      if (!isLoopback(request.socket.remoteAddress)) return request.socket.destroy();
      const host = request.headers.host;
      if (host === undefined || !allowedHosts.has(host.toLowerCase())) return refuse(response, 403, "host_not_allowed");
      const origin = request.headers.origin;
      if (origin !== undefined && !allowedOrigins.has(origin.toLowerCase())) return refuse(response, 403, "origin_not_allowed");
      const method = request.method ?? "GET";
      if (method !== "GET" && method !== "POST") return refuse(response, 405, "method_not_allowed");
      const body = method === "POST" ? await readBody(request) : undefined;
      if (method === "POST" && body === undefined) return refuse(response, 413, "request_too_large");
      const headers: Record<string, string | undefined> = {};
      for (const [name, value] of Object.entries(request.headers)) headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
      let answer: BrokerResponse;
      try {
        answer = await options.handler({ method, path: request.url ?? "/", headers, ...(body === undefined || body === "" ? {} : { body }) });
      } catch {
        return refuse(response, 500, "internal_error");
      }
      send(response, answer.statusCode, answer.body, answer.headers);
    })().catch(() => {
      if (!response.headersSent) refuse(response, 500, "internal_error");
      else response.destroy();
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    // The host is named, never left to the default: a bare listen() would take every interface.
    server.listen({ host: LOCAL_HOST, port: options.port ?? 0, exclusive: true }, () => {
      const address = server.address() as AddressInfo;
      if (address.address !== LOCAL_HOST) {
        server.close();
        return reject(new Error("the server did not bind to 127.0.0.1"));
      }
      const port = address.port;
      allowedHosts = new Set([`${LOCAL_HOST}:${port}`, `localhost:${port}`]);
      allowedOrigins = new Set([`http://${LOCAL_HOST}:${port}`, `http://localhost:${port}`]);
      server.removeListener("error", reject);
      resolve({
        port,
        url: `http://${LOCAL_HOST}:${port}`,
        close: () => new Promise<void>((done) => {
          server.close(() => done());
          server.closeAllConnections();
        }),
      });
    });
  });
}
