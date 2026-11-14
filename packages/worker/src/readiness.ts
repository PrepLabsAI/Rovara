import { agentXError, type ProjectCommand, type WorkspaceStatus } from "@agentx/contracts";
import { discoverEvals, type EvalDiscovery } from "./verification/eval-discovery.js";
import { type EvalHealthInput, type EvalHealthResult } from "./verification/eval-health.js";
import { type EvalBaselines } from "./verification/eval-baseline-refresh.js";
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
  input: { rootPath: string; commands: readonly ProjectCommand[];
    /** Trusted setup seam. Cloud supplies persisted selection/approval later; never read this from project config. */
    evalSetup?: { health?: EvalHealthInput; baselines?: EvalBaselines };
  },
  runner: ReadinessCommandRunner,
): Promise<{ ready: boolean; results: ReadinessResult[]; eval?: { discovery: EvalDiscovery; message: string; measurement: Promise<EvalHealthResult | { status: "cached" }> } }> {
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
  const ready = results.every((result) => result.ready);
  if (input.evalSetup === undefined) return { ready, results };
  const discovery = await discoverEvals(input.rootPath);
  const { health, baselines } = input.evalSetup;
  const measurement = health === undefined || baselines === undefined
    ? Promise.resolve({ status: "not_run" as const, message: "Not run: trusted eval setup capabilities are not connected." })
    : baselines.afterMerge(health);
  // The host owns this promise: readiness and the first task do not wait on model calls.
  return { ready, results, eval: { discovery, message: health === undefined || baselines === undefined ? "Eval health check is not connected" : "baseline still being measured", measurement } };
}

export function assertWorkspaceReady(status: WorkspaceStatus): void {
  if (status === "READY") return;
  if (status === "PREPARATION_FAILED") {
    throw agentXError("WORKSPACE_NOT_READY", "workspace preparation failed");
  }
  throw agentXError("WORKSPACE_NOT_READY", `workspace is not ready (${status})`);
}
