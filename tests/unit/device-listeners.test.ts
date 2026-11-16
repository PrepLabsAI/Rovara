// Device testing slice 2: who owns each listening socket in the namespace the device executor shares with the task sandbox, judged on a made-up /proc. The point is the failure cases: a listener that
// nothing in the executor holds (the sandbox's own code lives in another process namespace) and a listener held by a program that is not the emulator, adb or Maestro must each be a violation.
import { describe, expect, it } from "vitest";
import { DEVICE_ADB_PATH, DEVICE_EMULATOR_DIR, identifyProcess, listenerReport, listeningSockets, watchDeviceListeners, type ProcReader } from "../../packages/verifier/src/executor/device-listeners.js";

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

  it("says the emulator, adb and Maestro own what they hold, by the file each one runs, and finds no violation", () => {
    const report = listenerReport(fake(normal));
    expect(report.violations).toEqual([]);
    expect(report.rows.map((entry) => [entry.port, entry.owner])).toEqual([[5037, "adb"], [5554, "emulator"], [5555, "emulator"], [41000, "maestro"], [50000, "maestro"]]);
  });

  it("MUTANT: a listener that no process of the executor holds (a stray one started by the sandbox's own code, which lives in another process namespace) is a violation", () => {
    const report = listenerReport(fake({ ...normal, tcp: (normal.tcp ?? "") + row(9, 8081, "0A", 999) }));
    expect(report.rows.find((entry) => entry.port === 8081)?.owner).toBe("unowned");
    expect(report.violations).toEqual(["8081 unowned"]);
  });

  it("MUTANT: a listener held by some other program of the executor is a violation, whatever it is called or which port it uses", () => {
    const sneaky = { ...normal, procs: { ...normal.procs, 13: { exe: "/usr/local/bin/node", cmdline: ["/opt/android-sdk/platform-tools/adb"], sockets: [777] } }, tcp: (normal.tcp ?? "") + row(9, 5037, "0A", 777) };
    expect(listenerReport(fake(sneaky)).violations).toEqual(["5037 other /usr/local/bin/node"]);
    // a name the program chose (its command line) never counts: only the file it runs
    expect(identifyProcess(fake(sneaky), 13)).toEqual({ owner: "other", exe: "/usr/local/bin/node" });
  });

  it("MUTANT: Java is Maestro only when its command line names Maestro's directory, and the emulator only when its file is under the emulator's directory", () => {
    const other = { ...normal, procs: { ...normal.procs, 12: { exe: JAVA, cmdline: [JAVA, "-jar", "/tmp/evil.jar"], sockets: [444, 555] } } };
    expect(listenerReport(fake(other)).violations).toEqual(["41000 other " + JAVA, "50000 other " + JAVA]);
    expect(identifyProcess(fake({ procs: { 1: { exe: "/opt/android-sdk/emulatorX/run" } } }), 1).owner).toBe("other");
    expect(identifyProcess(fake({ procs: { 1: { exe: `${DEVICE_EMULATOR_DIR}../x/y` } } }), 1).owner).toBe("other");
    expect(identifyProcess(fake({ procs: { 1: {} } }), 1)).toEqual({ owner: "other", exe: "" });
  });

  it("a socket held by an owner and by a stranger together counts as the stranger's", () => {
    const shared = { ...normal, procs: { ...normal.procs, 13: { exe: "/bin/sh", sockets: [222] } } };
    expect(listenerReport(fake(shared)).violations).toEqual(["5554 other /bin/sh", "5555 other /bin/sh"]);
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
