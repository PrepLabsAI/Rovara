import { readFile } from "node:fs/promises";
import { startIsolatedHost, type IsolatedHostConfig } from "./serve-isolated.js";

/**
 * Process entry for one local isolated host.
 *
 *   node packages/host/dist/serve-isolated-main.js /absolute/path/host-config.json
 *
 * Prints one JSON "ready" line on stdout (URL, certificate and bearer *paths*, never
 * their contents), then drains the durable outbox one delivery at a time until it is
 * told to stop. Drains are serialized so the host never runs two containers at once.
 */
async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) throw new Error("usage: serve-isolated-main <config.json>");
  const config = JSON.parse(await readFile(path, "utf8")) as IsolatedHostConfig;
  const host = await startIsolatedHost(config);
  process.stdout.write(`${JSON.stringify({
    ready: true,
    url: host.url,
    certificatePath: host.certificatePath,
    bearerPath: host.bearerPath,
    workspaceId: host.workspaceId,
    conversationId: host.conversationId,
    baseCommit: host.baseCommit,
    node: process.version,
    pid: process.pid,
  })}\n`);

  let stopping = false;
  let draining: Promise<unknown> = Promise.resolve();
  const intervalMs = Number(process.env.AGENTX_DRAIN_INTERVAL_MS ?? "250");
  const timer = setInterval(() => {
    if (stopping) return;
    draining = draining.then(async () => {
      if (stopping) return;
      const outcomes = await host.drainOnce();
      for (const outcome of outcomes) process.stderr.write(`${JSON.stringify({ drained: outcome })}\n`);
    }).catch((error: unknown) => {
      process.stderr.write(`${JSON.stringify({ drainError: error instanceof Error ? error.message : "drain failed" })}\n`);
    });
  }, intervalMs);

  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    await draining.catch(() => undefined);
    await host.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop());
  process.on("SIGINT", () => void stop());
  process.stdin.on("end", () => void stop());
  process.stdin.resume();
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(70);
});
