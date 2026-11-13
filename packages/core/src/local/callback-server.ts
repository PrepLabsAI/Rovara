// Port lane L4b: the listener a local worker's callbacks arrive on.
//
// The main server (http-server.ts) answers the owner: it binds 127.0.0.1, accepts a Host of 127.0.0.1 or localhost and every
// route. A worker cannot call it, and must not be able to: a worker is code that may be driven by a repository. This second
// listener answers workers and nothing else:
//   - only `POST /v1/internal/...`, the routes the worker calls back (callback-client.ts), so none of the owner's routes; and, when a
//     model proxy is given (lane L9a), `GET /v1/internal/model-access` and `POST /v1/internal/model-proxy/...`, which it answers itself
//     (a model call is streamed, so it does not go through the buffered handler)
//   - a Host of `host.docker.internal:<port>`, the name the egress gateway of a worker machine gives it (isolation/stack.ts),
//     which is why the main server's Host check refuses these requests
//   - never a browser (no Origin header), a body up to 8 MiB
//   - bound to 127.0.0.1 only (Docker Desktop and Colima carry a container's `host.docker.internal` to the computer's loopback),
//     and on Linux also a Unix socket in the 0700 state folder, mounted into the gateway: there the host gateway address is not
//     loopback, and the socket opens the broker to no network at all.
// The gateway checks the path and the worker's own workspace id before it relays; the broker's handler checks the callback capability.
import { chmod, lstat, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { BrokerResponse } from "../handler.js";
import { LOCAL_HOST, type LocalRequestHandler } from "./http-server.js";
import { MODEL_ACCESS_PATH, MODEL_PROXY_PREFIX, type LocalModelProxy } from "./model-proxy/proxy.js";
import { ensurePrivateDirectory } from "./state-directory.js";

export const CALLBACK_MAX_BYTES = 8 * 1_048_576;
export const CALLBACK_SOCKET_FILE = "callback.sock";
export const RUN_DIRECTORY_NAME = "run";
/** A Unix socket path must fit `sun_path` (104 bytes on macOS, 108 on Linux). */
const MAX_SOCKET_PATH = 100;

export interface CallbackServer {
  readonly tcpPort: number;
  /** The folder holding the Unix socket, when one is served (Linux only). */
  readonly socketDirectory: string | undefined;
  close(): Promise<void>;
}

export interface CallbackServerOptions {
  handler: LocalRequestHandler;
  stateDirectory: string;
  /** Serve a Unix socket too. Default: on Linux. */
  unixSocket?: boolean;
  /** The local model proxy (K1). Absent: a worker's model calls are refused like any other route that is not a callback. */
  modelProxy?: Pick<LocalModelProxy, "access" | "handle"> | undefined;
}

const isLoopback = (address: string | undefined): boolean => address === "127.0.0.1" || address === "::ffff:127.0.0.1";
const INTERNAL_PREFIX = "/v1/internal/";

function refuse(response: ServerResponse, statusCode: number, code: string): void {
  response.writeHead(statusCode, { "content-type": "application/json", "cache-control": "no-store", connection: "close" });
  response.end(JSON.stringify({ error: { code, message: code.replaceAll("_", " ") } }));
}

async function readBody(request: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).byteLength;
    if (size > CALLBACK_MAX_BYTES) return undefined;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function makeServer(handler: LocalRequestHandler, allowedHost: () => string, peerMustBeLoopback: boolean, modelProxy: CallbackServerOptions["modelProxy"]): Server {
  const server = createServer({ maxHeaderSize: 16_384 }, (request, response) => {
    void (async () => {
      if (peerMustBeLoopback && !isLoopback(request.socket.remoteAddress)) return request.socket.destroy();
      if (request.headers.host?.toLowerCase() !== allowedHost()) return refuse(response, 403, "host_not_allowed");
      if (request.headers.origin !== undefined) return refuse(response, 403, "origin_not_allowed");
      const path = request.url ?? "/";
      if (modelProxy !== undefined && path.startsWith(INTERNAL_PREFIX) && !path.includes("..") && !path.includes("//")) {
        const bare = path.split("?")[0] ?? path;
        if (request.method === "GET" && bare === MODEL_ACCESS_PATH) {
          const headers: Record<string, string | undefined> = {};
          for (const [name, value] of Object.entries(request.headers)) headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
          const answer = await modelProxy.access({ path, headers });
          response.writeHead(answer.statusCode, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", ...answer.headers });
          return void response.end(answer.body);
        }
        if (bare.startsWith(`${MODEL_PROXY_PREFIX}/`)) return await modelProxy.handle(request, response);
      }
      // The design review's reviewers read their packets, and a stage reads its source tool list, with a GET (core/design-review/packet-route.ts, app/context-tools.ts); nothing else but a POST is a callback.
      if (request.method === "GET" && path.startsWith(INTERNAL_PREFIX) && !path.includes("..") && !path.includes("//") && /^\/v1\/internal\/(?:design-review\/packet\?slot=[a-z0-9][a-z0-9_-]{0,31}|context-tools)$/u.test(path)) {
        const headers: Record<string, string | undefined> = {};
        for (const [name, value] of Object.entries(request.headers)) headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
        let answer: BrokerResponse;
        try {
          answer = await handler({ method: "GET", path, headers });
        } catch {
          return refuse(response, 500, "internal_error");
        }
        response.writeHead(answer.statusCode, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", ...answer.headers });
        return void response.end(answer.body);
      }
      if (request.method !== "POST") return refuse(response, 405, "method_not_allowed");
      if (!path.startsWith(INTERNAL_PREFIX) || path.includes("..") || path.includes("//")) return refuse(response, 404, "not_found");
      const body = await readBody(request);
      if (body === undefined) return refuse(response, 413, "request_too_large");
      const headers: Record<string, string | undefined> = {};
      for (const [name, value] of Object.entries(request.headers)) headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
      let answer: BrokerResponse;
      try {
        answer = await handler({ method: "POST", path, headers, ...(body === "" ? {} : { body }) });
      } catch {
        return refuse(response, 500, "internal_error");
      }
      response.writeHead(answer.statusCode, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", ...answer.headers });
      response.end(answer.body);
    })().catch(() => {
      if (!response.headersSent) refuse(response, 500, "internal_error");
      else response.destroy();
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 120_000;
  return server;
}

export async function startCallbackServer(options: CallbackServerOptions): Promise<CallbackServer> {
  let tcpPort = 0;
  const tcp = makeServer(options.handler, () => `host.docker.internal:${tcpPort}`, true, options.modelProxy);
  await new Promise<void>((resolve, reject) => {
    tcp.once("error", reject);
    tcp.listen({ host: LOCAL_HOST, port: 0, exclusive: true }, () => {
      const address = tcp.address() as AddressInfo;
      if (address.address !== LOCAL_HOST) {
        tcp.close();
        return reject(new Error("the callback server did not bind to 127.0.0.1"));
      }
      tcpPort = address.port;
      tcp.removeListener("error", reject);
      resolve();
    });
  });

  let unix: Server | undefined;
  let socketDirectory: string | undefined;
  const wantSocket = options.unixSocket ?? process.platform === "linux";
  if (wantSocket) {
    try {
      const directory = await ensurePrivateDirectory(join(options.stateDirectory, RUN_DIRECTORY_NAME));
      const socketPath = join(directory, CALLBACK_SOCKET_FILE);
      if (socketPath.length <= MAX_SOCKET_PATH) {
        // A socket left by a crashed run; anything else at that name is not ours to delete.
        const found = await lstat(socketPath).catch(() => undefined);
        if (found?.isSocket() === true) await rm(socketPath, { force: true });
        const server = makeServer(options.handler, () => `host.docker.internal:${tcpPort}`, false, options.modelProxy);
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(socketPath, () => {
            server.removeListener("error", reject);
            resolve();
          });
        });
        await chmod(socketPath, 0o600);
        unix = server;
        socketDirectory = directory;
      }
    } catch {
      // No socket: the loopback listener is still served; on Linux the gateway then cannot reach it, and a start says so.
      unix = undefined;
      socketDirectory = undefined;
    }
  }

  return {
    tcpPort,
    socketDirectory,
    close: async () => {
      for (const server of [tcp, unix]) {
        if (server === undefined) continue;
        await new Promise<void>((done) => {
          server.close(() => done());
          server.closeAllConnections();
        });
      }
    },
  };
}
