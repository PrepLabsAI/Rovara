// General fakes, slice 2b (owner decision 252a): the hosted fake-helper's container program. It runs from the WORKER'S OWN image (`node dist/general-fakes-helper.js`, the model helper's and the fake helper's pattern) on the
// run's own network, beside a task sandbox, with arguments the worker built from numbers and ids (general-fakes-hosted.ts). It has two modes and nothing else:
//   SERVE      `--listen <ipv4> --caller <ipv4> --digest <64 hex> --workspace <uuid> --operation <uuid>`: loads the one set at GENERAL_FAKES_SET_PATH (the worker's file, mounted read-only), serves ONLY a set that hashes to the
//              digest and is bound to this workspace (company) and this operation (task), listens on `--listen` (never a wildcard) at GENERAL_FAKES_HELPER_PORT, serves the one `--caller` address and closes every other
//              connection unread, labels every answer `x-rovara-label: madeByRovara`, and keeps a small summary of counts on its own tmpfs, rewritten before each answer is sent.
//   SUMMARIZE  `--summarize`: prints ONE line of JSON, the summary (`GeneralFakesSummary`). The worker runs it by `docker exec` while the helper is up and builds the round's facts from the line alone.
// No path, URL, name or secret is an argument (the set's and the summary's places are fixed), the program takes nothing from the environment, and it makes no outbound connection: its import graph is walked by a test
// (tests/unit/worker-general-fakes-helper-import-graph.test.ts) and reaches the contracts only through the narrow entry `@agentx/contracts/general-fakes-helper`.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import {
  GENERAL_FAKES_HELPER_PORT, GENERAL_FAKES_SET_PATH, GENERAL_FAKES_SUMMARY_MAX_COUNT, GENERAL_FAKES_SUMMARY_PATH, GENERAL_FAKES_SET_MAX_BYTES, UNTRUSTED_GENERAL_FAKES_SUMMARY,
  parseGeneralFakesSetBytes, parseGeneralFakesSummaryText,
  type GeneralFakeServiceFake, type GeneralFakesSummary, type TrustedGeneralFakesSummary,
} from "@agentx/contracts/general-fakes-helper";
import { createGeneralFakesServer, type GeneralFakeServerCall } from "./general-fakes-server.js";
import type { Server } from "node:http";

const DIGEST = /^[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** The one error of this program; its message is a fixed word and carries no value. */
export class GeneralFakesHelperRefused extends Error {
  constructor(readonly reason: "arguments" | "set" | "summary") {
    super(`general fakes helper refused: ${reason}`);
    this.name = "GeneralFakesHelperRefused";
  }
}

export interface GeneralFakesServeArguments { readonly listen: string; readonly caller: string; readonly digest: string; readonly workspaceId: string; readonly operationId: string }

function valuesOf(argv: readonly string[], name: string): string[] {
  const values: string[] = [];
  for (let at = 0; at < argv.length; at += 1) {
    if (argv[at] !== `--${name}`) continue;
    const value = argv[at + 1];
    if (value === undefined || value.startsWith("--")) throw new GeneralFakesHelperRefused("arguments");
    values.push(value);
  }
  return values;
}
function one(argv: readonly string[], name: string): string {
  const values = valuesOf(argv, name);
  if (values.length !== 1) throw new GeneralFakesHelperRefused("arguments");
  return values[0]!;
}
const refuse = (): never => { throw new GeneralFakesHelperRefused("arguments"); };

/** The arguments of serving, strictly: an unknown flag, a repeated one, a name instead of an address, a wildcard, the loopback or an id that is not a UUID is refused. */
export function parseGeneralFakesServeArguments(argv: readonly string[]): GeneralFakesServeArguments {
  const known = new Set(["listen", "caller", "digest", "workspace", "operation"]);
  for (const token of argv) if (token.startsWith("--") && !known.has(token.slice(2))) refuse();
  const listen = one(argv, "listen");
  const caller = one(argv, "caller");
  const digest = one(argv, "digest");
  const workspaceId = one(argv, "workspace");
  const operationId = one(argv, "operation");
  if (isIP(listen) !== 4 || isIP(caller) !== 4 || listen === "0.0.0.0" || listen.startsWith("127.") || listen === caller || !DIGEST.test(digest) || !UUID.test(workspaceId) || !UUID.test(operationId)) refuse();
  return { listen, caller, digest, workspaceId, operationId };
}

export function isGeneralFakesSummarizeRequest(argv: readonly string[]): boolean {
  if (argv.length !== 1 || argv[0] !== "--summarize") return false;
  return true;
}

// ---- the summary file

interface Counters { served: number; cannotAnswer: Record<"no_spec" | "spec_unreadable" | "spec_ambiguous" | "operation_unknown" | "operation_unsupported", number>; foreign: number; unrouted: number; refused: number }
const emptyCounters = (): Counters => ({ served: 0, cannotAnswer: { no_spec: 0, spec_unreadable: 0, spec_ambiguous: 0, operation_unknown: 0, operation_unsupported: 0 }, foreign: 0, unrouted: 0, refused: 0 });

export interface SummaryFiles {
  write(path: string, text: string): void;
  read(path: string): string;
}
const realFiles: SummaryFiles = {
  // Written beside and renamed over, so a read by `docker exec` sees a whole summary or the one before it, never half of one.
  write: (path, text) => { writeFileSync(`${path}.next`, text, { mode: 0o600 }); renameSync(`${path}.next`, path); },
  read: (path) => readFileSync(path, "utf8"),
};

export interface RunningGeneralFakesHelper {
  readonly server: Server;
  readonly port: number;
  /** The summary as of now (what the file holds). */
  summary(): GeneralFakesSummary;
  close(): Promise<void>;
}

export interface ServeGeneralFakesOptions {
  readonly readFile?: ((path: string) => Uint8Array) | undefined;
  readonly files?: SummaryFiles | undefined;
  /** Test seam: the port (the program's own is GENERAL_FAKES_HELPER_PORT) and the summary's place. */
  readonly port?: number | undefined;
  readonly summaryPath?: string | undefined;
  /** Test seam: the counters' limit (the program's own is GENERAL_FAKES_SUMMARY_MAX_COUNT). */
  readonly countLimit?: number | undefined;
}

/**
 * Loads the pinned set and starts serving. Throws `GeneralFakesHelperRefused` for a set that is not the pinned one, is bound to another company or task, or cannot be read; nothing listens then and no summary is written
 * (a summary that is missing is an untrusted one).
 */
export async function serveGeneralFakes(args: GeneralFakesServeArguments, options: ServeGeneralFakesOptions = {}): Promise<RunningGeneralFakesHelper> {
  const read = options.readFile ?? ((path: string): Uint8Array => readFileSync(path));
  const files = options.files ?? realFiles;
  const summaryPath = options.summaryPath ?? GENERAL_FAKES_SUMMARY_PATH;
  let fakes: GeneralFakeServiceFake[] | undefined;
  try {
    const bytes = read(GENERAL_FAKES_SET_PATH);
    fakes = bytes.length > GENERAL_FAKES_SET_MAX_BYTES ? undefined : parseGeneralFakesSetBytes(bytes, { digest: args.digest, workspaceId: args.workspaceId, operationId: args.operationId });
  } catch {
    throw new GeneralFakesHelperRefused("set");
  }
  if (fakes === undefined) throw new GeneralFakesHelperRefused("set");
  const counters = emptyCounters();
  const limit = Math.min(options.countLimit ?? GENERAL_FAKES_SUMMARY_MAX_COUNT, GENERAL_FAKES_SUMMARY_MAX_COUNT);
  let saturated = false;
  const current = (): TrustedGeneralFakesSummary => ({ schemaVersion: 1, trusted: true, workspaceId: args.workspaceId, operationId: args.operationId, digest: args.digest, ...structuredClone(counters), saturated });
  const record = (): void => { files.write(summaryPath, `${JSON.stringify(current())}\n`); };
  // The first summary exists before anything listens: a helper that cannot write it never serves.
  try { record(); } catch { throw new GeneralFakesHelperRefused("summary"); }
  const bump = (outcome: GeneralFakeServerCall): void => {
    if (outcome === "served" || outcome === "foreign" || outcome === "refused") counters[outcome] += 1;
    else if (outcome === "unattributed") counters.unrouted += 1;
    else counters.cannotAnswer[outcome] += 1;
    // A counter never passes its limit: at it the summary says "saturated" and the worker treats its counts as lower bounds.
    const clamp = (value: number): number => { if (value >= limit) saturated = true; return Math.min(value, limit); };
    counters.served = clamp(counters.served); counters.foreign = clamp(counters.foreign); counters.unrouted = clamp(counters.unrouted); counters.refused = clamp(counters.refused);
    for (const key of Object.keys(counters.cannotAnswer) as (keyof Counters["cannotAnswer"])[]) counters.cannotAnswer[key] = clamp(counters.cannotAnswer[key]);
  };
  const server = createGeneralFakesServer({
    fakes,
    callers: [args.caller],
    // Written BEFORE the answer is sent: a summary read after an answer arrived always includes it. A write that fails leaves the old summary, which then under-counts, so the helper stops answering instead.
    onCall: (outcome) => {
      bump(outcome);
      try { record(); } catch { server.close(); server.closeAllConnections(); }
    },
  });
  const port = options.port ?? GENERAL_FAKES_HELPER_PORT;
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, args.listen, () => resolveListen());
  });
  const address = server.address();
  if (address === null || typeof address === "string" || address.address !== args.listen) {
    server.close();
    throw new GeneralFakesHelperRefused("arguments");
  }
  let closed: Promise<void> | undefined;
  return {
    server, port: address.port, summary: current,
    close: () => (closed ??= new Promise<void>((resolveClose) => { server.closeAllConnections(); server.close(() => resolveClose()); })),
  };
}

/** The summary the file holds, or the untrusted one. Never throws: a file that is missing, too big or not a summary says nothing. */
export function summarizeGeneralFakes(files: SummaryFiles = realFiles, path: string = GENERAL_FAKES_SUMMARY_PATH): GeneralFakesSummary {
  try { return parseGeneralFakesSummaryText(files.read(path)) ?? UNTRUSTED_GENERAL_FAKES_SUMMARY; } catch { return UNTRUSTED_GENERAL_FAKES_SUMMARY; }
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  if (isGeneralFakesSummarizeRequest(argv)) {
    process.stdout.write(`${JSON.stringify(summarizeGeneralFakes())}\n`);
    return;
  }
  const helper = await serveGeneralFakes(parseGeneralFakesServeArguments(argv));
  const end = (): void => { void helper.close().finally(() => process.exit(0)); };
  process.on("SIGTERM", end);
  process.on("SIGINT", end);
}

if (process.argv[1]?.endsWith("general-fakes-helper.js")) {
  main().catch(() => { process.exit(1); });
}
