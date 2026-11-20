// For the shared-module test files (vitest.config.ts, project "shared-modules") once they share modules (isolate: false, with this file as their setup file):
// they then run one after another in one worker without fresh modules, so state a module or
// the process keeps outlives the file that changed it. This setup file runs before every such test file. When the file ends it puts back what a fresh worker
// would give the next one: the environment variables and working directory as the file found them, real timers, no stubbed global or environment variable,
// no spy left on a shared module, the process-wide switches as they were, and empty merge-action slots (packages/broker/src/local/app/app.ts installs the
// CI fix and branch sync deciders once per process; a fresh module graph has none). A file therefore leaves the process as it found it.
import { afterAll, beforeAll, vi } from "vitest";
import { uninstallBranchSyncDeciders } from "../../packages/broker/src/core/branch-sync/branch-sync.js";
import { uninstallCiFixDecider } from "../../packages/broker/src/core/ci-fix/ci-fix.js";
import { currentAutoApplyGate, currentLearnedLessonsGate, setAutoApplyGate, setLearnedLessonsGate } from "../../packages/broker/src/lessons/policy.js";
import { currentLessonsUsedReader, setLessonsUsedReader } from "../../packages/broker/src/lessons/used-in-pr.js";

let foundEnvironment: Record<string, string | undefined> = {};
let foundDirectory = process.cwd();
let found: { lessonsGate: () => boolean; autoApplyGate: () => boolean; lessonsUsedReader: ReturnType<typeof currentLessonsUsedReader> } | undefined;

beforeAll(() => {
  foundEnvironment = { ...process.env };
  foundDirectory = process.cwd();
  found = { lessonsGate: currentLearnedLessonsGate(), autoApplyGate: currentAutoApplyGate(), lessonsUsedReader: currentLessonsUsedReader() };
});

afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const name of Object.keys(process.env)) if (!(name in foundEnvironment)) delete process.env[name];
  for (const [name, value] of Object.entries(foundEnvironment)) if (value !== undefined && process.env[name] !== value) process.env[name] = value;
  if (process.cwd() !== foundDirectory) process.chdir(foundDirectory);
  if (found !== undefined) {
    setLearnedLessonsGate(found.lessonsGate);
    setAutoApplyGate(found.autoApplyGate);
    setLessonsUsedReader(found.lessonsUsedReader);
  }
  uninstallCiFixDecider();
  uninstallBranchSyncDeciders();
});
