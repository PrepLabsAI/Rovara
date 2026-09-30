import { spawn } from "node:child_process";

/** How much of each output stream a command keeps: its last 1 MiB, where errors usually are (#154). */
export const MAX_COMMAND_OUTPUT_BYTES = 1_048_576;

export interface CollectedProcess {
  /** null when a signal ended the process, or when it was aborted. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** The signal that ended the process, when one did. */
  signal?: string;
  /** True when `timeoutMs` passed and the process was stopped with SIGTERM. */
  timedOut?: boolean;
}

export interface CollectedProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  onStdout?: (data: Buffer) => void;
  onStderr?: (data: Buffer) => void;
}

/**
 * Runs a process and collects the last MAX_COMMAND_OUTPUT_BYTES of each output stream. More
 * output than that never stops the process. An abort resolves with exitCode null; a process that
 * cannot start rejects.
 */
export function runCollected(executable: string, args: readonly string[], options: CollectedProcessOptions = {}): Promise<CollectedProcess> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const stdout = tailCollector();
    const stderr = tailCollector();
    let timedOut = false;
    let settled = false;
    const timer = options.timeoutMs
      ? setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, options.timeoutMs)
      : undefined;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
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
