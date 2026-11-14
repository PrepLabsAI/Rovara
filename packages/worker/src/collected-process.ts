import { spawn, type ChildProcess } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { redactText } from "@agentx/contracts";
import { markWorkspaceUnsafe, type UnconfirmedStop } from "./workspace-safety.js";

/** How much of each output stream a command keeps: its last 1 MiB, where errors usually are (#154). */
export const MAX_COMMAND_OUTPUT_BYTES = 1_048_576;

/** How long a timed-out process group has to stop after SIGTERM before it gets SIGKILL (#170). */
export const TIMEOUT_KILL_GRACE_MS = 5_000;

/**
 * How long after SIGKILL a stopped process group has to be gone before the stop is called "kill-unconfirmed". The whole stop
 * (SIGTERM, the grace period, SIGKILL, this wait) is bounded by `killGraceMs + killConfirmMs`.
 */
export const KILL_CONFIRM_MS = 5_000;

/**
 * Raised by a caller of a stop that could not be confirmed (the process or something in its group, or a command in a
 * container, may still be running). Whoever catches it must treat the run as failed and must NOT read or write the
 * working tree afterwards: a command that is still running may still be writing it. The text is fixed: nothing from the
 * command is in it.
 */
export class RunnerKillUnconfirmedError extends Error {
  /**
   * Making one is what sets the task's WorkspaceSafety latch (workspace-safety.ts), so that no producer can forget it and no catch between here and the
   * run's ending can turn the fact into an ordinary failure. `stop` says where the command ran and is REQUIRED: a wrong kind decides how the workspace is
   * quarantined and whether the next task is let in, so every producer states it.
   *
   * Do not construct one in a catch that rewraps an error you caught: that records a second unconfirmed stop that did not happen, and the latch cannot be
   * unset. Rethrow the one you caught. Construct it where the stop is found to be unconfirmed, inside the scope of the task that started the command.
   */
  constructor(stop: UnconfirmedStop) {
    super("AgentX could not confirm that the command stopped, so it did not touch the workspace afterwards");
    this.name = "RunnerKillUnconfirmedError";
    markWorkspaceUnsafe(stop, this);
  }
}

/** The two operating-system calls a stop uses. Real by default; tests replace them to make a stop that cannot be confirmed. */
export interface ProcessControl {
  /** Sends the signal to the child's process group, falling back to the child alone. */
  signalGroup(child: ChildProcess, signal: NodeJS.Signals): void;
  /** Whether any live process is left in the group the child led. */
  groupAlive(pid: number): boolean;
}

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
  /**
   * True when a stop (an abort or a timeout) could not be confirmed within the bound: the process group may still be running, so
   * the caller must treat the run as failed and must not touch the working tree (see RunnerKillUnconfirmedError).
   */
  killUnconfirmed?: true;
  /** With `killUnconfirmed`: the process group the command led, which may still be running. */
  pgid?: number;
}

export interface CollectedProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** How long after SIGTERM a timed-out process group gets SIGKILL. Defaults to TIMEOUT_KILL_GRACE_MS. */
  killGraceMs?: number;
  /** How long after SIGKILL the group has to be gone before the stop is reported as unconfirmed. Defaults to KILL_CONFIRM_MS. */
  killConfirmMs?: number;
  /** Tests only: replaces the signal and liveness calls. */
  control?: ProcessControl;
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
 * (#170); output that is not cut comes back unredacted, so a caller that stores it must redact it. A process that cannot start rejects. The process
 * leads its own process group: a timeout or an abort sends SIGTERM to the group, then SIGKILL after
 * the grace period (#170).
 *
 * A stop is joined: the result comes back only once the process has exited AND no live process is left in its group, so a caller
 * that aborts and then reads or writes the working tree never races a command that is still writing. An abort resolves with
 * exitCode null. The whole stop is bounded by `killGraceMs + killConfirmMs`: a group that is still alive then is not waited for any
 * longer, and the result says `killUnconfirmed: true`, which the caller must treat as a failure and must not touch the working tree
 * after (RunnerKillUnconfirmedError). Output stops reaching onStdout and onStderr as soon as an abort is made.
 *
 * This stops local processes only; a command the process runs somewhere else, such as in a devcontainer, is not signalled here:
 * the container runners (devcontainer.ts runInContainerGroup) stop and confirm their own process group inside the container.
 */
export function runCollected(executable: string, args: readonly string[], options: CollectedProcessOptions = {}): Promise<CollectedProcess> {
  return new Promise((resolvePromise, reject) => {
    if (options.signal?.aborted) {
      resolvePromise({ exitCode: null, stdout: "", stderr: "" });
      return;
    }
    const control = options.control ?? realProcessControl;
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
    let aborted = false;
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
    let boundTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let pollTimer: NodeJS.Timeout | undefined;
    let ended: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    const result = (unconfirmed: boolean): CollectedProcess => ({
      // An abort is reported as no exit code, whatever the process said as it died.
      exitCode: aborted ? null : ended?.code ?? null,
      stdout: stdout.text(),
      stderr: stderr.text(),
      ...(!aborted && ended !== undefined && ended.signal !== null ? { signal: ended.signal } : {}),
      ...(timedOut && !aborted ? { timedOut: true } : {}),
      ...(unconfirmed ? { killUnconfirmed: true as const, ...(child.pid === undefined ? {} : { pgid: child.pid }) } : {}),
    });
    // SIGTERM to the group now, SIGKILL after the grace period. The SIGKILL is sent even when the
    // result has already come back, for a group member that ignores SIGTERM but does not hold the
    // output open; it does not keep the worker running. The result itself waits for the group to be
    // gone (see `confirmGone`), up to the bound.
    const stop = () => {
      if (stopping) return;
      stopping = true;
      const graceMs = options.killGraceMs ?? TIMEOUT_KILL_GRACE_MS;
      control.signalGroup(child, "SIGTERM");
      // Cleared when the result settles: a stop that is confirmed has nothing left to kill, and a SIGKILL sent after it would go to a group id that may by then belong to another process.
      killTimer = setTimeout(() => {
        control.signalGroup(child, "SIGKILL");
        if (settled) return;
        // A process that left the group (setsid) may still hold the output open.
        if (exited) stopReading();
        else child.once("exit", stopReading);
      }, graceMs);
      killTimer.unref();
      // The bound: a group still alive when it ends is reported, not waited for. It is not unref'd: the result is owed.
      boundTimer = setTimeout(() => settle(() => resolvePromise(result(true))), graceMs + (options.killConfirmMs ?? KILL_CONFIRM_MS));
    };
    // The leader has exited: wait until nothing is left alive in its group (a grandchild may outlive it, and write).
    const confirmGone = () => {
      if (settled) return;
      if (child.pid === undefined || !control.groupAlive(child.pid)) {
        settle(() => resolvePromise(result(false)));
        return;
      }
      pollTimer = setTimeout(confirmGone, GROUP_POLL_MS);
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
      aborted = true;
      stop();
      // No output reaches onStdout or onStderr after the abort has been made.
      stopReading();
      // The result is NOT returned here: it comes once the process has exited and its group is gone.
    };
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (boundTimer !== undefined) clearTimeout(boundTimer);
      if (pollTimer !== undefined) clearTimeout(pollTimer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
      finish();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (data: Buffer) => { if (!aborted) { stdout.add(data); options.onStdout?.(data); } });
    child.stderr.on("data", (data: Buffer) => { if (!aborted) { stderr.add(data); options.onStderr?.(data); } });
    child.on("error", (error) => settle(() => reject(error)));
    child.on("close", (code, signal) => {
      ended = { code, signal };
      // A stop (an abort or a timeout) is joined: the group must be gone as well.
      if (stopping) confirmGone();
      else settle(() => resolvePromise(result(false)));
    });
  });
}

/** How often a stopped process group is looked at to see whether it is gone. */
const GROUP_POLL_MS = 25;

const realProcessControl: ProcessControl = { signalGroup, groupAlive: (pgid) => groupAlive(pgid) };

/**
 * Whether any live process is left in the process group `pgid` (the group a detached child leads). `kill(-pgid, 0)` finds the group
 * while any member exists, zombies included; on Linux a group of zombies (which a process manager that does not reap, as a bare
 * Node PID 1 does not, leaves behind) counts as gone. A group that cannot be examined counts as alive: the stop is then not confirmed.
 */
export function groupAlive(pgid: number, probe: GroupProbe = realGroupProbe): boolean {
  try {
    probe.kill(-pgid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
  return probe.platform === "linux" ? liveMemberOnLinux(pgid, probe.procRoot) : true;
}

/** What groupAlive asks of the system; tests replace it (a fake /proc with a zombie in it, for one). */
export interface GroupProbe {
  kill(pid: number, signal: 0): void;
  platform: string;
  /** The directory of per-process folders ("/proc"). */
  procRoot: string;
}
const realGroupProbe: GroupProbe = { kill: (pid, signal) => { process.kill(pid, signal); }, platform: process.platform, procRoot: "/proc" };

function liveMemberOnLinux(pgid: number, procRoot: string): boolean {
  let names: string[];
  try {
    names = readdirSync(procRoot);
  } catch {
    return true;
  }
  for (const name of names) {
    if (!/^[0-9]+$/u.test(name)) continue;
    let stat: string;
    try {
      stat = readFileSync(`${procRoot}/${name}/stat`, "utf8");
    } catch (error) {
      // It exited meanwhile; anything else (a hidden /proc entry) means this member cannot be judged.
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ESRCH") continue;
      return true;
    }
    // "pid (comm) state ppid pgrp ...": the name may hold spaces and parentheses, so read after its last ")".
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (Number(fields[2]) === pgid && fields[0] !== "Z" && fields[0] !== "X") return true;
  }
  return false;
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
 * is redacted over the whole kept window, then cut to at most its last `limit` bytes, from a whole
 * line (#170). Shorter output comes back as written, not redacted: callers that store it redact it.
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
      return redactedTail(window.subarray(start).toString("utf8"), limit, rawCut ? margin : undefined);
    },
  };
}

/**
 * Redacts the text, then keeps at most its last `limit` bytes of UTF-8 (so also at most `limit`
 * characters) (#170). `rawCutMargin` says the text's start was already cut raw, and that many
 * bytes at its start were kept only so that redaction sees whole secrets: they are dropped too.
 * A cut output starts at its first whole line, or else after its first whitespace, so that no
 * fragment of a secret the cut split is kept.
 */
export function redactedTail(text: string, limit: number, rawCutMargin?: number): string {
  const redacted = redactText(text);
  const bytes = Buffer.from(redacted, "utf8");
  const keep = rawCutMargin === undefined ? limit : Math.min(limit, Math.max(0, bytes.length - rawCutMargin));
  if (bytes.length <= keep && rawCutMargin === undefined) return redacted;
  const kept = bytes.subarray(bytes.length - keep);
  // A cut can start inside a UTF-8 sequence: skip its continuation bytes.
  let start = 0;
  while (start < kept.length && start < 3 && ((kept[start] ?? 0) & 0xc0) === 0x80) start += 1;
  return fromWholeLine(kept.subarray(start).toString("utf8"));
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
