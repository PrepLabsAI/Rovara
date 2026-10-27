import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMPTY_GIT_DIRECTORY_ROOT_VARIABLE, createEmptyGitDirectories, removeEmptyGitDirectories } from "./empty-git-directories.js";

export const TEST_TMP_PREFIX = "agentx-vitest-";

/** Leftovers from a run that was killed before its teardown; old enough that no live run owns them. */
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Vitest global setup: gives the whole run its own temporary directory and removes it at teardown.
 * CDK apps built without an outdir write a cdk.out* assembly under os.tmpdir() on every synth, and
 * many tests mkdtemp there without cleaning up; before this, each full run left gigabytes behind.
 * Workers inherit TMPDIR from this process, so os.tmpdir() in every test resolves inside the run's
 * directory.
 */
export default function setup(): () => void {
  const parent = tmpdir();
  for (const name of readdirSync(parent)) {
    if (!name.startsWith(TEST_TMP_PREFIX)) continue;
    const path = join(parent, name);
    try {
      if (Date.now() - statSync(path).mtimeMs > STALE_AFTER_MS) rmSync(path, { recursive: true, force: true });
    } catch {
      // Another run removed it first, or it is not ours to remove; either way it is not this run's.
    }
  }
  const runDir = mkdtempSync(join(parent, TEST_TMP_PREFIX));
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = runDir;
  // The empty, read-only git directories the worker's verified base read uses; a worker image carries them, a test run makes its own.
  const emptyGitDirectories = join(runDir, "empty-git-directories");
  createEmptyGitDirectories(emptyGitDirectories);
  const previousEmpty = process.env[EMPTY_GIT_DIRECTORY_ROOT_VARIABLE];
  process.env[EMPTY_GIT_DIRECTORY_ROOT_VARIABLE] = emptyGitDirectories;
  // The worker runs a task's commands in a sandbox container unless told otherwise. Tests run them as children of
  // the test process, which they must ask for, and keep the worker's private state in the run's directory, not in $HOME.
  const previousShell = process.env.AGENTX_TASK_SHELL;
  const previousState = process.env.AGENTX_WORKER_STATE_DIR;
  process.env.AGENTX_TASK_SHELL = "local";
  process.env.AGENTX_WORKER_STATE_DIR = join(runDir, "worker-state");
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  return () => {
    restore(EMPTY_GIT_DIRECTORY_ROOT_VARIABLE, previousEmpty);
    removeEmptyGitDirectories(emptyGitDirectories);
    restore("TMPDIR", previous);
    restore("AGENTX_TASK_SHELL", previousShell);
    restore("AGENTX_WORKER_STATE_DIR", previousState);
    rmSync(runDir, { recursive: true, force: true });
  };
}
