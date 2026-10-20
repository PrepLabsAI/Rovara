import { execFile, spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import type { RmOptions } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

export type LocalChromium = Readonly<{ cdpEndpoint: string; pid: number; close(): Promise<void> }>;

const STARTUP_TIMEOUT_MS = 30_000;
/** How long Chromium and its helper processes get to exit on SIGTERM before they are killed, and how long the kill itself is waited for. */
const GRACEFUL_EXIT_MS = 3_000;
const KILLED_EXIT_MS = 2_000;
const EXIT_POLL_MS = 25;
/** However slow the process table is to read, the waits for the browser's processes to exit end this long after the main process has exited. */
const EXIT_WAIT_CEILING_MS = 8_000;
/** Removing the profile directory: attempts of `fs.rm` (itself retrying ENOTEMPTY and busy errors), with a pause between attempts. */
const PROFILE_REMOVAL_ATTEMPTS = 4;
const PROFILE_REMOVAL_PAUSE_MS = 100;

const pause = (milliseconds: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, milliseconds); });
const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * One process as the operating system lists it: its parent, whether it has already exited and is only waiting to be reaped, and when it started (the kernel's
 * start time in procfs, `lstart` from ps). A pid alone can be reused by an unrelated process; a pid with the start time it had when it was recorded cannot.
 */
export type ProcessEntry = Readonly<{ ppid: number; zombie: boolean; start: string }>;
export type ProcessTable = ReadonlyMap<number, ProcessEntry>;

/** Every process on the host: from procfs where there is one (the executor container), otherwise from `ps` (a developer's macOS). Empty when neither answers. */
export async function readProcessTable(procRoot = "/proc"): Promise<ProcessTable> {
  const table = new Map<number, ProcessEntry>();
  try {
    for (const name of await readdir(procRoot)) {
      if (!/^\d+$/.test(name)) continue;
      try {
        // "pid (comm) S ppid ...": comm may hold spaces and parentheses, so the fields are read after its last closing parenthesis.
        const stat = await readFile(`${procRoot}/${name}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        const ppid = Number(fields[1]);
        // Field 22 (index 19 after the state) is the start time in clock ticks since boot.
        if (Number.isInteger(ppid)) table.set(Number(name), { ppid, zombie: fields[0] === "Z" || fields[0] === "X", start: fields[19] ?? "" });
      } catch { /* the process exited while the table was read */ }
    }
    return table;
  } catch { /* no procfs: ask ps */ }
  return new Promise((resolve) => {
    execFile("ps", ["-A", "-o", "pid=,ppid=,stat=,lstart="], { timeout: 5_000 }, (error, stdout) => {
      if (error) { resolve(table); return; }
      for (const line of stdout.split("\n")) {
        // lstart is several words ("Mon Oct 19 22:48:13 2026"): everything after the state.
        const [pid, ppid, state, ...started] = line.trim().split(/\s+/);
        if (/^\d+$/.test(pid ?? "") && /^\d+$/.test(ppid ?? "")) table.set(Number(pid), { ppid: Number(ppid), zombie: state?.startsWith("Z") ?? false, start: started.join(" ") });
      }
      resolve(table);
    });
  });
}

/** The pid itself and everything below it in the table. */
function subtreeOf(root: number, table: ProcessTable): number[] {
  const found = new Set<number>([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, entry] of table) if (!found.has(pid) && found.has(entry.ppid)) { found.add(pid); grew = true; }
  }
  return [...found];
}

/**
 * Removes a directory Chromium (or a helper process of it) may still have been writing to: `fs.rm` already retries ENOTEMPTY and busy errors, and a bounded
 * number of whole attempts follows it. It never throws: it returns the last error, or null once the directory is gone, because a cleanup failure must be
 * reported as a diagnostic and never decide the outcome of the work it cleans up after.
 */
export async function removeDirectoryWithRetries(path: string, seams: Readonly<{ remove?: (path: string, options: RmOptions) => Promise<void>;
  sleep?: (milliseconds: number) => Promise<void>; attempts?: number }> = {}): Promise<Error | null> {
  const remove = seams.remove ?? rm;
  const sleep = seams.sleep ?? pause;
  const attempts = Math.max(1, seams.attempts ?? PROFILE_REMOVAL_ATTEMPTS);
  let last: Error | null = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { await remove(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); return null; }
    catch (error) {
      last = error instanceof Error ? error : new Error(String(error));
      if (attempt < attempts) await sleep(PROFILE_REMOVAL_PAUSE_MS * attempt);
    }
  }
  return last;
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason instanceof Error ? signal.reason : new Error("chromium launch was cancelled")); return; }
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, milliseconds);
    const abort = () => { clearTimeout(timer); reject(signal.reason instanceof Error ? signal.reason : new Error("chromium launch was cancelled")); };
    signal.addEventListener("abort", abort, { once: true });
  });
}

/**
 * Starts the pinned Playwright Chromium inside the executor container and hands back its DevTools endpoint.
 *
 * Chromium's own sandbox stays on: its renderers run behind a seccomp filter in their own user and PID namespaces, so a hostile page has
 * to escape that before it reaches this process and the run's result files. It needs the executor container's pinned seccomp profile (it
 * lets an unprivileged process create namespaces; no capability is added) and a kernel that allows unprivileged user namespaces. When the
 * sandbox cannot start Chromium exits and this launch fails: there is deliberately no flag and no retry that falls back to an unsandboxed
 * browser. The debugging port is bound to loopback, so only processes inside this container can attach.
 */
export async function launchLocalChromium(input: { downloadDir: string; signal: AbortSignal;
  /** Test seam for a Chromium binary other than the pinned Playwright one. */
  executablePath?: string;
  /**
   * Where a cleanup problem is reported (the browser's helper processes would not exit, the profile directory would not go away). Cleanup never throws and never
   * replaces the outcome of the work it follows, so this is the only place such a problem is visible. The default writes it to stderr.
   */
  onCleanupDiagnostic?: (message: string) => void | Promise<void>;
  /** Test seams: removing the profile directory, the pause between looks, the clock the waits are bounded on, and the process table. */
  removeDirectory?: (path: string, options: RmOptions) => Promise<void>; sleep?: (milliseconds: number) => Promise<void>; now?: () => number;
  readProcesses?: () => Promise<ProcessTable> }): Promise<LocalChromium> {
  const executable = input.executablePath ?? chromium.executablePath();
  try { await access(executable); } catch { throw new Error(`chromium executable is not installed at ${executable}`); }
  await mkdir(input.downloadDir, { recursive: true, mode: 0o755 });
  const profile = await mkdtemp(join(tmpdir(), "rovara-chromium-"));
  await mkdir(join(profile, "Default"), { recursive: true });
  // Downloads that Chromium itself saves land in the ledger's downloads directory; the owning Playwright context still
  // fetches its own copy through DevTools.
  await writeFile(join(profile, "Default", "Preferences"), JSON.stringify({ download: { default_directory: input.downloadDir,
    prompt_for_download: false, directory_upgrade: true } }));
  const args = ["--headless=new", "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-extensions", "--metrics-recording-only",
    "--mute-audio", "--password-store=basic", "--use-mock-keychain", `--user-data-dir=${profile}`,
    "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
    "about:blank"];
  // Chromium sees only what it needs: the host's own environment may hold credentials that no page may ever read.
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: profile, TMPDIR: tmpdir(), LANG: "C.UTF-8" };
  const child: ChildProcess = spawn(executable, args, { env, stdio: ["ignore", "ignore", "pipe"], shell: false });
  let stderrTail = "";
  child.stderr?.on("data", (chunk: Buffer) => { stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-8192); });
  let exited = false;
  const exit = new Promise<void>((resolve) => { child.once("exit", () => { exited = true; resolve(); }); });
  child.once("error", () => { exited = true; });

  const diagnose = async (message: string): Promise<void> => {
    const line = `chromium cleanup diagnostic: ${message}`;
    try { await (input.onCleanupDiagnostic ? input.onCleanupDiagnostic(line) : process.stderr.write(`${line}\n`)); } catch { /* a diagnostic sink that fails cannot be reported to itself */ }
  };
  // Chromium's own exit is not the end of its work: its network, GPU and utility helpers outlive the main process by a moment and keep writing into the
  // profile, so removing the profile as soon as the main process exits races them (ENOTEMPTY). Cleanup waits for every process below the browser first.
  const stopEveryProcess = async (): Promise<void> => {
    const now = input.now ?? Date.now;
    const sleep = input.sleep ?? pause;
    const readProcesses = input.readProcesses ?? (() => readProcessTable());
    // Each tracked pid is kept with the start time it had when it was recorded: a pid that is later listed with another start time is a different
    // process that reused the number, and is neither waited for nor signalled.
    const tracked = new Map<number, string>();
    if (!exited && child.pid !== undefined) {
      const table = await readProcesses();
      for (const pid of subtreeOf(child.pid, table)) tracked.set(pid, table.get(pid)?.start ?? "");
    }
    if (!exited) {
      child.kill("SIGTERM");
      const killer = setTimeout(() => { if (!exited) child.kill("SIGKILL"); }, GRACEFUL_EXIT_MS);
      await exit;
      clearTimeout(killer);
    }
    tracked.delete(child.pid ?? -1);
    const alive = async (): Promise<number[]> => {
      const table = await readProcesses();
      const same = (pid: number): boolean => table.has(pid) && table.get(pid)!.start === tracked.get(pid);
      for (const pid of [...tracked.keys()]) if (same(pid)) for (const below of subtreeOf(pid, table)) if (!tracked.has(below)) tracked.set(below, table.get(below)?.start ?? "");
      return [...tracked.keys()].filter((pid) => same(pid) && !table.get(pid)!.zombie);
    };
    const begun = now();
    // A wait ends when nothing is left, or at the later of its look count and its time (so a fast table cannot cut it short and a slow one cannot stretch
    // it), and never later than the ceiling after the main process exited.
    const waitFor = async (milliseconds: number): Promise<number[]> => {
      const phaseBegun = now();
      let remaining = await alive();
      for (let looks = 0; remaining.length > 0; looks += 1) {
        if (now() - begun >= EXIT_WAIT_CEILING_MS) break;
        if (looks >= milliseconds / EXIT_POLL_MS && now() - phaseBegun >= milliseconds) break;
        await sleep(EXIT_POLL_MS);
        remaining = await alive();
      }
      return remaining;
    };
    let remaining = await waitFor(GRACEFUL_EXIT_MS);
    if (remaining.length > 0) {
      for (const pid of remaining) { try { process.kill(pid, "SIGKILL"); } catch { /* it exited meanwhile */ } }
      remaining = await waitFor(KILLED_EXIT_MS);
    }
    if (remaining.length > 0) await diagnose(`process(es) ${remaining.join(", ")} of the browser did not exit before its profile directory was removed`);
  };
  let closing: Promise<void> | null = null;
  const closeOnce = async (): Promise<void> => {
    try { await stopEveryProcess(); }
    catch (error) { await diagnose(`could not wait for the browser's processes to exit: ${describeError(error)}`); }
    const failure = await removeDirectoryWithRetries(profile, { ...(input.removeDirectory ? { remove: input.removeDirectory } : {}), ...(input.sleep ? { sleep: input.sleep } : {}) });
    if (failure) await diagnose(`could not remove the profile directory ${profile}: ${failure.message}`);
  };
  const close = (): Promise<void> => (closing ??= closeOnce());

  try {
    const startup = AbortSignal.any([input.signal, AbortSignal.timeout(STARTUP_TIMEOUT_MS)]);
    for (;;) {
      if (exited) throw new Error(`chromium exited before it opened a debugging port: ${stderrTail.trim().slice(-500)}`);
      try {
        const [port, path] = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n");
        if (port && /^\d{2,5}$/.test(port) && path?.startsWith("/devtools/browser/")) {
          return Object.freeze({ cdpEndpoint: `ws://127.0.0.1:${port}${path}`, pid: child.pid ?? 0, close });
        }
      } catch { /* the file appears once the browser listens */ }
      await wait(50, startup);
    }
  } catch (error) {
    await close();
    throw error;
  }
}
