// The first setup file of the shared-module test files (vitest.config.ts, project "shared-modules"). They run one after another in one worker process on one
// module graph, so what a file leaves in the process (an environment variable, a changed working directory, fake timers, a stubbed global, a spy on a shared
// module) would reach the next file. This notes the environment and working directory once the file's imports have loaded, and puts them back when the file
// ends, with real timers, no stubbed global or environment variable, and no spy left. Noted after the imports, not before: a shared helper that sets a variable
// when it is first loaded runs only once per worker, so what it set must stay for the files after it. (The "fresh-modules" files each get a new process.)
// It imports nothing of the project's, so it costs a file nothing to load.
import { afterAll, beforeAll, vi } from "vitest";

let foundEnvironment: Record<string, string | undefined> = {};
let foundDirectory = process.cwd();

beforeAll(() => {
  foundEnvironment = { ...process.env };
  foundDirectory = process.cwd();
});

afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const name of Object.keys(process.env)) if (!(name in foundEnvironment)) delete process.env[name];
  for (const [name, value] of Object.entries(foundEnvironment)) if (value !== undefined && process.env[name] !== value) process.env[name] = value;
  if (process.cwd() !== foundDirectory) process.chdir(foundDirectory);
});
