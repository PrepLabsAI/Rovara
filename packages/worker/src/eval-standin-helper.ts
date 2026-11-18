// The eval stand-in helper's container program (L4-E56, rows E5 and E6). It runs from the WORKER'S OWN image (`node dist/eval-standin-helper.js`; the model helper's, the fake helper's and the general fakes helper's pattern) on the eval
// round's own network, beside the sealed eval box, with arguments the worker built from numbers and ids (eval-standin-hosted.ts). It has two modes and nothing else:
//   SERVE      `--listen <ipv4> --caller <ipv4> --digest <64 hex> --workspace <uuid> --operation <uuid> --lifetime-ms <int>`: loads the one set at EVAL_STAND_IN_SET_PATH (the worker's file, mounted read-only), serves ONLY a set that
//              hashes to the digest and is bound to this company and task, listens on `--listen` (never a wildcard, never loopback) on port 80 (plain HTTP) and port 443 (HTTPS, certificates from the round's own authority),
//              serves the one `--caller` address and closes every other connection unread, answers EVERY request (a stand-in never stops: see eval-standin-server.ts), labels every answer, and keeps a summary of counts and the
//              answers it made on its own tmpfs, rewritten before each answer is sent. It has a deadline of its own: `--lifetime-ms` after it starts it closes every connection and exits.
//   SUMMARIZE  `--summarize`: prints ONE line of JSON, the summary. The worker runs it by `docker exec` while the helper is up and builds the run's counts, the answers for the round's book and the gap names from the line alone.
// No path, URL, name or secret is an argument (the set's and the summary's places are fixed), the program takes nothing from the environment, and it makes no outbound connection: its import graph is walked by a test
// (tests/unit/worker-eval-standin-helper-import-graph.test.ts) and reaches the contracts only through the narrow entry `@agentx/contracts/eval-standin-helper`. The authority's private key is read from the set and kept in memory:
// it is never written anywhere and never sent.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import type { Server } from "node:http";
import type { Server as TlsServer } from "node:https";
import {
  EVAL_STAND_IN_HTTP_PORT, EVAL_STAND_IN_LEDGER_DIR, EVAL_STAND_IN_SET_MAX_BYTES, EVAL_STAND_IN_SET_PATH, EVAL_STAND_IN_SUMMARY_PATH, EVAL_STAND_IN_TLS_PORT, EvalAnswerBook, UNTRUSTED_EVAL_STAND_IN_SUMMARY,
  parseEvalStandInSetBytes, parseEvalStandInSummaryText,
  type EvalStandInBookEntry, type EvalStandInSummary, type TrustedEvalStandInSummary,
} from "@agentx/contracts/eval-standin-helper";
import { createLeafMinter } from "./run-ca.js";
import { createEvalStandInServers } from "./eval-standin-server.js";

const DIGEST = /^[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
/** Where the additions (answers made during the run) are kept beside the summary: rewritten only when the book grew, so a call costs a small write. */
export const EVAL_STAND_IN_ADDITIONS_PATH = `${EVAL_STAND_IN_LEDGER_DIR}/additions.json`;

/** The one error of this program; its message is a fixed word and carries no value. */
export class EvalStandInHelperRefused extends Error {
  constructor(readonly reason: "arguments" | "set" | "summary") {
    super(`eval stand-in helper refused: ${reason}`);
    this.name = "EvalStandInHelperRefused";
  }
}

export const EVAL_STAND_IN_HELPER_MIN_LIFETIME_MS = 1_000;
export const EVAL_STAND_IN_HELPER_MAX_LIFETIME_MS = 86_400_000;
const LIFETIME = /^[1-9][0-9]{3,8}$/u;

export interface EvalStandInServeArguments { readonly listen: string; readonly caller: string; readonly digest: string; readonly workspaceId: string; readonly operationId: string; readonly lifetimeMs: number }

function valuesOf(argv: readonly string[], name: string): string[] {
  const values: string[] = [];
  for (let at = 0; at < argv.length; at += 1) {
    if (argv[at] !== `--${name}`) continue;
    const value = argv[at + 1];
    if (value === undefined || value.startsWith("--")) throw new EvalStandInHelperRefused("arguments");
    values.push(value);
  }
  return values;
}
function one(argv: readonly string[], name: string): string {
  const values = valuesOf(argv, name);
  if (values.length !== 1) throw new EvalStandInHelperRefused("arguments");
  return values[0]!;
}
const refuse = (): never => { throw new EvalStandInHelperRefused("arguments"); };

/** The arguments of serving, strictly: an unknown flag, a repeated one, a name instead of an address, a wildcard, the loopback or an id that is not a UUID is refused. */
export function parseEvalStandInServeArguments(argv: readonly string[]): EvalStandInServeArguments {
  const known = new Set(["listen", "caller", "digest", "workspace", "operation", "lifetime-ms"]);
  for (const token of argv) if (token.startsWith("--") && !known.has(token.slice(2))) refuse();
  const listen = one(argv, "listen");
  const caller = one(argv, "caller");
  const digest = one(argv, "digest");
  const workspaceId = one(argv, "workspace");
  const operationId = one(argv, "operation");
  const lifetimeText = one(argv, "lifetime-ms");
  const lifetimeMs = LIFETIME.test(lifetimeText) ? Number(lifetimeText) : Number.NaN;
  if (!(lifetimeMs >= EVAL_STAND_IN_HELPER_MIN_LIFETIME_MS && lifetimeMs <= EVAL_STAND_IN_HELPER_MAX_LIFETIME_MS)) refuse();
  if (isIP(listen) !== 4 || isIP(caller) !== 4 || listen === "0.0.0.0" || listen.startsWith("127.") || listen === caller || !DIGEST.test(digest) || !UUID.test(workspaceId) || !UUID.test(operationId)) refuse();
  return { listen, caller, digest, workspaceId, operationId, lifetimeMs };
}

export function isEvalStandInSummarizeRequest(argv: readonly string[]): boolean {
  return argv.length === 1 && argv[0] === "--summarize";
}

export interface SummaryFiles {
  write(path: string, text: string): void;
  read(path: string): string;
}
const realFiles: SummaryFiles = {
  // Written beside and renamed over, so a read by `docker exec` sees a whole file or the one before it, never half of one.
  write: (path, text) => { writeFileSync(`${path}.next`, text, { mode: 0o600 }); renameSync(`${path}.next`, path); },
  read: (path) => readFileSync(path, "utf8"),
};

export interface RunningEvalStandInHelper {
  readonly http: Server;
  readonly tls: TlsServer;
  readonly httpPort: number;
  readonly tlsPort: number;
  /** The summary as of now. */
  summary(): TrustedEvalStandInSummary;
  close(): Promise<void>;
}

export interface ServeEvalStandInOptions {
  readonly readFile?: ((path: string) => Uint8Array) | undefined;
  readonly files?: SummaryFiles | undefined;
  /** Test seams: the ports (the program's own are 80 and 443), the files' places, the address (default: `args.listen`). */
  readonly httpPort?: number | undefined;
  readonly tlsPort?: number | undefined;
  readonly summaryPath?: string | undefined;
  readonly additionsPath?: string | undefined;
  readonly now?: (() => number) | undefined;
  /** Test seam: what the deadline calls to end the process (the program's own is `process.exit`). */
  readonly exit?: ((code: number) => void) | undefined;
}

/** The most the additions file may weigh: past it the helper keeps serving (the answers are the same pure function of the request) and the summary says "saturated". */
const ADDITIONS_MAX_BYTES = 3 * 1024 * 1024;

/**
 * Loads the pinned set and starts serving. Throws `EvalStandInHelperRefused` for a set that is not the pinned one, is bound to another company or task, or cannot be read; nothing listens then and no summary is written
 * (a summary that is missing is an untrusted one).
 */
export async function serveEvalStandIn(args: EvalStandInServeArguments, options: ServeEvalStandInOptions = {}): Promise<RunningEvalStandInHelper> {
  const read = options.readFile ?? ((path: string): Uint8Array => readFileSync(path));
  const files = options.files ?? realFiles;
  const summaryPath = options.summaryPath ?? EVAL_STAND_IN_SUMMARY_PATH;
  const additionsPath = options.additionsPath ?? EVAL_STAND_IN_ADDITIONS_PATH;
  let set: ReturnType<typeof parseEvalStandInSetBytes>;
  try {
    const bytes = read(EVAL_STAND_IN_SET_PATH);
    set = bytes.length > EVAL_STAND_IN_SET_MAX_BYTES ? undefined : parseEvalStandInSetBytes(bytes, { digest: args.digest, workspaceId: args.workspaceId, operationId: args.operationId });
  } catch { throw new EvalStandInHelperRefused("set"); }
  if (set === undefined) throw new EvalStandInHelperRefused("set");
  const book = new EvalAnswerBook();
  for (const recorded of set.recorded) book.preloadRecorded(recorded);
  for (const entry of set.book) book.restore(entry);
  const initial = new Set(book.snapshot().map((entry) => entry.key));
  let minter: ReturnType<typeof createLeafMinter>;
  try { minter = createLeafMinter(set.ca, options.now); } catch { throw new EvalStandInHelperRefused("set"); }
  const servers = createEvalStandInServers({ plan: set.plan, book, minter, defaultName: args.listen, callers: [args.caller], beforeSend: () => { try { record(); } catch { stop(); } } });

  let additionsSize = -1;
  let additionsDropped = false;
  const additionsOf = (): EvalStandInBookEntry[] => book.snapshot().filter((entry) => !initial.has(entry.key));
  const current = (): TrustedEvalStandInSummary => {
    const stats = servers.stats();
    const additions = additionsOf();
    const counts = book.counts();
    return {
      schemaVersion: 1, trusted: true, workspaceId: args.workspaceId, operationId: args.operationId, digest: args.digest,
      counts: { ...counts, saturated: counts.saturated || additionsDropped },
      foreign: stats.foreign, refused: stats.refused, tlsFailed: stats.tlsFailed, additions, gaps: stats.gaps, newHosts: stats.newHosts,
    };
  };
  /** The small summary (everything but the additions) and, when the book grew, the additions. Written BEFORE the answer is sent: a summary read after an answer arrived always includes it. */
  const record = (): void => {
    // The small summary is the full one without its additions (JSON drops an undefined member): they are kept in a file of their own.
    files.write(summaryPath, `${JSON.stringify({ ...current(), additions: undefined })}\n`);
    const added = additionsOf();
    if (added.length !== additionsSize) {
      let text = JSON.stringify(added);
      if (text.length > ADDITIONS_MAX_BYTES) { additionsDropped = true; text = "[]"; }
      files.write(additionsPath, `${text}\n`);
      additionsSize = added.length;
    }
  };
  // The first summary exists before anything listens: a helper that cannot write it never serves.
  try { record(); } catch { throw new EvalStandInHelperRefused("summary"); }
  const stop = (): void => { for (const server of [servers.http, servers.tls]) { if (server === undefined) continue; server.close(); server.closeAllConnections(); } };

  const listen = (server: Server | TlsServer, port: number): Promise<number> => new Promise<number>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, args.listen, () => {
      const address = server.address();
      if (address === null || typeof address === "string" || address.address !== args.listen) { rejectListen(new EvalStandInHelperRefused("arguments")); return; }
      resolveListen(address.port);
    });
  });
  const tls = servers.tls;
  if (tls === undefined) throw new EvalStandInHelperRefused("set");
  let httpPort: number;
  let tlsPort: number;
  try {
    httpPort = await listen(servers.http, options.httpPort ?? EVAL_STAND_IN_HTTP_PORT);
    tlsPort = await listen(tls, options.tlsPort ?? EVAL_STAND_IN_TLS_PORT);
  } catch (error) {
    stop();
    throw error instanceof EvalStandInHelperRefused ? error : new EvalStandInHelperRefused("arguments");
  }
  let closed: Promise<void> | undefined;
  const exit = options.exit ?? ((code: number): void => { process.exit(code); });
  const deadline = setTimeout(() => { stop(); exit(0); }, args.lifetimeMs);
  deadline.unref();
  servers.http.once("close", () => { clearTimeout(deadline); });
  return {
    http: servers.http, tls, httpPort, tlsPort, summary: current,
    close: () => (closed ??= new Promise<void>((resolveClose) => {
      let open = 2;
      const done = (): void => { open -= 1; if (open === 0) resolveClose(); };
      servers.http.closeAllConnections(); tls.closeAllConnections();
      servers.http.close(done); tls.close(done);
    })),
  };
}

/** The summary the files hold, or the untrusted one. Never throws: a file that is missing, too big or not a summary says nothing. */
export function summarizeEvalStandIn(files: SummaryFiles = realFiles, paths: { summary: string; additions: string } = { summary: EVAL_STAND_IN_SUMMARY_PATH, additions: EVAL_STAND_IN_ADDITIONS_PATH }): EvalStandInSummary {
  try {
    const small = JSON.parse(files.read(paths.summary)) as Record<string, unknown>;
    let additions: unknown = [];
    try { additions = JSON.parse(files.read(paths.additions)); } catch { additions = []; }
    return parseEvalStandInSummaryText(`${JSON.stringify({ ...small, additions })}\n`) ?? UNTRUSTED_EVAL_STAND_IN_SUMMARY;
  } catch { return UNTRUSTED_EVAL_STAND_IN_SUMMARY; }
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  if (isEvalStandInSummarizeRequest(argv)) {
    process.stdout.write(`${JSON.stringify(summarizeEvalStandIn())}\n`);
    return;
  }
  const helper = await serveEvalStandIn(parseEvalStandInServeArguments(argv));
  const end = (): void => { void helper.close().finally(() => process.exit(0)); };
  process.on("SIGTERM", end);
  process.on("SIGINT", end);
}

if (process.argv[1]?.endsWith("eval-standin-helper.js")) {
  main().catch(() => { process.exit(1); });
}
