// TE-F2 part B (M2, release 0.5.19; DECISIONS 158; te-f1 design 3.2 item 4): the LAPTOP path. No container and no network block: a loopback helper CHILD PROCESS (`node dist/model-helper.js`, the same program the hosted
// container runs) on 127.0.0.1 and an ephemeral port, started for the check round of a local run, reached by the same base-URL variables (the pure map is model-helper-env.ts; F1-b's builder replaces it for hosted runs).
//
// Three things this file is careful about:
//   1. The child gets a MINIMAL environment, built here: nothing of the user's shell, so no real model key and no `NODE_OPTIONS`. A test builds a fake real-looking key at run time and shows it never reaches the child.
//   2. The commands of the round get the dummy key in EVERY model key variable (model-helper-env.ts), overriding what the user's shell holds.
//   3. Nothing blocks model hosts on a laptop (the egress gateway's list is a separate matter: default-allow-domains.ts), so the block state is `not_blocked_here` and the evidence says exactly "model hosts not blocked on this
//      machine". A client that ignores the redirect can still reach a real host there; the dummy key is all it sends. This is said in the PR body and in the evidence, never hidden.
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelCatalogRow, ServableRow } from "@agentx/contracts";
import { modelHelperArgs } from "./model-helper-args.js";
import { writeDummyAdc } from "./model-helper-adc.js";
import { laptopModelEnvironment } from "./model-helper-env.js";
import { summarizeModelLedgerFile } from "./model-helper-ledger.js";
import { removeModelHelperRunFiles, writeModelHelperRunFiles, type ModelHelperRoundPlan, type ModelHelperRoundResult, type StartedModelHelper } from "./model-helper-round.js";
import { loadModelReplySets, type LoadOptions, type ReplySetSource } from "./model-reply-set-load.js";

export const LOCAL_HELPER_START_TIMEOUT_MS = 10_000;
/** The worker's own built program (`dist/model-helper.js` next to this file when this file is built too). */
export const defaultModelHelperEntry = (): string => fileURLToPath(new URL("./model-helper.js", import.meta.url));

/** The child's whole environment: nothing inherited. */
export const LOCAL_HELPER_CHILD_ENVIRONMENT: Readonly<Record<string, string>> = Object.freeze({ NODE_ENV: "production" });

export type SpawnSeam = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface LocalModelHelperInput {
  readonly catalogRows: readonly ModelCatalogRow[];
  /** The rows the project's client is pointed at. */
  readonly rowIds: readonly string[];
  readonly source: ReplySetSource;
  /** A worker-owned directory for the run files. */
  readonly scratchRoot?: string;
  readonly projectId?: string;
  readonly entry?: string;
  readonly spawn?: SpawnSeam;
  readonly load?: LoadOptions;
  /** REQUIRED: the round's summary and evidence (an escape is `not_run`); see `ModelHelperRoundPlan.onResult`. */
  readonly onResult: (result: ModelHelperRoundResult) => void;
  /** F0a's `modelHostBlockList(...)`. */
  readonly blockList: readonly string[];
}

const servable = (row: ModelCatalogRow): ServableRow => ({ id: row.id, family: row.family, ...(row.pathPrefix === undefined ? {} : { pathPrefix: row.pathPrefix }), ...(row.routesTo === undefined ? {} : { routesTo: row.routesTo }) });

/** The plan for `withModelHelperRound` on a laptop. A round whose project has no reply set starts no helper. */
export function localModelHelperPlan(input: LocalModelHelperInput): ModelHelperRoundPlan {
  return {
    blockList: input.blockList,
    onResult: input.onResult,
    async start(signal) {
      const loaded = await loadModelReplySets(input.source, signal, input.load);
      if (loaded.sets.length === 0) return undefined;
      const files = await writeModelHelperRunFiles({ parent: input.scratchRoot ?? join(tmpdir(), "rovara-model-helper"), rows: input.catalogRows.map(servable), sets: loaded.sets });
      let child: ChildProcess | undefined;
      const stop = async (): Promise<void> => {
        if (child !== undefined && child.exitCode === null && !child.killed) child.kill("SIGTERM");
        await removeModelHelperRunFiles(files).catch(() => undefined);
      };
      try {
        const ledger = join(files.dir, "ledger.jsonl");
        const args = modelHelperArgs({
          listen: "127.0.0.1", port: 0, metaPort: 0, caller: "127.0.0.1", mode: "scripted", rows: files.rowsPath, replies: files.repliesPath, digest: files.digest, ledger,
          blockState: "not_blocked_here", projectId: input.projectId, recordEscapes: false,
        });
        const run = input.spawn ?? spawn;
        child = run(process.execPath, [input.entry ?? defaultModelHelperEntry(), ...args], { env: { ...LOCAL_HELPER_CHILD_ENVIRONMENT }, stdio: ["ignore", "pipe", "ignore"] });
        const listening = await readListeningLine(child, signal);
        const baseUrl = `http://127.0.0.1:${String(listening.port)}`;
        if (listening.metaPort === null) throw new Error("the model helper has no metadata port");
        const adc = await writeDummyAdc({ dir: files.dir, tokenUri: `http://127.0.0.1:${String(listening.metaPort)}/token`, projectId: input.projectId });
        const environment = laptopModelEnvironment({
          rows: input.catalogRows, rowIds: input.rowIds, baseUrl, projectId: input.projectId,
          metadataHostPort: `127.0.0.1:${String(listening.metaPort)}`, adc,
        });
        if (!environment.ok) throw new Error("the model rows cannot be pointed at one helper");
        const started: StartedModelHelper = {
          pinnedDigest: files.digest,
          commandEnvironment: environment.environment,
          readSummary: () => Promise.resolve(summarizeModelLedgerFile(ledger)),
          stop,
        };
        return started;
      } catch (error) {
        await stop();
        throw error;
      }
    },
  };
}

function readListeningLine(child: ChildProcess, signal: AbortSignal): Promise<{ port: number; metaPort: number | null }> {
  return new Promise((resolveLine, rejectLine) => {
    let text = "";
    const timer = setTimeout(() => fail(), LOCAL_HELPER_START_TIMEOUT_MS);
    const fail = (): void => {
      clearTimeout(timer);
      rejectLine(new Error("the model helper did not start"));
    };
    signal.addEventListener("abort", fail, { once: true });
    child.once("error", fail);
    child.once("exit", fail);
    child.stdout?.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      const end = text.indexOf("\n");
      if (end < 0 && text.length < 1024) return;
      try {
        const value = JSON.parse(text.slice(0, end < 0 ? undefined : end)) as { listening?: { port?: unknown; metaPort?: unknown } };
        const port = value.listening?.port;
        const meta = value.listening?.metaPort;
        if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535) return fail();
        clearTimeout(timer);
        resolveLine({ port, metaPort: typeof meta === "number" ? meta : null });
      } catch {
        fail();
      }
    });
  });
}
