import { agentXError, type ProjectCommand, type WorkspaceStatus } from "@agentx/contracts";
import { storedCommandOutput } from "./command-failure.js";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** The signal that ended the command, when one did (#154). */
  signal?: string;
  /** True when the command's own timeoutSeconds ended it (#154). */
  timedOut?: boolean;
}

export type ReadinessCommandRunner = (
  command: ProjectCommand,
  index: number,
  rootPath: string,
) => Promise<CommandResult>;

export interface ReadinessResult extends CommandResult {
  index: number;
  ready: boolean;
}

export async function evaluateReadiness(
  input: { rootPath: string; commands: readonly ProjectCommand[] },
  runner: ReadinessCommandRunner,
): Promise<{ ready: boolean; results: ReadinessResult[] }> {
  const results: ReadinessResult[] = [];
  for (const [index, command] of input.commands.entries()) {
    try {
      const result = await runner(command, index, input.rootPath);
      // The preparation manifest stores these: redacted, then cut to the last lines (#170).
      results.push({
        ...result,
        stdout: storedCommandOutput(result.stdout),
        stderr: storedCommandOutput(result.stderr),
        index,
        // A check that its timeout stopped is not ready, even when it exited 0 on SIGTERM (#170).
        ready: result.exitCode === 0 && result.timedOut !== true,
      });
    } catch (error) {
      results.push({
        index,
        ready: false,
        exitCode: -1,
        stdout: "",
        stderr: storedCommandOutput(error instanceof Error ? error.message : "readiness command failed"),
      });
    }
  }
  return { ready: results.every((result) => result.ready), results };
}

export function assertWorkspaceReady(status: WorkspaceStatus): void {
  if (status === "READY") return;
  if (status === "PREPARATION_FAILED") {
    throw agentXError("WORKSPACE_NOT_READY", "workspace preparation failed");
  }
  throw agentXError("WORKSPACE_NOT_READY", `workspace is not ready (${status})`);
}
