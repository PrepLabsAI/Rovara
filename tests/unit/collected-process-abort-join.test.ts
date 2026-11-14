// FIX-RUNNER-ABORT-JOIN: an abort is joined. runCollected settles only once the process has exited and nothing is left
// alive in its process group, so a caller that aborts and then reads or writes the working tree never races a command
// that is still writing. A stop that cannot be confirmed within its bound says so (killUnconfirmed).
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { runCollected, type ProcessControl } from "../../packages/worker/src/collected-process.js";

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const scratch: string[] = [];
const spawned: number[] = [];
afterEach(async () => {
  for (const pid of spawned.splice(0)) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  for (const directory of scratch.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function directory(): Promise<string> {
  const made = await mkdtemp(join(tmpdir(), "abort-join-"));
  scratch.push(made);
  return made;
}
/** Runs the command and aborts it when it has printed its first line (the pids it announces); returns what it printed too. */
async function abortedAfterFirstLine(executable: string, args: string[], options: Parameters<typeof runCollected>[2] = {}) {
  const controller = new AbortController();
  let printed = "";
  const startedAt = Date.now();
  const result = await runCollected(executable, args, {
    ...options,
    signal: controller.signal,
    onStdout: (data) => {
      printed += data.toString("utf8");
      if (printed.includes("\n") && !controller.signal.aborted) {
        for (const pid of printed.trim().split(/\s+/u).map(Number)) if (Number.isSafeInteger(pid) && pid > 0) spawned.push(pid);
        controller.abort();
      }
    },
  });
  return { result, elapsedMs: Date.now() - startedAt, pids: printed.trim().split(/\s+/u).map(Number).filter((pid) => Number.isSafeInteger(pid) && pid > 0) };
}

describe("runCollected joins an abort", () => {
  it("settles only after a SIGTERM-resistant child is dead, and within the bound (SIGKILL escalation)", async () => {
    const script = 'process.on("SIGTERM", () => {}); console.log(process.pid); setInterval(() => {}, 1000);';
    const { result, elapsedMs, pids } = await abortedAfterFirstLine(process.execPath, ["-e", script], { killGraceMs: 300 });
    expect(pids).toHaveLength(1);
    // The positive control: the child ignored SIGTERM, so only the SIGKILL after the grace period can have ended it.
    expect(elapsedMs).toBeGreaterThanOrEqual(250);
    // Not waited for longer than the grace period plus a little: the bound is respected.
    expect(elapsedMs).toBeLessThan(300 + 2_500);
    expect(alive(pids[0]!)).toBe(false);
    expect(result.exitCode).toBeNull();
    expect(result.killUnconfirmed).toBeUndefined();
  });

  it("settles only after a grandchild in the process group, which ignores SIGTERM and writes late, is dead", async () => {
    const dir = await directory();
    const late = join(dir, "late-write");
    // The leader dies on SIGTERM at once; its background child (same process group) announces itself once it ignores SIGTERM, and would write after 1.5 s.
    const script = `sh -c 'trap "" TERM; echo $$; sleep 1.5; echo late > "$1"' sh "$1" & wait`;
    const { result, elapsedMs, pids } = await abortedAfterFirstLine("sh", ["-c", script, "sh", late], { killGraceMs: 300 });
    expect(pids).toHaveLength(1);
    expect(alive(pids[0]!)).toBe(false);
    expect(elapsedMs).toBeGreaterThanOrEqual(250);
    expect(result.killUnconfirmed).toBeUndefined();
    await delay(1_800);
    await expect(stat(late)).rejects.toThrow(/ENOENT/);
  });

  it("a timeout is joined the same way: the result waits for a group member that ignores SIGTERM", async () => {
    const dir = await directory();
    const late = join(dir, "late-write");
    const script = `sh -c 'trap "" TERM; echo $$; sleep 1.5; echo late > "$1"' sh "$1" & wait`;
    let printed = "";
    const result = await runCollected("sh", ["-c", script, "sh", late], { timeoutMs: 300, killGraceMs: 300, onStdout: (data) => { printed += data.toString("utf8"); } });
    const member = Number.parseInt(printed.trim(), 10);
    spawned.push(member);
    expect(result.timedOut).toBe(true);
    expect(alive(member)).toBe(false);
    await delay(1_800);
    await expect(stat(late)).rejects.toThrow(/ENOENT/);
  });

  it("reports kill-unconfirmed, within the bound, when the group is still alive after SIGKILL", async () => {
    // The real child is killed, but the stop sees the group as alive for ever: the stop cannot be confirmed.
    const real = { signalGroup: (child: Parameters<ProcessControl["signalGroup"]>[0], signal: NodeJS.Signals) => { try { process.kill(-child.pid!, signal); } catch { child.kill(signal); } } };
    const control: ProcessControl = { ...real, groupAlive: () => true };
    const script = 'console.log(process.pid); setInterval(() => {}, 1000);';
    const { result, elapsedMs } = await abortedAfterFirstLine(process.execPath, ["-e", script], { killGraceMs: 100, killConfirmMs: 300, control });
    expect(result.killUnconfirmed).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(elapsedMs).toBeGreaterThanOrEqual(380);
    expect(elapsedMs).toBeLessThan(400 + 1_500);
  });

  it("reports kill-unconfirmed when the process never exits (signals that do nothing)", async () => {
    const control: ProcessControl = { signalGroup: () => undefined, groupAlive: () => true };
    const script = 'process.on("SIGTERM", () => {}); console.log(process.pid); setInterval(() => {}, 1000);';
    const { result, elapsedMs, pids } = await abortedAfterFirstLine(process.execPath, ["-e", script], { killGraceMs: 100, killConfirmMs: 200, control });
    expect(result.killUnconfirmed).toBe(true);
    expect(elapsedMs).toBeLessThan(300 + 1_500);
    // The child really is still running: the caller was told, and must not touch the tree.
    expect(alive(pids[0]!)).toBe(true);
  });

  it("does not report kill-unconfirmed for a stop that worked, and keeps the output collected before the abort", async () => {
    const script = 'console.log(process.pid); setInterval(() => {}, 1000);';
    const { result, pids } = await abortedAfterFirstLine(process.execPath, ["-e", script], { killGraceMs: 300 });
    expect(result).toEqual({ exitCode: null, stdout: `${String(pids[0])}\n`, stderr: "" });
  });

  it("gives no output to its callbacks after the abort has been made", async () => {
    const controller = new AbortController();
    const seen: string[] = [];
    let after = 0;
    const script = 'console.log(process.pid); process.on("SIGTERM", () => { console.log("after-term"); }); setInterval(() => {}, 1000);';
    const result = await runCollected(process.execPath, ["-e", script], {
      signal: controller.signal,
      killGraceMs: 300,
      onStdout: (data) => {
        if (controller.signal.aborted) after += 1;
        seen.push(data.toString("utf8"));
        if (!controller.signal.aborted) { spawned.push(Number.parseInt(seen.join("").trim(), 10)); controller.abort(); }
      },
    });
    expect(after).toBe(0);
    expect(result.stdout).not.toContain("after-term");
  });

  it("an abort of a command that finishes first changes nothing: exit code and output are the command's", async () => {
    const controller = new AbortController();
    const result = await runCollected("sh", ["-c", "echo hi; exit 3"], { signal: controller.signal });
    controller.abort();
    expect(result).toEqual({ exitCode: 3, stdout: "hi\n", stderr: "" });
  });

  it("leaves the file it was told to write unwritten: the late write of a TERM-resistant child never lands", async () => {
    const dir = await directory();
    const target = join(dir, "tracked.txt");
    const script = `process.on("SIGTERM", () => {}); console.log(process.pid); setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(target)}, "late"), 1200); setInterval(() => {}, 1000);`;
    const { result } = await abortedAfterFirstLine(process.execPath, ["-e", script], { killGraceMs: 200 });
    expect(result.killUnconfirmed).toBeUndefined();
    await delay(1_500);
    await expect(readFile(target, "utf8")).rejects.toThrow(/ENOENT/);
  });

  it("L1: a stop that settled as confirmed sends no SIGKILL afterwards (the grace timer is cleared)", async () => {
    const signals: Array<{ signal: string; at: number }> = [];
    const startedAt = Date.now();
    const control: ProcessControl = {
      signalGroup: (child, signal) => { signals.push({ signal, at: Date.now() - startedAt }); try { process.kill(-child.pid!, signal); } catch { child.kill(signal); } },
      groupAlive: (pgid) => { try { process.kill(-pgid, 0); return true; } catch { return false; } },
    };
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const result = await runCollected("sleep", ["30"], { signal: controller.signal, killGraceMs: 400, control });
    expect(result.killUnconfirmed).toBeUndefined();
    // Past the grace period: the SIGKILL that used to be sent here, to a group that no longer exists, is not.
    await delay(700);
    expect(signals.map((entry) => entry.signal)).toEqual(["SIGTERM"]);
  });
});
