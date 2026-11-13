import { spawn, type ChildProcess } from "node:child_process";
import { agentXError } from "@rovara-code/contracts";

export interface AbortablePiSession {
  abort(): Promise<void>;
  /**
   * Live steer: queues a message for the step's running session(s) (pi delivers it after the current tool calls, before the next model call). Answers whether a session took it (false: none is
   * streaming now). Absent for a step that takes none.
   */
  steer?(text: string): Promise<boolean>;
  /** Whether a session of the step is streaming a prompt now: a message is given only then (an idle session would keep it for a later prompt, or lose it). Absent: never. */
  streaming?(): boolean;
}

/** A person's live message the step's session took: its id and the authority it was given with (the step stops for re-approval only on the owner's). */
export interface LiveSteerTaken { messageId: string; authority: "owner_instruction" | "information" }

export class WorkerOperationCancelledError extends Error {
  /** F5: a setup run that was stopped finishes and reports what it had; its result rides on the cancelled end (the broker reads it again and keeps only the partial proposal). */
  constructor(readonly operationId: string, readonly setupRunResult?: unknown) {
    super(`operation ${operationId} was cancelled`);
    this.name = "WorkerOperationCancelledError";
  }
}

interface ActiveOperation {
  session?: AbortablePiSession;
  processes: Set<ChildProcess>;
  liveSteers: LiveSteerTaken[];
}

/** How long a stop remembered for an operation that has not registered is kept (an operation that is still starting registers within minutes). */
export const PENDING_CANCEL_TTL_MS = 60 * 60_000;

export class WorkerCancellationController {
  private readonly active = new Map<string, ActiveOperation>();
  private readonly cancelled = new Set<string>();
  /** Operations a cancel named before they registered (058-stop-close): the stop is applied the moment each registers. */
  private readonly cancelOnRegister = new Map<string, number>();

  register(operationId: string, session?: AbortablePiSession): () => void {
    if (this.active.has(operationId)) throw agentXError("WORKSPACE_BUSY", "operation is already registered");
    const operation: ActiveOperation = {
      ...(session === undefined ? {} : { session }),
      processes: new Set(),
      liveSteers: [],
    };
    this.active.set(operationId, operation);
    // A stop that came while this operation was still preparing: marked, and the run's own abort runs now, so the run ends on its first check instead of going on.
    if (this.cancelOnRegister.delete(operationId)) {
      this.cancelled.add(operationId);
      queueMicrotask(() => { void this.cancel(operationId).catch(() => undefined); });
    }
    return () => this.active.delete(operationId);
  }

  /** Whether the operation is registered (running) here now. */
  isRegistered(operationId: string): boolean {
    return this.active.has(operationId);
  }

  /**
   * A cancel for an operation the worker has taken but that has not registered yet (it is still checking out or starting its session): the stop is remembered, marked cancelled at once, and
   * applied when the operation registers. False when it is registered already (the ordinary cancel applies).
   */
  cancelWhenRegistered(operationId: string, now: number = Date.now()): boolean {
    if (this.active.has(operationId)) return false;
    // Bounded: an operation that never registers (a publish, a close, a checkout that failed) leaves its entry only for the TTL.
    for (const [entry, expiresAt] of this.cancelOnRegister) {
      if (expiresAt <= now) { this.cancelOnRegister.delete(entry); this.cancelled.delete(entry); }
    }
    this.cancelled.add(operationId);
    this.cancelOnRegister.set(operationId, now + PENDING_CANCEL_TTL_MS);
    return true;
  }

  /** The operation has ended: a stop remembered for it is no longer needed. Never touches a registered (running) operation. */
  forget(operationId: string): void {
    if (this.active.has(operationId)) return;
    this.cancelOnRegister.delete(operationId);
    this.cancelled.delete(operationId);
  }

  spawnTracked(
    operationId: string,
    executable: string,
    args: readonly string[],
    options: { cwd: string; env?: NodeJS.ProcessEnv },
  ): ChildProcess {
    const operation = this.active.get(operationId);
    if (!operation) throw agentXError("NOT_FOUND", "active operation not found");
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== "win32",
      stdio: "ignore",
    });
    operation.processes.add(child);
    child.once("exit", () => operation.processes.delete(child));
    return child;
  }

  async cancel(operationId: string, graceMilliseconds = 1_000): Promise<{
    status: "CANCELLED" | "INTERRUPTED";
    remainingProcesses: number;
  }> {
    const operation = this.active.get(operationId);
    if (!operation) throw agentXError("NOT_FOUND", "active operation not found");
    // Marked first: an abort can end the task's prompt normally, and the task must already see
    // that it was cancelled when it checks (#136).
    this.cancelled.add(operationId);
    await operation.session?.abort();
    for (const child of operation.processes) signalProcess(child, "SIGTERM");
    if (operation.processes.size > 0) await delay(graceMilliseconds);
    for (const child of operation.processes) signalProcess(child, "SIGKILL");
    if (operation.processes.size > 0) await delay(50);
    const remainingProcesses = operation.processes.size;
    this.active.delete(operationId);
    return {
      status: remainingProcesses === 0 ? "CANCELLED" : "INTERRUPTED",
      remainingProcesses,
    };
  }

  isCancelled(operationId: string): boolean {
    return this.cancelled.has(operationId);
  }

  /** Whether the operation is registered with a session that takes messages and was not cancelled. */
  canSteer(operationId: string): boolean {
    return this.active.get(operationId)?.session?.steer !== undefined && !this.cancelled.has(operationId);
  }

  /** Whether a message can be given now: `canSteer`, and a session of the step is streaming a prompt (an idle session only keeps a message for a later prompt, or loses it). */
  canSteerNow(operationId: string): boolean {
    return this.canSteer(operationId) && this.active.get(operationId)?.session?.streaming?.() === true;
  }

  /**
   * Gives a message to the streaming session(s) of a running operation. `not_running`: no such operation is registered, it takes no message, it was cancelled, or no session of it is
   * streaming now. A rejection of pi's own is thrown (the caller turns it into a fixed outcome; the message is never put in it).
   */
  async steer(operationId: string, text: string): Promise<"steered" | "not_running"> {
    const operation = this.active.get(operationId);
    if (operation?.session?.steer === undefined || this.cancelled.has(operationId) || operation.session.streaming?.() !== true) return "not_running";
    return (await operation.session.steer(text)) ? "steered" : "not_running";
  }

  /** Remembers a live message the operation's session took, for the step to read at its end (the owner's re-approval marker counts only after an owner's message). */
  recordLiveSteer(operationId: string, taken: LiveSteerTaken): void {
    this.active.get(operationId)?.liveSteers.push(taken);
  }

  /** The live messages the operation's session took so far, oldest first. */
  liveSteers(operationId: string): readonly LiveSteerTaken[] {
    return this.active.get(operationId)?.liveSteers ?? [];
  }
}

function signalProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid || child.exitCode !== null) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ESRCH") throw error;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
