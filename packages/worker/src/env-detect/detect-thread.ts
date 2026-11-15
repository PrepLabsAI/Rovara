// The thread that runs the detectors (see `guarded.ts`). It has no file access of its own: every file's text is asked for from the thread that started it (which reads through the bounded reader, with its path
// list, size cap and byte budget), and the detection comes back as a plain object. If a hostile file makes a pattern run for ever, only this thread is stuck, and the starter ends it.
import { detectWorkspacePackagesInThread } from "./packages.js";
import { parentPort, workerData } from "node:worker_threads";
import { BUILT_IN_DETECTOR_NAMES, runDetectors } from "./index.js";
import { loadPluginDetectors } from "./plugin-detectors.js";
import type { RepositoryReader } from "./types.js";

interface Start { workspace?: boolean; paths: string[]; truncated: boolean; cwd: string; legacyOnly: boolean; only?: string[]; /** Vetted detector modules a build-system profile names (port lane P6, item B1). */ detectorModules?: string[] }
type Reply = { type: "text"; id: number; text: string | undefined; exhausted: boolean };

const port = parentPort;
if (port === null) throw new Error("detect-thread must run as a worker thread");
const start = workerData as Start;
const allowed = new Set(start.paths);
const waiting = new Map<number, (reply: Reply) => void>();
let exhausted = false;
let next = 0;

port.on("message", (message: Reply) => {
  const resolve = waiting.get(message.id);
  if (resolve !== undefined) { waiting.delete(message.id); resolve(message); }
});

const reader: RepositoryReader = {
  paths: start.paths,
  truncated: start.truncated,
  budgetExhausted: () => exhausted,
  read(path) {
    if (!allowed.has(path)) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      next += 1;
      const id = next;
      waiting.set(id, (reply) => { exhausted = reply.exhausted; resolve(reply.text); });
      port.postMessage({ type: "read", id, path });
    });
  },
};

(start.workspace === true
  ? detectWorkspacePackagesInThread(reader, start.cwd, start.only === undefined ? {} : { only: start.only })
  : loadPluginDetectors(start.detectorModules ?? [], BUILT_IN_DETECTOR_NAMES).then((plugin) => runDetectors(reader, start.cwd, {
  legacyOnly: start.legacyOnly,
  ...(start.only === undefined ? {} : { only: start.only }),
  extraDetectors: plugin.detectors,
  extraNotes: plugin.notes,
}))).then(
  (detection) => port.postMessage({ type: "done", detection }),
  () => port.postMessage({ type: "failed" }),
);
