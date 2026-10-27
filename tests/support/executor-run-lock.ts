import { randomBytes } from "node:crypto";
import { link, readFile, unlink, writeFile } from "node:fs/promises";
import { runE2EExecutor } from "../../packages/verifier/src/executor/run.js";

// The executor's forwarder binds a fixed loopback port (the compiled origin, 127.0.0.1:4317), so two real executor runs on one machine cannot overlap, and vitest runs test files in
// parallel workers (and several vitest runs may share the machine). The repo has no serial-file mechanism, so the real-Chromium executor tests take this lock.
//
// The lock is one file at a fixed path that does not depend on TMPDIR (each vitest run gets its own TMPDIR, see `test-temp-dir.ts`), so it is machine-wide:
//  - Acquire is atomic: the owner's record (pid and a random token) is written to a private file first, then hard-linked to the lock path. `link` fails with EEXIST when the lock exists, and
//    the lock never exists without its owner record in it.
//  - A lock is only ever taken over when its recorded owner is provably dead (`kill(pid, 0)` says ESRCH; EPERM means a live process of another user). An unreadable or malformed record is
//    not proof of anything, so it is waited on, never removed.
//  - Taking over is serialized by a second, short-lived "reaper" lock (same mechanism). Acquirers cannot create the lock while the dead one is in place, so under the reaper lock the lock
//    cannot change between re-reading its owner and removing it: nobody else's fresh lock is ever removed. Only a reaper lock whose own owner is provably dead is taken over, and the
//    residual risk (a reaper dying between checking and removing, then two waiters racing over its leftover) is limited to the microseconds that critical section takes.
const LOCK_PATH = "/tmp/rovara-executor-forwarder-port.lock";
const POLL_MS = 150;
const GIVE_UP_MS = 20 * 60_000;

/** `afterStaleOwnerRead` is a test seam: it runs between a waiter confirming the owner is dead and removing the lock (the window another waiter could race through). */
type RunLockOptions = { path: string; pollMs?: number; giveUpMs?: number; afterStaleOwnerRead?: () => Promise<void>;
  /** A test seam for the removal of a dead owner's lock (default: unlink), so a removal that fails can be tested. */
  removeStaleLock?: (path: string) => Promise<void> };

/** True only when the process is provably gone: ESRCH. EPERM (another user's live process) and anything else count as alive. */
const provablyDead = (pid: number): boolean => {
  try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
};

/** The owner pid of a lock record, or undefined when the file is missing or not a record we wrote. */
const ownerOf = (record: string): number | undefined => {
  const match = /^(\d+)\n[0-9a-f]+\n$/.exec(record);
  const pid = match === null ? undefined : Number(match[1]);
  return pid !== undefined && Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
};

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** Takes `path` atomically; resolves to the record written when this call took it, or undefined when it exists. */
async function tryCreate(path: string): Promise<string | undefined> {
  const record = `${process.pid}\n${randomBytes(8).toString("hex")}\n`;
  const staging = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(staging, record, { flag: "wx" });
  try {
    await link(staging, path);
    return record;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw error;
  } finally {
    await unlink(staging).catch(() => undefined);
  }
}

/** Removes `path` only if it still holds `record` (ours). */
async function releaseIfOurs(path: string, record: string): Promise<void> {
  if (await readFile(path, "utf8").catch(() => undefined) === record) await unlink(path).catch(() => undefined);
}

/** Removes the lock at `path` when, with the reaper lock held, its recorded owner is provably dead. Returns whether it removed one. */
async function reapDeadOwner(path: string, afterStaleOwnerRead: (() => Promise<void>) | undefined, removeStaleLock: (path: string) => Promise<void>): Promise<boolean> {
  const reaperPath = `${path}.reaper`;
  const reaper = await tryCreate(reaperPath);
  if (reaper === undefined) {
    // Another waiter is reaping. Its lock is only taken over when its owner is provably dead, which can only be a waiter that was killed in the middle.
    const reaperOwner = ownerOf(await readFile(reaperPath, "utf8").catch(() => ""));
    if (reaperOwner !== undefined && provablyDead(reaperOwner)) await unlink(reaperPath).catch(() => undefined);
    return false;
  }
  try {
    // Re-read under the reaper lock: the lock cannot be replaced while a dead one sits there, so what is read here is what is removed.
    const owner = ownerOf(await readFile(path, "utf8").catch(() => ""));
    if (owner === undefined || !provablyDead(owner)) return false;
    await afterStaleOwnerRead?.();
    // Gone (ENOENT) or removed: the lock is free to take. Any other failure (EPERM, EACCES, ...) leaves the dead lock in place, so the caller must not retry in a loop: it waits and gives up.
    try { await removeStaleLock(path); } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
    return true;
  } finally {
    await releaseIfOurs(reaperPath, reaper);
  }
}

/** A lock on `options.path`: `withLock` runs work while holding it; two holders never overlap, in this process or another. */
export function createExecutorRunLock(options: RunLockOptions): { withLock: <T>(work: () => Promise<T>) => Promise<T> } {
  const { path, pollMs = POLL_MS, giveUpMs = GIVE_UP_MS, afterStaleOwnerRead, removeStaleLock = unlink } = options;
  async function acquire(): Promise<string> {
    const startedAt = Date.now();
    for (;;) {
      const record = await tryCreate(path);
      if (record !== undefined) return record;
      if (await reapDeadOwner(path, afterStaleOwnerRead, removeStaleLock)) continue;
      if (Date.now() - startedAt > giveUpMs) throw new Error(`the executor forwarder port stayed locked by another test file (lock: ${path}). A reused process id can leave a stale lock that looks alive; if no executor test is running, delete ${path} (and ${path}.reaper) and run again.`);
      await sleep(pollMs);
    }
  }
  return {
    async withLock<T>(work: () => Promise<T>): Promise<T> {
      const record = await acquire();
      try { return await work(); } finally { await releaseIfOurs(path, record); }
    },
  };
}

const machineWideLock = createExecutorRunLock({ path: LOCK_PATH });

/** Runs `work` while holding the machine-wide forwarder-port lock; two holders never overlap, in this process or another. */
export function withExecutorRunLock<T>(work: () => Promise<T>): Promise<T> {
  return machineWideLock.withLock(work);
}

/** Runs the executor while holding the forwarder-port lock. */
export function runE2EExecutorSerially(...args: Parameters<typeof runE2EExecutor>): ReturnType<typeof runE2EExecutor> {
  return withExecutorRunLock(() => runE2EExecutor(...args));
}

/** Where the machine-wide lock lives: a fixed path, not under the per-run TMPDIR. */
export const EXECUTOR_RUN_LOCK_PATH = LOCK_PATH;
