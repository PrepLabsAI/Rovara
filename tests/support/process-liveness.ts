// Whether a process (or a process group) a test started has ended, the same on every machine the suite runs on.
//
// `process.kill(pid, 0)` alone is not enough. A process that has exited but that no parent has reaped yet (a zombie) still answers it. A killed grandchild is
// handed to the machine's first process: on a GitHub runner (a VM, systemd first) it is reaped at once; in a container whose first process does not reap
// (an AWS CodeBuild build, a plain `docker run`) it stays a zombie until the container ends. A zombie has ended, so here it counts as ended.
import { readdirSync, readFileSync } from "node:fs";

/** The process state letter and process group from /proc/<pid>/stat (Linux), or undefined when the file is gone or there is no /proc. */
function procStat(pid: number): { state: string; pgrp: number } | undefined {
  if (process.platform !== "linux") return undefined;
  let text: string;
  try { text = readFileSync(`/proc/${pid}/stat`, "utf8"); } catch { return undefined; }
  // pid (comm) state ppid pgrp ...: comm may hold spaces and parentheses, so the fields start after the last ")".
  const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
  return { state: fields[0] ?? "", pgrp: Number(fields[2]) };
}

const ended = (state: string): boolean => state === "Z" || state === "X";

/** True when the process has ended: no such process, or (Linux) only its zombie is left. A live process of another user (EPERM) has not ended. */
export function processEnded(pid: number): boolean {
  try { process.kill(pid, 0); } catch (error) { return (error as NodeJS.ErrnoException).code !== "EPERM"; }
  const stat = procStat(pid);
  if (stat !== undefined) return ended(stat.state);
  // Linux, and the process went between the two reads: it has ended. Elsewhere kill(pid, 0) succeeding means it is running (macOS reaps orphans through launchd).
  return process.platform === "linux";
}

/** True while the process has not ended (see processEnded). */
export const processAlive = (pid: number): boolean => !processEnded(pid);

/** True while some member of the process group has not ended: kill(-pgid, 0) answers for zombie members too, so on Linux the members are read from /proc. */
export function processGroupAlive(pgid: number): boolean {
  try { process.kill(-pgid, 0); } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
  if (process.platform !== "linux") return true;
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const stat = procStat(Number(entry));
    if (stat !== undefined && stat.pgrp === pgid && !ended(stat.state)) return true;
  }
  return false;
}
