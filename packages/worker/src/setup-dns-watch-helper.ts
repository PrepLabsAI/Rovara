// The helper container's program (sh-setup-wire, SH14; setup-network.ts): one setup run's DNS watch, in a container of its own on the run's network. It listens on the helper's address, serves only the
// sandbox's address, relays every answer byte for byte, and keeps the names the resolver refused in a file the worker reads with one fixed `docker exec`. It has no command output, no repository text and
// no secret: its only inputs are its four arguments and DNS traffic. Not run by this build (no Docker): see the checks in setup-network.ts.
import { writeFileSync, renameSync } from "node:fs";
import { SetupDnsWatch } from "./setup-dns-watch.js";

function argument(name: string): string {
  const at = process.argv.indexOf(`--${name}`);
  const value = at < 0 ? undefined : process.argv[at + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`missing --${name}`);
  return value;
}

export async function main(): Promise<void> {
  const state = argument("state");
  const watch = new SetupDnsWatch({ listenAddress: argument("listen"), upstream: { address: argument("upstream") }, allowedSources: [argument("source")] });
  await watch.start();
  let written = "";
  const flush = (): void => {
    const next = JSON.stringify(watch.blockedHosts());
    if (next === written) return;
    written = next;
    // Written beside and renamed over, so a reader never sees half a file.
    writeFileSync(`${state}.tmp`, next);
    renameSync(`${state}.tmp`, state);
  };
  flush();
  const timer = setInterval(flush, 1_000);
  const end = (): void => { clearInterval(timer); flush(); void watch.stop().finally(() => process.exit(0)); };
  process.on("SIGTERM", end);
  process.on("SIGINT", end);
}

if (process.argv[1]?.endsWith("setup-dns-watch-helper.js")) void main();
