// Device testing slice 2 (DEC 244): who owns every listening TCP socket in the namespace the device executor shares with the task sandbox. For the CI test only (the entry program turns it on with
// ROVARA_DEVICE_DIAG=1, and the Linux test reads the one line it prints); it changes nothing and its output never reaches the evidence. A listener is found in /proc/net/tcp and /proc/net/tcp6 (state
// 0A) by its socket inode, and owned by the process in THIS container that holds that inode in /proc/<pid>/fd. A process is identified by what it runs (the path of its executable), never by a name it
// chooses or a port number: the emulator (anything under the SDK's emulator directory), adb (the SDK's one adb binary) and Maestro (the JRE running a command line that names /opt/maestro). A listener
// that no process here holds (the sandbox's own code lives in another process namespace, so it shows up as owned by nobody) or that another program here holds is a violation.
import { readdirSync, readFileSync, readlinkSync } from "node:fs";

export const DEVICE_EMULATOR_DIR = "/opt/android-sdk/emulator/";
export const DEVICE_ADB_PATH = "/opt/android-sdk/platform-tools/adb";
export const DEVICE_MAESTRO_DIR = "/opt/maestro/";

export type DeviceListenerOwner = "emulator" | "adb" | "maestro" | "other" | "unowned";
export type DeviceListenerRow = Readonly<{ port: number; owner: DeviceListenerOwner; exe: string }>;
export type DeviceListenerReport = Readonly<{ rows: readonly DeviceListenerRow[]; violations: readonly string[] }>;

/** The three reads this needs, so a test can give it a made-up /proc. Each answers undefined for a path that cannot be read. */
export type ProcReader = Readonly<{ read(path: string): string | undefined; list(path: string): readonly string[]; link(path: string): string | undefined }>;

export function nodeProcReader(): ProcReader {
  return {
    read: (path) => { try { return readFileSync(path, "utf8"); } catch { return undefined; } },
    list: (path) => { try { return readdirSync(path); } catch { return []; } },
    link: (path) => { try { return readlinkSync(path); } catch { return undefined; } },
  };
}

/** Every listening socket of the namespace: its port and its inode. */
export function listeningSockets(proc: ProcReader): Array<{ port: number; inode: string }> {
  const found: Array<{ port: number; inode: string }> = [];
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    for (const line of (proc.read(file) ?? "").split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/u);
      if (fields.length < 10 || fields[3] !== "0A") continue;
      const port = Number.parseInt((fields[1] ?? "").split(":")[1] ?? "", 16);
      const inode = fields[9] ?? "";
      if (Number.isInteger(port) && port > 0 && /^\d+$/u.test(inode) && inode !== "0") found.push({ port, inode });
    }
  }
  return found;
}

/** Which processes of this container hold which socket inode. */
export function socketHolders(proc: ProcReader): Map<string, number[]> {
  const holders = new Map<string, number[]>();
  for (const name of proc.list("/proc")) {
    if (!/^\d+$/u.test(name)) continue;
    for (const fd of proc.list(`/proc/${name}/fd`)) {
      const inode = /^socket:\[(\d+)\]$/u.exec(proc.link(`/proc/${name}/fd/${fd}`) ?? "")?.[1];
      if (inode === undefined) continue;
      const list = holders.get(inode) ?? [];
      if (!list.includes(Number(name))) list.push(Number(name));
      holders.set(inode, list);
    }
  }
  return holders;
}

/** What a process is, by the file it runs. */
export function identifyProcess(proc: ProcReader, pid: number): { owner: Exclude<DeviceListenerOwner, "unowned">; exe: string } {
  const exe = proc.link(`/proc/${String(pid)}/exe`) ?? "";
  if (exe.startsWith(DEVICE_EMULATOR_DIR) && !exe.includes("..")) return { owner: "emulator", exe };
  if (exe === DEVICE_ADB_PATH) return { owner: "adb", exe };
  const command = (proc.read(`/proc/${String(pid)}/cmdline`) ?? "").split("\0");
  if (/(^|\/)java$/u.test(exe) && command.some((word) => word.startsWith(DEVICE_MAESTRO_DIR))) return { owner: "maestro", exe };
  return { owner: "other", exe };
}

/** How hard to look again before a listener is called unowned (see `listenerReport`). `sleep` is a parameter so a test does not wait. */
export type Resample = Readonly<{ attempts: number; delayMs: number; sleep(ms: number): void }>;
const sleepSync = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
/** Four looks 100 ms apart: far longer than a process takes to finish an exec or open its sockets, short enough that a real stray still reads unowned well inside a run. */
export const DEVICE_LISTENER_RESAMPLE: Resample = { attempts: 4, delayMs: 100, sleep: sleepSync };

/** One look: the listening table FIRST, then who holds each socket. In that order a socket opened after the table was read is simply not in this look, rather than listed with no holder yet. */
function look(proc: ProcReader): DeviceListenerRow[] {
  const sockets = listeningSockets(proc);
  const holders = socketHolders(proc);
  const rows: DeviceListenerRow[] = [];
  for (const { port, inode } of sockets) {
    const pids = holders.get(inode) ?? [];
    if (pids.length === 0) { rows.push({ port, owner: "unowned", exe: "" }); continue; }
    const who = pids.map((pid) => identifyProcess(proc, pid));
    const bad = who.find((row) => row.owner === "other");
    rows.push(bad !== undefined ? { port, owner: "other", exe: bad.exe } : { port, owner: who[0]!.owner, exe: who[0]!.exe });
  }
  return rows;
}

/**
 * The report: one row per listening port, and a violation for every listener nobody here owns or a program that is not one of the three owns.
 * /proc is not read atomically (the listening table, the process list and each process's descriptors are three separate reads), so a process that is
 * mid-exec or has just opened its sockets can read as holding nothing for a moment: the emulator's own ports 5554, 5555 and 42311 read "unowned" once in CI.
 * So a listener that reads unowned is looked at again, up to `attempts` looks `delayMs` apart, and is unowned only if no look finds a holder. A later look only ever
 * replaces "unowned" with what it found (an owner, or "other", which is a violation too): who counts as an owner is not widened, and a stray that no process here holds stays unowned.
 */
export function listenerReport(proc: ProcReader = nodeProcReader(), resample: Resample = DEVICE_LISTENER_RESAMPLE): DeviceListenerReport {
  let rows = look(proc);
  for (let attempt = 1; attempt < resample.attempts && rows.some((row) => row.owner === "unowned"); attempt += 1) {
    resample.sleep(resample.delayMs);
    const again = new Map(look(proc).map((row) => [row.port, row]));
    rows = rows.map((row) => { const found = row.owner === "unowned" ? again.get(row.port) : undefined; return found !== undefined && found.owner !== "unowned" ? found : row; });
  }
  return { rows, violations: rows.filter((row) => row.owner === "unowned" || row.owner === "other").map((row) => `${String(row.port)} ${row.owner} ${row.exe}`.trim()) };
}

/** Looks every `everyMs` until stopped and keeps every listener it ever saw (a port that appears later with a worse owner replaces the earlier row). */
export function watchDeviceListeners(everyMs: number, proc: ProcReader = nodeProcReader(), resample: Resample = DEVICE_LISTENER_RESAMPLE): { stop(): DeviceListenerReport } {
  const seen = new Map<number, DeviceListenerRow>();
  const lookNow = () => {
    for (const row of listenerReport(proc, resample).rows) {
      const before = seen.get(row.port);
      if (before === undefined || before.owner === row.owner || row.owner === "unowned" || row.owner === "other") seen.set(row.port, row);
    }
  };
  lookNow();
  const timer = setInterval(lookNow, everyMs);
  return {
    stop() {
      clearInterval(timer);
      lookNow();
      const rows = [...seen.values()].sort((a, b) => a.port - b.port);
      return { rows, violations: rows.filter((row) => row.owner === "unowned" || row.owner === "other").map((row) => `${String(row.port)} ${row.owner} ${row.exe}`.trim()) };
    },
  };
}
