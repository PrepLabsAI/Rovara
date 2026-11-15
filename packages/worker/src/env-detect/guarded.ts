// The detector pass under a hard wall-clock limit (test services, hostile-repository safety). A repository's files are untrusted text, and a pattern that backtracks on a crafted file can run for minutes in
// one synchronous call, which no timer in the same thread can interrupt. So the pass runs in a worker thread (`detect-thread.ts`) and the starting thread keeps the clock:
//   - the thread has no file access: it asks this thread for each file's text, and this thread answers through the bounded reader (path list, 256 KiB per file, 4 MiB in all), so it only ever sees text the
//     reader already allows;
//   - the thread has its own memory limit, and `terminate()` frees its heap with it;
//   - on the limit (default 60 s, `timeoutMs`) the thread is ended and the detection is made again WITHOUT the dependency detectors, by a second thread with a shorter limit (10 s at most), so a repository
//     that only trips a new detector still gets today's detection. If that one is stopped too, the detection is empty. Either way it says "Some checks took too long and were stopped.";
//   - if a thread cannot be started because its entry file is missing (`ERR_MODULE_NOT_FOUND`, `ERR_WORKER_PATH`), the pass runs in this thread exactly as before, and ONE log line says so (the worker log), so a
//     packaging fault does not go unseen. Any other failure before the first message (a crash, running out of memory) counts as "stopped": the caller gets today's detection plus the note, never an unguarded rerun.
import type { WorkspaceDetection } from "./packages.js";
import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { consoleWorkerLog, logEnvDetectGuardUnavailable, type WorkerLogSink } from "../worker-log.js";
import { runDetectors } from "./index.js";
import { PLUGIN_NOT_LOADED_NOTE, vetDetectorModules } from "./plugin-detectors.js";
import { installedDetectorModules } from "../build-systems.js";
import { emptyDetection, type Detection, type RepositoryReader } from "./types.js";

export const ENV_DETECT_TIMEOUT_MS = 60_000;
export const ENV_DETECT_FALLBACK_TIMEOUT_MS = 10_000;
export const ENV_DETECT_TIMEOUT_NOTE = "Some checks took too long and were stopped.";
const THREAD_MEMORY_MB = 512;
/** The only errors that mean "no thread can be started here". */
const UNAVAILABLE_CODES: ReadonlySet<string> = new Set(["ERR_MODULE_NOT_FOUND", "ERR_WORKER_PATH"]);
const codeOf = (error: unknown): string | undefined => (typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : undefined);

export interface ThreadEntry { url: URL; execArgv: string[] }
export interface GuardOptions {
  /** The limit for the whole detector pass, in milliseconds. */
  timeoutMs?: number | undefined;
  /** The thread's entry file; by default the compiled `detect-thread.js` beside this file, or its source with `tsx` when running from source. */
  entry?: ThreadEntry | undefined;
  /** Where the "guard unavailable" line goes; the worker's console log by default. */
  log?: WorkerLogSink | undefined;
  /** Run only the detectors with these names (see `runDetectors`). */
  only?: readonly string[] | undefined;
  /** Port lane P6 (item B1): the detector modules of the worker's build-system profiles; by default the installed profiles'. They are vetted here and imported by the thread. */
  detectorModules?: readonly string[] | undefined;
}

export function defaultThreadEntry(): ThreadEntry {
  const compiled = new URL("./detect-thread.js", import.meta.url);
  if (existsSync(fileURLToPath(compiled))) return { url: compiled, execArgv: [] };
  return { url: new URL("./detect-thread.ts", import.meta.url), execArgv: ["--import", "tsx"] };
}

type Attempt<T> = { kind: "done"; detection: T } | { kind: "stopped" } | { kind: "unavailable"; code: string };

function attempt<T = Detection>(reader: RepositoryReader, cwd: string, legacyOnly: boolean, timeoutMs: number, entry: ThreadEntry, only?: readonly string[], detectorModules?: readonly string[], workspace = false): Promise<Attempt<T>> {
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(entry.url, {
        workerData: { workspace, paths: [...reader.paths], truncated: reader.truncated === true, cwd, legacyOnly, ...(only === undefined ? {} : { only: [...only] }), ...(detectorModules === undefined || detectorModules.length === 0 ? {} : { detectorModules: [...detectorModules] }) },
        execArgv: entry.execArgv,
        env: {},
        resourceLimits: { maxOldGenerationSizeMb: THREAD_MEMORY_MB, maxYoungGenerationSizeMb: 64 },
      });
    } catch (error) {
      const code = codeOf(error);
      resolve(code !== undefined && UNAVAILABLE_CODES.has(code) ? { kind: "unavailable", code } : { kind: "stopped" });
      return;
    }
    let settled = false;
    let started = false;
    const finish = (value: Attempt<T>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate().then(() => resolve(value), () => resolve(value));
    };
    const timer = setTimeout(() => finish({ kind: "stopped" }), timeoutMs);
    worker.on("message", (message: { type: string; id?: number; path?: string; detection?: T }) => {
      started = true;
      if (message.type === "read" && typeof message.path === "string") {
        const { id, path } = message;
        reader.read(path).then(
          (text) => { if (!settled) worker.postMessage({ type: "text", id, text, exhausted: reader.budgetExhausted?.() === true }); },
          () => { if (!settled) worker.postMessage({ type: "text", id, text: undefined, exhausted: false }); },
        );
      } else if (message.type === "done" && message.detection !== undefined) finish({ kind: "done", detection: message.detection });
      else if (message.type === "failed") finish({ kind: "stopped" });
    });
    // Only a missing entry file means "unavailable". A crash or running out of memory, before or after the first message, is "stopped".
    worker.on("error", (error: unknown) => {
      const code = codeOf(error);
      finish(!started && code !== undefined && UNAVAILABLE_CODES.has(code) ? { kind: "unavailable", code } : { kind: "stopped" });
    });
    worker.on("exit", () => finish({ kind: "stopped" }));
  });
}

/** `runDetectors` under a wall-clock limit. Same result as `runDetectors` for any repository that finishes in time. */
export async function runDetectorsGuarded(reader: RepositoryReader, cwd: string, options: GuardOptions = {}): Promise<Detection> {
  const timeoutMs = options.timeoutMs ?? ENV_DETECT_TIMEOUT_MS;
  const entry = options.entry ?? defaultThreadEntry();
  // Port lane P6 (item B1): a build system's detectors, from the operator's profile (never from the repository), checked before a thread is asked to import them.
  // A caller that asks for named detectors only (`only`) wants none of a plug-in's.
  const vetted = await vetDetectorModules(options.only !== undefined ? [] : options.detectorModules ?? installedDetectorModules(), process.env.AGENTX_WORKSPACE_ROOT ?? "/mnt/workspace");
  const full = await attempt(reader, cwd, false, timeoutMs, entry, options.only, vetted.modules);
  if (full.kind === "done") return vetted.notes.length === 0 ? full.detection : { ...full.detection, notes: [...new Set([...vetted.notes, ...full.detection.notes])] };
  if (full.kind === "unavailable") {
    logEnvDetectGuardUnavailable(options.log ?? consoleWorkerLog, full.code);
    // No thread to hold a plug-in detector to its clock and memory limit: only the built-in detectors run here, in this thread, and a missing plug-in is said so. Plug-in code is never imported into the main thread.
    return runDetectors(reader, cwd, { ...(options.only === undefined ? {} : { only: options.only }), extraNotes: [...vetted.notes, ...(vetted.modules.length > 0 ? [PLUGIN_NOT_LOADED_NOTE] : [])] });
  }
  const legacy = await attempt(reader, cwd, true, Math.min(ENV_DETECT_FALLBACK_TIMEOUT_MS, timeoutMs), entry, options.only, vetted.modules);
  const base = legacy.kind === "done" ? legacy.detection : emptyDetection();
  return { ...base, notes: [...new Set([...vetted.notes, ...base.notes, ENV_DETECT_TIMEOUT_NOTE])] };
}

/** Package discovery and all unit passes share one attempt; a stopped workspace is never partial success. */
export async function runWorkspacePackagesGuarded(reader: RepositoryReader, cwd: string, options: Pick<GuardOptions, "timeoutMs" | "entry" | "only"> = {}): Promise<WorkspaceDetection> {
  const result = await attempt<WorkspaceDetection>(reader, cwd, false, options.timeoutMs ?? ENV_DETECT_TIMEOUT_MS, options.entry ?? defaultThreadEntry(), options.only, [], true);
  if (result.kind === "done") return result.detection;
  return { kind: "unavailable", units: [], reason: result.kind === "unavailable" ? "Workspace detection guard could not start." : "Workspace detection did not finish within its limit." };
}
