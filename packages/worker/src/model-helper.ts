// TE-F2 part B (M2, release 0.5.19; DECISIONS 158): the scripted-replies model helper program. It runs from the WORKER'S OWN image (`node dist/model-helper.js`, the fake helper's pattern, fake-helper.ts) with arguments the
// worker built from numbers and paths (`modelHelperArgs`, model-helper-args.ts), beside the customer's tests: it answers a model client's calls from scripted replies, serves the failure pack, answers the GCE metadata server for
// Vertex, and records who called what. It is NOT test services (no `tx`), it is labelled "not sealed" until the sealed round exists (O44), and it has no outbound socket of any kind.
//   SERVE      starts the HTTP loop (model-helper-http.ts) on `--listen`; serves ONLY a reply bundle that hashes to `--digest`; writes the ledger before it answers. Prints ONE line of JSON once listening
//              (`{"listening":{"port":n,"metaPort":n,"escapePorts":{...}}}`): the laptop's parent reads the ephemeral port from it.
//   SUMMARIZE  `--summarize --ledger <file>`: prints ONE line, the `ModelHelperSummary` (model-helper-ledger.ts). The worker reads it by `docker exec` while the helper is up.
// Nothing here takes a secret, a URL or a repository string. Until F1-b's recorder is wired (`model-helper-recorder.ts`), the 443/80 listeners record that a client connected, with no name.
import { readFileSync } from "node:fs";
import { parseModelHelperArgs, parseModelHelperSummarizeArgs } from "./model-helper-args.js";
import { createModelLedgerWriter, summarizeModelLedgerFile } from "./model-helper-ledger.js";
import { startModelHelperLoop, type ModelBackend, type RunningModelHelperLoop } from "./model-helper-http.js";
import { UNNAMED_ESCAPE_RECORDER, type ModelHostRecorderPort } from "./model-helper-recorder-port.js";
import { parseModelHelperRowsBytes, parseModelReplyBundleBytes } from "./model-reply-bundle.js";
import type { ModelHelperServeArgs } from "./model-helper-args.js";

/** The one error of this program; its message is a fixed word and carries no value. */
export class ModelHelperRefused extends Error {
  constructor(readonly reason: "arguments" | "rows" | "replies" | "ledger") {
    super(`model helper refused: ${reason}`);
    this.name = "ModelHelperRefused";
  }
}

export interface ServeModelHelperOptions {
  readonly readFile?: ((path: string) => Uint8Array) | undefined;
  readonly recorder?: ModelHostRecorderPort | undefined;
  readonly backend?: ModelBackend | undefined;
  /** Test seam: the escape ports (443 and 80 are privileged). */
  readonly escapePorts?: { readonly tls: number; readonly plain: number } | undefined;
  readonly now?: (() => number) | undefined;
}

/** Loads the pinned files and starts the loop. Throws `ModelHelperRefused` for a file that is not the pinned one; nothing listens then. */
export async function serveModelHelper(args: ModelHelperServeArgs, options: ServeModelHelperOptions = {}): Promise<RunningModelHelperLoop> {
  const read = options.readFile ?? ((path: string): Uint8Array => readFileSync(path));
  let rowsBytes: Uint8Array;
  let repliesBytes: Uint8Array;
  try {
    rowsBytes = read(args.rows);
    repliesBytes = read(args.replies);
  } catch {
    throw new ModelHelperRefused("rows");
  }
  const rows = parseModelHelperRowsBytes(rowsBytes);
  if (rows === undefined) throw new ModelHelperRefused("rows");
  const bundle = parseModelReplyBundleBytes(repliesBytes, args.digest);
  if (!bundle.ok) throw new ModelHelperRefused("replies");
  const now = options.now ?? Date.now;
  let ledger: ReturnType<typeof createModelLedgerWriter>;
  try {
    ledger = createModelLedgerWriter(args.ledger, { header: 1, mode: args.mode, blockState: args.blockState, digest: bundle.digest, startedAt: now() });
  } catch {
    throw new ModelHelperRefused("ledger");
  }
  return startModelHelperLoop({
    listen: args.listen,
    port: args.port,
    metaPort: args.metaPort,
    caller: args.caller,
    mode: args.mode,
    rows,
    replySets: bundle.byFamily,
    ledger,
    projectId: args.projectId,
    backend: options.backend,
    escapes: args.recordEscapes ? { recorder: options.recorder ?? UNNAMED_ESCAPE_RECORDER, ...(options.escapePorts === undefined ? {} : { ports: options.escapePorts }) } : undefined,
    now,
  });
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  if (argv.includes("--summarize")) {
    process.stdout.write(`${JSON.stringify(summarizeModelLedgerFile(parseModelHelperSummarizeArgs(argv).ledger))}\n`);
    return;
  }
  const loop = await serveModelHelper(parseModelHelperArgs(argv));
  const end = (): void => {
    void loop.close().finally(() => process.exit(0));
  };
  process.on("SIGTERM", end);
  process.on("SIGINT", end);
  process.stdout.write(`${JSON.stringify({ listening: { port: loop.port, metaPort: loop.metaPort ?? null, escapePorts: loop.escapePorts ?? null } })}\n`);
}

if (process.argv[1]?.endsWith("model-helper.js")) {
  main().catch(() => {
    process.exit(1);
  });
}
