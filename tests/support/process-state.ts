// The first setup file of the shared-module test files (vitest.config.ts, project "shared-modules"). They run one after another in one worker process on one
// module graph, so what a file leaves in the process (an environment variable, a changed working directory, fake timers, a stubbed global, a spy on a shared
// module) would reach the next file. When a file ends this puts back real timers, no stubbed global or environment variable, no spy, and the environment and
// working directory. (The "fresh-modules" files each get a new process.) It imports nothing of the project's, so it costs a file nothing to load.
//
// The environment is noted twice: before the file is imported (this module runs first) and once its imports have loaded. Both are clean states to end in: a file
// that sets a variable while it loads and removes it itself when it ends (tests/support/skip-bundling.ts) ends as it began, and a shared helper that sets one
// when it is first loaded runs only once per worker, so what it set stays for the files after it. Any other value goes back to the one the file had once loaded.
import { afterAll, beforeAll, vi } from "vitest";

const beforeImport: Record<string, string | undefined> = { ...process.env };
const directoryBeforeImport = process.cwd();
let loaded: Record<string, string | undefined> = beforeImport;
let directoryLoaded = directoryBeforeImport;

beforeAll(() => {
  loaded = { ...process.env };
  directoryLoaded = process.cwd();
});

afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const name of new Set([...Object.keys(process.env), ...Object.keys(loaded)])) {
    const now = process.env[name];
    if (now === loaded[name] || now === beforeImport[name]) continue;
    if (loaded[name] === undefined) delete process.env[name];
    else process.env[name] = loaded[name];
  }
  const directory = process.cwd();
  if (directory !== directoryLoaded && directory !== directoryBeforeImport) process.chdir(directoryLoaded);
});
