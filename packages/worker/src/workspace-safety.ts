// FIX-RUNNER-ABORT-JOIN: the latch that says "a command we stopped may still be writing the workspace".
//
// An exception cannot carry that fact to the code that must act on it: Pi turns a throwing shell tool into an ordinary tool result, and a hook that catches
// everything reports "error" and lets the run go on. So the fact is recorded where it is found, in a per-task object that every later step can read, and
// the run ends on it instead of on whatever the exception became on its way.
//
// The object lives in an AsyncLocalStorage opened by `runTaskInvocation`: every runner that starts a command for the task (host, container, agent shell,
// check round, seeds) runs inside that task's async context, so it finds the task's latch without a parameter threaded through each constructor, and two
// tasks in one worker never share one. Constructing a RunnerKillUnconfirmedError is what sets it (collected-process.ts), so no producer can forget.
import { AsyncLocalStorage } from "node:async_hooks";

/** Where the command that could not be confirmed stopped ran: the task sandbox (a container the worker can remove), a sealed check round's sandbox (removed by the round's own teardown, which fails when it cannot), a devcontainer (it persists), or this worker's own host. */
export type UnconfirmedKind = "sandbox" | "sealed" | "devcontainer" | "local";

export interface UnconfirmedStop {
  kind: UnconfirmedKind;
  /** The process group the host command led, when the kind is "local" and it is known. */
  pgid?: number;
}

/** Something the worker can kill, remove and check gone when a command in it could not be confirmed stopped (a task sandbox). */
export interface Quarantinable {
  readonly name: string;
  quarantine(): Promise<{ name: string; verified: boolean }>;
}

export class WorkspaceSafety {
  /** The sandboxes of the task, quarantined as soon as the latch is set (workspace-quarantine.ts). The list is the task's own, read when it is needed. */
  readonly quarantinables: Array<readonly Quarantinable[]> = [];
  /** The quarantine in progress, so the task's end can wait for it. */
  pending: Promise<void> = Promise.resolve();

  private readonly stops: UnconfirmedStop[] = [];
  private firstFailure: Error | undefined;
  private readonly listeners: Array<(stop: UnconfirmedStop) => void> = [];

  /** True once any command of the task was stopped without the stop being confirmed. */
  get unsafe(): boolean {
    return this.stops.length > 0;
  }

  /** The first error that recorded one: what a step that must stop the run throws. */
  get failure(): Error | undefined {
    return this.firstFailure;
  }

  /** Every unconfirmed stop recorded so far. */
  get unconfirmed(): readonly UnconfirmedStop[] {
    return this.stops;
  }

  markUnsafe(stop: UnconfirmedStop, failure?: Error): void {
    this.stops.push(stop);
    this.firstFailure ??= failure;
    for (const listener of this.listeners) {
      try {
        listener(stop);
      } catch {
        // A listener that fails must not hide the latch: it is already set.
      }
    }
  }

  /** Called at once for each unconfirmed stop (and for the ones already recorded). */
  onUnsafe(listener: (stop: UnconfirmedStop) => void): void {
    this.listeners.push(listener);
    for (const stop of this.stops) {
      try {
        listener(stop);
      } catch {
        // See markUnsafe.
      }
    }
  }
}

const scope = new AsyncLocalStorage<WorkspaceSafety>();

/** Runs `work` with `safety` as the current task's latch. */
export function withWorkspaceSafety<T>(safety: WorkspaceSafety, work: () => T): T {
  return scope.run(safety, work);
}

export function currentWorkspaceSafety(): WorkspaceSafety | undefined {
  return scope.getStore();
}

/**
 * Runs `fn` in `safety`'s scope, or in NO task's scope when `safety` is undefined. For code that runs later, in whatever context made it run (an abort listener, a timer), and must
 * still act for the task that asked for the work: the latch belongs to the task that started the command, never to the canceller's context, nor to another task's.
 */
export function inWorkspaceScope<T>(safety: WorkspaceSafety | undefined, fn: () => T): T {
  return safety === undefined ? scope.exit(fn) : scope.run(safety, fn);
}

/** Records an unconfirmed stop on the current task's latch. A no-op outside a task (a test, a CLI). */
export function markWorkspaceUnsafe(stop: UnconfirmedStop, failure?: Error): void {
  scope.getStore()?.markUnsafe(stop, failure);
}
