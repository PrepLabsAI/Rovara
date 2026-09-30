import { spawn, type ChildProcess } from "node:child_process";
import { redactText } from "@agentx/contracts";

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
 * How much more raw output than MAX_COMMAND_OUTPUT_BYTES a stream keeps, so that a secret the
 * 1 MiB cut would split is redacted whole before the cut (#170).
 */
export const REDACTION_MARGIN_BYTES = 65_536;

/**
 * Runs a process and collects the last MAX_COMMAND_OUTPUT_BYTES of each output stream. More
 * output than that never stops the process, and output that is cut is redacted before the cut
 * (#170). An abort resolves with exitCode null; a process that cannot start rejects. The process
 * leads its own process group: a timeout or an abort sends SIGTERM to the group, then SIGKILL after
 * the grace period (#170). This stops local processes only; a command the process runs somewhere
 * else, such as in a devcontainer, is not signalled.
 */
export function runCollected(executable: string, args: readonly string[], options: CollectedProcessOptions = {}): Promise<CollectedProcess> {
  return new Promise((resolvePromise, reject) => {
    if (options.signal?.aborted) {
      resolvePromise({ exitCode: null, stdout: "", stderr: "" });
      return;
    }
    const child = spawn(executable, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group, whose ID is its PID, so a timeout can signal its children too.
      detached: true,
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
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
    let stopping = false;
    // SIGTERM to the group now, SIGKILL after the grace period. The SIGKILL is sent even when the
    // result has already come back, for a group member that ignores SIGTERM but does not hold the
    // output open; it does not keep the worker running.
    const stop = () => {
      if (stopping) return;
      stopping = true;
      signalGroup(child, "SIGTERM");
      setTimeout(() => {
        signalGroup(child, "SIGKILL");
        if (settled) return;
        // A process that left the group (setsid) may still hold the output open.
        if (exited) stopReading();
        else child.once("exit", stopReading);
      }, options.killGraceMs ?? TIMEOUT_KILL_GRACE_MS).unref();
    };
    const timer = options.timeoutMs
      ? setTimeout(() => {
        if (exited) {
          // The process is done, but a child it left running holds the output open: stop reading,
          // so "close" fires, without calling the process timed out.
          stopReading();
          return;
        }
        timedOut = true;
        stop();
      }, options.timeoutMs)
      : undefined;
    const onAbort = () => {
      stop();
      settle(() => resolvePromise({ exitCode: null, stdout: stdout.text(), stderr: stderr.text() }));
    };
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      finish();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (data: Buffer) => { stdout.add(data); options.onStdout?.(data); });
    child.stderr.on("data", (data: Buffer) => { stderr.add(data); options.onStderr?.(data); });
    child.on("error", (error) => settle(() => reject(error)));
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

/**
 * Keeps the last `limit` bytes written, plus `margin` more raw bytes. Output longer than `limit`
 * is redacted over the whole kept window, then cut to its last `limit` characters, from a whole
 * line (#170).
 */
export function tailCollector(limit = MAX_COMMAND_OUTPUT_BYTES, margin = REDACTION_MARGIN_BYTES): { add(data: Buffer): void; text(): string } {
  const keep = limit + margin;
  let chunks: Buffer[] = [];
  let size = 0;
  let cut = false;
  return {
    add(data) {
      chunks.push(data);
      size += data.length;
      if (size > keep * 2) {
        const kept = Buffer.concat(chunks).subarray(size - keep);
        chunks = [kept];
        size = kept.length;
        cut = true;
      }
    },
    text() {
      const all = Buffer.concat(chunks);
      if (!cut && all.length <= limit) return all.toString("utf8");
      const rawCut = cut || all.length > keep;
      const window = all.length > keep ? all.subarray(all.length - keep) : all;
      // A raw cut can start inside a UTF-8 sequence: skip its continuation bytes.
      let start = 0;
      while (rawCut && start < window.length && start < 3 && ((window[start] ?? 0) & 0xc0) === 0x80) start += 1;
      return redactedTail(window.subarray(start).toString("utf8"), limit, rawCut);
    },
  };
}

/**
 * Redacts the text, then keeps its last `limit` characters (#170). When that cuts it, or when
 * `alreadyCut` says its start was cut before, it starts at the first whole line, or else after the
 * first whitespace, so that no fragment of a secret the cut split is kept.
 */
export function redactedTail(text: string, limit: number, alreadyCut = false): string {
  const redacted = redactText(text);
  const cutHere = redacted.length > limit;
  if (!cutHere && !alreadyCut) return redacted;
  return withoutSplitPair(fromWholeLine(cutHere ? redacted.slice(redacted.length - limit) : redacted), "start");
}

function fromWholeLine(text: string): string {
  const lineBreak = text.indexOf("\n");
  if (lineBreak >= 0 && lineBreak < text.length - 1) return text.slice(lineBreak + 1);
  const space = text.search(/\s/);
  if (space >= 0 && space < text.length - 1) return text.slice(space + 1);
  return text;
}

/** Drops half of a surrogate pair left at a cut. */
export function withoutSplitPair(text: string, side: "start" | "end"): string {
  if (side === "start") {
    const code = text.charCodeAt(0);
    return code >= 0xdc00 && code <= 0xdfff ? text.slice(1) : text;
  }
  const code = text.charCodeAt(text.length - 1);
  return code >= 0xd800 && code <= 0xdbff ? text.slice(0, -1) : text;
}
