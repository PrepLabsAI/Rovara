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

/** The report: one row per listening port, and a violation for every listener nobody here owns or a program that is not one of the three owns. */
export function listenerReport(proc: ProcReader = nodeProcReader()): DeviceListenerReport {
  const holders = socketHolders(proc);
  const rows: DeviceListenerRow[] = [];
  for (const { port, inode } of listeningSockets(proc)) {
    const pids = holders.get(inode) ?? [];
    if (pids.length === 0) { rows.push({ port, owner: "unowned", exe: "" }); continue; }
    const who = pids.map((pid) => identifyProcess(proc, pid));
    const bad = who.find((row) => row.owner === "other");
    rows.push(bad !== undefined ? { port, owner: "other", exe: bad.exe } : { port, owner: who[0]!.owner, exe: who[0]!.exe });
  }
  return { rows, violations: rows.filter((row) => row.owner === "unowned" || row.owner === "other").map((row) => `${String(row.port)} ${row.owner} ${row.exe}`.trim()) };
}

/** Looks every `everyMs` until stopped and keeps every listener it ever saw (a port that appears later with a worse owner replaces the earlier row). */
export function watchDeviceListeners(everyMs: number, proc: ProcReader = nodeProcReader()): { stop(): DeviceListenerReport } {
  const seen = new Map<number, DeviceListenerRow>();
  const look = () => {
    for (const row of listenerReport(proc).rows) {
      const before = seen.get(row.port);
      if (before === undefined || before.owner === row.owner || row.owner === "unowned" || row.owner === "other") seen.set(row.port, row);
    }
  };
  look();
  const timer = setInterval(look, everyMs);
  return {
    stop() {
      clearInterval(timer);
      look();
      const rows = [...seen.values()].sort((a, b) => a.port - b.port);
      return { rows, violations: rows.filter((row) => row.owner === "unowned" || row.owner === "other").map((row) => `${String(row.port)} ${row.owner} ${row.exe}`.trim()) };
    },
  };
}
