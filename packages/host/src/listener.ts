import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import type { BrokerRequest } from "@agentx/broker";
import type { HostHandler } from "./dispatcher.js";

const MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface LoopbackListenerOptions {
  handler: HostHandler;
  /** PEM certificate and private key for this process only. */
  tls: { cert: string; key: string };
  port?: number;
  /** Loopback only. Binding elsewhere would expose the host beyond this machine. */
  host?: "127.0.0.1" | "::1";
}

export interface LoopbackListener {
  server: Server;
  port: number;
  url: string;
  close(): Promise<void>;
}

/**
 * Serve the host over HTTPS on loopback.
 *
 * HTTPS is not decoration here: the accepted control-plane client refuses any endpoint
 * that is not `https`, and that guard stays. The certificate is process-scoped trust
 * material supplied by the caller — this module never reads, writes or alters the
 * system trust store, and never binds beyond loopback.
 */
export async function startLoopbackListener(options: LoopbackListenerOptions): Promise<LoopbackListener> {
  const host = options.host ?? "127.0.0.1";
  const server = createServer({ cert: options.tls.cert, key: options.tls.key }, (incoming, outgoing) => {
    void (async () => {
      try {
        const body = await readBody(incoming, MAX_BODY_BYTES);
        if (body === undefined) {
          outgoing.writeHead(413, { "content-type": "application/json" });
          outgoing.end(JSON.stringify({ error: { code: "CONFIG_INVALID", message: "request body is too large" } }));
          return;
        }
        const request: BrokerRequest = {
          method: incoming.method ?? "GET",
          path: incoming.url ?? "/",
          headers: Object.fromEntries(
            Object.entries(incoming.headers).map(([name, value]) => [
              name.toLowerCase(),
              Array.isArray(value) ? value[0] : value,
            ]),
          ),
          ...(body === "" ? {} : { body }),
        };
        const response = await options.handler(request);
        outgoing.writeHead(response.statusCode, response.headers);
        outgoing.end(response.body);
      } catch {
        outgoing.writeHead(500, { "content-type": "application/json" });
        outgoing.end(JSON.stringify({ error: { code: "RUNTIME_UNAVAILABLE", message: "host request failed" } }));
      }
    })();
  });

  await new Promise<void>((resolveListening, rejectListening) => {
    server.once("error", rejectListening);
    server.listen(options.port ?? 0, host, () => {
      server.removeListener("error", rejectListening);
      resolveListening();
    });
  });

  const port = (server.address() as AddressInfo).port;
  return {
    server,
    port,
    url: `https://${host === "::1" ? "[::1]" : host}:${port}`,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

async function readBody(incoming: NodeJS.ReadableStream, limit: number): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of incoming) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > limit) return undefined;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
