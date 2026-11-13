import { WORKFLOW_LEFTOVER_PROCESSES_MESSAGE, agentXError, redactText } from "@rovara-code/contracts";
import { containWorkspace, type OtherOperationWait } from "./publish.js";
import { stopWorkspaceProcesses } from "./workspace-processes.js";
import { sweepWorkspaceContainers } from "./workspace-containers.js";

/**
 * The steps that only read the workspace for someone else's judgement. Each runs after the coding session, in a workspace it
 * wrote, so a program that session left running (a background job, a `setsid` daemon, a process inside the task sandbox or the
 * project's dev container, which persists between operations) could change files, the rule-file scratch area or results while
 * the reader reads them.
 */
export const READ_ONLY_STEP_MODES: ReadonlySet<string> = new Set(["REVIEW", "FEEDBACK_REVIEW", "PLAN_CRITIQUE", "UNDERSTAND"]);

/**
 * Every mode that stops first: the reading steps, and AgentX's rerun of the project's checks (CHECKS). The checks run the project's code, so unlike the reading steps they do start the
 * project's dev container (or a sandbox), but a fresh one: a program left in the old one could change files, ports or results while the checks run.
 */
export const STOPS_PROGRAMS_FIRST_MODES: ReadonlySet<string> = new Set([...READ_ONLY_STEP_MODES, "CHECKS"]);

export interface StopBeforeReadingOptions {
  /** Test seams: the same two steps publication takes. */
  stopWorkspaceProcesses?: (rootPath: string) => Promise<{ stopped: number } | void>;
  sweepWorkspaceContainers?: (rootPath: string) => Promise<{ removed: number }>;
  /** Whether another operation is still running in this worker (server.ts). */
  otherOperationActive?: () => boolean;
  /** How long to wait for it to end before failing closed (30 s by default). */
  otherOperationWait?: OtherOperationWait;
  log?: (event: Record<string, unknown>) => void;
}

/**
 * Before one of those steps reads anything, stops every program the coding session started the way publication does before it
 * takes a push token (publish.ts): the worker's own leftover processes (workspace-processes.ts), then every container but the
 * worker's own (workspace-containers.ts), the task sandbox and the dev container included, repeated until a round finds neither.
 * If another operation is still running in this worker (an earlier coding run the broker wrote off as lost), nothing is stopped and the step fails the same way once a bounded wait
 * (30 s; a cancel reports before the cancelled run has left the list) is over: killing its children would not stop its own code, which keeps writing the workspace.
 * Nothing is started in their place here: the step opens its own task sandbox afterwards, and does not start the dev container
 * (its lifecycle commands are the repository's), so no program of the project runs before the read.
 *
 * Fails closed with one fixed reason (WORKFLOW_LEFTOVER_PROCESSES_MESSAGE). What went wrong is logged for the operator and is never
 * part of the reason: it can carry a container name or a program's output. The attempt is bounded by the rounds of
 * `containWorkspace`; nothing here retries.
 */
export async function stopProgramsBeforeReading(rootPath: string, options: StopBeforeReadingOptions = {}, step: "read the workspace" | "run the checks" = "read the workspace"): Promise<void> {
  const log = options.log ?? ((event: Record<string, unknown>) => console.log(JSON.stringify({ component: "worker", ...event })));
  try {
    await containWorkspace(rootPath, {
      sweep: options.sweepWorkspaceContainers ?? ((root: string) => sweepWorkspaceContainers({ rootPath: root })),
      stop: options.stopWorkspaceProcesses ?? ((root: string) => stopWorkspaceProcesses({ rootPath: root })),
      ...(options.otherOperationActive === undefined ? {} : { otherOperationActive: options.otherOperationActive }),
      ...(options.otherOperationWait === undefined ? {} : { otherOperationWait: options.otherOperationWait }),
    });
  } catch (error) {
    log({ event: "read-step.stop-programs.failed", reason: redactText(error instanceof Error ? error.message : String(error)).slice(0, 300) });
    throw agentXError("RUNTIME_UNAVAILABLE", `AgentX ${WORKFLOW_LEFTOVER_PROCESSES_MESSAGE}, so it did not ${step}`);
  }
}
