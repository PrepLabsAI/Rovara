// The sealed DNS helper's program (test services, TS16; check-sandbox.ts): one run's name server in a container of its own at .2 of the run's services network. It answers the run's static table, sends every other
// name to the sinkhole, serves only the check sandbox's address (.4; the working sandbox at .3 is detached for the round), has no upstream, and keeps the unknown names it was asked in a file the worker reads with one fixed `docker exec`. Its only inputs are its
// arguments and DNS traffic. Not run by this build (no Docker): see the checks in check-sandbox.ts. (The setup run's helper, setup-dns-watch-helper.ts, is separate and unchanged.)
import { renameSync, writeFileSync } from "node:fs";
import { SealedDnsHelper } from "./setup-dns-watch.js";

function argument(name: string): string {
  const values = argumentsOf(name);
  if (values.length !== 1) throw new Error(`need exactly one --${name}`);
  return values[0]!;
}

function argumentsOf(name: string): string[] {
  const values: string[] = [];
  for (let at = 0; at < process.argv.length; at += 1) {
    if (process.argv[at] !== `--${name}`) continue;
    const value = process.argv[at + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`missing value for --${name}`);
    values.push(value);
  }
  return values;
}

/** `--host name=address` pairs into the table. A pair without one `=` or a repeated name is an error (the object refuses the rest: names and addresses are checked there). */
export function tableFromArguments(pairs: readonly string[]): Record<string, string> {
  const table: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const pair of pairs) {
    const parts = pair.split("=");
    if (parts.length !== 2 || parts[0] === "" || parts[1] === "") throw new Error("--host takes name=address");
    if (parts[0]! in table) throw new Error("a name is given twice");
    table[parts[0]!] = parts[1]!;
  }
  return table;
}

export async function main(): Promise<void> {
  const state = argument("state");
  const helper = new SealedDnsHelper({ listenAddress: argument("listen"), allowedSources: argumentsOf("source"), sinkholeAddress: argument("sinkhole"), names: tableFromArguments(argumentsOf("host")) });
  await helper.start();
  let written = "";
  const flush = (): void => {
    const next = JSON.stringify({ unknown: helper.unknownNames(), dropped: helper.droppedNames(), unrecorded: helper.unrecordedQueries() });
    if (next === written) return;
    written = next;
    // Written beside and renamed over, so a reader never sees half a file.
    writeFileSync(`${state}.tmp`, next);
    renameSync(`${state}.tmp`, state);
  };
  flush();
  const timer = setInterval(flush, 1_000);
  const end = (): void => { clearInterval(timer); flush(); void helper.stop().finally(() => process.exit(0)); };
  process.on("SIGTERM", end);
  process.on("SIGINT", end);
}

if (process.argv[1]?.endsWith("sealed-dns-helper.js")) void main();
