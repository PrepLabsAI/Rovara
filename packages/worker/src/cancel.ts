import { spawn, type ChildProcess } from "node:child_process";
import { agentXError } from "@agentx/contracts";

export interface AbortablePiSession {
  abort(): Promise<void>;
}

export class WorkerOperationCancelledError extends Error {
  constructor(readonly operationId: string) {
    super(`operation ${operationId} was cancelled`);
    this.name = "WorkerOperationCancelledError";
  }
}

interface ActiveOperation {
  session?: AbortablePiSession;
  processes: Set<ChildProcess>;
}

export class WorkerCancellationController {
  private readonly active = new Map<string, ActiveOperation>();
  private readonly cancelled = new Set<string>();

  register(operationId: string, session?: AbortablePiSession): () => void {
    if (this.active.has(operationId)) throw agentXError("WORKSPACE_BUSY", "operation is already registered");
    const operation: ActiveOperation = {
      ...(session === undefined ? {} : { session }),
      processes: new Set(),
    };
    this.active.set(operationId, operation);
    return () => this.active.delete(operationId);
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
    await operation.session?.abort();
    this.cancelled.add(operationId);
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
