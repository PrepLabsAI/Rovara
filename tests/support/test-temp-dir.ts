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
  return () => {
    if (previousEmpty === undefined) delete process.env[EMPTY_GIT_DIRECTORY_ROOT_VARIABLE];
    else process.env[EMPTY_GIT_DIRECTORY_ROOT_VARIABLE] = previousEmpty;
    removeEmptyGitDirectories(emptyGitDirectories);
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    rmSync(runDir, { recursive: true, force: true });
  };
}
