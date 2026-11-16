// Device testing slice 2 (DEC 244): how the Android driver starts programs inside the device executor. One port, so the driver is tested with a scripted one and nothing else ever starts a process.
// No shell: a file and its arguments, never a string to be split. Every run has a time limit and an output limit (more than the limit is "too large", and the command is stopped), the whole
// process group is ended when it is stopped (the emulator and Maestro start helpers of their own), and the environment is the one the caller gives, plus nothing.
import { spawn } from "node:child_process";

/**
 * `mergeStderr` adds the program's error output to the end of what it printed (for a program whose failure reasons go there, never for one that prints bytes of a picture). `cwd` (slice 4: the project's
 * own build runs in a checkout) is the directory the program starts in. `discardOutput` keeps none of the output and sets no limit on it (a build prints without end); the result's `stdout` is empty.
 */
export type DeviceCommandOptions = Readonly<{ timeoutMs: number; maxStdoutBytes: number; env?: Readonly<Record<string, string>>; mergeStderr?: boolean; cwd?: string; discardOutput?: boolean }>;
export type DeviceCommandResult = Readonly<{ exitCode: number | null; stdout: Uint8Array; timedOut: boolean; tooLarge: boolean }>;
export type DeviceBackground = Readonly<{
  /** Whether the program is still running. */
  running(): boolean;
  /** The end of what the program printed (output and errors), only when it was started with `capture`: for the CI test's diagnostic lines, never kept anywhere else. */
  tail?(): string;
  /** Asks the program's group to end, then forces it after `graceMs`; resolves when it is gone (or after the force, at most `graceMs` + 2 s). */
  stop(graceMs: number): Promise<void>;
}>;
export type DeviceCommandPort = Readonly<{
  run(file: string, args: readonly string[], options: DeviceCommandOptions): Promise<DeviceCommandResult>;
  /** Starts a program that keeps running (the emulator). Its output is discarded, unless `capture` asks for the last 2,000 characters of it (see `tail`). */
  start(file: string, args: readonly string[], options: { env?: Readonly<Record<string, string>>; capture?: boolean }): DeviceBackground;
}>;

const NO_BYTES = new Uint8Array(0);
function endGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  // A negative pid is the process group: the program and everything it started.
  try { process.kill(-pid, signal); } catch { /* already gone */ }
}

/** The real port, over `child_process`. */
export function createNodeCommandPort(): DeviceCommandPort {
  return {
    run(file, args, options) {
      return new Promise<DeviceCommandResult>((resolve) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let timedOut = false;
        let tooLarge = false;
        let settled = false;
        const discard = options.discardOutput === true;
        const child = spawn(file, [...args], {
          detached: true, stdio: ["ignore", discard ? "ignore" : "pipe", options.mergeStderr === true && !discard ? "pipe" : "ignore"], env: { ...(options.env ?? {}) }, ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        });
        const finish = (exitCode: number | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          // Whatever the program left behind in its group is ended with it.
          endGroup(child.pid, "SIGKILL");
          resolve({ exitCode, stdout: tooLarge ? NO_BYTES : new Uint8Array(Buffer.concat(chunks)), timedOut, tooLarge });
        };
        const timer = setTimeout(() => { timedOut = true; endGroup(child.pid, "SIGKILL"); finish(null); }, Math.max(1, options.timeoutMs));
        const collect = (chunk: Buffer) => {
          if (tooLarge) return;
          size += chunk.byteLength;
          if (size > options.maxStdoutBytes) { tooLarge = true; chunks.length = 0; endGroup(child.pid, "SIGKILL"); return; }
          chunks.push(chunk);
        };
        child.stdout?.on("data", collect);
        child.stderr?.on("data", collect);
        child.once("error", () => finish(null));
        child.once("close", (code) => finish(code));
      });
    },
    start(file, args, options) {
      let exited = false;
      let last = "";
      const child = spawn(file, [...args], { detached: true, stdio: options.capture === true ? ["ignore", "pipe", "pipe"] : "ignore", env: { ...(options.env ?? {}) } });
      if (options.capture === true) {
        const keep = (chunk: Buffer) => { last = (last + chunk.toString("utf8")).slice(-2_000); };
        child.stdout?.on("data", keep);
        child.stderr?.on("data", keep);
      }
      const gone = new Promise<void>((resolve) => { child.once("exit", () => { exited = true; resolve(); }); child.once("error", () => { exited = true; resolve(); }); });
      return {
        running: () => !exited,
        ...(options.capture === true ? { tail: () => last } : {}),
        async stop(graceMs) {
          if (exited) return;
          endGroup(child.pid, "SIGTERM");
          const forced = setTimeout(() => endGroup(child.pid, "SIGKILL"), Math.max(1, graceMs));
          const bound = new Promise<void>((resolve) => { setTimeout(resolve, Math.max(1, graceMs) + 2_000).unref(); });
          try { await Promise.race([gone, bound]); } finally { clearTimeout(forced); endGroup(child.pid, "SIGKILL"); }
        },
      };
    },
  };
}
