import { spawn, type ChildProcess } from "node:child_process";

/** How much of each output stream a command keeps: its last 1 MiB, where errors usually are (#154). */
export const MAX_COMMAND_OUTPUT_BYTES = 1_048_576;

/** How long a timed-out process group has to stop after SIGTERM before it gets SIGKILL (#170). */
export const TIMEOUT_KILL_GRACE_MS = 5_000;

export interface CollectedProcess {
  /** null when a signal ended the process, or when it was aborted. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** The signal that ended the process, when one did. */
  signal?: string;
  /**
   * True only when `timeoutMs` passed while the process was running: its process group was sent
   * SIGTERM, then SIGKILL after `killGraceMs` (#170).
   */
  timedOut?: boolean;
}

export interface CollectedProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** How long after SIGTERM a timed-out process group gets SIGKILL. Defaults to TIMEOUT_KILL_GRACE_MS. */
  killGraceMs?: number;
  signal?: AbortSignal;
  onStdout?: (data: Buffer) => void;
  onStderr?: (data: Buffer) => void;
}

/**
 * Runs a process and collects the last MAX_COMMAND_OUTPUT_BYTES of each output stream. More
 * output than that never stops the process. An abort resolves with exitCode null; a process that
 * cannot start rejects. The process leads its own process group, so a timeout stops everything it
 * started: SIGTERM to the group, then SIGKILL after the grace period (#170).
 */
export function runCollected(executable: string, args: readonly string[], options: CollectedProcessOptions = {}): Promise<CollectedProcess> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group, whose ID is its PID, so a timeout can signal its children too.
      detached: true,
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const stdout = tailCollector();
    const stderr = tailCollector();
    let timedOut = false;
    let settled = false;
    // "close" waits for every holder of the output pipes, which can include a child the process
    // left running; the timeout counts only while the process itself has not exited.
    let exited = false;
    child.on("exit", () => { exited = true; });
    const stopReading = () => {
      child.stdout.destroy();
      child.stderr.destroy();
    };
    let killTimer: NodeJS.Timeout | undefined;
    const timer = options.timeoutMs
      ? setTimeout(() => {
        if (exited) {
          // The process is done, but a child it left running holds the output open: stop reading,
          // so "close" fires, without calling the process timed out.
          stopReading();
          return;
        }
        timedOut = true;
        signalGroup(child, "SIGTERM");
        killTimer = setTimeout(() => {
          signalGroup(child, "SIGKILL");
          // A process that left the group (setsid) may still hold the output open.
          if (exited) stopReading();
          else child.once("exit", stopReading);
        }, options.killGraceMs ?? TIMEOUT_KILL_GRACE_MS);
      }, options.timeoutMs)
      : undefined;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      finish();
    };
    child.stdout.on("data", (data: Buffer) => { stdout.add(data); options.onStdout?.(data); });
    child.stderr.on("data", (data: Buffer) => { stderr.add(data); options.onStderr?.(data); });
    child.on("error", (error) => settle(() => {
      if (error.name === "AbortError") resolvePromise({ exitCode: null, stdout: stdout.text(), stderr: stderr.text() });
      else reject(error);
    }));
    child.on("close", (code, signal) => settle(() => resolvePromise({
      exitCode: code,
      stdout: stdout.text(),
      stderr: stderr.text(),
      ...(signal !== null ? { signal } : {}),
      ...(timedOut ? { timedOut: true } : {}),
    })));
  });
}

/** Sends a signal to the child's process group, or to the child alone when that fails. */
function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The group is gone, or cannot be signalled: fall back to the child itself.
    }
  }
  child.kill(signal);
}

/** Keeps the last MAX_COMMAND_OUTPUT_BYTES written. */
export function tailCollector(limit = MAX_COMMAND_OUTPUT_BYTES): { add(data: Buffer): void; text(): string } {
  let chunks: Buffer[] = [];
  let size = 0;
  return {
    add(data) {
      chunks.push(data);
      size += data.length;
      if (size > limit * 2) {
        const kept = Buffer.concat(chunks).subarray(size - limit);
        chunks = [kept];
        size = kept.length;
      }
    },
    text() {
      const all = Buffer.concat(chunks);
      const kept = all.length > limit ? all.subarray(all.length - limit) : all;
      // A cut can start inside a UTF-8 sequence: skip its continuation bytes.
      let start = 0;
      while (start < kept.length && start < 3 && ((kept[start] ?? 0) & 0xc0) === 0x80) start += 1;
      return kept.subarray(start).toString("utf8");
    },
  };
}
