// Device testing slice 2: who owns each listening socket in the namespace the device executor shares with the task sandbox, judged on a made-up /proc. The point is the failure cases: a listener that
// nothing in the executor holds (the sandbox's own code lives in another process namespace) and a listener held by a program that is not the emulator, adb or Maestro must each be a violation.
import { describe, expect, it, vi } from "vitest";
import { DEVICE_ADB_PATH, DEVICE_EMULATOR_DIR, DEVICE_LISTENER_RESAMPLE, identifyProcess, listenerReport, listeningSockets, watchDeviceListeners, type ProcReader, type Resample } from "../../packages/verifier/src/executor/device-listeners.js";

const HEADER = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
const row = (n: number, port: number, state: string, inode: number, ip = "0100007F") => `   ${String(n)}: ${ip}:${port.toString(16).toUpperCase().padStart(4, "0")} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000 10001 0 ${String(inode)} 1 0000000000000000 100 0 0 10 0\n`;

interface FakeProc { tcp?: string; tcp6?: string; procs?: Record<number, { exe?: string; cmdline?: string[]; sockets?: number[] }> }
function fake(input: FakeProc): ProcReader {
  const procs = input.procs ?? {};
  return {
    read: (path) => {
      if (path === "/proc/net/tcp") return input.tcp ?? HEADER;
      if (path === "/proc/net/tcp6") return input.tcp6 ?? HEADER;
      const cmd = /^\/proc\/(\d+)\/cmdline$/u.exec(path);
      return cmd === null ? undefined : (procs[Number(cmd[1])]?.cmdline ?? []).join("\0");
    },
    list: (path) => {
      if (path === "/proc") return ["self", "net", ...Object.keys(procs)];
      const fds = /^\/proc\/(\d+)\/fd$/u.exec(path);
      return fds === null ? [] : (procs[Number(fds[1])]?.sockets ?? []).map((_inode, index) => String(index + 3));
    },
    link: (path) => {
      const exe = /^\/proc\/(\d+)\/exe$/u.exec(path);
      if (exe !== null) return procs[Number(exe[1])]?.exe;
      const fd = /^\/proc\/(\d+)\/fd\/(\d+)$/u.exec(path);
      const inode = fd === null ? undefined : procs[Number(fd[1])]?.sockets?.[Number(fd[2]) - 3];
      return inode === undefined ? undefined : `socket:[${String(inode)}]`;
    },
  };
}
const EMU = `${DEVICE_EMULATOR_DIR}qemu/linux-x86_64/qemu-system-x86_64-headless`;
const JAVA = "/usr/lib/jvm/java-17-openjdk-amd64/bin/java";
const normal: FakeProc = {
  tcp: HEADER + row(0, 5037, "0A", 111) + row(1, 5554, "0A", 222) + row(2, 5555, "0A", 222) + row(3, 40000, "01", 333) + row(4, 41000, "0A", 444),
  tcp6: HEADER + row(0, 50000, "0A", 555),
  procs: {
    10: { exe: DEVICE_ADB_PATH, cmdline: [DEVICE_ADB_PATH, "server", "nodaemon"], sockets: [111] },
    11: { exe: EMU, cmdline: [EMU, "-avd", "rovara"], sockets: [222] },
    12: { exe: JAVA, cmdline: [JAVA, "-classpath", "/opt/maestro/lib/maestro-cli.jar", "maestro.cli.AppKt"], sockets: [444, 555] },
  },
};

describe("device listener ownership", () => {
  it("reads only listening sockets (state 0A) from both tables, with their ports and inodes", () => {
    expect(listeningSockets(fake(normal))).toEqual([{ port: 5037, inode: "111" }, { port: 5554, inode: "222" }, { port: 5555, inode: "222" }, { port: 41000, inode: "444" }, { port: 50000, inode: "555" }]);
    expect(listeningSockets(fake({ tcp: HEADER + row(0, 80, "0A", 0) }))).toEqual([]);
  });

  it("MUTANT: Java is Maestro only when its command line names Maestro's directory, and the emulator only when its file is under the emulator's directory", () => {
    const other = { ...normal, procs: { ...normal.procs, 12: { exe: JAVA, cmdline: [JAVA, "-jar", "/tmp/evil.jar"], sockets: [444, 555] } } };
    expect(listenerReport(fake(other)).violations).toEqual(["41000 other " + JAVA, "50000 other " + JAVA]);
    expect(identifyProcess(fake({ procs: { 1: { exe: "/opt/android-sdk/emulatorX/run" } } }), 1).owner).toBe("other");
    expect(identifyProcess(fake({ procs: { 1: { exe: `${DEVICE_EMULATOR_DIR}../x/y` } } }), 1).owner).toBe("other");
    expect(identifyProcess(fake({ procs: { 1: {} } }), 1)).toEqual({ owner: "other", exe: "" });
  });

  it("the watcher keeps a listener seen once even if it is gone at the end, and a worse owner replaces a better one", () => {
    let calls = 0;
    const base = fake(normal);
    const stray = fake({ ...normal, tcp: (normal.tcp ?? "") + row(9, 8081, "0A", 999) });
    const watched = watchDeviceListeners(1_000_000, { ...base, read: (path) => ((calls++ === 0 ? stray : base).read(path)) });
    const report = watched.stop();
    expect(report.rows.some((entry) => entry.port === 8081 && entry.owner === "unowned")).toBe(true);
    expect(report.violations).toEqual(["8081 unowned"]);
  });
});
const noSleep = (log: number[] = []): Resample => ({ ...DEVICE_LISTENER_RESAMPLE, sleep: (ms) => { log.push(ms); } });

describe("device listener ownership: a listener is unowned only if every look finds no holder", () => {

  it("MUTANT: looking again does not widen who counts: a program that shows up holding the socket later is 'other', which is a violation", () => {
    const base = fake(normal); let looks = 0;
    const proc: ProcReader = { ...base, list: (path) => {
      if (path === "/proc/11/fd") { looks += 1; return looks === 1 ? [] : base.list(path); }
      if (path === "/proc/13/fd") return looks === 1 ? [] : ["3"];
      return base.list(path);
    }, link: (path) => (path === "/proc/13/fd/3" ? "socket:[222]" : path === "/proc/13/exe" ? "/usr/local/bin/node" : base.link(path)) };
    const withIntruder: ProcReader = { ...proc, list: (path) => (path === "/proc" ? [...base.list(path), "13"] : proc.list(path)) };
    expect(listenerReport(withIntruder, noSleep()).violations).toEqual(["5554 other /usr/local/bin/node", "5555 other /usr/local/bin/node"]);
  });
});

// ---- the flake that the resample did not fix (9 of ~30 device-runtime runs, 2026-11-16 to 2026-11-17, always this one assertion): a socket whose holder is going away reads unowned for longer than the window ----
describe("device listener ownership: a socket that an owner held and that nobody holds now is closing, not a stray", () => {

  it("MUTANT: a program that holds the socket after the owner let go is 'other', which the history never excuses, even when it lets go too", () => {
    // look 1: the emulator (11) holds inode 222. look 2: 11 is gone and 13 (not an owner) holds it. look 3: nobody holds it.
    const base = fake(normal); let looks = 0; let phase = 0;
    const proc: ProcReader = {
      ...base,
      read: (path) => { if (path === "/proc/net/tcp") { looks += 1; phase = looks; } return base.read(path); },
      list: (path) => {
        if (path === "/proc") return [...base.list(path), "13"];
        if (path === "/proc/11/fd") return phase === 1 ? base.list(path) : [];
        if (path === "/proc/13/fd") return phase === 2 ? ["3"] : [];
        return base.list(path);
      },
      link: (path) => (path === "/proc/13/fd/3" ? "socket:[222]" : path === "/proc/13/exe" ? "/usr/local/bin/node" : base.link(path)),
    };
    vi.useFakeTimers();
    try {
      const watched = watchDeviceListeners(500, proc, { ...noSleep(), attempts: 1 }); // look 1
      vi.advanceTimersByTime(500); // look 2
      const stopped = watched.stop(); // look 3
      expect(looks).toBe(3);
      expect(stopped.violations).toEqual(["5554 other /usr/local/bin/node", "5555 other /usr/local/bin/node"]);
    } finally { vi.useRealTimers(); }
  });
});
