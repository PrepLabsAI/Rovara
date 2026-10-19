import { createConnection, createServer, type Server, type Socket } from "node:net";

export type AppForwarder = Readonly<{ close(): Promise<void> }>;

/**
 * Serves the candidate application on a loopback address by piping each connection to its real address. The pinned runner
 * only accepts plain HTTP for loopback hosts, so compiled suites name `http://127.0.0.1:4317`; the executor container's
 * only route to the candidate stays its alias on the internal network.
 */
export async function startAppForwarder(input: { listen: { host: string; port: number }; upstream: { host: string; port: number } }): Promise<AppForwarder> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((client) => {
    const upstream = createConnection({ host: input.upstream.host, port: input.upstream.port });
    sockets.add(client); sockets.add(upstream);
    const drop = () => { client.destroy(); upstream.destroy(); sockets.delete(client); sockets.delete(upstream); };
    client.on("error", drop); upstream.on("error", drop);
    client.on("close", drop); upstream.on("close", drop);
    client.pipe(upstream); upstream.pipe(client);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(input.listen.port, input.listen.host, () => { server.off("error", reject); resolve(); });
  });
  return Object.freeze({
    close: () => new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  });
}
