import { mkdtempSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createExecutorRunLock, EXECUTOR_RUN_LOCK_PATH } from "../support/executor-run-lock.js";

const DEAD_PID = 2147483646;
const record = (pid: number) => `${pid}\n0123456789abcdef\n`;
const privateLock = () => {
  const dir = mkdtempSync(join(tmpdir(), "run-lock-safety-"));
  return { dir, path: join(dir, "lock") };
};

// LOCK1: the executor run lock is machine-wide, acquired atomically, and never removes a lock whose owner is not provably dead or that someone else just took.
describe("the executor run lock's safety", () => {
  it("lives at a fixed path outside the per-run temporary directory, so every vitest run on the machine shares it", () => {
    expect(EXECUTOR_RUN_LOCK_PATH.startsWith(tmpdir())).toBe(false);
    expect(EXECUTOR_RUN_LOCK_PATH).toBe("/tmp/rovara-executor-forwarder-port.lock");
  });

  it("never takes over a lock whose owner is alive, even one it is not permitted to signal (EPERM), and leaves it untouched", async () => {
    const { path } = privateLock();
    // pid 1 is alive on every machine; for a non-root user kill(1, 0) fails with EPERM, which must still count as alive.
    await writeFile(path, record(1));
    await expect(createExecutorRunLock({ path, pollMs: 10, giveUpMs: 150 }).withLock(async () => "ran")).rejects.toThrow("stayed locked");
    expect(await readFile(path, "utf8")).toBe(record(1));
  });

  it("does not treat an unreadable or malformed owner record as a dead owner", async () => {
    for (const content of ["", "0\n0123456789abcdef\n", "-5\nabc\n", "not a pid"]) {
      const { path } = privateLock();
      await writeFile(path, content);
      await expect(createExecutorRunLock({ path, pollMs: 10, giveUpMs: 100 }).withLock(async () => "ran")).rejects.toThrow("stayed locked");
      expect(await readFile(path, "utf8")).toBe(content);
    }
  });

  it("on release removes only its own lock, never one another holder took in the meantime", async () => {
    const { path } = privateLock();
    await createExecutorRunLock({ path }).withLock(async () => { await writeFile(path, record(1)); });
    expect(await readFile(path, "utf8")).toBe(record(1));
  });

  it("holds a complete owner record from the first moment the lock exists, and leaves nothing behind", async () => {
    const { dir, path } = privateLock();
    const lock = createExecutorRunLock({ path, pollMs: 2 });
    let sampling = true;
    const seen: string[] = [];
    const sampler = (async () => {
      while (sampling) {
        const content = await readFile(path, "utf8").catch(() => undefined);
        if (content !== undefined) seen.push(content);
        await new Promise((done) => setTimeout(done, 0));
      }
    })();
    await Promise.all(Array.from({ length: 6 }, () => lock.withLock(async () => { await new Promise((done) => setTimeout(done, 5)); })));
    sampling = false;
    await sampler;
    expect(seen.length).toBeGreaterThan(0);
    for (const content of seen) expect(content).toMatch(new RegExp(`^${process.pid}\\n[0-9a-f]{16}\\n$`));
    expect(await readdir(dir)).toEqual([]);
  });

  it("many waiters over one dead lock take turns: one takes it over, nobody removes a lock another just took", async () => {
    const { dir, path } = privateLock();
    await writeFile(path, record(DEAD_PID));
    const lock = createExecutorRunLock({ path, pollMs: 1 });
    let inside = 0;
    let overlaps = 0;
    let entered = 0;
    await Promise.all(Array.from({ length: 12 }, () => lock.withLock(async () => {
      inside += 1;
      entered += 1;
      if (inside > 1) overlaps += 1;
      await new Promise((done) => setTimeout(done, 8));
      inside -= 1;
    })));
    expect({ entered, overlaps }).toEqual({ entered: 12, overlaps: 0 });
    expect(await readdir(dir)).toEqual([]);
  });

  it("while one waiter is between confirming a dead owner and removing its lock, another waiter cannot take or remove the lock", async () => {
    const { path } = privateLock();
    await writeFile(path, record(DEAD_PID));
    const events: string[] = [];
    let confirmedDead!: () => void;
    const confirmed = new Promise<void>((done) => { confirmedDead = done; });
    let resume!: () => void;
    const paused = new Promise<void>((done) => { resume = done; });
    const first = createExecutorRunLock({ path, pollMs: 2, afterStaleOwnerRead: async () => { confirmedDead(); await paused; } })
      .withLock(async () => { events.push("first:in"); await new Promise((done) => setTimeout(done, 10)); events.push("first:out"); });
    await confirmed;
    const second = createExecutorRunLock({ path, pollMs: 2 }).withLock(async () => { events.push("second:in"); events.push("second:out"); });
    // Plenty of polls for the second waiter to see the dead lock and act on it while the first is paused.
    await new Promise((done) => setTimeout(done, 100));
    expect(events).toEqual([]);
    resume();
    await Promise.all([first, second]);
    // Once the first is let go either may take the lock next, but never both at once.
    expect(events[0]!.endsWith(":in") && events[1] === events[0]!.replace(":in", ":out") && events[2]!.endsWith(":in") && events[3] === events[2]!.replace(":in", ":out")).toBe(true);
    expect(new Set(events).size).toBe(4);
  });
});
