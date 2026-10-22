import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runE2EExecutor } from "../../packages/verifier/src/executor/run.js";

// The executor's forwarder binds a fixed loopback port (the compiled origin, 127.0.0.1:4317), so two real executor runs on one machine cannot overlap, and vitest runs test files in
// parallel workers. The repo has no serial-file mechanism, so the real-Chromium executor tests take this lock: a directory in the run's temporary directory (one per vitest run, see
// `test-temp-dir.ts`), owned by a process id so that a lock left by a killed worker is taken over.
const LOCK = join(tmpdir(), "rovara-executor-forwarder-port.lock");
const POLL_MS = 150;
const GIVE_UP_MS = 20 * 60_000;

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function acquire(): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    try {
      await mkdir(LOCK);
      await writeFile(join(LOCK, "owner"), String(process.pid));
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = Number(await readFile(join(LOCK, "owner"), "utf8").catch(() => "0"));
      // An owner file that does not exist yet belongs to a process that is still taking the lock: only a named, dead owner loses it.
      if (owner > 0 && !alive(owner)) { await rm(LOCK, { recursive: true, force: true }); continue; }
      if (Date.now() - startedAt > GIVE_UP_MS) throw new Error("the executor forwarder port stayed locked by another test file", { cause: error });
      await new Promise((done) => setTimeout(done, POLL_MS));
    }
  }
}

/** Runs `work` while holding the machine-wide forwarder-port lock; two holders never overlap, in this process or another. */
export async function withExecutorRunLock<T>(work: () => Promise<T>): Promise<T> {
  await acquire();
  try { return await work(); } finally { await rm(LOCK, { recursive: true, force: true }); }
}

/** Runs the executor while holding the forwarder-port lock. */
export function runE2EExecutorSerially(...args: Parameters<typeof runE2EExecutor>): ReturnType<typeof runE2EExecutor> {
  return withExecutorRunLock(() => runE2EExecutor(...args));
}

/** Where the lock lives (a test plants a stale one there). */
export const EXECUTOR_RUN_LOCK_PATH = LOCK;
